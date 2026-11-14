// CPU, memory, network, temperature and VPN, read from /proc and /sys.

import GLib from 'gi://GLib';

import * as P from './parsers.js';
import {readText, listDir, isCancelled} from './io.js';

const HISTORY = 40;

export class SystemSampler {
    /** `root` prefixes /proc and /sys, for tests. */
    constructor(root = '') {
        this._root = root;
        this.cpu = new P.History(HISTORY);
        this.ram = new P.History(HISTORY);
        this.down = new P.History(HISTORY);
        this.up = new P.History(HISTORY);
        this.state = {
            cpu: null, temp: null, ram: null, net: null, vpn: null, load: null,
        };
        this._prevStat = null;
        this._prevNet = null;
        this._prevNetTime = 0;
        this._tempPath = undefined; // undefined: not looked for yet
        this._lastVpnCheck = 0;
    }

    /**
     * One sample. `want` says which readings are needed: {cpu, temp, ram,
     * net, vpn, load}. Readings not wanted are not read.
     */
    async sample(want, cancellable) {
        const jobs = [];
        if (want.cpu)
            jobs.push(this._cpu(cancellable));
        if (want.temp)
            jobs.push(this._temp(cancellable));
        if (want.ram)
            jobs.push(this._ram(cancellable));
        if (want.net)
            jobs.push(this._net(cancellable));
        if (want.load)
            jobs.push(this._load(cancellable));
        const now = GLib.get_monotonic_time() / 1e6;
        if (want.vpn && now - this._lastVpnCheck >= 5) {
            this._lastVpnCheck = now;
            jobs.push(this._vpn(cancellable));
        }
        try {
            await Promise.all(jobs);
        } catch (e) {
            if (!isCancelled(e))
                console.error('Tacho: sampling failed', e);
        }
        return this.state;
    }

    async _cpu(cancellable) {
        const text = await readText(this._root + '/proc/stat', cancellable);
        const cur = text ? P.parseProcStat(text) : null;
        const percent = P.cpuPercent(this._prevStat, cur);
        this._prevStat = cur;
        if (percent !== null) {
            this.state.cpu = percent;
            this.cpu.push(percent / 100);
        }
    }

    async _ram(cancellable) {
        const text = await readText(this._root + '/proc/meminfo', cancellable);
        const mem = text ? P.parseMeminfo(text) : null;
        this.state.ram = mem;
        if (mem)
            this.ram.push(mem.percent / 100);
    }

    async _net(cancellable) {
        const text = await readText(this._root + '/proc/net/dev', cancellable);
        const cur = text ? P.parseNetDev(text) : null;
        const now = GLib.get_monotonic_time() / 1e6;
        const rates = P.netRates(this._prevNet, cur, now - this._prevNetTime);
        this._prevNet = cur;
        this._prevNetTime = now;
        if (rates) {
            this.state.net = rates;
            this.down.push(rates.down);
            this.up.push(rates.up);
        }
    }

    async _load(cancellable) {
        const text = await readText(this._root + '/proc/loadavg', cancellable);
        this.state.load = text ? P.parseLoadavg(text) : null;
    }

    async _temp(cancellable) {
        if (this._tempPath === undefined)
            this._tempPath = await this._findTempSensor(cancellable);
        if (!this._tempPath) {
            this.state.temp = null;
            return;
        }
        const text = await readText(this._tempPath, cancellable);
        this.state.temp = text === null ? null : P.parseMilliCelsius(text);
        // A sensor that went away (driver reloaded) is looked for again.
        if (text === null)
            this._tempPath = undefined;
    }

    async _findTempSensor(cancellable) {
        const sensors = [];
        const hwmon = `${this._root}/sys/class/hwmon`;
        for (const dir of await listDir(hwmon, cancellable)) {
            const base = `${hwmon}/${dir}`;
            const chip = ((await readText(`${base}/name`, cancellable)) ?? '').trim();
            const files = await listDir(base, cancellable);
            for (const f of files) {
                const m = /^temp(\d+)_input$/.exec(f);
                if (!m)
                    continue;
                const label = ((await readText(`${base}/temp${m[1]}_label`, cancellable)) ?? '').trim();
                sensors.push({kind: 'hwmon', chip, label, path: `${base}/${f}`});
            }
        }
        const thermal = `${this._root}/sys/class/thermal`;
        for (const dir of await listDir(thermal, cancellable)) {
            if (!dir.startsWith('thermal_zone'))
                continue;
            const type = ((await readText(`${thermal}/${dir}/type`, cancellable)) ?? '').trim();
            sensors.push({kind: 'thermal', chip: type, label: '', path: `${thermal}/${dir}/temp`});
        }
        return P.pickTempSensor(sensors);
    }

    async _vpn(cancellable) {
        const names = (await listDir(`${this._root}/sys/class/net`, cancellable)).filter(n => P.VPN_PATTERN.test(n));
        if (!names.length) {
            this.state.vpn = [];
            return;
        }
        const route = await readText(this._root + '/proc/net/route', cancellable);
        const routed = route ? P.parseRouteInterfaces(route) : new Set();
        const entries = [];
        for (const name of names) {
            const flags = await readText(`${this._root}/sys/class/net/${name}/flags`, cancellable);
            if (flags !== null)
                entries.push({name, flags: parseInt(flags.trim(), 16) || 0});
        }
        this.state.vpn = P.vpnInterfaces(entries, routed);
    }

    /** Download and upload histories scaled to a shared ceiling, 0..1. */
    netGraph() {
        const top = Math.max(this.down.max(), this.up.max(), 16 * 1024);
        return [this.down.values.map(v => v / top), this.up.values.map(v => v / top)];
    }
}
