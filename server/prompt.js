'use strict';
// 协作协议与提示词：告诉每个 AI 它是谁、队友是谁、怎么用 @ 交接；
// 以及把群聊记录整理成它能读懂的形式。

const USER_ALIASES = ['用户', 'user', 'human', '人类'];
const ALL_ALIASES = ['所有人', '全体成员', '全体', 'all', 'everyone'];
const RESERVED = [...USER_ALIASES, ...ALL_ALIASES, '系统', 'system', '你'];
// 没法从用户的话判断语言时，默认用界面语言回复（提示词本身保持中文）
const LANG_NAMES = { 'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', en: '英文（English）' };
const replyLang = () => LANG_NAMES[require('./i18n').lang()] || '简体中文';

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
    `3. 需要队友接着做或回答问题时，在最终回复里 @ 对方的名字，例如「@${example} 请根据 docs/design.md 实现首页」。只有被 @ 的成员会被唤醒；可以一次 @ 多人，会按顺序轮流执行。`,
    '4. 需要用户拍板、提供信息或验收时，@用户，然后停下来等。',
    '5. 你这一步做完、也不需要任何人接着做时，不要 @ 任何人，接力会自然结束。',
    '6. 只在需要对方行动时才用 @。只是提到某人时直接写名字、不要加 @（加了会把对方唤醒）。不要 @ 自己。',
    '7. 尊重分工：不要重做别人已经完成的部分；对别人的工作有意见，在群里说明并 @ 对方。',
    '8. 较长的方案、设计稿、接口约定请写成文件（例如 docs/ 目录下），消息里给出路径和要点即可。',
    `9. 用和用户相同的语言交流（默认${replyLang()}），简洁直接。`,
    '10. 用户消息里的「/名称」表示要求使用对应的技能（skill），具体怎么用会附在这一轮的提示里。',
    '11. 提到项目里的文件时，用相对项目文件夹的路径（例如 docs/design.md），不要写成本机的绝对路径链接。',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}

function changedFiles(m) {
  // 新消息里有按快照对比出来的准确列表
  if (Array.isArray(m.files) && m.files.length) return m.files.filter((f) => f.change !== 'delete').map((f) => f.path);
  const out = [];
  for (const it of m.items || []) {
    if ((it.k === 'write' || it.k === 'edit') && it.d && !out.includes(it.d)) out.push(it.d);
  }
  return out;
}

function renderMsg(m, selfId, perMsg = 12000) {
  let who;
  if (m.from === 'user') who = '用户';
  else who = m.name + (m.role ? `（${m.role}）` : '') + (m.from === selfId ? '（你之前的发言）' : '');
  let text = String(m.text || '').trim();
  if (text.length > perMsg) text = text.slice(0, perMsg) + '\n…（太长，已截断）';
  if (m.status === 'error') text += `${text ? '\n' : ''}（这一轮运行出错：${oneLine(m.error, 300)}）`;
  if (m.status === 'stopped') text += `${text ? '\n' : ''}（这一轮被用户中止了）`;
  const files = changedFiles(m);
  if (files.length) text += `\n（这一轮改动的文件：${files.slice(0, 20).join('、')}${files.length > 20 ? ' 等' : ''}）`;
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
  return [
    '---',
    `现在轮到你（${agent.name}${agent.role ? '，' + agent.role : ''}）。${why}`,
    `完成你这一步，最终回复会发到群里。需要队友接手就 @ 名字（${names || '目前没有其他成员'}），需要用户决定就 @用户，不需要任何人行动就不要 @。`,
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
    if (m.from === agent.id) push('assistant', String(m.text || '').trim() || '（无内容）');
    else push('user', renderMsg(m, agent.id));
  }
  if (skillText) push('user', skillText);
  push('user', turnInstruction(room, agent, trigger));
  if (out[1] && out[1].role === 'assistant') out.splice(1, 0, { role: 'user', content: '（群聊开始）' });
  return out;
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
  protocol,
  USER_ALIASES,
  ALL_ALIASES,
  RESERVED,
};
