// The top-bar part: one button with every reading (combined), or a button
// per reading (separate, with or without graphs).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as P from './parsers.js';
import {COLORS, Graph} from './graph.js';
import {MenuSections} from './menu.js';
import {setLevel, setText, setVisible, vbox} from './widgets.js';

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
    const showTemp = ctx.settings.get_boolean('show-temp');
    switch (key) {
    case 'cpu':
        return {
            value: percent(s.cpu),
            extra: showTemp && s.temp !== null ? `${Math.round(s.temp)}°` : '',
            extraLevel: P.temperatureLevel(s.temp),
            graph: [ctx.sampler.cpu.values],
        };
    case 'gpu': {
        const g = ctx.gpu.panel;
        const temp = g?.temp ?? null;
        // A hybrid laptop's NVIDIA card asleep and nothing else to show.
        const asleep = !g && (ctx.gpu.gpus ?? []).some(x => x.asleep);
        return {
            value: g ? percent(g.busy) : (asleep ? _('off') : '–'),
            extra: showTemp && temp !== null ? `${Math.round(temp)}°` : '',
            extraLevel: P.temperatureLevel(temp),
            graph: [ctx.gpu.history.values],
        };
    }
    case 'ram':
        return {value: percent(s.ram?.percent), graph: [ctx.sampler.ram.values]};
    case 'net':
        return {
            down: `↓ ${P.formatRateShort(s.net?.down ?? 0)}`,
            up: `↑ ${P.formatRateShort(s.net?.up ?? 0)}`,
            graph: ctx.sampler.netGraph(),
        };
    case 'ai': {
        const top = ctx.aiHighest();
        return {value: top === null ? '' : percent(top), level: P.limitLevel(top), idle: top === null};
    }
    case 'infra': {
        const showDocker = ctx.settings.get_boolean('show-docker');
        const showKube = ctx.settings.get_boolean('show-kube');
        const docker = ctx.infra.state.docker;
        const kube = ctx.infra.state.kube.current;
        const up = docker.status === 'ok';
        return {
            value: showDocker && up ? `${docker.containers.filter(c => c.running).length}` : '',
            docker: showDocker,
            dockerUp: up,
            kube: showKube && kube !== null,
            level: showKube && P.isProduction(kube) ? 'critical' : 'normal',
        };
    }
    }
    return {value: ''};
}

/**
 * One reading in the top bar, drawn like the macOS app: a small graph in a
 * rounded box (or an icon), then the value. Network shows download over
 * upload in two small lines; temperature follows the percentage, smaller.
 */
class ReadingView {
    constructor(ctx, key, mode) {
        this._ctx = ctx;
        this.key = key;
        this.mode = mode;
        this._graph = null;
        this._icon = null;
        this._value = null;
        this._extra = null;
        this._kubeIcon = null;
        this._build(mode !== 'separate' && HAS_GRAPH.has(key));
        this.update();
    }

    _build(withGraph) {
        const center = Clutter.ActorAlign.CENTER;
        const box = new St.BoxLayout({
            style_class: `tacho-reading tacho-reading-${this.key}`,
            reactive: this.mode === 'combined',
            track_hover: this.mode === 'combined',
            y_align: center,
        });
        this.actor = box;

        if (withGraph) {
            const net = this.key === 'net';
            this._graph = new Graph({
                color: net ? COLORS.netIn : COLORS[this.key],
                color2: net ? COLORS.netOut : null,
                chip: true,
                style_class: 'tacho-chip',
                y_align: center,
            });
            box.add_child(this._graph);
        } else {
            const name = this.key === 'infra' ? 'docker' : this.key;
            this._icon = new St.Icon({gicon: this._ctx.icon(name), style_class: 'tacho-icon', y_align: center});
            box.add_child(this._icon);
        }

        if (this.key === 'net') {
            const lines = vbox({style_class: 'tacho-net', y_align: center});
            this._down = new St.Label({style_class: 'tacho-net-line'});
            this._up = new St.Label({style_class: 'tacho-net-line'});
            lines.add_child(this._down);
            lines.add_child(this._up);
            box.add_child(lines);
            return;
        }

        // A fixed-width slot with the number on its right, so "4%" sits next
        // to its temperature and neighbours do not move as numbers change.
        this._value = new St.Label({style_class: 'tacho-value', x_align: Clutter.ActorAlign.END, y_align: center});
        this._slot = new St.Bin({style_class: `tacho-slot tacho-slot-${this.key}`, child: this._value, y_align: center});
        box.add_child(this._slot);
        if (this.key === 'cpu' || this.key === 'gpu') {
            this._extra = new St.Label({style_class: 'tacho-temp', y_align: center});
            box.add_child(this._extra);
        }
        if (this.key === 'infra') {
            this._kubeIcon = new St.Icon({gicon: this._ctx.icon('kube'), style_class: 'tacho-icon tacho-kube', y_align: center});
            box.add_child(this._kubeIcon);
        }
    }

    update() {
        const d = describe(this.key, this._ctx);
        if (this._graph && d.graph)
            this._graph.setValues(d.graph[0], d.graph[1] ?? null);
        if (this.key === 'net') {
            setText(this._down, d.down);
            setText(this._up, d.up);
            return;
        }
        setText(this._value, d.value);
        setVisible(this._slot, d.value !== '');
        if (this._extra) {
            setText(this._extra, d.extra);
            setVisible(this._extra, d.extra !== '');
            setLevel(this._extra, d.extraLevel);
            // Dimmed while cool; amber and red show at full strength.
            this._extra.opacity = d.extraLevel === 'normal' ? 170 : 255;
        }
        if (this.key === 'ai') {
            setLevel(this._value, d.level);
            this._icon.opacity = d.idle ? 120 : 255;
        }
        if (this.key === 'infra') {
            // Docker's box while Docker is wanted, faint while it is not
            // running; the wheel for a Kubernetes context. With neither, a
            // faint box keeps the item there to click.
            const nothing = !d.docker && !d.kube;
            setVisible(this._icon, d.docker || nothing);
            this._icon.opacity = d.dockerUp ? 255 : 120;
            setVisible(this._kubeIcon, d.kube);
            // Production: the whole reading turns red, as on macOS.
            setLevel(this._kubeIcon, d.level);
            setLevel(this._value, d.level);
            setLevel(this._icon, d.level);
        }
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
