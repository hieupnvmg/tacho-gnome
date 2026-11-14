#!/bin/bash
# Stops only processes started for the throwaway shell: those whose
# environment has XDG_RUNTIME_DIR=/tmp/tacho-nested/runtime.
mine=()
exec 2>/dev/null
for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [ "$pid" = "$$" ] && continue
    if tr "\0" "\n" 2>/dev/null < $d/environ | grep -qx 'XDG_RUNTIME_DIR=/tmp/tacho-nested/runtime'; then
        mine+=("$pid")
    fi
done
[ ${#mine[@]} -gt 0 ] && { echo "stopping: $(for p in "${mine[@]}"; do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-40; echo -n '; '; done)"; kill "${mine[@]}" 2>/dev/null; sleep 2; kill -9 "${mine[@]}" 2>/dev/null; }
fusermount -uz /tmp/tacho-nested/runtime/doc 2>/dev/null
fusermount -uz /tmp/tacho-nested/runtime/gvfs 2>/dev/null
exit 0
