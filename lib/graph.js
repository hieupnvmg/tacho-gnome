// A small history graph drawn with Cairo. It only repaints when what it
// would draw changes: values are compared after being rounded to the
// graph's vertical resolution.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {graphKey} from './parsers.js';

export const COLORS = {
    cpu: [0.31, 0.56, 0.95],
    gpu: [0.56, 0.50, 0.88],
    ram: [0.45, 0.74, 0.44],
    netIn: [0.56, 0.50, 0.88],
    netOut: [0.93, 0.72, 0.33],
};

export const Graph = GObject.registerClass(
class TachoGraph extends St.DrawingArea {
    _init({color = COLORS.cpu, color2 = null, faint = false, chip = false, slots = 40, ...params} = {}) {
        super._init({style_class: faint ? 'tacho-graph tacho-graph-faint' : 'tacho-graph', ...params});
        this._color = color;
        this._color2 = color2;
        this._faint = faint;
        this._chip = chip;
        this._slots = slots;
        this._values = [];
        this._values2 = null;
        this._key = null;
    }

    /** Values are 0..1, oldest first; `values2` is drawn as a line on top. */
    setValues(values, values2 = null) {
        const key = `${graphKey(values)}|${values2 ? graphKey(values2) : ''}`;
        if (key === this._key)
            return;
        this._key = key;
        this._values = values.slice(-this._slots);
        this._values2 = values2 ? values2.slice(-this._slots) : null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        let fillAlpha = this._faint ? 0.22 : 0.35;
        const lineAlpha = this._faint ? 0.45 : 0.95;
        if (this._chip) {
            // A rounded box tinted with the text colour, so it shows on
            // dark and light top bars, with the graph clipped inside it.
            const fg = this.get_theme_node().get_foreground_color();
            const r = Math.min(3 * (height / 16), height / 2, 6);
            cr.newSubPath();
            cr.arc(width - r, r, r, -Math.PI / 2, 0);
            cr.arc(width - r, height - r, r, 0, Math.PI / 2);
            cr.arc(r, height - r, r, Math.PI / 2, Math.PI);
            cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
            cr.closePath();
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.13);
            cr.fillPreserve();
            cr.clip();
            fillAlpha = 0.8;
        }
        this._draw(cr, width, height, this._values, this._color, fillAlpha, lineAlpha);
        if (this._values2)
            this._draw(cr, width, height, this._values2, this._color2 ?? this._color, 0, lineAlpha);
        cr.$dispose();
    }

    _draw(cr, width, height, values, [r, g, b], fillAlpha, lineAlpha) {
        if (values.length < 2 || width <= 0 || height <= 0)
            return;
        // Newest sample on the right edge; a short history leaves the left empty.
        const step = width / (this._slots - 1);
        const x0 = width - (values.length - 1) * step;
        const y = v => height - 1 - Math.min(Math.max(v ?? 0, 0), 1) * (height - 2);
        cr.setLineWidth(1);
        cr.moveTo(x0, y(values[0]));
        for (let i = 1; i < values.length; i++)
            cr.lineTo(x0 + i * step, y(values[i]));
        if (fillAlpha > 0) {
            cr.setSourceRGBA(r, g, b, lineAlpha);
            cr.strokePreserve();
            cr.lineTo(width, height);
            cr.lineTo(x0, height);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, fillAlpha);
            cr.fill();
        } else {
            cr.setSourceRGBA(r, g, b, lineAlpha);
            cr.stroke();
        }
    }
});
