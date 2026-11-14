// Small async file helpers on top of Gio. Reads happen in GLib's worker
// threads; only the light line handling comes back to the main loop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {splitChunk} from './parsers.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const decoder = new TextDecoder();

export function homeDir() {
    return GLib.getenv('HOME') || GLib.get_home_dir();
}

export function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** The whole file as text, or null. */
export async function readText(path, cancellable = null) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

/** Modification time (s) and size of a file, or null. */
export async function stat(path, cancellable = null) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'time::modified,standard::size', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable);
        return {mtime: info.get_modification_date_time()?.to_unix() ?? 0, size: info.get_size()};
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

/** Names of the entries of a directory, or []. */
export async function listDir(path, cancellable = null) {
    const names = [];
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return names;
    }
    try {
        for (;;) {
            const infos = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, cancellable);
            if (!infos.length)
                break;
            for (const info of infos)
                names.push(info.get_name());
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
    return names;
}

/**
 * Every regular file under `root` whose name ends with `suffix`, as
 * {path, mtime (s), size}. Hidden entries and symlinks are skipped.
 */
export async function walk(root, suffix, cancellable = null) {
    const out = [];
    const stack = [Gio.File.new_for_path(root)];
    while (stack.length) {
        const dir = stack.pop();
        let enumerator;
        try {
            enumerator = await dir.enumerate_children_async(
                'standard::name,standard::type,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            continue;
        }
        try {
            for (;;) {
                const infos = await enumerator.next_files_async(200, GLib.PRIORITY_LOW, cancellable);
                if (!infos.length)
                    break;
                for (const info of infos) {
                    const name = info.get_name();
                    if (name.startsWith('.'))
                        continue;
                    const type = info.get_file_type();
                    if (type === Gio.FileType.DIRECTORY) {
                        stack.push(dir.get_child(name));
                    } else if (type === Gio.FileType.REGULAR && name.endsWith(suffix)) {
                        out.push({
                            path: dir.get_child(name).get_path(),
                            mtime: info.get_modification_date_time()?.to_unix() ?? 0,
                            size: info.get_size(),
                        });
                    }
                }
            }
        } finally {
            enumerator.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
    return out;
}

const CHUNK = 1 << 20;

/**
 * Reads the lines appended to growing JSONL files since the last call,
 * remembering a byte offset per file. A half-written last line waits for
 * the next call. Lines are filtered by substring before they are handed
 * on, since parsing JSON is the expensive part.
 */
export class JsonlTail {
    constructor() {
        this._offsets = new Map();
    }

    async read(files, needle, onLine, cancellable = null) {
        for (const file of files) {
            let pos = this._offsets.get(file.path) ?? 0;
            if (pos > file.size)
                pos = 0; // replaced or truncated
            if (file.size <= pos)
                continue;
            let stream;
            try {
                stream = await Gio.File.new_for_path(file.path).read_async(GLib.PRIORITY_LOW, cancellable);
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                continue;
            }
            try {
                if (pos > 0)
                    stream.seek(pos, GLib.SeekType.SET, cancellable);
                let carry = null;
                for (;;) {
                    const bytes = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_LOW, cancellable);
                    if (bytes.get_size() === 0)
                        break;
                    const r = splitChunk(carry, bytes.toArray(), needle, decoder);
                    pos += r.consumed;
                    carry = r.carry;
                    for (const line of r.lines)
                        onLine(line);
                }
            } catch (e) {
                if (isCancelled(e))
                    throw e;
            } finally {
                stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
            }
            this._offsets.set(file.path, pos);
        }
    }

    /** Forgets files that are no longer in `paths`. */
    prune(paths) {
        const keep = new Set(paths);
        for (const path of this._offsets.keys()) {
            if (!keep.has(path))
                this._offsets.delete(path);
        }
    }
}

/** The last `maxBytes` of a file as complete lines, newest last. */
export async function tailLines(path, size, maxBytes, cancellable = null) {
    let stream;
    try {
        stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return [];
    }
    try {
        const start = Math.max(size - maxBytes, 0);
        if (start > 0)
            stream.seek(start, GLib.SeekType.SET, cancellable);
        const parts = [];
        let total = 0;
        while (total < maxBytes) {
            const bytes = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_LOW, cancellable);
            if (bytes.get_size() === 0)
                break;
            parts.push(bytes.toArray());
            total += bytes.get_size();
        }
        const data = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
            data.set(p, o);
            o += p.length;
        }
        const lines = decoder.decode(data).split('\n');
        if (start > 0)
            lines.shift(); // probably cut in half
        return lines.filter(l => l.length);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return [];
    } finally {
        stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
}
