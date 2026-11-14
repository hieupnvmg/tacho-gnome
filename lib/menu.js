// The drop-down menu. Sections are only filled while the menu is open.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as P from './parsers.js';
import {COLORS, Graph} from './graph.js';
import {dim, setLevel, setText, setVisible} from './widgets.js';

const BAR_WIDTH = 120;

function pct(v) {
    return v === null || v === undefined ? '–' : `${Math.round(v)}%`;
}

/** "14:30" today, "Tue 14:30" on another day. */
function formatReset(ms) {
    if (!ms)
        return '';
    const when = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const sameDay = when.get_year() === now.get_year() && when.get_day_of_year() === now.get_day_of_year();
    /* Translators: time a usage limit resets, e.g. "resets 14:30" or "resets Tue 14:30". */
    return _('resets %s').format(when.format(sameDay ? '%H:%M' : '%a %H:%M'));
}

const InfoItem = GObject.registerClass(
class TachoInfoItem extends PopupMenu.PopupBaseMenuItem {
    _init(label) {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-info-item'});
        this.label = dim(new St.Label({text: label, x_expand: true, style_class: 'tacho-info-label', y_align: Clutter.ActorAlign.CENTER}), 190);
        this.value = new St.Label({style_class: 'tacho-info-value', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.add_child(this.value);
    }

    set(value, level = 'normal') {
        setText(this.value, value);
        setLevel(this.value, level);
    }
});

const NoteItem = GObject.registerClass(
class TachoNoteItem extends PopupMenu.PopupBaseMenuItem {
    _init(text = '') {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-note-item'});
        this.label = dim(new St.Label({text, x_expand: true, style_class: 'tacho-note'}));
        this.label.clutter_text.line_wrap = true;
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.add_child(this.label);
    }

    set(text) {
        setText(this.label, text);
    }
});

const HeaderItem = GObject.registerClass(
class TachoHeaderItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, icon) {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-header-item'});
        if (icon)
            this.add_child(new St.Icon({gicon: icon, style_class: 'tacho-header-icon', y_align: Clutter.ActorAlign.CENTER}));
        this.label = new St.Label({text, style_class: 'tacho-header', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.detail = dim(new St.Label({x_expand: true, style_class: 'tacho-header-detail', y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(this.detail);
    }
});

const GraphItem = GObject.registerClass(
class TachoGraphItem extends PopupMenu.PopupBaseMenuItem {
    _init(color, color2 = null) {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-graph-item'});
        this.graph = new Graph({color, color2, chip: true, style_class: 'tacho-graph tacho-menu-graph', x_expand: true});
        this.add_child(this.graph);
    }
});

const BarItem = GObject.registerClass(
class TachoBarItem extends PopupMenu.PopupBaseMenuItem {
    _init(label) {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-bar-item'});
        const center = Clutter.ActorAlign.CENTER;
        this._label = new St.Label({text: label, style_class: 'tacho-bar-label', y_align: center});
        this._bar = new St.Widget({style_class: 'tacho-bar', y_align: center});
        this._fill = new St.Widget({style_class: 'tacho-bar-fill'});
        this._bar.add_child(this._fill);
        this._percent = new St.Label({style_class: 'tacho-bar-percent', y_align: center});
        this._reset = dim(new St.Label({style_class: 'tacho-bar-reset', x_expand: true, y_align: center}));
        for (const a of [this._label, this._bar, this._percent, this._reset])
            this.add_child(a);
    }

    set(label, used, resetsAt) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        setText(this._label, label);
        setText(this._percent, pct(used));
        setText(this._reset, formatReset(resetsAt));
        const width = Math.round(BAR_WIDTH * scale * P.clamp(used, 0, 100) / 100);
        if (this._fill.width !== width)
            this._fill.set_width(width);
        const level = P.limitLevel(used);
        setLevel(this._fill, level);
        setLevel(this._percent, level);
    }
});

const ContainerItem = GObject.registerClass(
class TachoContainerItem extends PopupMenu.PopupBaseMenuItem {
    _init(container, onToggle) {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-container-item'});
        const center = Clutter.ActorAlign.CENTER;
        const dot = new St.Widget({style_class: container.running ? 'tacho-dot tacho-dot-on' : 'tacho-dot', y_align: center});
        const names = new St.BoxLayout({x_expand: true, y_align: center, style_class: 'tacho-container-names'});
        names.layout_manager.orientation = Clutter.Orientation.VERTICAL;
        names.add_child(new St.Label({text: container.name, style_class: 'tacho-container-name'}));
        names.add_child(dim(new St.Label({text: container.image, style_class: 'tacho-container-image'})));
        this.memory = dim(new St.Label({style_class: 'tacho-container-memory', y_align: center}));
        if (!container.running)
            this.memory.text = container.status;
        const button = new St.Button({
            style_class: 'tacho-icon-button',
            can_focus: true,
            y_align: center,
            child: new St.Icon({
                icon_name: container.running ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic',
                style_class: 'popup-menu-icon',
            }),
            accessible_name: container.running ? _('Stop container') : _('Start container'),
        });
        button.connect('clicked', () => onToggle(container));
        this.add_child(dot);
        this.add_child(names);
        this.add_child(this.memory);
        this.add_child(button);
    }
});

const PendingItem = GObject.registerClass(
class TachoPendingItem extends PopupMenu.PopupBaseMenuItem {
    _init(container) {
        super._init({reactive: false, can_focus: false, style_class: 'tacho-container-item'});
        this.add_child(dim(new St.Label({
            text: container.running ? _('Stopping %s…').format(container.name) : _('Starting %s…').format(container.name),
            style_class: 'tacho-note',
            x_expand: true,
        })));
    }
});

class Section {
    constructor() {
        this.section = new PopupMenu.PopupMenuSection();
    }

    add(item) {
        this.section.addMenuItem(item);
        return item;
    }

    update() {}

    destroy() {}
}

class CpuSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this.add(new HeaderItem(_('CPU'), ctx.icon('cpu')));
        this._graph = this.add(new GraphItem(COLORS.cpu));
        this._usage = this.add(new InfoItem(_('Usage')));
        this._temp = this.add(new InfoItem(_('Temperature')));
        this._load = this.add(new InfoItem(_('Load average')));
    }

    update() {
        const s = this._ctx.sampler.state;
        this._graph.graph.setValues(this._ctx.sampler.cpu.values);
        this._usage.set(pct(s.cpu));
        setVisible(this._temp, s.temp !== null);
        if (s.temp !== null)
            this._temp.set(`${Math.round(s.temp)} °C`, P.temperatureLevel(s.temp));
        this._load.set(s.load ? s.load.map(v => v.toFixed(2)).join('  ') : '–');
    }
}

class GpuSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this.add(new HeaderItem(_('GPU'), ctx.icon('gpu')));
        this._graph = this.add(new GraphItem(COLORS.gpu));
        this._blocks = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this._blocks);
        this._key = null;
        this._rows = [];
    }

    // One block per GPU, built when the set of GPUs is first known.
    _build(gpus) {
        this._blocks.removeAll();
        this._rows = gpus.map(() => {
            const rows = {
                name: new InfoItem(''),
                usage: new InfoItem(_('Usage')),
                freq: new InfoItem(_('Frequency')),
                memory: new InfoItem(_('Video memory')),
                temp: new InfoItem(_('Temperature')),
                power: new InfoItem(_('Power')),
            };
            rows.name.label.opacity = 255;
            rows.name.label.add_style_class_name('tacho-gpu-name');
            Object.values(rows).forEach(r => this._blocks.addMenuItem(r));
            return rows;
        });
    }

    update() {
        const sampler = this._ctx.gpu;
        this._graph.graph.setValues(sampler.history.values);
        const gpus = sampler.gpus ?? [];
        const key = gpus.map(g => g.id).join(',');
        if (key !== this._key) {
            this._key = key;
            this._build(gpus);
        }
        gpus.forEach((g, i) => {
            const r = this._rows[i];
            setText(r.name.label, g.name);
            r.name.set(g.asleep ? _('Asleep') : (g === sampler.panel ? _('in the top bar') : ''));
            const awake = !g.asleep;
            setVisible(r.usage, awake);
            r.usage.set(pct(g.busy));
            setVisible(r.freq, awake && g.freq !== null);
            r.freq.set(g.maxFreq ? _('%d of %d MHz').format(g.freq ?? 0, g.maxFreq) : `${g.freq ?? 0} MHz`);
            setVisible(r.memory, awake && g.memTotal !== null);
            r.memory.set(_('%s of %s').format(P.formatBytes(g.memUsed ?? 0), P.formatBytes(g.memTotal ?? 0)));
            setVisible(r.temp, awake && g.temp !== null);
            r.temp.set(`${Math.round(g.temp ?? 0)} °C`, P.temperatureLevel(g.temp));
            setVisible(r.power, awake && g.power !== null);
            r.power.set(`${(g.power ?? 0).toFixed(1)} W`);
        });
        if (!gpus.length && !this._empty) {
            this._empty = new NoteItem(_('No GPU found.'));
            this._blocks.addMenuItem(this._empty);
        }
    }
}

class RamSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this.add(new HeaderItem(_('Memory'), ctx.icon('ram')));
        this._graph = this.add(new GraphItem(COLORS.ram));
        this._used = this.add(new InfoItem(_('Used')));
        this._available = this.add(new InfoItem(_('Available')));
        this._swap = this.add(new InfoItem(_('Swap')));
    }

    update() {
        const m = this._ctx.sampler.state.ram;
        this._graph.graph.setValues(this._ctx.sampler.ram.values);
        if (!m)
            return;
        /* Translators: memory used, e.g. "8.0 GB of 16 GB (50%)". */
        this._used.set(_('%s of %s (%s)').format(P.formatBytes(m.used), P.formatBytes(m.total), pct(m.percent)));
        this._available.set(P.formatBytes(m.available));
        setVisible(this._swap, m.swapTotal > 0);
        this._swap.set(_('%s of %s').format(P.formatBytes(m.swapUsed), P.formatBytes(m.swapTotal)));
    }
}

class NetSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this.add(new HeaderItem(_('Network'), ctx.icon('net')));
        this._graph = this.add(new GraphItem(COLORS.netIn, COLORS.netOut));
        this._down = this.add(new InfoItem(_('Download')));
        this._up = this.add(new InfoItem(_('Upload')));
        this._vpn = this.add(new InfoItem(_('VPN')));
    }

    update() {
        const s = this._ctx.sampler.state;
        const [down, up] = this._ctx.sampler.netGraph();
        this._graph.graph.setValues(down, up);
        this._down.set(P.formatRate(s.net?.down ?? 0));
        this._up.set(P.formatRate(s.net?.up ?? 0));
        const vpn = s.vpn ?? [];
        this._vpn.set(vpn.length ? vpn.join(', ') : _('Off'));
    }
}

class AssistantBlock {
    constructor(section, name, icon) {
        this.header = section.add(new HeaderItem(name, icon));
        this.bars = [section.add(new BarItem('5h')), section.add(new BarItem('7d'))];
        this.tokens = section.add(new InfoItem(_('Tokens today')));
        this.note = section.add(new NoteItem());
    }

    update(usage, missingNote, noLimitsNote) {
        if (!usage) {
            setText(this.header.detail, '');
            this.bars.forEach(b => setVisible(b, false));
            setVisible(this.tokens, false);
            setVisible(this.note, true);
            this.note.set(missingNote);
            return;
        }
        setText(this.header.detail, usage.model ?? '');
        const now = Date.now();
        const windows = usage.windows.map(w => P.effectiveWindow(w, now));
        this.bars.forEach((bar, i) => {
            const w = windows[i];
            setVisible(bar, Boolean(w));
            if (w)
                bar.set(w.label, w.used, w.reset ? null : w.resetsAt);
        });
        setVisible(this.tokens, true);
        const cached = usage.cachedToday ? `  ·  ${_('%s cached').format(P.formatTokens(usage.cachedToday))}` : '';
        this.tokens.set(`${P.formatTokens(usage.tokensToday)}${cached}`);
        setVisible(this.note, !windows.length && Boolean(noLimitsNote));
        if (!windows.length)
            this.note.set(noLimitsNote ?? '');
    }
}

class AiSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this._claude = new AssistantBlock(this, 'Claude Code', ctx.icon('ai'));
        this._codex = new AssistantBlock(this, 'Codex', ctx.icon('ai'));
    }

    update() {
        const {claude, codex} = this._ctx.ai.state;
        this._claude.update(claude, _('Claude Code not found (~/.claude).'),
            _('Limits appear once tacho-statusline is set as Claude Code’s statusLine (see README).'));
        this._codex.update(codex, _('Codex not found (~/.codex).'),
            _('No limits reported in recent Codex sessions.'));
    }
}

class InfraSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this._kube = [];
        this._docker = [];
        const k = items => {
            this._kube.push(...items);
            return items;
        };
        const d = items => {
            this._docker.push(...items);
            return items;
        };

        // Kubernetes
        [this._kubeHeader] = k([this.add(new HeaderItem(_('Kubernetes'), ctx.icon('kube')))]);
        this._context = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tacho-context-item'});
        this._contextName = new St.Label({style_class: 'tacho-context-name', y_align: Clutter.ActorAlign.CENTER});
        this._badge = new St.Label({text: _('PRODUCTION'), style_class: 'tacho-badge', y_align: Clutter.ActorAlign.CENTER});
        this._context.add_child(this._contextName);
        this._context.add_child(this._badge);
        k([this.add(this._context)]);
        [this._cluster, this._namespace, this._others] = k([
            this.add(new InfoItem(_('Cluster'))),
            this.add(new InfoItem(_('Namespace'))),
            this.add(new NoteItem()),
        ]);

        // Docker
        [this._dockerHeader] = d([this.add(new HeaderItem('Docker', ctx.icon('docker')))]);
        [this._dockerStatus, this._dockerMemory] = d([
            this.add(new NoteItem()),
            this.add(new InfoItem(_('Memory'))),
        ]);
        this._containers = new PopupMenu.PopupMenuSection();
        d([this._containers]);
        this.section.addMenuItem(this._containers);
        this._containersKey = null;
        this._memoryLabels = new Map();
        this._shownKube = null;
        this._shownDocker = null;
    }

    update() {
        const settings = this._ctx.settings;
        const state = this._ctx.infra.state;
        const showKube = settings.get_boolean('show-kube');
        const showDocker = settings.get_boolean('show-docker');
        // Whole blocks only change with the settings; the updates below
        // then hide the rows that have nothing to show.
        if (showKube !== this._shownKube) {
            this._shownKube = showKube;
            this._kube.forEach(i => setVisible(i.actor ?? i, showKube));
        }
        if (showDocker !== this._shownDocker) {
            this._shownDocker = showDocker;
            this._docker.forEach(i => setVisible(i.actor ?? i, showDocker));
        }
        if (showKube)
            this._updateKube(state.kube);
        if (showDocker)
            this._updateDocker(state.docker);
    }

    _updateKube({current, contexts}) {
        if (!current) {
            setText(this._contextName, _('No context in ~/.kube/config'));
            setVisible(this._badge, false);
            setLevel(this._contextName, 'normal');
            [this._cluster, this._namespace].forEach(i => setVisible(i, false));
            setVisible(this._others, false);
            return;
        }
        const prod = P.isProduction(current);
        setText(this._contextName, current.name);
        setLevel(this._contextName, prod ? 'critical' : 'normal');
        setVisible(this._badge, prod);
        setVisible(this._cluster, Boolean(current.cluster));
        this._cluster.set(current.cluster);
        setVisible(this._namespace, true);
        this._namespace.set(current.namespace ?? 'default');
        const others = contexts.filter(c => c.name !== current.name).map(c => c.name);
        setVisible(this._others, others.length > 0);
        this._others.set(_('Other contexts: %s').format(others.join(', ')));
    }

    _updateDocker(docker) {
        const running = docker.containers.filter(c => c.running).length;
        setText(this._dockerHeader.detail, docker.status === 'ok'
            ? _('%d running / %d').format(running, docker.containers.length) : '');
        let status = '';
        if (docker.status === 'down')
            status = _('Docker isn’t running.');
        else if (docker.status === 'denied')
            status = _('No access to the Docker socket. Add yourself to the “docker” group, then log out and back in.');
        else if (docker.status === 'unknown')
            status = _('Checking Docker…');
        else if (!docker.containers.length)
            status = _('No containers.');
        setVisible(this._dockerStatus, status !== '');
        this._dockerStatus.set(status);

        const ok = docker.status === 'ok';
        const used = Object.values(docker.memory).reduce((a, b) => a + b, 0);
        setVisible(this._dockerMemory, ok && docker.vmMemory !== null);
        if (docker.vmMemory !== null) {
            /* Translators: memory of all containers, then the memory Docker's engine has. */
            this._dockerMemory.set(_('containers %s / engine %s').format(P.formatBytes(used), P.formatBytes(docker.vmMemory)));
        }

        const pending = this._ctx.infra.pending;
        const list = ok ? docker.containers.slice(0, 12) : [];
        const key = list.map(c => `${c.id}:${c.running}:${pending.has(c.id)}:${c.running ? '' : c.status}`).join('|');
        if (key !== this._containersKey) {
            this._containersKey = key;
            this._containers.removeAll();
            this._memoryLabels.clear();
            for (const c of list) {
                if (pending.has(c.id)) {
                    this._containers.addMenuItem(new PendingItem(c));
                    continue;
                }
                const item = new ContainerItem(c, container => this._ctx.infra.setRunning(container.id, !container.running));
                this._memoryLabels.set(c.id, item.memory);
                this._containers.addMenuItem(item);
            }
        }
        for (const [id, label] of this._memoryLabels) {
            const bytes = docker.memory[id];
            if (bytes !== undefined)
                setText(label, P.formatBytes(bytes));
        }
    }
}

class ActionsSection extends Section {
    constructor(ctx) {
        super();
        this._ctx = ctx;
        this._awake = this.add(new PopupMenu.PopupSwitchMenuItem(_('Keep awake'), ctx.keepAwake.active));
        this._awake.connect('toggled', (_item, on) => ctx.keepAwake.set(on));
        this._awakeId = ctx.keepAwake.connectChanged(on => this._awake.setToggleState(on));
        this.add(new PopupMenu.PopupMenuItem(_('Open System Monitor'))).connect('activate', () => ctx.openSystemMonitor());
        this.add(new PopupMenu.PopupMenuItem(_('Tacho Settings'))).connect('activate', () => ctx.openPreferences());
        this._updateItem = this.add(new PopupMenu.PopupMenuItem(''));
        this._updateItem.connect('activate', () => {
            const state = ctx.updater?.state;
            if (state === 'available' || state === 'failed')
                ctx.updater.install();
        });
        this.update();
    }

    update() {
        const updater = this._ctx.updater;
        const state = updater?.state;
        const version = updater?.release?.version ?? '';
        let text = '';
        if (state === 'available')
            text = _('Update Tacho to %s').format(version);
        else if (state === 'downloading')
            text = _('Downloading Tacho %s…').format(version);
        else if (state === 'installed')
            text = _('Tacho %s installed. Log out and back in to finish.').format(version);
        else if (state === 'failed')
            text = _('Update failed. Click to try again.');
        setVisible(this._updateItem, text !== '');
        setText(this._updateItem.label, text);
        this._updateItem.setSensitive(state === 'available' || state === 'failed');
    }

    destroy() {
        this._ctx.keepAwake.disconnectChanged(this._awakeId);
    }
}

const SECTIONS = {cpu: CpuSection, gpu: GpuSection, ram: RamSection, net: NetSection, ai: AiSection, infra: InfraSection};

/** The menu of one button: a section per reading, then quick actions. */
export class MenuSections {
    constructor(ctx, menu, keys) {
        this._sections = new Map();
        this._separators = [];
        keys.forEach((key, i) => {
            if (i > 0) {
                const sep = new PopupMenu.PopupSeparatorMenuItem();
                this._separators.push(sep);
                menu.addMenuItem(sep);
            }
            const section = new SECTIONS[key](ctx);
            this._sections.set(key, section);
            menu.addMenuItem(section.section);
        });
        if (keys.length)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._actions = new ActionsSection(ctx);
        menu.addMenuItem(this._actions.section);
    }

    /** Shows one reading's section, or all of them when `focus` is null. */
    show(focus) {
        for (const [key, section] of this._sections)
            setVisible(section.section.actor, !focus || key === focus);
        for (const sep of this._separators)
            setVisible(sep, !focus);
    }

    update() {
        for (const section of this._sections.values()) {
            if (section.section.actor.visible)
                section.update();
        }
        this._actions.update();
    }

    destroy() {
        for (const section of this._sections.values())
            section.destroy();
        this._actions.destroy();
        this._sections.clear();
    }
}
