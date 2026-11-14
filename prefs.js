import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = ['combined', 'separate-graphs', 'separate'];
const POSITIONS = ['left', 'center', 'right'];
const INTERVALS = [1, 2, 5];

function comboRow(title, subtitle, labels, getIndex, setIndex) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
    row.selected = Math.max(getIndex(), 0);
    row.connect('notify::selected', () => setIndex(row.selected));
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    return row;
}

export default class TachoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // Display
        const display = new Adw.PreferencesGroup({title: _('Top bar')});
        page.add(display);
        display.add(comboRow(_('Display'), _('How readings appear in the top bar'),
            [_('Combined, one item with graphs'), _('Separate items with graphs'), _('Separate items without graphs')],
            () => MODES.indexOf(settings.get_string('display-mode')),
            i => settings.set_string('display-mode', MODES[i])));
        display.add(comboRow(_('Position'), '',
            [_('Left'), _('Center'), _('Right')],
            () => POSITIONS.indexOf(settings.get_string('panel-position')),
            i => settings.set_string('panel-position', POSITIONS[i])));
        display.add(comboRow(_('Update every'), _('CPU, memory and network'),
            [_('1 second'), _('2 seconds'), _('5 seconds')],
            () => INTERVALS.indexOf(settings.get_uint('update-interval')),
            i => settings.set_uint('update-interval', INTERVALS[i])));

        // Readings
        const readings = new Adw.PreferencesGroup({title: _('Readings')});
        page.add(readings);
        readings.add(switchRow(settings, 'show-cpu', _('CPU')));
        readings.add(switchRow(settings, 'show-temp', _('CPU temperature'),
            _('Amber from 70 °C, red from 90 °C')));
        readings.add(switchRow(settings, 'show-ram', _('Memory')));
        readings.add(switchRow(settings, 'show-net', _('Network'), _('Download and upload, VPN in the menu')));
        readings.add(switchRow(settings, 'show-ai', _('AI limits'),
            _('Highest Claude Code or Codex window, from their local logs')));
        readings.add(switchRow(settings, 'show-docker', _('Docker'), _('Running containers')));
        readings.add(switchRow(settings, 'show-kube', _('Kubernetes'),
            _('Current context; the wheel turns red for production')));

        // Notifications
        const alerts = new Adw.PreferencesGroup({title: _('Notifications')});
        page.add(alerts);
        alerts.add(switchRow(settings, 'notify-ai', _('AI limits'), _('At 80% and 95% of a window, once per window')));
        alerts.add(switchRow(settings, 'notify-vpn', _('VPN'), _('When a VPN connects or disconnects')));

        // Claude Code help
        const claude = new Adw.PreferencesGroup({
            title: _('Claude Code limits'),
            description: _('Claude Code only reports its 5-hour and 7-day limits to a statusLine command. Install the tacho-statusline script from the Tacho repository and set it as the statusLine in ~/.claude/settings.json:'),
        });
        page.add(claude);
        const code = new Gtk.Label({
            label: '"statusLine": {"type": "command", "command": "~/.local/bin/tacho-statusline"}',
            selectable: true,
            wrap: true,
            xalign: 0,
            css_classes: ['monospace'],
            margin_top: 6,
        });
        claude.add(code);
        const link = new Adw.ActionRow({title: _('Instructions'), subtitle: 'github.com/hieupnvmg/tacho-gnome'});
        const open = new Gtk.LinkButton({
            uri: 'https://github.com/hieupnvmg/tacho-gnome#claude-code-limits',
            label: _('Open'),
            valign: Gtk.Align.CENTER,
        });
        link.add_suffix(open);
        claude.add(link);
    }
}
