'use strict';
// 右侧面板：文件、侧边对话、终端、浏览器 —— 像 Claude、Codex 桌面版那样从右边展开。
// app.js 调用 createPanel(ctx) 创建，ctx 里是 app.js 的状态和工具函数。
window.createPanel = function createPanel(ctx) {
  const {
    S,
    $,
    el,
    esc,
    api,
    toast,
    md,
    ICONS,
    fileType,
    FILE_ICON,
    fullPath,
    fileUrl,
    fileAction,
    copyText,
    openMenu,
    agentById,
    enabledAgents,
    initial,
    hashColor,
    fmtTime,
    fmtDur,
    fmtClock,
    workItem,
    desktop,
    local,
    insertIntoComposer,
    onChange,
  } = ctx;
  const tr = window.I18N.t; // 界面文字的翻译（见 i18n.js）

  const TABS = [
    ['files', tr('文件'), 'folder'],
    ['side', tr('侧边对话'), 'chat'],
    ['term', tr('终端'), 'terminal'],
    ['browser', tr('浏览器'), 'web'],
  ];
  const MIN_W = 320;
  const saved = (() => {
    try {
      return JSON.parse(local.get('agentchat.panel') || '{}') || {};
    } catch {
      return {};
    }
  })();
  const P = {
    open: !!saved.open,
    tab: TABS.some((t) => t[0] === saved.tab) ? saved.tab : 'files',
    width: Math.max(MIN_W, Number(saved.width) || 480),
  };
  const save = () => local.set('agentchat.panel', JSON.stringify(P));
  const root = $('#panel');
  const view = (id) => root.querySelector(`[data-pview="${id}"]`);
  const noRoom = (what) => `<div class="pv-empty"><p>${esc(tr('先在左边选择或新建一个会话，再使用{what}。', { what }))}</p></div>`;
  const fmtSize = (n) =>
    n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  // ---------- 面板本身：显示、隐藏、切换标签、拖动改宽度 ----------
  function mount() {
    root.innerHTML = `
      <div class="panel-resizer" id="panelResizer" title="${tr('拖动调整宽度，双击恢复默认')}"></div>
      <div class="panel-tabs" role="tablist" aria-label="${tr('右侧面板')}">
        ${TABS.map(
          ([id, label, icon]) =>
            `<button type="button" role="tab" class="ptab" data-ptab="${id}" aria-selected="false">${ICONS[icon]}<span>${label}</span></button>`
        ).join('')}
        <span class="grow"></span>
        <button type="button" class="icon-btn" data-panel-close title="${tr('关闭面板')}" aria-label="${tr('关闭面板')}">${ICONS.close}</button>
      </div>
      <div class="panel-body">${TABS.map(([id]) => `<section class="pview pv-${id}" data-pview="${id}" role="tabpanel"></section>`).join('')}</div>`;
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-ptab],[data-panel-close]');
      if (!t) return;
      if (t.dataset.ptab) show(t.dataset.ptab);
      else hide();
    });
    setupResizer();
    FILES.mount();
    SIDE.mount();
    TERM.mount();
    BROWSER.mount();
    window.addEventListener('resize', () => {
      applyWidth();
      TERM.fit();
    });
    layout();
    if (P.open) activate();
  }

  // 窗口太窄时临时缩小显示，但不改你拖出来的宽度，窗口变大后会恢复
  function applyWidth() {
    const max = Math.max(MIN_W, window.innerWidth - 460);
    root.style.width = Math.min(P.width, max) + 'px';
  }

  // 焦点留在看不见的地方（比如收起的终端）时，打的字会跑进去：挪回群聊输入框
  function rescueFocus() {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return;
    const v = a.closest('[data-pview]');
    if (P.open && v && v.classList.contains('active')) return;
    a.blur();
    const input = document.getElementById('input');
    if (input) input.focus();
  }

  function layout() {
    root.hidden = !P.open;
    $('#app').classList.toggle('panel-open', P.open);
    applyWidth();
    for (const b of root.querySelectorAll('[data-ptab]')) b.setAttribute('aria-selected', String(b.dataset.ptab === P.tab));
    for (const v of root.querySelectorAll('[data-pview]')) v.classList.toggle('active', v.dataset.pview === P.tab);
    rescueFocus();
    if (onChange) onChange(P);
  }

  function activate() {
    const V = { files: FILES, side: SIDE, term: TERM, browser: BROWSER }[P.tab];
    V.activate();
  }

  function show(tab) {
    if (tab) P.tab = tab;
    P.open = true;
    save();
    layout();
    activate();
  }

  function hide() {
    P.open = false;
    save();
    layout();
  }

  // 点标题栏上的图标：面板开着并且就是这一页 → 收起；否则打开到这一页
  function toggle(tab) {
    if (P.open && (!tab || tab === P.tab)) return hide();
    show(tab || P.tab);
  }

  function setupResizer() {
    const h = $('#panelResizer');
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const startX = e.clientX;
      const startW = root.getBoundingClientRect().width;
      const move = (ev) => {
        const max = Math.max(MIN_W, window.innerWidth - 460);
        P.width = Math.round(Math.min(max, Math.max(MIN_W, startW + (startX - ev.clientX))));
        applyWidth();
        TERM.fit();
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
        save();
        TERM.fit();
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('dblclick', () => {
      P.width = 480;
      applyWidth();
      save();
      TERM.fit();
    });
  }

  // =====================================================================
  // 文件：项目文件树 + 预览
  // =====================================================================
  const FILES = (() => {
    const states = new Map(); // 每个项目各记各的：展开了哪些文件夹、打开着哪个文件
    let searchTimer = null;

    function st() {
      if (!S.roomId) return null;
      let s = states.get(S.roomId);
      if (!s) {
        s = { dirs: new Map(), loading: new Set(), expanded: new Set(), query: '', results: null, file: null, mode: '', ver: 1 };
        states.set(S.roomId, s);
      }
      return s;
    }

    function mount() {
      const v = view('files');
      v.innerHTML = `
        <div class="pv-head">
          <label class="pv-search">${ICONS.search}<input type="search" id="fSearch" placeholder="${tr('搜索文件')}" autocomplete="off" spellcheck="false" aria-label="${tr('搜索文件')}"></label>
          <button type="button" class="icon-btn" data-f="refresh" title="${tr('刷新')}" aria-label="${tr('刷新')}">${ICONS.refresh}</button>
          <button type="button" class="icon-btn" data-f="reveal-root" title="${tr('在文件管理器中打开项目文件夹')}" aria-label="${tr('在文件管理器中打开')}">${ICONS.open}</button>
        </div>
        <div class="pv-scroll f-list" id="fList"></div>
        <div class="fpv" id="fPreview" hidden></div>`;
      const input = $('#fSearch');
      input.addEventListener('input', () => search(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) {
          e.stopPropagation();
          input.value = '';
          search('');
        }
      });
      v.addEventListener('click', onClick);
      v.addEventListener('contextmenu', onContext);
    }

    function activate() {
      const s = st();
      $('#fSearch').disabled = !s;
      $('#fSearch').value = s ? s.query : ''; // 每个项目各有各的搜索
      if (s && s.file) renderPreview();
      else renderList();
    }

    // 这个项目里每个文件最后一次是谁、什么时候新建或修改的（来自消息底部的文件卡片）
    function changes() {
      const map = new Map();
      for (const m of S.messages) {
        if (m.kind !== 'agent' || !Array.isArray(m.files)) continue;
        const a = agentById(m.from);
        for (const f of m.files) {
          if (f.change === 'delete') map.delete(f.path);
          else map.set(f.path, { change: f.change, color: a ? a.color : hashColor(m.name), name: a ? a.name : m.name, ts: m.ts });
        }
      }
      return map;
    }

    const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const baseName = (p) => p.split('/').pop();

    async function load(dir) {
      const s = st();
      if (!s || s.loading.has(dir)) return;
      const roomId = S.roomId;
      s.loading.add(dir);
      try {
        const r = await api('GET', `/api/rooms/${roomId}/tree?path=${encodeURIComponent(dir)}`);
        s.dirs.set(dir, { entries: r.entries, truncated: r.truncated });
      } catch (e) {
        s.dirs.set(dir, { entries: [], error: e.message });
      } finally {
        s.loading.delete(dir);
      }
      if (roomId === S.roomId && P.open && P.tab === 'files' && !s.file && !s.results) renderList();
    }

    function search(q) {
      const s = st();
      if (!s) return;
      clearTimeout(searchTimer);
      s.query = q.trim();
      if (!s.query) {
        s.results = null;
        return renderList();
      }
      searchTimer = setTimeout(async () => {
        const want = s.query;
        try {
          const r = await api('GET', `/api/rooms/${S.roomId}/find?q=${encodeURIComponent(want)}`);
          if (s.query !== want) return;
          s.results = r.results;
        } catch (e) {
          s.results = [];
          toast(e.message, true);
        }
        s.file = null;
        renderList();
      }, 180);
    }

    // 「GPT 新建于 12:03」
    function changedAt(info) {
      const vars = { name: info.name, time: fmtTime(info.ts) };
      return info.change === 'add' ? tr('{name} 新建于 {time}', vars) : tr('{name} 修改于 {time}', vars);
    }

    function fileRow(p, depth, e, ch, showDir) {
      const t = fileType(p);
      const info = ch.get(p);
      const tip = [p, e && e.size != null ? fmtSize(e.size) : '', info ? changedAt(info) : '']
        .filter(Boolean)
        .join(' · ');
      return `<li><button type="button" class="tree-row file" data-tree-file="${esc(p)}" aria-current="${st().file === p}" style="--depth:${depth}" title="${esc(tip)}">
        <span class="tree-ico k-${t.kind}">${FILE_ICON[t.kind] || FILE_ICON.other}</span><span class="tree-name">${esc(baseName(p))}${showDir && parentOf(p) ? `<small>${esc(parentOf(p))}</small>` : ''}</span>${
          info ? `<i class="tree-dot" style="--c:${info.color}"></i>` : ''
        }</button></li>`;
    }

    function dirRows(s, dir, depth, ch, budget) {
      const d = s.dirs.get(dir);
      if (!d) {
        load(dir);
        return `<li class="tree-note" style="--depth:${depth}">${tr('正在读取……')}</li>`;
      }
      if (d.error) return `<li class="tree-note bad" style="--depth:${depth}">${esc(d.error)}</li>`;
      if (!d.entries.length) return `<li class="tree-note" style="--depth:${depth}">${tr('（空文件夹）')}</li>`;
      let html = '';
      for (const e of d.entries) {
        if (budget.n-- <= 0) return html + `<li class="tree-note" style="--depth:${depth}">${tr('展开的内容太多，先收起一些文件夹')}</li>`;
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (e.dir) {
          const open = s.expanded.has(p);
          html += `<li><button type="button" class="tree-row dir${e.heavy ? ' heavy' : ''}" data-tree-dir="${esc(p)}" aria-expanded="${open}" style="--depth:${depth}" title="${esc(p)}">${ICONS.chev}<span class="tree-ico">${ICONS.folder}</span><span class="tree-name">${esc(e.name)}</span></button>${
            open ? `<ul class="tree">${dirRows(s, p, depth + 1, ch, budget)}</ul>` : ''
          }</li>`;
        } else html += fileRow(p, depth, e, ch);
      }
      if (d.truncated) html += `<li class="tree-note" style="--depth:${depth}">${tr('文件太多，只列出前 3000 个')}</li>`;
      return html;
    }

    function renderList() {
      const s = st();
      const list = $('#fList');
      $('#fPreview').hidden = true;
      list.hidden = false;
      if (!s) {
        list.innerHTML = noRoom(tr('文件面板'));
        return;
      }
      const ch = changes();
      if (s.results) {
        list.innerHTML = s.results.length
          ? `<div class="f-sec"><div class="f-sec-head">${tr('找到 {n} 个', { n: s.results.length + (s.results.length >= 200 ? '+' : '') })}</div><ul class="tree">${s.results
              .map((r) =>
                r.dir
                  ? `<li><button type="button" class="tree-row dir" data-reveal-dir="${esc(r.path)}" style="--depth:0">${ICONS.folder}<span class="tree-name">${esc(r.path)}</span></button></li>`
                  : fileRow(r.path, 0, null, ch, true)
              )
              .join('')}</ul></div>`
          : `<div class="pv-empty"><p>${tr('没有找到名字里带这几个字的文件。')}</p></div>`;
        return;
      }
      const recent = [...ch.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 6);
      const ws = S.room.workspace;
      // 不属于项目的会话：文件夹名是 Nightshift 起的编号，写成「会话文件夹」
      const name = S.room.standalone ? tr('会话文件夹') : ws.split(/[\\/]/).filter(Boolean).pop() || ws;
      const keep = list.scrollTop;
      list.innerHTML =
        (recent.length
          ? `<div class="f-sec"><div class="f-sec-head">${tr('最近改动')}</div><ul class="tree recent">${recent
              .map(([p, info]) => {
                const t = fileType(p);
                return `<li><button type="button" class="tree-row file" data-tree-file="${esc(p)}" aria-current="${s.file === p}" style="--depth:0" title="${esc(p)}">
                  <span class="tree-ico k-${t.kind}">${FILE_ICON[t.kind] || FILE_ICON.other}</span><span class="tree-name">${esc(baseName(p))}<small>${esc(parentOf(p))}</small></span>
                  <span class="tree-by" style="--c:${info.color}">${esc(info.change === 'add' ? tr('{name} 新建', { name: info.name }) : tr('{name} 修改', { name: info.name }))}</span></button></li>`;
              })
              .join('')}</ul></div>`
          : '') +
        `<div class="f-sec"><div class="f-sec-head" title="${esc(ws)}">${ICONS.folder}${esc(name)}</div><ul class="tree" role="tree">${dirRows(s, '', 0, ch, { n: 4000 })}</ul></div>`;
      list.scrollTop = keep;
    }

    function toggleDir(p) {
      const s = st();
      if (s.expanded.has(p)) s.expanded.delete(p);
      else s.expanded.add(p);
      renderList();
    }

    // 搜索结果里点文件夹、消息里点附上的文件夹：退出搜索（正在预览文件的话回到文件列表），在树里展开到它
    function revealDir(p) {
      const s = st();
      if (!s) return;
      $('#fSearch').value = '';
      s.query = '';
      s.results = null;
      s.file = null;
      s.loc = null;
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) s.expanded.add(parts.slice(0, i).join('/'));
      renderList();
      setTimeout(() => {
        const row = view('files').querySelector(`[data-tree-dir="${CSS.escape(p)}"]`);
        if (row) row.scrollIntoView({ block: 'center' });
      }, 120);
    }

    async function refresh() {
      const s = st();
      if (!s) return;
      const dirs = [...s.dirs.keys()];
      s.dirs.clear();
      await Promise.all(dirs.map((d) => (d === '' || s.expanded.has(d) ? load(d) : null)));
      if (s.file) {
        s.ver++;
        renderPreview();
      } else renderList();
    }

    // ---------- 预览 ----------
    function defaultMode(t) {
      return t.preview === 'html' || t.preview === 'md' ? 'preview' : 'source';
    }

    // loc：app.js 的 locate 算出来的。别的项目里的文件（loc.roomId）借那个项目的会话来读；
    // 哪个项目都不在的（loc.outside）没法预览，只说明它在哪
    function open(rel, loc) {
      const s = st();
      if (!s) return;
      const t = fileType(rel);
      s.file = rel;
      s.loc = loc && (loc.outside || (loc.roomId && loc.roomId !== S.roomId)) ? loc : null;
      s.mode = defaultMode(t);
      s.ver++;
      // 当前项目的文件：在树里也展开到它
      if (!s.loc) {
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) s.expanded.add(parts.slice(0, i).join('/'));
      }
      if (P.tab !== 'files' || !P.open) show('files');
      else renderPreview();
    }

    function close() {
      const s = st();
      if (s) {
        s.file = null;
        s.loc = null;
      }
      renderList();
    }

    function codeHtml(text, wrap) {
      const lines = text.split('\n');
      if (lines.length > 30000) return `<pre class="code-view plain${wrap ? ' wrap' : ''}"><code>${esc(text)}</code></pre>`;
      return `<pre class="code-view${wrap ? ' wrap' : ''}"><code>${lines.map((l) => `<span class="ln">${esc(l.replace(/\r$/, '')) || ' '}</span>`).join('')}</code></pre>`;
    }

    function cannot(rel, why) {
      const t = fileType(rel);
      return `<div class="pv-empty"><span class="file-icon k-${t.kind}">${FILE_ICON[t.kind] || FILE_ICON.other}</span>
        <p>${esc(why)}</p>
        <div class="row center"><button type="button" class="btn small primary" data-f="open">${t.kind === 'exec' ? tr('在文件夹中显示') : tr('用默认程序打开')}</button>
        <button type="button" class="btn small" data-f="with">${tr('选择其他程序…')}</button></div></div>`;
    }

    async function renderPreview() {
      const s = st();
      const box = $('#fPreview');
      if (!s || !s.file) return renderList();
      $('#fList').hidden = true;
      box.hidden = false;
      const rel = s.file;
      const loc = s.loc;
      const t = fileType(rel);
      const info = loc ? null : changes().get(rel);
      const dir = parentOf(rel);
      const modes = !(loc && loc.outside) && (t.preview === 'html' || t.preview === 'md');
      // 文件名下面一行：在哪个文件夹（别的项目里的标出项目名，不属于项目的会话标出会话名，项目外的写完整路径）
      const where = loc
        ? loc.outside
          ? esc(fullPath(dir))
          : `<span class="fpv-proj">${esc(loc.standalone ? tr('会话「{name}」', { name: loc.project }) : tr('项目「{name}」', { name: loc.project }))}</span> · ${esc(dir || tr('项目根目录'))}`
        : `${esc(dir || tr('项目根目录'))}${info ? ` · <span class="tree-by" style="--c:${info.color}">${esc(changedAt(info))}</span>` : ''}`;
      box.innerHTML = `
        <div class="pv-head fpv-head">
          <button type="button" class="icon-btn" data-f="back" title="${tr('返回文件列表')}" aria-label="${tr('返回文件列表')}">${ICONS.back}</button>
          <span class="tree-ico k-${t.kind}">${FILE_ICON[t.kind] || FILE_ICON.other}</span>
          <div class="fpv-title"><b title="${esc(loc ? fullPath(loc.full) : rel)}">${esc(baseName(rel))}</b><small>${where}</small></div>
          ${
            modes
              ? `<div class="mini-seg" role="group" aria-label="${tr('显示方式')}"><button type="button" data-f-mode="preview" aria-pressed="${s.mode === 'preview'}">${tr('预览')}</button><button type="button" data-f-mode="source" aria-pressed="${s.mode === 'source'}">${tr('源码')}</button></div>`
              : ''
          }
          ${loc && loc.outside ? '' : `<button type="button" class="icon-btn" data-f="reload" title="${tr('重新读取')}" aria-label="${tr('重新读取')}">${ICONS.refresh}</button>`}
          <button type="button" class="icon-btn" data-f="menu" data-menu-anchor title="${tr('打开方式')}" aria-label="${tr('打开方式')}" aria-haspopup="menu">${ICONS.more}</button>
        </div>
        <div class="fpv-body" id="fBody"><div class="pv-empty"><p>${tr('正在打开……')}</p></div></div>`;
      const body = $('#fBody');
      // 不在任何项目里的文件：服务端不给读，这里说清楚原因，给出能做的事
      if (loc && loc.outside) {
        const why = loc.project
          ? tr('这个文件在项目「{name}」的文件夹里，但那个项目还没有会话，暂时没法在这里预览。', { name: loc.project })
          : tr('这个文件不在任何项目的文件夹里。Nightshift 只能预览项目文件夹里的文件，可以在文件夹中找到它。');
        body.innerHTML = `<div class="pv-empty"><span class="file-icon k-${t.kind}">${FILE_ICON[t.kind] || FILE_ICON.other}</span>
          <p>${esc(why)}</p><p class="pv-path">${esc(fullPath(loc.full))}</p>
          <div class="row center"><button type="button" class="btn small primary" data-f="reveal-file">${tr('在文件夹中显示')}</button>
          <button type="button" class="btn small" data-f="copy-path">${tr('复制完整路径')}</button></div></div>`;
        return;
      }
      const url = `${fileUrl(rel, loc && loc.roomId)}?v=${s.ver}`;
      const stillHere = () => s.file === rel && S.roomId && $('#fBody') === body;
      try {
        if (t.preview === 'html' && s.mode === 'preview') {
          // 沙盒 iframe：网页里的脚本能跑，但拿不到 Agent Chat 的身份
          body.innerHTML = `<iframe class="preview-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="${esc(url)}" title="${esc(baseName(rel))}"></iframe>
            <div class="fpv-foot"><span>${tr('沙盒预览：脚本能运行，本地存储等功能可能受限。')}</span><button type="button" class="link-btn" data-f="browser">${tr('在浏览器标签中打开')}</button></div>`;
          return;
        }
        if (t.preview === 'image') {
          body.innerHTML = `<div class="preview-image"><img src="${esc(url)}" alt="${esc(baseName(rel))}"></div>`;
          return;
        }
        if (t.kind === 'pdf') {
          body.innerHTML = `<iframe class="preview-frame pdf" src="${esc(url)}" title="${esc(baseName(rel))}"></iframe>`;
          return;
        }
        if (t.kind === 'media') {
          const tag = /^(mp3|wav|ogg|flac|m4a)$/.test(t.ext) ? 'audio' : 'video';
          body.innerHTML = `<div class="preview-image"><${tag} src="${esc(url)}" controls></${tag}></div>`;
          return;
        }
        const res = await fetch(url);
        if (!stillHere()) return;
        if (!res.ok) {
          body.innerHTML = `<div class="pv-empty"><p>${tr('找不到这个文件，可能已经被删除或改名了。')}</p></div>`;
          return;
        }
        const size = Number(res.headers.get('content-length')) || 0;
        if (!t.preview && (size > 2 * 1024 * 1024 || ['word', 'sheet', 'slide', 'archive', 'exec'].includes(t.kind))) {
          body.innerHTML = cannot(rel, tr('{type}没法在这里预览。', { type: t.label }));
          return;
        }
        const buf = await res.arrayBuffer();
        if (!stillHere()) return;
        const head = new Uint8Array(buf.slice(0, 8192));
        if (!t.preview && head.includes(0)) {
          body.innerHTML = cannot(rel, tr('这是二进制文件，没法在这里预览。'));
          return;
        }
        let text = new TextDecoder('utf-8').decode(buf);
        let cut = '';
        if (text.length > 600000) {
          text = text.slice(0, 600000);
          cut = `<div class="fpv-foot"><span>${tr('文件太长，只显示前面一部分。')}</span></div>`;
        }
        if (t.preview === 'md' && s.mode === 'preview') body.innerHTML = `<div class="md preview-md">${md(text)}</div>${cut}`;
        else body.innerHTML = codeHtml(text, t.kind === 'doc' || t.preview === 'md') + cut;
      } catch (e) {
        if (stillHere()) body.innerHTML = `<div class="pv-empty"><p>${esc(e.message)}</p></div>`;
      }
    }

    function menuFor(anchor, rel, isDir, at, loc) {
      const t = fileType(rel);
      const items = [];
      // 预览着的别的项目里的、项目外的文件：动作都按它自己的位置来，路径给完整的
      if (loc) {
        const full = fullPath(loc.full);
        if (!loc.outside) {
          if (t.preview === 'html') items.push({ label: tr('在浏览器标签中打开'), icon: ICONS.web, run: () => BROWSER.openFile(rel, loc) });
          if (t.kind !== 'exec') items.push({ label: tr('用默认程序打开'), icon: ICONS.open, run: () => fileAction(loc, 'open') });
          items.push({ label: tr('选择其他程序打开…'), icon: ICONS.apps, run: () => fileAction(loc, 'with') });
        }
        items.push(
          { label: tr('在文件夹中显示'), icon: ICONS.folder, run: () => fileAction(loc, 'reveal') },
          '-',
          { label: tr('把路径插入输入框'), icon: ICONS.quote, run: () => insertIntoComposer(full) },
          { label: tr('复制完整路径'), icon: ICONS.copy, run: () => copyText(full, tr('已复制路径')) }
        );
        return openMenu(anchor, items, at);
      }
      if (isDir) {
        items.push(
          { label: tr('在文件管理器中打开'), icon: ICONS.open, run: () => fileAction(rel, 'open') },
          { label: tr('在这里打开终端'), icon: ICONS.terminal, run: () => TERM.openAt(rel) }
        );
      } else {
        items.push({ label: tr('预览'), icon: ICONS.eye, run: () => open(rel) });
        if (t.preview === 'html') items.push({ label: tr('在浏览器标签中打开'), icon: ICONS.web, run: () => BROWSER.openFile(rel) });
        if (t.kind !== 'exec') items.push({ label: tr('用默认程序打开'), icon: ICONS.open, run: () => fileAction(rel, 'open') });
        items.push(
          { label: tr('选择其他程序打开…'), icon: ICONS.apps, run: () => fileAction(rel, 'with') },
          { label: tr('在文件夹中显示'), icon: ICONS.folder, run: () => fileAction(rel, 'reveal') }
        );
      }
      items.push(
        '-',
        { label: tr('把路径插入输入框'), icon: ICONS.quote, run: () => insertIntoComposer(rel + (isDir ? '/' : '')) },
        { label: tr('复制完整路径'), icon: ICONS.copy, run: () => copyText(fullPath(rel), tr('已复制路径')) },
        { label: tr('复制相对路径'), icon: ICONS.copy, run: () => copyText(rel, tr('已复制相对路径')) }
      );
      openMenu(anchor, items, at);
    }

    async function onClick(e) {
      const t = e.target.closest('[data-tree-dir],[data-tree-file],[data-reveal-dir],[data-f],[data-f-mode]');
      if (!t) return;
      const s = st();
      const d = t.dataset;
      if (d.treeDir !== undefined) return toggleDir(d.treeDir);
      if (d.treeFile !== undefined) return open(d.treeFile);
      if (d.revealDir !== undefined) return revealDir(d.revealDir);
      if (d.fMode) {
        if (s.mode === d.fMode) return;
        s.mode = d.fMode;
        return renderPreview();
      }
      switch (d.f) {
        case 'refresh':
          return refresh();
        case 'reveal-root':
          return S.roomId && api('POST', `/api/rooms/${S.roomId}/open`).catch((err) => toast(err.message, true));
        case 'back':
          return close();
        case 'reload':
          s.ver++;
          return renderPreview();
        case 'menu':
          return menuFor(t, s.file, false, undefined, s.loc);
        case 'open':
          return fileAction(s.loc || s.file, fileType(s.file).kind === 'exec' ? 'reveal' : 'open');
        case 'with':
          return fileAction(s.loc || s.file, 'with');
        case 'browser':
          return BROWSER.openFile(s.file, s.loc);
        case 'reveal-file':
          return fileAction(s.loc || s.file, 'reveal');
        case 'copy-path':
          return copyText(fullPath(s.loc ? s.loc.full : s.file), tr('已复制路径'));
      }
    }

    function onContext(e) {
      const row = e.target.closest('[data-tree-dir],[data-tree-file],[data-reveal-dir]');
      if (!row) return;
      e.preventDefault();
      const d = row.dataset;
      const p = d.treeFile !== undefined ? d.treeFile : d.treeDir !== undefined ? d.treeDir : d.revealDir;
      menuFor(row, p, d.treeFile === undefined, { x: e.clientX, y: e.clientY });
    }

    // 成员这一轮改了文件：刷新受影响的文件夹；正在预览的文件被改了就重新读取
    function onFiles(roomId, list) {
      const s = states.get(roomId);
      if (!s || !list || !list.length) return;
      const dirs = new Set();
      for (const f of list) {
        let p = parentOf(f.path);
        for (;;) {
          dirs.add(p);
          if (!p) break;
          p = parentOf(p);
        }
      }
      const reload = [...dirs].filter((d) => s.dirs.has(d));
      const here = roomId === S.roomId && P.open && P.tab === 'files';
      for (const d of reload) {
        if (here) load(d);
        else s.dirs.delete(d);
      }
      if (s.file && list.some((f) => f.path === s.file)) {
        s.ver++;
        if (here) renderPreview();
      } else if (here && !s.file) renderList();
    }

    function onRoom() {
      if (P.open && P.tab === 'files') activate();
    }

    function refreshList() {
      const s = st();
      if (s && !s.file && !s.results) renderList();
    }

    return { mount, activate, open, onFiles, onRoom, refreshList, revealDir };
  })();

  // =====================================================================
  // 侧边对话：单独问某个成员，不发到群聊、不触发接力、只读
  // =====================================================================
  const SIDE = (() => {
    const data = new Map(); // roomId → { messages, running }
    const pickKey = (id) => `agentchat.side.${id}`;

    function mount() {
      const v = view('side');
      v.innerHTML = `
        <div class="pv-head side-head">
          <button type="button" class="side-who" id="sWho" data-s="who" data-menu-anchor aria-haspopup="menu" title="${tr('选择要问的成员')}"></button>
          <span class="grow"></span>
          <button type="button" class="icon-btn" data-s="clear" title="${tr('清空侧边对话')}" aria-label="${tr('清空侧边对话')}">${ICONS.trash}</button>
        </div>
        <div class="pv-scroll side-scroll" id="sScroll"><div class="side-list" id="sList"></div></div>
        <form class="side-composer" id="sForm" autocomplete="off">
          <textarea id="sInput" rows="1" spellcheck="false" aria-label="${tr('侧边对话的问题')}"></textarea>
          <div class="side-row"><span class="side-note">${tr('只读，不会发到群聊，也不会打断接力')}</span>
            <button type="submit" class="send-btn small" id="sSend" title="${tr('发送（Enter）')}" aria-label="${tr('发送')}">${ICONS.arrowUp}</button></div>
        </form>`;
      const input = $('#sInput');
      const grow = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      };
      input.addEventListener('input', grow);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        // 设置里选了「Ctrl+Enter 发送」：Enter 照常换行
        const ctrlMode = S.settings && S.settings.sendKey === 'ctrl-enter';
        if (e.key === 'Enter' && (ctrlMode ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.ctrlKey && !e.altKey)) {
          e.preventDefault();
          send();
        }
      });
      $('#sForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const cur = data.get(S.roomId);
        if (cur && cur.running) stop();
        else send();
      });
      v.addEventListener('click', onClick);
      setInterval(() => {
        const t = v.querySelector('.elapsed');
        if (t && P.open && P.tab === 'side') t.textContent = fmtClock(Date.now() - Number(t.dataset.since));
      }, 1000);
    }

    function picked() {
      const list = enabledAgents();
      if (!list.length) return null;
      const id = local.get(pickKey(S.roomId));
      return list.find((a) => a.id === id) || list[0];
    }

    async function ensure(roomId) {
      let d = data.get(roomId);
      if (d && d.loaded) return d;
      try {
        const r = await api('GET', `/api/rooms/${roomId}/side`);
        d = { messages: r.messages, running: r.running, loaded: true };
        data.set(roomId, d);
      } catch (e) {
        d = { messages: [], running: null, loaded: false, error: e.message };
      }
      return d;
    }

    async function activate() {
      if (!S.roomId) {
        $('#sList').innerHTML = noRoom(tr('侧边对话'));
        renderHead();
        return;
      }
      const roomId = S.roomId;
      const d = await ensure(roomId);
      if (roomId !== S.roomId) return;
      render(d, true);
    }

    function renderHead() {
      const who = $('#sWho');
      const a = S.roomId ? picked() : null;
      who.disabled = !a;
      who.innerHTML = a
        ? `<span class="avatar sm" style="--c:${a.color}">${esc(initial(a.name))}</span><span>${tr('问 {name}', { name: `<b style="--c:${a.color}">${esc(a.name)}</b>` })}</span>${ICONS.chevDown}`
        : `<span>${tr('还没有成员')}</span>`;
      const input = $('#sInput');
      const keys = S.settings && S.settings.sendKey === 'ctrl-enter' ? tr('（Ctrl+Enter 发送，Enter 换行）') : tr('（Enter 发送，Shift+Enter 换行）');
      input.placeholder = a ? tr('单独问 {name}……', { name: a.name }) + keys : tr('先在左边添加成员');
      input.disabled = !a;
    }

    function msgHtml(m) {
      if (m.from === 'user') {
        return `<div class="s-msg user"><div class="s-meta"><span>${esc(tr('问 {name}', { name: m.toName || '' }))}</span><span>${fmtTime(m.ts)}</span></div><div class="s-bubble">${esc(m.text)}</div></div>`;
      }
      const a = agentById(m.from);
      const color = a ? a.color : hashColor(m.name || '');
      const meta = [`<span>${fmtTime(m.ts)}</span>`];
      if (m.meta && m.meta.ms) meta.push(`<span>${tr('用时 {time}', { time: fmtDur(m.meta.ms) })}</span>`);
      return `<div class="s-msg agent" style="--c:${color}">
        <div class="s-who"><span class="avatar sm">${esc(initial(m.name))}</span><b>${esc(m.name)}</b><span class="s-meta">${meta.join('')}</span></div>
        ${m.text ? `<div class="md">${md(m.text)}</div>` : ''}
        ${m.status === 'error' ? `<div class="err"><b>${tr('出错了')}</b><pre>${esc(m.error || tr('未知错误'))}</pre></div>` : ''}
        ${m.status === 'stopped' ? `<div class="s-meta bad">${tr('已停止')}</div>` : ''}
        ${
          m.items && m.items.length
            ? `<details class="s-work"><summary>${ICONS.chev}${tr('查看了 {n} 步', { n: m.items.length })}</summary><ol class="work-list">${m.items.map(workItem).join('')}</ol></details>`
            : ''
        }
        ${
          m.text
            ? `<div class="s-actions"><button type="button" data-s-copy="${m.id}">${ICONS.copy}${tr('复制')}</button><button type="button" data-s-quote="${m.id}">${ICONS.quote}${tr('引用到群聊')}</button></div>`
            : ''
        }
      </div>`;
    }

    function liveHtml(run) {
      const a = agentById(run.agentId);
      const name = a ? a.name : tr('成员');
      return `<div class="s-msg agent live" style="--c:${a ? a.color : '#888'}">
        <div class="s-who"><span class="avatar sm">${esc(initial(name))}</span><b>${esc(name)}</b>
          <span class="s-meta live-status"><span class="now">${esc(run.status || tr('思考中'))}</span><span class="elapsed" data-since="${run.startedAt}">${fmtClock(Date.now() - run.startedAt)}</span></span></div>
        ${run.items && run.items.length ? `<ol class="work-list live-items">${run.items.slice(-4).map(workItem).join('')}</ol>` : ''}
        ${run.live ? `<div class="md live-text">${md(run.live)}</div>` : ''}
      </div>`;
    }

    function examples() {
      const list = enabledAgents();
      const other = list[1] || list[0];
      const qs = [
        tr('这个项目现在做到哪一步了？还差什么？'),
        other ? tr('{name} 上一轮改了哪些文件？为什么这么改？', { name: other.name }) : tr('最近改了哪些文件？'),
        tr('解释一下项目的目录结构'),
      ];
      return `<div class="pv-empty side-empty">
        <p>${tr('在这里单独问某位成员问题。它能看项目文件和群聊记录，但{a}，问答也{b}，正在进行的接力不受影响。', {
          a: `<b>${tr('不会改动任何文件')}</b>`,
          b: `<b>${tr('不会出现在群聊里')}</b>`,
        })}</p>
        <div class="examples">${qs.map((q) => `<button type="button" class="example" data-s-example="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
    }

    function render(d, toBottom) {
      renderHead();
      const box = $('#sList');
      const scroller = $('#sScroll');
      const stick = toBottom || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      if (d.error) box.innerHTML = `<div class="pv-empty"><p>${esc(d.error)}</p></div>`;
      else box.innerHTML = d.messages.length || d.running ? d.messages.map(msgHtml).join('') + (d.running ? liveHtml(d.running) : '') : examples();
      const btn = $('#sSend');
      btn.innerHTML = d.running ? ICONS.stopSq : ICONS.arrowUp;
      btn.title = d.running ? tr('停止回答') : tr('发送（Enter）');
      btn.setAttribute('aria-label', btn.title);
      if (stick) scroller.scrollTop = scroller.scrollHeight;
    }

    async function send() {
      const input = $('#sInput');
      const text = input.value.trim();
      const a = picked();
      if (!text || !a || !S.roomId) return;
      const roomId = S.roomId;
      input.value = '';
      input.style.height = 'auto';
      try {
        await api('POST', `/api/rooms/${roomId}/side`, { agentId: a.id, text });
      } catch (e) {
        if (!input.value) input.value = text;
        toast(e.message, true);
      }
    }

    function stop() {
      if (S.roomId) api('POST', `/api/rooms/${S.roomId}/side/stop`).catch((e) => toast(e.message, true));
    }

    async function onClick(e) {
      const t = e.target.closest('[data-s],[data-s-copy],[data-s-quote],[data-s-example]');
      if (!t || !S.roomId) return;
      const d = t.dataset;
      const cur = data.get(S.roomId);
      const find = (id) => cur && cur.messages.find((m) => m.id === id);
      if (d.sCopy) {
        const m = find(d.sCopy);
        if (m) copyText(m.text, tr('已复制'));
        return;
      }
      if (d.sQuote) {
        const m = find(d.sQuote);
        if (m) insertIntoComposer(`${tr('{name} 在侧边对话里说：', { name: m.name })}\n${m.text.split('\n').map((l) => '> ' + l).join('\n')}\n\n`);
        return;
      }
      if (d.sExample) {
        const input = $('#sInput');
        input.value = d.sExample;
        input.focus();
        input.dispatchEvent(new Event('input'));
        return;
      }
      if (d.s === 'who') {
        const list = enabledAgents();
        if (!list.length) return;
        openMenu(
          t,
          list.map((a) => ({
            label: `${a.name}${a.role ? ` · ${a.role}` : ''}`,
            icon: `<span class="avatar xs" style="--c:${a.color}">${esc(initial(a.name))}</span>`,
            checked: picked() && picked().id === a.id,
            run: () => {
              local.set(pickKey(S.roomId), a.id);
              renderHead();
              $('#sInput').focus();
            },
          })),
          { align: 'left' }
        );
        return;
      }
      if (d.s === 'clear') {
        if (!cur || (!cur.messages.length && !cur.running)) return;
        if (!(await ctx.confirmBox(tr('清空侧边对话'), tr('侧边对话的记录会全部删除，成员在侧边对话里的记忆也会清空。群聊不受影响。'), tr('清空'), true))) return;
        api('POST', `/api/rooms/${S.roomId}/side/clear`).catch((err) => toast(err.message, true));
      }
    }

    function onEvent(name, ev) {
      const d = data.get(ev.roomId);
      if (name === 'side-cleared') {
        if (d) Object.assign(d, { messages: [], running: null });
      } else if (!d) return;
      else if (name === 'side-message') {
        if (!d.messages.some((m) => m.id === ev.message.id)) d.messages.push(ev.message);
      } else if (name === 'side-progress') d.running = ev.running;
      if (d && ev.roomId === S.roomId && P.open && P.tab === 'side') render(d, name === 'side-message' && ev.message.from === 'user');
    }

    function onRoom() {
      if (P.open && P.tab === 'side') activate();
    }

    return { mount, activate, onEvent, onRoom, renderHead };
  })();

  // =====================================================================
  // 终端：真正的终端（node-pty + xterm.js），在项目文件夹里打开
  // =====================================================================
  const TERM = (() => {
    // 终端属于项目（同一个文件夹）：在项目里的会话之间切换时，终端都还在
    const scope = () => (S.room && S.room.projectId) || S.projectId || null;
    let lib = null;
    let available = null;
    let unavailable = '';
    const clients = new Map(); // 终端 id → { id, roomId, title, term, fit, box, seq, ready, pending, exited }
    const rooms = new Map(); // roomId → { active, synced, autoMade }

    const DARK = {
      black: '#1e1e1e', red: '#f14c4c', green: '#23d18b', yellow: '#e5e510', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#cccccc',
      brightBlack: '#6e6e6e', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
    };
    const LIGHT = {
      black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
      brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
    };
    function theme() {
      const css = getComputedStyle(document.documentElement);
      const v = (k) => css.getPropertyValue(k).trim();
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      return {
        background: v('--sheet'),
        foreground: v('--ink'),
        cursor: v('--ink'),
        cursorAccent: v('--sheet'),
        selectionBackground: dark ? 'rgba(124,155,234,0.38)' : 'rgba(63,106,216,0.24)',
        ...(dark ? DARK : LIGHT),
      };
    }

    function mount() {
      const v = view('term');
      v.innerHTML = `
        <div class="pv-head term-head">
          <div class="term-tabs" id="tTabs" role="tablist" aria-label="${tr('终端')}"></div>
          <button type="button" class="icon-btn" data-t="new" title="${tr('新建终端')}" aria-label="${tr('新建终端')}">${ICONS.plus}</button>
          <span class="grow"></span>
          <button type="button" class="icon-btn" data-t="clear" title="${tr('清屏')}" aria-label="${tr('清屏')}">${ICONS.eraser}</button>
          <button type="button" class="icon-btn" data-t="kill" title="${tr('关闭这个终端')}" aria-label="${tr('关闭这个终端')}">${ICONS.trash}</button>
        </div>
        <div class="term-host" id="tHost"></div>
        <div class="pv-empty term-empty" id="tEmpty" hidden></div>`;
      v.addEventListener('click', onClick);
      new ResizeObserver(() => fit()).observe($('#tHost'));
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        for (const c of clients.values()) c.term.options.theme = theme();
      });
    }

    function loadLib() {
      if (lib) return lib;
      lib = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'vendor/xterm/xterm.css';
        document.head.append(css);
        const files = ['vendor/xterm/xterm.js', 'vendor/xterm/addon-fit.js', 'vendor/xterm/addon-web-links.js'];
        let i = 0;
        const next = () => {
          if (i >= files.length) return resolve();
          const s = document.createElement('script');
          s.src = files[i++];
          s.onload = next;
          s.onerror = () => reject(new Error(tr('终端组件加载失败')));
          document.head.append(s);
        };
        next();
      });
      lib.catch(() => (lib = null));
      return lib;
    }

    const roomInfo = (id) => {
      let r = rooms.get(id);
      if (!r) rooms.set(id, (r = { active: null, syncing: null, autoMade: false }));
      return r;
    };

    // 第一次用到某个项目的终端时，先接回服务端还开着的终端（比如界面刷新过）。
    // 新建终端也要等这一步做完，免得同一个终端被接上两次
    function ensureSynced(roomId) {
      const r = roomInfo(roomId);
      if (!r.syncing) {
        r.syncing = (async () => {
          await loadLib();
          const st = await api('GET', `/api/term?room=${encodeURIComponent(roomId)}`);
          available = st.available;
          unavailable = st.error;
          for (const info of st.terminals) if (!clients.has(info.id)) await attach(info);
        })();
        r.syncing.catch(() => (r.syncing = null));
      }
      return r.syncing;
    }
    const roomClients = (id) => [...clients.values()].filter((c) => c.roomId === id).sort((a, b) => a.createdAt - b.createdAt);
    const active = () => {
      if (!scope()) return null;
      const r = roomInfo(scope());
      return clients.get(r.active) || roomClients(scope())[0] || null;
    };
    const visible = () => P.open && P.tab === 'term';

    async function activate() {
      const empty = $('#tEmpty');
      if (!scope()) {
        showOnly(null);
        empty.hidden = false;
        empty.innerHTML = noRoom(tr('终端'));
        renderTabs();
        return;
      }
      const roomId = scope();
      try {
        await ensureSynced(roomId);
        const r = roomInfo(roomId);
        if (available === false) {
          showOnly(null);
          empty.hidden = false;
          empty.innerHTML = `<p>${esc(tr('终端不可用：{why}', { why: unavailable || tr('未知原因') }))}</p>`;
          return;
        }
        if (roomId !== scope()) return;
        if (!roomClients(roomId).length && !r.autoMade) {
          r.autoMade = true;
          await create();
          return;
        }
        render();
      } catch (e) {
        empty.hidden = false;
        empty.innerHTML = `<p>${esc(e.message)}</p>`;
      }
    }

    function render() {
      const c = active();
      renderTabs();
      showOnly(c);
      const empty = $('#tEmpty');
      empty.hidden = !!c;
      if (!c) {
        empty.innerHTML = `<p>${tr('这个项目还没有打开的终端。')}</p><button type="button" class="btn small primary" data-t="new">${ICONS.plus}${tr('新建终端')}</button>`;
        return;
      }
      if (visible()) {
        requestAnimationFrame(() => {
          fit();
          c.term.focus();
        });
      }
    }

    function renderTabs() {
      const list = scope() ? roomClients(scope()) : [];
      const cur = active();
      $('#tTabs').innerHTML = list
        .map(
          (c) =>
            `<button type="button" role="tab" class="term-tab${c.exited ? ' exited' : ''}" data-t-tab="${c.id}" aria-selected="${c === cur}" title="${esc(
              [c.shell, c.cwd].filter(Boolean).join(' · ') // 鼠标移上去能看到终端开在哪个文件夹
            )}${c.exited ? tr('（已结束）') : ''}">${ICONS.terminal}<span>${esc(c.title)}</span><span class="x" data-t-close="${c.id}" title="${tr('关闭')}" aria-label="${tr('关闭')}">${ICONS.close}</span></button>`
        )
        .join('');
      view('term').querySelector('[data-t="kill"]').disabled = !cur;
      view('term').querySelector('[data-t="clear"]').disabled = !cur;
    }

    function showOnly(c) {
      for (const x of clients.values()) x.box.hidden = x !== c;
    }

    function makeClient(info) {
      const term = new window.Terminal({
        fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 8000,
        theme: theme(),
      });
      const fitter = new window.FitAddon.FitAddon();
      term.loadAddon(fitter);
      term.loadAddon(
        new window.WebLinksAddon.WebLinksAddon((ev, uri) => {
          if (ev && ev.preventDefault) ev.preventDefault();
          BROWSER.open(uri);
        })
      );
      const box = el('<div class="term-pane"></div>');
      box.hidden = true;
      $('#tHost').append(box);
      term.open(box);
      const c = { ...info, term, fit: fitter, box, seq: 0, ready: false, pending: [], queue: '', sending: false, cols: 0, rows: 0 };
      term.onData((d) => input(c, d));
      term.attachCustomKeyEventHandler((e) => keys(c, e));
      box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(c, e);
      });
      return c;
    }

    // Ctrl+C：选中了文字就复制，没选中就照常发给程序（中断）；Ctrl+V 粘贴
    function keys(c, e) {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'c' && (e.shiftKey || c.term.hasSelection())) {
        if (c.term.hasSelection()) {
          copyText(c.term.getSelection(), null);
          c.term.clearSelection();
        }
        e.preventDefault();
        return false;
      }
      if (ctrl && k === 'v') return false; // 交给浏览器的粘贴事件，xterm 自己会处理
      if (ctrl && (e.key === '`' || k === 'j')) return false; // 留给全局快捷键（切换面板）
      return true;
    }

    async function paste(c) {
      let text = '';
      try {
        text = desktop && desktop.paste ? await desktop.paste() : await navigator.clipboard.readText();
      } catch {}
      if (text) c.term.paste(text);
      c.term.focus();
    }

    function contextMenu(c, e) {
      openMenu(
        c.box,
        [
          { label: tr('复制'), icon: ICONS.copy, disabled: !c.term.hasSelection(), run: () => copyText(c.term.getSelection(), null) },
          { label: tr('粘贴'), icon: ICONS.quote, run: () => paste(c) },
          { label: tr('全选'), icon: ICONS.check, run: () => c.term.selectAll() },
          '-',
          { label: tr('清屏'), icon: ICONS.eraser, run: () => c.term.clear() },
        ],
        { x: e.clientX, y: e.clientY }
      );
    }

    function input(c, d) {
      if (!c.id || c.exited) return;
      c.queue += d;
      if (c.sending) return;
      c.sending = true;
      (async () => {
        while (c.queue) {
          const data = c.queue;
          c.queue = '';
          try {
            await api('POST', `/api/term/${c.id}/input`, { data });
          } catch {
            c.queue = '';
            break;
          }
        }
        c.sending = false;
      })();
    }

    // 接上服务端的终端：先把之前的输出补上，之后的输出按序号接着写，不重复也不漏
    async function sync(c) {
      const r = await api('GET', `/api/term/${c.id}`);
      if (r.buffer) c.term.write(r.buffer);
      c.seq = r.seq || 0;
      c.exited = r.exited;
      c.ready = true;
      for (const p of c.pending) {
        if (p.seq > c.seq) {
          c.term.write(p.data);
          c.seq = p.seq;
        }
      }
      c.pending = [];
      if (c.exited) exitNote(c, r.code);
    }

    async function attach(info) {
      const c = makeClient(info);
      clients.set(info.id, c);
      try {
        await sync(c);
      } catch {
        dispose(c);
      }
      return c;
    }

    async function create(cwdRel) {
      if (!scope()) return;
      const roomId = scope();
      await ensureSynced(roomId);
      if (available === false) return toast(tr('终端不可用：{why}', { why: unavailable || tr('未知原因') }), true);
      const c = makeClient({ id: '', roomId, title: tr('终端'), createdAt: Date.now() });
      showOnly(c);
      $('#tEmpty').hidden = true;
      try {
        c.fit.fit();
      } catch {}
      let info;
      try {
        info = await api('POST', '/api/term', { roomId, cols: c.term.cols, rows: c.term.rows });
      } catch (e) {
        dispose(c);
        toast(e.message, true);
        return;
      }
      Object.assign(c, info, { cols: c.term.cols, rows: c.term.rows });
      clients.set(c.id, c);
      roomInfo(roomId).active = c.id;
      await sync(c).catch(() => {});
      if (cwdRel) input(c, `cd "${cwdRel.replace(/"/g, '')}"\r`);
      if (roomId === scope()) render();
    }

    function dispose(c) {
      clients.delete(c.id);
      try {
        c.term.dispose();
      } catch {}
      c.box.remove();
    }

    async function kill(c) {
      if (!c) return;
      const r = roomInfo(c.roomId);
      dispose(c);
      if (r.active === c.id) r.active = (roomClients(c.roomId).pop() || {}).id || null;
      api('DELETE', `/api/term/${c.id}`).catch(() => {});
      if (c.roomId === scope()) render();
    }

    // ev：服务端的 term-exit 事件。换了项目文件夹时服务端会关掉旧终端（reason: 'moved'），写明原因
    function exitNote(c, code, ev = {}) {
      const note =
        ev.reason === 'moved'
          ? tr('项目文件夹换成了 {path}，这个终端还在原来的文件夹，已经关掉。点右上角的 + 在新文件夹里打开终端', { path: ev.to || '' })
          : code != null
            ? tr('进程已结束，退出码 {code}。点右上角的 + 再开一个终端', { code })
            : tr('进程已结束。点右上角的 + 再开一个终端');
      c.term.write(`\r\n\x1b[90m[${note}]\x1b[0m\r\n`);
    }

    function fit() {
      const c = active();
      if (!c || !visible() || c.box.hidden || !c.box.offsetWidth) return;
      try {
        c.fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = c.term;
      if (c.id && !c.exited && (cols !== c.cols || rows !== c.rows)) {
        c.cols = cols;
        c.rows = rows;
        clearTimeout(c.resizeTimer);
        c.resizeTimer = setTimeout(() => api('POST', `/api/term/${c.id}/resize`, { cols, rows }).catch(() => {}), 80);
      }
    }

    function onClick(e) {
      const close = e.target.closest('[data-t-close]');
      if (close) {
        e.stopPropagation();
        return kill(clients.get(close.dataset.tClose));
      }
      const tab = e.target.closest('[data-t-tab]');
      if (tab) {
        roomInfo(scope()).active = tab.dataset.tTab;
        return render();
      }
      const b = e.target.closest('[data-t]');
      if (!b) return;
      const c = active();
      if (b.dataset.t === 'new') create().catch((err) => toast(err.message, true));
      else if (b.dataset.t === 'kill') kill(c);
      else if (b.dataset.t === 'clear' && c) {
        c.term.clear();
        c.term.focus();
      }
    }

    function onEvent(name, ev) {
      const c = clients.get(ev.id);
      if (!c) return;
      if (name === 'term') {
        if (!c.ready) c.pending.push(ev);
        else if (ev.seq > c.seq) {
          c.term.write(ev.data);
          c.seq = ev.seq;
        }
      } else if (name === 'term-exit') {
        c.exited = true;
        exitNote(c, ev.code, ev);
        if (c.roomId === scope()) renderTabs();
      }
    }

    // 文件面板里「在这里打开终端」
    async function openAt(rel) {
      if (scope()) roomInfo(scope()).autoMade = true;
      show('term');
      await create(rel);
    }

    function onRoom() {
      if (visible()) activate();
      else showOnly(null);
    }

    return { mount, activate, onEvent, onRoom, fit, openAt };
  })();

  // =====================================================================
  // 浏览器：桌面版用 <webview>（真正的浏览器标签），浏览器版退回 iframe
  // =====================================================================
  const BROWSER = (() => {
    const real = !!(desktop && desktop.webview);
    let frame = null;
    let current = '';
    let loading = false;

    function mount() {
      const v = view('browser');
      v.innerHTML = `
        <div class="pv-head browser-bar">
          <button type="button" class="icon-btn" data-b="back" title="${tr('后退')}" aria-label="${tr('后退')}" disabled>${ICONS.back}</button>
          <button type="button" class="icon-btn" data-b="forward" title="${tr('前进')}" aria-label="${tr('前进')}" disabled>${ICONS.forward}</button>
          <button type="button" class="icon-btn" data-b="reload" title="${tr('刷新')}" aria-label="${tr('刷新')}">${ICONS.refresh}</button>
          <button type="button" class="icon-btn" data-b="home" title="${tr('起始页')}" aria-label="${tr('起始页')}">${ICONS.home}</button>
          <form class="url-form" id="bForm"><input class="url-input" id="bUrl" placeholder="${tr('输入网址，例如 localhost:5173')}" spellcheck="false" autocomplete="off" aria-label="${tr('网址')}"></form>
          ${real ? `<button type="button" class="icon-btn" data-b="devtools" title="${tr('开发者工具')}" aria-label="${tr('开发者工具')}">${ICONS.code}</button>` : ''}
          <button type="button" class="icon-btn" data-b="external" title="${tr('在系统浏览器中打开')}" aria-label="${tr('在系统浏览器中打开')}">${ICONS.open}</button>
        </div>
        <div class="browser-host" id="bHost">
          <div class="pv-scroll browser-start" id="bStart"></div>
          <div class="browser-error" id="bError" hidden></div>
        </div>`;
      $('#bForm').addEventListener('submit', (e) => {
        e.preventDefault();
        go($('#bUrl').value);
      });
      $('#bUrl').addEventListener('focus', (e) => e.target.select());
      v.addEventListener('click', onClick);
    }

    function activate() {
      if (!current) renderStart();
    }

    function normalize(s) {
      s = String(s || '').trim();
      if (!s) return '';
      if (/^[a-z]:[\\/]/i.test(s)) return encodeURI('file:///' + s.replace(/\\/g, '/'));
      if (/^(https?|file):/i.test(s) || s === 'about:blank') return s;
      if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
      if (/^\d{2,5}$/.test(s)) return `http://localhost:${s}/`;
      if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s)) return 'https://' + s;
      return 'https://www.bing.com/search?q=' + encodeURIComponent(s);
    }

    function ensureFrame() {
      if (frame) return frame;
      const host = $('#bHost');
      if (real) {
        frame = document.createElement('webview');
        frame.setAttribute('partition', 'persist:agentchat-browser');
        frame.setAttribute('allowpopups', '');
        frame.addEventListener('did-start-loading', () => setLoading(true));
        frame.addEventListener('did-stop-loading', () => setLoading(false));
        frame.addEventListener('did-navigate', (e) => setUrl(e.url));
        frame.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && setUrl(e.url));
        frame.addEventListener('did-fail-load', (e) => {
          if (!e.isMainFrame || e.errorCode === -3) return;
          showError(e.validatedURL || current, e.errorDescription || tr('错误 {code}', { code: e.errorCode }));
        });
      } else {
        frame = document.createElement('iframe');
        frame.setAttribute('allow', 'clipboard-write; fullscreen');
        frame.addEventListener('load', () => setLoading(false));
      }
      frame.className = 'browser-frame off';
      host.append(frame);
      return frame;
    }

    function go(input) {
      const url = normalize(input);
      if (!url) return;
      ensureFrame();
      $('#bStart').hidden = true;
      $('#bError').hidden = true;
      frame.classList.remove('off');
      current = url;
      $('#bUrl').value = url;
      setLoading(true);
      frame.src = url;
      if (!real) navButtons();
    }

    function open(url) {
      show('browser');
      go(url);
    }

    // 项目里的网页：桌面版直接用 file:// 打开（本地存储等都能用），浏览器版走预览地址。
    // loc：别的项目里的文件（见 app.js 的 locate），借那个项目的会话来读
    function openFile(rel, loc) {
      if (real) open('file:///' + (loc ? loc.full : fullPath(rel).replace(/\\/g, '/')));
      else open(location.origin + fileUrl(rel, loc && loc.roomId));
    }

    function setUrl(url) {
      current = url;
      if (document.activeElement !== $('#bUrl')) $('#bUrl').value = url === 'about:blank' ? '' : url;
      $('#bError').hidden = true;
      navButtons();
    }

    function setLoading(on) {
      loading = on;
      const b = view('browser').querySelector('[data-b="reload"]');
      b.innerHTML = on ? ICONS.close : ICONS.refresh;
      b.title = on ? tr('停止') : tr('刷新');
      navButtons();
    }

    function navButtons() {
      const v = view('browser');
      const can = (fn) => {
        try {
          return !!(real && frame && frame[fn]());
        } catch {
          return false;
        }
      };
      v.querySelector('[data-b="back"]').disabled = !can('canGoBack');
      v.querySelector('[data-b="forward"]').disabled = !can('canGoForward');
    }

    function showError(url, why) {
      const box = $('#bError');
      box.hidden = false;
      box.innerHTML = `<div class="pv-empty"><p><b>${tr('打不开这个网页')}</b></p><p class="hint">${esc(url)}<br>${esc(why)}</p>
        <p class="hint">${tr('如果是本机的开发服务器，先确认它已经启动（比如在终端里运行 npm run dev）。')}</p>
        <button type="button" class="btn small" data-b="reload">${tr('重试')}</button></div>`;
    }

    async function renderStart() {
      const box = $('#bStart');
      box.hidden = false;
      if (frame) frame.classList.add('off');
      $('#bError').hidden = true;
      current = '';
      $('#bUrl').value = '';
      navButtons();
      box.innerHTML = `<div class="b-start">
        <h3>${tr('打开网页')}</h3>
        <p class="hint">${tr('在上面输入网址，或者从下面选一个。')}${real ? '' : tr('浏览器版里网页是嵌在页面里显示的，有些网站不允许这样打开；exe 版没有这个限制。')}</p>
        <div class="b-sec"><div class="b-sec-head">${tr('本机正在运行的网页')}<button type="button" class="link-btn" data-b="scan">${tr('重新查找')}</button></div><div id="bPorts" class="b-links"><span class="hint">${tr('正在查找……')}</span></div></div>
        <div class="b-sec"><div class="b-sec-head">${tr('项目里的网页')}</div><div id="bPages" class="b-links"><span class="hint">${S.roomId ? tr('正在查找……') : tr('先打开一个项目')}</span></div></div>
      </div>`;
      scanPorts();
      if (S.roomId) {
        try {
          const r = await api('GET', `/api/rooms/${S.roomId}/find?q=.html&limit=12`);
          const pages = r.results.filter((x) => !x.dir && /\.html?$/i.test(x.path));
          const out = $('#bPages');
          if (out)
            out.innerHTML = pages.length
              ? pages.map((p) => `<button type="button" class="b-link" data-b-file="${esc(p.path)}">${ICONS.web}<span>${esc(p.path)}</span></button>`).join('')
              : `<span class="hint">${tr('项目里还没有 .html 文件')}</span>`;
        } catch {}
      }
    }

    async function scanPorts() {
      const out = $('#bPorts');
      if (!out) return;
      out.innerHTML = `<span class="hint">${tr('正在查找……')}</span>`;
      try {
        const r = await api('GET', '/api/ports');
        if (!$('#bPorts')) return;
        out.innerHTML = r.ports.length
          ? r.ports.map((p) => `<button type="button" class="b-link" data-b-url="${esc(p.url)}">${ICONS.web}<span>${esc(p.url)}</span></button>`).join('')
          : `<span class="hint">${tr('没有发现。AI 或你在终端里启动开发服务器（比如 npm run dev）后，点「重新查找」。')}</span>`;
      } catch {
        out.innerHTML = `<span class="hint">${tr('查找失败')}</span>`;
      }
    }

    function onClick(e) {
      const link = e.target.closest('[data-b-url],[data-b-file]');
      if (link) {
        if (link.dataset.bUrl) go(link.dataset.bUrl);
        else openFile(link.dataset.bFile);
        return;
      }
      const b = e.target.closest('[data-b]');
      if (!b) return;
      switch (b.dataset.b) {
        case 'back':
          if (real && frame) frame.goBack();
          break;
        case 'forward':
          if (real && frame) frame.goForward();
          break;
        case 'reload':
          if (!current) return renderStart();
          if (loading && real && frame) frame.stop();
          else if (real && frame && !$('#bError').hidden) go(current);
          else if (real && frame) frame.reload();
          else go(current);
          break;
        case 'home':
          renderStart();
          break;
        case 'scan':
          scanPorts();
          break;
        case 'devtools':
          if (real && frame && current) frame.openDevTools();
          break;
        case 'external':
          if (!current) return;
          if (/^https?:/i.test(current)) window.open(current, '_blank', 'noopener');
          else toast(tr('本地文件请用文件面板里的「用默认程序打开」'));
          break;
      }
    }

    function onRoom() {
      if (P.open && P.tab === 'browser' && !current) renderStart();
    }

    return { mount, activate, open, openFile, onRoom };
  })();

  // ---------- 给 app.js 用的接口 ----------
  return {
    mount,
    show,
    hide,
    toggle,
    state: () => ({ ...P }),
    openFile: (rel, loc) => FILES.open(rel, loc),
    // 打开文件面板，在树里展开到这个文件夹（消息里附上的文件夹）
    showDir(rel) {
      show('files');
      FILES.revealDir(rel);
    },
    openUrl: (url) => BROWSER.open(url),
    openHtmlInBrowser: (rel) => BROWSER.openFile(rel),
    onRoom() {
      FILES.onRoom();
      SIDE.onRoom();
      TERM.onRoom();
      BROWSER.onRoom();
    },
    onMembers() {
      if (P.open && P.tab === 'side') SIDE.renderHead();
    },
    onFiles: (roomId, list) => FILES.onFiles(roomId, list),
    onMessages() {
      if (P.open && P.tab === 'files') FILES.refreshList();
    },
    onEvent(name, data) {
      if (name.startsWith('side')) SIDE.onEvent(name, data);
      else if (name.startsWith('term')) TERM.onEvent(name, data);
    },
  };
};
