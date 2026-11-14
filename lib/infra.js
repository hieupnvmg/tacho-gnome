// Docker (over its Unix socket, no CLI) and the Kubernetes context.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as P from './parsers.js';
import {homeDir, isCancelled, readText, stat} from './io.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.IOStream.prototype, 'close_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function socketCandidates() {
    const list = [];
    const host = GLib.getenv('DOCKER_HOST');
    if (host?.startsWith('unix://'))
        list.push(host.slice('unix://'.length));
    list.push('/var/run/docker.sock', '/run/docker.sock');
    const runtime = GLib.getenv('XDG_RUNTIME_DIR');
    if (runtime)
        list.push(`${runtime}/docker.sock`, `${runtime}/podman/podman.sock`);
    list.push(`${homeDir()}/.docker/desktop/docker.sock`);
    return [...new Set(list)];
}

class DockerError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind; // 'down' | 'denied' | 'http'
    }
}

/** Talks HTTP/1.0 to the Docker engine over its Unix socket. */
export class DockerClient {
    constructor() {
        this._socket = null;
    }

    async request(method, path, {timeout = 3, cancellable = null} = {}) {
        const candidates = this._socket ? [this._socket] : socketCandidates();
        let denied = false;
        for (const socket of candidates) {
            if (!GLib.file_test(socket, GLib.FileTest.EXISTS))
                continue;
            try {
                const res = await this._send(socket, method, path, timeout, cancellable);
                this._socket = socket;
                return res;
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
                    denied = true;
            }
        }
        // The remembered socket failed: look through all of them next time.
        this._socket = null;
        throw new DockerError(denied ? 'denied' : 'down', 'Docker engine not reachable');
    }

    async _send(socket, method, path, timeout, cancellable) {
        const client = new Gio.SocketClient({timeout});
        const conn = await client.connect_async(Gio.UnixSocketAddress.new(socket), cancellable);
        try {
            // The request is a few dozen bytes: one write takes all of it.
            const request = new GLib.Bytes(encoder.encode(P.httpRequest(method, path)));
            await conn.get_output_stream().write_bytes_async(request, GLib.PRIORITY_DEFAULT, cancellable);
            const input = conn.get_input_stream();
            const parts = [];
            let total = 0;
            for (;;) {
                const bytes = await input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable);
                const n = bytes.get_size();
                if (!n)
                    break;
                parts.push(bytes.toArray());
                total += n;
                if (total > 8_000_000)
                    break;
            }
            const data = new Uint8Array(total);
            let o = 0;
            for (const p of parts) {
                data.set(p, o);
                o += p.length;
            }
            const res = P.parseHttpResponse(data);
            // 204: started or stopped; 304: it already was.
            if (!res || ![200, 204, 304].includes(res.status))
                throw new DockerError('http', `HTTP ${res?.status ?? '?'} for ${path}`);
            return res;
        } finally {
            conn.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }

    async getJson(path, opts) {
        const res = await this.request('GET', path, opts);
        return JSON.parse(decoder.decode(res.body));
    }
}

function kubeconfigPath() {
    // The first file of KUBECONFIG, if the session has it, else the default.
    const env = GLib.getenv('KUBECONFIG');
    const first = env?.split(':').find(p => p.length);
    return first || `${homeDir()}/.kube/config`;
}

/**
 * Polls Docker and the kubeconfig every 10 s while wanted. Container
 * memory and the engine's memory are only read while `detailed` is set
 * (the menu is open).
 */
export class InfraWatcher {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this.docker = new DockerClient();
        this._timer = 0;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._kubeMtime = null;
        this.detailed = false;
        this.pending = new Set();
        this.state = {
            docker: {status: 'unknown', containers: [], vmMemory: null, memory: {}},
            kube: {current: null, contexts: []},
        };
    }

    start() {
        if (this._timer)
            return;
        this.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 10, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    get running() {
        return this._timer !== 0;
    }

    async refresh() {
        if (this._busy)
            return;
        this._busy = true;
        const cancellable = this._cancellable;
        try {
            const [docker, kube] = await Promise.all([this._readDocker(cancellable), this._readKube(cancellable)]);
            this.state = {docker, kube};
            this._onUpdate(this.state);
        } catch (e) {
            if (!isCancelled(e))
                console.error('Tacho: reading Docker/Kubernetes failed', e);
        } finally {
            this._busy = false;
        }
    }

    async _readDocker(cancellable) {
        const prev = this.state.docker;
        let containers;
        try {
            containers = P.parseContainers(await this.docker.getJson('/containers/json?all=1', {cancellable}));
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return {status: e.kind === 'denied' ? 'denied' : 'down', containers: [], vmMemory: null, memory: {}};
        }
        if (!containers)
            return {status: 'down', containers: [], vmMemory: null, memory: {}};
        containers = P.sortContainers(containers);
        let vmMemory = prev.vmMemory, memory = prev.memory;
        if (this.detailed) {
            memory = {};
            try {
                const info = await this.docker.getJson('/info', {cancellable});
                vmMemory = typeof info.MemTotal === 'number' ? info.MemTotal : null;
            } catch (e) {
                if (isCancelled(e))
                    throw e;
            }
            const running = containers.filter(c => c.running).slice(0, 12);
            await Promise.all(running.map(async c => {
                try {
                    const stats = await this.docker.getJson(
                        `/containers/${c.id}/stats?stream=false&one-shot=true`, {cancellable, timeout: 4});
                    const used = P.containerMemory(stats);
                    if (used !== null)
                        memory[c.id] = used;
                } catch (e) {
                    if (isCancelled(e))
                        throw e;
                }
            }));
        }
        return {status: 'ok', containers, vmMemory, memory};
    }

    async _readKube(cancellable) {
        const path = kubeconfigPath();
        const info = await stat(path, cancellable);
        if (!info) {
            this._kubeMtime = null;
            return {current: null, contexts: []};
        }
        if (info.mtime === this._kubeMtime)
            return this.state.kube;
        const text = await readText(path, cancellable);
        this._kubeMtime = info.mtime;
        return text ? P.parseKubeconfig(text) : {current: null, contexts: []};
    }

    /** `docker start` / `docker stop` for one container. */
    async setRunning(id, running) {
        this.pending.add(id);
        this._onUpdate(this.state);
        try {
            await this.docker.request('POST', `/containers/${id}/${running ? 'start' : 'stop?t=10'}`,
                {timeout: 15, cancellable: this._cancellable});
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Tacho: could not ${running ? 'start' : 'stop'} container ${id}: ${e.message}`);
        } finally {
            this.pending.delete(id);
            this.refresh();
        }
    }

    destroy() {
        this.stop();
        this._cancellable.cancel();
        this._onUpdate = () => {};
    }
}
