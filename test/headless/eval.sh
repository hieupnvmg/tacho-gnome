#!/bin/bash
export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/tacho-nested/bus)
timeout ${T:-20} gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"
