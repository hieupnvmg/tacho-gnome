// Runs the Gio-based readers under plain GJS (no GNOME Shell needed):
//
//   gjs -m test/gjs-smoke.js
//
// It builds a temporary HOME from the fixtures, reads it through the real
// AiWatcher (incremental JSONL tailing included), appends to the logs and
// reads again, then tries the system sampler and the Docker/kubeconfig
// watcher on whatever this machine has.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// The readers resolve HOME when they run, not when imported.
import {AiWatcher} from '../lib/ai.js';
import {InfraWatcher} from '../lib/infra.js';
import {SystemSampler} from '../lib/system.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fixtures = `${here}/fixtures`;
let failures = 0;

function check(cond, what) {
    print(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
    if (!cond)
        failures++;
}

function dated(text) {
    return text.replace(/__(TODAY|YESTERDAY)__T(\d\d):(\d\d):(\d\d)\.\d+Z/g, (_, which, h, m, s) => {
        const d = new Date();
        if (which === 'YESTERDAY')
            d.setDate(d.getDate() - 1);
        d.setHours(Number(h), Number(m), Number(s), 0);
        return d.toISOString();
    });
}

function readFixture(name) {
    const [, bytes] = GLib.file_get_contents(`${fixtures}/${name}`);
    return new TextDecoder().decode(bytes);
}

function write(path, text, append = false) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const file = Gio.File.new_for_path(path);
    const stream = append
        ? file.append_to(Gio.FileCreateFlags.NONE, null)
        : file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(text), null);
    stream.close(null);
}

const home = GLib.dir_make_tmp('tacho-home-XXXXXX');
GLib.setenv('HOME', home, true);
GLib.unsetenv('CODEX_HOME');
GLib.unsetenv('CLAUDE_CONFIG_DIR');
GLib.unsetenv('KUBECONFIG');

const codexLog = `${home}/.codex/sessions/2026/11/14/rollout-1.jsonl`;
const claudeLog = `${home}/.claude/projects/-home-u-proj/session-1.jsonl`;
write(codexLog, dated(readFixture('codex-session.jsonl')));
write(claudeLog, dated(readFixture('claude-session.jsonl')));
write(`${home}/.claude/tacho-usage.json`, readFixture('claude-tacho-usage.json'));
write(`${home}/.kube/config`, readFixture('kubeconfig.yaml'));

const loop = new GLib.MainLoop(null, false);

async function main() {
    const ai = new AiWatcher(() => {});
    await ai.refresh();
    const {claude, codex} = ai.state;
    check(codex?.tokensToday === 6000, `Codex tokens today 6000 (got ${codex?.tokensToday})`);
    check(codex?.windows?.[0]?.used === 44, `Codex 5h window 44% (got ${codex?.windows?.[0]?.used})`);
    check(claude?.tokensToday === 1363, `Claude tokens today 1363 (got ${claude?.tokensToday})`);
    check(claude?.statusLine === true && claude.windows.length === 2, 'Claude limits from tacho-usage.json');

    // A streamed response grows, a half-written line waits for its end.
    const t = new Date().toISOString();
    write(claudeLog, `{"type":"assistant","timestamp":"${t}","message":{"id":"msg_2","usage":{"input_tokens":3,"output_tokens":400}}}\n{"type":"assistant","timestamp":"${t}","message":{"id":"msg_9","usa`, true);
    await ai.refresh();
    check(ai.state.claude.tokensToday === 1363 + 300, `incremental read, dedupe by id (got ${ai.state.claude.tokensToday})`);
    write(claudeLog, `ge":{"input_tokens":1,"output_tokens":9}}}\n`, true);
    await ai.refresh();
    check(ai.state.claude.tokensToday === 1363 + 300 + 10, `half-written line read once complete (got ${ai.state.claude.tokensToday})`);
    ai.destroy();

    // A stand-in Docker engine on a socket in the temporary HOME.
    const socket = `${home}/docker.sock`;
    const fake = Gio.Subprocess.new(['python3', `${here}/fake-docker.py`, socket],
        Gio.SubprocessFlags.STDOUT_PIPE);
    await new Promise(resolve => fake.get_stdout_pipe().read_bytes_async(16, 0, null, () => resolve()));
    GLib.setenv('DOCKER_HOST', `unix://${socket}`, true);

    const infra = new InfraWatcher(() => {});
    infra.detailed = true;
    await infra.refresh();
    const {kube, docker} = infra.state;
    check(kube.current?.name === 'payments-live', `kube current context (got ${kube.current?.name})`);
    check(docker.status === 'ok' && docker.containers.length === 2, `docker containers over the socket (got ${docker.status}, ${docker.containers.length})`);
    check(docker.containers[0].name === 'web' && docker.containers[0].running, 'running container listed first');
    check(docker.vmMemory === 8 * 1024 ** 3, `engine memory from /info (got ${docker.vmMemory})`);
    check(docker.memory.aaa111 === 200 * 1024 ** 2, `container memory without page cache (got ${docker.memory.aaa111})`);
    await infra.setRunning('bbb222', true);
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => r() ?? GLib.SOURCE_REMOVE));
    check(infra.state.docker.containers.every(c => c.running), 'start a container with POST');
    fake.force_exit();
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => r() ?? GLib.SOURCE_REMOVE));
    await infra.refresh();
    check(infra.state.docker.status === 'down', `engine gone reads as down (got ${infra.state.docker.status})`);
    infra.destroy();

    // A fake /proc and /sys built from the fixtures.
    const root = `${home}/root`;
    write(`${root}/proc/stat`, readFixture('proc_stat_1.txt'));
    write(`${root}/proc/meminfo`, readFixture('meminfo.txt'));
    write(`${root}/proc/net/dev`, readFixture('net_dev_1.txt'));
    write(`${root}/proc/net/route`, readFixture('route.txt'));
    write(`${root}/proc/loadavg`, '0.52 0.58 0.59 1/467 12345\n');
    write(`${root}/sys/class/hwmon/hwmon0/name`, 'nvme\n');
    write(`${root}/sys/class/hwmon/hwmon0/temp1_input`, '41000\n');
    write(`${root}/sys/class/hwmon/hwmon3/name`, 'coretemp\n');
    write(`${root}/sys/class/hwmon/hwmon3/temp1_input`, '72000\n');
    write(`${root}/sys/class/hwmon/hwmon3/temp1_label`, 'Package id 0\n');
    write(`${root}/sys/class/hwmon/hwmon3/temp2_input`, '65000\n');
    write(`${root}/sys/class/hwmon/hwmon3/temp2_label`, 'Core 0\n');
    write(`${root}/sys/class/net/wlan0/flags`, '0x1003\n');
    write(`${root}/sys/class/net/tun0/flags`, '0x1001\n');
    const sampler = new SystemSampler(root);
    const want = {cpu: true, temp: true, ram: true, net: true, vpn: true, load: true};
    await sampler.sample(want, null);
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => r() ?? GLib.SOURCE_REMOVE));
    write(`${root}/proc/stat`, readFixture('proc_stat_2.txt'));
    write(`${root}/proc/net/dev`, readFixture('net_dev_2.txt'));
    const s = await sampler.sample(want, null);
    check(s.cpu === 40, `CPU % from two /proc/stat samples (got ${s.cpu})`);
    check(s.temp === 72, `package temperature chosen over cores and NVMe (got ${s.temp})`);
    check(s.ram?.percent === 50, `memory % (got ${s.ram?.percent})`);
    check(s.net?.down > 0 && s.net?.up > 0, `network rates (got ${JSON.stringify(s.net)})`);
    check(JSON.stringify(s.vpn) === '["tun0"]', `VPN interfaces (got ${JSON.stringify(s.vpn)})`);
    check(s.load?.[0] === 0.52, `load average (got ${s.load})`);
    check(sampler.cpu.values.length === 1 && sampler.down.values.length === 1, 'histories filled');

    // And this machine's real /proc, if it has one (Linux).
    const real = new SystemSampler();
    await real.sample(want, null);
    const r = await real.sample(want, null);
    print(`     this machine: cpu=${r.cpu} temp=${r.temp} ram=${r.ram?.percent} vpn=${JSON.stringify(r.vpn)}`);
}

main().catch(e => {
    logError(e);
    failures++;
}).finally(() => {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(home)}`);
    loop.quit();
});
loop.run();
print(failures ? `${failures} failed` : 'all passed');
System.exit(failures ? 1 : 0);
