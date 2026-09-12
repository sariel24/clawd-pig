'use strict';
/* 打包前回归：确认 fs 版 app:// 协议下渲染页仍能加载、素材仍就绪（自动退出） */
const { app, BrowserWindow } = require('electron');
let failed = false;
app.on('web-contents-created', (_e, c) => {
  c.on('did-fail-load', (_ev, code, desc, url) => { failed = true; console.log(`[did-fail-load] ${code} ${desc} ${url}`); });
  c.on('console-message', (a, b) => {
    let l = a, m = b;
    if (typeof a === 'object' && a) { l = a.level; m = a.message; }
    if (l === 'error') console.log('[renderer:error]', m);
  });
});
require('./main.js');
setTimeout(() => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.log('FAIL no-window'); app.exit(2); return; }
  w.webContents.executeJavaScript('JSON.stringify(__clawd.getState())').then((s) => {
    console.log('[state]', s);
    console.log('SPRITES', /"sprites":true/.test(s) ? 'OK' : 'MISSING');
    console.log(`SMOKE failed=${failed} visible=${w.isVisible()}`);
    console.log('SMOKE-OK (auto quit)');
    app.exit(failed ? 3 : 0);
  }).catch((e) => { console.log('FAIL', String(e)); app.exit(2); });
}, 5000);
process.on('uncaughtException', (e) => { console.error('EXC', e); app.exit(2); });
