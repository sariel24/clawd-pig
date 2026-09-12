'use strict';

/* 图标仓库面板：只通过 preload 暴露的 iconAPI 工作，不直接触碰文件系统 */
(function () {
  const api = window.iconAPI;
  const $ = (id) => document.getElementById(id);

  const STATUS_TEXT = {
    stored: '已吃下（种子）',
    planting: '种植中',
    moving: '处理中',
    restored: '已恢复',
    missing: '文件缺失',
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function iconFor(path) {
    try { return await api.iconOf(path); } catch (e) { return null; }
  }

  async function refresh() {
    const st = await api.state();
    if (!st) return;
    $('deskPath').textContent = st.desktop || '（未找到）';
    $('bellyPath').textContent = st.belly || '—';
    const scanOnly = !!(st.settings && st.settings.scanOnly);
    const mode = $('mode');
    mode.textContent = scanOnly ? '扫描模式（不移动真实图标）' : '真实移动已开启';
    mode.className = 'badge' + (scanOnly ? '' : ' warn');
    $('scanOnly').checked = !scanOnly;
    renderSeeds(st.stored || []);
  }

  function renderSeeds(list) {
    const box = $('seeds');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="empty">暂无。吃下（或测试移入）的快捷方式会出现在这里。</div>'; return; }
    for (const s of list) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `<img alt=""><span class="nm">${esc(s.name)}<br><span class="st">${esc(STATUS_TEXT[s.status] || s.status)} · ${esc(s.originalPath || '')}</span></span>`;
      const plant = document.createElement('button');
      plant.className = 'mini';
      plant.textContent = '种植（动画）';
      plant.onclick = async () => { await api.plantAnimate(s.id); refresh(); };
      const harvest = document.createElement('button');
      harvest.className = 'mini';
      harvest.textContent = '收获（恢复）';
      harvest.onclick = async () => { await api.harvest(s.id); refresh(); };
      const now = document.createElement('button');
      now.className = 'mini';
      now.textContent = '立即种好并恢复';
      now.onclick = async () => { await api.harvest(s.id); refresh(); };
      el.appendChild(plant); el.appendChild(harvest); el.appendChild(now);
      box.appendChild(el);
      iconFor(s.originalPath).then((url) => { if (url) el.querySelector('img').src = url; });
    }
  }

  async function scan() {
    const box = $('candidates');
    box.innerHTML = '<div class="empty">扫描中…</div>';
    const r = await api.scan();
    const st = await api.state();
    const scanOnly = !!(st && st.settings && st.settings.scanOnly);
    box.innerHTML = '';
    if (!r || !r.ok) { box.innerHTML = `<div class="empty">扫描失败：${esc((r && r.reason) || '未知')}</div>`; return; }
    if (!r.entries.length) { box.innerHTML = '<div class="empty">桌面上没有可吃的快捷方式（只认 .lnk / .url，且排除小猪自身）。</div>'; return; }
    for (const e of r.entries) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `<img alt=""><span class="nm">${esc(e.name)}<br><span class="st">${esc(e.path)}</span></span>`;
      const pv = document.createElement('button');
      pv.className = 'mini';
      pv.textContent = '模拟吃（预览）';
      pv.onclick = async () => { await api.preview(e.path, 0); };
      const eat = document.createElement('button');
      eat.className = 'mini';
      eat.textContent = scanOnly ? '吃掉（需先开真实移动）' : '吃掉';
      eat.disabled = scanOnly;
      eat.onclick = async () => {
        const r2 = await api.eat({ name: e.name, path: e.path, hunger: 60 });
        alert(r2 && r2.ok ? '已移动进小猪肚子（可种植恢复）' : `没有吃：${(r2 && r2.reason) || '未知'}`);
        refresh();
      };
      el.appendChild(pv); el.appendChild(eat);
      box.appendChild(el);
      iconFor(e.path).then((url) => { if (url) el.querySelector('img').src = url; });
    }
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = scanOnly ? '当前为扫描模式：只列出候选，不会移动任何真实图标。' : '真实移动已开启。';
    box.appendChild(note);
  }

  $('btnScan').onclick = scan;
  $('btnRefresh').onclick = refresh;
  $('btnRestoreAll').onclick = async () => {
    const r = await api.restoreAll();
    alert(`已恢复 ${r && r.restored ? r.restored : 0} 个快捷方式`);
    refresh();
  };

  // 真实移动开关：勾选前二次确认；取消则回到只扫描
  $('scanOnly').addEventListener('change', async (ev) => {
    const wantReal = ev.target.checked; // 勾选 = 开启真实移动
    if (wantReal) {
      const ok = window.confirm(
        '要开启“真实移动”吗？\n\n' +
        '· 只会移动桌面上的 .lnk / .url 快捷方式\n' +
        '· 不吃文件夹、照片、文档、压缩包等真实文件\n' +
        '· 不吃“此电脑/回收站”等系统图标，也不吃小猪自己的快捷方式\n' +
        '· “吃掉”= 移动到小猪仓库，绝不删除，随时可用“立即恢复全部”还原\n\n' +
        '确认开启吗？'
      );
      if (!ok) { ev.target.checked = false; return; }
      await api.setSettings({ scanOnly: false });
    } else {
      await api.setSettings({ scanOnly: true });
    }
    refresh();
  });

  refresh();
})();
