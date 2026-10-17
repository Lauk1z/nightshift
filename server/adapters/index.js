'use strict';
const { refreshPath } = require('../proc');

const list = [
  require('./claude'),
  require('./codex'),
  require('./opencode'),
  require('./gemini'),
  require('./grok'),
  require('./pi'),
  require('./hermes'),
  require('./dsh'),
  require('./openai'),
];
const byId = new Map(list.map((a) => [a.id, a]));

let cached = null;
let cachedAt = 0;
let pending = null;
let pendingForce = false;

// 检测这台电脑上装了哪些 AI 工具。
// 第一次和「重新检测」时会先读一遍系统最新的 PATH：刚装的工具、或者在新电脑上装 Agent Chat 时，都不用重启就能找到。
// force 时还会重新探测每个工具的版本能力（支持哪些参数和思考强度档位）。
async function detectAll(force = false) {
  if (!force && cached && Date.now() - cachedAt < 60000) return cached;
  // 正在检测时：普通请求直接等它；「重新检测」要等它结束后再完整做一遍，不能拿旧结果充数
  if (pending && (pendingForce || !force)) return pending;
  if (pending) await pending.catch(() => {});
  pendingForce = force;
  pending = (async () => {
    if (force || !cached) await refreshPath();
    const out = {};
    await Promise.all(
      list.map(async (a) => {
        try {
          out[a.id] = { id: a.id, label: a.label, cli: !!a.cmd, ...(await a.detect(force)) };
        } catch (e) {
          out[a.id] = { id: a.id, label: a.label, cli: !!a.cmd, installed: false, error: e.message };
        }
      })
    );
    cached = out;
    cachedAt = Date.now();
    return out;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// 改了成员设置以后，旧会话还能不能续用：换了接入方式不能；有的工具（DeepSeek Harness，pinsSession）
// 在建会话时就定下了模型、思考强度和权限，改了这几项也不能
function sessionOutdated(prev, next) {
  if (next.adapter !== prev.adapter) return true;
  const a = byId.get(next.adapter);
  return !!(a && a.pinsSession) && ['model', 'effort', 'permission'].some((k) => (next[k] || '') !== (prev[k] || ''));
}

// 测试时用来注册假的适配器
function register(a) {
  byId.set(a.id, a);
}

module.exports = { list, get: (id) => byId.get(id), detectAll, register, sessionOutdated };
