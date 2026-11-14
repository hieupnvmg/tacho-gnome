// Over-the-air updates for copies installed from GitHub releases.
//
// Only in the GitHub build (metadata "update-channel": "github"); the build
// for extensions.gnome.org leaves this file out, since there the site and
// GNOME's Extensions app handle updates.
//
// Every 6 hours it asks the GitHub API for the repository's releases. When
// a newer one carries the extension zip, the menu offers it; installing
// downloads the zip, checks its SHA-256 against the release's .sha256 file
// and hands it to `gnome-extensions install --force`. GNOME Shell loads the
// new code at the next login (Wayland) or shell restart (X11).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as P from './parsers.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const REPO = 'hieupnvmg/tacho-gnome';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const FIRST_CHECK = 60; // seconds after login
const INTERVAL = 6 * 3600;

export class Updater {
    /**
     * `uuid` and `current` come from metadata.json; `onChange(updater)` is
     * called when `state` changes.
     */
    constructor({uuid, current, settings, onChange}) {
        this._uuid = uuid;
        this._current = current;
        this._settings = settings;
        this._onChange = onChange;
        this._assetName = `${uuid}.shell-extension.zip`;
        this._session = new Soup.Session({user_agent: `Tacho-GNOME/${current}`, timeout: 60});
        this._cancellable = new Gio.Cancellable();
        this._timer = 0;
        /** idle | checking | available | downloading | installed | failed */
        this.state = 'idle';
        this.release = null;
        this.error = null;
    }

    get current() {
        return this._current;
    }

    start() {
        if (this._timer)
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, FIRST_CHECK, () => {
            this.check();
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, INTERVAL, () => {
                this.check();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _set(state, extra = {}) {
        this.state = state;
        Object.assign(this, extra);
        this._onChange(this);
    }

    async _get(url) {
        const message = Soup.Message.new('GET', url);
        if (url.startsWith('https://api.github.com/'))
            message.request_headers.append('Accept', 'application/vnd.github+json');
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable);
        const status = message.get_status();
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status} for ${url}`);
        return bytes;
    }

    /** Asks GitHub for a newer release. */
    async check() {
        if (['checking', 'downloading', 'installed'].includes(this.state))
            return;
        const before = this.state;
        this.state = 'checking';
        try {
            const bytes = await this._get(API);
            const releases = JSON.parse(new TextDecoder().decode(bytes.toArray()));
            const release = P.pickRelease(releases, this._current, this._assetName,
                this._settings.get_boolean('update-prereleases'));
            if (release)
                this._set('available', {release, error: null});
            else
                this._set('idle', {release: null, error: null});
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // Offline or rate-limited: try again at the next check, quietly.
            console.warn(`Tacho: update check failed: ${e.message}`);
            this.state = before === 'checking' ? 'idle' : before;
        }
    }

    /** Downloads, verifies and installs the available release. */
    async install() {
        const release = this.release;
        if (!release || this.state === 'downloading' || this.state === 'installed')
            return;
        this._set('downloading', {error: null});
        try {
            const zip = await this._get(release.zipUrl);
            if (release.shaUrl) {
                const expected = P.parseSha256(new TextDecoder().decode((await this._get(release.shaUrl)).toArray()));
                const actual = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, zip);
                if (!expected || expected !== actual)
                    throw new Error('the download does not match its checksum');
            }
            const dir = `${GLib.get_user_cache_dir()}/tacho-gnome`;
            GLib.mkdir_with_parents(dir, 0o700);
            const path = `${dir}/${this._assetName}`;
            await Gio.File.new_for_path(path).replace_contents_bytes_async(
                zip, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
            const proc = Gio.Subprocess.new(['gnome-extensions', 'install', '--force', path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [, , stderr] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!proc.get_successful())
                throw new Error(stderr?.trim() || 'gnome-extensions install failed');
            this._set('installed');
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`Tacho: update failed: ${e.message}`);
            this._set('failed', {error: e.message});
        }
    }

    destroy() {
        this.stop();
        this._cancellable.cancel();
        this._session.abort();
        this._onChange = () => {};
    }
}
