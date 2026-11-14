(async () => {
  const {default: Shell} = await import('gi://Shell');
  const {default: Gio} = await import('gi://Gio');
  const Main = await import('resource:///org/gnome/shell/ui/main.js');
  const mode = globalThis._tachoMode;
  const open = globalThis._tachoOpen;
  const ext = Main.extensionManager.lookup('tacho@hieupnvmg.github.io');
  const settings = ext.stateObj._tacho.settings;
  if (mode && settings.get_string('display-mode') !== mode)
    settings.set_string('display-mode', mode);
  await new Promise(r => setTimeout(r, 3500));
  const buttons = Object.keys(Main.panel.statusArea).filter(k => k.startsWith('tacho')).map(k => Main.panel.statusArea[k]);
  if (open !== undefined && buttons[open])
    buttons[open].menu.open(false);
  await new Promise(r => setTimeout(r, 800));
  const file = Gio.File.new_for_path(`/tmp/tacho-shot-${globalThis._tachoName}.png`);
  const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
  const shot = new Shell.Screenshot();
  await new Promise((res, rej) => shot.screenshot(false, stream, (o, r) => { try { o.screenshot_finish(r); res(); } catch (e) { rej(e); } }));
  stream.close(null);
  for (const b of buttons) b.menu.close(false);
  globalThis._tachoShot = 'done';
})().catch(e => { globalThis._tachoShot = String(e); });
