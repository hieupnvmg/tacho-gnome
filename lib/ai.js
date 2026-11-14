// Claude Code and Codex usage, read from their local session logs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as P from './parsers.js';
import {homeDir, isCancelled, JsonlTail, readText, stat, tailLines, walk} from './io.js';

const RECENT = 2 * 86400; // seconds

function codexHome() {
    return GLib.getenv('CODEX_HOME') || `${homeDir()}/.codex`;
}

function claudeHome() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') || `${homeDir()}/.claude`;
}

export function claudeSnapshotPath() {
    return `${claudeHome()}/tacho-usage.json`;
}

class CodexReader {
    constructor() {
        this._tail = new JsonlTail();
        this._usage = new P.CodexUsage();
        this._lookedBack = false;
    }

    get root() {
        return `${codexHome()}/sessions`;
    }

    async read(cancellable) {
        if (!await stat(this.root, cancellable))
            return null;
        this._usage.rollDay();
        const files = await walk(this.root, '.jsonl', cancellable);
        const cutoff = Date.now() / 1000 - RECENT;
        const recent = files.filter(f => f.mtime >= cutoff).sort((a, b) => a.mtime - b.mtime);
        this._tail.prune(recent.map(f => f.path));
        await this._tail.read(recent, '"token_count"', line => this._usage.addLine(line), cancellable);
        if (!this._usage.windows.length && !this._lookedBack) {
            this._lookedBack = true;
            await this._lookBack(files, cancellable);
        }
        return this._usage.snapshot();
    }

    // Nothing in the last two days: the newest older session that reported
    // limits, read from its end, so the limits still show (or that they
    // have reset since).
    async _lookBack(files, cancellable) {
        const newest = files.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 30);
        for (const file of newest) {
            const lines = await tailLines(file.path, file.size, 1_000_000, cancellable);
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].includes('"rate_limits"') && this._usage.takeWindowsFrom(lines[i]))
                    return;
            }
        }
    }
}

class ClaudeReader {
    constructor() {
        this._tail = new JsonlTail();
        this._usage = new P.ClaudeUsage();
    }

    async read(cancellable) {
        const home = claudeHome();
        if (!await stat(home, cancellable))
            return null;
        this._usage.rollDay();
        const root = `${home}/projects`;
        const cutoff = Date.now() / 1000 - RECENT;
        const files = (await walk(root, '.jsonl', cancellable))
            .filter(f => f.mtime >= cutoff)
            .sort((a, b) => a.mtime - b.mtime);
        this._tail.prune(files.map(f => f.path));
        await this._tail.read(files, '"usage"', line => this._usage.addLine(line), cancellable);
        const result = this._usage.snapshot();
        const text = await readText(claudeSnapshotPath(), cancellable);
        const snap = text ? P.parseClaudeSnapshot(text) : null;
        if (snap) {
            result.windows = snap.windows;
            result.windowsUpdated = snap.updated;
            result.model = snap.model ?? result.model;
            result.statusLine = true;
        } else {
            result.statusLine = false;
        }
        return result;
    }
}

/** Reads both assistants every minute and hands the result to `onUpdate`. */
export class AiWatcher {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._codex = new CodexReader();
        this._claude = new ClaudeReader();
        this._timer = 0;
        this._startTimer = 0;
        this._reading = false;
        this._cancellable = null;
        this._lastRead = 0;
        this.state = {claude: null, codex: null};
    }

    start() {
        if (this._timer || this._startTimer)
            return;
        // The first read goes through every recent log; it waits a little
        // so logging in stays light.
        this._startTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 15, () => {
            this._startTimer = 0;
            this.refresh();
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this._startTimer)
            GLib.source_remove(this._startTimer);
        if (this._timer)
            GLib.source_remove(this._timer);
        this._startTimer = 0;
        this._timer = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    /** Reads now unless a read happened in the last `minAge` seconds. */
    refreshIfOlder(minAge) {
        if (Date.now() / 1000 - this._lastRead >= minAge)
            this.refresh();
    }

    async refresh() {
        if (this._reading)
            return;
        this._reading = true;
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        try {
            const codex = await this._codex.read(cancellable);
            const claude = await this._claude.read(cancellable);
            this._lastRead = Date.now() / 1000;
            this.state = {claude, codex};
            this._onUpdate(this.state);
        } catch (e) {
            if (!isCancelled(e))
                console.error('Tacho: reading AI usage failed', e);
        } finally {
            this._reading = false;
        }
    }

    destroy() {
        this.stop();
        this._onUpdate = () => {};
    }
}
