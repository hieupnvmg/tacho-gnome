// Pure parsing and formatting helpers. Nothing here imports GNOME
// libraries, so the same file runs under GJS and under Node for the tests.

// ---------------------------------------------------------------- /proc

/** `/proc/stat` → totals of the aggregate "cpu" line: {busy, total}. */
export function parseProcStat(text) {
    for (const line of text.split('\n')) {
        if (!line.startsWith('cpu '))
            continue;
        const f = line.trim().split(/\s+/).slice(1).map(Number);
        // user nice system idle iowait irq softirq steal (guest is in user)
        const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0,
            irq = 0, softirq = 0, steal = 0] = f;
        const idleAll = idle + iowait;
        const total = user + nice + system + idleAll + irq + softirq + steal;
        return {busy: total - idleAll, total};
    }
    return null;
}

/** CPU % between two `parseProcStat` samples, or null. */
export function cpuPercent(prev, cur) {
    if (!prev || !cur)
        return null;
    const total = cur.total - prev.total;
    if (total <= 0)
        return null;
    return clamp(((cur.busy - prev.busy) / total) * 100, 0, 100);
}

/** `/proc/meminfo` → bytes {total, available, used, percent, swapTotal, swapUsed}. */
export function parseMeminfo(text) {
    const kb = {};
    for (const line of text.split('\n')) {
        const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
        if (m)
            kb[m[1]] = Number(m[2]);
    }
    const total = (kb.MemTotal ?? 0) * 1024;
    if (!total)
        return null;
    // MemAvailable exists since Linux 3.14; estimate it on anything older.
    const available = (kb.MemAvailable ??
        ((kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0))) * 1024;
    const used = Math.max(total - available, 0);
    const swapTotal = (kb.SwapTotal ?? 0) * 1024;
    const swapUsed = Math.max(swapTotal - (kb.SwapFree ?? 0) * 1024, 0);
    return {total, available, used, percent: (used / total) * 100, swapTotal, swapUsed};
}

/** `/proc/net/dev` → {rx, tx} bytes summed over every interface but `lo`. */
export function parseNetDev(text) {
    let rx = 0, tx = 0, found = false;
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const name = line.slice(0, colon).trim();
        if (!name || name === 'lo' || name.includes('|'))
            continue;
        const f = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (f.length < 9)
            continue;
        rx += f[0];
        tx += f[8];
        found = true;
    }
    return found ? {rx, tx} : null;
}

/** Bytes per second between two `parseNetDev` samples taken `seconds` apart. */
export function netRates(prev, cur, seconds) {
    if (!prev || !cur || !(seconds > 0))
        return null;
    // A counter that went backwards (interface removed) reads as zero.
    return {
        down: Math.max(cur.rx - prev.rx, 0) / seconds,
        up: Math.max(cur.tx - prev.tx, 0) / seconds,
    };
}

/** `/proc/loadavg` → [1, 5, 15] minute averages. */
export function parseLoadavg(text) {
    const f = text.trim().split(/\s+/).slice(0, 3).map(Number);
    return f.length === 3 && f.every(Number.isFinite) ? f : null;
}

/** `/proc/net/route` → set of interface names with an IPv4 route. */
export function parseRouteInterfaces(text) {
    const names = new Set();
    for (const line of text.split('\n').slice(1)) {
        const name = line.split('\t')[0]?.trim();
        if (name)
            names.add(name);
    }
    return names;
}

export const VPN_PATTERN = /^(tun|wg|utun|ppp|tailscale|nordlynx|proton|ipsec|vpn)/;

const IFF_UP = 0x1, IFF_RUNNING = 0x40;

/**
 * VPN interfaces that are up. `entries` are {name, flags} from
 * /sys/class/net/<name>/flags; `routed` is the set from
 * `parseRouteInterfaces`. An interface counts when it is up and either
 * running or carrying an IPv4 route.
 */
export function vpnInterfaces(entries, routed = new Set()) {
    return entries
        .filter(e => VPN_PATTERN.test(e.name))
        .filter(e => (e.flags & IFF_UP) && ((e.flags & IFF_RUNNING) || routed.has(e.name)))
        .map(e => e.name)
        .sort();
}

/**
 * Picks the CPU temperature sensor. `sensors` are
 * {chip, label, path, kind: 'hwmon'|'thermal'}; for thermal zones `chip`
 * is the zone's type. Returns the chosen path or null.
 */
export function pickTempSensor(sensors) {
    const rank = s => {
        const chip = (s.chip ?? '').toLowerCase();
        const label = (s.label ?? '').toLowerCase();
        if (s.kind === 'hwmon') {
            if (chip === 'coretemp')
                return label.startsWith('package') ? 100 : label === '' ? 60 : 50;
            if (chip === 'k10temp' || chip === 'zenpower') {
                if (label === 'tctl')
                    return 100;
                if (label === 'tdie')
                    return 95;
                return label === '' ? 60 : 40;
            }
            if (chip === 'cpu_thermal' || chip === 'soc_thermal')
                return 70;
            if (label.startsWith('package') || label === 'tctl' || label === 'cpu')
                return 65;
            return 0;
        }
        if (chip === 'x86_pkg_temp')
            return 80;
        if (chip.includes('cpu') || chip.includes('soc'))
            return 55;
        if (chip === 'acpitz')
            return 20;
        return 10;
    };
    let best = null, bestRank = 0;
    for (const s of sensors) {
        const r = rank(s);
        if (r > bestRank) {
            best = s;
            bestRank = r;
        }
    }
    return best?.path ?? null;
}

/** A hwmon/thermal millidegree reading → °C, or null. */
export function parseMilliCelsius(text) {
    const v = Number(String(text).trim());
    if (!Number.isFinite(v))
        return null;
    const c = v / 1000;
    return c > -40 && c < 150 ? c : null;
}

// ---------------------------------------------------------------- JSONL

/**
 * Splits newly read bytes into complete lines. `carry` holds the bytes of
 * a line that was cut off by the previous chunk. Returns the lines that
 * contain `needle` (decoded), the new carry, and how many bytes were
 * consumed as whole lines.
 */
export function splitChunk(carry, chunk, needle, decoder = new TextDecoder()) {
    let data;
    if (carry && carry.length) {
        data = new Uint8Array(carry.length + chunk.length);
        data.set(carry, 0);
        data.set(chunk, carry.length);
    } else {
        data = chunk;
    }
    const end = data.lastIndexOf(0x0A);
    if (end < 0)
        return {lines: [], carry: data, consumed: 0};
    const text = decoder.decode(data.subarray(0, end));
    const lines = needle
        ? text.split('\n').filter(l => l.includes(needle))
        : text.split('\n');
    return {lines, carry: data.slice(end + 1), consumed: end + 1};
}

function tryParse(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/** "5h", "7d", "90m" for a window length in minutes. */
export function windowLabel(minutes) {
    if (minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}

/** Local midnight of the day containing `ms`. */
export function startOfDay(ms = Date.now()) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Codex `payload.rate_limits` → [{label, used, resetsAt(ms)|null}] or null. */
export function codexWindows(limits, timestampMs = null) {
    if (!limits || typeof limits !== 'object')
        return null;
    const out = [];
    for (const key of ['primary', 'secondary']) {
        const w = limits[key];
        if (!w || typeof w.used_percent !== 'number' || typeof w.window_minutes !== 'number')
            continue;
        let resetsAt = null;
        if (typeof w.resets_at === 'number')
            resetsAt = w.resets_at * 1000;
        else if (typeof w.resets_in_seconds === 'number' && timestampMs)
            resetsAt = timestampMs + w.resets_in_seconds * 1000;
        out.push({label: windowLabel(w.window_minutes), used: w.used_percent, resetsAt});
    }
    return out;
}

/** Accumulates Codex `token_count` events for one day. */
export class CodexUsage {
    constructor(now = Date.now()) {
        this.day = startOfDay(now);
        this.tokensToday = 0;
        this.cachedToday = 0;
        this.windows = [];
        this.windowsUpdated = null;
    }

    /** Resets today's counters when the date has changed. */
    rollDay(now = Date.now()) {
        const day = startOfDay(now);
        if (day !== this.day) {
            this.day = day;
            this.tokensToday = 0;
            this.cachedToday = 0;
        }
    }

    /** Feeds one log line; returns true if it was a token_count event. */
    addLine(line) {
        const obj = tryParse(line);
        const payload = obj?.payload;
        if (!payload || payload.type !== 'token_count')
            return false;
        const when = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        const last = payload.info?.last_token_usage;
        if (Number.isFinite(when) && when >= this.day && last) {
            const input = last.input_tokens ?? 0;
            const cached = last.cached_input_tokens ?? 0;
            const output = last.output_tokens ?? 0;
            this.tokensToday += Math.max(input - cached, 0) + output;
            this.cachedToday += cached;
        }
        const windows = codexWindows(payload.rate_limits, Number.isFinite(when) ? when : null);
        if (windows?.length) {
            const at = Number.isFinite(when) ? when : 0;
            if (at >= (this.windowsUpdated ?? 0)) {
                this.windows = windows;
                this.windowsUpdated = at || null;
            }
        }
        return true;
    }

    /** For look-back: takes the windows of a single line if it has any. */
    takeWindowsFrom(line) {
        const obj = tryParse(line);
        const when = obj?.timestamp ? Date.parse(obj.timestamp) : NaN;
        const windows = codexWindows(obj?.payload?.rate_limits, Number.isFinite(when) ? when : null);
        if (!windows?.length)
            return false;
        this.windows = windows;
        this.windowsUpdated = Number.isFinite(when) ? when : null;
        return true;
    }

    snapshot() {
        return {
            windows: this.windows.slice(),
            windowsUpdated: this.windowsUpdated,
            tokensToday: this.tokensToday,
            cachedToday: this.cachedToday,
            model: null,
        };
    }
}

/** Accumulates Claude Code responses for one day, deduplicated by message id. */
export class ClaudeUsage {
    constructor(now = Date.now()) {
        this.day = startOfDay(now);
        this.responses = new Map();
        this.model = null;
        this._anon = 0;
    }

    rollDay(now = Date.now()) {
        const day = startOfDay(now);
        if (day !== this.day) {
            this.day = day;
            this.responses.clear();
        }
    }

    addLine(line) {
        const obj = tryParse(line);
        const message = obj?.message;
        const usage = message?.usage;
        if (!usage || !obj.timestamp)
            return false;
        const when = Date.parse(obj.timestamp);
        if (!Number.isFinite(when) || when < this.day)
            return false;
        const id = message.id ?? obj.uuid ?? `anon-${this._anon++}`;
        const fresh = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
        const cached = usage.cache_read_input_tokens ?? 0;
        const seen = this.responses.get(id);
        this.responses.set(id, {
            fresh: Math.max(seen?.fresh ?? 0, fresh),
            cached: Math.max(seen?.cached ?? 0, cached),
        });
        if (typeof message.model === 'string' && !message.model.startsWith('<'))
            this.model = message.model;
        return true;
    }

    snapshot() {
        let fresh = 0, cached = 0;
        for (const r of this.responses.values()) {
            fresh += r.fresh;
            cached += r.cached;
        }
        return {windows: [], windowsUpdated: null, tokensToday: fresh, cachedToday: cached, model: this.model};
    }
}

/** `~/.claude/tacho-usage.json` → {windows, updated(ms), model} or null. */
export function parseClaudeSnapshot(text) {
    const obj = tryParse(text);
    if (!obj || !Array.isArray(obj.windows))
        return null;
    const windows = obj.windows
        .filter(w => w && typeof w.label === 'string' && typeof w.used === 'number')
        .map(w => ({
            label: w.label,
            used: w.used,
            resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null,
        }));
    return {
        windows,
        updated: typeof obj.updated === 'number' ? obj.updated * 1000 : null,
        model: typeof obj.model === 'string' ? obj.model : null,
    };
}

/** A window whose reset time has passed is at 0% until the next report. */
export function effectiveWindow(w, now = Date.now()) {
    if (w.resetsAt && w.resetsAt <= now)
        return {...w, used: 0, reset: true};
    return {...w, reset: false};
}

/** Highest effective window % across assistants' usages, or null. */
export function highestWindow(usages, now = Date.now()) {
    let best = null;
    for (const u of usages) {
        for (const w of u?.windows ?? []) {
            const e = effectiveWindow(w, now);
            if (best === null || e.used > best)
                best = e.used;
        }
    }
    return best;
}

/**
 * Which AI limit alerts to send now. `alerts` is a list of
 * {tool, label, used, resetsAt}; `sent` the keys already sent. Returns
 * [{key, tool, label, used, threshold}] — only the highest threshold
 * crossed per window.
 */
export function dueLimitAlerts(alerts, sent, thresholds = [80, 95]) {
    const due = [];
    for (const a of alerts) {
        const crossed = thresholds.filter(t => a.used >= t);
        if (!crossed.length)
            continue;
        const threshold = Math.max(...crossed);
        const key = `${a.tool}:${a.label}:${a.resetsAt ?? 'none'}:${threshold}`;
        if (sent.has(key))
            continue;
        // A lower threshold of the same window is implied once a higher one fired.
        const higherSent = thresholds.some(t => t > threshold &&
            sent.has(`${a.tool}:${a.label}:${a.resetsAt ?? 'none'}:${t}`));
        if (!higherSent)
            due.push({key, tool: a.tool, label: a.label, used: a.used, threshold});
    }
    return due;
}

// ---------------------------------------------------------------- Kubernetes

/** True when a context's name or cluster says production. */
export function isProduction(ctx) {
    if (!ctx)
        return false;
    const text = `${ctx.name ?? ''} ${ctx.cluster ?? ''}`.toLowerCase();
    return text.includes('prod') || text.includes('prd');
}

function yamlValue(line) {
    const colon = line.indexOf(':');
    if (colon < 0)
        return '';
    const v = line.slice(colon + 1).trim();
    const quote = v[0];
    if (quote === '"' || quote === "'") {
        const close = v.indexOf(quote, 1);
        return close > 0 ? v.slice(1, close) : v.slice(1);
    }
    // A trailing comment outside quotes.
    return v.replace(/\s+#.*$/, '');
}

/**
 * Just enough YAML for kubeconfig: `current-context` and the `contexts`
 * list with name, cluster and namespace. Returns {current, contexts}.
 */
export function parseKubeconfig(text) {
    let currentName = null;
    const contexts = [];
    let inContexts = false;
    let entry = {};
    const flush = () => {
        if (entry.name)
            contexts.push({name: entry.name, cluster: entry.cluster ?? '', namespace: entry.namespace ?? null});
        entry = {};
    };
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.trim().startsWith('#') || line.trim() === '')
            continue;
        const topLevel = !/^[\s-]/.test(line);
        if (topLevel) {
            if (inContexts)
                flush();
            inContexts = line.startsWith('contexts:');
            if (line.startsWith('current-context:'))
                currentName = yamlValue(line) || null;
            continue;
        }
        if (!inContexts)
            continue;
        let content = line.trim();
        if (content.startsWith('- ')) {
            flush();
            content = content.slice(2).trim();
        }
        for (const key of ['name', 'cluster', 'namespace']) {
            if (content.startsWith(`${key}:`))
                entry[key] = yamlValue(content);
        }
    }
    if (inContexts)
        flush();
    const current = currentName
        ? contexts.find(c => c.name === currentName) ?? {name: currentName, cluster: '', namespace: null}
        : null;
    return {current, contexts};
}

// ---------------------------------------------------------------- Docker

function indexOfSeq(data, seq, from = 0) {
    outer: for (let i = from; i <= data.length - seq.length; i++) {
        for (let j = 0; j < seq.length; j++) {
            if (data[i + j] !== seq[j])
                continue outer;
        }
        return i;
    }
    return -1;
}

function dechunk(body) {
    const parts = [];
    let pos = 0, total = 0;
    const decoder = new TextDecoder();
    while (pos < body.length) {
        const lineEnd = indexOfSeq(body, [13, 10], pos);
        if (lineEnd < 0)
            break;
        const size = parseInt(decoder.decode(body.subarray(pos, lineEnd)), 16);
        if (!Number.isFinite(size) || size === 0)
            break;
        const start = lineEnd + 2;
        parts.push(body.subarray(start, start + size));
        total += size;
        pos = start + size + 2;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/** Raw HTTP/1.x response bytes → {status, headers, body(Uint8Array)} or null. */
export function parseHttpResponse(data) {
    const split = indexOfSeq(data, [13, 10, 13, 10]);
    if (split < 0)
        return null;
    const head = new TextDecoder().decode(data.subarray(0, split)).split('\r\n');
    const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head[0] ?? '');
    if (!m)
        return null;
    const headers = {};
    for (const h of head.slice(1)) {
        const c = h.indexOf(':');
        if (c > 0)
            headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim();
    }
    let body = data.subarray(split + 4);
    if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked'))
        body = dechunk(body);
    return {status: Number(m[1]), headers, body};
}

export function httpRequest(method, path) {
    return `${method} ${path} HTTP/1.0\r\nHost: docker\r\nContent-Length: 0\r\n\r\n`;
}

/** `/containers/json?all=1` body → [{id, name, image, state, status, running}]. */
export function parseContainers(json) {
    const list = typeof json === 'string' ? tryParse(json) : json;
    if (!Array.isArray(list))
        return null;
    return list.map(e => {
        const name = (e.Names?.[0] ?? '').replace(/^\/+/, '');
        return {
            id: e.Id ?? name,
            name: name || (e.Id ?? '').slice(0, 12),
            image: e.Image ?? '',
            state: e.State ?? '',
            status: e.Status ?? '',
            running: e.State === 'running',
        };
    });
}

/** Containers sorted running first, then by name. */
export function sortContainers(list) {
    return list.slice().sort((a, b) =>
        (b.running - a.running) || a.name.localeCompare(b.name));
}

/** One-shot stats body → bytes used without page cache, like `docker stats`. */
export function containerMemory(json) {
    const stats = typeof json === 'string' ? tryParse(json) : json;
    const mem = stats?.memory_stats;
    if (typeof mem?.usage !== 'number')
        return null;
    const s = mem.stats ?? {};
    const cache = s.inactive_file ?? s.total_inactive_file ?? s.cache ?? 0;
    return mem.usage > cache ? mem.usage - cache : mem.usage;
}

// ---------------------------------------------------------------- Formatting

export function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

/** 1536 → "1.5K", for the compact panel: K/M/G with no "B". */
export function formatRateShort(bytesPerSec) {
    const v = Math.max(bytesPerSec ?? 0, 0);
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0, n = v;
    while (n >= 1000 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    if (i === 0)
        return `${Math.round(n)}B`;
    return `${n < 10 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/** Bytes → "1.5 GB" (binary multiples, labelled the way GNOME does for memory). */
export function formatBytes(bytes) {
    const v = Math.max(bytes ?? 0, 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = v;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return i === 0 ? `${Math.round(n)} B` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function formatRate(bytesPerSec) {
    return `${formatBytes(bytesPerSec)}/s`;
}

/** 1234567 → "1.2M". */
export function formatTokens(n) {
    const v = Math.max(n ?? 0, 0);
    if (v >= 1e9)
        return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6)
        return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3)
        return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`;
    return `${Math.round(v)}`;
}

/** Time left until `ms` as {days, hours, minutes}, or null if past. */
export function timeUntil(ms, now = Date.now()) {
    if (!ms || ms <= now)
        return null;
    let m = Math.ceil((ms - now) / 60000);
    const days = Math.floor(m / 1440);
    m -= days * 1440;
    const hours = Math.floor(m / 60);
    return {days, hours, minutes: m - hours * 60};
}

/** Temperature level: 'normal' below 70 °C, 'warning' to 90, 'critical' above. */
export function temperatureLevel(c) {
    if (c === null || c === undefined)
        return 'normal';
    if (c >= 90)
        return 'critical';
    if (c >= 70)
        return 'warning';
    return 'normal';
}

/** AI limit level: 'warning' at 80 %, 'critical' at 95 %. */
export function limitLevel(p) {
    if (p === null || p === undefined)
        return 'normal';
    if (p >= 95)
        return 'critical';
    if (p >= 80)
        return 'warning';
    return 'normal';
}

/**
 * Quantizes a history (values 0..1) into `levels` steps so a graph is only
 * repainted when what it would draw changes. Returns a string key.
 */
export function graphKey(values, levels = 24) {
    let key = '';
    for (const v of values)
        key += String.fromCharCode(48 + Math.round(clamp(v ?? 0, 0, 1) * levels));
    return key;
}

/** Fixed-length history of numbers. */
export class History {
    constructor(length = 40) {
        this.length = length;
        this.values = [];
    }

    push(v) {
        this.values.push(v);
        if (this.values.length > this.length)
            this.values.shift();
    }

    max() {
        return this.values.reduce((a, b) => Math.max(a, b ?? 0), 0);
    }
}
