import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import * as P from '../lib/parsers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = name => readFileSync(path.join(dir, name), 'utf8');

// Fixture timestamps are written as __TODAY__Thh:mm:ss.sssZ; they are
// turned into that local time today (or yesterday), as ISO in UTC, so the
// tests do not depend on the machine's time zone.
function dated(text) {
    return text.replace(/__(TODAY|YESTERDAY)__T(\d\d):(\d\d):(\d\d)\.\d+Z/g, (_, which, h, m, s) => {
        const d = new Date();
        if (which === 'YESTERDAY')
            d.setDate(d.getDate() - 1);
        d.setHours(Number(h), Number(m), Number(s), 0);
        return d.toISOString();
    });
}

test('/proc/stat CPU percent from two samples', () => {
    const a = P.parseProcStat(fixture('proc_stat_1.txt'));
    const b = P.parseProcStat(fixture('proc_stat_2.txt'));
    assert.deepEqual(a, {busy: 1500, total: 10000});
    // busy +400 of total +1000
    assert.equal(P.cpuPercent(a, b), 40);
    assert.equal(P.cpuPercent(null, b), null);
    assert.equal(P.cpuPercent(b, b), null);
});

test('/proc/meminfo uses MemAvailable', () => {
    const m = P.parseMeminfo(fixture('meminfo.txt'));
    assert.equal(m.total, 16384000 * 1024);
    assert.equal(m.used, (16384000 - 8192000) * 1024);
    assert.equal(m.percent, 50);
    assert.equal(m.swapTotal, 2097148 * 1024);
    assert.equal(m.swapUsed, (2097148 - 1048574) * 1024);
});

test('/proc/meminfo without MemAvailable falls back', () => {
    const m = P.parseMeminfo('MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 200 kB\n');
    assert.equal(m.available, 500 * 1024);
    assert.equal(P.parseMeminfo('nothing'), null);
});

test('/proc/net/dev excludes lo and computes rates', () => {
    const a = P.parseNetDev(fixture('net_dev_1.txt'));
    const b = P.parseNetDev(fixture('net_dev_2.txt'));
    assert.deepEqual(a, {rx: 1200000, tx: 600000});
    const r = P.netRates(a, b, 2);
    assert.equal(r.down, 2048576 / 2);
    assert.equal(r.up, 10240 / 2);
    // Counters going backwards read as zero.
    assert.deepEqual(P.netRates(b, a, 1), {down: 0, up: 0});
});

test('loadavg', () => {
    assert.deepEqual(P.parseLoadavg('0.52 0.58 0.59 1/467 12345\n'), [0.52, 0.58, 0.59]);
    assert.equal(P.parseLoadavg('x'), null);
});

test('VPN interfaces: up and running, or routed', () => {
    const routed = P.parseRouteInterfaces(fixture('route.txt'));
    assert.ok(routed.has('tun0'));
    assert.ok(routed.has('wlan0'));
    const entries = [
        {name: 'wlan0', flags: 0x1043},
        {name: 'tun0', flags: 0x1001}, // up, not "running", but routed
        {name: 'wg0', flags: 0x91}, // up + running (0x80|0x10|0x1)? 0x91 lacks 0x40
        {name: 'wg1', flags: 0x41},
        {name: 'tailscale0', flags: 0x0}, // down
        {name: 'docker0', flags: 0x1003},
    ];
    assert.deepEqual(P.vpnInterfaces(entries, routed), ['tun0', 'wg1']);
});

test('temperature sensor preference', () => {
    const sensors = [
        {kind: 'thermal', chip: 'acpitz', path: '/z0'},
        {kind: 'hwmon', chip: 'nvme', label: 'Composite', path: '/nvme'},
        {kind: 'hwmon', chip: 'coretemp', label: 'Core 0', path: '/core0'},
        {kind: 'hwmon', chip: 'coretemp', label: 'Package id 0', path: '/pkg'},
        {kind: 'thermal', chip: 'x86_pkg_temp', path: '/z1'},
    ];
    assert.equal(P.pickTempSensor(sensors), '/pkg');
    assert.equal(P.pickTempSensor([
        {kind: 'hwmon', chip: 'k10temp', label: 'Tccd1', path: '/ccd'},
        {kind: 'hwmon', chip: 'k10temp', label: 'Tctl', path: '/tctl'},
    ]), '/tctl');
    assert.equal(P.pickTempSensor([{kind: 'thermal', chip: 'acpitz', path: '/z0'}]), '/z0');
    assert.equal(P.pickTempSensor([{kind: 'hwmon', chip: 'nvme', label: 'Composite', path: '/n'}]), null);
    assert.equal(P.parseMilliCelsius('54000\n'), 54);
    assert.equal(P.parseMilliCelsius('-273000'), null);
    assert.equal(P.parseMilliCelsius('garbage'), null);
});

test('splitChunk keeps partial lines and filters by substring', () => {
    const enc = new TextEncoder();
    let r = P.splitChunk(null, enc.encode('{"a":"usage"}\n{"b":1}\n{"c":"us'), '"usage"');
    assert.deepEqual(r.lines, ['{"a":"usage"}']);
    assert.equal(r.consumed, '{"a":"usage"}\n{"b":1}\n'.length);
    assert.equal(new TextDecoder().decode(r.carry), '{"c":"us');
    r = P.splitChunk(r.carry, enc.encode('age"}\n'), 'usage');
    assert.deepEqual(r.lines, ['{"c":"usage"}']);
    assert.equal(r.carry.length, 0);
    // No newline at all: everything is carried.
    r = P.splitChunk(null, enc.encode('abc'), 'a');
    assert.deepEqual(r.lines, []);
    assert.equal(r.consumed, 0);
    // Multi-byte UTF-8 split across chunks survives.
    const bytes = enc.encode('{"t":"tiếng việt usage"}\n');
    const r1 = P.splitChunk(null, bytes.subarray(0, 10), 'usage');
    const r2 = P.splitChunk(r1.carry, bytes.subarray(10), 'usage');
    assert.deepEqual(r2.lines, ['{"t":"tiếng việt usage"}']);
});

test('Codex token_count: today tokens and latest windows', () => {
    const u = new P.CodexUsage();
    for (const line of dated(fixture('codex-session.jsonl')).split('\n').filter(l => l.includes('"token_count"')))
        u.addLine(line);
    const s = u.snapshot();
    // today: (12000-10000)+800 + (3000-0)+200 = 6000; yesterday's line is excluded
    assert.equal(s.tokensToday, 6000);
    assert.equal(s.cachedToday, 10000);
    assert.deepEqual(s.windows.map(w => [w.label, w.used, w.resetsAt]),
        [['5h', 44, 1900000000 * 1000], ['7d', 13, 1900500000 * 1000]]);
});

test('Codex older resets_in_seconds format and look-back', () => {
    const w = P.codexWindows({primary: {used_percent: 5, window_minutes: 90, resets_in_seconds: 60}}, 1000);
    assert.deepEqual(w, [{label: '90m', used: 5, resetsAt: 61000}]);
    const u = new P.CodexUsage();
    assert.equal(u.takeWindowsFrom('{"payload":{"rate_limits":null}}'), false);
    assert.equal(u.takeWindowsFrom('{"timestamp":"2025-01-01T00:00:00Z","payload":{"rate_limits":{"primary":{"used_percent":7,"window_minutes":300,"resets_at":1}}}}'), true);
    assert.equal(u.windows[0].label, '5h');
});

test('Codex day rollover resets counters', () => {
    const u = new P.CodexUsage(Date.now() - 86400000 * 2);
    u.tokensToday = 50;
    u.rollDay();
    assert.equal(u.tokensToday, 0);
});

test('Claude Code: dedupe streamed responses by message id, today only', () => {
    const u = new P.ClaudeUsage();
    for (const line of dated(fixture('claude-session.jsonl')).split('\n').filter(l => l.includes('"usage"')))
        u.addLine(line);
    const s = u.snapshot();
    // msg_1 max(10+5+1000, 10+250+1000)=1260, msg_2 103, msg_3 0
    assert.equal(s.tokensToday, 1363);
    assert.equal(s.cachedToday, 41000);
    assert.equal(s.model, 'claude-opus-4-5');
});

test('Claude snapshot file and reset windows', () => {
    const snap = P.parseClaudeSnapshot(fixture('claude-tacho-usage.json'));
    assert.equal(snap.model, 'Opus 4.5');
    assert.equal(snap.updated, 1763000000 * 1000);
    assert.deepEqual(snap.windows.map(w => w.label), ['5h', '7d']);
    const now = 2000 * 1000;
    // 7d reset at 1000 s, so it now reads 0
    assert.equal(P.effectiveWindow(snap.windows[1], now).used, 0);
    assert.equal(P.effectiveWindow(snap.windows[0], now).used, 34);
    assert.equal(P.highestWindow([{windows: snap.windows}, null], now), 34);
    assert.equal(P.highestWindow([], now), null);
    assert.equal(P.parseClaudeSnapshot('not json'), null);
});

test('AI limit alerts fire once per window and reset', () => {
    const sent = new Set();
    let due = P.dueLimitAlerts([{tool: 'claude', label: '5h', used: 82, resetsAt: 1}], sent);
    assert.equal(due.length, 1);
    assert.equal(due[0].threshold, 80);
    due.forEach(d => sent.add(d.key));
    assert.equal(P.dueLimitAlerts([{tool: 'claude', label: '5h', used: 85, resetsAt: 1}], sent).length, 0);
    due = P.dueLimitAlerts([{tool: 'claude', label: '5h', used: 96, resetsAt: 1}], sent);
    assert.equal(due[0].threshold, 95);
    due.forEach(d => sent.add(d.key));
    // New window (different reset): fires again.
    assert.equal(P.dueLimitAlerts([{tool: 'claude', label: '5h', used: 81, resetsAt: 2}], sent).length, 1);
    // Jumping straight to 96 % sends only the 95 % alert; 80 % is implied.
    const s2 = new Set();
    due = P.dueLimitAlerts([{tool: 'codex', label: '7d', used: 99, resetsAt: 5}], s2);
    assert.deepEqual(due.map(d => d.threshold), [95]);
    due.forEach(d => s2.add(d.key));
    assert.equal(P.dueLimitAlerts([{tool: 'codex', label: '7d', used: 90, resetsAt: 5}], s2).length, 0);
});

test('kubeconfig: current context, namespaces, production', () => {
    const k = P.parseKubeconfig(fixture('kubeconfig.yaml'));
    assert.deepEqual(k.current, {name: 'payments-live', cluster: 'gke-main-prd', namespace: 'payments'});
    assert.deepEqual(k.contexts.map(c => c.name), ['payments-live', 'kind-dev', 'minikube']);
    assert.equal(k.contexts[2].namespace, 'default');
    assert.equal(k.contexts[1].namespace, null);
    assert.equal(P.isProduction(k.current), true);
    assert.equal(P.isProduction(k.contexts[1]), false);
    assert.equal(P.isProduction({name: 'eu-PROD-1', cluster: ''}), true);
    assert.deepEqual(P.parseKubeconfig(''), {current: null, contexts: []});
    // Current context that is not in the list.
    assert.deepEqual(P.parseKubeconfig('current-context: ghost\n').current,
        {name: 'ghost', cluster: '', namespace: null});
});

test('HTTP over the Docker socket', () => {
    const enc = new TextEncoder();
    const raw = enc.encode('HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n[{"Id":"abc","Names":["/web"],"Image":"nginx","State":"running","Status":"Up 2 hours"},{"Id":"def","Names":["/db"],"Image":"postgres","State":"exited","Status":"Exited (0)"}]');
    const res = P.parseHttpResponse(raw);
    assert.equal(res.status, 200);
    const list = P.parseContainers(new TextDecoder().decode(res.body));
    assert.deepEqual(list.map(c => [c.name, c.running]), [['web', true], ['db', false]]);
    assert.deepEqual(P.sortContainers([list[1], list[0]]).map(c => c.name), ['web', 'db']);

    const chunked = enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n3\r\n:1}\r\n0\r\n\r\n');
    const c = P.parseHttpResponse(chunked);
    assert.equal(new TextDecoder().decode(c.body), '{"a":1}');
    assert.equal(P.parseHttpResponse(enc.encode('garbage')), null);
    assert.equal(P.parseHttpResponse(enc.encode('HTTP/1.0 304 Not Modified\r\n\r\n')).status, 304);
    assert.equal(P.httpRequest('POST', '/containers/x/stop?t=10'),
        'POST /containers/x/stop?t=10 HTTP/1.0\r\nHost: docker\r\nContent-Length: 0\r\n\r\n');
});

test('container memory leaves out page cache', () => {
    assert.equal(P.containerMemory({memory_stats: {usage: 1000, stats: {inactive_file: 300}}}), 700);
    assert.equal(P.containerMemory({memory_stats: {usage: 1000, stats: {total_inactive_file: 100}}}), 900);
    assert.equal(P.containerMemory({memory_stats: {usage: 100, stats: {inactive_file: 300}}}), 100);
    assert.equal(P.containerMemory({memory_stats: {}}), null);
});

test('formatting', () => {
    assert.equal(P.formatRateShort(0), '0B');
    assert.equal(P.formatRateShort(1536), '1.5K');
    assert.equal(P.formatRateShort(50 * 1024 * 1024), '50M');
    assert.equal(P.formatBytes(1536), '1.5 KB');
    assert.equal(P.formatBytes(3 * 1024 ** 3), '3.0 GB');
    assert.equal(P.formatRate(2048), '2.0 KB/s');
    assert.equal(P.formatTokens(999), '999');
    assert.equal(P.formatTokens(1500), '1.5K');
    assert.equal(P.formatTokens(250000), '250K');
    assert.equal(P.formatTokens(2_340_000), '2.3M');
    assert.deepEqual(P.timeUntil(0 + 90 * 60000 + 1, 0), {days: 0, hours: 1, minutes: 31});
    assert.deepEqual(P.timeUntil(3 * 86400000, 0), {days: 3, hours: 0, minutes: 0});
    assert.equal(P.timeUntil(5, 10), null);
    assert.equal(P.windowLabel(300), '5h');
    assert.equal(P.windowLabel(10080), '7d');
    assert.equal(P.temperatureLevel(69.9), 'normal');
    assert.equal(P.temperatureLevel(70), 'warning');
    assert.equal(P.temperatureLevel(90), 'critical');
    assert.equal(P.limitLevel(80), 'warning');
    assert.equal(P.limitLevel(95), 'critical');
});

test('graph key changes only when the drawing would', () => {
    assert.equal(P.graphKey([0.5, 0.501]), P.graphKey([0.501, 0.5]));
    assert.notEqual(P.graphKey([0.5]), P.graphKey([0.6]));
    const h = new P.History(3);
    [1, 2, 3, 4].forEach(v => h.push(v));
    assert.deepEqual(h.values, [2, 3, 4]);
    assert.equal(h.max(), 4);
});
