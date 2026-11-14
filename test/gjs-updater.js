// Checks the updater against the real GitHub releases (needs the network
// and libsoup 3):
//
//   gjs -m test/gjs-updater.js
//
// It pretends to be version 0.0.1, so the newest release is offered, then
// downloads it and verifies its checksum. Installing is pointed at a fake
// `gnome-extensions` on PATH, which only records its arguments.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {Updater} from '../lib/updater.js';

const tmp = GLib.dir_make_tmp('tacho-update-XXXXXX');
GLib.setenv('XDG_CACHE_HOME', tmp, true);
const bin = `${tmp}/bin`;
GLib.mkdir_with_parents(bin, 0o755);
GLib.file_set_contents(`${bin}/gnome-extensions`, `#!/bin/sh\necho "$@" > "${tmp}/installed-args"\n`);
GLib.chmod(`${bin}/gnome-extensions`, 0o755);
GLib.setenv('PATH', `${bin}:${GLib.getenv('PATH')}`, true);

let failures = 0;
function check(cond, what) {
    print(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
    if (!cond)
        failures++;
}

const settings = {get_boolean: () => true};
const updater = new Updater({
    uuid: 'tacho@hieupnvmg.github.io',
    current: '0.0.1',
    settings,
    onChange: () => {},
});

const loop = new GLib.MainLoop(null, false);
(async () => {
    await updater.check();
    check(updater.state === 'available', `a newer release is offered (state ${updater.state}, ${updater.release?.version})`);
    check(Boolean(updater.release?.shaUrl), 'the release has a .sha256');
    await updater.install();
    check(updater.state === 'installed', `downloaded, checksum verified, installed (state ${updater.state} ${updater.error ?? ''})`);
    const [ok, args] = GLib.file_get_contents(`${tmp}/installed-args`);
    check(ok && new TextDecoder().decode(args).startsWith('install --force '), 'gnome-extensions install --force <zip>');

    const current = new Updater({uuid: 'tacho@hieupnvmg.github.io', current: '999.0', settings, onChange: () => {}});
    await current.check();
    check(current.state === 'idle', 'nothing offered when already newest');
})().catch(e => {
    logError(e);
    failures++;
}).finally(() => {
    Gio.Subprocess.new(['rm', '-rf', tmp], Gio.SubprocessFlags.NONE);
    loop.quit();
});
loop.run();
print(failures ? `${failures} failed` : 'all passed');
System.exit(failures ? 1 : 0);
