# Trying the extension in a throwaway GNOME Shell

On an Ubuntu/GNOME machine, without touching the desktop session that is
running: a headless `gnome-shell` on its own D-Bus bus (which can only
start dconf), with its own dconf, cache and runtime folders under
`/tmp/tacho-nested`.

```bash
make && cp build/github/tacho@hieupnvmg.github.io.shell-extension.zip /tmp/tacho.zip
bash test/headless/start.sh            # EXTS="[]" for a shell without Tacho
sleep 15
bash test/headless/eval.sh "$(cat test/headless/state.js)"; bash test/headless/eval.sh globalThis._tachoState
bash test/headless/stop.sh             # stops only processes of this shell
```

`screenshot.js` switches the display mode (`globalThis._tachoMode`),
optionally opens a menu (`_tachoOpen`) and saves `/tmp/tacho-shot-<_tachoName>.png`.
Errors from the extension appear in `/tmp/tacho-nested/shell.log`.
