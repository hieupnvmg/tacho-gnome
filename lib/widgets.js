// Small St helpers shared by the panel and the menu.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

/**
 * A vertical St.BoxLayout. Set through the layout manager, which works
 * both before GNOME 48 (`vertical`) and after (`orientation`).
 */
export function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    box.layout_manager.orientation = Clutter.Orientation.VERTICAL;
    return box;
}

/** Sets a label's text only when it differs, so nothing relayouts for nothing. */
export function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}

const LEVELS = ['tacho-warning', 'tacho-critical'];

/** Applies 'normal' | 'warning' | 'critical' as a style class. */
export function setLevel(actor, level) {
    for (const cls of LEVELS) {
        const want = cls === `tacho-${level}`;
        if (actor.has_style_class_name(cls) !== want) {
            if (want)
                actor.add_style_class_name(cls);
            else
                actor.remove_style_class_name(cls);
        }
    }
}

export function setVisible(actor, visible) {
    if (actor.visible !== visible)
        actor.visible = visible;
}

/** Dims secondary text in a way that works on dark and light themes. */
export function dim(actor, opacity = 165) {
    actor.opacity = opacity;
    return actor;
}
