'use strict';
/* 图标功能自动化测试：使用临时桌面与临时 userData，绝不触碰真实桌面 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// 项目根目录用脚本自身位置推导，避免写入本机绝对路径
const ROOT = __dirname;
const DESK = path.join(ROOT, '.test-desktop');
const USER = path.join(ROOT, '.test-userdata');

function setup() {
  fs.rmSync(DESK, { recursive: true, force: true });
  fs.rmSync(USER, { recursive: true, force: true });
  fs.mkdirSync(DESK, { recursive: true });
  fs.mkdirSync(USER, { recursive: true });
  const mk = (n, c) => fs.writeFileSync(path.join(DESK, n), c || 'fake shortcut');
  mk('A游戏.lnk'); mk('B工具.url'); mk('Chat.lnk');
  mk('小猪Clawd.lnk');           // 必须排除（自身）
  mk('Photo.jpg'); mk('Doc.docx'); mk('pack.zip');
  fs.mkdirSync(path.join(DESK, 'SomeFolder'), { recursive: true });
}
setup();

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}#${results.length} (${ok ? 'ok' : 'check failed'})`);
  try { fs.appendFileSync(path.join(ROOT, 'test-report.txt'), `${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}\n`, 'utf8'); } catch (e) { /* ignore */ }
}

app.on('web-contents-created', (_e, c) => {
  c.on('console-message', (a, b) => {
    let l = a, m = b;
    if (typeof a === 'object' && a) { l = a.level; m = a.message; }
    if (l === 'error') console.log('[renderer:error]', m);
  });
});
require('./main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function petWin() { return BrowserWindow.getAllWindows()[0]; }
async function ev(expr) {
  const w = petWin();
  if (!w) return null;
  const r = await w.webContents.executeJavaScript(`(async()=>{ try { return JSON.stringify(await (${expr})); } catch(e){ return JSON.stringify({__err:String(e)}); } })()`);
  try { return JSON.parse(r); } catch (e) { return null; }
}
const bellyDir = () => path.join(USER, 'belly-storage');
const manifestPath = () => path.join(bellyDir(), 'manifest.json');
const readManifest = () => { try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch (e) { return []; } };
const writeManifest = (m) => fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
const lsDesk = () => fs.readdirSync(DESK).filter((n) => fs.statSync(path.join(DESK, n)).isFile());

async function main() {
  await app.whenReady();
  await wait(1500);

  // 1) 扫描：只允许 .lnk/.url；排除文件夹/照片/文档/压缩包/自身
  const scan = await ev('window.iconAPI.scan()');
  const names = (scan && scan.entries || []).map((e) => e.name).sort();
  check('扫描只列出快捷方式', JSON.stringify(names) === JSON.stringify(['A游戏.lnk', 'B工具.url', 'Chat.lnk'].sort()), JSON.stringify(names));
  check('排除目录/文档/图片/压缩包/自身', !names.some((n) => /Photo|Docx|zip|Folder|小猪/i.test(n)));

  // 2) 动画预览：三组动画不串帧、可回到 idle 第1帧
  await ev('window.__clawdIcons.preview(0)');
  await wait(400);
  let st = await ev('window.__clawd.getState()');
  check('播放第1行（吃）动画', st && /^icon:row0:/.test(st.spriteView || ''), st && st.spriteView);
  await wait(1700);
  st = await ev('window.__clawd.getState()');
  check('吃完回 idle 第1帧静止', st && st.spriteView === 'core:idle' && st.frameCol === 0, st && st.spriteView + ' col=' + st.frameCol);
  await ev('window.__clawdIcons.preview(1)');
  await wait(300);
  st = await ev('window.__clawd.getState()');
  check('播放第2行（嫌弃）动画', st && /^icon:row1:/.test(st.spriteView || ''), st && st.spriteView);
  await wait(1700);
  await ev('window.__clawdIcons.preview(2)');
  await wait(300);
  st = await ev('window.__clawd.getState()');
  check('播放第3行（种植）动画', st && /^icon:row2:/.test(st.spriteView || ''), st && st.spriteView);
  await wait(1700);

  const aPath = path.join(DESK, 'A游戏.lnk');

  // 3) scanOnly 默认：只扫描，不移动
  const settings0 = await ev('window.iconAPI.state()');
  check('默认 scanOnly=true', settings0 && settings0.settings && settings0.settings.scanOnly === true);
  const eatBlocked = await ev(`window.iconAPI.eat({name:'A游戏.lnk', path:${JSON.stringify(aPath)}, hunger:70})`);
  check('scanOnly 下拒绝移动真实文件', eatBlocked && eatBlocked.ok === false && eatBlocked.reason === 'scanOnly', JSON.stringify(eatBlocked));
  check('scanOnly 后文件仍在桌面', fs.existsSync(aPath));

  // 4) 打开真实移动（仅测试环境）
  await ev('window.iconAPI.setSettings({scanOnly:false, dailyLimit:5, cooldownMs:0})');

  // 5) 吃掉 A：移动进 belly-storage，清单落盘
  const eatA = await ev(`window.iconAPI.eat({name:'A游戏.lnk', path:${JSON.stringify(aPath)}, hunger:80})`);
  check('吃掉快捷方式成功', eatA && eatA.ok === true, JSON.stringify(eatA && eatA.record && eatA.record.storedName));
  check('原桌面文件已移走', !fs.existsSync(aPath));
  const man1 = readManifest();
  const recA = man1.find((e) => e.originalName === 'A游戏.lnk');
  check('清单记录（ID/原路径/仓库路径/状态/时间）', !!(recA && recA.id && recA.originalPath && recA.storedName && recA.status === 'stored' && recA.eatenAt));
  check('仓库文件真实存在（未删除）', !!(recA && fs.existsSync(path.join(bellyDir(), recA.storedName))));

  // 6) 同名冲突：不覆盖（确定性：临时把 A 设为“喜欢”，抵消同类近期惩罚）
  fs.writeFileSync(aPath, 'fake shortcut 2');
  await ev(`window.iconAPI.setSettings({preferences:{'A游戏.lnk':'like'}, cooldownMs:0})`);
  const eatA2 = await ev(`window.iconAPI.eat({name:'A游戏.lnk', path:${JSON.stringify(aPath)}, hunger:100})`);
  check('同名冲突自动改名不覆盖', eatA2 && eatA2.ok === true && eatA2.record && /\(1\)/.test(eatA2.record.storedName), JSON.stringify(eatA2));
  await ev(`window.iconAPI.setSettings({preferences:{}})`);

  // 7) 挑食：不喜欢 + 不饿 → 嫌弃（不移动）
  await ev(`window.iconAPI.setSettings({cooldownMs:0, preferences:{'B工具.url':'dislike'}})`);
  const bPath = path.join(DESK, 'B工具.url');
  const ev1 = await ev(`window.iconAPI.evaluate({path:${JSON.stringify(bPath)}, hunger:10})`);
  check('挑食评分低→拒绝', ev1 && ev1.ok === false && ev1.reason === 'not-hungry', JSON.stringify(ev1));
  // 复位偏好与额度，继续后续“移动/恢复”用例
  await ev(`window.iconAPI.setSettings({preferences:{}, dailyLimit:10, cooldownMs:0})`);

  // 8) 异常中断自愈：manifest 停在 moving，重启（调用 state 触发 reconcile）
  const eatB = await ev(`window.iconAPI.eat({name:'B工具.url', path:${JSON.stringify(bPath)}, hunger:90})`);
  check('吃掉 B 成功', eatB && eatB.ok === true, JSON.stringify(eatB));
  const man3 = readManifest();
  const target = man3.find((e) => e.originalName === 'B工具.url');
  check('B 已写入清单', !!target);
  target.status = 'moving'; // 模拟“移动中途崩溃”
  writeManifest(man3);
  const stAfter = await ev('window.iconAPI.state()');
  const healed = (stAfter.stored || []).find((e) => e.name === 'B工具.url');
  check('异常中断自愈（moving→stored）', !!(healed && healed.status === 'stored'), healed && healed.status);

  // 9) 异常中断（文件其实已回桌面）→ 自愈为 restored
  const man4 = readManifest();
  const t2 = man4.find((e) => e.originalName === 'B工具.url');
  fs.copyFileSync(path.join(bellyDir(), t2.storedName), bPath);   // 假装已回到桌面
  fs.unlinkSync(path.join(bellyDir(), t2.storedName));
  t2.status = 'moving';
  writeManifest(man4);
  await ev('window.iconAPI.state()');
  const m5 = readManifest().find((e) => e.originalName === 'B工具.url');
  check('中断后已回桌面→标记 restored', m5 && m5.status === 'restored', m5 && m5.status);

  // 10) 种植恢复：plant → harvest 回到桌面；立即种好并恢复
  const stash = (await ev('window.iconAPI.stored()')) || [];
  const first = stash[0];
  const planted = await ev(`window.iconAPI.plantAnimate(${JSON.stringify(first.id)})`);
  check('种植标记 planting + 触发动画', planted && planted.ok === true, JSON.stringify(planted && planted.record && planted.record.status));
  await wait(500);
  const stPlant = await ev('window.__clawd.getState()');
  check('种植时播放第3行动画', stPlant && /^icon:row2:/.test(stPlant.spriteView || ''), stPlant && stPlant.spriteView);
  await wait(1800);
  const harvested = await ev(`window.iconAPI.harvest(${JSON.stringify(first.id)})`);
  check('收获→恢复到桌面', harvested && harvested.ok === true && fs.existsSync(harvested.restoredTo), harvested && harvested.restoredTo);

  // 11) 一键恢复全部
  const left = await ev('window.iconAPI.restoreAll()');
  check('立即恢复全部', left && left.ok === true, `restored=${left && left.restored}`);
  const stillStored = (readManifest() || []).filter((e) => e.status === 'stored' || e.status === 'planting' || e.status === 'moving');
  check('仓库已清空（无残留）', stillStored.length === 0, JSON.stringify(stillStored.map((e) => e.name)));

  // 12) 永远不吃名单
  await ev(`window.iconAPI.setSettings({neverEat:['Chat.lnk']})`);
  const scan2 = await ev('window.iconAPI.scan()');
  check('永远不吃名单生效', !(scan2.entries || []).some((e) => e.name === 'Chat.lnk'));

  // 13) 每日上限
  await ev(`window.iconAPI.setSettings({neverEat:[], dailyLimit:0, cooldownMs:0})`);
  const cPath = path.join(DESK, 'Chat.lnk');
  const evLimit = await ev(`window.iconAPI.evaluate({path:${JSON.stringify(cPath)}, hunger:90})`);
  check('每日上限生效', evLimit && evLimit.ok === false && evLimit.reason === 'daily-limit', JSON.stringify(evLimit));

  // 14) 非快捷方式绝不允许
  const jPath = path.join(DESK, 'Photo.jpg');
  const evJpg = await ev(`window.iconAPI.evaluate({path:${JSON.stringify(jPath)}, hunger:90})`);
  check('禁止处理照片等真实文件', evJpg && evJpg.ok === false, JSON.stringify(evJpg));

  // 15) 开关可正常切换（对应面板解除锁定后的行为）
  const sOn = await ev('window.iconAPI.setSettings({scanOnly:false})');
  check('可开启真实移动（解锁后）', sOn && sOn.scanOnly === false);
  const sOff = await ev('window.iconAPI.setSettings({scanOnly:true})');
  check('可切回只扫描模式', sOff && sOff.scanOnly === true);

  // 16) 仓库数据(manifest)损坏：不删除任何快捷方式，能从仓库重建并恢复
  await ev(`window.iconAPI.setSettings({scanOnly:false, neverEat:[], dailyLimit:10, cooldownMs:0, preferences:{'Chat.lnk':'like'}})`);
  const cPath2 = path.join(DESK, 'Chat.lnk');
  const eatC = await ev(`window.iconAPI.eat({name:'Chat.lnk', path:${JSON.stringify(cPath2)}, hunger:100})`);
  check('吃掉 Chat 作为损坏测试样本', eatC && eatC.ok === true, JSON.stringify(eatC && eatC.reason));
  fs.writeFileSync(manifestPath(), '{ this is corrupted json ###');   // 人为损坏清单
  const stCorrupt = await ev('window.iconAPI.state()');
  const recovered = (stCorrupt.stored || []).filter((e) => e.status === 'stored' || e.status === 'planting');
  check('清单损坏后能从仓库重建记录', recovered.length >= 1, JSON.stringify(recovered.map((e) => e.name)));
  const corruptFiles = fs.readdirSync(bellyDir()).filter((n) => /manifest\.corrupt-/.test(n));
  check('损坏清单改名留档（未删除）', corruptFiles.length >= 1, JSON.stringify(corruptFiles));
  const back = await ev('window.iconAPI.restoreAll()');
  check('损坏后仍能立即恢复全部', back && back.restored >= 1 && fs.existsSync(cPath2), `restored=${back && back.restored}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  console.log('SMOKE-OK (auto quit)');
  app.exit(failed.length ? 3 : 0);
}

main().catch((e) => { console.error('TEST-EXC', e); app.exit(2); });
setTimeout(() => { console.log('TIMEOUT'); app.exit(4); }, 90000);
