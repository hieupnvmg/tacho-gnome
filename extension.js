// Tacho for GNOME: system gauges, AI coding limits, Docker and Kubernetes
// in the top bar.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as P from './lib/parsers.js';
import {AiWatcher} from './lib/ai.js';
import {InfraWatcher} from './lib/infra.js';
import {KeepAwake} from './lib/awake.js';
import {SystemSampler} from './lib/system.js';
import {TachoButton, enabledReadings} from './lib/panel.js';

const SYSTEM_MONITORS = [
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
    'gnome-system-monitor_gnome-system-monitor.desktop',
    'net.nokyan.Resources.desktop',
];

const LAYOUT_KEYS = new Set([
    'display-mode', 'panel-position', 'show-cpu', 'show-temp', 'show-ram', 'show-net',
    'show-ai', 'show-docker', 'show-kube',
]);

class Tacho {
    constructor(extension) {
        this._extension = extension;
        this.settings = extension.getSettings();
        this._icons = new Map();
        this._buttons = [];
        this._tickId = 0;
        this._sampling = false;
        this._openMenus = 0;
        this._vpnBefore = null;
        this._cancellable = new Gio.Cancellable();
        this._sent = new Set(this.settings.get_strv('ai-alerts-sent'));

        this.sampler = new SystemSampler();
        this.ai = new AiWatcher(() => this._onAi());
        this.infra = new InfraWatcher(() => this._update());
        this.keepAwake = new KeepAwake(_('Keep awake is on in Tacho'));

        // Over-the-air updates: only in the build published on GitHub.
        this.updater = null;
        this._githubBuild = extension.metadata['update-channel'] === 'github';

        this._settingsId = this.settings.connect('changed', (_s, key) => this._onSetting(key));
        this._build();
        this._syncWatchers();
        this._restartTick();
        this._syncUpdater();
    }

    // ------------------------------------------------------------ helpers

    icon(name) {
        let icon = this._icons.get(name);
        if (!icon) {
            icon = Gio.FileIcon.new(Gio.File.new_for_path(`${this._extension.path}/icons/tacho-${name}-symbolic.svg`));
            this._icons.set(name, icon);
        }
        return icon;
    }

    aiHighest() {
        const {claude, codex} = this.ai.state;
        return P.highestWindow([claude, codex]);
    }

    openPreferences() {
        this._extension.openPreferences();
    }

    openSystemMonitor() {
        const apps = Shell.AppSystem.get_default();
        for (const id of SYSTEM_MONITORS) {
            const app = apps.lookup_app(id);
            if (app) {
                app.activate();
                return;
            }
        }
        Main.notify(_('Tacho'), _('GNOME System Monitor is not installed.'));
    }

    menuOpenChanged(open) {
        this._openMenus = Math.max(this._openMenus + (open ? 1 : -1), 0);
        const anyOpen = this._openMenus > 0;
        this.infra.detailed = anyOpen;
        if (open) {
            if (this.infra.running)
                this.infra.refresh();
            if (this.settings.get_boolean('show-ai'))
                this.ai.refreshIfOlder(30);
            // Load average is only read for the menu.
            this._tick();
        }
    }

    // ------------------------------------------------------------ layout

    _onSetting(key) {
        if (LAYOUT_KEYS.has(key)) {
            this._build();
            this._syncWatchers();
        } else if (key === 'update-interval') {
            this._restartTick();
        } else if (key === 'notify-ai' || key === 'notify-vpn') {
            this._syncWatchers();
        } else if (key === 'check-updates') {
            this._syncUpdater();
        } else if (key === 'update-prereleases') {
            this.updater?.check();
        }
    }

    // ------------------------------------------------------------ updates

    async _syncUpdater() {
        const want = this._githubBuild && this.settings.get_boolean('check-updates');
        if (!want) {
            this.updater?.destroy();
            this.updater = null;
            this._update();
            return;
        }
        if (this.updater || this._loadingUpdater)
            return;
        this._loadingUpdater = true;
        try {
            const {Updater} = await import('./lib/updater.js');
            if (this._cancellable.is_cancelled() || this.updater)
                return;
            this.updater = new Updater({
                uuid: this._extension.uuid,
                current: this._extension.metadata['version-name'] ?? '0',
                settings: this.settings,
                onChange: updater => this._onUpdaterChange(updater),
            });
            this.updater.start();
        } catch (e) {
            console.error('Tacho: could not load the updater', e);
        } finally {
            this._loadingUpdater = false;
        }
    }

    _onUpdaterChange(updater) {
        this._update();
        const version = updater.release?.version;
        if (updater.state === 'available' && version !== this.settings.get_string('update-notified')) {
            this.settings.set_string('update-notified', version);
            Main.notify(_('Tacho %s is available').format(version),
                _('Open the Tacho menu and choose “Update Tacho” to install it.'));
        } else if (updater.state === 'installed') {
            Main.notify(_('Tacho %s installed').format(version),
                _('Log out and back in to start using it.'));
        } else if (updater.state === 'failed') {
            Main.notify(_('Tacho could not update'), updater.error ?? '');
        }
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
        this._openMenus = 0;
        this.infra.detailed = false;
    }

    _build() {
        this._destroyButtons();
        const mode = this.settings.get_string('display-mode');
        const position = this.settings.get_string('panel-position');
        const box = ['left', 'center', 'right'].includes(position) ? position : 'right';
        const keys = enabledReadings(this.settings);
        const groups = mode === 'combined' || !keys.length ? [keys] : keys.map(k => [k]);
        groups.forEach((group, i) => {
            const button = new TachoButton(this, group, mode === 'combined' || !keys.length ? 'combined' : mode);
            const role = `tacho-${group.join('-') || 'empty'}`;
            Main.panel.addToStatusArea(role, button, box === 'left' ? -1 : i, box);
            this._buttons.push(button);
        });
    }

    _syncWatchers() {
        const s = this.settings;
        if (s.get_boolean('show-ai') || s.get_boolean('notify-ai'))
            this.ai.start();
        else
            this.ai.stop();
        if (s.get_boolean('show-docker') || s.get_boolean('show-kube'))
            this.infra.start();
        else
            this.infra.stop();
    }

    // ------------------------------------------------------------ sampling

    _restartTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        const seconds = [1, 2, 5].includes(this.settings.get_uint('update-interval'))
            ? this.settings.get_uint('update-interval') : 2;
        this._tick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _tick() {
        if (this._sampling)
            return;
        this._sampling = true;
        const s = this.settings;
        const cpu = s.get_boolean('show-cpu');
        const want = {
            cpu,
            temp: cpu && s.get_boolean('show-temp'),
            ram: s.get_boolean('show-ram'),
            net: s.get_boolean('show-net'),
            vpn: s.get_boolean('show-net') || s.get_boolean('notify-vpn'),
            load: cpu && this._openMenus > 0,
        };
        try {
            await this.sampler.sample(want, this._cancellable);
        } finally {
            this._sampling = false;
        }
        if (this._cancellable.is_cancelled())
            return;
        this._checkVpn();
        this._update();
    }

    _update() {
        for (const button of this._buttons)
            button.update();
    }

    // ------------------------------------------------------------ alerts

    _checkVpn() {
        const now = this.sampler.state.vpn;
        if (now === null)
            return;
        const before = this._vpnBefore;
        this._vpnBefore = now;
        if (before === null || !this.settings.get_boolean('notify-vpn'))
            return;
        for (const name of now.filter(n => !before.includes(n)))
            Main.notify(_('VPN connected'), _('%s is up.').format(name));
        for (const name of before.filter(n => !now.includes(n)))
            Main.notify(_('VPN disconnected'), _('%s went down.').format(name));
    }

    _onAi() {
        this._update();
        if (!this.settings.get_boolean('notify-ai'))
            return;
        const names = {claude: 'Claude Code', codex: 'Codex'};
        const now = Date.now();
        const windows = [];
        for (const tool of ['claude', 'codex']) {
            for (const w of this.ai.state[tool]?.windows ?? []) {
                const e = P.effectiveWindow(w, now);
                windows.push({tool, label: e.label, used: e.used, resetsAt: e.resetsAt});
            }
        }
        const due = P.dueLimitAlerts(windows, this._sent);
        for (const alert of due) {
            this._sent.add(alert.key);
            /* Translators: e.g. "Claude Code: 82% of the 5h limit used". */
            const title = _('%s: %d%% of the %s limit used').format(names[alert.tool], Math.round(alert.used), alert.label);
            const body = alert.threshold >= 95
                ? _('Almost out. It resets on its own when the window ends.')
                : _('Past %d%%. Tacho will tell you again at 95%%.').format(alert.threshold);
            Main.notify(title, body);
        }
        if (due.length)
            this._saveSent(now);
    }

    _saveSent(now) {
        // Keys end with the window's reset time; drop those long past.
        for (const key of this._sent) {
            const reset = Number(key.split(':')[2]);
            if (Number.isFinite(reset) && reset < now - 86400000)
                this._sent.delete(key);
        }
        this.settings.set_strv('ai-alerts-sent', [...this._sent].slice(-50));
    }

    // ------------------------------------------------------------ teardown

    destroy() {
        this._cancellable.cancel();
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this.settings.disconnect(this._settingsId);
        this._destroyButtons();
        this.updater?.destroy();
        this.updater = null;
        this.ai.destroy();
        this.infra.destroy();
        this.keepAwake.destroy();
        this._icons.clear();
        this.ai = null;
        this.infra = null;
        this.sampler = null;
        this.keepAwake = null;
        this.settings = null;
    }
}

export default class TachoExtension extends Extension {
    enable() {
        this._tacho = new Tacho(this);
    }

    disable() {
        this._tacho?.destroy();
        this._tacho = null;
    }
}
