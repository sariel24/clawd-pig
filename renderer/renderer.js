(function () {
  'use strict';

  /* =========================================================================
   * 小猪 Clawd —— 渲染进程（v3：动作表现力 + 场景道具）
   *
   * 设计要点：
   *  - 尺寸预设：小96 / 标准128 / 大160（猪的最长边目标），默认小 ≈96~112 显示。
   *  - 像素清晰：imageSmoothingEnabled=false，最近邻缩放，不做模糊放大。
   *  - 动作 = 四阶段（预备→主→结果停留→收尾），由姿态(位移/旋转/缩放)+
   *    道具动画+气泡共同表达；若精灵图有对应动作帧则优先播放帧。
   *  - 场景道具为绘制型（非二进制素材），尺寸按小猪高度 45%~100% 设计。
   * ========================================================================= */

  const pet = window.petAPI;
  if (!pet) {
    document.getElementById('fatal').textContent = '错误：未检测到 petAPI（preload 未生效）';
    document.getElementById('fatal').hidden = false;
    return;
  }

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
  ctx.imageSmoothingEnabled = false; // 必须：禁止平滑插值
  const bubbleEl = document.getElementById('bubble');
  const fatalEl = document.getElementById('fatal');
  const debugEl = document.getElementById('debug');

  function fatal(msg) {
    fatalEl.textContent = String(msg);
    fatalEl.hidden = false;
  }

  const STORE_KEY = 'clawdPetStateV1';

  const CFG = {
    alphaHit: 40,
    padDest: 8,
    gapDest: 6,
    walkTickMs: 110,
    walkStepPx: 3, // 移动单步上限（缺少会令坐标计算产生 NaN）
    fps: { idle: 6, 'running-right': 10, 'running-left': 10, jumping: 12, waiting: 8, failed: 9 },
  };
  const SIZE_PRESETS = { small: 96, standard: 128, large: 160 };

  /* ================= 新素材精灵图接入（4列×4行，从左到右，约6fps/160ms） =================
   * core 行: idle / walking / happy_wave / expressions(表情)
   * actions 行: planting / watering / painting / watching_phone
   * 只用 drawImage 九参数整格裁切原图，绝不程序拼装身体/五官。
   */
  const SPR_ROW = { idle: 0, walking: 1, happy_wave: 2, expressions: 3 };
  const SPR_AROW = { planting: 0, watering: 1, painting: 2, watching_phone: 3 };
  // 旧 core 第3行的四种表情（新表情表缺失时回退）
  const SPR_EXPR = { happy: 0, shy: 1, sad: 2, surprised: 3 };
  // GPT 表情表 16 格顺序（用户已确认）：每行4格
  const EXPR_ORDER = [
    'neutral', 'happy', 'laugh', 'shy',
    'angry', 'pout', 'cry', 'surprised',
    'tired', 'sleepy', 'bored', 'focused',
    'proud', 'comfort', 'hurt', 'neutral',
  ];
  const EXPR_IDX = {
    neutral: 0, happy: 1, laugh: 2, shy: 3,
    angry: 4, pout: 5, sad: 5, cry: 6,
    surprised: 7, surprise: 7, tired: 8, sleepy: 9,
    bored: 10, focused: 11, proud: 12, comfort: 13, hurt: 14,
  };
  const SPR_ACTION_MAP = { planting: 'planting', watering: 'watering', drawing: 'painting', watching: 'watching_phone' };
  const SPR_FRAME_MS = 160; // ≈6fps

  let sprCoreImg = null;      // Image（待机/走路/挥手）
  let sprActionsImg = null;   // Image（动作行）
  let sprCoreCanvas = null;
  let sprActionsCanvas = null;
  let sprExprImg = null;      // GPT 表情表（4×4，16格）
  let sprExprCanvas = null;
  let sprExprReady = false;
  let sprFrameW = 0;          // naturalWidth/4（禁止写死）
  let sprFrameH = 0;          // naturalHeight/4
  let spritesReady = false;

  // 显示上下文（单一动画状态机，仅由 rAF 内的一个时钟推进）
  let dKind = 'core';          // core | action | expr
  let dCoreRow = 'idle';
  let dActionRow = null;
  let dExprKey = null;
  let dExprUntil = 0;
  let dCol = 0;
  let dLoops = -1;             // -1 无限循环
  let sprAccMs = 0;
  let sprSeq = null;           // 测试序列（同一时刻只有一个计时器）
  let sprSeqToken = 0;

  function cancelSprSeq() {
    if (sprSeq) { clearTimeout(sprSeq.timer); sprSeq = null; }
    sprSeqToken++;
  }

  // 回到基础状态：动作精灵优先，否则 idle/walking
  function sprBase() {
    cancelSprSeq();
    if (!spritesReady) return;
    if (currentAction) {
      const row = SPR_ACTION_MAP[currentAction.id];
      if (row) { dKind = 'action'; dActionRow = row; dExprKey = null; dCol = 0; dLoops = -1; return; }
    }
    dKind = 'core';
    dCoreRow = (walking && !currentAction) ? 'walking' : 'idle';
    dActionRow = null;
    dExprKey = null;
    dCol = 0;
    dLoops = -1;
  }

  function sprSetCore(rowName) {
    dKind = 'core';
    dCoreRow = rowName;
    dActionRow = null;
    dExprKey = null;
    dCol = 0;
    dLoops = rowName === 'happy_wave' ? 2 : -1; // 一次性挥动至少两轮后回待机
  }

  function sprSetAction(rowName) {
    dKind = 'action';
    dActionRow = rowName;
    dExprKey = null;
    dCol = 0;
    dLoops = -1;
  }

  function sprSetExpr(key, ms) {
    if (!spritesReady || !EXPR_IDX[key]) return;
    if (currentAction && SPR_ACTION_MAP[currentAction.id]) return; // 动作行优先
    if (dKind === 'icon' && dIconLoopsLeft > 0) return;            // 吃/种植仪式优先，不被情绪打断
    dKind = 'expr';
    dExprKey = key;
    dExprUntil = Date.now() + ms;
    dCol = 0;
    dLoops = 0;
  }

  // 表情来源：优先 GPT 16格表情表，缺失时回退 core 第3行四种
  function exprFrameRC(key) {
    const idx = EXPR_IDX[key] !== undefined ? EXPR_IDX[key] : 0;
    if (sprExprReady && sprExprCanvas) {
      return { row: Math.floor(idx / 4), col: idx % 4 };
    }
    return { row: SPR_ROW.expressions, col: SPR_EXPR[key] || 0 };
  }
  function exprCanvas() {
    return (sprExprReady && sprExprCanvas) ? sprExprCanvas : sprCoreCanvas;
  }

  /* ---------- 吃图标 / 种植精灵表（2048×768，8列×3行，每格256×256，固定网格） ---------- */
  const ICON_COLS = 8;
  const ICON_ROWS = 3;
  let sprIconImg = null;
  let sprIconCanvas = null;
  let sprIconReady = false;
  let dIconRow = 0;
  let dIconCol = 0;
  let dIconLoopsLeft = 0;
  let overlayIconImg = null;          // 运行时要覆盖的真实快捷方式图标
  const placeholderCache = new Map();

  function iconCell() {
    if (!sprIconCanvas) return { w: 256, h: 256 };
    return { w: Math.floor(sprIconCanvas.width / ICON_COLS), h: Math.floor(sprIconCanvas.height / ICON_ROWS) };
  }

  // 在帧内探测“蓝色通用快捷方式占位符”位置（运行时检测；失败则不加覆盖，保留占位符）
  function iconPlaceholderBox(row, col) {
    if (!sprIconReady || !sprIconCanvas) return null;
    const key = row + ':' + col;
    if (placeholderCache.has(key)) return placeholderCache.get(key);
    const cell = iconCell();
    let box = null;
    try {
      const data = sprIconCanvas.getContext('2d', { willReadFrequently: true })
        .getImageData(col * cell.w, row * cell.h, cell.w, cell.h).data;
      let minX = cell.w, minY = cell.h, maxX = -1, maxY = -1;
      for (let y = 0; y < cell.h; y++) {
        const rb = y * cell.w * 4;
        for (let x = 0; x < cell.w; x++) {
          const i = rb + x * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a > 30 && b > 140 && b - r > 35 && b - g > 20) { // 蓝色系占位符
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (bw > 6 && bh > 6 && bw < cell.w * 0.75 && bh < cell.h * 0.75 && bw * bh > 120) {
        box = { x: minX, y: minY, w: bw, h: bh };
      }
    } catch (e) { box = null; }
    placeholderCache.set(key, box);
    return box;
  }

  function canStartIconRitual() {
    return spritesReady && !currentAction && !dragging && !reactionBusy()
      && mvState === 'idle' && !(sprSeq && sprSeq.timer);
  }

  // 播放吃/嫌弃/种植的一整行（每行8帧，播完自动回 idle 第1帧）
  function playIconGroup(row, opts) {
    if (!sprIconReady) { speak('吃图标素材还没加载好', 1600); return false; }
    if (!canStartIconRitual()) { speak('等小猪忙完这一段再吃～', 1500); return false; }
    pauseAutoForUser();
    cancelSprSeq();
    dKind = 'icon';
    dIconRow = row;
    dIconCol = 0;
    dIconLoopsLeft = (opts && opts.loops) || 1;
    overlayIconImg = (opts && opts.iconImg) || null;
    return true;
  }

  function finishIconRitual() {
    overlayIconImg = null;
    sprBase();
  }

  function hungerNow() {
    return Math.max(0, Math.min(100, Math.round(100 - moodVal.energy)));
  }

  // 是否允许连续推进动作帧：
  // 只有 ①窗口真的在移动(walking) ②正在执行动作 ③happy_wave/测试等明确动画才推进；
  // idle / paused / reaction 等待期间一律停在第 1 帧（col 0），四腿静止。
  function framesShouldRun() {
    if (dKind === 'expr') return false;              // 表情是定格帧
    if (currentAction) return true;                  // 动作行(种花/浇水/…)
    if (sprSeq && sprSeq.timer) return true;         // “测试新素材”演示
    if (dKind === 'core' && dCoreRow === 'happy_wave' && dLoops > 0) return true; // 挥手两轮
    if (dKind === 'core' && dCoreRow === 'walking') {
      return !!(walking && mvState === 'moving');    // 只有 BrowserWindow 真在移动才走帧
    }
    if (dKind === 'icon') return dIconLoopsLeft > 0; // 吃/嫌弃/种植表演中
    return false;
  }

  function sprTick(nowMs) {
    if (dKind === 'expr') {
      if (nowMs >= dExprUntil) sprBase(); // 表情停留1~2秒后回基础
      return;
    }
    if (!framesShouldRun()) {
      // idle / paused / 等待：锁定 core 第1行第1帧，绝不循环、不累加帧号
      if (dKind === 'core') dCol = 0;
      return;
    }
    if (dKind === 'icon') {
      dIconCol++;
      if (dIconCol >= ICON_COLS) {
        dIconCol = 0;
        dIconLoopsLeft--;
        if (dIconLoopsLeft <= 0) finishIconRitual();
      }
      return;
    }
    dCol++;
    if (dCol >= 4) {
      dCol = 0;
      if (dLoops > 0) {
        dLoops--;
        if (dLoops === 0) sprBase();
      }
    }
  }

  // 当前要播放的帧（每张图按各自自然网格裁切，绝不写死单张尺寸）
  function sprFrame() {
    let src;
    let row = SPR_ROW.idle;
    let col = 0;
    let cw = 0, ch = 0;
    if (dKind === 'expr') {
      src = exprCanvas();
      const rc = exprFrameRC(dExprKey || 'neutral');
      row = rc.row;
      col = rc.col;
      cw = Math.round(src.width / 4);
      ch = Math.round(src.height / 4);
    } else if (dKind === 'icon') {
      src = sprIconCanvas;
      row = dIconRow;
      col = dIconCol;
      const cell = iconCell();
      cw = cell.w;
      ch = cell.h;
    } else {
      src = dKind === 'action' ? sprActionsCanvas : sprCoreCanvas;
      if (dKind === 'action') { row = SPR_AROW[dActionRow]; col = dCol; }
      else { row = SPR_ROW[dCoreRow] || 0; col = dCol; }
      cw = Math.round(src.width / 4);
      ch = Math.round(src.height / 4);
    }
    return { x: col * cw, y: row * ch, w: cw, h: ch };
  }

  /* “测试新素材”调度：同一时刻仅一个计时器 */
  function runSpriteTest(item) {
    if (!spritesReady) { speak('精灵图尚未加载完成，请稍后', 1800); return; }
    stopWalking();
    interruptAction(false);
    cancelSprSeq();
    const token = ++sprSeqToken;

    let steps = null;
    const core = (row, ms) => ({ t: 'core', row, ms });
    const act = (row, ms) => ({ t: 'action', row, ms });
    const ex = (key, ms) => ({ t: 'expr', key, ms });
    if (item === 'all') {
      steps = [
        core('idle', 1300), core('walking', 1300), core('happy_wave', 1400),
        ex('happy', 1200), ex('shy', 1200), ex('surprised', 1200),
        act('planting', 1300), act('watering', 1300), act('painting', 1300), act('watching_phone', 1300),
      ];
    } else if (item === 'expressions') {
      // 测试表情（含哭哭）：开心/大笑/害羞/生气/委屈/哭泣/惊讶/被摸舒服
      steps = [
        ex('happy', 1200), ex('laugh', 1200), ex('shy', 1200), ex('angry', 1200),
        ex('pout', 1200), ex('cry', 1300), ex('surprised', 1200), ex('comfort', 1200),
      ];
    } else if (item === 'idle' || item === 'walk' || item === 'happy') {
      const map = { idle: 'idle', walk: 'walking', happy: 'happy_wave' };
      steps = [core(map[item], 1400)];
    } else if (item === 'plant' || item === 'water' || item === 'paint' || item === 'phone') {
      const map = { plant: 'planting', water: 'watering', paint: 'painting', phone: 'watching_phone' };
      steps = [act(map[item], 1400)];
    }
    if (!steps) return;

    const applyStep = (s) => {
      if (s.t === 'core') sprSetCore(s.row);
      else if (s.t === 'action') sprSetAction(s.row);
      else sprSetExpr(s.key, s.ms);
    };
    const run = (i) => {
      if (token !== sprSeqToken) return;
      if (i >= steps.length) {
        sprSeq = null;
        sprBase(); // 测试结束回到待机
        return;
      }
      applyStep(steps[i]);
      sprSeq = { timer: setTimeout(() => run(i + 1), steps[i].ms) };
    };
    sprSeq = { timer: 0 };
    run(0);
  }

  /* ================= 缓动函数 ================= */
  const E = {
    lin: (t) => t,
    inCubic: (t) => t * t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outQuad: (t) => 1 - (1 - t) * (1 - t),
  };

  /* ================= 动作定义 =================
   * 每个动作四阶段时长（秒）：prep 预备 / main 主动作 / hold 结果停留 / end 收尾
   * sprite：未来精灵图有对应行时填 state 名，会自动优先播放帧动画。
   * texts：主动作台词（轮流）；finish：结果停留时说。
   * fx：场景类型；数值在动作自然完成后结算。
   */
  const ACTION_SPRITES = {
    sleeping: null, working: null, drawing: null,
    planting: null, watering: null, picking: null, gifting: null, watching: null,
  };
  const ACT = {
    sleeping: { label: '睡觉', prep: 0.35, main: 5.0, hold: 1.1, end: 0.6, fps: 2, fx: 'sleep', texts: ['好困呀……', '呼……呼……', 'Zzz…'], energy: 30, finish: '睡饱啦！' },
    working:  { label: '工作', prep: 0.30, main: 2.2, hold: 0.8, end: 0.5, fps: 8, fx: 'work', texts: ['敲代码中……', '认真工作！'], energy: -10, happiness: -3, finish: '做完啦，休息一下～' },
    drawing:  { label: '画画', prep: 0.30, main: 2.4, hold: 0.8, end: 0.5, fps: 8, fx: 'draw', texts: ['画点什么好呢…', '画朵小花送给你！'], energy: -4, happiness: 4, finish: '画好啦！' },
    planting: { label: '种花', prep: 0.35, main: 2.0, hold: 0.7, end: 0.45, fps: 8, fx: 'plant', texts: ['挖个小坑……', '埋下种子！'], energy: -3, happiness: 3, finish: '种好啦～' },
    watering: { label: '浇水', prep: 0.30, main: 2.2, hold: 0.8, end: 0.5, fps: 8, fx: 'water', texts: ['浇浇水～', '快长大吧！'], energy: -3, happiness: 2, finish: '' },
    picking:  { label: '摘花', prep: 0.40, main: 2.0, hold: 0.8, end: 0.5, fps: 9, fx: 'pick', texts: ['轻轻摘下来……'], energy: -2, happiness: 4, finish: '' },
    gifting:  { label: '送花', prep: 0.30, main: 2.2, hold: 1.0, end: 0.6, fps: 9, fx: 'gift', texts: ['送给你！'], energy: -2, happiness: 4, affection: 12, finish: '要一直喜欢我哦～' },
    watching: { label: '刷视频', prep: 0.35, main: 2.6, hold: 0.9, end: 0.6, fps: 8, fx: 'watch', texts: ['哈哈好好笑', '再看一个！'], energy: -3, happiness: 3, finish: '' },
  };
  const ACTION_IDS = Object.keys(ACT);

  /* 心情与点击 */
  const MOOD_LINES = {
    happy:  ['啦啦啦～', '今天心情超好！'],
    shy:    ['…害羞', '（脸红）'],
    angry:  ['哼！', '不理你了！'],
    sad:    ['呜…', '有点难过'],
    tired:  ['好困呀…'],
    bored:  ['好无聊哦…', '要不要陪我玩？'],
  };
  const REACTIONS = {
    ear:   { text: '别揪耳朵！', state: 'jumping', loops: 1 },
    nose:  { text: '哼？',       state: 'waiting', loops: 1 },
    belly: { text: '咕噜噜……',   state: 'failed',  loops: 1 },
  };
  const ZONES = [
    { id: 'ear',   x: 0.00, y: 0.00, w: 0.34, h: 0.30 },
    { id: 'ear',   x: 0.66, y: 0.00, w: 0.34, h: 0.30 },
    { id: 'nose',  x: 0.30, y: 0.20, w: 0.40, h: 0.36 },
    { id: 'belly', x: 0.20, y: 0.60, w: 0.60, h: 0.40 },
  ];
  const FLOWER_STAGES = ['seed', 'sprout', 'bud', 'bloom', 'picked'];

  /* ================= 小工具 ================= */
  const clamp100 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = dataUrl;
    });
  }

  /* ================= 持久化 ================= */
  function sanitizeSaved(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const m = s.mood || {};
    return {
      size: SIZE_PRESETS[s.size] ? s.size : 'small',
      anchor: Number.isFinite(s.anchor && s.anchor.cx) && Number.isFinite(s.anchor && s.anchor.feet)
        ? { cx: s.anchor.cx, feet: s.anchor.feet } : null,
      flower: s.flower && FLOWER_STAGES.includes(s.flower.stage)
        ? { stage: s.flower.stage, water: Math.max(0, Math.floor(s.flower.water) || 0) } : null,
      mood: { happiness: clamp100(m.happiness), energy: clamp100(m.energy), affection: clamp100(m.affection) },
    };
  }
  let saved = sanitizeSaved(null);
  function loadSaved() {
    try { const raw = JSON.parse(localStorage.getItem(STORE_KEY)); if (raw) saved = sanitizeSaved(raw); } catch (e) { /* 忽略 */ }
  }
  function persistNow() {
    saved.size = sizePreset;
    if (Number.isFinite(A.cx) && Number.isFinite(A.feet)) {
      saved.anchor = { cx: A.cx, feet: A.feet }; // 只保存有效锚点，避免污染存档
    }
    saved.flower = flower ? { stage: flower.stage, water: flower.water } : null;
    saved.mood = { happiness: moodVal.happiness, energy: moodVal.energy, affection: moodVal.affection };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) { /* 忽略 */ }
  }

  /* ================= 素材 ================= */
  let mode = 'none';      // sheet | static | none
  let srcCanvas = null;
  let union = { x: 0, y: 0, w: 1, h: 1 };
  let states = {};
  let poseBuf = null;     // 当前帧缓冲（sheet 时裁剪到 union 尺寸；static 复用 srcCanvas）

  function buildFromSheet(image, layoutJson) {
    const sheetW = layoutJson.width, sheetH = layoutJson.height;
    const cols = layoutJson.columns, rows = layoutJson.rows;
    if (!cols || !rows || sheetW <= 0 || sheetH <= 0) return false;
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = sheetW; srcCanvas.height = sheetH;
    const sctx = srcCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
    sctx.drawImage(image, 0, 0);
    const px = sctx.getImageData(0, 0, sheetW, sheetH).data;
    const cellW = Math.round(sheetW / cols), cellH = Math.round(sheetH / rows);
    function cellBBox(cx, cy) {
      const x0 = cx * cellW, y0 = cy * cellH, x1 = x0 + cellW - 1, y1 = y0 + cellH - 1;
      let minX = x1 + 1, minY = y1 + 1, maxX = x0 - 1, maxY = y0 - 1;
      for (let y = y0; y <= y1; y++) {
        const rb = y * sheetW * 4;
        for (let x = x0; x <= x1; x++) {
          if (px[rb + x * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return maxX < minX ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
    let gx = Infinity, gy = Infinity, gx2 = -1, gy2 = -1;
    for (const cell of layoutJson.cells || []) {
      if (!cell.used) continue;
      const bbox = cellBBox(cell.column, cell.row);
      if (!bbox) continue;
      const name = cell.state;
      if (!states[name]) states[name] = { frames: [] };
      states[name].frames.push(bbox);
      if (bbox.x < gx) gx = bbox.x;
      if (bbox.y < gy) gy = bbox.y;
      if (bbox.x + bbox.w - 1 > gx2) gx2 = bbox.x + bbox.w - 1;
      if (bbox.y + bbox.h - 1 > gy2) gy2 = bbox.y + bbox.h - 1;
    }
    if (Object.keys(states).length === 0) return false;
    union = { x: gx, y: gy, w: gx2 - gx + 1, h: gy2 - gy + 1 };
    poseBuf = document.createElement('canvas');
    poseBuf.width = union.w; poseBuf.height = union.h;
    mode = 'sheet';
    return true;
  }

  function buildFromReference(image) {
    const tmp = document.createElement('canvas');
    tmp.width = image.naturalWidth || image.width;
    tmp.height = image.naturalHeight || image.height;
    const tctx = tmp.getContext('2d', { alpha: true, willReadFrequently: true });
    tctx.drawImage(image, 0, 0);
    const W = tmp.width, H = tmp.height;
    const px = tctx.getImageData(0, 0, W, H).data;
    const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
    let br = 0, bg = 0, bb = 0;
    for (const [cx0, cy0] of corners) { const i = (cy0 * W + cx0) * 4; br += px[i]; bg += px[i + 1]; bb += px[i + 2]; }
    br = Math.round(br / 4); bg = Math.round(bg / 4); bb = Math.round(bb / 4);
    const tol = 26;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      const rb = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = rb + x * 4;
        if (Math.abs(px[i] - br) <= tol && Math.abs(px[i + 1] - bg) <= tol && Math.abs(px[i + 2] - bb) <= tol) px[i + 3] = 0;
        else { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
    }
    if (maxX < minX) return false;
    const pw = maxX - minX + 1, ph = maxY - minY + 1;
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = pw; srcCanvas.height = ph;
    const sctx = srcCanvas.getContext('2d', { alpha: true });
    sctx.putImageData(tctx.getImageData(minX, minY, pw, ph), 0, 0);
    union = { x: 0, y: 0, w: pw, h: ph };
    // 各状态共用同一只猪：帧数 = 动画周期长度（用轻量上下浮动代替帧）
    const cycles = { idle: 4, 'running-right': 4, 'running-left': 4, jumping: 5, waiting: 4, failed: 4 };
    for (const name of Object.keys(cycles)) {
      states[name] = { frames: Array(cycles[name]).fill({ x: 0, y: 0, w: pw, h: ph }) };
    }
    mode = 'static';
    return true;
  }

  /* ================= 布局 ================= */
  let sizePreset = 'small';
  let S = 0.25;
  let canvasW = 200, canvasH = 200;
  let pigR = { x: 0, y: 0, w: 96, h: 96 };
  let panelX = 0;      // 场景列左缘（画布坐标）
  let sceneSW = 0;     // 场景列宽（动态）
  const pigCVC = () => pigR.x + pigR.w / 2;

  const U = () => pigR.h;          // 猪显示高度（道具尺寸基准）
  const floorY = () => pigR.y + pigR.h;

  function sceneNeededWidth() {
    // 花盆持久占位 + 动作场景宽度；道具须 ≥45% 猪高
    let w = 0;
    if (flower) w = Math.max(w, Math.round(U() * 0.56) + 8);
    if (currentAction) {
      const id = currentAction.id;
      if (id === 'working') w = Math.max(w, Math.round(U() * 0.95));
      else if (id === 'drawing') w = Math.max(w, Math.round(U() * 0.85));
      else if (id === 'planting' || id === 'watering' || id === 'picking') w = Math.max(w, Math.round(U() * 0.78));
      else if (id === 'watching') w = Math.max(w, Math.round(U() * 0.62));
      else if (id === 'sleeping') w = Math.max(w, Math.round(U() * 0.55));
      // gifting 用手中花，不需要侧栏
    }
    return w;
  }

  function computeLayout() {
    if (mode === 'none') {
      canvasW = 420; canvasH = 170; S = 1;
      pigR = { x: 0, y: 0, w: 1, h: 1 };
      panelX = 0; sceneSW = 0;
      return;
    }
    const pad = CFG.padDest;
    // 新素材精灵图优先：按真实帧尺寸（naturalWidth/4）等比设定显示尺寸
    if (spritesReady && sprFrameW > 0) {
      const target = SIZE_PRESETS[sizePreset] || 96;
      const pw = Math.max(8, Math.round(target));
      const ph = Math.max(8, Math.round(pw * (sprFrameH / sprFrameW)));
      pigR = { x: pad, y: pad, w: pw, h: ph };
      panelX = pad + pw + CFG.gapDest;
      S = 1;
      return;
    }
    const target = SIZE_PRESETS[sizePreset] || 96;
    S = target / Math.max(union.w, union.h);
    const pw = Math.max(8, Math.round(union.w * S));
    const ph = Math.max(8, Math.round(union.h * S));
    pigR = { x: pad, y: pad, w: pw, h: ph };
    panelX = pad + pw + CFG.gapDest;
  }

  function refreshShape() {
    sceneSW = mode === 'none' ? 0 : sceneNeededWidth();
    if (mode === 'none') {
      canvasW = 420; canvasH = 170;
    } else {
      canvasW = panelX + sceneSW + CFG.padDest;
      canvasH = CFG.padDest + pigR.h + CFG.padDest;
    }
    canvas.width = canvasW;
    canvas.height = canvasH;
    applyWindow();
  }

  /* ================= 窗口锚点（猪底中心 A） ================= */
  let A = { cx: 120, feet: 120 };
  let winX = 120, winY = 120;
  let bubbleW = 0;
  let bubbleOpen = false;
  let bubbleTimer = 0;
  let queue = [];
  let activeSpeech = null;

  function winW() { return Math.max(canvasW, bubbleW); }
  function winH() { return canvasH + (bubbleOpen ? 44 : 0); }

  function applyWindow() {
    const W = winW();
    const H = winH();
    const canvasLeft = (W - canvasW) / 2;
    const canvasTop = bubbleOpen ? 44 : 0;
    const nx = Math.round(A.cx - canvasLeft - pigCVC());
    const ny = Math.round(A.feet - canvasTop - (pigR.y + pigR.h));
    winX = nx; winY = ny;
    canvas.style.left = Math.round(canvasLeft) + 'px';
    bubbleEl.style.left = Math.round(canvasLeft + pigCVC()) + 'px';
    pet.setBounds({ x: nx, y: ny, width: W, height: H });
  }

  async function clampIntoWorkArea() {
    const wa = await pet.getWorkArea();
    if (!wa) return;
    const canvasLeft = (winW() - canvasW) / 2;
    const canvasTop = bubbleOpen ? 44 : 0;
    const left = A.cx - canvasLeft - pigCVC();
    const top = A.feet - canvasTop - (pigR.y + pigR.h);
    let dx = 0, dy = 0;
    if (left < wa.x) dx = wa.x - left;
    if (left + winW() > wa.x + wa.width) dx = wa.x + wa.width - winW() - left;
    if (top < wa.y) dy = wa.y - top;
    if (top + winH() > wa.y + wa.height) dy = wa.y + wa.height - winH() - top;
    if (dx || dy) { A.cx += dx; A.feet += dy; applyWindow(); }
  }

  function setSizePreset(id) {
    if (!SIZE_PRESETS[id]) return;
    sizePreset = id;
    computeLayout();
    refreshShape();
    persistNow();
  }

  /* ================= 气泡 ================= */
  function speak(text, ms) { queue.push({ text: String(text), ms: ms || 1600 }); pump(); }
  function pump() {
    if (activeSpeech || !queue.length) return;
    const s = queue.shift();
    activeSpeech = s;
    showBubbleNow(s.text, s.ms, () => { activeSpeech = null; pump(); });
  }
  function clearSpeech() {
    queue = [];
    clearTimeout(bubbleTimer);
    if (bubbleOpen) {
      bubbleOpen = false;
      bubbleW = 0;
      bubbleEl.hidden = true;
      applyWindow();
    }
    activeSpeech = null;
  }
  function showBubbleNow(text, ms, done) {
    clearTimeout(bubbleTimer);
    bubbleEl.textContent = text;
    bubbleEl.hidden = false;
    bubbleOpen = true;
    bubbleW = Math.max(60, bubbleEl.offsetWidth + 14);
    applyWindow();
    bubbleTimer = setTimeout(() => {
      bubbleOpen = false;
      bubbleW = 0;
      bubbleEl.hidden = true;
      applyWindow();
      if (done) done();
    }, ms);
  }

  /* ================= 动画循环 / 状态 ================= */
  let stateName = 'idle';
  let frameIndex = 0;
  let lastTs = 0;
  let acc = 0;
  let actionReaction = null;  // 点击反应（jumping 等）
  let currentAction = null;   // { id, t0, phaseTimers:[], onDone }

  function setState(name) {
    if (!states[name]) return;
    if (name === stateName) return;
    stateName = name;
    frameIndex = 0;
    acc = 0;
  }

  function fpsOf() {
    if (currentAction && ACT[currentAction.id].fps) return ACT[currentAction.id].fps;
    const st = states[stateName];
    if (st && CFG.fps[stateName]) return CFG.fps[stateName];
    return 6;
  }

  function advanceFrame() {
    const st = states[stateName];
    if (!st || st.frames.length === 0) return;
    frameIndex++;
    if (frameIndex >= st.frames.length) {
      frameIndex = 0;
      if (actionReaction) {
        actionReaction.loopsLeft--;
        if (actionReaction.loopsLeft <= 0) {
          actionReaction = null;
          afterReaction();
        }
      }
    }
  }

  function frameLoop(ts) {
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    acc += dt;
    lastTs = ts;
    const stepMs = 1000 / fpsOf();
    while (acc >= stepMs) { acc -= stepMs; advanceFrame(); }
    // 精灵帧时钟：160ms/帧，仅此一个驱动源（无多余定时器）
    if (spritesReady) {
      sprAccMs += dt;
      const nowMs = Date.now();
      while (sprAccMs >= SPR_FRAME_MS) { sprAccMs -= SPR_FRAME_MS; sprTick(nowMs); }
    }
    draw();
    requestAnimationFrame(frameLoop);
  }

  /* ================= 四阶段动作引擎 ================= */

  function phaseInfo(action) {
    const def = ACT[action.id];
    const t = (Date.now() - action.t0) / 1000;
    const pP = def.prep, pM = def.main, pH = def.hold, pE = def.end;
    let phase = 'prep', p = clamp(t / pP, 0, 1), local = t;
    if (t > pP) { phase = 'main'; p = clamp((t - pP) / pM, 0, 1); }
    if (t > pP + pM) { phase = 'hold'; p = clamp((t - pP - pM) / pH, 0, 1); }
    if (t > pP + pM + pH) { phase = 'end'; p = clamp((t - pP - pM - pH) / pE, 0, 1); }
    return { phase, p, t, pP, pM, pH, pE, total: pP + pM + pH + pE };
  }

  function runAction(id, onDone) {
    if (mode === 'none') { speak('素材缺失，暂时无法动作', 1600); if (onDone) onDone(false); return; }
    const def = ACT[id];
    if (!def) return;

    // 花相关：先校验（含演示催熟分支），失败只提示不进入动作
    if (id === 'planting') { if (!prepPlant()) return; }
    else if (id === 'watering') { if (!prepWater()) return; }
    else if (id === 'picking') { if (!prepPick()) return; }
    else if (id === 'gifting') { if (!prepGift()) return; }

    // 打断旧动作
    if (currentAction) interruptAction(false);
    actionReaction = null;
    stopWalking(false); // 动作期间暂停自主走动（保留 walkSwitch 复位后不可自动恢复，待命）

    const act = {
      id,
      t0: Date.now(),
      phaseTimers: [],
      onDone: onDone || null,
      textIdx: 0,
      committed: false,
    };
    currentAction = act;
    refreshShape();

    // 阶段事件
    const ph = phaseInfo.bind(null, act);
    const prepMs = Math.round(def.prep * 1000);
    const mainMs = Math.round(def.main * 1000);
    const holdMs = Math.round(def.hold * 1000);
    act.phaseTimers.push(setTimeout(() => {
      if (currentAction !== act) return;
      // 主台词轮播
      const cycle = () => {
        if (currentAction !== act) return;
        if (act.textIdx < def.texts.length) {
          speak(def.texts[act.textIdx % def.texts.length], Math.min(1500, mainMs / Math.max(1, def.texts.length) + 400));
          act.textIdx++;
          const timer = setTimeout(cycle, Math.min(1500, mainMs / Math.max(1, def.texts.length) + 500));
          act.phaseTimers.push(timer);
        }
      };
      cycle();
    }, prepMs + 80));
    act.phaseTimers.push(setTimeout(() => {
      if (currentAction !== act) return;
      if (def.finish) speak(def.finish, 1700);
    }, prepMs + mainMs + 150));
    // 浇水：主动作中途推进一次生长（不可一次开花，需多次浇水）
    if (id === 'watering') {
      act.phaseTimers.push(setTimeout(() => {
        if (currentAction !== act) return;
        applyWaterGrow(act);
      }, prepMs + Math.round(mainMs * 0.55)));
    }
    act.phaseTimers.push(setTimeout(() => {
      if (currentAction !== act) return;
      commitAction(act);      // 结果结算
      finishAction(act);      // 进入收尾 & 结束
    }, prepMs + mainMs + holdMs));

    // 精灵帧优先；否则用姿态动画
    const sprite = ACTION_SPRITES[id];
    if (sprite && states[sprite]) setState(sprite);
    else setState('idle');
    // 新素材：有对应动作行的切动作行，没有的用 idle 帧表达
    if (spritesReady) {
      cancelSprSeq();
      const arow = SPR_ACTION_MAP[id];
      if (arow) sprSetAction(arow);
      else sprSetCore('idle');
    }
    persistNow();
  }

  function interruptAction(commit) {
    if (!currentAction) return;
    const act = currentAction;
    currentAction = null;
    act.phaseTimers.forEach(clearTimeout);
    if (commit && !act.committed) commitAction(act);
    if (act.onDone) { const f = act.onDone; act.onDone = null; f(false); }
    clearSpeech();
    refreshShape();
    setState(walking ? (dir === 1 ? 'running-right' : 'running-left') : 'idle');
    if (spritesReady) sprBase();
  }

  function commitAction(act) {
    if (act.committed) return;
    act.committed = true;
    const def = ACT[act.id];
    // 花动作的结果在自然结束时提交，保证场景连续性
    if (act.id === 'picking' && flower && flower.stage === 'bloom') {
      flower.stage = 'picked';   // 花到小猪手里
    } else if (act.id === 'gifting' && flower && flower.stage === 'picked') {
      flower = null;             // 花送出去了
      addMood('affection', def.affection || 0);
      addMood('happiness', def.happiness || 0);
      setMood('happy', 8000);
    }
    if (def.energy) addMood('energy', def.energy);
    if (act.id !== 'gifting' && def.happiness) addMood('happiness', def.happiness);
    if (moodVal.energy < 25) { moodName = 'tired'; moodUntil = 0; pendingMoodText = pick(MOOD_LINES.tired); }
    persistNow();
  }

  function finishAction(act) {
    if (currentAction !== act) return;
    currentAction = null;
    act.phaseTimers.forEach(clearTimeout);
    if (act.onDone) { const f = act.onDone; act.onDone = null; f(true); }
    clearSpeech();
    refreshShape();
    setState(walking ? (dir === 1 ? 'running-right' : 'running-left') : 'idle');
    if (spritesReady) sprBase();
  }

  /* ---- 花动作前置校验（返回能否开始动作） ---- */
  function prepPlant() {
    if (flower) {
      speak(flower.stage === 'picked' ? '花还拿在手里呢，先送给我吧' : '已经有花在长啦', 1800);
      return false;
    }
    flower = { stage: 'seed', water: 0 };
    persistNow();
    speak('挖个坑，把种子放进去！', 1500);
    return true;
  }
  function prepWater() {
    if (!flower) { speak('花坛还空着呢，先“种花”吧', 1800); return false; }
    if (flower.stage === 'picked') { speak('花已经摘下来啦，先送给我吧', 1800); return false; }
    if (flower.stage === 'bloom') { speak('已经开花啦，快“摘花”吧', 1800); return false; }
    return true;
  }
  function prepPick() {
    if (!flower) { speak('还没有花呢，先“种花”吧', 1800); return false; }
    if (flower.stage !== 'bloom') {
      speak(flower.stage === 'picked' ? '花已经摘下来啦' : '花还没开呢，再浇浇水吧', 1800);
      return false;
    }
    return true;
  }
  function prepGift() {
    if (!flower || flower.stage !== 'picked') {
      if (!flower) speak('手里没有花，先“种花”吧', 1800);
      else if (flower.stage === 'bloom') speak('要先“摘花”才能送人哦', 1800);
      else speak('花还没开呢，先等等吧', 1800);
      return false;
    }
    return true;
  }

  /* ---- 浇水在动作主阶段中途推进生长（每 0.55s 一级视觉），自然结束时落账 ---- */
  function applyWaterGrow(act) {
    if (!flower || act.id !== 'watering' || flower.stage === 'picked' || flower.stage === 'bloom') return;
    flower.water += 1;
    const ns = stageByWater(flower.water);
    if (ns !== flower.stage) {
      flower.stage = ns;
      if (ns === 'bloom') speak('开花啦！好漂亮～', 1800);
      else if (ns === 'bud') speak('长出花苞啦！', 1500);
      else if (ns === 'sprout') speak('发芽啦！', 1500);
    }
    persistNow();
  }
  function stageByWater(w) {
    if (w >= 9) return 'bloom';
    if (w >= 6) return 'bud';
    if (w >= 3) return 'sprout';
    return 'seed';
  }

  /* ================= 心情 ================= */
  let moodVal = { happiness: 72, energy: 72, affection: 10 };
  let moodName = 'happy';
  let moodUntil = 0;
  let lastAutoMoodAt = 0;
  let lastInteractMs = Date.now();
  let lastEnergyMs = Date.now();
  let lastDecayMs = Date.now();
  let pendingMoodText = null;
  let happyHopUntil = 0;
  let earSpamStart = 0;
  let earSpamCount = 0;
  let tearY = 0;
  let flower = null;          // { stage:'seed'..'bloom'|'picked', water:n } | null

  function addMood(key, delta) { moodVal[key] = clamp100(moodVal[key] + delta); }
  function setMood(name, durationMs) {
    if (!MOOD_LINES[name]) return;
    moodName = name;
    moodUntil = durationMs ? Date.now() + durationMs : 0;
    pendingMoodText = pick(MOOD_LINES[name]);
  }
  function angryNow() { return moodName === 'angry' && moodUntil > Date.now(); }

  function recomputeMoodAuto() {
    const nowT = Date.now();
    if (moodUntil > nowT) return;
    if (nowT - lastAutoMoodAt < 25000) return;
    lastAutoMoodAt = nowT;
    const idleLong = nowT - lastInteractMs > 150000;
    let next = 'happy';
    if (moodVal.energy < 25) next = 'tired';
    else if (moodVal.happiness <= 25) next = 'sad';
    else if (idleLong && moodVal.happiness < 65) next = 'bored';
    else if (moodVal.happiness < 45) next = 'bored';
    if (next !== moodName) {
      moodName = next;
      moodUntil = 0;
      pendingMoodText = pick(MOOD_LINES[next]);
      // 心情有对应表情帧（无动作时展示1~2秒）
      if (spritesReady && !currentAction) {
        if (next === 'shy') sprSetExpr('shy', 2000);
        else if (next === 'sad') {
          // 很难过(快乐很低)→哭哭；一般难过→委屈
          sprSetExpr(moodVal.happiness <= 15 ? 'cry' : 'pout', 2000);
        } else if (next === 'happy' && Math.random() < 0.3) {
          sprSetExpr('happy', 1500);
        } else sprBase();
      }
    }
  }

  function deliverPendingMood() {
    if (pendingMoodText && !currentAction && !activeSpeech && !queue.length) {
      const t = pendingMoodText;
      pendingMoodText = null;
      speak(t, 1800);
    }
  }

  /* ================= 姿态计算（身体语言） ================= */
  function currentPose() {
    // 返回 { ty, rot, sx, sy, shx, flip }
    const pose = { ty: 0, rot: 0, sx: 1, sy: 1, shx: 0, flip: false };
    const t = Date.now();
    if (mode === 'none') return pose;

    // 行走/待机基础浮动
    if (currentAction) {
      const act = currentAction;
      const pi = phaseInfo(act);
      const def = ACT[act.id];
      const u = U();
      // —— 预备：身体微蹲蓄力（ease-in-out）
      if (pi.phase === 'prep') {
        pose.ty += Math.round(u * 0.045 * E.inOutCubic(pi.p));
        pose.sy -= 0.025 * E.inOutCubic(pi.p);
      }
      // —— 主阶段：身体动作
      if (pi.phase === 'main') {
        const b = 0.5 - 0.5 * Math.cos(pi.t * 6); // 轻微节律
        if (act.id === 'sleeping') {
          pose.ty += Math.round(Math.sin(pi.t * 1.8) * 1.2); // 呼吸起伏
          pose.sy = 0.985 + 0.012 * Math.sin(pi.t * 1.8);
        } else if (act.id === 'working') {
          pose.ty += Math.round(Math.sin(pi.t * 3) * 0.8);
          pose.rot += Math.sin(pi.t * 2.2) * 1.2;   // 轻微左右摆动
        } else if (act.id === 'drawing') {
          pose.rot += -3 + Math.sin(pi.t * 2.5) * 0.8;  // 倾向画板
          pose.ty += Math.round(Math.sin(pi.t * 3) * 1);
        } else if (act.id === 'planting') {
          pose.ty += Math.round(u * 0.07 * Math.sin(Math.PI * Math.min(1, pi.t / 1.1))); // 蹲下
          pose.rot += 2 + Math.sin(pi.t * 4) * 1.5;
        } else if (act.id === 'watering') {
          pose.rot += 4 - Math.min(1, pi.p) * 4;    // 前倾浇水
          pose.ty += Math.round(Math.sin(pi.t * 4) * 0.8);
        } else if (act.id === 'picking') {
          pose.rot += -2 - Math.sin(pi.t * 3) * 2;  // 伸向花
          pose.ty += Math.round(Math.sin(pi.t * 3) * 1.2);
        } else if (act.id === 'gifting') {
          pose.ty += Math.round(-u * 0.06 * E.inOutCubic(pi.p)); // 起身举花
          pose.sx += 0.02 * Math.sin(pi.t * 2);
          pose.rot += Math.sin(pi.t * 2.5) * 0.6;
        } else if (act.id === 'watching') {
          pose.ty += Math.round(u * 0.055);          // 躺下一点
          pose.rot += 2.5;
          pose.sy = 0.94;
        }
        // 情绪抖动等
        if (b > 0.48 && (act.id === 'working' || act.id === 'drawing')) pose.shx = b > 0.5 ? 1 : 0;
        void b;
      }
      // —— 结果停留：保持姿态 + 微动
      if (pi.phase === 'hold') {
        if (act.id === 'gifting') {
          pose.ty += Math.round(-u * 0.05);
          if (happyHopUntil < t && pi.p > 0.1) { happyHopUntil = t + 500; }
        }
        pose.ty += Math.round(Math.sin(pi.t * 3) * 0.5);
      }
      // —— 收尾：回中立（ease-out）
      if (pi.phase === 'end') {
        const k = E.outCubic(pi.p);
        pose.ty += Math.round((0 - 0) * k);
        pose.rot *= (1 - k);
      }
      // 开心跳一下（gift / bloom）
      if (happyHopUntil > t && !pose.ty) pose.ty -= 2;
    } else {
      // 非动作：待机浮动 / 情绪
      const sFrame = states[stateName];
      if (sFrame && sFrame.frames.length > 1) {
        // 静态浮动：用帧周期
        if (mode === 'static') {
          const cycles = { idle: [0, 1, 0, 1], 'running-right': [0, 1, 0, -1], 'running-left': [0, 1, 0, -1], jumping: [0, -2, -4, -2, 0], waiting: [0, 1, 0, 1], failed: [0, 1, 1, 0] };
          const cyc = cycles[stateName] || [0];
          pose.ty += Math.round(cyc[frameIndex % cyc.length] * S);
        }
      }
      // 行走起伏与节奏（已由 walkTick 驱动 bob）
      if (walking && !actionReaction) {
        const amp = Math.max(1, Math.round(U() * 0.016));
        pose.ty += -Math.round(Math.abs(Math.sin(walkPhase)) * amp);
        pose.rot += Math.sin(walkPhase * 2) * 0.7;
      }
      // 情绪姿态
      if (!actionReaction && !walking) {
        if (moodName === 'shy') pose.rot += Math.sin(t / 400) * 2.2;
        else if (moodName === 'tired' || moodName === 'sad') { pose.sy = 0.97; pose.ty += Math.round(U() * 0.012); }
        else if (moodName === 'angry' && !angryNow()) { pose.ty += 1; }
      }
      if (happyHopUntil > t) pose.ty -= 2;
    }

    // 生气快抖
    if (angryNow() && !currentAction) {
      pose.shx = (Math.floor(t / 70) % 2 === 0 ? 1 : -1) * 2;
    }
    if (mode === 'static' && stateName === 'running-left') pose.flip = true;
    pose.ty = Math.round(pose.ty);
    return pose;
  }

  /* ================= 绘制 ================= */
  function ensurePoseBuf() {
    if (mode === 'sheet') {
      const st = states[stateName];
      if (!st || st.frames.length === 0) return false;
      const f = st.frames[frameIndex % st.frames.length];
      const bctx = poseBuf.getContext('2d', { willReadFrequently: true });
      bctx.clearRect(0, 0, poseBuf.width, poseBuf.height);
      bctx.drawImage(srcCanvas, f.x, f.y, f.w, f.h, f.x - union.x, f.y - union.y, f.w, f.h);
      return true;
    }
    // static：直接使用 srcCanvas（union 尺寸）
    return !!srcCanvas;
  }

  function drawPigPosed(pose) {
    // 新素材精灵图：整格九参数裁切
    if (spritesReady && sprCoreCanvas) {
      drawSpriteFrame(pose);
      return;
    }
    if (!ensurePoseBuf()) return;
    const imgW = Math.round(union.w * S);
    const imgH = Math.round(union.h * S);
    const cx = pigR.x + pigR.w / 2 + (pose.shx || 0);
    const feet = pigR.y + pigR.h;
    ctx.save();
    ctx.translate(Math.round(cx), Math.round(feet));
    if (pose.flip) ctx.scale(-1, 1);
    ctx.rotate((pose.rot || 0) * Math.PI / 180);
    ctx.scale(pose.sx || 1, pose.sy || 1);
    ctx.translate(0, pose.ty || 0);
    ctx.drawImage(mode === 'sheet' ? poseBuf : srcCanvas, -imgW / 2, -imgH, imgW, imgH);
    ctx.restore();
  }

  // 新素材播放：drawImage(sheet, sx,sy,sw,sh, dx,dy,dw,dh)，整格裁切、底部对齐于同一盒子
  function drawSpriteFrame(pose) {
    const src = dKind === 'icon' ? sprIconCanvas
      : dKind === 'expr' ? exprCanvas()
      : (dKind === 'action' ? sprActionsCanvas : sprCoreCanvas);
    if (!src || (dKind !== 'icon' && sprFrameW <= 0)) return;
    const f = sprFrame();
    const imgW = Math.round(pigR.w);
    const imgH = Math.round(pigR.h);
    const cx = pigR.x + pigR.w / 2 + (pose.shx || 0);
    const feet = pigR.y + pigR.h;
    ctx.save();
    ctx.translate(Math.round(cx), Math.round(feet));
    if (pose.flip) ctx.scale(-1, 1);
    ctx.rotate((pose.rot || 0) * Math.PI / 180);
    ctx.scale(pose.sx || 1, pose.sy || 1);
    ctx.translate(0, pose.ty || 0);
    ctx.drawImage(src, f.x, f.y, f.w, f.h, -imgW / 2, -imgH, imgW, imgH);

    // 运行时把“真实快捷方式图标”覆盖到蓝色占位符位置（探测失败则保留占位符，不破坏动画）
    if (dKind === 'icon' && overlayIconImg) {
      const box = iconPlaceholderBox(dIconRow, dIconCol);
      if (box) {
        const sx = imgW / f.w;
        const sy = imgH / f.h;
        const bx = -imgW / 2 + box.x * sx;
        const by = -imgH + box.y * sy;
        const bw = Math.max(1, Math.round(box.w * sx * 0.92));
        const bh = Math.max(1, Math.round(box.h * sy * 0.92));
        // 保持真实图标宽高比，居中放入占位框
        const iw = overlayIconImg.naturalWidth || overlayIconImg.width;
        const ih = overlayIconImg.naturalHeight || overlayIconImg.height;
        let dw = bw, dh = bh;
        if (iw > 0 && ih > 0) {
          const k = Math.min(bw / iw, bh / ih);
          dw = Math.max(1, Math.round(iw * k));
          dh = Math.max(1, Math.round(ih * k));
        }
        const dx = Math.round(bx + (bw - dw) / 2);
        const dy = Math.round(by + (bh - dh) / 2);
        ctx.drawImage(overlayIconImg, dx, dy, dw, dh);
      }
    }
    ctx.restore();
  }

  /* ---------- 小图形工具 ---------- */
  function r(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function hline(x, y, w, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), 1); }
  function vline(x, y, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), 1, Math.round(h)); }

  /* ================= 场景绘制（道具 ≥45% 猪高） ================= */
  // 花盆 + 植物（共用：种/浇/摘/日常显示）
  function drawPlant(cx, bottom, stage, grow) {
    const u = U();
    const potH = Math.round(u * 0.24);
    const potW = Math.round(u * 0.44);
    const bx = cx - potW / 2;
    // 花盆
    r(bx, bottom - potH, potW, potH, '#a0724f');
    r(bx - 2, bottom - potH - 2, potW + 4, 4, '#8b5a2b');
    r(bx + 2, bottom - potH + 3, potW - 4, Math.round(potH * 0.3), '#7a5136');
    const soilY = bottom - potH + 6;
    if (stage === 'seed') {
      r(cx - 2, soilY, 5, 3, '#6d4c2f');
    } else if (stage === 'sprout' || stage === 'bud') {
      const hgt = Math.round(u * (0.3 + 0.08 * (grow || 0)));
      vline(cx, bottom - potH - hgt, hgt + 1, '#3f9142');
      r(cx - 3, bottom - potH - hgt + Math.round(hgt * 0.5), 3, 3, '#3f9142');
      r(cx + 1, bottom - potH - hgt + Math.round(hgt * 0.28), 3, 3, '#3f9142');
      if (stage === 'bud') { r(cx - 2, bottom - potH - hgt - 5, 6, 6, '#a9d765'); r(cx - 1, bottom - potH - hgt - 4, 2, 2, '#cbe89a'); }
    } else if (stage === 'bloom') {
      const hgt = Math.round(u * 0.5);
      vline(cx, bottom - potH - hgt, hgt + 1, '#3f9142');
      r(cx - 4, bottom - potH - hgt + Math.round(hgt * 0.6), 4, 3, '#3f9142');
      // 花头
      const hy = bottom - potH - hgt;
      r(cx - 5, hy - 4, 4, 5, '#ff9ecb');
      r(cx + 1, hy - 4, 4, 5, '#ff9ecb');
      r(cx - 1, hy - 7, 4, 5, '#ff9ecb');
      r(cx - 1, hy - 1, 4, 5, '#ff9ecb');
      r(cx - 1, hy - 3, 3, 3, '#ffd94d');
    } else if (stage === 'picked') {
      vline(cx, bottom - potH - 4, 6, '#3f9142');
    }
  }

  // 场景主体：接收 { phase, p, t } 与 场景列/地面
  function drawScene() {
    if (!currentAction || mode === 'none') return;
    const act = currentAction;
    const def = ACT[act.id];
    const pi = phaseInfo(act);
    const u = U();
    const w = pigR.w;
    const floor = floorY();
    const sx0 = Math.max(panelX, pigR.x + pigR.w + 4); // 场景画布左缘
    const sceneCX = sx0 + Math.max(40, sceneSW) / 2 - 10;
    const growK = Math.min(1, pi.p); // 动作进度（用于画面上渐变）

    // —— 工作：桌 + 显示器 + 杯 + 打字
    if (act.id === 'working') {
      const deskY = pigR.y + Math.round(u * 0.5);
      const deskX = pigR.x + Math.round(w * 0.1);
      const deskW = Math.round(w * 1.35);
      // 桌（在小猪身前，遮住下半身）
      r(deskX, deskY, deskW, Math.round(u * 0.28), '#9a6b4f');
      hline(deskX, deskY, deskW, '#c98d5f');
      r(deskX + 8, deskY - Math.round(u * 0.46), Math.round(w * 0.66), Math.round(u * 0.46), '#2c3e50');
      r(deskX + 10, deskY - Math.round(u * 0.44), Math.round(w * 0.62), Math.round(u * 0.42), '#b7e0f7');
      // 屏幕微光/打字行
      const lines = ['#7fd3f7', '#ffd166', '#ff8fa3', '#a0e9a0', '#d8b4fe'];
      const nLine = Math.floor(pi.t * 8) % 5;
      for (let i = 0; i < 5; i++) {
        const on = i === nLine || (Math.floor(pi.t * 3) + i) % 3 === 0;
        if (on) hline(deskX + 14, deskY - Math.round(u * 0.28) + i * 4, Math.round(w * 0.4) - 8, lines[i]);
      }
      // 杯子
      const cupX = deskX + deskW - Math.round(u * 0.2);
      r(cupX, deskY - 8, 8, 10, '#f4e2c6');
      r(cupX + 1, deskY - 6, 6, 6, '#b98a5e');
      r(cupX - 2, deskY - 3, 3, 3, '#8b5a2b'); // 把手
    }
    // —— 画画：大画架 + 调色盘 + 画笔 + 渐现图案
    else if (act.id === 'drawing') {
      const frameW = Math.round(u * 0.62);
      const frameH = Math.round(u * 0.7);
      const fx = pigR.x + pigR.w - Math.round(w * 0.1);
      const fy = floor - frameH - 2;
      // 画架腿
      r(fx - 4, fy - 6, 4, 6, '#7c5a3a');
      vline(fx + frameW + 2, fy, frameH + 8, '#7c5a3a');
      hline(fx - 6, floor - 3, frameW + 14, '#7c5a3a');
      // 画布
      r(fx, fy, frameW, frameH, '#fff');
      r(fx + 2, fy + 2, frameW - 4, frameH - 4, '#fbf3df');
      // 图案渐现：先一笔太阳后一朵花
      const pDraw = Math.min(1, Math.max(0, (pi.p - 0.15) / 0.75));
      if (pDraw > 0) {
        // 简单画：茎花 + 太阳
        r(fx + frameW * 0.3, fy + frameH * 0.25, Math.round(10 * pDraw), 2, '#f6a800');
        r(fx + frameW * 0.55, fy + frameH * 0.7 - Math.round(26 * pDraw), 2, Math.round(26 * pDraw), '#3f9142');
        r(fx + frameW * 0.62, fy + frameH * 0.78, Math.round(10 * pDraw), 2, '#3f9142');
        r(fx + frameW * 0.5, fy + frameH * 0.62, Math.round(16 * pDraw), 10, '#ff8fa3');
        r(fx + frameW * 0.5, fy + frameH * 0.3, Math.round(8 * pDraw), 8, '#ffb8ce');
      }
      // 调色盘 + 画笔
      const palX = fx + frameW + 6;
      r(palX, fy + Math.round(frameH * 0.75), 14, 9, '#d8a46b');
      r(palX + 2, fy + Math.round(frameH * 0.75) + 2, 4, 3, '#e94f4f');
      r(palX + 7, fy + Math.round(frameH * 0.75) + 1, 4, 3, '#4f9ee9');
      r(palX + 11, fy + Math.round(frameH * 0.75) + 4, 3, 3, '#79c96b');
      // 画笔动画（画布前）
      const by = fy + Math.round(frameH * 0.72) - Math.round((pi.p * 18) % 8);
      r(fx + frameW * 0.52, by - 10, 2, 12, '#8d6e63');
      r(fx + frameW * 0.52, by - 13, 2, 3, '#e94f4f');
    }
    // —— 种花 / 浇水 / 摘花：共用的花盆（位置一致）
    else if (act.id === 'planting' || act.id === 'watering' || act.id === 'picking') {
      const cx = sceneCX;
      const stageNow = flower ? flower.stage : 'seed';
      if (act.id === 'planting') {
        // 铲土 + 放下种子
        const dig = Math.sin(Math.min(1, pi.t / 0.7) * Math.PI);
        r(cx - 14, floor - 16 - Math.round(dig * 8), 3, 14 + Math.round(dig * 6), '#8d6e63');
        r(cx - 16, floor - 18 - Math.round(dig * 8), 7, 3, '#a1887f');
        if (pi.p > 0.35) {
          r(cx - 2, floor - 6, 4, 3, '#5d4037'); // 种子入土
        }
        drawPlant(cx, floor, flower ? flower.stage : 'seed', growK);
      } else if (act.id === 'watering') {
        // 大喷壶 + 连续水滴
        const canX = cx - 30;
        const canH = Math.round(u * 0.5);
        const canW = Math.round(u * 0.34);
        r(canX, floor - canH, canW, canH, '#4aa8e8');
        r(canX + canW - 4, floor - canH - Math.round(u * 0.14), 9, Math.round(u * 0.14), '#4aa8e8');
        r(canX + 5, floor - canH - 7, Math.round(u * 0.2), 7, '#9fd8f5');
        // 水滴（连续）
        const dd = (pi.t * 7) % 1;
        for (let i = 0; i < 3; i++) {
          const dy = (i + dd) / 3;
          const dx = canX + canW - 2 + Math.round(dy * (cx - (canX + canW - 2)));
          r(dx, floor - Math.round(dy * 14) - 2, 2, 4, '#8fd3ff');
        }
        // 浇水 0.5 秒后植物轻长（视觉：花盆整体上移 3px 一点点长高感）
        drawPlant(cx, floor - (growK > 0.5 ? 3 : 0), flower ? flower.stage : 'seed', growK);
      } else if (act.id === 'picking') {
        const stage = (flower && flower.stage === 'bloom') ? 'bloom' : 'bloom';
        drawPlant(cx, floor, stage, 1);
        // 花从花盆移动到猪手（主阶段）
        if (pi.phase === 'main' || pi.phase === 'hold') {
          const fromX = cx;
          const fromY = floor - Math.round(u * 0.6);
          const toX = pigR.x + pigR.w - 6;
          const toY = pigR.y + Math.round(u * 0.42);
          const k = E.outCubic(clamp((pi.t - 0.3) / 1.1, 0, 1));
          if (k > 0) {
            const hx = fromX + (toX - fromX) * k;
            const hy = fromY + (toY - fromY) * k - Math.sin(k * Math.PI) * Math.round(u * 0.16);
            drawBigFlower(hx, hy, Math.round(u * 0.3));
          }
        }
      }
    }
    // —— 送花：大花 + 爱心
    else if (act.id === 'gifting') {
      const holdY = pigR.y + Math.round(u * 0.28) - Math.round(growK * 4);
      drawBigFlower(pigR.x + pigR.w - 6, holdY, Math.round(u * 0.5));
      // 爱心
      const hp = Math.floor(pi.t * 5) % 3;
      ctx.fillStyle = '#ff7aa8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const rise = (hp + i * 1.3) % 3;
        ctx.fillText('♥', pigR.x + pigR.w - 10 + i * 7, pigR.y + Math.round(u * 0.12) - Math.round(rise * 6));
      }
    }
    // —— 刷视频：大手机 + 滚动画面
    else if (act.id === 'watching') {
      const mW = Math.round(u * 0.46);
      const mH = Math.round(u * 0.64);
      const mx = pigR.x + pigR.w - Math.round(w * 0.14) - mW;
      const my = floor - mH - 4;
      r(mx - 2, my - 3, mW + 4, mH + 6, '#37474f');
      r(mx, my, mW, mH, '#fff');
      // 彩色滚动条
      const colors = ['#ff8fa3', '#7fd3f7', '#ffe66d', '#a0e9a0', '#d8b4fe'];
      const scroll = Math.floor(pi.t * 14) % mH;
      for (let i = 0; i < 6; i++) {
        const yy = my + ((scroll + i * Math.round(mH / 5)) % mH);
        r(mx + 3, yy, mW - 8, 8, colors[i % colors.length]);
        r(mx + 3, yy + 9, mW - Math.round(mW * 0.5), 4, '#eee');
      }
      // 手指滑动
      const fy = my + Math.round((pi.t * 30) % mH);
      r(mx + mW - 7, fy, 4, 7, '#f2a9a9');
    }
    // —— 睡觉：枕头/垫子 + Z
    else if (act.id === 'sleeping') {
      // 垫子
      const padW = Math.round(w * 1.1);
      r(pigR.x - 4, floor - 6, padW, 7, '#a7c7e7');
      r(pigR.x - 6, floor - 8, Math.round(w * 0.3), 5, '#d7e7f7');
      // Zzz（大小交替）
      ctx.fillStyle = '#7c8fd0';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      const zz = (pi.t * 1.6) % 3;
      for (let i = 0; i < 3; i++) {
        const rise = ((zz + i * 1.2) % 3);
        const zx = pigR.x + pigR.w * 0.55 + i * 8;
        const zy = pigR.y - 4 - Math.round(rise * 7);
        ctx.fillText(i === 2 ? 'z' : i === 1 ? 'Z' : 'Z', zx, zy);
      }
    }
  }

  // 大花（手捧）
  function drawBigFlower(cx, cy, size) {
    const s = size || Math.round(U() * 0.2);
    vline(cx, cy + s * 0.6, Math.round(s * 0.6), '#3f9142');
    ctx.fillStyle = '#ff9ecb';
    ctx.beginPath();
    ctx.arc(cx - s * 0.3, cy, s * 0.34, 0, Math.PI * 2);
    ctx.arc(cx + s * 0.3, cy, s * 0.34, 0, Math.PI * 2);
    ctx.arc(cx, cy - s * 0.35, s * 0.34, 0, Math.PI * 2);
    ctx.arc(cx, cy + s * 0.35, s * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd94d';
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---------- 常驻显示：花盆（无动作时也可见，保持连续） ---------- */
  function drawPersistentFlower() {
    if (!flower) return;
    // 种/浇/摘动作自带同一盆花的绘制，避免重复
    const sceneOwns = currentAction && ['planting', 'watering', 'picking'].includes(currentAction.id);
    if (sceneOwns) return;
    const cx = panelX + Math.max(40, sceneSW) / 2 - 10;
    drawPlant(cx, floorY(), flower.stage, 0);
  }

  /* ================= 心情表情点缀 ================= */
  function drawMoodFx() {
    const cx = pigR.x + pigR.w / 2;
    if (moodName === 'shy') {
      ctx.fillStyle = 'rgba(255,110,150,.75)';
      const chY = pigR.y + Math.round(pigR.h * 0.36);
      r(cx - pigR.w * 0.36, chY, 3, 2, 'rgba(255,110,150,.75)');
      r(cx + pigR.w * 0.36 - 3, chY, 3, 2, 'rgba(255,110,150,.75)');
    }
    if (moodName === 'sad' && moodUntil <= Date.now()) {
      tearY = (tearY + 0.03) % 5;
      r(cx + pigR.w * 0.22, pigR.y + Math.round(pigR.h * 0.18) + Math.round(tearY), 2, 3, '#7ec8ff');
    }
    if (angryNow()) {
      const ex = Math.round(cx + pigR.w * 0.3);
      const ey = pigR.y + Math.round(pigR.h * 0.1);
      r(ex - 1, ey - 5, 4, 3, '#ff5a4e');
      r(ex, ey - 2, 2, 6, '#ff5a4e');
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvasW, canvasH);
    if (mode === 'none') return;
    const pose = currentPose();
    drawPigPosed(pose);
    drawMoodFx();
    drawScene();
    drawPersistentFlower();
    if (debugOn) drawDebugOverlay();
    updateDebug();
  }

  /* ================= 点击反应（优先级：dragging > reaction > action > walking > idle） ================= */
  let reactionTimer = 0;
  let reactionUntil = 0; // 供走动调度器判断“反应中”
  function reactionBusy() { return Date.now() < reactionUntil; }

  function afterReaction() {
    if (currentAction) return;
    if (walking) setState(dir === 1 ? 'running-right' : 'running-left');
    else setState('idle');
  }

  function lightReaction(partId) {
    // 执行动作时点击：只做轻反馈，不打断场景
    if (partId === 'belly') { addMood('happiness', 1); speak('咕噜噜……', 1200); }
    else if (partId === 'nose') { addMood('affection', 1); speak('哼？', 1200); }
    else if (partId === 'ear') { speak('别揪耳朵！', 1200); }
    persistNow();
  }

  function triggerReaction(partId) {
    if (mode === 'none') return;
    touch();
    // 吃图标/种植仪式进行中：等它自然结束（本轮不打断状态机）
    if (dKind === 'icon' && dIconLoopsLeft > 0) return;
    const r = REACTIONS[partId];
    if (!r) return;

    if (currentAction) { lightReaction(partId); return; } // 动作中不打断

    // 点击命中：先暂停自主移动（保留走动开关；反应结束进 idle 等3~8s）
    pauseAutoForUser();

    // 气泡文案
    const txt = partId === 'ear' ? '嘿嘿，别挠啦～'
      : partId === 'nose' ? '阿嚏！'
      : '咕噜噜……';
    speak(txt, 1700);

    // 反应占位：完整播放约1.6秒
    clearTimeout(reactionTimer);
    reactionUntil = Date.now() + 1700;
    reactionTimer = setTimeout(() => {
      reactionUntil = 0;
      if (spritesReady) sprBase();
      if (walking && !autoBlocked()) enterIdle(); // 结束后 idle，等待3~8秒再决定
    }, 1700);

    hardReactionMood(partId); // 数值 / 心情 / 连点生气（原有逻辑）

    if (spritesReady) {
      // 新素材表情：鼻→惊讶；肚→被摸舒服；耳朵→开心挥动；连点生气→生气/哭哭
      cancelSprSeq();
      if (partId === 'nose') sprSetExpr('surprised', 1500);
      else if (partId === 'belly') sprSetExpr('comfort', 1700);
      else if (partId === 'ear' && angryNow()) {
        // 很快乐不够时连揪耳朵会委屈到哭哭，否则是生气
        sprSetExpr(moodVal.happiness <= 32 ? 'cry' : 'angry', 1700);
      } else sprSetCore('happy_wave');
    } else {
      // 旧渲染保留：沿用 jumping/waiting/failed 帧
      actionReaction = { loopsLeft: r.loops };
      setState(r.state);
    }
    persistNow();
  }

  function hardReactionMood(partId) {
    if (partId === 'belly') { addMood('happiness', 2); maybeHop(); }
    else if (partId === 'nose') { addMood('affection', 1); addMood('happiness', 1); if (Math.random() < 0.4) setMood('shy', 6000); }
    else if (partId === 'ear') {
      const nowT = Date.now();
      if (!earSpamStart || nowT - earSpamStart > 7000) { earSpamStart = nowT; earSpamCount = 1; }
      else earSpamCount++;
      if (earSpamCount >= 3) {
        earSpamStart = 0;
        addMood('happiness', -8);
        addMood('affection', -3);
        setMood('angry', 9000);
        clearSpeech();
        speak('哼！再揪耳朵就生气啦！', 2000);
      }
    }
  }

  function maybeHop() { happyHopUntil = Date.now() + 450; }

  /* ---- 点击区域：按“当前实际显示的小猪像素区域”计算（不依赖旧帧坐标） ---- */
  const contentCache = new Map();

  function contentOfCell(sheetKey, row, col) {
    const cv = sheetKey === 'actions' ? sprActionsCanvas
      : sheetKey === 'expr' ? exprCanvas()
      : sprCoreCanvas;
    if (!cv) return null;
    const key = sheetKey + ':' + row + ':' + col;
    if (contentCache.has(key)) return contentCache.get(key);
    const cw = Math.round(cv.width / 4);
    const ch = Math.round(cv.height / 4);
    const px = cv.getContext('2d', { willReadFrequently: true })
      .getImageData(col * cw, row * ch, cw, ch).data;
    let minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let y = 0; y < ch; y++) {
      const rb = y * cw * 4;
      for (let x = 0; x < cw; x++) {
        if (px[rb + x * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const rect = maxX >= minX
      ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : { x: 0, y: 0, w: cw, h: ch };
    contentCache.set(key, rect);
    return rect;
  }

  // 当前帧内容在画布中的显示矩形
  function currentContentRect() {
    if (!spritesReady) return { x: pigR.x, y: pigR.y, w: pigR.w, h: pigR.h };
    let sheetKey = 'core';
    let row = SPR_ROW[dCoreRow] !== undefined ? SPR_ROW[dCoreRow] : 0;
    let col = dCol;
    if (dKind === 'action') { sheetKey = 'actions'; row = SPR_AROW[dActionRow] || 0; }
    else if (dKind === 'expr') {
      sheetKey = 'expr';
      const rc = exprFrameRC(dExprKey || 'neutral');
      row = rc.row;
      col = rc.col;
    }
    const cv = sheetKey === 'actions' ? sprActionsCanvas
      : sheetKey === 'expr' ? exprCanvas()
      : sprCoreCanvas;
    if (!cv) return { x: pigR.x, y: pigR.y, w: pigR.w, h: pigR.h };
    const cw = Math.round(cv.width / 4);
    const cb = contentOfCell(sheetKey, row, col);
    if (!cb) return { x: pigR.x, y: pigR.y, w: pigR.w, h: pigR.h };
    const f = pigR.w / cw;
    return { x: pigR.x + cb.x * f, y: pigR.y + cb.y * f, w: cb.w * f, h: cb.h * f };
  }

  function tryReaction(px, py) {
    if (mode === 'none') return false;
    const x = Math.max(0, Math.min(canvasW - 1, Math.floor(px)));
    const y = Math.max(0, Math.min(canvasH - 1, Math.floor(py)));
    // 必须先点中可见小猪像素
    if (ctx.getImageData(x, y, 1, 1).data[3] < CFG.alphaHit) return false;
    const cr = currentContentRect();
    if (px < cr.x || px > cr.x + cr.w || py < cr.y || py > cr.y + cr.h) return false;
    const u = (px - cr.x) / cr.w;
    const v = (py - cr.y) / cr.h;
    for (const z of ZONES) {
      if (u >= z.x && u <= z.x + z.w && v >= z.y && v <= z.y + z.h) {
        triggerReaction(z.id);
        return true;
      }
    }
    return false;
  }

  /* ================= 自主移动（唯一控制器：渲染端只决策，窗口由主进程插值） =================
   * 流程：idle 固定3~8秒 → 选取新目标(与当前距离≥150px、最多重试20次、不与上次相同) →
   * 只发一次 startMove(x,y,durationMs) → 主进程按 easeInOutSine 绝对插值移动窗口 →
   * 收到一次 move-complete → 回到 idle 再固定3~8秒。
   * 禁止：渲染端逐帧/累加移动窗口；idle/action/reaction/dragging 期间改动窗口坐标；
   * walking 完成回调里直接再次 walking。
   */
  let walking = false;    // 走动开关（右键“开始/暂停走动”）
  let dir = 1;
  let walkPhase = 0;      // 仅旧渲染的视觉步相（不参与坐标）
  let mvState = 'idle';   // 'idle' | 'moving'
  let idleTimer = 0;      // 唯一的待机定时器
  let motionSeq = 0;      // 本端发起序号
  let lastMoveX = null;   // 上一次目标X（新目标不得与其完全相同）
  let moveUnsub = null;
  let movesDone = 0;      // 验收用：已完成自主移动次数
  let moveHistory = [];   // 验收用：每次完成的目标坐标（最多记20条）

  function spriteWalkNow() {
    if (spritesReady) { dKind = 'core'; dCoreRow = 'walking'; dExprKey = null; dCol = 0; dLoops = -1; }
    else setState(dir === 1 ? 'running-right' : 'running-left');
  }
  function spriteIdleNow() {
    if (spritesReady) { dKind = 'core'; dCoreRow = 'idle'; dExprKey = null; dCol = 0; dLoops = -1; }
    else setState('idle');
  }
  function clearIdleTimer() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; } }
  function cancelWindowMotion() { if (pet && pet.cancelMove) pet.cancelMove(); }
  function autoBlocked() {
    return mode === 'none' || dragging || reactionBusy() || !!currentAction || (!!sprSeq && !!sprSeq.timer);
  }

  // 立即停止任何移动与待机计时（进入任意非 walking 状态时调用）
  function pauseAutoForUser() {
    clearIdleTimer();
    cancelWindowMotion();
    if (mvState === 'moving') {
      mvState = 'idle';
      spriteIdleNow();
    }
  }

  // 进入 idle：窗口坐标保持不动，等 delayMs(默认3~8s) 后再决定
  function enterIdle(delayMs) {
    mvState = 'idle';
    clearIdleTimer();
    cancelWindowMotion();
    spriteIdleNow();
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      maybeStartMove();
    }, delayMs || rand(3000, 8000));
  }

  function maybeStartMove() {
    if (!walking || autoBlocked() || mvState !== 'idle') return;
    chooseAndStartMove();
  }

  async function chooseAndStartMove() {
    const [wa, pos] = await Promise.all([pet.getWorkArea(), pet.getPosition()]);
    if (!wa || !pos) return;
    if (!walking || autoBlocked()) return;

    const minX = wa.x + 10;
    const maxX = wa.x + wa.width - canvasW - 10;
    const minY = wa.y + 10;
    const maxY = wa.y + wa.height - canvasH - 10;
    if (maxX <= minX || maxY <= minY) { enterIdle(); return; }

    const curX = pos.x;
    const curY = pos.y;
    let tx = null, ty = null;
    for (let i = 0; i < 20 && tx === null; i++) {
      const cx = minX + Math.random() * (maxX - minX);
      const cy = minY + Math.random() * (maxY - minY);
      const d = Math.hypot(cx - curX, cy - curY);
      if (d >= 150 && Math.round(cx) !== lastMoveX) { tx = Math.round(cx); ty = Math.round(cy); }
    }
    if (tx === null) {
      // 20 次都太近：退化为“当前最远的角”
      const farX = Math.abs(minX - curX) >= Math.abs(maxX - curX) ? minX : maxX;
      const farY = Math.abs(minY - curY) >= Math.abs(maxY - curY) ? minY : maxY;
      tx = Math.round(farX); ty = Math.round(farY);
      if (Math.hypot(tx - curX, ty - curY) < 150) { enterIdle(); return; }
    }
    lastMoveX = tx;
    const dist = Math.hypot(tx - curX, ty - curY);
    const speed = rand(70, 110); // px/s
    const dur = clamp(Math.round((dist / speed) * 1000), 2000, 8000);
    dir = tx >= curX ? 1 : -1;   // 目标在右→向右走；在左→向左走
    motionSeq++;
    mvState = 'moving';
    spriteWalkNow();
    pet.startMove(tx, ty, dur).then((ok) => {
      if (ok === false && walking) enterIdle();
    });
  }

  // 主进程移动完成（仅一次）→ idle 并固定等待
  function onMoveDone(payload) {
    if (mvState !== 'moving') return;
    mvState = 'idle';
    spriteIdleNow();
    movesDone++;
    if (payload && Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      moveHistory.push({ x: payload.x, y: payload.y });
      if (moveHistory.length > 20) moveHistory.shift();
    }
    if (walking && !autoBlocked()) enterIdle();
  }

  function startWalking() {
    if (mode === 'none' || currentAction) return;
    cancelSprSeq();
    pauseAutoForUser();
    walking = true;
    enterIdle(rand(3000, 8000)); // 恢复后先完整待机≥3秒，再选新目标
    persistNow();
  }

  function stopWalking(keepState) {
    walking = false;
    pauseAutoForUser();
    if (spritesReady) { dKind = 'core'; dCoreRow = 'idle'; dExprKey = null; dCol = 0; dLoops = -1; }
    else if (!keepState) setState('idle');
    persistNow();
  }

  /* ================= 点击 / 拖动区分（Pointer Events，统一鼠标与触摸） ================= */
  let dragging = false;
  let dragMoved = false;
  let dragBase = null;
  let dragRaf = 0;
  let pendingMove = null;
  let downInfo = null; // { x, y, t, moved }

  function clearDragState() {
    downInfo = null;
    dragging = false;
    dragMoved = false;
    dragBase = null;
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
    pendingMove = null;
  }

  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return; // 右键走菜单，不做普通点击
    if (downInfo) return; // 已有一路指针按下，忽略重复
    downInfo = { x: event.screenX, y: event.screenY, t: Date.now(), moved: false };
    dragging = false;
    dragMoved = false;
    // 用户按下即取消自主移动与待机计时（拖动/点击都不允许窗口继续自主移动）
    pauseAutoForUser();
    try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    touch();
  }

  function onPointerMove(event) {
    if (!downInfo) return;
    const dx = event.screenX - downInfo.x;
    const dy = event.screenY - downInfo.y;
    const dist = Math.hypot(dx, dy);
    if (!downInfo.moved && dist <= 5) return; // 5px 内不算拖动
    downInfo.moved = true;

    if (!dragging) {
      dragging = true;
      if (currentAction) interruptAction(false); // 拖动时暂停动作，松手回待机
      dragBase = { ax: A.cx, feet: A.feet, sx: event.screenX, sy: event.screenY };
    }
    pendingMove = {
      ax: dragBase.ax + (event.screenX - dragBase.sx),
      feet: dragBase.feet + (event.screenY - dragBase.sy),
    };
    if (!dragRaf) {
      dragRaf = requestAnimationFrame(() => {
        dragRaf = 0;
        if (pendingMove) {
          const m = pendingMove;
          pendingMove = null;
          A.cx = m.ax;
          A.feet = m.feet;
          applyWindow();
        }
      });
    }
  }

  function onPointerUp(event) {
    if (!downInfo) return;
    const wasDrag = dragging && downInfo.moved;
    const dt = Date.now() - downInfo.t;
    const dist = Math.hypot(event.screenX - downInfo.x, event.screenY - downInfo.y);
    const dx = event.clientX - canvas.getBoundingClientRect().left;
    const dy = event.clientY - canvas.getBoundingClientRect().top;
    clearDragState();
    try { canvas.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }

    if (wasDrag) {
      clampIntoWorkArea().then(persistNow);
      if (spritesReady) sprBase();
      setState('idle');
      // 松手后：如果走动仍开启 → idle 固定3~8秒再考虑下一次（不立刻走）
      if (walking && !autoBlocked()) enterIdle();
    } else if (dt <= 350 && dist <= 5) {
      // 是点击（移动≤5px 且 时间≤350ms）
      const reacted = tryReaction(dx, dy);
      // 点击没触发反应也保持 idle 等待，不恢复移动计时（反应会自己安排）
      if (!reacted && walking && !autoBlocked() && !reactionBusy()) enterIdle();
    }
    touch();
  }

  function onPointerCancel() {
    clearDragState();
  }

  /* ================= 右键菜单 ================= */
  async function showContextMenu() {
    const cmd = await pet.contextMenu(walking, sizePreset);
    if (!cmd) return;
    if (cmd === 'walk-toggle') {
      if (walking) stopWalking();
      else startWalking();
    } else if (cmd === 'to-idle') {
      stopWalking();
      interruptAction(false);
      actionReaction = null;
      cancelSprSeq();
      if (spritesReady) sprBase();
      clearSpeech();
      setState('idle');
    } else if (cmd.startsWith('action:')) {
      runAction(cmd.slice('action:'.length), null);
    } else if (cmd === 'demo:all') {
      runDemoAll();
    } else if (cmd.startsWith('sprite:')) {
      runSpriteTest(cmd.slice('sprite:'.length));
    } else if (cmd === 'icons:panel') {
      if (window.iconAPI) window.iconAPI.openPanel();
    } else if (cmd.startsWith('icons:preview:')) {
      const row = parseInt(cmd.slice('icons:preview:'.length), 10) || 0;
      const label = row === 0 ? '发现→观察→吞吃→咀嚼→满足' : row === 1 ? '闻一闻→犹豫→摇头→嫌弃' : '拿种子→挖土→播种→浇水→发芽→恢复';
      if (playIconGroup(row, { loops: 1 })) speak(label, 2200);
    } else if (cmd === 'icons:restoreAll') {
      if (window.iconAPI) {
        window.iconAPI.restoreAll().then((r) => {
          speak(`已恢复 ${r && r.restored ? r.restored : 0} 个快捷方式`, 2000);
        });
      }
    } else if (cmd.startsWith('size:')) {
      const id = cmd.slice('size:'.length);
      if (SIZE_PRESETS[id]) {
        setSizePreset(id);
        clampIntoWorkArea().then(() => {
          speak(id === 'small' ? '变小啦！' : id === 'large' ? '变大啦！' : '刚刚好～', 1200);
        });
      }
    } else if (cmd === 'quit') {
      persistNow();
      pet.quit();
    }
  }

  /* ================= 演示全部动作 ================= */
  const DEMO_ORDER = ['working', 'drawing', 'planting', 'watering', 'picking', 'gifting', 'watching', 'sleeping'];
  let demoToken = 0;

  async function runDemoAll() {
    const token = ++demoToken;
    speak('演示开始～', 1500);
    // 演示前保证花园链完整可用（不破坏连续观感：只补缺失态）
    if (!flower) { flower = { stage: 'seed', water: 0 }; persistNow(); }
    else if (flower.stage === 'picked') flower = null; // 摘过的先清空再重来

    for (const id of DEMO_ORDER) {
      if (token !== demoToken) return;
      // 按需推进到下一步所需状态，保证每个动作能完整演示
      if (id === 'watering' && flower && flower.stage !== 'bloom' && flower.stage !== 'picked') {
        flower = { stage: 'seed', water: 0 };
        persistNow();
      }
      if (id === 'picking' && flower && flower.stage !== 'bloom') {
        flower = { stage: 'bloom', water: 9 };
        persistNow();
      }
      if (id === 'gifting' && flower && flower.stage !== 'picked') {
        flower = { stage: 'picked', water: 9 };
        persistNow();
      }
      const ok = await runActionWait(id);
      if (!ok) break;           // 被打断
      if (token !== demoToken) return;
      await delay(800);         // 动作间停顿
    }
    if (token === demoToken) speak('演示完毕！', 1800);
  }

  function runActionWait(id) {
    return new Promise((resolve) => {
      const started = { ok: false };
      runAction(id, (finished) => {
        if (started.ok || finished === false) { resolve(false); return; }
        resolve(finished);
      });
      // 若动作因校验未开始，runAction 内会以 onDone(false) 返回
    });
  }

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ================= 自主随机动作 ================= */
  let lastAutoActionAt = Date.now();
  function maybeAutoAction() {
    const nowT = Date.now();
    if (currentAction || actionReaction || walking || dragging) return;
    if (nowT - lastInteractMs < 12000) return;
    if (nowT - lastAutoActionAt < 25000) return;
    lastAutoActionAt = nowT;
    if (Math.random() > 0.6) return;

    const pool = [];
    if (!flower || flower.stage === 'picked') pool.push('planting');
    else if (flower.stage !== 'bloom') pool.push('watering');
    else if (flower.stage === 'bloom') pool.push('picking');
    pool.push('working', 'drawing', 'watching');
    if (moodVal.energy < 40 || Math.random() < 0.18) pool.push('sleeping');
    const id = pick(pool);
    if (id) runAction(id, null);
  }

  /* ================= 定时维护 ================= */
  function touch() { lastInteractMs = Date.now(); }

  function periodic() {
    const nowT = Date.now();
    if (nowT - lastEnergyMs >= 20000) {
      lastEnergyMs = nowT;
      if (moodVal.energy < 100) addMood('energy', 1);
    }
    if (nowT - lastDecayMs >= 30000) {
      lastDecayMs = nowT;
      if (nowT - lastInteractMs > 75000 && moodVal.happiness > 15) {
        addMood('happiness', -1);
        if (nowT - lastInteractMs > 180000 && !currentAction && Math.random() < 0.6) {
          speak(pick(MOOD_LINES.bored), 1800);
        }
      }
    }
    recomputeMoodAuto();
    deliverPendingMood();
    maybeAutoAction();
    persistNow();
  }

  /* ================= 事件（只注册一次，不随动画重挂） ================= */
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  window.addEventListener('contextmenu', (event) => { event.preventDefault(); showContextMenu(); });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'F2') {
      debugOn = !debugOn;
      debugEl.hidden = !debugOn;
      if (!debugOn) draw();
    }
  });

  /* ================= 调试 ================= */
  let debugOn = false;
  function drawDebugOverlay() {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,0,0,.5)';
    ctx.strokeRect(pigR.x + 0.5, pigR.y + 0.5, pigR.w - 1, pigR.h - 1);
    const colors = { ear: 'rgba(255,80,80,.5)', nose: 'rgba(60,180,90,.5)', belly: 'rgba(70,130,255,.5)' };
    for (const z of ZONES) {
      ctx.strokeStyle = colors[z.id];
      ctx.strokeRect(pigR.x + z.x * pigR.w + 0.5, pigR.y + z.y * pigR.h + 0.5, z.w * pigR.w - 1, z.h * pigR.h - 1);
    }
    ctx.restore();
  }
  function updateDebug() {
    if (!debugOn) return;
    const ph = currentAction ? phaseInfo(currentAction) : null;
    debugEl.textContent =
      `模式:${mode}  尺寸:${sizePreset}  状态:${stateName}\n` +
      `心情:${moodName} 快乐${moodVal.happiness} 精力${moodVal.energy} 亲密${moodVal.affection}\n` +
      `花:${flower ? flower.stage + '(水' + flower.water + ')' : '无'}` +
      (currentAction ? `  动作:${currentAction.id}[${ph ? ph.phase : ''}]` : '') + '\n' +
      `走动:${walking ? (dir > 0 ? '右' : '左') : '停'}  窗口:${winW()}x${winH()}@(${winX},${winY})\n` +
      `F2 隐藏调试`;
  }

  /* ================= 启动 ================= */
  async function boot() {
    let payload = null;
    try { payload = await pet.getAssets(); } catch (e) { payload = null; }

    // —— 预加载两张新精灵图（必须先加载完再开始动画，避免空白/闪烁）
    if (payload && payload.spriteCore && payload.spriteActions) {
      try {
        const cImg = await loadImage(payload.spriteCore);
        const aImg = await loadImage(payload.spriteActions);
        sprCoreImg = cImg;
        sprActionsImg = aImg;
        sprCoreCanvas = document.createElement('canvas');
        sprActionsCanvas = document.createElement('canvas');
        sprCoreCanvas.width = cImg.naturalWidth;
        sprCoreCanvas.height = cImg.naturalHeight;
        sprActionsCanvas.width = aImg.naturalWidth;
        sprActionsCanvas.height = aImg.naturalHeight;
        sprCoreCanvas.getContext('2d', { alpha: true }).drawImage(cImg, 0, 0);
        sprActionsCanvas.getContext('2d', { alpha: true }).drawImage(aImg, 0, 0);
        sprFrameW = Math.round(cImg.naturalWidth / 4);
        sprFrameH = Math.round(cImg.naturalHeight / 4);
        const aW = Math.round(aImg.naturalWidth / 4);
        const aH = Math.round(aImg.naturalHeight / 4);
        if (sprFrameW > 0 && sprFrameH > 0 && aW > 0 && aH > 0) {
          spritesReady = true; // 两张图各自 4 列×4 行，无需同格
        } else {
          fatal('精灵图格尺寸异常 core:' + sprFrameW + 'x' + sprFrameH + ' actions:' + aW + 'x' + aH);
        }
      } catch (e) {
        fatal('精灵图加载失败：' + (e && e.message ? e.message : e));
      }
    } else if (payload) {
      if (!payload.spriteCore) fatal('缺少 assets/clawd-pig-core-v1.png');
      else if (!payload.spriteActions) fatal('缺少 assets/clawd-pig-actions-v1.png');
    }

    // —— 预加载 GPT 表情表（16格 4×4，RGB → 运行时抠背景转透明，不改原图）
    if (payload && payload.expressionSheet) {
      try {
        const ei = await loadImage(payload.expressionSheet);
        sprExprImg = ei;
        const cv = document.createElement('canvas');
        cv.width = ei.naturalWidth;
        cv.height = ei.naturalHeight;
        const g = cv.getContext('2d', { alpha: true, willReadFrequently: true });
        g.drawImage(ei, 0, 0);
        if (ei.naturalWidth % 4 === 0 && ei.naturalHeight % 4 === 0 && ei.naturalWidth > 0) {
          const data = g.getImageData(0, 0, cv.width, cv.height);
          const p = data.data;
          const W = cv.width, H = cv.height;
          const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
          let br = 0, bg = 0, bb = 0;
          for (const [x, y] of corners) { const i = (y * W + x) * 4; br += p[i]; bg += p[i + 1]; bb += p[i + 2]; }
          br = Math.round(br / 4); bg = Math.round(bg / 4); bb = Math.round(bb / 4);
          const tol = 30;
          for (let y = 0; y < H; y++) {
            const rb = y * W * 4;
            for (let x = 0; x < W; x++) {
              const i = rb + x * 4;
              if (Math.abs(p[i] - br) <= tol && Math.abs(p[i + 1] - bg) <= tol && Math.abs(p[i + 2] - bb) <= tol) {
                p[i + 3] = 0;
              }
            }
          }
          g.putImageData(data, 0, 0);
          sprExprCanvas = cv;
          sprExprReady = true;
        }
      } catch (e) {
        sprExprCanvas = null;
        sprExprReady = false; // 失败则回退 core 第3行的四种表情
      }
    }

    // —— 预加载“吃图标/种植”素材（2048×768，8列×3行，每格256；不改原图）
    if (payload && payload.iconSheet) {
      try {
        const ii = await loadImage(payload.iconSheet);
        sprIconImg = ii;
        const cv = document.createElement('canvas');
        cv.width = ii.naturalWidth;
        cv.height = ii.naturalHeight;
        cv.getContext('2d', { alpha: true }).drawImage(ii, 0, 0);
        if (ii.naturalWidth % ICON_COLS === 0 && ii.naturalHeight % ICON_ROWS === 0 && ii.naturalWidth > 0) {
          sprIconCanvas = cv;
          sprIconReady = true;
        }
      } catch (e) {
        sprIconCanvas = null;
        sprIconReady = false;
      }
    }

    if (payload && payload.sheet && payload.layout && payload.layout.cells) {
      try {
        const img = await loadImage(payload.sheet);
        if (buildFromSheet(img, payload.layout)) mode = 'sheet';
      } catch (e) { mode = 'none'; }
    }
    if (mode === 'none' && payload && payload.reference) {
      try {
        const img = await loadImage(payload.reference);
        if (buildFromReference(img)) mode = 'static';
      } catch (e) { mode = 'none'; }
    }

    if (mode === 'none' && !spritesReady) {
      fatal('未找到 spritesheet-extended-v3.png，且 clawd-pig.png 不可用。\n请将精灵图放入工作区后重启。');
      computeLayout();
      canvas.width = canvasW; canvas.height = canvasH;
      const wa0 = await pet.getWorkArea();
      if (wa0) { A.cx = wa0.x + wa0.width - canvasW / 2; A.feet = wa0.y + wa0.height - 12; }
      applyWindow();
      requestAnimationFrame(frameLoop);
      setInterval(periodic, 3000);
      if (pet.onMoveComplete) moveUnsub = pet.onMoveComplete(onMoveDone);
      await pet.show();
      return;
    }

    loadSaved();
    sizePreset = saved.size;
    moodVal = { happiness: saved.mood.happiness, energy: saved.mood.energy, affection: saved.mood.affection };
    flower = saved.flower ? { stage: saved.flower.stage, water: saved.flower.water } : null;

    computeLayout();
    refreshShape();

    const wa = await pet.getWorkArea();
    if (wa) {
      if (saved.anchor) { A.cx = saved.anchor.cx; A.feet = saved.anchor.feet; }
      else { A.cx = wa.x + wa.width - canvasW + pigCVC() - 24; A.feet = wa.y + wa.height - 12; }
    } else { A.cx = pigCVC() + 120; A.feet = 120 + pigR.y + pigR.h; }
    applyWindow();
    await clampIntoWorkArea();

    moodName = moodVal.happiness >= 60 ? 'happy' : 'bored';
    lastAutoMoodAt = Date.now();

    requestAnimationFrame(frameLoop);
    setInterval(periodic, 3000);
    if (pet.onMoveComplete) moveUnsub = pet.onMoveComplete(onMoveDone);
    // 面板指令：种植动画 / 模拟吃预览（带真实图标覆盖）
    if (window.iconAPI && window.iconAPI.onCommand) {
      window.iconAPI.onCommand(async (cmd) => {
        if (!cmd) return;
        if (cmd.type === 'plant') {
          if (playIconGroup(2, { loops: 1 })) speak('种下啦～长好后点“收获”恢复', 2200);
        } else if (cmd.type === 'preview') {
          let img = null;
          try {
            const url = await window.iconAPI.iconOf(cmd.path);
            if (url) img = await loadImage(url);
          } catch (e) { img = null; }
          const row = Number.isFinite(cmd.row) ? cmd.row : 0;
          if (playIconGroup(row, { loops: 1, iconImg: img })) {
            speak(row === 0 ? '（预览）啊呜～' : row === 1 ? '（预览）唔…不太想吃' : '（预览）种下去～', 1800);
          }
        }
      });
    }

    if (spritesReady) speak('嗨，我是 Clawd！新素材已就位', 2000);
    else if (mode === 'static') speak('精灵图缺失 · 参考图模式', 2200);
    else speak('嗨，我是 Clawd！', 2000);
    persistNow();
    await pet.show();
  }

  /* ================= 图标仪式（挑食地吃 / 种植） ================= */
  async function iconRitualOnce(real) {
    if (!window.iconAPI) return { ok: false, reason: 'no-icon-api' };
    const st = await window.iconAPI.state();
    const scan = await window.iconAPI.scan();
    if (!scan || !scan.ok || !scan.entries || !scan.entries.length) return { ok: false, reason: 'no-candidates' };
    const entry = scan.entries[Math.floor(Math.random() * scan.entries.length)];
    const ev = await window.iconAPI.evaluate({ path: entry.path, hunger: hungerNow() });
    const iconUrl = await window.iconAPI.iconOf(entry.path);
    let img = null;
    if (iconUrl) { try { img = await loadImage(iconUrl); } catch (e) { img = null; } }

    if (!ev || !ev.ok) {
      // 分数低：走近后播放第2行“闻/犹豫/摇头/嫌弃”，然后离开（不做任何移动文件操作）
      if (playIconGroup(1, { loops: 1, iconImg: img })) speak('唔…这个不太想吃', 1800);
      return { ok: false, reason: (ev && ev.reason) || 'refused', score: ev && ev.score };
    }
    let moved = null;
    const scanOnly = !!(st && st.settings && st.settings.scanOnly);
    if (real && !scanOnly) {
      moved = await window.iconAPI.eat({ name: entry.name, path: entry.path, hunger: hungerNow() });
      if (!moved || !moved.ok) {
        if (playIconGroup(1, { loops: 1, iconImg: img })) speak('唔…吃不到', 1600);
        return { ok: false, reason: moved && moved.reason };
      }
    }
    if (playIconGroup(0, { loops: 1, iconImg: img })) {
      speak(scanOnly ? '（预览）啊呜～这个好吃！' : '啊呜～吃掉啦！', 2000);
    }
    return { ok: true, scanOnly, moved, score: ev.score, name: entry.name };
  }

  // 供面板/测试使用
  window.__clawdIcons = {
    preview: (row) => playIconGroup(Number(row) || 0, { loops: 1 }),
    eatOnce: (real) => iconRitualOnce(!!real),
    simulate: () => iconRitualOnce(false),
    state: () => (window.iconAPI ? window.iconAPI.state() : null),
  };

  // 供冒烟/调试钩子
  window.__clawd = {
    runDemoAll,
    runAction: (id) => runAction(id, null),
    runSpriteTest,
    startWalking,
    stopWalking,
    runReaction: (part) => triggerReaction(part),
    getState: () => ({
      mode, sizePreset, stateName, moodName, moodVal: { ...moodVal },
      flower: flower ? { ...flower } : null,
      walking, mvState,
      frameCol: dCol,
      movesDone,
      moveHistory: moveHistory.map((m) => ({ x: m.x, y: m.y })),
      anchor: { cx: Math.round(A.cx), feet: Math.round(A.feet) },
      action: currentAction ? currentAction.id : null,
      sprites: spritesReady,
      expressionReady: sprExprReady,
      iconSheetReady: sprIconReady,
      spriteFrame: spritesReady ? { w: sprFrameW, h: sprFrameH } : null,
      spriteView: spritesReady ? (dKind + (dKind === 'core' ? ':' + dCoreRow : dKind === 'action' ? ':' + dActionRow : dKind === 'icon' ? ':row' + dIconRow + ':' + dIconCol : ':' + dExprKey)) : null,
      canvas: { w: canvasW, h: canvasH },
      pig: { w: pigR.w, h: pigR.h },
    }),
  };

  boot();
})();
