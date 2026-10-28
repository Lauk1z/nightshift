'use strict';
// 导出会话：整段聊天记录写成给人看的 Markdown（项目文件夹里的 .agentchat/chat-*.md 是给成员读的，格式不一样）。
// 谁、什么时候、用的什么模型、说了什么；附件、改了哪些文件、出错和停止也写上。文字按当前的界面语言
const adapters = require('./adapters');
const { t: tr } = require('./i18n');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return tr('{n} 秒', { n: s });
  const m = Math.floor(s / 60);
  return m < 60 ? tr('{m} 分 {s} 秒', { m, s: s % 60 }) : tr('{h} 小时 {m} 分', { h: Math.floor(m / 60), m: m % 60 });
}
const oneLine = (s, n = 400) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const toolOf = (a) => {
  const ad = adapters.get(a.adapter);
  return a.adapter === 'openai' ? a.model || (ad && ad.label) : [ad ? ad.label : a.adapter, a.model].filter(Boolean).join(' · ');
};
const CHANGE = () => ({ add: tr('文件改动::新建'), update: tr('文件改动::修改'), delete: tr('文件改动::删除') });

function exportMarkdown(room, project, messages) {
  const out = [`# ${room.name}`, ''];
  if (project && !project.standalone) out.push(`- ${tr('导出::项目')}：${project.name}（${room.workspace}）`);
  else out.push(`- ${tr('文件夹')}：${room.workspace}`);
  const members = room.agents.map((a) => `${a.name}（${[a.role, toolOf(a)].filter(Boolean).join('，')}）`);
  out.push(`- ${tr('成员')}：${members.join(tr('、')) || tr('还没有成员')}`);
  out.push(`- ${tr('导出于 {time}', { time: stamp(Date.now()) })}`, '');
  const change = CHANGE();
  for (const m of messages) {
    // 系统提示（接力暂停、出错之类）写成一行引用
    if (m.kind === 'system') {
      out.push(`> ${oneLine(m.text)}`, '');
      continue;
    }
    const who = m.from === 'user' ? tr('你') : m.kind === 'review' ? tr('自动审查') : m.name + (m.role ? `（${m.role}）` : '');
    const meta = [stamp(m.ts)];
    if (m.meta && m.meta.model) meta.push(m.meta.model);
    if (m.meta && m.meta.ms) meta.push(tr('用时 {time}', { time: dur(m.meta.ms) }));
    out.push('---', '', `**${who}** · ${meta.join(' · ')}`, '');
    const text = String(m.text || '').trim();
    if (text) out.push(text, '');
    if (m.status === 'error') out.push(`> ${tr('出错了')}：${oneLine(m.error)}`, '');
    if (m.status === 'stopped') out.push(`> ${tr('已停止')}`, '');
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    if (atts.length) out.push(`${tr('附件')}：${atts.map((a) => '`' + a.path + (a.kind === 'dir' ? '/' : '') + '`').join(tr('、'))}`, '');
    const files = Array.isArray(m.files) ? m.files : [];
    if (files.length) out.push(`${tr('改动的文件')}：${files.map((f) => `\`${f.path}\`（${change[f.change] || f.change}）`).join(tr('、'))}`, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// 存文件时用的名字：去掉文件名里不能有的字符
function exportName(room) {
  const base = String(room.name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (base || 'chat') + '.md';
}

module.exports = { exportMarkdown, exportName };
