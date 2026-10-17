'use strict';
// README 截图用的演示数据：设置里的名字和外观、四个项目、八个会话和消息、一年的用量。不会调用任何 AI。
// variant：live = DeepSeek 还没发言，截图时再让替身 dsh 跑起来（停在「正在运行」）；done = DeepSeek 已经检查完
const fs = require('fs');
const path = require('path');
const CONTENT = require('./content');
const todoFiles = require('./todo-app');

const MIN = 60e3;
const H = 60 * MIN;
const D = 24 * H;

// dataDir：Nightshift 的数据文件夹（AGENT_CHAT_DATA），先清空；wsRoot：四个项目文件夹放在这里面
function seed({ lang, variant, theme, dataDir, wsRoot }) {
  const c = CONTENT[lang];
  if (!c) throw new Error('不认识的语言：' + lang);

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const write = (f, s) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s, null, 2));
  };

  write(path.join(dataDir, 'settings.json'), { name: c.userName, color: '#2B7BB9', theme, language: lang, sendKey: 'enter', notify: false });

  const now = Date.now();

  // ---------- 项目文件夹 ----------
  const folders = { p_todo: 'todo-app', p_blog: 'blog', p_dash: 'sales-dashboard', p_weekly: 'weekly-report' };
  const ws = {};
  for (const [pid, dir] of Object.entries(folders)) {
    ws[pid] = path.join(wsRoot, dir);
    fs.rmSync(ws[pid], { recursive: true, force: true });
    write(path.join(ws[pid], 'README.md'), c.readme[pid]);
  }
  for (const [f, s] of Object.entries(todoFiles(c))) write(path.join(ws.p_todo, f), s);

  // ---------- 项目 ----------
  const projects = [
    { id: 'p_todo', createdAt: now - 2 * D },
    { id: 'p_blog', createdAt: now - 9 * D },
    { id: 'p_dash', createdAt: now - 20 * D },
    { id: 'p_weekly', createdAt: now - 40 * D },
  ];
  projects.forEach((p, i) =>
    write(path.join(dataDir, 'projects', p.id, 'project.json'), { id: p.id, name: c.projects[p.id], workspace: ws[p.id], createdAt: p.createdAt, updatedAt: p.createdAt, order: i })
  );

  // ---------- 会话 ----------
  const ag = (id, name, adapter, model, effort, permission, color, role, instructions = '') => ({ id, name, adapter, model, effort, role, instructions, permission, color, enabled: true });
  function saveRoom(r, msgs) {
    let seq = 0;
    const lines = msgs.map((m) => JSON.stringify({ seq: ++seq, ...m }));
    r.seq = seq;
    write(path.join(dataDir, 'rooms', r.id, 'room.json'), {
      sessions: {},
      lastSeen: {},
      sideSessions: {},
      sideSeen: {},
      autoName: false,
      pinned: false,
      ...r,
      workspace: ws[r.projectId],
    });
    write(path.join(dataDir, 'rooms', r.id, 'messages.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  }
  const user = (id, ts, text) => ({ id, ts, from: 'user', name: c.you, kind: 'user', text });
  const reply = (id, ts, a, text, meta, items = [], files = []) => ({ id, ts, from: a.id, name: a.name, role: a.role, kind: 'agent', adapter: a.adapter, status: 'done', text, items, files, meta: { effort: a.effort, ...meta } });

  // 主角：GPT 出设计 → Claude 实现 → DeepSeek 检查
  const gpt = ag('a_gpt', 'GPT', 'codex', 'gpt-6.1-sol', 'high', 'edit', '#13897A', c.roles.design, c.instr.design);
  const cl = ag('a_cl', 'Claude', 'claude', 'opus', 'high', 'full', '#B4610C', c.roles.dev, c.instr.dev);
  const ds = ag('a_ds', 'DeepSeek', 'dsh', 'deepseek-v4-pro', 'high', 'edit', '#3F6AD8', c.roles.review, c.instr.review);
  const b = c.build;
  // 消息上显示的时刻：夜班（深色）是晚上，日班（浅色）是下午。左边栏的「几分钟前」还是按现在算
  const clock = new Date();
  clock.setHours(theme === 'light' ? 14 : 22, theme === 'light' ? 6 : 38, 0, 0);
  const t0 = clock.getTime();
  const buildMsgs = [
    user('m_b1', t0, b.user),
    reply(
      'm_b2',
      t0 + 2 * MIN,
      gpt,
      b.gpt,
      { ms: 108000, model: 'gpt-6.1-sol' },
      [
        { id: 'g1', k: 'cmd', n: 'shell', d: 'Get-ChildItem -Recurse', s: 'ok' },
        { id: 'g2', k: 'note', d: b.gptNote },
        { id: 'g3', k: 'write', n: 'apply_patch', d: 'docs/design.md', s: 'ok' },
      ],
      [{ path: 'docs/design.md', change: 'add', size: 1840 }]
    ),
    reply(
      'm_b3',
      t0 + 7 * MIN,
      cl,
      b.cl,
      { ms: 252000, model: 'claude-opus-5-5' },
      [
        { id: 'c1', k: 'read', n: 'Read', d: 'docs/design.md', s: 'ok' },
        { id: 'c2', k: 'note', d: b.clNote },
        { id: 'c3', k: 'write', n: 'Write', d: 'index.html', s: 'ok' },
        { id: 'c4', k: 'write', n: 'Write', d: 'src/app.js', s: 'ok' },
        { id: 'c5', k: 'cmd', n: 'Bash', d: 'node --check src/app.js', s: 'ok' },
      ],
      [
        { path: 'index.html', change: 'add', size: 4800 },
        { path: 'src/app.js', change: 'add', size: 5200 },
      ]
    ),
  ];
  if (variant === 'done') {
    buildMsgs.push(
      reply(
        'm_b4',
        t0 + 12 * MIN,
        ds,
        b.ds,
        { ms: 196000, model: 'deepseek-v4-pro' },
        [
          { id: 'd1', k: 'note', d: b.dsNote1 },
          { id: 'd2', k: 'write', n: 'write', d: 'tests/app.test.js', s: 'ok' },
          { id: 'd3', k: 'cmd', n: 'bash', d: 'node --test tests/', s: 'ok' },
          { id: 'd4', k: 'read', n: 'read', d: 'src/app.js', s: 'ok' },
          { id: 'd5', k: 'note', d: b.dsNote2 },
          { id: 'd6', k: 'cmd', n: 'bash', d: 'npx playwright test drag.spec.js', s: 'ok' },
          { id: 'd7', k: 'edit', n: 'edit', d: 'src/app.js', s: 'ok' },
          { id: 'd8', k: 'cmd', n: 'bash', d: 'node --test tests/', s: 'ok' },
        ],
        [
          { path: 'tests/app.test.js', change: 'add', size: 2400 },
          { path: 'src/app.js', change: 'update', size: 5260 },
        ]
      )
    );
  }
  saveRoom(
    {
      id: 'r_build',
      name: c.rooms.r_build,
      projectId: 'p_todo',
      agents: [gpt, cl, ds],
      pinned: true,
      order: 0,
      settings: { maxAutoTurns: 10, defaultAgent: 'a_gpt' },
      // 已经交接过的成员：下次只看新消息（和真的跑过一样）
      lastSeen: { a_gpt: 2, a_cl: 3, ...(variant === 'done' ? { a_ds: 4 } : {}) },
      createdAt: now - 20 * MIN,
      updatedAt: variant === 'done' ? now - 5 * MIN : now - 1 * MIN,
    },
    buildMsgs
  );

  // 左边栏里的其他会话：每个两条消息
  const O = c.others;
  const gem = ag('a_gem', 'Gemini', 'gemini', 'pro', '', 'edit', '#5B47C7', c.roles.front);
  const cl2 = ag('a_cl2', 'Claude', 'claude', 'sonnet', 'medium', 'edit', '#B4610C', c.roles.dev);
  const grok = ag('a_grok', 'Grok', 'grok', 'grok-5', 'medium', 'edit', '#9A3412', c.roles.docs);
  const hermes = ag('a_hermes', 'Hermes', 'hermes', '', '', 'readonly', '#B0357A', c.roles.proof);
  const gpt2 = ag('a_gpt2', 'GPT', 'codex', 'gpt-6-luna', 'low', 'readonly', '#13897A', c.roles.design);
  const oc = ag('a_oc', 'OpenCode', 'opencode', 'dashscope/qwen4-coder-plus', '', 'edit', '#0E7490', c.roles.data);
  const pair = (id, pid, name, order, at, agents, [q, a], meta) =>
    saveRoom({ id, name, projectId: pid, agents, order, settings: { maxAutoTurns: 10, defaultAgent: agents[0].id }, createdAt: at - 10 * MIN, updatedAt: at }, [
      user(id + '_1', at - 6 * MIN, q),
      reply(id + '_2', at, agents[0], a, meta),
    ]);
  pair('r_drag', 'p_todo', c.rooms.r_drag, 1, now - 2 * H, [gem, cl2], O.drag, { ms: 143000, model: 'gemini-3-pro' });
  pair('r_docs', 'p_todo', c.rooms.r_docs, 2, now - 26 * H, [grok, hermes], O.docs, { ms: 61000, model: 'grok-5' });
  pair('r_home', 'p_blog', c.rooms.r_home, 0, now - 3 * D, [cl2], O.home, { ms: 187000, model: 'claude-sonnet-5-5' });
  pair('r_astro', 'p_blog', c.rooms.r_astro, 1, now - 6 * D, [gpt2], O.astro, { ms: 38000, model: 'gpt-6-luna' });
  pair('r_chart', 'p_dash', c.rooms.r_chart, 0, now - 8 * D, [gem], O.chart, { ms: 117000, model: 'gemini-3-pro' });
  pair('r_api', 'p_dash', c.rooms.r_api, 1, now - 12 * D, [oc], O.api, { ms: 224000, model: 'dashscope/qwen4-coder-plus' });
  pair('r_mail', 'p_weekly', c.rooms.r_mail, 0, now - 30 * D, [cl2], O.mail, { ms: 96000, model: 'claude-sonnet-5-5' });

  // ---------- 用量：最近一年，工作日多、周末少，中间放过两次假 ----------
  const models = [
    { model: 'claude-opus-5-5', adapter: 'claude', agent: 'Claude', w: 1.0 },
    { model: 'gpt-6.1-sol', adapter: 'codex', agent: 'GPT', w: 0.75 },
    { model: 'deepseek-v4-pro', adapter: 'dsh', agent: 'DeepSeek', w: 0.55 },
    { model: 'gemini-3-pro', adapter: 'gemini', agent: 'Gemini', w: 0.4 },
    { model: 'claude-sonnet-5-5', adapter: 'claude', agent: 'Claude', w: 0.3 },
    { model: 'grok-5', adapter: 'grok', agent: 'Grok', w: 0.18 },
  ];
  const roomsFor = ['r_build', 'r_drag', 'r_docs', 'r_home', 'r_astro', 'r_chart', 'r_api', 'r_mail'];
  // 固定种子的伪随机数：每次生成的用量都一样
  let state = 11;
  const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const lines = [];
  const today = new Date();
  for (let back = 330; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 9, 30, 0);
    const dow = d.getDay();
    if ((back > 196 && back < 210) || (back > 70 && back < 76)) continue;
    if (rnd() < (dow === 0 || dow === 6 ? 0.6 : 0.1)) continue;
    // 越近用得越多
    const busy = 0.25 + rnd() * (back < 60 ? 2.4 : back < 150 ? 1.6 : 1.0);
    const runs = 1 + Math.floor(rnd() * 7);
    for (let i = 0; i < runs; i++) {
      const m = models[Math.floor(rnd() * models.length)];
      if (rnd() > m.w + 0.25) continue;
      const input = Math.round((18000 + rnd() * 170000) * busy * m.w);
      const rid = roomsFor[Math.floor(rnd() * roomsFor.length)];
      lines.push(
        JSON.stringify({
          ts: d.getTime() + i * 1700e3,
          roomId: rid,
          room: c.rooms[rid],
          agentId: 'a_' + m.agent.toLowerCase(),
          agent: m.agent,
          adapter: m.adapter,
          ms: Math.round((25 + rnd() * 380) * 1000),
          side: rnd() < 0.12,
          rows: [{ model: m.model, input, output: Math.round(input * (0.03 + rnd() * 0.08)), cacheRead: Math.round(input * rnd() * 3), cacheWrite: Math.round(input * rnd() * 0.3) }],
        })
      );
    }
  }
  write(path.join(dataDir, 'usage.jsonl'), lines.join('\n') + '\n');
}

module.exports = { seed };
