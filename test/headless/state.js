(async () => {
  const Main = await import('resource:///org/gnome/shell/ui/main.js');
  const e = Main.extensionManager.lookup('tacho@hieupnvmg.github.io');
  const keys = Object.keys(Main.panel.statusArea).filter(k => k.startsWith('tacho'));
  const out = {state: e?.state, error: String(e?.error ?? ''), buttons: keys};
  for (const k of keys) {
    const b = Main.panel.statusArea[k];
    const texts = [];
    const walk = a => { if (a.text !== undefined && a instanceof imports.gi.St.Label) texts.push(a.text); a.get_children().forEach(walk); };
    walk(b);
    out[k] = {visible: b.container.visible, width: b.width, height: b.height, texts};
  }
  globalThis._tachoState = JSON.stringify(out);
})();
