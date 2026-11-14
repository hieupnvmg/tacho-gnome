// The top-bar part: one button with a column per reading (combined), or a
// button per reading (separate, with or without graphs).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as P from './parsers.js';
import {COLORS, Graph} from './graph.js';
import {MenuSections} from './menu.js';
import {dim, setLevel, setText, setVisible, vbox} from './widgets.js';

export const MODES = ['combined', 'separate-graphs', 'separate'];

/** The readings switched on, in panel order. */
export function enabledReadings(settings) {
    const keys = [];
    if (settings.get_boolean('show-cpu'))
        keys.push('cpu');
    if (settings.get_boolean('show-gpu'))
        keys.push('gpu');
    if (settings.get_boolean('show-ram'))
        keys.push('ram');
    if (settings.get_boolean('show-net'))
        keys.push('net');
    if (settings.get_boolean('show-ai'))
        keys.push('ai');
    if (settings.get_boolean('show-docker') || settings.get_boolean('show-kube'))
        keys.push('infra');
    return keys;
}

const HAS_GRAPH = new Set(['cpu', 'gpu', 'ram', 'net']);

function percent(v) {
    return v === null || v === undefined ? '–' : `${Math.round(v)}%`;
}

/** What one reading shows in the panel right now. */
function describe(key, ctx) {
    const s = ctx.sampler.state;
    switch (key) {
    case 'cpu': {
        const showTemp = ctx.settings.get_boolean('show-temp') && s.temp !== null;
        return {
            title: _('CPU'),
            value: percent(s.cpu),
            extra: showTemp ? `${Math.round(s.temp)}°` : '',
            extraLevel: P.temperatureLevel(s.temp),
            graph: [ctx.sampler.cpu.values],
        };
    }
    case 'gpu': {
        const g = ctx.gpu.panel;
        const temp = g?.temp ?? null;
        // A hybrid laptop's NVIDIA card asleep and nothing else to show.
        const asleep = !g && (ctx.gpu.gpus ?? []).some(x => x.asleep);
        return {
            title: _('GPU'),
            value: g ? percent(g.busy) : (asleep ? _('off') : '–'),
            extra: temp !== null && ctx.settings.get_boolean('show-temp') ? `${Math.round(temp)}°` : '',
            extraLevel: P.temperatureLevel(temp),
            graph: [ctx.gpu.history.values],
        };
    }
    case 'ram':
        return {title: _('RAM'), value: percent(s.ram?.percent), graph: [ctx.sampler.ram.values]};
    case 'net': {
        const down = P.formatRateShort(s.net?.down ?? 0);
        const up = P.formatRateShort(s.net?.up ?? 0);
        return {title: `↑${up}`, value: `↓${down}`, inline: `↓${down} ↑${up}`, graph: ctx.sampler.netGraph()};
    }
    case 'ai': {
        const top = ctx.aiHighest();
        return {title: _('AI'), value: percent(top), level: P.limitLevel(top)};
    }
    case 'infra': {
        const showDocker = ctx.settings.get_boolean('show-docker');
        const showKube = ctx.settings.get_boolean('show-kube');
        const docker = ctx.infra.state.docker;
        const kube = ctx.infra.state.kube.current;
        const running = docker.containers.filter(c => c.running).length;
        const prod = P.isProduction(kube);
        return {
            title: showDocker ? _('DOCKER') : _('K8S'),
            value: showDocker ? (docker.status === 'ok' ? `${running}` : '–') : '',
            docker: showDocker,
            kube: showKube && kube !== null,
            level: showKube && prod ? 'critical' : 'normal',
        };
    }
    }
    return {title: '', value: ''};
}

class ReadingView {
    constructor(ctx, key, mode) {
        this._ctx = ctx;
        this.key = key;
        this.mode = mode;
        this._graph = null;
        this._extra = null;
        this._dockerIcon = null;
        this._kubeIcon = null;
        this.actor = mode === 'combined' ? this._buildColumn() : this._buildInline(mode === 'separate-graphs');
        this.update();
    }

    _graphFor(params) {
        const net = this.key === 'net';
        return new Graph({
            color: net ? COLORS.netIn : COLORS[this.key],
            color2: net ? COLORS.netOut : null,
            ...params,
        });
    }

    _buildColumn() {
        const column = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: `tacho-column tacho-column-${this.key}`,
            reactive: true,
            track_hover: true,
            y_expand: true,
        });
        if (HAS_GRAPH.has(this.key)) {
            this._graph = this._graphFor({faint: true, x_expand: true, y_expand: true});
            column.add_child(this._graph);
        }
        const box = vbox({
            style_class: 'tacho-column-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = dim(new St.Label({style_class: 'tacho-column-title', x_align: Clutter.ActorAlign.CENTER}), 190);
        const row = new St.BoxLayout({style_class: 'tacho-column-row', x_align: Clutter.ActorAlign.CENTER});
        this._addValue(row, 'tacho-column-value');
        box.add_child(this._title);
        box.add_child(row);
        column.add_child(box);
        return column;
    }

    _buildInline(withGraph) {
        const box = new St.BoxLayout({style_class: `tacho-inline tacho-inline-${this.key}`});
        if (this.key !== 'infra') {
            box.add_child(new St.Icon({
                gicon: this._ctx.icon(this.key),
                style_class: 'tacho-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._addValue(box, 'tacho-inline-value');
        if (withGraph && HAS_GRAPH.has(this.key)) {
            this._graph = this._graphFor({style_class: 'tacho-graph tacho-sparkline', y_align: Clutter.ActorAlign.CENTER});
            box.add_child(this._graph);
        }
        return box;
    }

    _addValue(row, cls) {
        const center = Clutter.ActorAlign.CENTER;
        if (this.key === 'infra' && this.mode !== 'combined') {
            this._dockerIcon = new St.Icon({gicon: this._ctx.icon('docker'), style_class: 'tacho-icon', y_align: center});
            row.add_child(this._dockerIcon);
        }
        this._value = new St.Label({style_class: cls, y_align: center});
        row.add_child(this._value);
        if (this.key === 'cpu' || this.key === 'gpu') {
            this._extra = new St.Label({style_class: `${cls} tacho-temp`, y_align: center});
            row.add_child(this._extra);
        }
        if (this.key === 'infra') {
            this._kubeIcon = new St.Icon({gicon: this._ctx.icon('kube'), style_class: 'tacho-icon tacho-kube', y_align: center});
            row.add_child(this._kubeIcon);
        }
    }

    update() {
        const d = describe(this.key, this._ctx);
        if (this.mode === 'combined')
            setText(this._title, d.title);
        setText(this._value, this.mode !== 'combined' && d.inline ? d.inline : d.value);
        if (this.key === 'ai')
            setLevel(this._value, d.level);
        if (this._extra) {
            setText(this._extra, d.extra);
            setVisible(this._extra, d.extra !== '');
            setLevel(this._extra, d.extraLevel);
            // Dimmed while cool; amber and red show at full strength.
            this._extra.opacity = d.extraLevel === 'normal' ? 190 : 255;
        }
        if (this.key === 'infra') {
            setVisible(this._value, d.docker);
            if (this._dockerIcon)
                setVisible(this._dockerIcon, d.docker);
            // With no context to show and Docker off, a faint wheel keeps
            // the item visible and clickable.
            const nothing = !d.docker && !d.kube;
            setVisible(this._kubeIcon, d.kube || nothing);
            this._kubeIcon.opacity = nothing ? 110 : 255;
            // Production: the whole reading turns red, as on macOS.
            setLevel(this._kubeIcon, d.level);
            setLevel(this._value, d.level);
            if (this.mode === 'combined') {
                setLevel(this._title, d.level);
                this._title.opacity = d.level === 'critical' ? 255 : 190;
            }
        }
        if (this._graph && d.graph)
            this._graph.setValues(d.graph[0], d.graph[1] ?? null);
    }
}

/** One top-bar button showing `keys`, with their menu sections. */
export const TachoButton = GObject.registerClass(
class TachoButton extends PanelMenu.Button {
    _init(ctx, keys, mode) {
        super._init(0.5, 'Tacho', false);
        this._ctx = ctx;
        this._focus = null;
        this.add_style_class_name('tacho-button');
        const box = new St.BoxLayout({style_class: mode === 'combined' ? 'tacho-combined' : 'tacho-separate'});
        this.add_child(box);

        this._views = keys.map(key => new ReadingView(ctx, key, mode));
        for (const view of this._views) {
            box.add_child(view.actor);
            if (mode === 'combined')
                view.actor.connect('button-press-event', () => this._pressed(view.key));
        }
        if (!keys.length) {
            box.add_child(new St.Icon({gicon: ctx.icon('tacho'), style_class: 'system-status-icon'}));
        }

        this._sections = new MenuSections(ctx, this.menu, keys);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._sections.show(this._focus);
                this._sections.update();
            } else {
                this._focus = null;
            }
            ctx.menuOpenChanged(open);
        });
    }

    // Clicking a column opens the menu on that reading only. The button's
    // own handler still toggles the menu afterwards, unless the menu is
    // already open on another reading, which is then shown instead.
    _pressed(key) {
        if (this.menu.isOpen && this._focus !== key) {
            this._focus = key;
            this._sections.show(key);
            this._sections.update();
            return Clutter.EVENT_STOP;
        }
        this._focus = key;
        return Clutter.EVENT_PROPAGATE;
    }

    update() {
        for (const view of this._views)
            view.update();
        if (this.menu.isOpen)
            this._sections.update();
    }

    destroy() {
        this._sections?.destroy();
        this._sections = null;
        super.destroy();
    }
});
