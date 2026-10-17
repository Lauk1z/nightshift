'use strict';
// 演示项目里「成员做出来的」待办清单网页：index.html（含样式）+ src/app.js + tests/app.test.js
// 右侧面板的文件预览会真的把它打开，所以要能用、要好看
module.exports = function todoFiles(c) {
  const p = c.page;
  const lang = c.locale;
  const tasks = p.tasks.map(([group, title, tags], i) => ({ id: 't' + (i + 1), title, tags, group }));
  const css = cssText();
  const index = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<style>
${css}</style>
</head>
<body>
<main class="app">
  <header class="top">
    <div>
      <h1>${p.title}</h1>
      <p class="date" id="date"></p>
    </div>
    <div class="progress"><span id="progress"></span><span class="bar"><i id="bar"></i></span></div>
  </header>
  <form class="add" id="add">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>
    <input id="title" placeholder="${p.placeholder}" autocomplete="off">
    <kbd>N</kbd>
  </form>
  <nav class="tags" id="tags"></nav>
  <section class="board" id="board"></section>
</main>
<script src="src/app.js"></script>
</body>
</html>
`;

  // 样式直接写在 index.html 里（Claude 只建了两个文件）
  function cssText() {
    return `:root {
  --bg: #f2f4f8;
  --lane: #e8ecf3;
  --card: #ffffff;
  --ink: #1b2232;
  --muted: #6a7386;
  --line: #dde2ec;
  --accent: #3e63dd;
  --ok: #2f9e66;
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--ink);
  background: var(--bg);
}
* { box-sizing: border-box; }
body { margin: 0; }
.app { max-width: 1040px; margin: 0 auto; padding: 28px 22px 40px; }
.top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
h1 { font-size: 28px; line-height: 1.1; letter-spacing: -0.01em; margin: 0; }
.date { color: var(--muted); margin: 6px 0 0; font-size: 14px; }
.progress { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); white-space: nowrap; }
.bar { width: 88px; height: 6px; border-radius: 99px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: inherit; background: var(--ok); transition: width .3s; }
.add { margin-top: 20px; display: flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; box-shadow: 0 1px 2px rgba(16, 24, 40, .05); }
.add:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(62, 99, 221, .15); }
.add svg { width: 18px; height: 18px; fill: none; stroke: var(--muted); stroke-width: 1.8; stroke-linecap: round; flex: none; }
.add input { flex: 1; min-width: 0; border: 0; outline: 0; font: inherit; font-size: 15px; padding: 13px 0; background: transparent; color: inherit; }
kbd { font: 12px ui-monospace, Consolas, monospace; color: var(--muted); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 6px; padding: 1px 6px; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 18px; }
.tags button { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 99px; padding: 5px 13px; cursor: pointer; }
.tags button[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: #fff; }
.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
@media (max-width: 720px) { .board { grid-template-columns: 1fr; gap: 12px; } }
.group { background: var(--lane); border-radius: 14px; padding: 10px 10px 4px; min-height: 96px; }
.group.over { outline: 2px dashed var(--accent); outline-offset: -2px; }
.group h2 { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; color: var(--muted); margin: 4px 6px 10px; }
.card { display: flex; align-items: flex-start; gap: 10px; background: var(--card); border-radius: 10px; padding: 11px 12px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(16, 24, 40, .06), 0 0 0 1px rgba(16, 24, 40, .04); cursor: grab; outline: none; }
.card:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.card.dragging { opacity: .45; }
.check { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; border: 1.5px solid #b6bfcd; background: #fff; display: grid; place-items: center; cursor: pointer; padding: 0; }
.check svg { width: 10px; height: 10px; fill: none; stroke: #fff; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
.card.is-done .check { background: var(--ok); border-color: var(--ok); }
.card.is-done .check svg { opacity: 1; }
.card.is-done .title { color: var(--muted); text-decoration: line-through; }
.title { font-size: 14px; line-height: 1.45; }
.chips { display: flex; gap: 6px; margin-top: 6px; }
.chip { font-size: 12px; line-height: 18px; padding: 0 8px; border-radius: 99px; background: #eef1f6; color: var(--muted); }
.chip.work { background: #e6edfe; color: #3451b2; }
.chip.life { background: #e6f4ec; color: #1f7a4d; }
.chip.study { background: #f1e8fc; color: #7a3db8; }
.hint { font-size: 13px; color: var(--muted); text-align: center; padding: 14px 0 18px; }
`;
  }

  const js = `'use strict';
// ${p.title}：三个分组（${p.groups.today} / ${p.groups.later} / ${p.groups.done}），拖动换分组，#标签筛选，数据存在 localStorage
const KEY = 'todo.tasks.v1';
const GROUPS = ${JSON.stringify(Object.entries(p.groups))};
const TAG_CLASS = ${JSON.stringify(p.tags)};
const TEXT = ${JSON.stringify({ all: p.all, done: p.done, empty: p.empty, confirmDelete: p.confirmDelete })};
const DEFAULTS = ${JSON.stringify(tasks, null, 2).replace(/\n/g, '\n')};

// 标题里的 #标签 拿出来
function parseTitle(text) {
  const tags = [];
  const title = text.replace(/#(\\S+)/g, (_, t) => (tags.push(t), '')).replace(/\\s+/g, ' ').trim();
  return { title, tags };
}

// 松手的位置在这个分组的第几张卡片前面；空分组或者在最后一张下面，就放到末尾
function dropIndex(cards, y) {
  const i = cards.findIndex((r) => y < r.top + r.height / 2);
  return i < 0 ? cards.length : i;
}

function moveTask(tasks, id, group, index) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return tasks;
  const rest = tasks.filter((x) => x !== t);
  t.group = group;
  const same = rest.filter((x) => x.group === group);
  const anchor = same[index];
  rest.splice(anchor ? rest.indexOf(anchor) : rest.length, 0, t);
  return rest;
}

if (typeof module !== 'undefined') module.exports = { parseTitle, dropIndex, moveTask };

if (typeof document !== 'undefined') {
  let tasks = load();
  let filter = '';
  const $ = (s) => document.querySelector(s);
  const fmt = (s, v) => s.replace(/\\{(\\w+)\\}/g, (_, k) => v[k]);

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || DEFAULTS;
    } catch {
      return DEFAULTS;
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(tasks));
    } catch {}
  }

  function render() {
    $('#date').textContent = new Date().toLocaleDateString('${lang}', { month: 'long', day: 'numeric', weekday: 'long' });
    const done = tasks.filter((t) => t.group === 'done').length;
    $('#progress').textContent = fmt(TEXT.done, { n: done, total: tasks.length });
    $('#bar').style.width = (tasks.length ? (done / tasks.length) * 100 : 0) + '%';
    const tags = [...new Set(tasks.flatMap((t) => t.tags))];
    $('#tags').innerHTML = ['', ...tags].map((t) => \`<button type="button" data-tag="\${t}" aria-pressed="\${t === filter}">\${t ? '#' + t : TEXT.all}</button>\`).join('');
    $('#board').innerHTML = GROUPS.map(([g, name]) => {
      const list = tasks.filter((t) => t.group === g && (!filter || t.tags.includes(filter)));
      return \`<div class="group" data-group="\${g}"><h2><span>\${name}</span><span>\${list.length}</span></h2>\${list.map(card).join('') || \`<p class="hint">\${TEXT.empty}</p>\`}</div>\`;
    }).join('');
  }

  function card(t) {
    const chips = t.tags.map((x) => \`<span class="chip \${TAG_CLASS[x] || ''}">#\${x}</span>\`).join('');
    return \`<article class="card \${t.group === 'done' ? 'is-done' : ''}" draggable="true" tabindex="0" data-id="\${t.id}">
      <button type="button" class="check" aria-label="done"><svg viewBox="0 0 10 10"><path d="M2 5.2 4.2 7.4 8 2.8"/></svg></button>
      <div><div class="title">\${t.title}</div>\${chips ? \`<div class="chips">\${chips}</div>\` : ''}</div></article>\`;
  }

  function toggle(id) {
    const t = tasks.find((x) => x.id === id);
    if (t) t.group = t.group === 'done' ? 'today' : 'done';
    save();
    render();
  }

  $('#add').addEventListener('submit', (e) => {
    e.preventDefault();
    const { title, tags } = parseTitle($('#title').value);
    if (!title) return;
    tasks.unshift({ id: 't' + Date.now(), title, tags, group: 'today' });
    $('#title').value = '';
    save();
    render();
  });
  document.addEventListener('click', (e) => {
    const tag = e.target.closest('[data-tag]');
    if (tag) {
      filter = tag.dataset.tag;
      render();
    }
    const check = e.target.closest('.check');
    if (check) toggle(check.closest('.card').dataset.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input')) return;
    const c = e.target.closest && e.target.closest('.card');
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      $('#title').focus();
    } else if (c && e.key === ' ') {
      e.preventDefault();
      toggle(c.dataset.id);
    } else if (c && e.key === 'Delete') {
      const t = tasks.find((x) => x.id === c.dataset.id);
      if (t && confirm(fmt(TEXT.confirmDelete, { title: t.title }))) {
        tasks = tasks.filter((x) => x !== t);
        save();
        render();
      }
    }
  });
  document.addEventListener('dragstart', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    e.dataTransfer.setData('text/plain', c.dataset.id);
    c.classList.add('dragging');
  });
  document.addEventListener('dragend', (e) => e.target.classList && e.target.classList.remove('dragging'));
  document.addEventListener('dragover', (e) => {
    const g = e.target.closest('.group');
    if (!g) return;
    e.preventDefault();
    document.querySelectorAll('.group.over').forEach((x) => x !== g && x.classList.remove('over'));
    g.classList.add('over');
  });
  document.addEventListener('drop', (e) => {
    const list = e.target.closest('.group');
    if (!list) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const rects = [...list.querySelectorAll('.card:not(.dragging)')].map((x) => x.getBoundingClientRect());
    tasks = moveTask(tasks, id, list.dataset.group, dropIndex(rects, e.clientY));
    save();
    render();
  });
  render();
}
`;

  const test = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTitle, dropIndex, moveTask } = require('../src/app.js');

test('#标签 会从标题里拿出来', () => {
  assert.deepStrictEqual(parseTitle('${p.tasks[0][1]} #${p.tasks[0][2][0]}'), { title: '${p.tasks[0][1]}', tags: ['${p.tasks[0][2][0]}'] });
});

test('空分组：放到末尾', () => {
  assert.strictEqual(dropIndex([], 120), 0);
});

test('拖到第一张卡片上半部分：放到最前面', () => {
  assert.strictEqual(dropIndex([{ top: 100, height: 40 }, { top: 150, height: 40 }], 110), 0);
});

test('换分组时保留其他卡片的顺序', () => {
  const tasks = [
    { id: 'a', group: 'today' },
    { id: 'b', group: 'today' },
    { id: 'c', group: 'later' },
  ];
  const out = moveTask(tasks, 'a', 'later', 1);
  assert.deepStrictEqual(out.map((t) => t.id + ':' + t.group), ['b:today', 'c:later', 'a:later']);
});
`;

  return {
    'index.html': index,
    'src/app.js': js,
    'tests/app.test.js': test,
    'docs/design.md': c.design,
    'README.md': c.readme.p_todo,
  };
};
