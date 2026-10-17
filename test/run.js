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

test('设置和用量接口；换了语言，服务端的报错和 boot.js 跟着换', async () => {
  const { start } = require('../server');
  const dir = tmp();
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
    // 新会话默认照搬当前会话的成员：新的 id，配置（连同 Key）一样，默认接收人跟着对上
    const second = (await call('POST', `/api/projects/${made.project.id}/rooms`, { from: rid })).json();
    assert.notStrictEqual(second.id, rid);
    assert.deepStrictEqual(second.agents.map((a) => [a.name, a.model, a.api.hasKey]), [['DS', 'deepseek-chat', true]]);
    assert.notStrictEqual(second.agents[0].id, ag.id);
    assert.strictEqual(second.settings.defaultAgent, second.agents[0].id);
    assert.strictEqual(second.settings.maxAutoTurns, 7);
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
    // 终端属于项目：从哪个会话打开都是同一组
    assert.deepStrictEqual((await call('GET', `/api/term?room=${second.id}`)).json().terminals, []);
    // 换文件夹：整个项目一起换
    const ws2 = tmp();
    await call('PATCH', `/api/projects/${made.project.id}`, { workspace: ws2, name: '待办 App 2' });
    for (const id of [rid, second.id]) {
      const room = (await call('GET', `/api/rooms/${id}`)).json().room;
      assert.deepStrictEqual([room.workspace, room.projectName], [ws2, '待办 App 2']);
    }
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
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, prompt, promptFile: pf >= 0 ? args[pf + 1] : null }) + '\\n');
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
