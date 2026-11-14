#!/bin/bash
# On acer: start the throwaway shell, screenshot three modes and the menu.
bash /tmp/start.sh; sleep 16
for spec in combined:combined: menu:combined:0 graphs:separate-graphs: plain:separate: ; do
  IFS=: read name mode open <<< "$spec"; o=${open:-undefined}
  bash /tmp/eval.sh "globalThis._tachoMode=\"$mode\"; globalThis._tachoOpen=$o; globalThis._tachoName=\"$name\"; globalThis._tachoShot=null; $(cat /tmp/screenshot.js)" >/dev/null
  sleep 6
  bash /tmp/eval.sh "globalThis._tachoShot" | grep -v done
done
grep -iE "JS ERROR|TypeError|ReferenceError" /tmp/tacho-nested/shell.log | head -5
bash /tmp/stop.sh >/dev/null
