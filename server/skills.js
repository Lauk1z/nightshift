'use strict';
// 技能（skill）：读取各家 AI 工具已经装好的技能，供输入框里用 / 选择。
// 消息里用了 /技能名 时，告诉接手的成员用这个技能；它自己的工具里没装这个技能的话，把技能说明直接附在提示词里。
//
// 读取的位置（都要有 SKILL.md）：
//   Claude Code：~/.claude/skills、项目里的 .claude/skills、已安装插件的 skills，以及 ~/.claude/commands 里的自定义命令
//   Codex：~/.codex/skills（含系统技能）、项目里的 .codex/skills、config.toml 里启用的插件
//   OpenCode：~/.config/opencode/skill(s)、项目里的 .opencode/skill(s)
//   Gemini CLI：~/.gemini/skills、项目里的 .gemini/skills；Grok Build：~/.grok/skills、项目里的 .grok/skills
//   pi：~/.pi/agent/skills、项目里的 .pi/skills；Hermes：它数据文件夹里的 skills
//   DeepSeek Harness：~/.dsh/skills（DSH_HOME）、项目里的 .dsh/skills，它也读通用的 .agents/skills
//   通用：~/.agents/skills、项目里的 .agents/skills
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_INLINE = 16000;
const TTL = 30000;
const cache = new Map();

const home = () => os.homedir();
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

// 读 SKILL.md 开头 --- 之间的 name / description（支持 > 和 | 折行写法）
function frontMatter(text) {
  const m = String(text || '').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!m) return meta;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) {
      const more = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      v = more.join(' ');
    }
    meta[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return meta;
}

// 在 dir 下找 <技能>/SKILL.md（最多往下找 3 层，比如 Codex 的 .system/xxx/SKILL.md）
function scanSkillDir(dir, info, out, depth = 0) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name === 'node_modules') continue;
    const sub = path.join(dir, e.name);
    // 很多技能管理工具会用符号链接把同一个技能挂到 ~/.claude/skills 等位置，要跟进去看
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(sub).isDirectory();
      } catch {}
    }
    if (!isDir) continue;
    const file = path.join(sub, 'SKILL.md');
    if (exists(file)) {
      let meta = {};
      try {
        meta = frontMatter(fs.readFileSync(file, 'utf8').slice(0, 8000));
      } catch {}
      const base = meta.name || e.name;
      out.push({ ...info, name: info.prefix ? `${info.prefix}:${base}` : base, description: meta.description || '', file, dir: sub });
    } else if (depth < 2) {
      scanSkillDir(sub, info, out, depth + 1);
    }
  }
}

// ~/.claude/commands/*.md：自定义斜杠命令，用法和技能一样
function scanCommands(dir, info, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const file = path.join(dir, e.name);
    let meta = {};
    try {
      meta = frontMatter(fs.readFileSync(file, 'utf8').slice(0, 8000));
    } catch {}
    out.push({ ...info, name: e.name.replace(/\.md$/i, ''), description: meta.description || '自定义命令', file, dir });
  }
}

// Claude Code 已安装的插件
function claudePlugins(out) {
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(path.join(home(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return;
  }
  let disabled = {};
  try {
    disabled = JSON.parse(fs.readFileSync(path.join(home(), '.claude', 'settings.json'), 'utf8')).enabledPlugins || {};
  } catch {}
  for (const [id, installs] of Object.entries((j && j.plugins) || {})) {
    if (disabled[id] === false) continue;
    const inst = Array.isArray(installs) ? installs[installs.length - 1] : installs;
    if (!inst || !inst.installPath) continue;
    const plugin = id.split('@')[0];
    scanSkillDir(path.join(inst.installPath, 'skills'), { tool: 'claude', scope: 'plugin', prefix: plugin }, out);
  }
}

// Codex 在 config.toml 里启用的插件
function codexPlugins(out) {
  const codexHome = process.env.CODEX_HOME || path.join(home(), '.codex');
  let toml = '';
  try {
    toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return;
  }
  const sources = {};
  for (const m of toml.matchAll(/^\[marketplaces\.([^\]]+)\][^[]*?^source\s*=\s*['"]([^'"]+)['"]/gm)) {
    sources[m[1].replace(/"/g, '')] = m[2].replace(/^\\\\\?\\/, '');
  }
  for (const m of toml.matchAll(/^\[plugins\."([^"@]+)@([^"]+)"\][^[]*?^enabled\s*=\s*(\w+)/gm)) {
    if (m[3] !== 'true') continue;
    const [, name, market] = m;
    const dirs = [];
    const cacheDir = path.join(codexHome, 'plugins', 'cache', market, name);
    try {
      // 缓存里每个版本一个文件夹，取最新的
      const vers = fs.readdirSync(cacheDir).map((v) => path.join(cacheDir, v));
      vers.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (vers[0]) dirs.push(path.join(vers[0], 'skills'));
    } catch {}
    if (sources[market]) dirs.push(path.join(sources[market], 'plugins', name, 'skills'), path.join(sources[market], name, 'skills'));
    const dir = dirs.find(exists);
    if (dir) scanSkillDir(dir, { tool: 'codex', scope: 'plugin', prefix: name }, out);
  }
}

function collect(workspace) {
  const raw = [];
  const h = home();
  const user = (tool, dir) => scanSkillDir(dir, { tool, scope: 'user' }, raw);
  const project = (tool, dir) => workspace && scanSkillDir(path.join(workspace, dir), { tool, scope: 'project' }, raw);

  project('claude', path.join('.claude', 'skills'));
  project('codex', path.join('.codex', 'skills'));
  project('opencode', path.join('.opencode', 'skill'));
  project('opencode', path.join('.opencode', 'skills'));
  project('gemini', path.join('.gemini', 'skills'));
  project('grok', path.join('.grok', 'skills'));
  project('pi', path.join('.pi', 'skills'));
  project('dsh', path.join('.dsh', 'skills'));
  project('shared', path.join('.agents', 'skills'));
  if (workspace) scanCommands(path.join(workspace, '.claude', 'commands'), { tool: 'claude', scope: 'project' }, raw);

  user('claude', path.join(h, '.claude', 'skills'));
  scanCommands(path.join(h, '.claude', 'commands'), { tool: 'claude', scope: 'user' }, raw);
  user('codex', path.join(process.env.CODEX_HOME || path.join(h, '.codex'), 'skills'));
  user('opencode', path.join(h, '.config', 'opencode', 'skill'));
  user('opencode', path.join(h, '.config', 'opencode', 'skills'));
  user('gemini', path.join(h, '.gemini', 'skills'));
  user('grok', path.join(process.env.GROK_HOME || path.join(h, '.grok'), 'skills'));
  user('pi', path.join(h, '.pi', 'agent', 'skills'));
  user('hermes', path.join(require('./models').hermesHome(), 'skills'));
  user('dsh', path.join(process.env.DSH_HOME || path.join(h, '.dsh'), 'skills'));
  user('shared', path.join(h, '.agents', 'skills'));
  claudePlugins(raw);
  codexPlugins(raw);

  // 同名的合并成一项，记下哪些工具自己装了它
  const byName = new Map();
  for (const s of raw) {
    if (!/^[\w][\w.:-]{0,79}$/.test(s.name)) continue;
    const cur = byName.get(s.name);
    if (cur) {
      if (s.tool !== 'shared' && !cur.tools.includes(s.tool)) cur.tools.push(s.tool);
      if (!cur.description && s.description) cur.description = s.description;
    } else {
      byName.set(s.name, {
        name: s.name,
        description: s.description,
        tools: s.tool === 'shared' ? [] : [s.tool],
        scope: s.scope,
        file: s.file,
        dir: s.dir,
      });
    }
  }
  const order = { project: 0, user: 1, plugin: 2 };
  return [...byName.values()].sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));
}

function listSkills(workspace, force = false) {
  const key = workspace || '';
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.list;
  const list = collect(workspace);
  cache.set(key, { at: Date.now(), list });
  return list;
}

// 找出文字里用到的 /技能名（只认真实存在的技能，避免把路径之类的误认成技能）
function usedSkills(text, list) {
  const names = new Map(list.map((s) => [s.name.toLowerCase(), s]));
  const out = [];
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  for (const m of clean.matchAll(/(^|[\s(（,，。!！?？:：;；、])\/([\w][\w.:-]*)/g)) {
    const s = names.get(m[2].replace(/[.:]+$/, '').toLowerCase());
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// 写进提示词的说明：成员自己装了这个技能就让它直接用，没装就把 SKILL.md 内容附上
function skillSection(skills, adapter) {
  if (!skills.length) return '';
  const parts = ['## 用户要求使用的技能'];
  for (const s of skills) {
    // Grok Build 自己也会读 Claude 的技能（~/.claude、项目里的 .claude，插件里的除外）和 .agents/skills
    const grokHas = adapter === 'grok' && (!s.tools.length || (s.tools.includes('claude') && s.scope !== 'plugin'));
    // DeepSeek Harness 也会读通用的 .agents/skills
    const dshHas = adapter === 'dsh' && !s.tools.length;
    if (s.tools.includes(adapter) || grokHas || dshHas) {
      parts.push(`- /${s.name}：你那边已经装了这个技能，请用它来完成这一步。`);
      continue;
    }
    let body = '';
    try {
      body = fs.readFileSync(s.file, 'utf8');
    } catch {}
    if (body.length > MAX_INLINE) body = body.slice(0, MAX_INLINE) + '\n…（太长，后面省略了，完整内容见技能文件）';
    parts.push(
      `- /${s.name}：你那边没有装这个技能，下面是它的说明，请照着做。技能文件夹是 ${s.dir}，里面可能还有脚本、模板和参考资料，需要时可以去读。`,
      '<<<技能说明开始',
      body.trim() || '（技能文件是空的）',
      '技能说明结束>>>'
    );
  }
  return parts.join('\n');
}

module.exports = { listSkills, usedSkills, skillSection, frontMatter };
