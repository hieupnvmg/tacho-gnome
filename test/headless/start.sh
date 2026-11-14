#!/bin/bash
# Throwaway headless GNOME Shell. EXTS: gsettings list of enabled extensions.
set -u
UUID=tacho@hieupnvmg.github.io
T=/tmp/tacho-nested
EXTS=${EXTS:-"['$UUID']"}
rm -rf $T 2>/dev/null; mkdir -p $T/data/gnome-shell/extensions/$UUID $T/config $T/cache $T/runtime
chmod 700 $T/runtime
unzip -q /tmp/tacho.zip -d $T/data/gnome-shell/extensions/$UUID
cat > $T/inner.sh <<INNER
gsettings set org.gnome.shell enabled-extensions "$EXTS"
gsettings set org.gnome.shell disable-user-extensions false
echo "\$DBUS_SESSION_BUS_ADDRESS" > $T/bus
exec gnome-shell --headless --unsafe-mode --virtual-monitor 1600x900 --wayland --no-x11
INNER
export XDG_DATA_HOME=$T/data XDG_CONFIG_HOME=$T/config XDG_CACHE_HOME=$T/cache XDG_RUNTIME_DIR=$T/runtime
unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
export NO_AT_BRIDGE=1 GTK_A11Y=none GTK_USE_PORTAL=0
# A session bus that can only start dconf: no portals, calendar, a11y, gvfs.
mkdir -p $T/services
cp /usr/share/dbus-1/services/ca.desrt.dconf.service $T/services/
cat > $T/bus.conf <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=$T</listen>
  <servicedir>$T/services</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
setsid dbus-run-session --config-file=$T/bus.conf -- bash $T/inner.sh > $T/shell.log 2>&1 < /dev/null &
