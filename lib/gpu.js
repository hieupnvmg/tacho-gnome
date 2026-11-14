// GPU usage from sysfs (Intel, AMD) and nvidia-smi (NVIDIA).
//
// Intel has no busy counter in sysfs, but it has the time the GPU spent
// idle (RC6 on i915, gtidle on xe); busy is the rest. AMD writes a busy
// percentage. NVIDIA's driver only answers through nvidia-smi, which is
// run only while the card is awake: on hybrid laptops the NVIDIA GPU
// sleeps (runtime D3) when unused, and querying it would wake it and cost
// battery. It is also asked no more often than every 10 s, longer than
// the driver's usual delay before it sleeps, so polling never keeps it up.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as P from './parsers.js';
import {isCancelled, listDir, readText} from './io.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const NVIDIA_INTERVAL = 10; // seconds, while the menu is closed
const SMI_FIELDS = 'pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw';

async function readNumber(path, cancellable) {
    const text = await readText(path, cancellable);
    if (text === null)
        return null;
    const n = Number(text.trim());
    return Number.isFinite(n) ? n : null;
}

export class GpuSampler {
    /** `root` prefixes /sys and `nvidiaSmi` names the command, for tests. */
    constructor(root = '', nvidiaSmi = 'nvidia-smi') {
        this._root = root;
        this._smi = nvidiaSmi;
        this._smiPath = undefined;
        this._lastSmi = 0;
        this.gpus = null; // found on the first sample
        this.history = new P.History(40);
        this.panel = null; // the GPU the top bar shows
    }

    async _discover(cancellable) {
        const drm = `${this._root}/sys/class/drm`;
        const gpus = [];
        for (const name of (await listDir(drm, cancellable)).sort()) {
            if (!/^card\d+$/.test(name))
                continue;
            const card = `${drm}/${name}`;
            const dev = `${card}/device`;
            const {driver, slot} = P.parseUevent(await readText(`${dev}/uevent`, cancellable));
            if (!['i915', 'xe', 'amdgpu', 'nvidia'].includes(driver))
                continue;
            const vendor = P.gpuVendor(await readText(`${dev}/vendor`, cancellable));
            const gpu = {
                id: name, driver, slot: slot ?? null, vendor,
                name: {i915: 'Intel Graphics', xe: 'Intel Graphics', amdgpu: 'AMD Radeon', nvidia: 'NVIDIA'}[driver],
                discrete: driver === 'nvidia',
                busy: null, freq: null, maxFreq: null, memUsed: null, memTotal: null,
                temp: null, power: null, asleep: false,
                _paths: {}, _idle: null, _time: null,
            };
            const p = gpu._paths;
            if (driver === 'i915') {
                const gt = `${card}/gt/gt0`;
                if (await readText(`${gt}/rc6_residency_ms`, cancellable) !== null) {
                    p.idle = `${gt}/rc6_residency_ms`;
                    p.freq = `${gt}/rps_act_freq_mhz`;
                    p.maxFreq = `${gt}/rps_max_freq_mhz`;
                } else {
                    p.idle = `${card}/power/rc6_residency_ms`;
                    p.freq = `${card}/gt_act_freq_mhz`;
                    p.maxFreq = `${card}/gt_max_freq_mhz`;
                }
            } else if (driver === 'xe') {
                p.idle = `${dev}/tile0/gt0/gtidle/idle_residency_ms`;
                p.freq = `${dev}/tile0/gt0/freq0/act_freq`;
                p.maxFreq = `${dev}/tile0/gt0/freq0/max_freq`;
            } else if (driver === 'amdgpu') {
                p.busy = `${dev}/gpu_busy_percent`;
                p.memUsed = `${dev}/mem_info_vram_used`;
                p.memTotal = `${dev}/mem_info_vram_total`;
                // An APU's VRAM is a small carve-out of system memory.
                gpu.discrete = ((await readNumber(p.memTotal, cancellable)) ?? 0) > 1024 ** 3;
                const hwmon = (await listDir(`${dev}/hwmon`, cancellable))[0];
                if (hwmon) {
                    p.temp = `${dev}/hwmon/${hwmon}/temp1_input`;
                    p.power = `${dev}/hwmon/${hwmon}/power1_average`;
                    p.powerAlt = `${dev}/hwmon/${hwmon}/power1_input`;
                }
            } else if (driver === 'nvidia') {
                p.runtime = `${dev}/power/runtime_status`;
            }
            gpus.push(gpu);
        }
        return gpus;
    }

    /** Reads every GPU. `detailed` (menu open) asks NVIDIA every time. */
    async sample(detailed, cancellable) {
        try {
            if (this.gpus === null)
                this.gpus = await this._discover(cancellable);
            await Promise.all(this.gpus.map(g => this._read(g, detailed, cancellable)));
        } catch (e) {
            if (!isCancelled(e))
                console.error('Tacho: reading the GPU failed', e);
        }
        this.panel = P.pickPanelGpu(this.gpus ?? []);
        this.history.push(this.panel ? this.panel.busy / 100 : 0);
        return this.gpus;
    }

    async _read(gpu, detailed, cancellable) {
        const p = gpu._paths;
        if (p.idle) {
            const idle = await readNumber(p.idle, cancellable);
            const now = GLib.get_monotonic_time() / 1000;
            gpu.busy = P.idleBusy(gpu._idle, idle, now - (gpu._time ?? now));
            gpu._idle = idle;
            gpu._time = now;
            gpu.freq = await readNumber(p.freq, cancellable);
            if (gpu.maxFreq === null)
                gpu.maxFreq = await readNumber(p.maxFreq, cancellable);
            // RC6 counts idle time only while the GPU is powered; a GPU at
            // 0 MHz is resting however the counter moved.
            if (gpu.freq === 0)
                gpu.busy = gpu.busy === null ? null : 0;
        } else if (gpu.driver === 'amdgpu') {
            gpu.busy = await readNumber(p.busy, cancellable);
            gpu.memUsed = await readNumber(p.memUsed, cancellable);
            gpu.memTotal = await readNumber(p.memTotal, cancellable);
            if (p.temp) {
                const milli = await readNumber(p.temp, cancellable);
                gpu.temp = milli === null ? null : milli / 1000;
                const micro = (await readNumber(p.power, cancellable)) ?? (await readNumber(p.powerAlt, cancellable));
                gpu.power = micro === null ? null : micro / 1e6;
            }
        } else if (gpu.driver === 'nvidia') {
            await this._readNvidia(gpu, detailed, cancellable);
        }
    }

    async _readNvidia(gpu, detailed, cancellable) {
        const status = ((await readText(gpu._paths.runtime, cancellable)) ?? '').trim();
        if (status === 'suspended') {
            // Readings from before it slept are stale; only its name stays.
            Object.assign(gpu, {asleep: true, busy: null, power: null, temp: null, memUsed: null});
            this._lastSmi = 0; // read it as soon as it wakes
            return;
        }
        gpu.asleep = false;
        const now = GLib.get_monotonic_time() / 1e6;
        if (!detailed && now - this._lastSmi < NVIDIA_INTERVAL)
            return;
        if (this._smiPath === undefined)
            this._smiPath = this._smi.includes('/') ? this._smi : GLib.find_program_in_path(this._smi);
        if (!this._smiPath)
            return;
        this._lastSmi = now;
        try {
            const proc = Gio.Subprocess.new(
                [this._smiPath, `--query-gpu=${SMI_FIELDS}`, '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [stdout] = await proc.communicate_utf8_async(null, cancellable);
            const rows = P.parseNvidiaSmi(stdout);
            const row = rows.find(r => r.slot === gpu.slot) ?? (rows.length === 1 ? rows[0] : null);
            if (row) {
                Object.assign(gpu, {
                    name: row.name || gpu.name, busy: row.busy, memUsed: row.memUsed,
                    memTotal: row.memTotal, temp: row.temp, power: row.power,
                });
            }
        } catch (e) {
            if (isCancelled(e))
                throw e;
            console.warn(`Tacho: nvidia-smi failed: ${e.message}`);
        }
    }
}
