'use strict';

/**
 * 小猪 Clawd 桌面宠物 —— preload
 *
 * 在 contextIsolation + sandbox 下通过 contextBridge 向渲染进程暴露
 * 最小化的 API，渲染进程无法访问 Node.js / Electron 其余能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

function clampNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

contextBridge.exposeInMainWorld('petAPI', {
  // 素材：{ sheet: dataUrl|null, reference: dataUrl|null, layout: object|null }
  getAssets: () => ipcRenderer.invoke('pet:get-assets'),

  // 首次布局就绪后显示窗口
  show: () => ipcRenderer.invoke('pet:show'),

  // 屏幕：当前所在显示器的可用工作区 { x, y, width, height }
  getWorkArea: () => ipcRenderer.invoke('pet:get-work-area'),

  // 窗口位置（DIP）
  getPosition: () => ipcRenderer.invoke('pet:get-position'),
  setPosition: (x, y) => ipcRenderer.invoke('pet:set-position', clampNum(x), clampNum(y)),

  // —— 自主移动（唯一控制器在主进程，插值平滑，完成只通知一次）
  startMove: (x, y, durationMs) =>
    ipcRenderer.invoke('pet:start-move', {
      x: clampNum(x),
      y: clampNum(y),
      duration: clampNum(durationMs),
    }),
  cancelMove: () => ipcRenderer.invoke('pet:cancel-move'),
  onMoveComplete: (cb) => {
    const listener = (_event, data) => { if (cb) cb(data); };
    ipcRenderer.on('pet:move-complete', listener);
    return () => ipcRenderer.removeListener('pet:move-complete', listener);
  },

  // 窗口尺寸与位置（用于气泡区扩展、精灵尺寸自适应）
  setBounds: (b) =>
    ipcRenderer.invoke('pet:set-bounds', {
      x: clampNum(b && b.x),
      y: clampNum(b && b.y),
      width: clampNum(b && b.width),
      height: clampNum(b && b.height),
    }),

  // 右键菜单：返回 'walk-toggle'|'to-idle'|'action:<id>'|'size:<id>'|'sprite:<id>'|'demo:all'|'quit'|null
  contextMenu: (walking, size) =>
    ipcRenderer.invoke('pet:context-menu', { walking: !!walking, size: size || undefined }),

  // 退出
  quit: () => ipcRenderer.invoke('pet:quit'),
});

// —— 图标仓库 / 挑食 / 种植（白名单接口：渲染进程只能调用这些）
contextBridge.exposeInMainWorld('iconAPI', {
  state: () => ipcRenderer.invoke('icons:state'),
  scan: () => ipcRenderer.invoke('icons:scan'),
  iconOf: (filePath) => ipcRenderer.invoke('icons:iconOf', String(filePath || '')),
  evaluate: (payload) => ipcRenderer.invoke('icons:evaluate', {
    path: String((payload && payload.path) || ''),
    hunger: Number.isFinite(payload && payload.hunger) ? payload.hunger : 50,
  }),
  eat: (payload) => ipcRenderer.invoke('icons:eat', {
    name: String((payload && payload.name) || ''),
    path: String((payload && payload.path) || ''),
    hunger: Number.isFinite(payload && payload.hunger) ? payload.hunger : 50,
  }),
  stored: () => ipcRenderer.invoke('icons:stored'),
  plant: (id) => ipcRenderer.invoke('icons:plant', String(id || '')),
  harvest: (id) => ipcRenderer.invoke('icons:harvest', String(id || '')),
  restoreAll: () => ipcRenderer.invoke('icons:restoreAll'),
  openPanel: () => ipcRenderer.invoke('icons:openPanel'),
  setSettings: (patch) => ipcRenderer.invoke('icons:setSettings', patch || {}),
  plantAnimate: (id) => ipcRenderer.invoke('icons:plantAnimate', String(id || '')),
  preview: (filePath, row) => ipcRenderer.invoke('icons:preview', {
    path: String(filePath || ''),
    row: Number.isFinite(row) ? row : 0,
  }),
  onCommand: (cb) => {
    const listener = (_e, data) => { if (cb) cb(data); };
    ipcRenderer.on('icons:pet-command', listener);
    return () => ipcRenderer.removeListener('icons:pet-command', listener);
  },
});
