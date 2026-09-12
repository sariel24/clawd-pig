'use strict';
/* 真实桌面 scanOnly：只扫描候选，不移动任何真实文件（自动退出） */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.on('web-contents-created', (_e, c) => {
  c.on('console-message', (a, b) => {
    let l = a, m = b;
    if (typeof a === 'object' && a) { l = a.level; m = a.message; }
    if (l === 'error') console.log('[renderer:error]', m);
  });
});
require('./main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return null;
  const r = await w.webContents.executeJavaScript(`(async()=>{try{return JSON.stringify(await (${expr}));}catch(e){return JSON.stringify({__err:String(e)})}})()`);
  try { return JSON.parse(r); } catch (e) { return null; }
}

(async () => {
  await app.whenReady();
  await wait(1500);
  const st = await ev('window.iconAPI.state()');
  const desk = st && st.desktop;
  const before = desk && fs.existsSync(desk) ? fs.readdirSync(desk) : [];
  const scan = await ev('window.iconAPI.scan()');
  await wait(300);
  const after = desk && fs.existsSync(desk) ? fs.readdirSync(desk) : [];
  console.log('模式:', st && st.settings && st.settings.scanOnly ? 'scanOnly（只扫描，不移动）' : '真实移动已开启');
  console.log('桌面目录:', desk);
  console.log('仓库目录:', st && st.belly);
  console.log('候选数量:', (scan && scan.entries || []).length);
  for (const e of (scan && scan.entries || [])) console.log('  -', e.name);
  const unchanged = JSON.stringify(before.slice().sort()) === JSON.stringify(after.slice().sort());
  console.log('桌面文件清单前后一致(未被移动/删除):', unchanged, `(${before.length} 项)`);
  console.log('SMOKE-OK (auto quit)');
  app.exit(unchanged ? 0 : 3);
})().catch((e) => { console.error('EXC', e); app.exit(2); });
setTimeout(() => { console.log('TIMEOUT'); app.exit(4); }, 30000);
