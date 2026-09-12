'use strict';

/**
 * 小猪 Clawd 桌面宠物 —— 主进程
 *
 * 安全配置：
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - 渲染进程只能通过 preload 暴露的最小 petAPI 与主进程通信
 *  - 拒绝新窗口 / 导航
 *
 * 素材加载：不修改任何 PNG/JSON。spritesheet-extended-v3.png 存在则按
 * validation-extended-v3*.json 布局播放；不存在则由渲染进程回退到 clawd-pig.png。
 */

const { app, BrowserWindow, ipcMain, screen, Menu, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ASSET_DIR = __dirname; // 素材与代码同目录（当前工作区）
const SPRITE_DIR = path.join(__dirname, 'assets');
const RENDERER_DIR = path.join(__dirname, 'renderer');
const MAX_DIM = 4096;

// 仅供自动化测试：允许把 userData/桌面重定向到临时目录，避免触碰真实桌面
if (process.env.CLAWD_TEST_USERDATA) {
  try { app.setPath('userData', process.env.CLAWD_TEST_USERDATA); } catch (e) { /* ignore */ }
}

// 尺寸预设与动作菜单（渲染进程只需按返回码执行）
const SIZE_PRESETS = [
  { id: 'small', label: '小（96×96）' },
  { id: 'standard', label: '标准（128×128）' },
  { id: 'large', label: '大（160×160）' },
];
const ACTION_MENU = [
  { id: 'sleeping', label: '睡觉' },
  { id: 'working', label: '工作' },
  { id: 'drawing', label: '画画' },
  { id: 'planting', label: '种花' },
  { id: 'watering', label: '浇水' },
  { id: 'picking', label: '摘花' },
  { id: 'gifting', label: '送花' },
  { id: 'watching', label: '刷视频' },
];
const DEMO_MENU = [
  { id: 'working', label: '工作' },
  { id: 'drawing', label: '画画' },
  { id: 'planting', label: '种花' },
  { id: 'watering', label: '浇水' },
  { id: 'picking', label: '摘花' },
  { id: 'gifting', label: '送花' },
  { id: 'watching', label: '刷视频' },
  { id: 'sleeping', label: '睡觉' },
];
// “测试新素材”子菜单
const SPRITE_TEST_MENU = [
  { id: 'idle', label: '测试待机' },
  { id: 'walk', label: '测试走路' },
  { id: 'happy', label: '测试开心' },
  { id: 'expressions', label: '测试四种表情' },
  { id: 'plant', label: '测试种花' },
  { id: 'water', label: '测试浇水' },
  { id: 'paint', label: '测试画画' },
  { id: 'phone', label: '测试刷手机' },
];

// 自定义安全协议：让渲染页拥有同源（app://pet），配合 CSP 'self'
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

let win = null;

/* ---------------- 素材读取（只读，绝不修改 PNG） ---------------- */

function readPngAsDataUrl(fileName) {
  const abs = path.join(ASSET_DIR, fileName);
  try {
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function readAsset(name) {
  const abs = path.join(SPRITE_DIR, name);
  try {
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function readLayoutJson() {
  try {
    const names = fs.readdirSync(ASSET_DIR);
    const match = names.find((n) => /^validation-extended-v3.*\.json$/i.test(n));
    if (!match) return null;
    const raw = fs.readFileSync(path.join(ASSET_DIR, match), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getAssetsPayload() {
  const core = readAsset('clawd-pig-core-v1.png');
  const actions = readAsset('clawd-pig-actions-v1.png');
  const manifest = readAsset('sprites-manifest.json');
  const usage = readAsset('使用说明.txt');
  // GPT 生成的表情素材（16格 4×4）：固定按工作区根目录的文件名提供
  const exprRoot = readPngAsDataUrl('ChatGPT Image 2026年9月8日 09_55_17.png');
  return {
    sheet: readPngAsDataUrl('spritesheet-extended-v3.png'),
    reference: readPngAsDataUrl('clawd-pig.png'),
    layout: readLayoutJson(),
    spriteCore: core ? `data:image/png;base64,${core.toString('base64')}` : null,
    spriteActions: actions ? `data:image/png;base64,${actions.toString('base64')}` : null,
    spriteManifestOk: !!(manifest && usage), // 四个素材文件均存在
    expressionSheet: exprRoot,
    iconSheet: readPngAsDataUrl('小猪Clawd-吃图标与种植动作-v1.png'),
  };
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width: 196,
    height: 220,
    x: wa.x + wa.width - 240,
    y: wa.y + wa.height - 260,
    show: false, // 等渲染进程准备好素材并布局后再显示
    transparent: true,
    frame: false,
    resizable: false,
    movable: false, // 拖动由渲染进程通过 IPC 驱动
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  try {
    win.setAlwaysOnTop(true, 'screen-saver');
  } catch {
    /* 某些平台/版本不支持 level 参数，忽略 */
  }

  win.setMenu(null);

  // 安全：拦截新窗口与页面导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.on('closed', () => {
    win = null;
  });

  win.loadURL('app://pet/index.html');
}

/* ---------------- IPC（最小面） ---------------- */

function winOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

ipcMain.handle('pet:get-assets', () => getAssetsPayload());

ipcMain.handle('pet:get-work-area', (event) => {
  const w = winOf(event);
  if (!w) return null;
  try {
    const wa = screen.getDisplayMatching(w.getBounds()).workArea;
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  } catch {
    return null;
  }
});

ipcMain.handle('pet:get-position', (event) => {
  const w = winOf(event);
  if (!w) return null;
  const b = w.getBounds();
  return { x: b.x, y: b.y };
});

ipcMain.handle('pet:set-position', (event, x, y) => {
  const w = winOf(event);
  if (!w || !isFiniteNum(x) || !isFiniteNum(y)) return false;
  w.setPosition(Math.round(x), Math.round(y));
  return true;
});

/* ---- 自主移动唯一控制器（主进程执行插值，整项目仅此一个移动循环） ---- */
let moveTimer = null;
let motion = null; // { token, from:{x,y}, to:{x,y}, dur, t0 }
let moveSeq = 0;

function clearMove() {
  if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
  motion = null;
}

function easeInOutSine(x) {
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

ipcMain.handle('pet:start-move', (event, opts) => {
  const w = winOf(event);
  if (!w || !opts) return false;
  const { x, y } = opts;
  if (!isFiniteNum(x) || !isFiniteNum(y)) return false;
  let dur = opts.duration;
  if (!isFiniteNum(dur)) dur = 4000;
  dur = Math.max(1500, Math.min(12000, Math.round(dur)));

  // 目标必须落在当前显示器工作区内（含10px边距），杜绝越界
  let tx = Math.round(x);
  let ty = Math.round(y);
  try {
    const wa = screen.getDisplayMatching(w.getBounds()).workArea;
    const b = w.getBounds();
    const minX = wa.x + 10;
    const maxX = wa.x + wa.width - b.width - 10;
    const minY = wa.y + 10;
    const maxY = wa.y + wa.height - b.height - 10;
    if (maxX >= minX) tx = Math.max(minX, Math.min(maxX, tx));
    if (maxY >= minY) ty = Math.max(minY, Math.min(maxY, ty));
  } catch (e) { /* 校验失败则按原值 */ }

  clearMove(); // 取消旧任务，保证同一时间只有一个移动
  const from = w.getBounds();
  const seq = ++moveSeq;
  const token = seq;
  motion = { token, from: { x: from.x, y: from.y }, to: { x: tx, y: ty }, dur, t0: Date.now() };
  moveTimer = setInterval(() => {
    if (!motion) return;
    const elapsed = Date.now() - motion.t0;
    const p = Math.max(0, Math.min(1, elapsed / motion.dur));
    const ep = easeInOutSine(p);
    const nx = Math.round(motion.from.x + (motion.to.x - motion.from.x) * ep);
    const ny = Math.round(motion.from.y + (motion.to.y - motion.from.y) * ep);
    w.setPosition(nx, ny);
    if (p >= 1) {
      const done = { token: motion.token, x: nx, y: ny };
      clearMove();
      try { event.sender.send('pet:move-complete', done); } catch (e) { /* ignore */ }
    }
  }, 33); // ≈30fps 平滑插值
  return true;
});

ipcMain.handle('pet:cancel-move', (event) => {
  clearMove();
  return true;
});

ipcMain.handle('pet:set-bounds', (event, b) => {
  const w = winOf(event);
  if (!w || !b) return false;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every(isFiniteNum)) return false;
  if (width < 8 || width > MAX_DIM || height < 8 || height > MAX_DIM) return false;
  w.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  return true;
});

ipcMain.handle('pet:show', (event) => {
  const w = winOf(event);
  if (w && !w.isVisible()) w.show();
  return true;
});

ipcMain.handle('pet:context-menu', (event, opts) => {
  const w = winOf(event);
  if (!w) return Promise.resolve(null);
  const walking = !!(opts && opts.walking);
  const currentSize = SIZE_PRESETS.some((s) => s.id === (opts && opts.size)) ? opts.size : 'small';
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };
    const template = [
      { label: walking ? '暂停走动' : '开始走动', click: () => finish('walk-toggle') },
      { label: '回到待机', click: () => finish('to-idle') },
      { type: 'separator' },
      {
        label: '做点什么',
        submenu: ACTION_MENU.map((a) => ({
          label: a.label,
          click: () => finish('action:' + a.id),
        })),
      },
      {
        label: '演示动作',
        submenu: [
          ...DEMO_MENU.map((a) => ({
            label: a.label,
            click: () => finish('action:' + a.id),
          })),
          { type: 'separator' },
          { label: '演示全部动作', click: () => finish('demo:all') },
        ],
      },
      {
        label: '尺寸',
        submenu: SIZE_PRESETS.map((s) => ({
          label: s.label,
          type: 'radio',
          checked: currentSize === s.id,
          click: () => finish('size:' + s.id),
        })),
      },
      {
        label: '测试新素材',
        submenu: [
          ...SPRITE_TEST_MENU.map((a) => ({
            label: a.label,
            click: () => finish('sprite:' + a.id),
          })),
          { type: 'separator' },
          { label: '依次测试全部新素材', click: () => finish('sprite:all') },
        ],
      },
      {
        label: '图标功能（吃图标/种植）',
        submenu: [
          { label: '打开图标仓库面板（扫描/种子/恢复）', click: () => finish('icons:panel') },
          { type: 'separator' },
          { label: '预览：发现/吞吃/满足（第1行）', click: () => finish('icons:preview:0') },
          { label: '预览：闻/犹豫/嫌弃（第2行）', click: () => finish('icons:preview:1') },
          { label: '预览：种子/挖土/浇水/恢复（第3行）', click: () => finish('icons:preview:2') },
          { type: 'separator' },
          { label: '立即恢复全部快捷方式', click: () => finish('icons:restoreAll') },
        ],
      },
      { type: 'separator' },
      { label: '退出', click: () => finish('quit') },
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.on('menu-will-close', () => setTimeout(() => finish(null), 30));
    menu.popup({ window: w });
  });
});

ipcMain.handle('pet:quit', () => {
  app.quit();
  return true;
});

/* =========================================================================
 * 图标仓库 / 挑食 / 种植恢复（首版仅 Windows）
 *  - 只处理桌面上的 .lnk / .url；绝不触碰文件夹/文档/图片/压缩包等真实文件
 *  - “吃掉” = 移动到 userData/belly-storage（绝不删除）
 *  - 移动前原子写入清单（唯一ID/原名/原路径/仓库路径/时间/状态）
 *  - 默认 scanOnly=true：只扫描与播放动画，不移动真实图标
 * ========================================================================= */
const { randomUUID } = require('node:crypto');

const ICON_SHEET_FILE = '小猪Clawd-吃图标与种植动作-v1.png';
const ALLOWED_EXT = new Set(['.lnk', '.url']);
const BLOCK_NAME_RE = /(clawd|小猪)/i; // 排除小猪自身快捷方式
const DEFAULT_ICON_SETTINGS = {
  scanOnly: true,        // 默认只扫描，不移动真实图标
  dailyLimit: 3,         // 每日上限
  cooldownMs: 90 * 1000, // 冷却
  neverEat: [],          // 永远不吃的名单（文件名）
  preferences: {},       // { 文件名关键词: 'like' | 'dislike' }
  lastEatAt: 0,
  eatenToday: 0,
  eatenDay: '',
};

let iconSettings = null;
let iconManifest = [];
let panelWin = null;

function testDesktopOverride() { return process.env.CLAWD_TEST_DESKTOP || null; }

// Windows 真实桌面路径（app.getPath 会返回 Shell 认知的桌面，兼容 OneDrive 重定向）
function desktopDir() {
  const t = testDesktopOverride();
  if (t) return t;
  try { return app.getPath('desktop'); } catch (e) { return null; }
}

function bellyDir() {
  const d = path.join(app.getPath('userData'), 'belly-storage');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  return d;
}
function settingsFilePath() { return path.join(app.getPath('userData'), 'icon-settings.json'); }
function manifestFilePath() { return path.join(bellyDir(), 'manifest.json'); }

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function saveIconSettings() {
  try { atomicWriteJson(settingsFilePath(), iconSettings); } catch (e) { /* ignore */ }
}
function saveIconManifest() {
  try {
    const file = manifestFilePath();
    // 每次写入前留存上一份清单，降低“数据损坏导致无法恢复”的风险
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, path.join(bellyDir(), 'manifest.bak.json')); } catch (e) { /* ignore */ }
    }
    atomicWriteJson(file, iconManifest);
  } catch (e) { /* ignore */ }
}

// 去掉 “名字 (1)” 这类去重后缀，尽量还原原始文件名
function stripCopySuffix(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  return base.replace(/\s*\(\d+\)$/, '') + ext;
}

// 清单损坏时的兜底：不删除任何文件，仅从仓库里现有快捷方式重建可恢复记录
function rebuildFromBelly() {
  const out = [];
  const belly = bellyDir();
  let names = [];
  try { names = fs.readdirSync(belly); } catch (e) { return out; }
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue; // 仓库里非快捷方式文件一律不动
    const full = path.join(belly, n);
    let st = null;
    try { st = fs.statSync(full); if (!st.isFile()) continue; } catch (e) { continue; }
    out.push({
      id: randomUUID(),
      name: stripCopySuffix(n),
      originalName: stripCopySuffix(n),
      originalPath: null,          // 原路径未知：恢复时放回桌面并自动去重
      storedName: n,
      storedPath: full,
      ext,
      eatenAt: st.mtimeMs,
      status: 'stored',
      desktopPos: null,
      restoredAt: null,
      recovered: true,             // 标记：由仓库兜底重建
    });
  }
  return out;
}

function loadIconState() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
    iconSettings = Object.assign({}, DEFAULT_ICON_SETTINGS, raw || {});
  } catch (e) { iconSettings = Object.assign({}, DEFAULT_ICON_SETTINGS); }
  let parsed = [];
  try {
    const m = JSON.parse(fs.readFileSync(manifestFilePath(), 'utf8'));
    parsed = Array.isArray(m) ? m : [];
  } catch (e) { parsed = []; }
  iconManifest = parsed;
  recoverCorruptManifest();     // 损坏则留档并从仓库重建
  if (!iconManifest.length) {
    const recovered = rebuildFromBelly();
    if (recovered.length) { iconManifest = recovered; saveIconManifest(); }
  }
  reconcileManifest();
}

// 清单损坏 → 不删除任何快捷方式：损坏文件改名留档，并从仓库现有文件重建记录
function recoverCorruptManifest() {
  const file = manifestFilePath();
  if (!fs.existsSync(file)) return false;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return false; // 未损坏
  } catch (e) { /* 损坏 */ }
  try { fs.renameSync(file, path.join(bellyDir(), `manifest.corrupt-${Date.now()}.json`)); } catch (e) { /* ignore */ }
  const rebuilt = rebuildFromBelly();
  iconManifest = rebuilt;
  saveIconManifest();
  return true;
}

// 异常中断自愈：status=moving 的条目按实际文件位置判定
function reconcileManifest() {
  recoverCorruptManifest(); // 任何时候发现清单损坏都先自愈（不丢快捷方式）
  let changed = false;
  const belly = bellyDir();
  for (const e of iconManifest) {
    if (!e || !e.storedName) continue;
    const storedPath = path.join(belly, e.storedName);
    const stored = fs.existsSync(storedPath);
    const orig = e.originalPath ? fs.existsSync(e.originalPath) : false;
    if (e.status === 'moving') {
      e.status = stored ? 'stored' : (orig ? 'restored' : 'missing');
      changed = true;
    } else if (e.status === 'stored' && !stored && orig) {
      e.status = 'restored'; // 用户自己挪回了
      changed = true;
    }
  }
  if (changed) saveIconManifest();
}

function uniqueNameIn(dir, wantedName) {
  const ext = path.extname(wantedName);
  const base = path.basename(wantedName, ext);
  let name = wantedName;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base} (${i})${ext}`;
    i++;
    if (i > 999) break;
  }
  return name;
}

function isBlockedName(name) {
  if (BLOCK_NAME_RE.test(name)) return true;
  return (iconSettings.neverEat || []).some((n) => n && name.toLowerCase() === String(n).toLowerCase());
}

// 只扫描 .lnk / .url 文件；文件夹与其它真实文件全部忽略
function scanDesktop() {
  const dir = desktopDir();
  if (!dir || !fs.existsSync(dir)) return { ok: false, reason: 'desktop-not-found', dir, entries: [] };
  const entries = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { ok: false, reason: 'read-fail', dir, entries: [] }; }
  for (const d of names) {
    if (!d.isFile()) continue;                       // 文件夹一律跳过
    const ext = path.extname(d.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;             // 非快捷方式一律跳过
    if (isBlockedName(d.name)) continue;             // 自身快捷方式 / 永远不吃
    const full = path.join(dir, d.name);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    entries.push({
      id: randomUUID(),
      name: d.name,
      path: full,
      ext,
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { ok: true, dir, entries };
}

async function iconDataUrl(filePath) {
  try {
    const img = await app.getFileIcon(filePath, { size: 'normal' });
    if (!img || img.isEmpty()) return null;
    return img.toDataURL();
  } catch (e) { return null; }
}

// 挑食评分：偏好 + 最近同类 + 饥饿 + 随机心情（分数 <35 → 嫌弃离开）
function appetiteScore(entry, hunger) {
  let score = 60;
  const pref = (iconSettings.preferences || {})[entry.name] || (iconSettings.preferences || {})[entry.ext];
  if (pref === 'like') score += 30;
  if (pref === 'dislike') score -= 45;
  const last = iconManifest
    .filter((e) => e && e.ext === entry.ext && e.eatenAt)
    .sort((a, b) => b.eatenAt - a.eatenAt)[0];
  if (last && Date.now() - last.eatenAt < 10 * 60 * 1000) score -= 25; // 最近吃过同类
  if (Number.isFinite(hunger)) score += (hunger - 50) * 0.4;           // 越饿越想吃
  score += Math.round((Math.random() - 0.5) * 30);                     // 随机心情
  return Math.max(0, Math.min(100, Math.round(score)));
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function eatBlockReason(entry, hunger) {
  if (iconSettings.scanOnly) return 'scanOnly';
  if (!entry || !entry.path) return 'bad-entry';
  const ext = path.extname(entry.path).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return 'not-shortcut';
  if (isBlockedName(path.basename(entry.path))) return 'blocked';
  const dir = desktopDir();
  if (!dir || path.dirname(path.resolve(entry.path)) !== path.resolve(dir)) return 'not-on-desktop';
  if (!fs.existsSync(entry.path)) return 'missing';
  if (iconSettings.eatenDay !== todayKey()) { iconSettings.eatenDay = todayKey(); iconSettings.eatenToday = 0; saveIconSettings(); }
  if (iconSettings.eatenToday >= iconSettings.dailyLimit) return 'daily-limit';
  if (Date.now() - iconSettings.lastEatAt < iconSettings.cooldownMs) return 'cooldown';
  if (appetiteScore(entry, hunger) < 35) return 'not-hungry';
  return null;
}

// 真正“吃掉”：先原子写清单，再移动（EXDEV 时复制+删除源）
function eatIcon(entry, hunger) {
  const reason = eatBlockReason(entry, hunger);
  if (reason) return { ok: false, reason };
  const belly = bellyDir();
  const storedName = uniqueNameIn(belly, entry.name); // 有同名不覆盖
  const storedPath = path.join(belly, storedName);
  const rec = {
    id: randomUUID(),
    name: entry.name,
    originalName: entry.name,
    originalPath: entry.path,
    storedName,
    storedPath,
    ext: path.extname(entry.name).toLowerCase(),
    eatenAt: Date.now(),
    status: 'moving',   // 先落盘，异常中断可自愈
    desktopPos: null,   // 稳定的 Shell 接口不提供图标坐标 → 留空
    restoredAt: null,
  };
  iconManifest.push(rec);
  saveIconManifest();    // 原子化保存清单（移动之前）
  try {
    try {
      fs.renameSync(entry.path, storedPath);
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        fs.copyFileSync(entry.path, storedPath);
        fs.unlinkSync(entry.path);
      } else { throw e; }
    }
    rec.status = 'stored';
    iconSettings.lastEatAt = Date.now();
    iconSettings.eatenToday = (iconSettings.eatenToday || 0) + 1;
    iconSettings.eatenDay = todayKey();
    saveIconManifest();
    saveIconSettings();
    return { ok: true, record: rec };
  } catch (e) {
    rec.status = fs.existsSync(storedPath) ? 'stored' : 'missing';
    if (rec.status === 'stored') { rec.storedOnly = true; }
    saveIconManifest();
    return { ok: false, reason: 'move-failed', error: String(e && e.message || e), record: rec };
  }
}

// 恢复：回到原桌面路径；同名冲突自动改名，绝不覆盖
function restoreIcon(id) {
  const rec = iconManifest.find((e) => e && e.id === id);
  if (!rec) return { ok: false, reason: 'not-found' };
  const belly = bellyDir();
  const storedPath = path.join(belly, rec.storedName);
  if (!fs.existsSync(storedPath)) { rec.status = 'missing'; saveIconManifest(); return { ok: false, reason: 'seed-missing' }; }
  const dir = desktopDir();
  if (!dir) return { ok: false, reason: 'desktop-not-found' };
  let target = rec.originalPath && path.dirname(path.resolve(rec.originalPath)) === path.resolve(dir)
    ? rec.originalPath
    : path.join(dir, rec.originalName || rec.name);
  if (fs.existsSync(target)) target = path.join(dir, uniqueNameIn(dir, path.basename(target))); // 不覆盖
  try {
    try {
      fs.renameSync(storedPath, target);
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        fs.copyFileSync(storedPath, target);
        fs.unlinkSync(storedPath);
      } else { throw e; }
    }
    rec.status = 'restored';
    rec.restoredAt = Date.now();
    rec.restoredPath = target;
    saveIconManifest();
    return { ok: true, record: rec, restoredTo: target };
  } catch (e) {
    return { ok: false, reason: 'restore-failed', error: String(e && e.message || e) };
  }
}

function restoreAllIcons() {
  reconcileManifest();
  const out = [];
  for (const rec of iconManifest) {
    if (rec && (rec.status === 'stored' || rec.status === 'planting')) out.push(restoreIcon(rec.id));
  }
  return { ok: true, results: out, restored: out.filter((r) => r.ok).length };
}

function plantIcon(id) {
  const rec = iconManifest.find((e) => e && e.id === id);
  if (!rec) return { ok: false, reason: 'not-found' };
  if (rec.status !== 'stored') return { ok: false, reason: 'not-stored' };
  rec.status = 'planting';
  rec.plantedAt = Date.now();
  saveIconManifest();
  return { ok: true, record: rec };
}

function storedList() {
  reconcileManifest();
  const belly = bellyDir();
  return iconManifest
    .filter((e) => e && (e.status === 'stored' || e.status === 'planting' || e.status === 'moving'))
    .map((e) => ({
      id: e.id, name: e.name, ext: e.ext, status: e.status,
      eatenAt: e.eatenAt, plantedAt: e.plantedAt || null,
      originalPath: e.originalPath,
      existsInBelly: fs.existsSync(path.join(belly, e.storedName)),
    }));
}

function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return panelWin; }
  panelWin = new BrowserWindow({
    width: 460, height: 620,
    title: '小猪 Clawd · 图标仓库与种植',
    backgroundColor: '#1f2430',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  panelWin.setMenu(null);
  panelWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panelWin.webContents.on('will-navigate', (e) => e.preventDefault());
  panelWin.on('closed', () => { panelWin = null; });
  panelWin.loadURL('app://pet/panel.html');
  return panelWin;
}

ipcMain.handle('icons:state', () => {
  reconcileManifest();
  return { settings: iconSettings, desktop: desktopDir(), belly: bellyDir(), stored: storedList() };
});
ipcMain.handle('icons:scan', () => scanDesktop());
ipcMain.handle('icons:iconOf', async (event, filePath) => {
  if (typeof filePath !== 'string') return null;
  const dir = desktopDir();
  const belly = bellyDir();
  const resolved = path.resolve(filePath);
  const allowed = (dir && resolved.startsWith(path.resolve(dir) + path.sep)) ||
                  resolved.startsWith(path.resolve(belly) + path.sep);
  if (!allowed) return null; // 只允许桌面或仓库内的文件
  return iconDataUrl(resolved);
});
// 面板“模拟吃（预览）”：把候选路径交给宠物窗口播放动画（不移动文件）
ipcMain.handle('icons:preview', (event, payload) => {
  const p = payload || {};
  if (typeof p.path !== 'string') return false;
  const dir = desktopDir();
  const belly = bellyDir();
  const resolved = path.resolve(p.path);
  const allowed = (dir && resolved.startsWith(path.resolve(dir) + path.sep)) ||
                  resolved.startsWith(path.resolve(belly) + path.sep);
  if (!allowed) return false;
  const row = Number.isFinite(p.row) ? Math.max(0, Math.min(2, Math.round(p.row))) : 0;
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('icons:pet-command', { type: 'preview', path: resolved, row }); } catch (e) { /* ignore */ }
  }
  return true;
});
ipcMain.handle('icons:evaluate', (event, payload) => {  const p = payload || {};
  const dir = desktopDir();
  if (!dir || typeof p.path !== 'string' || path.dirname(path.resolve(p.path)) !== path.resolve(dir)) {
    return { ok: false, reason: 'not-on-desktop' };
  }
  const entry = { name: path.basename(p.path), path: path.resolve(p.path), ext: path.extname(p.path).toLowerCase() };
  const blocked = eatBlockReason(entry, p.hunger);
  return { ok: !blocked, reason: blocked || null, score: appetiteScore(entry, p.hunger), entry };
});
ipcMain.handle('icons:eat', (event, payload) => {
  const p = payload || {};
  const entry = { name: p.name, path: p.path, ext: path.extname(String(p.path || '')).toLowerCase() };
  return eatIcon(entry, p.hunger);
});
ipcMain.handle('icons:stored', () => storedList());
ipcMain.handle('icons:plant', (event, id) => plantIcon(id));
ipcMain.handle('icons:harvest', (event, id) => restoreIcon(id));
// 面板点“种下” → 先标记 planting，再让宠物窗口播放第3行种植动画
ipcMain.handle('icons:plantAnimate', (event, id) => {
  const r = plantIcon(id);
  if (r && r.ok && win && !win.isDestroyed()) {
    try { win.webContents.send('icons:pet-command', { type: 'plant', id }); } catch (e) { /* ignore */ }
  }
  return r;
});
ipcMain.handle('icons:restoreAll', () => restoreAllIcons());
ipcMain.handle('icons:openPanel', () => { createPanelWindow(); return true; });
ipcMain.handle('icons:setSettings', (event, patch) => {
  if (patch && typeof patch === 'object') {
    if (typeof patch.scanOnly === 'boolean' && iconSettings.scanOnly !== patch.scanOnly) {
      iconSettings.scanOnly = patch.scanOnly; // 真实移动开关（默认保持 true）
    }
    if (Number.isFinite(patch.dailyLimit)) iconSettings.dailyLimit = Math.max(0, Math.min(20, Math.round(patch.dailyLimit)));
    if (Number.isFinite(patch.cooldownMs)) iconSettings.cooldownMs = Math.max(0, Math.min(3600000, Math.round(patch.cooldownMs)));
    if (Array.isArray(patch.neverEat)) iconSettings.neverEat = patch.neverEat.filter((x) => typeof x === 'string').slice(0, 200);
    if (patch.preferences && typeof patch.preferences === 'object') {
      const pref = {};
      for (const [k, v] of Object.entries(patch.preferences)) {
        if (typeof k === 'string' && (v === 'like' || v === 'dislike')) pref[k] = v;
      }
      iconSettings.preferences = pref;
    }
    saveIconSettings();
  }
  return iconSettings;
});

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  // 只允许从 renderer 目录提供静态资源，杜绝路径穿越
  // 用 fs.readFileSync 读取（asar 打包后 net.fetch(file://) 读不到 asar 内文件）
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
  };
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const abs = path.normalize(path.join(RENDERER_DIR, rel));
      if (abs !== RENDERER_DIR && !abs.startsWith(RENDERER_DIR + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        return new Response('not found', { status: 404 });
      }
      const buf = fs.readFileSync(abs); // asar 内文件同样可读
      const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      return new Response(buf, { status: 200, headers: { 'content-type': type } });
    } catch {
      return new Response('error', { status: 500 });
    }
  });

  loadIconState(); // 读取设置与清单；异常中断的 moving 条目在此自愈
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 退出前再落盘一次清单（未完成的 moving 会在下次启动自愈；也可随时“立即恢复全部”）
app.on('before-quit', () => {
  try { reconcileManifest(); saveIconManifest(); saveIconSettings(); } catch (e) { /* ignore */ }
});

app.on('window-all-closed', () => {
  app.quit(); // 桌面宠物：任意窗口关闭即退出
});
