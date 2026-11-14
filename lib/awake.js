// "Keep awake": an inhibitor taken from GNOME's session manager, the same
// one a video player takes, so the screen does not blank and the computer
// does not suspend while it is held.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;

export class KeepAwake {
    constructor(reason) {
        this._reason = reason;
        this._cookie = null;
        this._wanted = false;
        this._listeners = new Map();
        this._nextId = 1;
    }

    get active() {
        return this._wanted;
    }

    connectChanged(callback) {
        const id = this._nextId++;
        this._listeners.set(id, callback);
        return id;
    }

    disconnectChanged(id) {
        this._listeners.delete(id);
    }

    _emit() {
        for (const callback of this._listeners.values())
            callback(this._wanted);
    }

    set(on) {
        if (on === this._wanted)
            return;
        this._wanted = on;
        if (on)
            this._inhibit();
        else
            this._uninhibit();
        this._emit();
    }

    _call(method, params, replyType, callback) {
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            method, params, replyType, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    callback(connection.call_finish(result));
                } catch (e) {
                    console.warn(`Tacho: ${method} failed: ${e.message}`);
                    callback(null);
                }
            });
    }

    _inhibit() {
        this._call('Inhibit',
            new GLib.Variant('(susu)', ['tacho', 0, this._reason, INHIBIT_SUSPEND | INHIBIT_IDLE]),
            new GLib.VariantType('(u)'),
            reply => {
                if (!reply) {
                    this._wanted = false;
                    this._emit();
                    return;
                }
                const [cookie] = reply.deepUnpack();
                // Switched off again while the call was under way.
                if (!this._wanted)
                    this._release(cookie);
                else
                    this._cookie = cookie;
            });
    }

    _uninhibit() {
        if (this._cookie === null)
            return;
        this._release(this._cookie);
        this._cookie = null;
    }

    _release(cookie) {
        this._call('Uninhibit', new GLib.Variant('(u)', [cookie]), null, () => {});
    }

    destroy() {
        this._listeners.clear();
        this._wanted = false;
        this._uninhibit();
    }
}
