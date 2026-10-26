'use strict';
// 不依赖任何第三方库的测试：node test/run.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { parseMentions, buildCliPrompt, buildApiMessages } = require('../server/prompt');
const { prettyCmd } = require('../server/adapters/common');
const { splitArgs } = require('../server/proc');
const adapters = require('../server/adapters');
const { Store } = require('../server/store');
const { Orchestrator } = require('../server/orchestrator');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-test-'));

const A = [
  { id: 'g', name: 'GPT', enabled: true },
  { id: 'c', name: 'Claude', enabled: true },
  { id: 'r', name: '审查员', enabled: true },
  { id: 'c2', name: 'Claude2', enabled: true },
];

test('解析 @：英文名、中文名、顺序、去重', () => {
  assert.deepStrictEqual(parseMentions('@GPT 先设计，然后 @Claude 实现，@GPT 再看看', A), ['g', 'c']);
  assert.deepStrictEqual(parseMentions('@审查员请看一下', A), ['r']);
  assert.deepStrictEqual(parseMentions('@claude2 和 @Claude', A), ['c2', 'c']);
  assert.deepStrictEqual(parseMentions('@GPTs 不是成员', A), []);
  assert.deepStrictEqual(parseMentions('联系 me@GPT.com', A), []);
  assert.deepStrictEqual(parseMentions('需要你决定 @用户', A), ['user']);
  assert.deepStrictEqual(parseMentions('@所有人 开会', A), ['all']);
  assert.deepStrictEqual(parseMentions('@GPT请设计', A), ['g']);
});

test('代码块里的 @ 不算', () => {
  assert.deepStrictEqual(parseMentions('看这里 `@Claude` 和\n```\n@GPT\n```\n完毕', A), []);
});

test('简化 Codex 的 PowerShell 命令显示', () => {
  const c = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-Content -Raw hello.txt\'';
  assert.strictEqual(prettyCmd(c), 'Get-Content -Raw hello.txt');
  assert.strictEqual(prettyCmd('/bin/bash -lc "npm test"'), 'npm test');
  assert.strictEqual(prettyCmd('npm test'), 'npm test');
});

test('工具记录：写到项目文件夹以外的路径标出来，相对路径按项目文件夹算', () => {
  const { rel, outside } = require('../server/adapters/common');
  const root = path.resolve(tmp());
  const fwd = (p) => p.replace(/\\/g, '/');
  const home = path.join(os.homedir(), 'ai_team_test', 'calculator.py');
  assert.deepStrictEqual(outside('write', 'ai_team_test/calculator.py', root), {});
  assert.deepStrictEqual(outside('edit', path.join(root, 'docs', 'a.md'), root), {});
  assert.deepStrictEqual(outside('write', '..notes.md', root), {}, '文件名以 .. 开头，还在项目里');
  assert.deepStrictEqual(outside('read', home, root), {}, '读文件不算');
  assert.deepStrictEqual(outside('write', home, root), { out: [fwd(home)] });
  assert.deepStrictEqual(outside('edit', ['ok.py', '../x.py', ''], root), { out: [fwd(path.resolve(root, '..', 'x.py'))] });
  assert.strictEqual(rel(path.join(root, 'docs', 'a.md'), root), 'docs/a.md');
  assert.strictEqual(rel(home, root), fwd(home));
  // Nightshift 自己的工作目录在项目里面时，相对路径也不会被多算一层
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const cwd0 = process.cwd();
  process.chdir(sub);
  try {
    assert.strictEqual(rel('a.py', root), 'a.py');
    assert.deepStrictEqual(outside('write', 'a.py', root), {});
  } finally {
    process.chdir(cwd0);
  }
});

test('额外参数支持引号', () => {
  assert.deepStrictEqual(splitArgs('--effort high -c model="o3" "a b"'), ['--effort', 'high', '-c', 'model=o3', 'a b']);
  assert.deepStrictEqual(splitArgs(`-c 'perm=["disk"]'`), ['-c', 'perm=["disk"]']);
});

function fakeRoom() {
  return {
    id: 'r1',
    name: '测试',
    workspace: 'E:\\proj',
    agents: [
      { id: 'g', name: 'GPT', role: '产品设计', instructions: '写设计', enabled: true },
      { id: 'c', name: 'Claude', role: '开发', instructions: '写代码', enabled: true },
    ],
    sessions: {},
    lastSeen: {},
    settings: {},
    seq: 3,
  };
}
const MSGS = [
  { seq: 1, from: 'user', name: '用户', kind: 'user', text: '做个待办 App @GPT 先设计' },
  { seq: 2, from: 'g', name: 'GPT', role: '产品设计', kind: 'agent', text: '设计好了 @Claude', items: [{ k: 'write', d: 'docs/design.md' }] },
  { seq: 3, from: 'system', name: '系统', kind: 'system', text: '系统提示不应该出现' },
];

test('首次提示词：协议 + 完整记录 + 轮到你', () => {
  const p = buildCliPrompt({ room: fakeRoom(), agent: fakeRoom().agents[1], messages: MSGS, fresh: true, trigger: { byName: 'GPT', seq: 2 } });
  assert.match(p, /你是「Claude」/);
  assert.match(p, /@GPT：产品设计/);
  assert.match(p, /\[#1\] 用户/);
  assert.match(p, /这一轮改动的文件：docs\/design\.md/);
  assert.match(p, /GPT 在 #2 里 @ 了你/);
  assert.doesNotMatch(p, /系统提示不应该出现/);
  // 协作规则：文件放在项目里，说做完之前先确认；括号里的核对结果以它为准
  assert.match(p, /不要写到项目文件夹以外。说「做完了」之前先确认文件确实已经在项目文件夹里；说测试通过之前要真的运行过/);
  assert.match(p, /是系统按实际文件核对出来的，和发言里说的对不上时以它为准/);
  assert.match(p, /13\. 提到项目里的文件时/);
});

test('后续提示词：只有新消息，不含自己的发言', () => {
  const room = fakeRoom();
  room.lastSeen.g = 1;
  const p = buildCliPrompt({ room, agent: room.agents[0], messages: [...MSGS, { seq: 4, from: 'c', name: 'Claude', kind: 'agent', text: '实现完了' }], fresh: false });
  assert.doesNotMatch(p, /团队协作模式/);
  assert.doesNotMatch(p, /\[#1\]/);
  assert.doesNotMatch(p, /\[#2\]/);
  assert.match(p, /\[#4\] Claude/);
});

test('API 消息：角色交替、以用户消息结尾', () => {
  const room = fakeRoom();
  const msgs = buildApiMessages({ room, agent: room.agents[0], messages: MSGS });
  assert.strictEqual(msgs[0].role, 'system');
  for (let i = 2; i < msgs.length; i++) assert.notStrictEqual(msgs[i].role, msgs[i - 1].role);
  assert.strictEqual(msgs[msgs.length - 1].role, 'user');
  assert.strictEqual(msgs[1].role, 'user');
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content.includes('设计好了')));
});

// ---- 编排：用一个假的 AI 跑通「接力」 ----
function fakeAdapter(script) {
  return {
    id: 'fake',
    label: 'Fake',
    run({ agent, prompt, sessionId, emit }) {
      let cancelled = false;
      const done = new Promise((resolve) => {
        setTimeout(() => {
          if (cancelled) return resolve({ error: '已中止', sessionId: sessionId || 's-' + agent.id });
          emit({ type: 'tool', item: { id: 't1', k: 'write', n: 'Write', d: agent.name + '.txt', s: 'running' } });
          emit({ type: 'tool', item: { id: 't1', s: 'ok' } });
          const out = script(agent, prompt);
          if (out && out.error) return resolve({ error: out.error, sessionId: sessionId || 's-' + agent.id });
          emit({ type: 'text', text: out });
          resolve({ text: out, sessionId: sessionId || 's-' + agent.id });
        }, 20);
      });
      return { done, cancel: () => (cancelled = true) };
    },
  };
}

function setupRoom(script, settings) {
  adapters.register(fakeAdapter(script));
  const dir = tmp();
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const store = new Store(path.join(dir, 'data'));
  const events = [];
  const bus = { send: (event, data) => events.push({ event, data }) };
  const orch = new Orchestrator(store, bus);
  const room = store.createRoom({
    name: 't',
    workspace: ws,
    settings,
    agents: [
      { id: 'g', name: 'GPT', role: '设计', adapter: 'fake', enabled: true },
      { id: 'c', name: 'Claude', role: '开发', adapter: 'fake', enabled: true },
    ],
  });
  return { store, orch, room, events, ws };
}

const idle = (orch, roomId) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (!orch.isBusy(roomId)) return resolve();
      if (Date.now() - t0 > 5000) return reject(new Error('超时'));
      setTimeout(tick, 10);
    };
    setTimeout(tick, 10);
  });

test('接力：用户 → GPT → Claude → 结束', async () => {
  const prompts = {};
  const { store, orch, room, ws } = setupRoom((agent, prompt) => {
    prompts[agent.name] = (prompts[agent.name] || []).concat(prompt);
    return agent.name === 'GPT' ? '设计写好了，@Claude 请实现' : '实现完成，没有需要别人做的了';
  });
  orch.postUser(room.id, '做一个网页，@GPT 先设计');
  await idle(orch, room.id);
  const msgs = store.messages(room.id).filter((m) => m.kind !== 'system');
  assert.deepStrictEqual(msgs.map((m) => m.name), ['用户', 'GPT', 'Claude']);
  assert.strictEqual(msgs[1].items.length, 1, '过程记录里有工具调用，最终回复不重复');
  assert.strictEqual(room.sessions.g, 's-g');
  assert.match(prompts.Claude[0], /设计写好了/);
  assert.ok(fs.existsSync(path.join(ws, '.agentchat', `chat-${room.id}.md`)), '项目文件夹里有聊天记录');

  // 第二轮：GPT 只收到新消息
  orch.postUser(room.id, '@GPT 看看效果');
  await idle(orch, room.id);
  const p2 = prompts.GPT[1];
  assert.doesNotMatch(p2, /团队协作模式/);
  assert.match(p2, /实现完成/);
  assert.match(p2, /看看效果/);
});

test('没 @ 人时交给默认成员', async () => {
  const { store, orch, room } = setupRoom(() => '收到');
  room.settings.defaultAgent = 'c';
  orch.postUser(room.id, '你好');
  await idle(orch, room.id);
  assert.deepStrictEqual(store.messages(room.id).map((m) => m.name), ['用户', 'Claude']);
});

test('互相 @ 不会无限循环：达到上限后暂停，继续后接着跑', async () => {
  const { store, orch, room } = setupRoom((agent) => (agent.name === 'GPT' ? '@Claude 到你' : '@GPT 到你'), { maxAutoTurns: 3 });
  orch.postUser(room.id, '@GPT 开始');
  await new Promise((r) => setTimeout(r, 400));
  const st = orch.state(room.id);
  assert.strictEqual(st.paused, true);
  const agentMsgs = store.messages(room.id).filter((m) => m.kind === 'agent');
  assert.strictEqual(agentMsgs.length, 4, '1 次用户触发 + 3 次自动');
  assert.ok(store.messages(room.id).some((m) => m.kind === 'system' && m.pause));
  orch.resume(room.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(store.messages(room.id).filter((m) => m.kind === 'agent').length, 7);
  orch.stop(room.id);
  await idle(orch, room.id);
});

test('出错：后面排队的成员不再继续，重试成功后从这一步接着做', async () => {
  let claudeRuns = 0;
  const { store, orch, room } = setupRoom((agent) => {
    if (agent.name === 'Claude' && ++claudeRuns === 1) return { error: 'Not logged in · Please run /login' };
    return `${agent.name} 完成`;
  });
  orch.postUser(room.id, '@Claude 先写提示词，然后交给@GPT 做网页');
  await new Promise((r) => setTimeout(r, 300));
  let st = orch.state(room.id);
  assert.strictEqual(st.paused, true, 'Claude 出错后暂停');
  assert.strictEqual(st.pauseReason, 'error');
  assert.strictEqual(st.failed.name, 'Claude');
  assert.deepStrictEqual(st.queue.map((q) => q.agentId), ['g'], 'GPT 还在排队，但没有执行');
  assert.deepStrictEqual(store.messages(room.id).filter((m) => m.kind === 'agent').map((m) => `${m.name}:${m.status}`), ['Claude:error']);
  assert.ok(store.messages(room.id).some((m) => m.kind === 'system' && /运行出错，接力先暂停/.test(m.text)));

  orch.poke(room.id, 'c'); // 让 Claude 再试一次
  await idle(orch, room.id);
  st = orch.state(room.id);
  assert.strictEqual(st.paused, false);
  assert.deepStrictEqual(
    store.messages(room.id).filter((m) => m.kind === 'agent').map((m) => `${m.name}:${m.status}`),
    ['Claude:error', 'Claude:done', 'GPT:done'],
    '重试的 Claude 先做，成功后 GPT 接着做'
  );
});

test('出错后选「跳过，继续接力」：后面的成员接着做', async () => {
  const { store, orch, room } = setupRoom((agent) => (agent.name === 'Claude' ? { error: '坏了' } : 'GPT 完成'));
  orch.postUser(room.id, '@Claude @GPT 一起来');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(orch.state(room.id).pauseReason, 'error');
  orch.resume(room.id);
  await idle(orch, room.id);
  assert.deepStrictEqual(store.messages(room.id).filter((m) => m.kind === 'agent').map((m) => `${m.name}:${m.status}`), ['Claude:error', 'GPT:done']);
});

test('出错但后面没人排队：不需要暂停', async () => {
  const { orch, room } = setupRoom(() => ({ error: '坏了' }));
  orch.postUser(room.id, '@Claude 试试');
  await idle(orch, room.id);
  assert.strictEqual(orch.state(room.id).paused, false);
});

test('停止：正在执行的成员被中止，排队清空', async () => {
  const { store, orch, room } = setupRoom(() => '@Claude 继续');
  orch.postUser(room.id, '@GPT @Claude 一起来');
  await new Promise((r) => setTimeout(r, 5));
  orch.stop(room.id);
  await idle(orch, room.id);
  const agentMsgs = store.messages(room.id).filter((m) => m.kind === 'agent');
  assert.strictEqual(agentMsgs.length, 1);
  assert.strictEqual(agentMsgs[0].status, 'stopped');
});

// ---- 成员 @用户 时：人工审查（默认）/ 自动执行 / 全权代理 ----
const said = (store, room) => store.messages(room.id).filter((m) => m.kind === 'agent' || m.kind === 'review').map((m) => `${m.kind === 'review' ? '审查' : m.name}`);

test('人工审查：成员 @用户 时排在后面的先不做；没 @ 人的回复交给问你的那位，它先做，排着的再接着做', async () => {
  const prompts = {};
  let gptRuns = 0;
  const { store, orch, room } = setupRoom((agent, prompt) => {
    prompts[agent.name] = (prompts[agent.name] || []).concat(prompt);
    if (agent.name === 'GPT') return ++gptRuns === 1 ? '**@用户** 请二选一：1. 下一轮允许我运行 build.bat；2. 你自己运行，把输出贴过来' : '按方案 1 构建通过';
    return 'Claude 审查完了';
  });
  orch.postUser(room.id, '@GPT 写代码，然后 @Claude 审查');
  await new Promise((r) => setTimeout(r, 300));
  const st = orch.state(room.id);
  assert.deepStrictEqual([st.paused, st.pauseReason, st.asked.name, st.queue.map((q) => q.agentId)], [true, 'ask', 'GPT', ['c']]);
  assert.ok(!prompts.Claude, 'Claude 还没开始');
  assert.ok(store.messages(room.id).some((m) => m.kind === 'system' && m.pause && /GPT 在等你回复/.test(m.text)));
  assert.match(prompts.GPT[0], /这时接力会暂停/);
  orch.postUser(room.id, '选 1');
  await idle(orch, room.id);
  assert.deepStrictEqual(said(store, room), ['GPT', 'GPT', 'Claude']);
  assert.match(prompts.GPT[1], /选 1/);
  assert.strictEqual(orch.state(room.id).paused, false);
});

test('人工审查：点「批准，继续接力」排着的接着做；@ 了用户但后面没人要做时不用停', async () => {
  const { store, orch, room } = setupRoom((agent) => (agent.name === 'GPT' ? '@用户 要不要加排行榜？' : 'Claude 完成'));
  orch.postUser(room.id, '@GPT @Claude 一起来');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(orch.state(room.id).pauseReason, 'ask');
  orch.resume(room.id);
  await idle(orch, room.id);
  assert.deepStrictEqual(said(store, room), ['GPT', 'Claude']);
  orch.postUser(room.id, '@GPT 再问一次');
  await idle(orch, room.id);
  assert.strictEqual(orch.state(room.id).paused, false);
});

test('全权代理：成员 @用户 也不停；提示词里告诉它们自己拿主意', async () => {
  const prompts = {};
  const { store, orch, room } = setupRoom(
    (agent, prompt) => {
      prompts[agent.name] = prompt;
      return agent.name === 'GPT' ? '@用户 要不要加排行榜？' : 'Claude 完成';
    },
    { approval: 'full' }
  );
  orch.postUser(room.id, '@GPT @Claude 一起来');
  await idle(orch, room.id);
  assert.deepStrictEqual(said(store, room), ['GPT', 'Claude']);
  assert.match(prompts.GPT, /用户已经授权你们全权处理/);
  assert.match(prompts.Claude, /自己拿主意，只有缺少只有用户能提供的东西时才 @用户/);
});

test('自动执行：审查模型代你答复的，问你的成员先接着做，然后才轮到排着的；审查只读、每次新会话', async () => {
  const prompts = {};
  const reviews = [];
  let gptRuns = 0;
  const { store, orch, room } = setupRoom(
    (agent, prompt) => {
      if (agent.name === '审查') {
        reviews.push({ permission: agent.permission, prompt });
        return '好的。\n```json\n{"decision": "approve", "reason": "只在项目里构建，风险低", "reply": "可以，运行 build.bat，出错就修"}\n```';
      }
      prompts[agent.name] = (prompts[agent.name] || []).concat(prompt);
      if (agent.name === 'GPT') return ++gptRuns === 1 ? '@用户 下一轮允许我运行 build.bat 吗？' : '构建通过';
      return 'Claude 审查完了';
    },
    { approval: 'auto', reviewer: 'own' }
  );
  room.reviewer = { id: 'rv', name: '审查', adapter: 'fake', permission: 'edit', enabled: true };
  orch.postUser(room.id, '@GPT 写代码，然后 @Claude 审查');
  await idle(orch, room.id);
  assert.deepStrictEqual(said(store, room), ['GPT', '审查', 'GPT', 'Claude']);
  const rv = store.messages(room.id).find((m) => m.kind === 'review');
  assert.deepStrictEqual([rv.review.decision, rv.review.reason, rv.review.by.own], ['approve', '只在项目里构建，风险低', true]);
  assert.match(rv.text, /^@GPT 可以，运行 build\.bat/);
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(reviews[0].permission, 'readonly', '审查模型只读');
  assert.match(reviews[0].prompt, /# 自动审查/);
  assert.match(reviews[0].prompt, /下一轮允许我运行 build\.bat 吗/);
  assert.match(prompts.GPT[0], /先交给审查模型替用户把关/);
  assert.match(prompts.GPT[1], /自动审查（审查模型代用户答复，按用户的答复对待）/);
  assert.match(prompts.GPT[1], /自动审查 在 #\d+ 里 @ 了你/);
  assert.ok(!room.sessions.rv, '审查不留会话');
});

test('自动执行：要你亲自动手的转交给你，接力停下；审查模型没给出结论也转交；成员也可以当审查模型', async () => {
  let verdict = '{"decision": "escalate", "reason": "要在你的电脑上双击运行，需要你亲自操作", "reply": ""}';
  const { store, orch, room } = setupRoom(
    (agent, prompt) => {
      if (/# 自动审查/.test(prompt)) return verdict;
      return agent.name === 'GPT' ? '@用户 请你在 E:\\test 里双击 build.bat，把输出贴给我' : 'Claude 完成';
    },
    { approval: 'auto', reviewer: 'c' }
  );
  orch.postUser(room.id, '@GPT @Claude 一起来');
  await new Promise((r) => setTimeout(r, 400));
  let st = orch.state(room.id);
  assert.deepStrictEqual([st.paused, st.pauseReason, st.asked.name], [true, 'ask', 'GPT']);
  assert.match(st.asked.reason, /需要你亲自操作/);
  const rv = store.messages(room.id).find((m) => m.kind === 'review');
  assert.deepStrictEqual([rv.review.decision, rv.review.by.name, rv.review.by.own], ['escalate', 'Claude', false]);
  assert.deepStrictEqual(said(store, room), ['GPT', '审查'], 'Claude 还没开始');
  orch.stop(room.id);
  verdict = '我觉得可以';
  orch.postUser(room.id, '@GPT @Claude 再来');
  await new Promise((r) => setTimeout(r, 400));
  st = orch.state(room.id);
  assert.strictEqual(st.pauseReason, 'ask');
  assert.match(st.asked.reason, /没有给出明确的结论/);
  orch.stop(room.id);
  await idle(orch, room.id);
});

test('自动执行：审查时你自己回复了，审查作废，回复交给问你的那位', async () => {
  let cancelled = false;
  adapters.register({
    id: 'slow',
    label: 'Slow',
    run() {
      let timer;
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
        timer = setTimeout(() => resolve({ text: '{"decision": "approve", "reason": "x", "reply": "可以"}' }), 600);
      });
      const cancel = () => {
        cancelled = true;
        clearTimeout(timer);
        finish({ error: '已中止' });
      };
      return { done, cancel };
    },
  });
  const { store, orch, room } = setupRoom((agent, prompt) => (agent.name === 'GPT' && !/选 1/.test(prompt) ? '@用户 选哪个方案？' : `${agent.name} 完成`), {
    approval: 'auto',
    reviewer: 'own',
  });
  room.reviewer = { id: 'rv', name: '审查', adapter: 'slow', enabled: true };
  orch.postUser(room.id, '@GPT @Claude 一起来');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(orch.state(room.id).review.name, 'GPT', '正在审查 GPT 的请求');
  orch.postUser(room.id, '选 1');
  await idle(orch, room.id);
  assert.ok(cancelled, '审查被取消');
  assert.deepStrictEqual(said(store, room), ['GPT', 'GPT', 'Claude']);
});

test('自动审查：从审查模型的回复里认出结论', () => {
  const { parseVerdict, approvalMode } = require('../server/prompt');
  assert.deepStrictEqual(parseVerdict('```json\n{"decision":"approve","reason":"低风险","reply":"可以"}\n```'), { decision: 'approve', reason: '低风险', reply: '可以' });
  assert.deepStrictEqual(parseVerdict('结论：{"decision": "Escalate", "reason": "要你亲自运行"} 就这样'), { decision: 'escalate', reason: '要你亲自运行', reply: '' });
  assert.strictEqual(parseVerdict('我觉得可以'), null);
  assert.strictEqual(parseVerdict('{"decision": "maybe"}'), null);
  assert.strictEqual(approvalMode({ settings: {} }), 'manual');
  assert.strictEqual(approvalMode({ settings: { approval: 'yolo' } }), 'manual');
});

test('交付核对：写到项目外、什么都没改，记在消息上，下一位成员的记录里也写明', async () => {
  const { rel, outside } = require('../server/adapters/common');
  const dir = tmp();
  const ws = path.join(dir, 'AgentChat', 'APP');
  const far = path.join(dir, 'home', 'ai_team_test', 'calculator.py'); // 相当于 C:\Users\wangr\ai_team_test
  fs.mkdirSync(ws, { recursive: true });
  // 假成员按名字做事：Out 用编辑工具写到项目外；Talk 只说不做；Dev 用命令写在项目里；
  // Dot 改了 . 开头的文件夹（不进快照）；Ro 只读；Bad 往项目外写但失败了。回复都说「做完了」
  adapters.register({
    id: 'fake-check',
    label: 'Fake',
    run({ agent, cwd, emit }) {
      const write = (id, file, ok = true) => {
        if (ok) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'x');
        }
        emit({ type: 'tool', item: { id, k: 'write', n: 'Write', d: rel(file, cwd), s: 'running', ...outside('write', file, cwd) } });
        emit({ type: 'tool', item: { id, s: ok ? 'ok' : 'error' } });
      };
      if (agent.name === 'Out') write('w1', far);
      if (agent.name === 'Dev') fs.writeFileSync(path.join(cwd, 'calc.py'), 'x');
      if (agent.name === 'Dot') write('w2', path.join(cwd, '.github', 'ci.yml'));
      if (agent.name === 'Bad') write('w3', path.join(dir, 'home', 'nope.py'), false);
      return { done: Promise.resolve({ text: '已创建 ai_team_test/calculator.py，22 个测试全部通过' }), cancel() {} };
    },
  });
  const store = new Store(path.join(dir, 'data'));
  const orch = new Orchestrator(store, { send() {} });
  const names = ['Out', 'Talk', 'Dev', 'Dot', 'Ro', 'Bad'];
  const room = store.createRoom({
    name: 't',
    workspace: ws,
    agents: names.map((n) => ({ id: n.toLowerCase(), name: n, adapter: 'fake-check', permission: n === 'Ro' ? 'readonly' : 'edit', enabled: true })),
  });
  orch.postUser(room.id, names.map((n) => '@' + n).join(' ') + ' 在 ai_team_test 里写一个计算器和测试');
  await idle(orch, room.id);
  const by = Object.fromEntries(store.messages(room.id).filter((m) => m.kind === 'agent').map((m) => [m.name, m]));
  const farFwd = far.replace(/\\/g, '/');
  assert.deepStrictEqual(names.map((n) => by[n].status), names.map(() => 'done'));
  assert.deepStrictEqual([by.Out.outside, by.Out.unchanged], [[farFwd], true], '写到了项目外，项目里也什么都没改');
  assert.deepStrictEqual(by.Out.items[0].out, [farFwd], '工作过程里那一步标着项目外');
  assert.deepStrictEqual([by.Talk.outside, by.Talk.unchanged], [undefined, true]);
  assert.deepStrictEqual([by.Dev.files.map((f) => f.path), by.Dev.unchanged], [['calc.py'], undefined]);
  assert.deepStrictEqual([by.Dot.files, by.Dot.unchanged], [[], undefined], '. 开头的文件夹不进快照，但工具记录里写了项目里的文件，不算「没改」');
  assert.strictEqual(by.Ro.unchanged, undefined, '只读成员不提示');
  assert.deepStrictEqual([by.Bad.outside, by.Bad.unchanged], [undefined, true], '写失败的不算写到了项目外');
  // 下一位成员（第一次发言，拿到完整记录）看到的
  const rev = { id: 'rev', name: 'Rev', adapter: 'fake-check', enabled: true };
  const p = buildCliPrompt({ room: { ...room, agents: [...room.agents, rev] }, agent: rev, messages: store.messages(room.id), fresh: true });
  const part = (name) => p.slice(p.indexOf(`] ${name}：`)).split('\n\n')[0];
  assert.ok(part('Out').includes(`（这一轮有文件写到了项目文件夹以外：${farFwd}）`), part('Out'));
  assert.ok(part('Out').includes('（这一轮没有改动项目文件夹里的文件）'));
  assert.doesNotMatch(part('Out'), /这一轮改动的文件/, '写到项目外的不算进「改动的文件」');
  assert.match(part('Talk'), /已创建 ai_team_test\/calculator\.py，22 个测试全部通过\n（这一轮没有改动项目文件夹里的文件）$/);
  assert.match(part('Dev'), /（这一轮改动的文件：calc\.py）$/);
  assert.match(part('Dot'), /（这一轮改动的文件：\.github\/ci\.yml）$/);
  assert.doesNotMatch(part('Ro'), /（这一轮/);
  assert.doesNotMatch(part('Bad'), /写到了项目文件夹以外|这一轮改动的文件/);
});

// ---- 交付验收清单（会话设置里打开）：成员交给用户验收时，按清单核对实际的文件和工具记录 ----
const acceptance = require('../server/acceptance');

test('交付验收清单：解析交付报告（中英文标签、写「无」的项、加粗、链接和括号里的说明）', () => {
  const r = acceptance.parseReport(
    [
      '做好了，请验收 @用户',
      '',
      '**【交付报告】**',
      '- 源代码：src/calc.py、[测试](tests/test_calc.py)（共 2 个）',
      '- 测试命令：`python -m pytest -q`',
      '- **可执行文件**：dist/calc.exe 已重新打包',
      '- 依赖文件：无',
      '- 启动测试：没法自动验证，请用户双击 dist/calc.exe',
      '- 日志：logs/build.log',
      '- 交付清单：DELIVERY.md',
      '- 可以清理的中间产物：build/、calc.spec',
      '',
      '有问题再叫我。',
    ].join('\n')
  );
  assert.deepStrictEqual(r.none, ['deps']);
  assert.deepStrictEqual(acceptance.splitPaths(r.fields.source), ['src/calc.py', 'tests/test_calc.py']);
  assert.deepStrictEqual(acceptance.splitPaths(r.fields.cleanup), ['build/', 'calc.spec']);
  assert.strictEqual(r.fields.test, '`python -m pytest -q`');
  assert.strictEqual(r.fields.launch, '没法自动验证，请用户双击 dist/calc.exe');
  const en = acceptance.parseReport('Done.\n\nDelivery report:\n1. Source code: app.py\n2. Tests: npm test\n3. Executable: none\n4. Manifest: DELIVERY.md');
  assert.deepStrictEqual([en.fields.source, en.fields.test, en.fields.manifest, en.none], ['app.py', 'npm test', 'DELIVERY.md', ['exe']]);
  assert.strictEqual(acceptance.parseReport('做完以后我会写交付报告。'), null, '只提到交付报告、没有一项内容的不算');
  assert.strictEqual(acceptance.parseReport('普通回答'), null);
});

test('交付验收清单：什么时候核对；哪些命令算跑了测试、删了文件；乱码怎么认', () => {
  const yes = (text, handoff = false) => acceptance.isDelivery({ text, report: acceptance.parseReport(text), handoff });
  assert.strictEqual(yes('全部完成，请验收 @用户'), true);
  assert.strictEqual(yes('All done!'), true);
  assert.strictEqual(yes('实现完成，@GPT-2 请审查', true), false, '交接给队友不算');
  assert.strictEqual(yes('【交付报告】\n- 源代码：a.py', true), true, '写了交付报告的都算');
  assert.strictEqual(yes('@用户 你想要深色还是浅色？'), false, '向用户提问不算');
  assert.strictEqual(yes('还没有完成，需要你提供 API Key @用户'), false);
  assert.strictEqual(yes('not yet done'), false);
  const runs = {
    'python -m pytest -q': ['pytest'],
    'cd app && pytest tests/': ['pytest'],
    'C:\\Python312\\python.exe -m unittest discover': ['unittest'],
    'npm run test': ['npm test'],
    'node test/run.js': ['run.js'],
    'python test_calc.py': ['test_calc.py'],
    '.\\run_tests.bat': ['run_tests.bat'],
    'python -m pytest tests\\test_calc.py 2>&1 | Tee-Object logs\\test.log': ['pytest', 'test_calc.py'],
    // 安装、查看测试文件、只是提到的，都不是跑测试
    'pip install pytest': [],
    'cat tests/test_x.py': [],
    'type tests\\test_x.py': [],
    'Get-Content tests\\test_calc.py | Select-Object -First 20': [],
    'git diff tests/test_a.py': [],
    'echo pytest': [],
    'python calc.py': [],
  };
  for (const [cmd, want] of Object.entries(runs)) assert.deepStrictEqual(acceptance.testTokens(cmd), want, cmd);
  for (const cmd of ['Remove-Item -Recurse build', 'cd x; rm -rf dist', 'del /q build\\*', 'python -c "import shutil; shutil.rmtree(\'build\')"', 'git clean -fdx']) assert.ok(acceptance.isRemove(cmd), cmd);
  for (const cmd of ['python model.py', 'git status', 'echo removed']) assert.ok(!acceptance.isRemove(cmd), cmd);
  // 乱码：一串串问号（中文用不支持的编码写出去就是这样）、替换字符、GBK
  const dir = tmp();
  const put = (name, data) => (fs.writeFileSync(path.join(dir, name), data), path.join(dir, name));
  assert.deepStrictEqual(acceptance.textIssues(put('ok.md', '# 计算器\n真的吗???\n')), { utf8: true, qmarks: 0, fffd: 0 }, '一处 ??? 不算');
  assert.deepStrictEqual(acceptance.textIssues(put('q.md', '# ???????\n\n?? ?????\n')), { utf8: true, qmarks: 2, fffd: 0 });
  assert.strictEqual(acceptance.textIssues(put('r.txt', '计\uFFFD器')).fffd, 1);
  assert.strictEqual(acceptance.textIssues(put('gbk.txt', Buffer.from([0xbc, 0xc6, 0xcb, 0xe3, 0xc6, 0xf7]))).utf8, false); // 「计算器」的 GBK
  assert.strictEqual(acceptance.textIssues(put('bin.dat', Buffer.from([0x4d, 0x5a, 0, 1]))), null, '二进制不查');
});

test('交付验收清单：打开以后每一轮都附上清单和交付报告的格式，照抄格式里的说明不会被当成路径；关着的不附', () => {
  const room = fakeRoom();
  assert.doesNotMatch(buildCliPrompt({ room, agent: room.agents[1], messages: MSGS, fresh: false }), /交付报告/);
  room.settings.acceptance = true;
  const p = buildCliPrompt({ room, agent: room.agents[1], messages: MSGS, fresh: false });
  assert.match(p, /## 交付验收清单（这个会话已打开）/);
  assert.match(p, /【交付报告】\n- 源代码：/);
  assert.match(p, /不要删除任何文件。构建中间产物/);
  assert.ok(p.indexOf('交付验收清单') < p.indexOf('现在轮到你'), '在「轮到你」前面');
  const api = buildApiMessages({ room, agent: room.agents[0], messages: MSGS });
  assert.match(api[api.length - 1].content, /【交付报告】/);
  const tpl = acceptance.parseReport(p.slice(p.indexOf('【交付报告】')));
  for (const k of ['source', 'exe', 'deps', 'log', 'manifest', 'cleanup']) assert.deepStrictEqual(acceptance.splitPaths(tpl.fields[k]), [], k);
});

// 按名字做事的假成员：write / edit / cmd 会真的改项目文件夹，并且发出和真实工具一样的工具记录
function scriptedAdapter(id, plays) {
  adapters.register({
    id,
    label: 'Fake',
    run({ agent, cwd, emit }) {
      let n = 0;
      const step = (k, d, s) => {
        const tid = 't' + ++n;
        emit({ type: 'tool', item: { id: tid, k, n: k, d, s: 'running' } });
        emit({ type: 'tool', item: { id: tid, s } });
      };
      const t = {
        write(rel, text) {
          fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
          fs.writeFileSync(path.join(cwd, rel), text);
          step('write', rel, 'ok');
        },
        edit(rel, text) {
          fs.appendFileSync(path.join(cwd, rel), text);
          step('edit', rel, 'ok');
        },
        cmd(command, ok = true, effect) {
          if (effect) effect(cwd);
          step('cmd', command, ok ? 'ok' : 'error');
        },
      };
      return { done: Promise.resolve({ text: plays[agent.name](t, cwd) }), cancel() {} };
    },
  });
}
// 打包出来的 EXE（文件开头是 MZ）。ago：把修改时间往前拨几秒
function fakeExe(cwd, rel, ago = 0) {
  const exe = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510)]));
  if (ago) fs.utimesSync(exe, new Date(Date.now() - ago * 1000), new Date(Date.now() - ago * 1000));
}

test('交付验收清单（假成员重现计算器那次）：测试过时、EXE 没重新打包、中文变问号、删了原有文件，逐项核对；用户确认后下一位成员看得到', async () => {
  scriptedAdapter('fake-accept', {
    GPT: (t) => {
      t.write('src/calc.py', 'def add(a, b):\n    return a + b\n');
      t.write('tests/test_calc.py', 'from src.calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n');
      t.edit('main.py', '\n# 计算器入口\n');
      t.cmd('python -m pytest -q');
      t.cmd('pyinstaller --onefile src/calc.py', true, (cwd) => fakeExe(cwd, 'dist/calc.exe', 60));
      t.write('docs/说明.md', '# 计算器使用说明\n\n????????\n');
      t.cmd('Remove-Item notes/old.txt', true, (cwd) => fs.rmSync(path.join(cwd, 'notes', 'old.txt')));
      return '实现完成，@GPT-2 请审查';
    },
    // 审查的成员改了代码，没再跑测试、没重新打包，却说全部通过
    'GPT-2': (t) => {
      t.edit('src/calc.py', '\n\ndef sub(a, b):\n    return a - b\n');
      return '审查完成，22 个测试全部通过，可以交付了。@用户 请验收';
    },
  });
  const dir = tmp();
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'docs'));
  // 上一次交付留下的交付清单；网页应用的 manifest.json 不是交付清单
  const files0 = [['README.md', '# 原有项目\n'], ['main.py', 'print("hi")\n'], ['notes/old.txt', '旧笔记\n'], ['docs/交付清单.md', '# 上次的交付\n'], ['manifest.json', '{}']];
  for (const [f, s] of files0) fs.writeFileSync(path.join(ws, f), s);
  const store = new Store(path.join(dir, 'data'));
  const orch = new Orchestrator(store, { send() {} });
  const room = store.createRoom({
    name: 't',
    workspace: ws,
    settings: { acceptance: true },
    agents: [
      { id: 'g', name: 'GPT', adapter: 'fake-accept', permission: 'full', enabled: true },
      { id: 'g2', name: 'GPT-2', adapter: 'fake-accept', permission: 'full', enabled: true },
    ],
  });
  orch.postUser(room.id, '@GPT 用 Python 做一个计算器，打包成 EXE');
  await idle(orch, room.id);
  const [dev, rev] = store.messages(room.id).filter((m) => m.kind === 'agent');
  assert.strictEqual(dev.acceptance, undefined, '交接给队友时不核对');
  const acc = rev.acceptance;
  assert.strictEqual(acc.report, false);
  const item = Object.fromEntries(acc.items.map((it) => [it.id, it]));
  assert.deepStrictEqual(acc.items.map((it) => `${it.id}:${it.s}`), ['source:pass', 'tests:fail', 'exe:fail', 'launch:user', 'logs:fail', 'originals:fail', 'encoding:fail']);
  assert.deepStrictEqual(item.source.f, [{ c: 'src-changed', files: ['src/calc.py', 'tests/test_calc.py', 'main.py'], n: 3 }]);
  assert.deepStrictEqual(item.tests.f, [
    { c: 'test-ran', who: 'GPT', cmd: 'python -m pytest -q', ok: true },
    { c: 'test-stale', who: 'GPT-2', file: 'src/calc.py' },
  ]);
  assert.deepStrictEqual(item.exe.f, [{ c: 'exe-older', file: 'dist/calc.exe', src: 'src/calc.py' }]);
  assert.deepStrictEqual(item.launch.f, [{ c: 'launch-unsaid' }, { c: 'launch-try', file: 'dist/calc.exe' }], '打包命令里提到 calc 不算启动过');
  assert.deepStrictEqual(item.logs.f, [{ c: 'log-none' }, { c: 'manifest-old', files: ['docs/交付清单.md'], n: 1 }], '有交付清单，但不是这次生成的');
  assert.deepStrictEqual(item.originals.f, [
    { c: 'orig-deleted', files: ['notes/old.txt'], n: 1 },
    { c: 'orig-modified', files: ['main.py'], n: 1 },
    { c: 'rm-cmd', who: 'GPT', cmd: 'Remove-Item notes/old.txt' },
  ]);
  assert.deepStrictEqual(item.encoding.f, [{ c: 'enc-qmarks', file: 'docs/说明.md', n: 1 }]);
  assert.deepStrictEqual(acc.cleanup, []);
  // 核对不删任何东西，也不运行程序
  assert.ok(fs.existsSync(path.join(ws, 'dist', 'calc.exe')));
  // 用户试了 EXE，打不开：点了「不通过」
  store.updateMessage(room.id, rev.id, (m) => (m.acceptance.items.find((it) => it.id === 'launch').u = 'fail'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'rooms', room.id, 'messages.jsonl'), 'utf8').trim().split('\n').pop()).acceptance.items[3].u, 'fail', '存进了文件');
  // 下一位成员（第一次发言，拿到完整记录）看到的
  const fix = { id: 'fix', name: 'Fix', adapter: 'fake-accept', enabled: true };
  const p = buildCliPrompt({ room: { ...room, agents: [...room.agents, fix] }, agent: fix, messages: store.messages(room.id), fresh: true });
  const part = p.slice(p.indexOf(`[#${rev.seq}] `)).split('\n\n')[0];
  assert.match(part, /（交付验收清单，系统按实际文件和工具记录核对，成员没有写交付报告：/);
  assert.match(part, /\n✗ 自动化测试：GPT 运行了 python -m pytest -q，成功；测试之后 GPT-2 又改了 src\/calc\.py，需要重新运行测试\n/);
  assert.match(part, /\n✗ EXE 和依赖文件：dist\/calc\.exe 比最后一次改代码（src\/calc\.py）还早，没有重新打包\n/);
  assert.match(part, /\n\? 启动测试：成员没有写启动测试的情况；等用户打开 dist\/calc\.exe 验收（用户确认：不通过）\n/);
  assert.match(part, /\n✗ 原有文件：删除了原有的 notes\/old\.txt；修改了原有的 main\.py；GPT 运行过删除文件的命令：Remove-Item notes\/old\.txt/);
  assert.match(part, /\n✗ 文字编码：docs\/说明\.md 里有一串串问号，中文可能被写坏了）$/);
  // 交付的成员自己下一轮（有会话记忆，只收新消息）也能看到核对结果
  room.lastSeen.g2 = rev.seq - 1;
  const own = buildCliPrompt({ room, agent: room.agents[1], messages: store.messages(room.id), fresh: false });
  assert.match(own, new RegExp(`## 你在 #${rev.seq} 交付以后\\n\\n（交付验收清单`));
  // API 模型没有会话记忆：自己的发言后面跟着核对结果
  const apiMsgs = buildApiMessages({ room, agent: room.agents[1], messages: store.messages(room.id) });
  const at = apiMsgs.findIndex((m) => m.role === 'assistant' && m.content.startsWith('审查完成'));
  assert.match(apiMsgs[at + 1].content, /^（交付验收清单/);
  // 项目里的聊天记录文件也写上了
  assert.match(fs.readFileSync(store.logPath(room), 'utf8'), /> （交付验收清单[\s\S]*> ✗ 自动化测试/);
});

test('交付验收清单：按格式交付的，能核对的都通过，启动测试交给用户；会话没打开清单时不核对', async () => {
  const good = (t) => {
    t.write('src/app.py', 'print("你好")\n');
    t.write('tests/test_app.py', 'def test_ok():\n    assert True\n');
    t.cmd('python -m pytest');
    t.cmd('pyinstaller --onefile src/app.py', true, (cwd) => fakeExe(cwd, 'dist/app.exe'));
    t.cmd('.\\dist\\app.exe --selftest');
    t.write('logs/build.log', 'build ok\n');
    t.write('DELIVERY.md', '# 交付清单\n\n- dist/app.exe\n');
    return [
      '做好了，请验收。',
      '',
      '【交付报告】',
      '- 源代码：src/app.py、tests/test_app.py',
      '- 测试命令：python -m pytest',
      '- 可执行文件：dist/app.exe',
      '- 依赖文件：无',
      '- 启动测试：运行过 dist/app.exe --selftest，正常退出；界面请用户双击确认',
      '- 日志：logs/build.log',
      '- 交付清单：DELIVERY.md',
      '- 可以清理的中间产物：build/、app.spec',
    ].join('\n');
  };
  scriptedAdapter('fake-good', { Dev: good });
  const run = async (settings) => {
    const dir = tmp();
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'README.md'), '# 原有项目\n');
    const store = new Store(path.join(dir, 'data'));
    const orch = new Orchestrator(store, { send() {} });
    const room = store.createRoom({ name: 't', workspace: ws, settings, agents: [{ id: 'd', name: 'Dev', adapter: 'fake-good', permission: 'full', enabled: true }] });
    orch.postUser(room.id, '@Dev 做一个打招呼的小程序，打包成 EXE');
    await idle(orch, room.id);
    return store.messages(room.id).find((m) => m.kind === 'agent');
  };
  const acc = (await run({ acceptance: true })).acceptance;
  assert.strictEqual(acc.report, true);
  assert.deepStrictEqual(acc.items.map((it) => `${it.id}:${it.s}`), ['source:pass', 'tests:pass', 'exe:pass', 'launch:user', 'logs:pass', 'originals:pass', 'encoding:pass']);
  const item = Object.fromEntries(acc.items.map((it) => [it.id, it]));
  assert.deepStrictEqual(item.source.f[0], { c: 'src-ok', files: ['src/app.py', 'tests/test_app.py'], n: 2 });
  assert.deepStrictEqual(item.tests.f, [{ c: 'test-ran', who: 'Dev', cmd: 'python -m pytest', ok: true }]);
  assert.deepStrictEqual([item.exe.f.length, item.exe.f[0].c, item.exe.f[0].file, item.exe.f[0].fresh], [1, 'exe-ok', 'dist/app.exe', true], '依赖写了「无」，不再提醒');
  assert.deepStrictEqual(item.launch.f, [
    { c: 'launch-said', text: '运行过 dist/app.exe --selftest，正常退出；界面请用户双击确认' },
    { c: 'launch-ran', who: 'Dev', cmd: '.\\dist\\app.exe --selftest', ok: true },
    { c: 'launch-try', file: 'dist/app.exe' },
  ]);
  assert.deepStrictEqual(item.logs.f, [
    { c: 'log-ok', files: ['logs/build.log'], n: 1 },
    { c: 'manifest-ok', files: ['DELIVERY.md'], n: 1 },
  ]);
  assert.deepStrictEqual(item.originals.f, [{ c: 'orig-kept', n: 1 }]);
  assert.deepStrictEqual(item.encoding.f, [{ c: 'enc-ok', n: 4 }]);
  assert.deepStrictEqual(acc.cleanup, ['build/', 'app.spec']);
  assert.match(acceptance.promptText(acc), /\n\? 启动测试：成员写的：运行过 dist\/app\.exe --selftest，正常退出；界面请用户双击确认；Dev 运行了 \.\\dist\\app\.exe --selftest，成功；等用户打开 dist\/app\.exe 验收（等用户确认）\n/);
  assert.strictEqual((await run({})).acceptance, undefined, '没打开就不核对，交付报告写了也一样');
});

test('交付验收清单：任务开始时的快照存在磁盘上，中途重启 Nightshift 以后照样核对原有文件；任务开始时没打开的没法核对', async () => {
  scriptedAdapter('fake-restart', {
    A: (t) => {
      t.cmd('del old.txt', true, (cwd) => fs.rmSync(path.join(cwd, 'old.txt')));
      return '删掉了旧文件。'; // 没说做完，也没 @ 人：接力结束，不核对
    },
    B: () => '全部完成，请验收 @用户',
  });
  const dir = tmp();
  const data = path.join(dir, 'data');
  const make = (store, name, settings) => {
    const ws = path.join(dir, name);
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'old.txt'), '原有的');
    return store.createRoom({ name, workspace: ws, settings, agents: ['A', 'B'].map((n) => ({ id: n.toLowerCase(), name: n, adapter: 'fake-restart', enabled: true })) });
  };
  const store = new Store(data);
  const orch = new Orchestrator(store, { send() {} });
  const on = make(store, 'on', { acceptance: true });
  const off = make(store, 'off', {});
  for (const room of [on, off]) {
    orch.postUser(room.id, '@A 清理一下');
    await idle(orch, room.id);
  }
  assert.ok(fs.existsSync(path.join(data, 'rooms', on.id, 'baseline.json')));
  assert.ok(!fs.existsSync(path.join(data, 'rooms', off.id, 'baseline.json')), '没打开验收清单时不存');
  // 重启：新的 Store 和编排器。没打开的那个会话现在才打开，再让 B 接着做（同一个任务）
  const store2 = new Store(data);
  const orch2 = new Orchestrator(store2, { send() {} });
  store2.getRoom(off.id).settings.acceptance = true;
  for (const room of [on, off]) {
    orch2.poke(room.id, 'b');
    await idle(orch2, room.id);
  }
  const originals = (id) => store2.messages(id).filter((m) => m.kind === 'agent').pop().acceptance.items.find((it) => it.id === 'originals');
  assert.deepStrictEqual(originals(on.id), { id: 'originals', s: 'fail', f: [{ c: 'orig-deleted', files: ['old.txt'], n: 1 }, { c: 'rm-cmd', who: 'A', cmd: 'del old.txt' }] });
  assert.deepStrictEqual(originals(off.id), { id: 'originals', s: 'user', f: [{ c: 'orig-nobase' }, { c: 'rm-cmd', who: 'A', cmd: 'del old.txt' }] });
  // 清空聊天记录时快照一起删掉
  store2.clearMessages(on.id);
  assert.ok(!fs.existsSync(path.join(data, 'rooms', on.id, 'baseline.json')));
});

test('API 模型（完全权限）：命令的退出码不是 0 就记为失败，交付验收清单据此判断测试没通过', async () => {
  let calls = 0;
  const sent = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      sent.push(JSON.parse(body).messages);
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      const reply = (message) => res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
      const use = (name, args) => reply({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (calls === 1) use('write_file', { path: 'test/check.js', content: 'process.exit(1)\n' });
      else if (calls === 2) use('run_command', { command: 'node test/check.js' });
      else reply({ role: 'assistant', content: '测试都通过了，完成。@用户' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = tmp();
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(ws);
    const store = new Store(path.join(dir, 'data'));
    const orch = new Orchestrator(store, { send() {} });
    const api = { baseUrl: `http://127.0.0.1:${srv.address().port}/v1` };
    const room = store.createRoom({ name: 't', workspace: ws, settings: { acceptance: true }, agents: [{ id: 'ds', name: 'DS', adapter: 'openai', model: 'deepseek-chat', permission: 'full', enabled: true, api }] });
    orch.postUser(room.id, '@DS 写个检查脚本并运行');
    for (const t0 = Date.now(); orch.isBusy(room.id); ) {
      if (Date.now() - t0 > 30000) throw new Error('超时');
      await new Promise((r) => setTimeout(r, 20));
    }
    const m = store.messages(room.id).find((x) => x.kind === 'agent');
    const cmd = m.items.find((it) => it.k === 'cmd');
    assert.deepStrictEqual([cmd.d, cmd.s], ['node test/check.js', 'error']);
    assert.match(sent[2].find((x) => x.role === 'tool' && x.tool_call_id === 'c2').content, /^退出码 1/, '模型照样拿到命令的输出');
    assert.deepStrictEqual(m.acceptance.items.find((it) => it.id === 'tests'), { id: 'tests', s: 'fail', f: [{ c: 'test-ran', who: 'DS', cmd: 'node test/check.js', ok: false }] });
  } finally {
    srv.close();
  }
});

// ---- API 模型：用一个模拟的 OpenAI 兼容接口测试工具调用 ----
test('API 模型：流式输出 + 调用工具写文件', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      calls++;
      assert.strictEqual(req.headers.authorization, 'Bearer sk-test');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (calls === 1) {
        assert.ok(j.tools.some((t) => t.function.name === 'write_file'));
        assert.ok(!j.tools.some((t) => t.function.name === 'run_command'), '可改文件权限下没有运行命令');
        send({ choices: [{ delta: { content: '我来写文件。' } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":"docs/a.md",' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"你好"}' } }] }, finish_reason: 'tool_calls' }] });
      } else {
        const toolMsg = j.messages.find((m) => m.role === 'tool');
        assert.match(toolMsg.content, /已写入 docs\/a\.md/);
        send({ choices: [{ delta: { content: '写好了 docs/a.md，' } }] });
        send({ choices: [{ delta: { content: '@Claude 请看' }, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const ws = tmp();
  const events = [];
  const api = adapters.get('openai');
  const h = api.run({
    agent: { name: 'DS', model: 'm', permission: 'edit', api: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: 'sk-test' } },
    cwd: ws,
    apiMessages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    emit: (e) => events.push(e),
  });
  const out = await h.done;
  srv.close();
  assert.strictEqual(out.error, undefined);
  assert.strictEqual(out.text, '写好了 docs/a.md，@Claude 请看');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'docs', 'a.md'), 'utf8'), '你好');
  assert.ok(events.some((e) => e.type === 'tool' && e.item.k === 'write'));
  assert.ok(events.some((e) => e.type === 'text' && e.text === '我来写文件。'));
});

test('API 模型的文件工具不能跑出项目文件夹', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      const tool = j.messages.find((m) => m.role === 'tool');
      if (!tool) {
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{"path":"../../secret.txt"}' } }] }, finish_reason: 'tool_calls' }] }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: tool.content }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const h = adapters.get('openai').run({
    agent: { name: 'DS', model: 'm', permission: 'readonly', api: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1` } },
    cwd: tmp(),
    apiMessages: [{ role: 'user', content: 'u' }],
    emit: () => {},
  });
  const out = await h.done;
  srv.close();
  assert.match(out.text, /只能访问项目文件夹以内的路径/);
});

// ---- DeepSeek 把工具调用写成 DSML 文字（实际遇到过：两轮「审查」只有这段文字，什么也没执行） ----
test('API 模型：解析 DeepSeek 的 DSML 工具调用（全角、半角竖线，string="false" 是 JSON，没写完的去掉）', () => {
  const { parseDsml } = require('../server/adapters/openai');
  const full = [
    '我先看看文件。',
    '<｜DSML｜function_calls>',
    '<｜DSML｜invoke name="read_file">',
    '<｜DSML｜parameter name="path" string="true">src/app.js</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '<｜DSML｜invoke name="list_files">',
    '<｜DSML｜parameter name="path" string="true">.</｜DSML｜parameter>',
    '<｜DSML｜parameter name="recursive" string="false">true</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜function_calls>',
  ].join('\n');
  const a = parseDsml(full);
  assert.strictEqual(a.found, true);
  assert.strictEqual(a.text, '我先看看文件。');
  assert.deepStrictEqual(a.calls, [
    { name: 'read_file', args: { path: 'src/app.js' } },
    { name: 'list_files', args: { path: '.', recursive: true } },
  ]);
  // 半角竖线；字符串值原样保留（换行、引号都不动）
  const b = parseDsml('<|DSML|function_calls>\n<|DSML|invoke name="write_file">\n<|DSML|parameter name="path" string="true">a.md</|DSML|parameter>\n<|DSML|parameter name="content" string="true">第一行\n"第二行"</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|function_calls>');
  assert.deepStrictEqual(b.calls, [{ name: 'write_file', args: { path: 'a.md', content: '第一行\n"第二行"' } }]);
  assert.strictEqual(b.text, '');
  // 只写了个开头：认出来了，但没有能执行的调用
  const c = parseDsml('好的。\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="read_');
  assert.deepStrictEqual([c.found, c.text, c.calls.length], [true, '好的。', 0]);
  assert.strictEqual(parseDsml('普通回答，提到 DSML 这个词也没关系').found, false);
});

test('API 模型：正文里的 DSML 照样执行，界面上不显示那段标记；看不懂的报错', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (calls === 1) {
        // 标记被拆在两段里流过来
        send({ choices: [{ delta: { content: '我来写文件。\n<｜DS' } }] });
        send({ choices: [{ delta: { content: 'ML｜function_calls>\n<｜DSML｜invoke name="write_file">\n<｜DSML｜parameter name="path" string="true">docs/a.md</｜DSML｜parameter>\n' } }] });
        send({ choices: [{ delta: { content: '<｜DSML｜parameter name="content" string="true">你好</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>' }, finish_reason: 'stop' }] });
      } else {
        // 第二次请求：上一轮按正常的 tool_calls 和工具结果发回去
        const asst = j.messages.find((m) => m.role === 'assistant');
        assert.strictEqual(asst.content, '我来写文件。');
        assert.deepStrictEqual(JSON.parse(asst.tool_calls[0].function.arguments), { path: 'docs/a.md', content: '你好' });
        assert.match(j.messages.find((m) => m.role === 'tool').content, /已写入 docs\/a\.md/);
        send({ choices: [{ delta: { content: '写好了。' }, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const ws = tmp();
  const events = [];
  const run = (port) =>
    adapters.get('openai').run({
      agent: { name: 'DS', model: 'deepseek-v4', permission: 'edit', api: { baseUrl: `http://127.0.0.1:${port}/v1` } },
      cwd: ws,
      apiMessages: [{ role: 'user', content: 'u' }],
      emit: (e) => events.push(e),
    });
  const out = await run(srv.address().port).done;
  srv.close();
  assert.strictEqual(out.error, undefined);
  assert.strictEqual(out.text, '写好了。');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'docs', 'a.md'), 'utf8'), '你好');
  assert.ok(events.some((e) => e.type === 'tool' && e.item.k === 'write'));
  const streamed = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.doesNotMatch(streamed, /DSML|<｜/);
  assert.match(streamed, /^我来写文件。/);

  // DSML 只写了一半：报错，不能当成已经回答了
  const bad = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '我来审查。\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="read' }, finish_reason: 'length' }] }));
    });
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const out2 = await run(bad.address().port).done;
  bad.close();
  assert.match(out2.error, /DSML/);
  assert.strictEqual(out2.text, '我来审查。');
});

test('项目外的文件：只认完整路径，不存在的不显示', () => {
  const { absolutePath } = require('../server/files');
  const dir = tmp();
  assert.strictEqual(absolutePath('docs/a.md'), null);
  assert.strictEqual(absolutePath(''), null);
  assert.strictEqual(absolutePath(path.join(dir, 'a.md')), path.join(dir, 'a.md'));
  if (process.platform === 'win32') {
    // AI 常写成 /C:/x/y.md、file:/// 链接、带 :行号
    assert.strictEqual(absolutePath('/C:/Users/x/report.md:12'), 'C:\\Users\\x\\report.md');
    assert.strictEqual(absolutePath('file:///C:/Users/x/a%20b.md'), 'C:\\Users\\x\\a b.md');
  }
});

test('附件：项目里的直接用，项目外的复制进 .agentchat/attachments（跳过依赖），去掉时只删复制的那份', () => {
  const { attach, removeAttachment, checkAttachments, uploadTarget } = require('../server/files');
  const ws = tmp();
  const out = tmp();
  fs.mkdirSync(path.join(ws, 'docs'));
  fs.writeFileSync(path.join(ws, 'docs', 'spec.md'), '# spec');
  fs.writeFileSync(path.join(out, 'report.pdf'), 'pdf!');
  fs.mkdirSync(path.join(out, 'assets', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(out, 'assets', 'logo.png'), 'png');
  fs.writeFileSync(path.join(out, 'assets', 'node_modules', 'x', 'index.js'), 'x');
  const items = attach(ws, [path.join(ws, 'docs', 'spec.md'), path.join(out, 'report.pdf'), path.join(out, 'assets'), path.join(ws, 'docs')]);
  const T = /\d{8}-\d{6}(-\d+)?/;
  assert.deepStrictEqual(
    items.map((a) => [a.path.replace(T, 'T'), a.kind, a.size, a.count, a.from ? 'copy' : '']),
    [
      ['docs/spec.md', 'file', 6, undefined, ''],
      ['.agentchat/attachments/T/report.pdf', 'file', 4, undefined, 'copy'],
      ['.agentchat/attachments/T/assets', 'dir', 3, 1, 'copy'],
      ['docs', 'dir', undefined, undefined, ''],
    ]
  );
  assert.strictEqual(fs.readFileSync(path.join(ws, items[1].path), 'utf8'), 'pdf!');
  assert.ok(!fs.existsSync(path.join(ws, items[2].path, 'node_modules')), '依赖不复制');
  assert.strictEqual(fs.readFileSync(path.join(ws, '.agentchat', '.gitignore'), 'utf8'), '*\n', '不进 git');
  // 同一个文件再加一次：新的一批，原样复制
  assert.notStrictEqual(attach(ws, [path.join(out, 'report.pdf')])[0].path, items[1].path);
  // 不能加：不存在的、项目文件夹本身、包含项目文件夹的文件夹。有一个不行就都不复制
  const before = fs.readdirSync(path.join(ws, '.agentchat', 'attachments')).length;
  assert.throws(() => attach(ws, [path.join(out, 'report.pdf'), path.join(out, 'nope.txt')]), /找不到「nope\.txt」/);
  assert.strictEqual(fs.readdirSync(path.join(ws, '.agentchat', 'attachments')).length, before);
  assert.throws(() => attach(ws, [ws]), /项目文件夹本身/);
  assert.throws(() => attach(ws, [path.dirname(ws)]), /包含了项目文件夹/);
  // 发消息时：只认项目里还在的；去掉附件时只删复制的那份，这一批空了连文件夹一起删
  assert.strictEqual(checkAttachments(ws, items).length, 4);
  assert.strictEqual(removeAttachment(ws, items[1].path), true);
  assert.ok(!fs.existsSync(path.join(ws, items[1].path)));
  assert.strictEqual(removeAttachment(ws, items[2].path), true);
  assert.ok(!fs.existsSync(path.join(ws, path.dirname(items[2].path))), '空了的那一批也删掉');
  assert.strictEqual(removeAttachment(ws, 'docs/spec.md'), false, '项目里原有的文件不动');
  assert.ok(fs.existsSync(path.join(ws, 'docs', 'spec.md')));
  assert.throws(() => checkAttachments(ws, [items[1]]), /找不到附件「report\.pdf」/);
  // 浏览器传上来的：只能写在这一批的文件夹里
  assert.ok(uploadTarget(ws, '20261026-101010', 'assets/logo.png').endsWith(path.join('20261026-101010', 'assets', 'logo.png')));
  assert.strictEqual(uploadTarget(ws, '20261026-101010', '../../evil.txt'), null);
  assert.strictEqual(uploadTarget(ws, '../x', 'a.txt'), null);
});

test('附件：成员看到的消息里写着每个附件的路径', () => {
  const msgs = [{ seq: 1, from: 'user', kind: 'user', text: '看看这份需求', attachments: [{ path: 'docs/spec.md', kind: 'file' }, { path: '.agentchat/attachments/T/assets', kind: 'dir' }] }];
  const p = buildCliPrompt({ room: fakeRoom(), agent: fakeRoom().agents[0], messages: msgs, fresh: true, trigger: null });
  assert.match(p, /看看这份需求\n（附件，路径相对项目文件夹：docs\/spec\.md、\.agentchat\/attachments\/T\/assets（文件夹））/);
});

// ---- 每个成员单独的模型和思考强度 ----
const models = require('../server/models');

test('Claude Code：模型和思考强度参数（用 --settings 覆盖全局设置）', () => {
  const args = adapters.get('claude').buildArgs({ agent: { model: 'opus', effort: 'high', permission: 'edit' }, sessionId: 's1' });
  assert.deepStrictEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus']);
  assert.deepStrictEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  // --settings 传的是一个临时文件（旧版本只认文件路径）
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
  assert.strictEqual(settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.ok(args.includes('--resume'));
  const plain = adapters.get('claude').buildArgs({ agent: { permission: 'edit' } });
  assert.ok(!plain.includes('--effort') && !plain.includes('--settings') && !plain.includes('--model'), '没设置时不加参数');
  const bad = adapters.get('claude').buildArgs({ agent: { effort: 'ultra' } });
  assert.ok(!bad.includes('--effort'), 'Claude 不支持的档位不传');
});

// 模拟不同版本的 claude --help
const NEW_HELP = `Usage: claude [options] [command] [prompt]
Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --include-partial-messages            Include partial message chunks as they
                                        arrive
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -p, --print                           Print response and exit
  --settings <file-or-json>             Path to a settings JSON file`;
const OLD_HELP = `Usage: claude [options] [command] [prompt]
Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'sonnet' or 'opus') or a model's full name.
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits",
                                        "bypassPermissions", "default", "plan")
  -p, --print                           Print response and exit`;

test('探测 Claude Code 版本能力：读 --help（含折行）', () => {
  const c = adapters.get('claude');
  const caps = c.parseHelp(NEW_HELP);
  assert.deepStrictEqual(caps.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(caps.aliases, ['fable', 'opus', 'sonnet']);
  assert.ok(caps.modes.includes('dontAsk') && caps.partial && caps.settings);
  const old = c.parseHelp(OLD_HELP);
  assert.strictEqual(old.effort, false);
  assert.strictEqual(old.partial, false);
  assert.deepStrictEqual(old.aliases, ['sonnet', 'opus']);
});

test('旧版 Claude Code：不传它不认识的参数，只读权限换成旧名字', () => {
  const c = adapters.get('claude');
  const args = c.buildArgs({ agent: { model: 'opus', effort: 'high', permission: 'readonly' }, caps: c.parseHelp(OLD_HELP) });
  assert.ok(!args.includes('--effort') && !args.includes('--settings'), '旧版没有 --effort');
  assert.ok(!args.includes('--include-partial-messages'));
  assert.deepStrictEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'default']);
  assert.ok(args.includes('--disallowedTools'));
});

test('新电脑上的 Claude Code：没有 settings.json 也能列出别名', () => {
  const c = models.claudeCatalog(tmp(), adapters.get('claude').parseHelp(NEW_HELP));
  assert.deepStrictEqual(c.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.strictEqual(c.defaultEffort, '');
  assert.strictEqual(c.efforts.length, 5);
  const old = models.claudeCatalog(tmp(), adapters.get('claude').parseHelp(OLD_HELP));
  assert.deepStrictEqual(old.efforts, [], '旧版不提供思考强度');
  assert.match(old.effortNote, /升级/);
});

test('旧版 OpenCode：模型列表退回 opencode models，不加 #variant', () => {
  const list = models.parseOpencodePlain('anthropic/claude-opus-4-5\nopenai/gpt-5\n\nsome log line\n');
  assert.deepStrictEqual(list.map((m) => m.id), ['anthropic/claude-opus-4-5', 'openai/gpt-5']);
  assert.strictEqual(list[0].note, 'anthropic');
  const a = adapters.get('opencode').buildArgs({ agent: { model: 'openai/gpt-5', effort: 'high' }, caps: { known: true, json: true, variant: false } });
  assert.deepStrictEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'openai/gpt-5']);
});

test('Codex：模型和思考强度参数，续会话时放在 resume 前面', () => {
  const args = adapters.get('codex').buildArgs({ agent: { model: 'gpt-5.5', effort: 'xhigh' }, cwd: 'E:\\p', sessionId: 't1' });
  assert.deepStrictEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'gpt-5.5']);
  assert.deepStrictEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.ok(args.indexOf('-c') < args.indexOf('resume'));
  assert.deepStrictEqual(args.slice(-3), ['resume', 't1', '-']);
});

test('OpenCode：思考强度写成 model#variant，没选模型时不加', () => {
  const a = adapters.get('opencode').buildArgs({ agent: { model: 'deepseek/deepseek-v4-pro', effort: 'max' } });
  assert.deepStrictEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'deepseek/deepseek-v4-pro#max']);
  const b = adapters.get('opencode').buildArgs({ agent: { effort: 'max' } });
  assert.ok(!b.includes('-m'));
});

test('模型目录：读 Claude Code 设置里的模型选项和别名', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'max', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4-pro' },
      modelPicker: { options: [{ model: 'x-pro[1M]', label: 'X Pro', description: 'big' }] },
    })
  );
  const c = models.claudeCatalog(dir);
  assert.strictEqual(c.models[0].id, 'x-pro[1M]');
  assert.strictEqual(c.models[0].label, 'X Pro');
  assert.match(c.models.find((m) => m.id === 'opus').note, /deepseek-v4-pro/);
  assert.strictEqual(c.defaultEffort, 'max');
  assert.deepStrictEqual(c.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('模型目录：解析 Codex 和 OpenCode 的输出', () => {
  const codex = models.parseCodexModels(
    JSON.stringify({
      models: [
        { slug: 'b', display_name: 'B', priority: 2, supported_reasoning_levels: [{ effort: 'low', description: 'fast' }, { effort: 'high' }], default_reasoning_level: 'low' },
        { slug: 'a', display_name: 'A', priority: 1, supported_reasoning_levels: ['medium'] },
        { slug: 'hidden', visibility: 'hide', priority: 0 },
        { slug: 'old', display_name: 'Old', priority: 0, upgrade: { model: 'a' } },
      ],
    })
  );
  assert.deepStrictEqual(codex.map((m) => m.id), ['a', 'b', 'old'], '按优先级排序、隐藏的不显示、旧版放最后');
  assert.strictEqual(codex[2].label, 'Old（旧版）');
  assert.deepStrictEqual(codex[1].efforts, ['low', 'high']);
  assert.strictEqual(codex[1].effortNotes.low, 'fast');
  const oc = models.parseOpencodeModels(
    JSON.stringify({ data: [{ id: 'm1', providerID: 'p', name: 'M1', variants: ['low', 'max'] }, { id: 'm2', providerID: 'p', enabled: false }] })
  );
  assert.deepStrictEqual(oc, [{ id: 'p/m1', label: 'M1', note: 'p', efforts: ['low', 'max'] }]);
});

test('读 Codex 的 config.toml 顶层设置', () => {
  const f = path.join(tmp(), 'config.toml');
  fs.writeFileSync(f, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "other"\n');
  assert.deepStrictEqual(models.tomlTop(f), { model: 'gpt-6-astra', effort: 'high' });
});

test('API 模型：思考强度和额外请求参数会发给接口', async () => {
  let got = null;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const h = adapters.get('openai').run({
    agent: { name: 'DS', model: 'm', effort: 'high', permission: 'readonly', api: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, extraBody: { thinking: { type: 'enabled' } } } },
    cwd: tmp(),
    apiMessages: [{ role: 'user', content: 'u' }],
    emit: () => {},
  });
  const out = await h.done;
  srv.close();
  assert.strictEqual(out.text, 'ok');
  assert.strictEqual(got.reasoning_effort, 'high');
  assert.deepStrictEqual(got.thinking, { type: 'enabled' });
  assert.strictEqual(got.stream, true);
});

// ---- 技能、文件卡片、消息里的文件链接 ----
const skillsMod = require('../server/skills');
const filesMod = require('../server/files');

test('技能：读 SKILL.md 开头的名字和说明（含折行写法）', () => {
  assert.deepStrictEqual(skillsMod.frontMatter('---\nname: "imagegen"\ndescription: 画图\n---\n正文'), { name: 'imagegen', description: '画图' });
  assert.strictEqual(skillsMod.frontMatter('---\nname: x\ndescription: >\n  第一行\n  第二行\n---').description, '第一行 第二行');
});

test('技能：只认真实存在的 /技能名，路径不算', () => {
  const list = [
    { name: 'frontend-design', tools: ['claude'], file: '', dir: '' },
    { name: 'github:yeet', tools: ['codex'], file: '', dir: '' },
  ];
  const used = skillsMod.usedSkills('@GPT /frontend-design 做个页面，再 /github:yeet。路径 /usr/bin 和 a/frontend-design 不算，`/frontend-design` 也不算', list);
  assert.deepStrictEqual(used.map((s) => s.name), ['frontend-design', 'github:yeet']);
});

test('技能：成员自己装了就让它直接用，没装就把说明附上', () => {
  const dir = tmp();
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: tidy\n---\n先列提纲再动手。');
  const s = [{ name: 'tidy', tools: ['claude'], file, dir }];
  assert.match(skillsMod.skillSection(s, 'claude'), /已经装了这个技能/);
  const inline = skillsMod.skillSection(s, 'codex');
  assert.match(inline, /没有装这个技能/);
  assert.match(inline, /先列提纲再动手/);
  const p = buildCliPrompt({ room: fakeRoom(), agent: fakeRoom().agents[0], messages: MSGS, fresh: true, skillText: inline });
  assert.ok(p.indexOf('先列提纲再动手') < p.indexOf('现在轮到你'), '技能说明放在「轮到你」之前');
});

test('技能：读本机的技能文件夹（含符号链接和 Claude 插件）', () => {
  const home = tmp();
  const os2 = require('os');
  const realHome = os2.homedir;
  os2.homedir = () => home;
  try {
    const mk = (p, body) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    mk(path.join(home, '.agents', 'skills', 'shared-one', 'SKILL.md'), '---\nname: shared-one\ndescription: 通用技能\n---');
    mk(path.join(home, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'), '---\nname: imagegen\n---');
    mk(path.join(home, '.claude', 'commands', 'deploy.md'), '---\ndescription: 发布\n---\n步骤');
    const plugin = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0');
    mk(path.join(plugin, 'skills', 'setup', 'SKILL.md'), '---\nname: setup\n---');
    mk(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: plugin }] } }));
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    try {
      fs.symlinkSync(path.join(home, '.agents', 'skills', 'shared-one'), path.join(home, '.claude', 'skills', 'shared-one'), 'junction');
    } catch {}
    const list = skillsMod.listSkills('', true);
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    assert.deepStrictEqual(by.imagegen.tools, ['codex']);
    assert.deepStrictEqual(by['p:setup'].tools, ['claude'], '插件技能带插件名前缀');
    assert.strictEqual(by.deploy.description, '发布');
    assert.deepStrictEqual(by['shared-one'].tools, ['claude'], '通过符号链接装进 ~/.claude/skills 的也算 Claude 自带');
  } finally {
    os2.homedir = realHome;
  }
});

test('文件卡片：对比前后快照，找出新建、修改、删除的文件', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'edit.md'), 'a');
  const before = filesMod.snapshot(dir);
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'new.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(dir, 'edit.md'), 'changed!');
  fs.unlinkSync(path.join(dir, 'gone.txt'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');
  fs.mkdirSync(path.join(dir, '.agentchat'));
  fs.writeFileSync(path.join(dir, '.agentchat', 'log.md'), '1');
  const d = filesMod.diff(before, filesMod.snapshot(dir), dir);
  assert.deepStrictEqual(d.map((f) => `${f.change}:${f.path}`), ['add:docs/new.html', 'update:edit.md', 'delete:gone.txt']);
});

test('打开文件：各种写法的路径都能认，跑出项目文件夹的拒绝', () => {
  const root = path.resolve(tmp());
  const fwd = root.replace(/\\/g, '/');
  assert.strictEqual(filesMod.resolveInside(root, 'index.html'), path.join(root, 'index.html'));
  assert.strictEqual(filesMod.resolveInside(root, '/' + fwd + '/index.html'), path.join(root, 'index.html'));
  assert.strictEqual(filesMod.resolveInside(root, 'file:///' + fwd + '/a.md'), path.join(root, 'a.md'));
  assert.strictEqual(filesMod.resolveInside(root, 'src/app.js:42'), path.join(root, 'src', 'app.js'));
  assert.strictEqual(filesMod.resolveInside(root, 'docs/%E4%BB%8B%E7%BB%8D.md'), path.join(root, 'docs', '介绍.md'));
  assert.strictEqual(filesMod.resolveInside(root, '../secret.txt'), null);
  assert.strictEqual(filesMod.resolveInside(root, path.join(os.tmpdir(), 'other.txt')), null);
});

test('消息里指向本机文件的链接可以点', () => {
  global.window = {};
  delete require.cache[require.resolve('../public/markdown.js')];
  require('../public/markdown.js');
  const html = global.window.Markdown.render('已新建 [index.html](/E:/test/index.html)，另见 [官网](https://example.com)');
  assert.match(html, /<a href="#" class="file-link" data-file-link="\/E:\/test\/index.html">index.html<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank"/);
  delete global.window;
});

// ---- 右侧面板 ----
const waitFor = (cond, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('超时'));
      setTimeout(tick, 20);
    };
    tick();
  });

test('文件面板：列出一层、标出依赖文件夹、按名字搜索，跑出项目文件夹的拒绝', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), '1');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'app.js'), '1');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  const top = filesMod.listDir(root, '');
  assert.deepStrictEqual(top.entries.map((e) => e.name), ['node_modules', 'src', 'README.md']);
  assert.ok(top.entries[0].dir && top.entries[0].heavy);
  assert.ok(!top.entries[1].heavy);
  assert.strictEqual(top.entries[2].size, 4);
  assert.deepStrictEqual(filesMod.listDir(root, 'src').entries.map((e) => e.name), ['app.js']);
  assert.strictEqual(filesMod.listDir(root, '..'), null);
  assert.strictEqual(filesMod.listDir(root, path.dirname(root)), null);
  // 搜索不进 node_modules；输入里带 / 时按路径搜
  assert.deepStrictEqual(filesMod.findFiles(root, 'APP').map((r) => r.path), ['src/app.js']);
  assert.deepStrictEqual(filesMod.findFiles(root, 'src/a').map((r) => r.path), ['src/app.js']);
  assert.deepStrictEqual(filesMod.findFiles(root, ''), []);
});

test('侧边对话：只读、不进群聊、不触发接力；之后续上自己的会话，只带新消息', async () => {
  const { SideChat } = require('../server/side');
  const seen = [];
  const { store, orch, room } = setupRoom((agent, prompt) => {
    seen.push({ name: agent.name, permission: agent.permission, prompt });
    return '项目里有 index.html。@Claude 你也看看'; // 侧边对话里 @ 了别人也不该唤醒谁
  });
  room.agents[0].permission = 'full';
  store.addMessage(room.id, { from: 'user', name: '用户', kind: 'user', text: '做一个待办网页' });
  const events = [];
  const side = new SideChat(store, { send: (event, data) => events.push({ event, data }) });

  side.ask(room.id, 'g', '项目里有什么文件？');
  assert.throws(() => side.ask(room.id, 'g', '再问一个'), /还在回答/);
  await waitFor(() => !side.anyBusy());
  assert.strictEqual(seen[0].permission, 'readonly');
  assert.match(seen[0].prompt, /# 侧边对话/);
  assert.match(seen[0].prompt, /只读/);
  assert.match(seen[0].prompt, /做一个待办网页/);
  assert.match(seen[0].prompt, /项目里有什么文件？/);
  const sideMsgs = store.sideMessages(room.id);
  assert.deepStrictEqual(sideMsgs.map((m) => [m.from, m.status || '']), [['user', ''], ['g', 'done']]);
  assert.strictEqual(store.messages(room.id).length, 1); // 群聊里没多出消息
  assert.ok(!orch.isBusy(room.id)); // 也没有触发接力
  assert.strictEqual(room.sideSessions.g, 's-g');
  assert.strictEqual(room.sessions.g, undefined); // 群聊的会话不受影响
  assert.ok(events.some((e) => e.event === 'side-message') && events.some((e) => e.event === 'side-progress'));

  store.addMessage(room.id, { from: 'user', name: '用户', kind: 'user', text: '再加一个删除按钮' });
  side.ask(room.id, 'g', '现在呢？');
  await waitFor(() => !side.anyBusy());
  assert.doesNotMatch(seen[1].prompt, /# 侧边对话/);
  assert.match(seen[1].prompt, /再加一个删除按钮/);
  assert.doesNotMatch(seen[1].prompt, /做一个待办网页/);

  // 换一个成员问：它是第一次来，要带上前面的侧边对话
  side.ask(room.id, 'c', '你怎么看？');
  await waitFor(() => !side.anyBusy());
  assert.match(seen[2].prompt, /之前的侧边对话/);
  assert.match(seen[2].prompt, /项目里有什么文件？/);

  side.clear(room.id);
  assert.deepStrictEqual(store.sideMessages(room.id), []);
  assert.deepStrictEqual(room.sideSessions, {});
});

test('终端：在项目文件夹里打开，输入命令能看到输出，输出序号连续', async () => {
  const { Terminals } = require('../server/terminal');
  const ev = [];
  const terms = new Terminals({ send: (event, data) => ev.push({ event, data }) });
  if (!terms.available().ok) return console.log('    （这台电脑上终端组件不可用，跳过）');
  const dir = tmp();
  const t = terms.create({ roomId: 'r1', cwd: dir, cols: 100, rows: 30 });
  try {
    await waitFor(() => terms.buffer(t.id).buffer.length > 0, 15000);
    terms.write(t.id, 'echo agentchat-$((20+22))\r');
    await waitFor(() => terms.buffer(t.id).buffer.includes('agentchat-42'), 15000);
    const seqs = ev.filter((e) => e.event === 'term').map((e) => e.data.seq);
    assert.ok(seqs.length > 0);
    assert.deepStrictEqual(seqs, seqs.map((_, i) => i + 1));
    assert.strictEqual(terms.buffer(t.id).seq, seqs[seqs.length - 1]);
    assert.deepStrictEqual(terms.forRoom('r1').map((x) => x.id), [t.id]);
  } finally {
    terms.killAll();
  }
  assert.deepStrictEqual(terms.forRoom('r1'), []);
  assert.throws(() => terms.write(t.id, 'x'), /已经关闭/);
});

test('终端：换了项目文件夹时关掉旧终端，只通知界面一次，带上原因和新文件夹', async () => {
  const { Terminals } = require('../server/terminal');
  const ev = [];
  const terms = new Terminals({ send: (event, data) => ev.push({ event, data }) });
  if (!terms.available().ok) return console.log('    （这台电脑上终端组件不可用，跳过）');
  const t = terms.create({ roomId: 'p1', cwd: tmp(), cols: 80, rows: 24 });
  terms.create({ roomId: 'p2', cwd: tmp(), cols: 80, rows: 24 });
  try {
    await waitFor(() => terms.buffer(t.id).buffer.length > 0, 15000);
    terms.killRoom('p1', { reason: 'moved', to: 'E:\\new' });
    assert.deepStrictEqual(terms.forRoom('p1'), []);
    assert.strictEqual(terms.forRoom('p2').length, 1, '别的项目的终端不动');
    await new Promise((r) => setTimeout(r, 1500)); // 等进程真的退出：退出时不能再发一次
    const exits = ev.filter((e) => e.event === 'term-exit' && e.data.id === t.id).map((e) => e.data);
    assert.deepStrictEqual(exits, [{ id: t.id, roomId: 'p1', code: null, reason: 'moved', to: 'E:\\new' }]);
  } finally {
    terms.killAll();
  }
});

test('项目和会话：旧数据按文件夹归进项目；只有一个会话时，会话用第一条消息起标题', () => {
  const { autoTitle } = require('../server/store');
  assert.strictEqual(autoTitle('@GPT @Claude 做一个待办清单网页\n要能离线用'), '做一个待办清单网页');
  assert.strictEqual(autoTitle('/frontend-design 设计一个登录页'), '设计一个登录页');
  assert.strictEqual(autoTitle('@GPT请设计'), '@GPT请设计'); // 名字后面没有空格时不拆
  assert.strictEqual([...autoTitle('一'.repeat(40))].length, 25); // 24 个字加省略号
  const dir = tmp();
  const ws1 = tmp();
  const ws2 = tmp();
  const mk = (id, name, ws, createdAt, msgs = []) => {
    fs.mkdirSync(path.join(dir, 'rooms', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rooms', id, 'room.json'), JSON.stringify({ id, name, workspace: ws, agents: [], createdAt, updatedAt: createdAt }));
    fs.writeFileSync(path.join(dir, 'rooms', id, 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + (msgs.length ? '\n' : ''));
  };
  mk('r_a', '网页项目', ws1, 1, [{ id: 'm1', seq: 1, kind: 'user', from: 'user', text: '@GPT 做一个待办清单网页，要能离线用' }]);
  mk('r_b', '第二个', ws2, 2, [{ id: 'm2', seq: 1, kind: 'system', from: 'system', text: '系统消息不算' }]);
  // 末尾多一个斜杠也是同一个文件夹
  mk('r_c', '同一个文件夹', ws2 + path.sep, 3, [{ id: 'm3', seq: 1, kind: 'user', from: 'user', text: '@Claude 修一下登录页' }]);
  const s = new Store(dir);
  const projects = s.listProjects();
  assert.strictEqual(projects.length, 2);
  const p1 = projects.find((p) => p.workspace === ws1);
  assert.strictEqual(p1.name, '网页项目'); // 只有一个会话：项目沿用原来的名字
  assert.strictEqual(s.getRoom('r_a').name, '做一个待办清单网页，要能离线用');
  const p2 = projects.find((p) => p.workspace === ws2);
  assert.strictEqual(p2.name, path.basename(ws2)); // 几个合在一起：用文件夹名
  // 旧数据还没排过顺序：按最近动过的先后编号，和升级前左边栏里的顺序一样
  assert.deepStrictEqual(projects.map((p) => p.id), [p2.id, p1.id]);
  assert.deepStrictEqual(s.roomsOf(p2.id).map((r) => r.id), ['r_c', 'r_b']);
  assert.strictEqual(s.getRoom('r_b').name, '第二个');
  assert.strictEqual(s.getRoom('r_c').name, '同一个文件夹'); // 几个合在一起：原来的名字留给会话，不用第一条消息改名
  assert.strictEqual(s.getRoom('r_c').workspace, ws2);
  // 记下来了：再读一遍还是这样，不会再迁移一次
  const again = new Store(dir);
  assert.strictEqual(again.listProjects().length, 2);
  assert.deepStrictEqual(again.listProjects().map((p) => p.id), [p2.id, p1.id]); // 编好的顺序存下来了
  assert.strictEqual(again.getRoom('r_a').projectId, p1.id);
  // 只给文件夹建会话（旧的写法）：放进用这个文件夹的项目
  const r = again.createRoom({ name: 'x', workspace: ws1 });
  assert.strictEqual(r.projectId, p1.id);
  again.deleteProject(p2.id);
  assert.strictEqual(again.getRoom('r_b'), null);
  assert.strictEqual(fs.existsSync(path.join(dir, 'rooms', 'r_c')), false);
});

test('用量：各家工具的输出统一成 模型 + 输入 / 输出 / 缓存', () => {
  const { addUsage } = require('../server/adapters/common');
  const { claudeUsage } = require('../server/adapters/claude');
  const { codexUsage } = require('../server/adapters/codex');
  const { opencodeUsage } = require('../server/adapters/opencode');
  const { apiUsage } = require('../server/adapters/openai');
  // 同一个模型合并成一行，全是 0 的不要
  const rows = [];
  addUsage(rows, 'm1', { input: 10, output: 2 });
  addUsage(rows, 'm1', { input: 5, cacheRead: 7 });
  addUsage(rows, 'm2', { input: 0, output: 0 });
  assert.deepStrictEqual(rows, [{ model: 'm1', input: 15, output: 2, cacheRead: 7, cacheWrite: 0 }]);
  // Claude Code：最终结果里按模型分好的 modelUsage
  const result = {
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
      'claude-haiku-5-5': { inputTokens: 8, outputTokens: 2 },
    },
  };
  assert.deepStrictEqual(claudeUsage(result, new Map(), ''), [
    { model: 'claude-opus-5-5', input: 100, output: 20, cacheRead: 300, cacheWrite: 40 },
    { model: 'claude-haiku-5-5', input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
  ]);
  // 被中止、没有最终结果：用每条回复各自的用量
  const per = new Map([
    ['msg1', { model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 } }],
    ['msg2', { model: '', usage: { input_tokens: 1, output_tokens: 1 } }],
  ]);
  assert.deepStrictEqual(claudeUsage(null, per, 'claude-opus-5-5'), [{ model: 'claude-opus-5-5', input: 4, output: 5, cacheRead: 5, cacheWrite: 0 }]);
  // Codex：cached_input_tokens 是 input_tokens 里命中缓存的部分
  assert.deepStrictEqual(codexUsage({ input_tokens: 1000, cached_input_tokens: 300, output_tokens: 50 }), {
    input: 700,
    cacheRead: 300,
    cacheWrite: undefined,
    output: 50,
  });
  // OpenCode：只算这一轮的回复，思考也算输出，模型写成 提供商/模型
  const since = Date.now();
  const list = [
    { type: 'user', tokens: { input: 999 } },
    { type: 'assistant', time: { created: since - 60000 }, model: { providerID: 'deepseek', id: 'v4' }, tokens: { input: 50, output: 5 } },
    { type: 'assistant', time: { created: since + 10 }, model: { providerID: 'deepseek', id: 'v4' }, tokens: { input: 20, output: 3, reasoning: 7, cache: { read: 100, write: 2 } } },
  ];
  assert.deepStrictEqual(opencodeUsage(list, since), [{ model: 'deepseek/v4', input: 20, output: 10, cacheRead: 100, cacheWrite: 2 }]);
  // API：OpenAI 和 DeepSeek 写缓存命中的地方不一样
  assert.deepStrictEqual(apiUsage({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } }), { input: 20, cacheRead: 100, output: 30 });
  assert.deepStrictEqual(apiUsage({ prompt_tokens: 50, completion_tokens: 9, prompt_cache_hit_tokens: 40 }), { input: 10, cacheRead: 40, output: 9 });
  assert.strictEqual(apiUsage(null), null);
});

test('用量统计：按天、按模型汇总，存进 usage.jsonl，坏行跳过', async () => {
  const { Usage, dayKey, recordRun } = require('../server/usage');
  const dir = tmp();
  const u = new Usage(dir);
  const day1 = new Date(2026, 2, 3, 10).getTime();
  const day2 = new Date(2026, 2, 4, 23).getTime();
  u.record({ ts: day1, agent: 'Claude', adapter: 'claude', ms: 5000, rows: [{ model: 'opus', input: 100, output: 10 }] });
  u.record({ ts: day2, agent: 'Claude', adapter: 'claude', ms: 9000, rows: [{ model: 'opus', input: 50, cacheRead: 50 }, { model: '', input: 1 }] });
  u.record({ ts: day2, agent: 'GPT', adapter: 'codex', ms: 1000, rows: [{ model: 'default', input: 7 }] });
  assert.strictEqual(u.record({ ts: day2, rows: [{ model: 'x', input: 0 }] }), null); // 全是 0 的不记
  fs.appendFileSync(path.join(dir, 'usage.jsonl'), '{坏掉的一行\n');
  const s = new Usage(dir).summary(); // 重新读文件
  assert.strictEqual(s.runs, 3);
  assert.strictEqual(s.since, day1);
  assert.deepStrictEqual(
    s.models.map((m) => [m.model, m.total, m.runs, m.adapters.join()]),
    [
      ['opus', 210, 2, 'claude'],
      ['default:codex', 7, 1, 'codex'],
      ['default:claude', 1, 1, 'claude'],
    ]
  );
  assert.deepStrictEqual(
    s.daily.filter((d) => d.m === 'opus').map((d) => [d.d, d.t]),
    [
      [dayKey(day1), 110],
      [dayKey(day2), 100],
    ]
  );
  assert.strictEqual(s.longest.all, 9000);
  assert.strictEqual(s.longest.byModel['default:codex'], 1000);
  // 跑完一轮：OpenCode 的用量要再读一次；没写模型的用工具的默认模型
  const u2 = new Usage(tmp());
  const room = { id: 'r1', name: '测试' };
  await recordRun(u2, { room, agent: { id: 'o', name: 'OC', adapter: 'opencode' }, res: { usageFetch: async () => [{ model: 'ds/v4', input: 3, output: 1 }] }, startedAt: Date.now() - 50 });
  await recordRun(u2, { room, agent: { id: 'a', name: 'API', adapter: 'openai', model: 'deepseek-chat' }, res: { usage: [{ model: '', input: 9 }] }, side: true });
  await recordRun(u2, { room, agent: { id: 'a', name: 'API', adapter: 'openai' }, res: { error: '出错', usage: [] } });
  const runs = u2.runs;
  assert.strictEqual(runs.length, 2);
  assert.deepStrictEqual(runs[0].rows, [{ model: 'ds/v4', input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }]);
  assert.ok(runs[0].ms >= 50);
  assert.strictEqual(runs[1].rows[0].model, 'deepseek-chat');
  assert.strictEqual(runs[1].side, true);
});

test('设置：默认值、只收合法的值、保存到 settings.json', () => {
  const { Settings, readSettings, DEFAULTS } = require('../server/settings');
  const dir = tmp();
  const s = new Settings(dir);
  assert.deepStrictEqual(s.get(), DEFAULTS);
  const next = s.update({ name: '  Jensen Liu 的名字特别特别特别长一直写下去  ', color: '#b4610c', theme: 'dark', language: 'en', sendKey: 'ctrl-enter', notify: false });
  assert.strictEqual(next.name, 'Jensen Liu 的名字特别特别特别长一直写下去'.slice(0, 24));
  assert.strictEqual(next.color, '#B4610C');
  assert.strictEqual(next.theme, 'dark');
  assert.strictEqual(next.language, 'en');
  assert.strictEqual(next.sendKey, 'ctrl-enter');
  assert.strictEqual(next.notify, false);
  // 不认识的值不改
  const same = s.update({ color: 'red', theme: 'purple', language: 'fr', sendKey: 'space' });
  assert.deepStrictEqual(same, next);
  assert.deepStrictEqual(readSettings(dir), next);
  fs.writeFileSync(path.join(dir, 'settings.json'), '这不是 JSON');
  assert.deepStrictEqual(readSettings(dir), DEFAULTS);
});

test('界面语言：查词典、占位符、英文单复数、同字不同义的语境键', () => {
  const vm = require('vm');
  const ctx = { window: {}, document: { documentElement: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), ctx);
  const I = ctx.window.I18N;
  assert.strictEqual(I.t('发给 {names}', { names: 'GPT' }), '发给 GPT');
  assert.strictEqual(I.t('思考强度::关闭'), '关闭'); // 中文只显示原文
  I.preload('en', { '{n} 天': '{n} {n|day|days}', '思考强度::关闭': 'Off', '关闭': 'Close' });
  I.setLang('en');
  assert.strictEqual(ctx.document.documentElement.lang, 'en');
  assert.strictEqual(I.t('{n} 天', { n: 1 }), '1 day');
  assert.strictEqual(I.t('{n} 天', { n: 12 }), '12 days');
  assert.strictEqual(I.t('思考强度::关闭'), 'Off');
  assert.strictEqual(I.t('关闭'), 'Close');
  assert.strictEqual(I.t('词典里没有的'), '词典里没有的');
  assert.strictEqual(I.t('{a} 和 {b}', { a: 1 }), '{a} 和 {b}'.replace('{a}', '1'));
  I.setLang('fr');
  assert.strictEqual(I.lang, 'zh-Hans');
  // 服务端：跟着设置里的语言
  const i18n = require('../server/i18n');
  let lang = 'en';
  i18n.bind(() => lang);
  try {
    assert.strictEqual(i18n.t('{n} 天', { n: 2 }), '2 days');
    assert.strictEqual(i18n.t('终端 {n}', { n: 3 }), 'Terminal 3');
    lang = 'zh-Hant';
    assert.strictEqual(i18n.t('设置'), '設定');
    assert.strictEqual(i18n.t('思考强度::关闭'), '關閉');
    lang = 'zh-Hans';
    assert.strictEqual(i18n.t('思考强度::关闭'), '关闭');
  } finally {
    i18n.bind(() => 'zh-Hans');
  }
});

test('界面语言：每个词典都翻译了代码里所有的文字，占位符一致', () => {
  const { collect, holes } = require('../scripts/i18n-keys');
  const { keys, problems } = collect();
  assert.deepStrictEqual(problems, []);
  assert.ok(keys.size > 500);
  const dir = path.join(__dirname, '..', 'public', 'i18n');
  for (const f of ['en.json', 'zh-Hant.json']) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const missing = [...keys.keys()].filter((k) => !dict[k]);
    assert.deepStrictEqual(missing, [], `${f} 缺翻译`);
    const bad = [...keys.keys()].filter((k) => holes(dict[k]) !== holes(k));
    assert.deepStrictEqual(bad, [], `${f} 占位符对不上`);
  }
  // 示例消息里的 @所有人 翻译以后也得是能用的别名
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  assert.deepStrictEqual(parseMentions(en['@所有人 用一两句话介绍一下自己擅长做什么。'], A), ['all']);
  assert.deepStrictEqual(parseMentions('@' + en['所有人'], A), ['all']);
});

test('使用说明：只给 GitHub 看的整行 HTML（图标、截图、语言链接）去掉，代码块里的不动', () => {
  const { readmeForApp } = require('../server');
  const src = [
    '<div align="center">',
    '',
    '<picture>',
    '  <source media="(prefers-color-scheme: light)" srcset="build/icon-day.png">',
    '  <img src="build/icon.png" width="112" alt="Nightshift">',
    '</picture>',
    '',
    '# Nightshift',
    '',
    '<p><a href="README.en.md">English</a></p>',
    '',
    '</div>',
    '',
    '正文里的 <b>标签</b> 不是整行，留着',
    '<!-- 注释 -->',
    '',
    '```html',
    '<p>代码</p>',
    '```',
    '',
  ].join('\n');
  assert.strictEqual(readmeForApp(src), '# Nightshift\n\n正文里的 <b>标签</b> 不是整行，留着\n\n```html\n<p>代码</p>\n```\n');
  // 三份使用说明都以标题开头，没有剩下的 HTML 行
  for (const f of ['README.md', 'README.en.md', 'README.zh-Hant.md']) {
    const text = readmeForApp(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    assert.match(text, /^# Nightshift\n/, f);
    assert.doesNotMatch(text, /^\s*<(picture|source|img|div|p)\b/m, f);
  }
});

test('设置和用量接口；换了语言，服务端的报错和 boot.js 跟着换', async () => {
  const { start } = require('../server');
  const dir = tmp();
  // 先在数据文件夹里放一个会话，里面有一条带交付验收清单的发言（服务端启动时读进来）
  const seed = new Store(dir);
  const sroom = seed.createRoom({ name: '验收', workspace: tmp(), settings: { acceptance: true } });
  const accItems = [
    { id: 'tests', s: 'fail', f: [{ c: 'test-none' }] },
    { id: 'launch', s: 'user', f: [{ c: 'launch-try', file: 'dist/app.exe' }] },
    { id: 'source', s: 'pass', f: [{ c: 'src-ok', files: ['app.py'], n: 1 }] },
  ];
  const smsg = seed.addMessage(sroom.id, { from: 'x', name: 'GPT', kind: 'agent', status: 'done', text: '做好了，请验收', acceptance: { at: 1, since: 0, report: false, items: accItems, cleanup: [] } });
  const srv = await start({ dataDir: dir, port: 0 });
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        srv.url + p,
        { method, headers: { 'x-agent-chat': '1', ...(data ? { 'content-type': 'application/json' } : {}) } },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, text: buf, json: () => JSON.parse(buf) }));
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  try {
    assert.strictEqual((await call('GET', '/api/settings')).json().language, 'zh-Hans');
    assert.match((await call('POST', '/api/rooms', { name: '' })).json().error, /请给项目起个名字/);
    let boot = (await call('GET', '/boot.js')).text;
    assert.match(boot, /window\.__BOOT__ = \{"settings"/);
    assert.doesNotMatch(boot, /I18N\.preload/);
    const s = (await call('PATCH', '/api/settings', { language: 'en', theme: 'dark', name: 'Lau' })).json();
    assert.strictEqual(s.language, 'en');
    assert.match((await call('POST', '/api/rooms', { name: '' })).json().error, /^Give the project a name$/);
    boot = (await call('GET', '/boot.js')).text;
    assert.match(boot, /window\.I18N\.preload\("en", \{/);
    assert.match(boot, /window\.I18N\.setLang\("en"\)/);
    assert.match(boot, /dataset\.theme = "dark"/);
    assert.strictEqual((await call('PATCH', '/api/settings', { language: 'klingon' })).json().language, 'en');
    const env = (await call('GET', '/api/env')).json();
    assert.strictEqual(env.adapters.openai.label, 'API model');
    // 消息里提到的项目外文件只能「在文件夹中显示」：相对路径、不存在的都拒绝（这里不测存在的，免得真的弹出资源管理器）
    assert.strictEqual((await call('POST', '/api/files/reveal', { path: 'docs/a.md' })).status, 400);
    assert.match((await call('POST', '/api/files/reveal', { path: path.join(tmp(), 'nope.md') })).json().error, /Can't find this file|找不到这个文件/);
    // 英文界面的使用说明是 README.en.md，去掉了只给 GitHub 看的图标和截图
    const help = (await call('GET', '/api/readme')).json().text;
    assert.match(help, /^# Nightshift\n/);
    assert.match(help, /^Several AIs working together on one project$/m);
    assert.doesNotMatch(help, /<picture|<img/);
    const u = (await call('GET', '/api/usage')).json();
    assert.deepStrictEqual([u.runs, u.models, u.daily], [0, [], []]);
    // 项目是一个文件夹，里面可以有好几个会话，每个会话自己配成员
    const ws = tmp();
    const made = (await call('POST', '/api/projects', { name: '待办 App', workspace: ws, template: 'blank' })).json();
    assert.strictEqual(made.project.name, '待办 App');
    assert.strictEqual(made.room.projectId, made.project.id);
    assert.strictEqual(made.room.projectName, '待办 App');
    assert.strictEqual(made.room.autoName, true);
    const rid = made.room.id;
    const ag = (
      await call('POST', `/api/rooms/${rid}/agents`, { name: 'DS', adapter: 'openai', model: 'deepseek-chat', permission: 'edit', enabled: false, api: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test' } })
    ).json();
    await call('PATCH', `/api/rooms/${rid}`, { settings: { defaultAgent: ag.id, maxAutoTurns: 7 } });
    // 成员需要你确认时：只收三种，默认人工审查。审查模型可以是会话成员，也可以专门接入一个（只读，Key 打码）
    assert.strictEqual(made.room.settings.approval, 'manual');
    assert.strictEqual((await call('PATCH', `/api/rooms/${rid}`, { settings: { approval: 'yolo' } })).status, 400);
    const rs = (await call('PATCH', `/api/rooms/${rid}`, { settings: { approval: 'auto', reviewer: ag.id } })).json().settings;
    assert.deepStrictEqual([rs.approval, rs.reviewer], ['auto', ag.id]);
    assert.strictEqual((await call('PATCH', `/api/rooms/${rid}`, { settings: { reviewer: 'own' } })).json().settings.reviewer, '', '还没有专门的审查模型');
    const withRv = (
      await call('PUT', `/api/rooms/${rid}/reviewer`, { adapter: 'openai', model: 'deepseek-chat', permission: 'full', api: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-reviewer-1234' } })
    ).json();
    assert.deepStrictEqual(
      [withRv.settings.reviewer, withRv.reviewer.permission, withRv.reviewer.api.apiKey, withRv.reviewer.api.hasKey],
      ['own', 'readonly', 'sk-••••1234', true]
    );
    assert.strictEqual((await call('PUT', `/api/rooms/${rid}/reviewer`, { adapter: 'openai', model: '' })).status, 400);
    // 新会话默认照搬当前会话的成员：新的 id，配置（连同 Key）一样，默认接收人跟着对上；
    // 「成员需要你确认时」和专门的审查模型也照搬
    const second = (await call('POST', `/api/projects/${made.project.id}/rooms`, { from: rid })).json();
    assert.notStrictEqual(second.id, rid);
    assert.deepStrictEqual(second.agents.map((a) => [a.name, a.model, a.api.hasKey]), [['DS', 'deepseek-chat', true]]);
    assert.notStrictEqual(second.agents[0].id, ag.id);
    assert.strictEqual(second.settings.defaultAgent, second.agents[0].id);
    assert.strictEqual(second.settings.maxAutoTurns, 7);
    assert.deepStrictEqual([second.settings.approval, second.settings.reviewer, second.reviewer.model, second.reviewer.api.hasKey], ['auto', 'own', 'deepseek-chat', true]);
    assert.notStrictEqual(second.reviewer.id, withRv.reviewer.id);
    // 改这个会话的成员，不影响另一个会话
    await call('PATCH', `/api/rooms/${second.id}/agents/${second.agents[0].id}`, { model: 'deepseek-reasoner' });
    assert.strictEqual((await call('GET', `/api/rooms/${rid}`)).json().room.agents[0].model, 'deepseek-chat');
    // 第一条消息给会话起标题
    await call('POST', `/api/rooms/${second.id}/messages`, { text: '@DS 帮我把首页的按钮改成圆角\n顺便看看手机上的样子' });
    const titled = (await call('GET', `/api/rooms/${second.id}`)).json().room;
    assert.strictEqual(titled.name, '帮我把首页的按钮改成圆角');
    assert.strictEqual(titled.autoName, false);
    const order = async () => (await call('GET', '/api/projects')).json().find((p) => p.id === made.project.id).rooms.map((r) => r.id);
    assert.deepStrictEqual(await order(), [second.id, rid]); // 新会话在最上面
    // 拖动排序、置顶：置顶的总在前面，拖不到没置顶的后面去；取消置顶后排在没置顶的第一个
    await call('POST', `/api/projects/${made.project.id}/order`, { ids: [rid, second.id] });
    assert.deepStrictEqual(await order(), [rid, second.id]);
    assert.strictEqual((await call('PATCH', `/api/rooms/${second.id}`, { pinned: true })).json().pinned, true);
    assert.deepStrictEqual(await order(), [second.id, rid]);
    await call('POST', `/api/projects/${made.project.id}/order`, { ids: [rid, second.id] });
    assert.deepStrictEqual(await order(), [second.id, rid]);
    await call('PATCH', `/api/rooms/${second.id}`, { pinned: false });
    assert.strictEqual((await call('GET', `/api/rooms/${second.id}`)).json().room.pinned, false);
    // 项目也能排：新建的在最上面，拖动以后按拖的顺序
    const other = (await call('POST', '/api/projects', { name: '另一个', workspace: tmp(), template: 'blank' })).json().project;
    const projectIds = async () => (await call('GET', '/api/projects')).json().map((p) => p.id).filter((id) => id === other.id || id === made.project.id);
    assert.deepStrictEqual(await projectIds(), [other.id, made.project.id]);
    await call('POST', '/api/projects/order', { ids: [made.project.id, other.id] });
    assert.deepStrictEqual(await projectIds(), [made.project.id, other.id]);
    await call('DELETE', `/api/projects/${other.id}`);
    // 不属于项目的会话（左边栏的「新建会话」）：不用选文件夹，Nightshift 在数据文件夹的 chats 里给它建一个；
    // 成员照搬 from 那个会话。它也存成一个项目（standalone），名字跟着会话
    const chat = (await call('POST', '/api/chats', { from: rid })).json();
    assert.deepStrictEqual([chat.standalone, chat.projectName, chat.name, chat.autoName], [true, '', 'New chat', true]); // 这时界面是英文
    assert.strictEqual(path.dirname(chat.workspace), path.join(dir, 'chats'));
    assert.ok(fs.statSync(chat.workspace).isDirectory());
    assert.deepStrictEqual(chat.agents.map((a) => [a.name, a.model]), [['DS', 'deepseek-chat']]);
    assert.strictEqual(chat.settings.defaultAgent, chat.agents[0].id);
    assert.deepStrictEqual((await call('POST', '/api/chats', { template: 'blank' })).json().agents, []);
    const looseOf = async () => (await call('GET', '/api/projects')).json().filter((p) => p.standalone);
    assert.strictEqual((await call('GET', '/api/projects')).json().find((p) => p.id === made.project.id).standalone, false);
    await call('POST', `/api/rooms/${chat.id}/messages`, { text: '@DS 随便问问：正则怎么匹配邮箱' });
    const cp = (await looseOf()).find((p) => p.id === chat.projectId);
    assert.deepStrictEqual([cp.name, cp.rooms.map((r) => r.id)], ['随便问问：正则怎么匹配邮箱', [chat.id]]);
    // 排的是它们各自占的项目：新建的在最上面；置顶、取消置顶时放到最上面；拖动以后按拖的顺序
    const chat2 = (await call('POST', '/api/chats', { from: chat.id })).json();
    const looseIds = async () => (await looseOf()).map((p) => p.rooms[0].id).filter((id) => id === chat.id || id === chat2.id);
    assert.deepStrictEqual(await looseIds(), [chat2.id, chat.id]);
    await call('PATCH', `/api/rooms/${chat.id}`, { pinned: true });
    assert.deepStrictEqual(await looseIds(), [chat.id, chat2.id]);
    await call('POST', '/api/projects/order', { ids: [chat2.projectId, chat.projectId] });
    assert.deepStrictEqual(await looseIds(), [chat2.id, chat.id]);
    assert.deepStrictEqual(await projectIds(), [made.project.id], '排不属于项目的会话不影响项目');
    // 删会话：它占的项目和 Nightshift 建的文件夹一起删（这里不是桌面版，直接删）
    fs.writeFileSync(path.join(chat.workspace, 'notes.md'), '# 随手记\n');
    await call('DELETE', `/api/rooms/${chat.id}`);
    assert.ok(!(await looseOf()).some((p) => p.id === chat.projectId));
    assert.ok(!fs.existsSync(chat.workspace));
    // 文件夹被换到 chats 外面的，删会话时不动那个文件夹
    const elsewhere = tmp();
    await call('PATCH', `/api/rooms/${chat2.id}`, { workspace: elsewhere });
    await call('DELETE', `/api/rooms/${chat2.id}`);
    assert.ok(fs.existsSync(elsewhere));
    assert.ok(!(await looseOf()).some((p) => p.id === chat2.projectId));
    // 终端属于项目：从哪个会话打开都是同一组
    const termList = (await call('GET', `/api/term?room=${second.id}`)).json();
    assert.deepStrictEqual(termList.terminals, []);
    const t1 = termList.available ? (await call('POST', '/api/term', { roomId: rid, cols: 80, rows: 24 })).json() : null;
    if (t1) assert.strictEqual(t1.cwd, ws);
    // 换文件夹：整个项目一起换；开着的终端还在旧文件夹里，一起关掉，新开的在新文件夹里
    const ws2 = tmp();
    await call('PATCH', `/api/projects/${made.project.id}`, { workspace: ws2, name: '待办 App 2' });
    for (const id of [rid, second.id]) {
      const room = (await call('GET', `/api/rooms/${id}`)).json().room;
      assert.deepStrictEqual([room.workspace, room.projectName], [ws2, '待办 App 2']);
    }
    if (t1) {
      assert.deepStrictEqual((await call('GET', `/api/term?room=${second.id}`)).json().terminals, []);
      assert.strictEqual((await call('POST', '/api/term', { roomId: second.id, cols: 80, rows: 24 })).json().cwd, ws2);
    }
    // 交付验收清单：会话设置里的开关（默认关）；「待你确认」的项点通过 / 不通过、没通过的项点「仍然通过」（空的就是取消），
    // 记在消息上、存进文件；通过了的项不用点
    assert.strictEqual(second.settings.acceptance, false);
    assert.strictEqual((await call('PATCH', `/api/rooms/${second.id}`, { settings: { acceptance: true } })).json().settings.acceptance, true);
    const vote = (item, verdict, mid = smsg.id) => call('POST', `/api/rooms/${sroom.id}/messages/${mid}/acceptance`, { item, verdict });
    const verdictOf = (m, id) => m.acceptance.items.find((it) => it.id === id).u;
    const onDisk = (id) => verdictOf(JSON.parse(fs.readFileSync(path.join(dir, 'rooms', sroom.id, 'messages.jsonl'), 'utf8').trim()), id);
    assert.strictEqual(verdictOf((await vote('launch', 'fail')).json(), 'launch'), 'fail');
    assert.strictEqual(onDisk('launch'), 'fail');
    assert.strictEqual(verdictOf((await call('GET', `/api/rooms/${sroom.id}`)).json().messages[0], 'launch'), 'fail');
    assert.strictEqual(verdictOf((await vote('launch', '')).json(), 'launch'), undefined);
    assert.strictEqual(onDisk('launch'), undefined);
    assert.strictEqual(verdictOf((await vote('tests', 'pass')).json(), 'tests'), 'pass', '没通过的项可以点「仍然通过」');
    assert.strictEqual(onDisk('tests'), 'pass');
    assert.strictEqual((await vote('source', 'fail')).status, 400, '通过了的项不用点');
    assert.strictEqual((await vote('launch', 'pass', 'm_nope')).status, 404);
    // 附件：桌面版按完整路径添加（项目里的直接用，项目外的复制）；浏览器把内容传上来，写进同一个地方；
    // 发消息时带上，只有附件也能发，没起名字的会话用附件的名字起标题
    const wsNow = (await call('GET', `/api/rooms/${rid}`)).json().room.workspace;
    fs.writeFileSync(path.join(wsNow, 'spec.md'), '# spec');
    const elsewhere2 = tmp();
    fs.writeFileSync(path.join(elsewhere2, 'logo.png'), 'png');
    const added = (await call('POST', `/api/rooms/${rid}/attachments`, { paths: [path.join(wsNow, 'spec.md'), path.join(elsewhere2, 'logo.png')] })).json().items;
    assert.deepStrictEqual(
      added.map((a) => [a.path.replace(/\d{8}-\d{6}(-\d+)?/, 'T'), a.kind, !!a.from]),
      [
        ['spec.md', 'file', false],
        ['.agentchat/attachments/T/logo.png', 'file', true],
      ]
    );
    assert.match((await call('POST', `/api/rooms/${rid}/attachments`, { paths: [path.join(elsewhere2, 'nope.txt')] })).json().error, /Can't find “nope\.txt”/);
    const raw = (method, p, data) =>
      new Promise((resolve, reject) => {
        const req = http.request(srv.url + p, { method, headers: { 'x-agent-chat': '1' } }, (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(buf) }));
        });
        req.on('error', reject);
        req.end(data);
      });
    const up = (await raw('PUT', `/api/rooms/${rid}/attachments/upload?batch=new&path=${encodeURIComponent('notes/todo.txt')}`, '买牛奶')).json();
    assert.match(up.base, /^\.agentchat\/attachments\/\d{8}-\d{6}/);
    assert.deepStrictEqual([up.path, up.size], [`${up.base}/notes/todo.txt`, Buffer.byteLength('买牛奶')]);
    assert.strictEqual(fs.readFileSync(path.join(wsNow, up.path), 'utf8'), '买牛奶');
    assert.strictEqual((await raw('PUT', `/api/rooms/${rid}/attachments/upload?batch=${up.batch}&path=${encodeURIComponent('../../x.txt')}`, 'x')).status, 400);
    assert.strictEqual((await call('DELETE', `/api/rooms/${rid}/attachments?path=${encodeURIComponent(added[1].path)}`)).json().removed, true);
    assert.ok(!fs.existsSync(path.join(wsNow, added[1].path)));
    assert.strictEqual((await call('DELETE', `/api/rooms/${rid}/attachments?path=spec.md`)).json().removed, false);
    assert.strictEqual((await call('POST', `/api/rooms/${rid}/messages`, { text: '', attachments: [added[1]] })).status, 400, '去掉了的附件不能再发');
    const withAtt = (await call('POST', `/api/rooms/${rid}/messages`, { text: '', attachments: [added[0], { path: `${up.base}/notes`, name: 'notes', count: 1 }] })).json();
    assert.deepStrictEqual(withAtt.attachments.map((a) => [a.path, a.kind]), [['spec.md', 'file'], [`${up.base}/notes`, 'dir']]);
    assert.strictEqual((await call('GET', `/api/rooms/${rid}`)).json().room.name, 'spec.md notes');
    assert.strictEqual((await call('POST', `/api/rooms/${rid}/messages`, { text: '  ' })).status, 400, '没字也没附件不能发');
    // 当审查模型的成员删掉了，就不再选它；专门的审查模型删掉了也一样
    await call('PATCH', `/api/rooms/${rid}`, { settings: { reviewer: ag.id } });
    await call('DELETE', `/api/rooms/${rid}/agents/${ag.id}`);
    assert.strictEqual((await call('GET', `/api/rooms/${rid}`)).json().room.settings.reviewer, '');
    const noRv = (await call('DELETE', `/api/rooms/${second.id}/reviewer`)).json();
    assert.deepStrictEqual([noRv.reviewer, noRv.settings.reviewer], [null, '']);
    // 删会话、删项目
    await call('DELETE', `/api/rooms/${second.id}`);
    assert.strictEqual((await call('GET', `/api/rooms/${second.id}`)).status, 404);
    await call('DELETE', `/api/projects/${made.project.id}`);
    assert.strictEqual((await call('GET', `/api/rooms/${rid}`)).status, 404);
    assert.ok(!(await call('GET', '/api/projects')).json().some((p) => p.id === made.project.id));
    // 不是本机页面发来的修改请求要拒绝
    assert.strictEqual((await new Promise((resolve) => http.request(srv.url + '/api/settings', { method: 'PATCH' }, (r) => resolve(r.statusCode)).end('{}'))), 403);
  } finally {
    await call('PATCH', '/api/settings', { language: 'zh-Hans' }).catch(() => {});
    await srv.close();
  }
});

// ---------- 新接入的命令行工具：用假的程序按各家的 JSON 格式吐事件，检查参数、文字、工具、会话和用量 ----------
// 假程序收到 --help 就打印 FAKE_HELP；正常运行时把参数和 stdin（或 --prompt-file 的内容）记到 FAKE_LOG，
// 再一行行输出 FAKE_SCRIPT 里的 lines（$SID 换成 -s 传进来的会话 id）
function fakeCli(name) {
  const dir = tmp();
  const js = path.join(dir, `fake-${name}.js`);
  fs.writeFileSync(
    js,
    `const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('${name} 9.9.9'); process.exit(0); }
if (args.includes('--help')) { console.log(process.env.FAKE_HELP || ''); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const pf = args.indexOf('--prompt-file');
  const prompt = pf >= 0 ? fs.readFileSync(args[pf + 1], 'utf8') : null;
  // DeepSeek Harness：记下这次运行的权限变量和 --patch 文件；Key 只记测试用的（不把真的 Key 写进日志）
  const pt = args.indexOf('--patch');
  const k = process.env.DEEPSEEK_API_KEY || '';
  const env = { DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || '', DEEPSEEK_API_KEY: k.startsWith('sk-test') ? k : k ? '(other)' : '' };
  const patch = pt >= 0 ? fs.readFileSync(args[pt + 1], 'utf8') : null;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, prompt, promptFile: pf >= 0 ? args[pf + 1] : null, env, patch }) + '\\n');
  const sc = JSON.parse(process.env.FAKE_SCRIPT || '{}');
  if (sc.failIf && args.includes(sc.failIf)) { process.stderr.write(sc.failText || 'error'); process.exit(2); }
  const s = args.indexOf('-s');
  for (const l of sc.lines || []) process.stdout.write(l.split('$SID').join(s >= 0 ? args[s + 1] : '') + '\\n');
  if (sc.stderr) process.stderr.write(sc.stderr);
  process.exit(sc.exit || 0);
});
`
  );
  fs.writeFileSync(path.join(dir, `${name}.cmd`), `@node "%~dp0\\fake-${name}.js" %*\r\n`);
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/usr/bin/env node\nrequire(${JSON.stringify(js)});\n`);
  try {
    fs.chmodSync(sh, 0o755);
  } catch {}
  return dir;
}

async function runFake(adapterId, { help, lines = [], exit = 0, stderr = '', failIf, failText, agent = {}, sessionId = null, prompt = '你好' }) {
  const proc = require('../server/proc');
  const dir = fakeCli(adapterId);
  const log = path.join(tmp(), 'calls.jsonl');
  const env = { PATH: process.env.PATH, FAKE_LOG: process.env.FAKE_LOG, FAKE_SCRIPT: process.env.FAKE_SCRIPT, FAKE_HELP: process.env.FAKE_HELP };
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  process.env.FAKE_LOG = log;
  process.env.FAKE_SCRIPT = JSON.stringify({ lines: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))), exit, stderr, failIf, failText });
  if (help !== undefined) process.env.FAKE_HELP = help;
  proc.clearCache();
  const adapter = require('../server/adapters').get(adapterId);
  const events = [];
  const cwd = tmp();
  try {
    const h = adapter.run({
      agent: { id: 'x', name: 'X', adapter: adapterId, model: '', effort: '', permission: 'edit', extraArgs: '', ...agent },
      cwd,
      prompt,
      sessionId,
      emit: (e) => events.push(e),
    });
    const res = await h.done;
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { res, events, calls, cwd };
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    proc.clearCache();
  }
}

const notes = (events) => events.filter((e) => e.type === 'text').map((e) => e.text);
const tools = (events) => events.filter((e) => e.type === 'tool').map((e) => e.item);

test('Gemini CLI：stream-json 的文字、工具、会话和用量；接口出错时进程照样退出 0', async () => {
  const help = '  -o, --output-format  [choices: "text", "json", "stream-json"]\n      --approval-mode  default, auto_edit, yolo, plan\n      --skip-trust  Trust the current workspace';
  const ok = await runFake('gemini', {
    help,
    agent: { model: 'flash', permission: 'edit' },
    lines: [
      { type: 'init', session_id: 'g-1', model: 'auto' },
      { type: 'message', role: 'user', content: '你好' },
      { type: 'message', role: 'assistant', content: '我先看看', delta: true },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: 'a.txt' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: '...' },
      { type: 'message', role: 'assistant', content: '看完了，', delta: true },
      { type: 'message', role: 'assistant', content: '没问题。', delta: true },
      { type: 'result', status: 'success', stats: { models: { 'gemini-3-flash': { input_tokens: 1200, cached: 200, input: 1000, output_tokens: 50 } } } },
    ],
  });
  assert.strictEqual(ok.res.error, null);
  assert.strictEqual(ok.res.text, '看完了，没问题。');
  assert.strictEqual(ok.res.sessionId, 'g-1');
  assert.strictEqual(ok.res.model, 'gemini-3-flash');
  assert.deepStrictEqual(ok.res.usage, [{ model: 'gemini-3-flash', input: 1000, output: 50, cacheRead: 200, cacheWrite: 0 }]);
  assert.deepStrictEqual(notes(ok.events), ['我先看看', '看完了，没问题。']);
  assert.deepStrictEqual(tools(ok.events).map((t) => [t.id, t.k, t.d, t.s]), [['t1', 'read', 'a.txt', 'running'], ['t1', undefined, undefined, 'ok']]);
  const call = ok.calls[0];
  assert.strictEqual(call.input, '你好'); // prompt 走 stdin
  assert.deepStrictEqual(call.args, ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust', '-m', 'flash']);
  // 续上会话、只读权限
  const again = await runFake('gemini', { agent: { permission: 'readonly' }, sessionId: 'g-1', lines: [{ type: 'result', status: 'success' }] });
  assert.deepStrictEqual(again.calls[0].args.slice(0, 4), ['--output-format', 'stream-json', '--approval-mode', 'default']);
  assert.ok(again.calls[0].args.join(' ').includes('--resume g-1'));
  const bad = await runFake('gemini', {
    lines: [{ type: 'init', session_id: 'g-2', model: 'auto' }, { type: 'result', status: 'error', error: { message: '[API Error: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"message\\": \\"API key not valid.\\"}}"}}]' } }],
  });
  assert.strictEqual(bad.res.error, 'API key not valid.');
  const noAuth = await runFake('gemini', { exit: 41, stderr: 'Please set an Auth method' });
  assert.match(noAuth.res.error, /Please set an Auth method/);
});

test('pi：--mode json 的会话头、回复、工具和每条回复的用量；权限靠 --tools', async () => {
  const help = '  --mode <mode>  text | json | rpc\n  --thinking <level>\n  --tools <list>';
  const r = await runFake('pi', {
    help,
    agent: { permission: 'readonly', effort: 'none', model: 'anthropic/claude-x' },
    lines: [
      { type: 'session', version: 3, id: 'p-1', cwd: '.' },
      { type: 'agent_start' },
      { type: 'message_end', message: { role: 'system', content: '' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好的，' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', id: 'c1', toolName: 'ls' } },
      { type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'claude-x', content: [{ type: 'text', text: '好的，' }], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, stopReason: 'toolUse' } },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'ls', args: { path: '.' } },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'ls', isError: false },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '看完了' } },
      { type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'claude-x', content: [{ type: 'text', text: '看完了' }], usage: { input: 20, output: 7, cacheRead: 3, cacheWrite: 0 }, stopReason: 'stop' } },
      { type: 'agent_end', messages: [] },
    ],
  });
  assert.strictEqual(r.res.error, null);
  assert.strictEqual(r.res.text, '看完了');
  assert.strictEqual(r.res.sessionId, 'p-1');
  assert.deepStrictEqual(r.res.usage, [{ model: 'anthropic/claude-x', input: 30, output: 12, cacheRead: 5, cacheWrite: 1 }]);
  assert.deepStrictEqual(notes(r.events), ['好的，', '看完了']);
  assert.deepStrictEqual(tools(r.events)[0], { id: 'c1', k: 'search', n: 'ls', d: '.', s: 'running' });
  assert.strictEqual(r.calls[0].input, '你好');
  assert.deepStrictEqual(r.calls[0].args, ['--mode', 'json', '--tools', 'read,grep,find,ls', '--model', 'anthropic/claude-x', '--thinking', 'off']);
  const full = await runFake('pi', { agent: { permission: 'full' }, sessionId: 'p-1', lines: [] });
  assert.deepStrictEqual(full.calls[0].args, ['--mode', 'json', '--session', 'p-1']);
  // 接口报错：进程以 0 退出，错误在回复里；之后自动重试成功就不算错
  const err = await runFake('pi', {
    lines: [{ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 {"type":"error","error":{"message":"invalid x-api-key"}}' } }],
  });
  assert.strictEqual(err.res.error, '401 invalid x-api-key');
  const retried = await runFake('pi', {
    lines: [
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' } },
      { type: 'auto_retry_start', attempt: 1 },
      { type: 'auto_retry_end', success: true, attempt: 1 },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '好了' }], stopReason: 'stop' } },
    ],
  });
  assert.strictEqual(retried.res.error, null);
  assert.strictEqual(retried.res.text, '好了');
  const noKey = await runFake('pi', { exit: 1, stderr: 'No API key found for the selected model.' });
  assert.match(noKey.res.error, /No API key found/);
});

test('Grok Build：prompt 走临时文件，新会话自己定好 id，streaming-json 的工具和用量；旧版不认 --trust 时去掉重来', async () => {
  const help = '  -p, --single <PROMPT>\n      --prompt-file <PATH>\n      --verbatim\n      --output-format <FMT>  plain, json, streaming-json\n      --permission-mode <MODE>';
  const r = await runFake('grok', {
    help,
    prompt: '请跑一下测试 @Claude /review',
    agent: { model: 'grok-4.6', effort: 'high' },
    lines: [
      { type: 'thought', data: '想一想' },
      { type: 'text', data: '先跑测试' },
      { type: 'tool_call', toolCallId: 'k1', title: 'Run', kind: 'execute', status: 'in_progress', toolName: 'run_terminal_cmd', rawInput: { command: 'npm test' }, content: [], locations: [] },
      { type: 'tool_call_update', toolCallId: 'k1', status: 'completed', rawOutput: {} },
      { type: 'text', data: '全部' },
      { type: 'text', data: '通过' },
      { type: 'usage', messageId: 'm1', stopReason: 'end_turn', usage: { input_tokens: 1 } },
      { type: 'end', stopReason: 'end_turn', sessionId: '$SID', usage: { cache_creation_input_tokens: 5 }, modelUsage: { 'grok-4.6': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50 } } },
    ],
  });
  assert.strictEqual(r.res.error, null);
  assert.strictEqual(r.res.text, '全部通过');
  const call = r.calls[0];
  assert.strictEqual(call.prompt, '请跑一下测试 @Claude /review');
  assert.strictEqual(call.input, ''); // 不走 stdin
  const sid = call.args[call.args.indexOf('-s') + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.strictEqual(r.res.sessionId, sid);
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'session').map((e) => e.id), [sid]);
  for (const a of ['--verbatim', '--trust']) assert.ok(call.args.includes(a), a);
  assert.ok(call.args.join(' ').includes('--output-format streaming-json'));
  assert.ok(call.args.join(' ').includes('--permission-mode acceptEdits'));
  assert.ok(call.args.join(' ').includes('-m grok-4.6 --effort high'));
  assert.deepStrictEqual(tools(r.events).map((t) => [t.k, t.d, t.s]), [['cmd', 'npm test', 'running'], [undefined, undefined, 'ok']]);
  assert.deepStrictEqual(r.res.usage, [{ model: 'grok-4.6', input: 100, output: 20, cacheRead: 50, cacheWrite: 5 }]);
  await new Promise((ok) => setTimeout(ok, 100));
  assert.strictEqual(fs.existsSync(call.promptFile), false); // 临时文件用完就删
  // 续上会话、完全权限；旧版不认识 --trust 时去掉再跑一次
  const old = await runFake('grok', {
    agent: { permission: 'full' },
    sessionId: 'old-sid',
    failIf: '--trust',
    failText: "error: unexpected argument '--trust' found",
    lines: [{ type: 'text', data: '好' }, { type: 'end', stopReason: 'end_turn', sessionId: 'old-sid' }],
  });
  assert.strictEqual(old.calls.length, 2);
  assert.ok(old.calls[0].args.includes('--trust'));
  assert.ok(!old.calls[1].args.includes('--trust'));
  assert.ok(old.calls[1].args.join(' ').includes('--always-approve'));
  assert.ok(old.calls[1].args.join(' ').includes('--resume old-sid'));
  assert.strictEqual(old.res.error, null);
  assert.strictEqual(old.res.text, '好');
  const failed = await runFake('grok', { lines: [{ type: 'error', message: 'Not logged in' }], exit: 1 });
  assert.strictEqual(failed.res.error, 'Not logged in');
  assert.strictEqual(failed.events.some((e) => e.type === 'session'), false); // 没建成的会话不记下来
});

test('Hermes：prompt 从 stdin 读，stream-json 的工具（旧版没有调用 id）、会话和用量；只读时在提示开头加上要求', async () => {
  const help = '  --query-file PATH\n  --format {text,stream-json}\n  --reasoning LEVEL';
  const r = await runFake('hermes', {
    help,
    agent: { permission: 'readonly', model: 'nous/hermes-4', effort: 'high' },
    lines: [
      { type: 'system', subtype: 'init', model: 'nous/hermes-4', session_id: 'h-1' },
      { type: 'text', text: '我来看看' },
      { type: 'tool_use', name: 'search_files', input: { pattern: 'TODO' } },
      { type: 'tool_result', name: 'search_files', output: '3 matches', duration_ms: 12, is_error: false },
      { type: 'text', text: '找到 3 处' },
      { type: 'result', session_id: 'h-1', exit_code: 0, text: '找到 3 处 TODO', tokens: { input: 120, output: 30, total: 150, cache_read: 20, cache_write: 0 }, duration_ms: 900 },
    ],
  });
  assert.strictEqual(r.res.error, null);
  assert.strictEqual(r.res.text, '找到 3 处 TODO'); // 以 result 里的最终回复为准
  assert.strictEqual(r.res.sessionId, 'h-1');
  assert.deepStrictEqual(r.res.usage, [{ model: 'nous/hermes-4', input: 100, output: 30, cacheRead: 20, cacheWrite: 0 }]);
  const [use, done] = tools(r.events);
  assert.deepStrictEqual([use.k, use.d, use.s], ['search', 'TODO', 'running']);
  assert.deepStrictEqual([done.id, done.s], [use.id, 'ok']);
  const call = r.calls[0];
  assert.match(call.input, /^（你现在是只读权限/);
  assert.ok(call.input.endsWith('你好'));
  assert.deepStrictEqual(call.args, ['chat', '--query-file', '-', '--format', 'stream-json', '-t', 'file,web,todo,skills', '-m', 'nous/hermes-4', '--reasoning', 'high']);
  const full = await runFake('hermes', { agent: { permission: 'full' }, sessionId: 'h-1', lines: [{ type: 'result', session_id: 'h-1', exit_code: 0, text: 'ok', tokens: {} }] });
  assert.deepStrictEqual(full.calls[0].args, ['chat', '--query-file', '-', '--format', 'stream-json', '--yolo', '--resume', 'h-1']);
  assert.strictEqual(full.calls[0].input, '你好');
  const bad = await runFake('hermes', { lines: [{ type: 'result', session_id: 'h-2', exit_code: 1, text: '', error: 'No provider configured' }], exit: 1 });
  assert.strictEqual(bad.res.error, 'No provider configured');
});

test('DeepSeek Harness：dsh headless --json，任务走 stdin；模型和思考强度写进 --patch，权限和 Key 走环境变量；续会话、缺 Key、会话不存在', async () => {
  const help = '  --json             write newline-delimited run events\n  --session-id <id>  adopt the persisted Session';
  const r = await runFake('dsh', {
    help,
    agent: { permission: 'readonly', model: 'deepseek-v4-pro', effort: 'none', api: { apiKey: 'sk-test-dsh' } },
    lines: [
      { type: 'session', sessionId: 'session-1', cwd: 'x' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'thinking', text: '想一下' },
      { type: 'text', text: '我先看看' },
      { type: 'tool_call', callId: 'c1', tool: 'read', input: { file_path: 'src/a.js' } },
      { type: 'tool_result', callId: 'c1', status: 'completed', result: '...' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } },
      { type: 'status', phase: 'step_start', turn: 1, step: 2 },
      { type: 'text', text: '看完了，没问题。' },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 10 } },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: '看完了，没问题。' },
    ],
  });
  assert.strictEqual(r.res.error, null);
  assert.strictEqual(r.res.text, '看完了，没问题。');
  assert.strictEqual(r.res.sessionId, 'session-1');
  assert.deepStrictEqual(r.res.usage, [{ model: 'deepseek-v4-pro', input: 150, output: 30, cacheRead: 30, cacheWrite: 0 }]);
  assert.deepStrictEqual(notes(r.events), ['我先看看', '看完了，没问题。']); // 工具调用前一段、最后一段（最后一段和最终回复一样，接力那边会去掉）
  const [use, done] = tools(r.events);
  assert.deepStrictEqual([use.k, use.d, use.s, done.id, done.s], ['read', 'src/a.js', 'running', 'c1', 'ok']);
  const call = r.calls[0];
  assert.strictEqual(call.input, '你好');
  assert.deepStrictEqual([call.args[0], call.args[1], ...call.args.slice(3)], ['headless', '--patch', '--json', '-']);
  assert.strictEqual(call.patch, '- id: agent-default-model\n  config:\n    provider: "deepseek-official"\n    model: "deepseek-v4-pro"\n    reasoningEffort: "off"\n');
  // patch 会整个替换这一项的配置，所以只选了思考强度时也要写上默认的提供商和模型
  assert.strictEqual(
    require('../server/adapters/dsh').patchText({ effort: 'max' }),
    '- id: agent-default-model\n  config:\n    provider: "deepseek-official"\n    model: "deepseek-flash"\n    reasoningEffort: "max"\n'
  );
  assert.deepStrictEqual(call.env, { DSH_PERMISSION_MODE: 'read-only', DEEPSEEK_API_KEY: 'sk-test-dsh' });
  // 续会话：没选模型和强度就不写 patch；完全权限
  const again = await runFake('dsh', { help, agent: { permission: 'full' }, sessionId: 'session-1', lines: [{ type: 'final', text: 'ok' }] });
  assert.deepStrictEqual(again.calls[0].args, ['headless', '--json', '--session-id', 'session-1', '-']);
  assert.strictEqual(again.calls[0].patch, null);
  assert.strictEqual(again.calls[0].env.DSH_PERMISSION_MODE, 'danger-full-access');
  // 「提供商/模型」拆成 provider 和 model
  const { patchText } = require('../server/adapters/dsh');
  assert.strictEqual(patchText({ model: 'my-proxy/qwen3-coder', effort: 'high' }), '- id: agent-default-model\n  config:\n    provider: "my-proxy"\n    model: "qwen3-coder"\n    reasoningEffort: "high"\n');
  // 缺 Key：给出怎么填的提示
  const noKey = await runFake('dsh', {
    help,
    exit: 1,
    stderr: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key',
    lines: [
      { type: 'session', sessionId: 'session-2', cwd: 'x' },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: 'llm-deepseek: no API key for provider route "deepseek-official"', code: 'MISSING_CREDENTIAL' } } },
      { type: 'final', text: '' },
    ],
  });
  assert.match(noKey.res.error, /DEEPSEEK_API_KEY/);
  // 会话不存在（数据被删了）：报错能被认出来，接力会换一个新会话重来
  const gone = await runFake('dsh', { help, exit: 1, sessionId: 'session-x', lines: [{ type: 'error', message: 'session "session-x" does not exist; omit --session-id to start a new Session' }] });
  assert.match(gone.res.error, require('../server/adapters/common').RESUME_FAIL);
  // 改了模型 / 思考强度 / 权限：DeepSeek Harness 要换新会话，别的工具不用
  const { sessionOutdated } = require('../server/adapters');
  assert.strictEqual(sessionOutdated({ adapter: 'dsh', model: '' }, { adapter: 'dsh', model: 'deepseek-v4-pro' }), true);
  assert.strictEqual(sessionOutdated({ adapter: 'dsh', permission: 'edit' }, { adapter: 'dsh', permission: 'full' }), true);
  assert.strictEqual(sessionOutdated({ adapter: 'dsh', name: 'A' }, { adapter: 'dsh', name: 'B' }), false);
  assert.strictEqual(sessionOutdated({ adapter: 'codex', model: 'a' }, { adapter: 'codex', model: 'b' }), false);
  assert.strictEqual(sessionOutdated({ adapter: 'codex' }, { adapter: 'dsh' }), true);
});

test('Codex：补丁写到项目文件夹以外时，工具记录里标出这些路径；删掉的不算', async () => {
  const far = path.join(os.tmpdir(), 'agentchat-elsewhere', 'ai_team_test', 'calculator.py');
  const gone = path.join(os.tmpdir(), 'agentchat-elsewhere', 'old.py');
  const r = await runFake('codex', {
    help: '  --json  Print events to stdout as JSONL',
    lines: [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'item.completed', item: { id: 'p1', type: 'file_change', status: 'completed', changes: [{ path: 'inside.py', kind: 'add' }, { path: far, kind: 'add' }] } },
      { type: 'item.completed', item: { id: 'p2', type: 'file_change', status: 'completed', changes: [{ path: 'docs/a.md', kind: 'update' }, { path: gone, kind: 'delete' }] } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '写好了' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  });
  assert.strictEqual(r.res.error, null);
  const [p1, p2] = tools(r.events);
  assert.deepStrictEqual([p1.k, p1.out], ['write', [far.replace(/\\/g, '/')]]);
  assert.deepStrictEqual([p2.k, p2.out], ['edit', undefined]);
  assert.ok(r.calls[0].args.includes('-C') && r.calls[0].args[r.calls[0].args.indexOf('-C') + 1] === r.cwd, 'cwd 用 -C 传给 Codex');
});

test('交付核对（假的 codex 程序跑一整轮接力）：写到项目外、只说没做，消息上记下来，下一位成员也看得到', async () => {
  const proc = require('../server/proc');
  const dir = fakeCli('codex');
  const keep = { PATH: process.env.PATH, FAKE_LOG: process.env.FAKE_LOG, FAKE_SCRIPT: process.env.FAKE_SCRIPT, FAKE_HELP: process.env.FAKE_HELP };
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  process.env.FAKE_LOG = path.join(tmp(), 'calls.jsonl');
  process.env.FAKE_HELP = '  --json  Print events to stdout as JSONL';
  proc.clearCache();
  const script = (...lines) => (process.env.FAKE_SCRIPT = JSON.stringify({ lines: lines.map((l) => JSON.stringify(l)) }));
  const far = path.join(tmp(), 'home', 'ai_team_test', 'calculator.py'); // 相当于 C:\Users\wangr\ai_team_test
  const start = { type: 'thread.started', thread_id: 't-1' };
  const claim = { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '已创建 ai_team_test/calculator.py，22 个测试全部通过' } };
  const end = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
  try {
    const ws = tmp();
    const store = new Store(path.join(tmp(), 'data'));
    const orch = new Orchestrator(store, { send() {} });
    const room = store.createRoom({ name: 't', workspace: ws, agents: [{ id: 'g', name: 'GPT', adapter: 'codex', permission: 'edit', enabled: true }] });
    // 第一轮：补丁写到了项目外
    script(start, { type: 'item.completed', item: { id: 'p1', type: 'file_change', status: 'completed', changes: [{ path: far, kind: 'add' }] } }, claim, end);
    orch.postUser(room.id, '@GPT 在 ai_team_test 里写计算器和测试');
    await idle(orch, room.id);
    // 第二轮：只说没做
    script(start, claim, end);
    orch.postUser(room.id, '@GPT 项目里没有这些文件，再写一次');
    await idle(orch, room.id);
    const [out, talk] = store.messages(room.id).filter((m) => m.kind === 'agent');
    const farFwd = far.replace(/\\/g, '/');
    assert.deepStrictEqual([out.status, out.outside, out.unchanged, out.files], ['done', [farFwd], true, []]);
    assert.deepStrictEqual(out.items.map((it) => [it.k, it.out]), [['write', [farFwd]]]);
    assert.deepStrictEqual([talk.status, talk.outside, talk.unchanged, talk.files, talk.items], ['done', undefined, true, [], []]);
    // 下一位成员（第一次发言，拿到完整记录）看到的
    const rev = { id: 'rev', name: 'Rev', adapter: 'codex', enabled: true };
    const p = buildCliPrompt({ room: { ...room, agents: [...room.agents, rev] }, agent: rev, messages: store.messages(room.id), fresh: true });
    const part = (seq) => p.slice(p.indexOf(`[#${seq}] `)).split('\n\n')[0];
    assert.ok(part(out.seq).includes(`（这一轮有文件写到了项目文件夹以外：${farFwd}）`), part(out.seq));
    assert.match(part(talk.seq), /22 个测试全部通过\n（这一轮没有改动项目文件夹里的文件）$/);
    // 两轮都在项目文件夹里启动（-C 和 cwd 都是它），第二轮续上第一轮的会话
    const calls = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(calls.map((c) => c.args[c.args.indexOf('-C') + 1]), [ws, ws]);
    assert.deepStrictEqual(calls[1].args.slice(-3), ['resume', 't-1', '-']);
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    proc.clearCache();
  }
});

test('模型目录：pi 的模型表、grok models 的输出、Hermes 和 Grok 设置里的默认模型、Gemini 的别名', () => {
  const m = require('../server/models');
  const pi = m.parsePiModels('provider   model             context  max-out  thinking  images\nanthropic  claude-opus-5-5   1M       128K     yes       yes\nopenai     gpt-4o-mini       128K     16K      no        yes\n');
  assert.deepStrictEqual(pi.map((x) => [x.id, x.note, x.efforts.length > 0]), [
    ['anthropic/claude-opus-5-5', 'anthropic', true],
    ['openai/gpt-4o-mini', 'openai', false],
  ]);
  assert.deepStrictEqual(m.parsePiModels('No models available. Use /login'), []);
  const g = m.parseGrokModels('Available models:\n  * grok-4.5 (default)\n    grok-4.6\n    grok-code-fast-1\n');
  assert.deepStrictEqual(g.models.map((x) => x.id), ['grok-4.5', 'grok-4.6', 'grok-code-fast-1']);
  assert.strictEqual(g.defaultModel, 'grok-4.5');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'agent:\n  max_turns: 90\nmodel:\n  default: "anthropic/claude-sonnet-4.6"  # 默认\n  provider: openrouter\n');
  assert.strictEqual(m.hermesDefaultModel(dir), 'anthropic/claude-sonnet-4.6');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: nous/hermes-4\n');
  assert.strictEqual(m.hermesDefaultModel(dir), 'nous/hermes-4');
  fs.writeFileSync(path.join(dir, 'config.toml'), 'theme = "dark"\n[models]\ndefault = "grok-4.6"\n[cli]\nauto_update = false\n');
  assert.strictEqual(m.tomlSectionKey(path.join(dir, 'config.toml'), 'models', 'default'), 'grok-4.6');
  fs.mkdirSync(path.join(dir, '.gemini'));
  fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify({ model: { name: 'gemini-3-pro-preview' } }));
  const gem = m.geminiCatalog(dir);
  assert.strictEqual(gem.defaultModel, 'gemini-3-pro-preview');
  assert.deepStrictEqual(gem.models.map((x) => x.id), ['auto', 'pro', 'flash', 'flash-lite', 'gemini-3-pro-preview']);
});

test('Markdown 表格：单元格里写成 \\| 的竖线不算分隔（比如代码里的管道符）', () => {
  const vm = require('vm');
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'markdown.js'), 'utf8'), ctx);
  const html = ctx.window.Markdown.render('| A | B |\n| --- | --- |\n| x | `irm a \\| iex` |\n| y | z |\n');
  assert.match(html, /<td><code>irm a \| iex<\/code><\/td>/);
  assert.strictEqual((html.match(/<td>/g) || []).length, 4);
});

// ---------- 自动更新（electron/updater.js）：不用 Electron，换成假的 autoUpdater ----------
test('自动更新：只有 NSIS 安装版检查；开发模式、免安装版、直接运行 win-unpacked 都跳过', () => {
  const { skipReason } = require('../electron/updater');
  const dir = 'C:\\Users\\me\\AppData\\Local\\Programs\\Nightshift';
  const has = (...files) => (p) => files.includes(p);
  const installed = { isPackaged: true, platform: 'win32', env: {}, execPath: dir + '\\Nightshift.exe', exists: has(dir + '\\Uninstall Nightshift.exe') };
  assert.strictEqual(skipReason(installed), '');
  // npm start：没打包
  assert.strictEqual(skipReason({ ...installed, isPackaged: false, execPath: 'E:\\Agent Chat\\node_modules\\electron\\dist\\electron.exe' }), 'dev');
  assert.strictEqual(skipReason({ ...installed, platform: 'darwin' }), 'platform');
  // 免安装版：exe 解压到临时文件夹里运行，PORTABLE_EXECUTABLE_DIR 是原来那个 exe 所在的文件夹
  const portable = { ...installed, env: { PORTABLE_EXECUTABLE_DIR: 'D:\\U盘' }, execPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\2abcXyz\\Nightshift.exe', exists: () => true };
  assert.strictEqual(skipReason(portable), 'portable');
  // 直接运行 dist/win-unpacked 里的 exe：旁边没有卸载程序
  assert.strictEqual(skipReason({ ...installed, execPath: 'E:\\Agent Chat\\dist\\win-unpacked\\Nightshift.exe' }), 'unpacked');
  // 卸载程序按 exe 的名字找，大小写不同也认
  assert.strictEqual(skipReason({ ...installed, execPath: 'D:\\Apps\\NS\\NIGHTSHIFT.EXE', exists: has('D:\\Apps\\NS\\Uninstall NIGHTSHIFT.exe') }), '');
  if (process.platform === 'win32') {
    // 真的文件夹：放上卸载程序以后才算安装版
    const d = tmp();
    const exe = path.join(d, 'Nightshift.exe');
    assert.strictEqual(skipReason({ isPackaged: true, platform: 'win32', env: {}, execPath: exe }), 'unpacked');
    fs.writeFileSync(path.join(d, 'Uninstall Nightshift.exe'), '');
    assert.strictEqual(skipReason({ isPackaged: true, platform: 'win32', env: {}, execPath: exe }), '');
  }
});

test('自动更新：出错的原因（没网、限流、没传 latest.yml、校验和签名不对），不被调用栈里的行号误判', () => {
  const { errorKind } = require('../electron/updater');
  const err = (message, extra) => Object.assign(new Error(message), extra);
  assert.strictEqual(errorKind(err('net::ERR_INTERNET_DISCONNECTED')), 'network');
  assert.strictEqual(errorKind(err('getaddrinfo ENOTFOUND github.com', { code: 'ENOTFOUND' })), 'network');
  assert.strictEqual(errorKind(err('429 Too Many Requests\nHeaders: {}', { statusCode: 429, code: 'HTTP_ERROR_429' })), 'limited');
  // electron-updater 包了一层：里面的错误在 message 里
  const wrapped = 'Unable to find latest version on GitHub (https://github.com/Lauk1z/nightshift/releases/latest), please ensure a production release exists: ';
  assert.strictEqual(errorKind(err(wrapped + 'HttpError: 403 Forbidden\n    at x.js:12:3', { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })), 'limited');
  assert.strictEqual(errorKind(err(wrapped + 'Error: net::ERR_NAME_NOT_RESOLVED', { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })), 'network');
  assert.strictEqual(errorKind(err(wrapped + 'HttpError: 404 Not Found', { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })), 'missing');
  assert.strictEqual(errorKind(err('Cannot find latest.yml in the latest release artifacts', { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })), 'missing');
  assert.strictEqual(errorKind(err('sha512 checksum mismatch, expected abc, got def', { code: 'ERR_CHECKSUM_MISMATCH' })), 'checksum');
  assert.strictEqual(errorKind(err('New version 0.13.0 is not signed by the application owner: x', { code: 'ERR_UPDATER_INVALID_SIGNATURE' })), 'signature');
  const disk = err('ENOSPC: no space left on device');
  disk.stack = 'Error: ENOSPC\n    at AppUpdater.js:429:15\n    at NsisUpdater.js:403:7';
  assert.strictEqual(errorKind(disk), 'other');
  assert.strictEqual(errorKind('奇怪的东西'), 'other');
});

test('自动更新：检查 → 下载 → 等用户点「重启以完成更新」；出错只改状态不抛出，已经下载好的不受影响', async () => {
  const { Updates } = require('../electron/updater');
  const { EventEmitter } = require('events');
  const fake = new EventEmitter();
  let plan = 'offline';
  let checks = 0;
  // 和 electron-updater 一样：检查出错时先发 error 事件再 reject；有新版本时 downloadPromise 是正在进行的下载
  fake.checkForUpdates = async () => {
    checks++;
    fake.emit('checking-for-update');
    if (plan === 'offline') {
      const e = new Error('net::ERR_INTERNET_DISCONNECTED');
      fake.emit('error', e);
      throw e;
    }
    if (plan === 'latest') {
      fake.emit('update-not-available', { version: '0.12.0' });
      return { isUpdateAvailable: false };
    }
    fake.emit('update-available', { version: '0.13.0' });
    const downloadPromise = (async () => {
      await null;
      fake.emit('download-progress', { percent: 42.7 });
      await null;
      if (plan === 'corrupt') {
        const e = Object.assign(new Error('sha512 checksum mismatch, expected a, got b'), { code: 'ERR_CHECKSUM_MISMATCH' });
        fake.emit('error', e);
        throw e;
      }
      fake.emit('update-downloaded', { version: '0.13.0' });
    })();
    return { isUpdateAvailable: true, downloadPromise };
  };
  const installs = [];
  fake.quitAndInstall = (...args) => installs.push(args);
  const u = new Updates({ updater: fake, version: '0.12.0', logFile: 'C:\\logs\\updater.log' });
  const seen = [];
  u.onChange((s) => seen.push(s.status === 'downloading' ? `downloading ${s.percent}` : s.status));
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.deepStrictEqual(u.state(), { status: 'idle', reason: '', version: '0.12.0', next: '', percent: 0, error: '', log: 'C:\\logs\\updater.log' });
    assert.strictEqual(await u.install(), false); // 还没下载好，不能装
    // 没网：状态变成 error，不抛出
    assert.strictEqual(u.check(true).status, 'checking');
    await settle();
    assert.deepStrictEqual([u.state().status, u.state().error], ['error', 'network']);
    // 已是最新
    plan = 'latest';
    u.check();
    await settle();
    assert.strictEqual(u.state().status, 'latest');
    // 下载到一半校验不对
    plan = 'corrupt';
    u.check();
    await settle();
    assert.deepStrictEqual([u.state().status, u.state().error], ['error', 'checksum']);
    // 有新版本：后台下载，下载好了等用户点
    plan = 'new';
    seen.length = 0;
    u.check();
    assert.strictEqual(u.check().status, 'checking'); // 正在查的时候再点一次不会重复查
    await settle();
    assert.deepStrictEqual(seen, ['checking', 'checking', 'downloading 0', 'downloading 42', 'ready']);
    assert.deepStrictEqual([u.state().status, u.state().next, u.state().percent], ['ready', '0.13.0', 100]);
    assert.deepStrictEqual(installs, []); // 没点就不装
    // 下载好了以后不再检查；之后再来的错误（比如没网）也不影响
    const before = checks;
    u.check(true);
    await settle();
    assert.strictEqual(checks, before);
    fake.emit('error', new Error('net::ERR_NETWORK_CHANGED'));
    assert.strictEqual(u.state().status, 'ready');
    // 点了「重启以完成更新」：先停好服务，再静默安装、装完打开（--updated /S --force-run）
    const order = [];
    fake.quitAndInstall = (...args) => {
      order.push('install');
      installs.push(args);
    };
    assert.strictEqual(await u.install(async () => order.push('stop server')), true);
    assert.deepStrictEqual(order, ['stop server', 'install']);
    assert.deepStrictEqual(installs, [[true, true]]);
    assert.strictEqual(u.state().status, 'installing');
    assert.strictEqual(await u.install(), false); // 不会装两次
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  // 安装包不见了之类的错误：electron-updater 当场发 error 事件，状态回到 ready，main.js 会重新打开程序
  const fake2 = new EventEmitter();
  fake2.quitAndInstall = () => fake2.emit('error', new Error("No update filepath provided, can't quit and install"));
  const u2 = new Updates({ updater: fake2, version: '0.12.0' });
  fake2.emit('update-downloaded', { version: '0.13.0' });
  assert.strictEqual(await u2.install(), false);
  assert.strictEqual(u2.state().status, 'ready');
  // 不检查更新的情况（免安装版等）：没有 autoUpdater，检查和安装都什么也不做
  const off = new Updates({ reason: 'portable', version: '0.12.0' });
  assert.deepStrictEqual([off.state().status, off.state().reason], ['off', 'portable']);
  assert.strictEqual(off.check(true).status, 'off');
  assert.strictEqual(await off.install(), false);
});

test('自动更新：日志写到文件里，带时间，太长的截断；超过 1 MB 时旧的改名成 updater.old.log', () => {
  const { fileLogger } = require('../electron/updater');
  const dir = tmp();
  const file = path.join(dir, 'logs', 'updater.log');
  const log = fileLogger(file); // logs 文件夹不存在时自己建
  log.info('Checking for update');
  log.error(new Error('net::ERR_INTERNET_DISCONNECTED'));
  log.warn('x'.repeat(5000));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d info  Checking for update$/);
  assert.match(lines[1], /error Error: net::ERR_INTERNET_DISCONNECTED/);
  assert.ok(lines.slice(1).join('\n').includes('warn  xxx') && lines[lines.length - 1].length < 4100); // 太长的截断
  fs.writeFileSync(file, 'y'.repeat(1024 * 1024 + 1));
  fileLogger(file).info('new');
  assert.ok(fs.statSync(path.join(dir, 'logs', 'updater.old.log')).size > 1024 * 1024);
  assert.match(fs.readFileSync(file, 'utf8'), /info  new\n$/);
});

test('打包配置：更新源是 GitHub 的 Lauk1z/nightshift，electron-updater 在 dependencies 里（会被打进安装包）', () => {
  const pkg = require('../package.json');
  assert.deepStrictEqual(pkg.build.publish, [{ provider: 'github', owner: 'Lauk1z', repo: 'nightshift' }]);
  assert.ok(pkg.dependencies['electron-updater']);
  assert.ok(pkg.build.win.target.includes('nsis'));
  assert.match(pkg.scripts.dist, /--publish never/); // npm run dist 只打包，不上传
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ✓ ' + t.name);
    } catch (e) {
      failed++;
      console.log('  ✗ ' + t.name);
      console.log('    ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n    '));
    }
  }
  console.log(failed ? `\n${failed} 个测试失败` : `\n全部 ${tests.length} 个测试通过`);
  process.exitCode = failed ? 1 : 0;
})();
