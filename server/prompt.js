'use strict';
// 协作协议与提示词：告诉每个 AI 它是谁、队友是谁、怎么用 @ 交接；
// 以及把群聊记录整理成它能读懂的形式。
const { promptSection, promptText } = require('./acceptance');

const USER_ALIASES = ['用户', 'user', 'human', '人类'];
const ALL_ALIASES = ['所有人', '全体成员', '全体', 'all', 'everyone'];
const RESERVED = [...USER_ALIASES, ...ALL_ALIASES, '系统', 'system', '你'];
// 没法从用户的话判断语言时，默认用界面语言回复（提示词本身保持中文）
const LANG_NAMES = { 'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', en: '英文（English）' };
const replyLang = () => LANG_NAMES[require('./i18n').lang()] || '简体中文';

// 成员 @用户（要用户拍板、提供信息或验收）时怎么办，会话设置里选：
//   manual 人工审查：后面还有成员要接着做的话，接力停下来，等用户回复或批准（默认）
//   auto   自动执行：先交给审查模型，风险低的由它代用户答复；高风险的、要用户亲自动手的才转给用户
//   full   全权代理：接力不停，成员自己拿主意
const APPROVAL = ['manual', 'auto', 'full'];
const approvalMode = (room) => {
  const v = room && room.settings && room.settings.approval;
  return APPROVAL.includes(v) ? v : 'manual';
};
const RULE_ASK = {
  manual: '6. 需要用户拍板、提供信息或验收时，@用户，然后停下来等。这时接力会暂停，排在后面的队友要等用户回复或批准以后才接着做。',
  auto:
    '6. 需要用户拍板、提供信息或验收时，@用户，然后停下来等。这类请求会先交给审查模型替用户把关：风险低的由它代用户答复（发言人是「自动审查」，按用户的答复对待）；高风险的操作、必须用户亲自动手的，才转给用户。所以请求里要写清楚要做什么、为什么、有什么风险。',
  full: '6. 用户已经授权你们全权处理：需要拍板时自己选最稳妥的方案接着做，不要停下来等用户批准。只有缺少只有用户才能提供的东西（账号、密钥、只有用户知道的需求，或者必须在用户电脑上亲手操作）时才 @用户。',
};

function oneLine(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function activeAgents(room) {
  return room.agents.filter((a) => a.enabled !== false);
}

// 找出文字里 @ 到的成员，按出现顺序返回 id；'user' 代表用户，'all' 代表所有人。
// 代码块里的 @ 不算。
function parseMentions(text, agents) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const keys = [
    ...agents.map((a) => ({ key: a.name, id: a.id })),
    ...USER_ALIASES.map((k) => ({ key: k, id: 'user' })),
    ...ALL_ALIASES.map((k) => ({ key: k, id: 'all' })),
  ].sort((x, y) => y.key.length - x.key.length);
  const found = [];
  const lower = clean.toLowerCase();
  for (let i = clean.indexOf('@'); i >= 0; i = clean.indexOf('@', i + 1)) {
    const prev = clean[i - 1];
    if (prev && /[A-Za-z0-9_.]/.test(prev)) continue; // 邮箱之类
    for (const k of keys) {
      const kk = k.key.toLowerCase();
      if (!lower.startsWith(kk, i + 1)) continue;
      const next = clean[i + 1 + kk.length];
      // 英文名后面紧跟英文字母/数字时不算（@GPTs 不等于 @GPT），中文名不受限制
      if (/[A-Za-z0-9_]$/.test(k.key) && next && /[A-Za-z0-9_]/.test(next)) continue;
      if (!found.includes(k.id)) found.push(k.id);
      break;
    }
  }
  return found;
}

function memberLine(a, selfId) {
  const me = a.id === selfId ? '（就是你）' : '';
  const role = a.role ? `：${a.role}` : '';
  const duty = a.instructions && a.id !== selfId ? `。${oneLine(a.instructions, 90)}` : '';
  return `- @${a.name}${me}${role}${duty}`;
}

function protocol(room, agent, logPath) {
  const agents = activeAgents(room);
  const mate = agents.find((a) => a.id !== agent.id);
  const example = mate ? mate.name : '某位队友';
  return [
    '# 团队协作模式',
    `你是「${agent.name}」，正在一个多 AI 协作群聊里工作。群里有一位人类用户（项目负责人）和几位 AI 成员，大家通过群聊消息分工合作，共同完成同一个项目。`,
    '',
    '## 你的角色',
    agent.role || '团队成员',
    agent.instructions ? agent.instructions : '',
    '',
    '## 群成员',
    '- @用户：人类项目负责人，做最终决定',
    ...agents.map((a) => memberLine(a, agent.id)),
    '',
    '## 共享的项目文件夹',
    room.workspace,
    '所有成员都在这个文件夹里工作，任何人的改动其他人马上能看到。' +
      (logPath ? `完整群聊记录保存在 ${logPath}，需要回顾更早的讨论时可以去读。` : ''),
    '',
    '## 协作规则',
    '1. 每次轮到你，你会收到自你上次发言以来群里的新消息。只做属于你职责的这一步，做完就交接。',
    '2. 你这一轮的「最终回复」会作为你的发言发到群里。队友看不到你的中间过程，所以最终回复要写清楚：做了什么、改了哪些文件、还有什么问题。',
    '3. 文件都放在共享的项目文件夹里，用相对路径创建和修改，不要写到项目文件夹以外。说「做完了」之前先确认文件确实已经在项目文件夹里；说测试通过之前要真的运行过，没运行就写明没运行。',
    '4. 每条发言后面括号里的「这一轮改动的文件」「这一轮没有改动项目文件夹里的文件」「这一轮有文件写到了项目文件夹以外」「交付验收清单」是系统按实际文件核对出来的，和发言里说的对不上时以它为准。',
    `5. 需要队友接着做或回答问题时，在最终回复里 @ 对方的名字，例如「@${example} 请根据 docs/design.md 实现首页」。只有被 @ 的成员会被唤醒；可以一次 @ 多人，会按顺序轮流执行。`,
    RULE_ASK[approvalMode(room)],
    '7. 你这一步做完、也不需要任何人接着做时，不要 @ 任何人，接力会自然结束。',
    '8. 只在需要对方行动时才用 @。只是提到某人时直接写名字、不要加 @（加了会把对方唤醒）。不要 @ 自己。',
    '9. 尊重分工：不要重做别人已经完成的部分；对别人的工作有意见，在群里说明并 @ 对方。',
    '10. 较长的方案、设计稿、接口约定请写成文件（例如 docs/ 目录下），消息里给出路径和要点即可。',
    `11. 用和用户相同的语言交流（默认${replyLang()}），简洁直接。`,
    '12. 用户消息里的「/名称」表示要求使用对应的技能（skill），具体怎么用会附在这一轮的提示里。',
    '13. 提到项目里的文件时，用相对项目文件夹的路径（例如 docs/design.md），不要写成本机的绝对路径链接。',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}

function changedFiles(m) {
  // 新消息里有按快照对比出来的准确列表
  if (Array.isArray(m.files) && m.files.length) return m.files.filter((f) => f.change !== 'delete').map((f) => f.path);
  // 快照里没有（旧消息，或者改的是 . 开头的文件夹这类不进快照的地方）：按工具记录，失败的和写到项目外的不算
  const out = [];
  for (const it of m.items || []) {
    if ((it.k === 'write' || it.k === 'edit') && it.d && it.s !== 'error' && !it.out && !out.includes(it.d)) out.push(it.d);
  }
  return out;
}

function renderMsg(m, selfId, perMsg = 12000) {
  let who;
  if (m.from === 'user') who = '用户';
  else if (m.kind === 'review') who = m.review && m.review.decision === 'approve' ? '自动审查（审查模型代用户答复，按用户的答复对待）' : '自动审查（已转交用户确认）';
  else who = m.name + (m.role ? `（${m.role}）` : '') + (m.from === selfId ? '（你之前的发言）' : '');
  let text = String(m.text || '').trim();
  if (text.length > perMsg) text = text.slice(0, perMsg) + '\n…（太长，已截断）';
  if (m.status === 'error') text += `${text ? '\n' : ''}（这一轮运行出错：${oneLine(m.error, 300)}）`;
  if (m.status === 'stopped') text += `${text ? '\n' : ''}（这一轮被用户中止了）`;
  // 下面几行是系统按实际文件核对出来的（见 orchestrator.js 的 delivery），协议里告诉了成员以这个为准
  const files = changedFiles(m);
  if (files.length) text += `\n（这一轮改动的文件：${files.slice(0, 20).join('、')}${files.length > 20 ? ' 等' : ''}）`;
  const out = Array.isArray(m.outside) ? m.outside : [];
  if (out.length) text += `\n（这一轮有文件写到了项目文件夹以外：${out.slice(0, 10).join('、')}${out.length > 10 ? ' 等' : ''}）`;
  if (m.unchanged) text += '\n（这一轮没有改动项目文件夹里的文件）';
  if (m.acceptance) text += '\n' + promptText(m.acceptance);
  return `[#${m.seq}] ${who}：\n${text || '（无内容）'}`;
}

// 从后往前取，直到用完字数预算；返回 [被省略条数, 保留的消息]
function budgetTail(msgs, selfId, budget) {
  const kept = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const len = renderMsg(msgs[i], selfId).length + 2;
    if (used + len > budget && kept.length) return [i + 1, kept];
    kept.unshift(msgs[i]);
    used += len;
  }
  return [0, kept];
}

function transcript(msgs, selfId, budget, logPath) {
  const [omitted, kept] = budgetTail(msgs, selfId, budget);
  const blocks = kept.map((m) => renderMsg(m, selfId));
  if (omitted) blocks.unshift(`（更早的 ${omitted} 条消息已省略${logPath ? '，完整记录见聊天记录文件' : ''}）`);
  return blocks.join('\n\n');
}

function turnInstruction(room, agent, trigger) {
  const names = activeAgents(room)
    .filter((a) => a.id !== agent.id)
    .map((a) => '@' + a.name)
    .join(' ');
  const why = trigger && trigger.byName ? `${trigger.byName === '用户' ? '用户' : trigger.byName} 在 #${trigger.seq} 里 @ 了你。` : '';
  // 全权代理每一轮都提醒（有会话记忆的成员只在第一轮看到完整的协作规则，中途改了设置也要知道）
  const ask = approvalMode(room) === 'full' ? '用户授权你们全权处理，自己拿主意，只有缺少只有用户能提供的东西时才 @用户' : '需要用户决定就 @用户';
  return [
    // 打开了交付验收清单的会话：每一轮都附上，中途才打开的、有会话记忆的成员也能看到
    ...(room.settings && room.settings.acceptance ? [promptSection(), ''] : []),
    '---',
    `现在轮到你（${agent.name}${agent.role ? '，' + agent.role : ''}）。${why}`,
    `完成你这一步，最终回复会发到群里。需要队友接手就 @ 名字（${names || '目前没有其他成员'}），${ask}，不需要任何人行动就不要 @。`,
  ].join('\n');
}

const visible = (m) => m.kind !== 'system';

// 命令行类 AI（有自己的会话记忆）：第一次给完整协议和历史，之后只给新消息。
// skillText：这一轮用户要求使用的技能说明（见 skills.js），放在「轮到你」之前
function buildCliPrompt({ room, agent, messages, fresh, trigger, logPath, skillText }) {
  const msgs = messages.filter(visible);
  const parts = [];
  if (fresh) {
    parts.push(protocol(room, agent, logPath));
    parts.push('## 群聊记录\n\n' + (msgs.length ? transcript(msgs, agent.id, 60000, logPath) : '（还没有消息）'));
  } else {
    const since = (room.lastSeen && room.lastSeen[agent.id]) || 0;
    const delta = msgs.filter((m) => m.seq > since && m.from !== agent.id);
    parts.push('## 群聊新消息（自你上次发言以来）\n\n' + (delta.length ? transcript(delta, agent.id, 60000, logPath) : '（没有新消息）'));
    // 自己的发言不再重复给，但交付后系统核对的结果（和用户点的通过 / 不通过）它还没看过
    for (const m of msgs.filter((x) => x.seq > since && x.from === agent.id && x.acceptance)) {
      parts.push(`## 你在 #${m.seq} 交付以后\n\n${promptText(m.acceptance)}`);
    }
  }
  if (skillText) parts.push(skillText);
  parts.push(turnInstruction(room, agent, trigger));
  return parts.join('\n\n');
}

// API 类模型（没有会话记忆）：每次都给协议 + 最近的历史。
function buildApiMessages({ room, agent, messages, trigger, logPath, skillText }) {
  const msgs = messages.filter(visible);
  const [omitted, kept] = budgetTail(msgs, agent.id, 100000);
  const out = [{ role: 'system', content: protocol(room, agent, logPath) }];
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last.role === role && role !== 'system') last.content += '\n\n' + content;
    else out.push({ role, content });
  };
  if (omitted) push('user', `（更早的 ${omitted} 条消息已省略）`);
  for (const m of kept) {
    if (m.from === agent.id) {
      push('assistant', String(m.text || '').trim() || '（无内容）');
      if (m.acceptance) push('user', promptText(m.acceptance)); // 自己交付以后系统核对的结果
    } else push('user', renderMsg(m, agent.id));
  }
  if (skillText) push('user', skillText);
  push('user', turnInstruction(room, agent, trigger));
  if (out[1] && out[1].role === 'assistant') out.splice(1, 0, { role: 'user', content: '（群聊开始）' });
  return out;
}

// ---------- 自动审查（「成员要你确认时」选了自动执行） ----------
// 成员 @用户 提出要用户确认的事时先问审查模型：风险低的它代用户答复，高风险的、要用户亲自动手的转给用户。
// 审查模型只读，每次都是新会话（不带记忆），看最近的群聊和这一条请求
function reviewProtocol(room) {
  return [
    '# 自动审查',
    '你是一个多 AI 协作群聊的审查员，替人类用户（项目负责人）把关。群里的 AI 成员 @用户 提出了要用户确认的问题或请求，用户让你先审查，再决定要不要叫他本人来。',
    '',
    '## 判断标准',
    '符合下面任意一条，就转交用户（escalate）：',
    '1. 高风险操作：删除或覆盖文件（尤其是项目文件夹以外的）、改系统设置或注册表、安装或卸载软件、运行来历不明的程序或从网上下载再执行、涉及账号密码密钥或付款、对外发布或推送（git push、发版、发消息、发邮件）、大批量且难以撤销的改动。',
    '2. 明确要用户亲自动手，或者要只有用户才有的东西：在用户自己的电脑上运行或点击、登录、提供 API Key 或账号、只有用户知道的需求细节，或者要用户亲自验收（试玩、看效果、确认结果）。',
    '3. 拿不准的。',
    '其余风险低的请求由你代用户答复（approve）：比如只在项目文件夹里读写文件、运行项目里的构建或测试脚本、在几个方案之间选一个（选成员推荐的，或者你认为最稳妥的）、确认可以继续下一步。',
    '',
    '可以只读地查看项目文件来帮助判断（比如看看要运行的脚本里写了什么），但不要修改任何文件，也不要运行会改动东西的命令。',
    '',
    '## 项目文件夹',
    room.workspace,
  ].join('\n');
}

function reviewTask(asker, msg) {
  return [
    `## 要审查的请求（#${msg.seq}，${asker.name}${asker.role ? `（${asker.role}）` : ''} 发的）`,
    '',
    String(msg.text || '').trim(),
    '',
    '---',
    '只输出一个 JSON 对象，不要别的文字：',
    `{"decision": "approve 或 escalate", "reason": "一句话说明为什么", "reply": "approve 时用用户的口吻给 ${asker.name} 的答复：明确选哪个方案、可以做什么、要注意什么，不要 @ 任何人；escalate 时留空"}`,
    `reason 和 reply 用${replyLang()}。`,
  ].join('\n');
}

// 请求之前的群聊（不含这一条），给审查模型判断上下文
const reviewContext = (msgs, msg, logPath) => {
  const earlier = msgs.filter((m) => visible(m) && m.seq < msg.seq);
  return '## 最近的群聊记录\n\n' + (earlier.length ? transcript(earlier, '', 30000, logPath) : '（没有更早的消息）');
};

function buildReviewPrompt({ room, asker, msg, messages, logPath }) {
  return [reviewProtocol(room), reviewContext(messages, msg, logPath), reviewTask(asker, msg)].join('\n\n');
}

function buildReviewApiMessages({ room, asker, msg, messages, logPath }) {
  return [
    { role: 'system', content: reviewProtocol(room) },
    { role: 'user', content: reviewContext(messages, msg, logPath) + '\n\n' + reviewTask(asker, msg) },
  ];
}

// 审查模型的结论：从回复里找 JSON（可能包在 ```json 里，前后还有别的话）。认不出来就返回 null，当作转交用户
function parseVerdict(text) {
  const s = String(text || '');
  const tries = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) tries.push(s.slice(i, j + 1));
  for (const t of tries) {
    let v;
    try {
      v = JSON.parse(t.trim());
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const d = String(v.decision || '').trim().toLowerCase();
    const decision = /^(approve|approved|allow|yes|ok)$/.test(d) ? 'approve' : /^(escalate|human|user|ask|deny|reject|no)$/.test(d) ? 'escalate' : '';
    if (decision) return { decision, reason: oneLine(v.reason, 400), reply: String(v.reply || '').trim().slice(0, 4000) };
  }
  return null;
}

// ---------- 侧边对话 ----------
// 用户单独问某个成员问题：不进群聊、不触发接力、只读。
function sideProtocol(room, agent, logPath) {
  const agents = activeAgents(room);
  return [
    '# 侧边对话',
    `你是「${agent.name}」${agent.role ? `（${agent.role}）` : ''}，是一个多 AI 协作群聊里的成员。现在用户在「侧边对话」里单独问你问题：`,
    '- 这里的对话不会发到群聊，其他成员看不到，也不会触发接力，所以不要 @ 任何人。',
    '- 这是只读模式：可以阅读项目文件、查看代码来回答，但不要修改、创建或删除任何文件，也不要运行会改动东西的命令。用户要你改东西时，告诉他在群聊里安排。',
    `- 回答直接、简洁，用和用户相同的语言（默认${replyLang()}）。提到项目里的文件时用相对项目文件夹的路径。`,
    '',
    '## 项目文件夹',
    room.workspace + (logPath ? `\n完整群聊记录保存在 ${logPath}。` : ''),
    '',
    '## 群成员',
    '- @用户：人类项目负责人',
    ...agents.map((a) => memberLine(a, agent.id)),
  ].join('\n');
}

function renderSide(m, selfId) {
  let who;
  if (m.from === 'user') who = `用户${m.toName ? `（问 ${m.toName}）` : ''}`;
  else who = (m.name || '成员') + (m.from === selfId ? '（你）' : '');
  let text = String(m.text || '').trim();
  if (text.length > 8000) text = text.slice(0, 8000) + '\n…（太长，已截断）';
  if (m.status === 'error') text += `${text ? '\n' : ''}（这次回答出错了）`;
  return `${who}：\n${text || '（无内容）'}`;
}

function sideTranscript(list, selfId, budget) {
  const kept = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = renderSide(list[i], selfId);
    if (used + s.length > budget && kept.length) break;
    kept.unshift(s);
    used += s.length + 2;
  }
  return kept.join('\n\n');
}

// 命令行类 AI：第一次给说明 + 群聊近况 + 之前的侧边对话；之后只给新的群聊消息和别人在侧边对话里的问答
function buildSidePrompt({ room, agent, messages, side, question, fresh, seen, logPath }) {
  const msgs = messages.filter(visible);
  const parts = [];
  if (fresh) {
    parts.push(sideProtocol(room, agent, logPath));
    parts.push('## 群聊记录（最近）\n\n' + (msgs.length ? transcript(msgs, agent.id, 40000, logPath) : '（还没有消息）'));
    if (side.length) parts.push('## 之前的侧边对话\n\n' + sideTranscript(side, agent.id, 16000));
  } else {
    const since = (seen && seen.main) || 0;
    const delta = msgs.filter((m) => m.seq > since);
    if (delta.length) parts.push('## 群聊新消息（自你上次在侧边对话里回答以来）\n\n' + transcript(delta, agent.id, 30000, logPath));
    const others = side.filter((m) => m.n > ((seen && seen.side) || 0) && m.from !== agent.id && !(m.from === 'user' && m.agentId === agent.id));
    if (others.length) parts.push('## 侧边对话里别人的问答\n\n' + sideTranscript(others, agent.id, 12000));
  }
  parts.push(`---\n用户在侧边对话里问你（只读，不要改文件，不要 @ 任何人）：\n\n${question}`);
  return parts.join('\n\n');
}

// API 类模型：每次都给说明、群聊近况和侧边对话记录
function buildSideApiMessages({ room, agent, messages, side, question, logPath }) {
  const msgs = messages.filter(visible);
  const out = [{ role: 'system', content: sideProtocol(room, agent, logPath) }];
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last.role === role && role !== 'system') last.content += '\n\n' + content;
    else out.push({ role, content });
  };
  push('user', '## 群聊记录（最近）\n\n' + (msgs.length ? transcript(msgs, agent.id, 60000, logPath) : '（还没有消息）'));
  let used = 0;
  const kept = [];
  for (let i = side.length - 1; i >= 0 && used < 30000; i--) {
    kept.unshift(side[i]);
    used += String(side[i].text || '').length;
  }
  for (const m of kept) {
    if (m.from === agent.id) push('assistant', String(m.text || '').trim() || '（无内容）');
    else push('user', renderSide(m, agent.id));
  }
  push('user', `用户在侧边对话里问你（只读，不要改文件，不要 @ 任何人）：\n\n${question}`);
  return out;
}

module.exports = {
  parseMentions,
  buildCliPrompt,
  buildApiMessages,
  buildSidePrompt,
  buildSideApiMessages,
  buildReviewPrompt,
  buildReviewApiMessages,
  parseVerdict,
  approvalMode,
  APPROVAL,
  protocol,
  USER_ALIASES,
  ALL_ALIASES,
  RESERVED,
};
