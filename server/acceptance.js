'use strict';
// 交付验收清单（会话设置里打开）。成员把成果交给用户验收时 —— 写了交付报告，或者接力到它这里结束、说做完了 ——
// Nightshift 按清单逐项核对实际的文件和工具记录，不只听成员怎么说。结果记在那条发言上（acceptance），
// 界面上是一张清单卡片（app.js 的 acceptNode），也写进给下一位成员的聊天记录（prompt.js 的 renderMsg）。
// 核对只读：不运行成员做的程序，也不删除任何文件。
const fs = require('fs');
const path = require('path');
const files = require('./files');

// 清单上的项，顺序就是卡片上的顺序。前六项是用户定的；最后一项是同一份反馈里遇到的问题（中文说明全变成了问号，没人发现）。
// 每项的结论 s：pass 通过、fail 没通过、user 只能由用户确认、na 这次交付不涉及。用户点的记在 u 里（pass / fail）：
// user 的项点通过或不通过；fail 的项核对得不对时（核对靠的是文件和命令的特征，难免有看错的）可以点「仍然通过」。
// f 是依据，每条 { c: 类别, ...数据 }，界面和给成员的文字各自按类别写成句子
const ITEMS = ['source', 'tests', 'exe', 'launch', 'logs', 'originals', 'encoding'];

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const fwd = (p) => String(p).replace(/\\/g, '/');
const relOf = (root, full) => fwd(path.relative(root, full));
// 文件列表最多带 8 个，n 是总数
const some = (list) => ({ files: list.slice(0, 8), n: list.length });

// ---------- 交付报告：成员按协议里的格式写在最终回复的最后 ----------
const FIELDS = [
  ['source', /^(源代码|源码|代码|源文件|source( code| files?)?|code)$/i],
  ['test', /^(测试命令|测试|自动化测试|tests?( commands?)?)$/i],
  ['exe', /^(可执行文件|可执行程序|程序|exe|executables?)$/i],
  ['deps', /^(依赖文件|依赖|所需文件|dependencies|deps|required files)$/i],
  ['launch', /^(启动测试|启动|launch( test)?|startup( test)?)$/i],
  ['log', /^(日志|日志文件|logs?)$/i],
  ['manifest', /^(交付清单|清单|manifest|delivery (list|manifest))$/i],
  ['cleanup', /^(可以清理的中间产物|可清理的中间产物|待清理的中间产物|中间产物|待清理|cleanup|intermediates|build intermediates)$/i],
];
const NONE = /^(无|没有|暂无|不适用|不需要|n\/?a|none|no|-|—|–)$/i;

// 返回 { fields: { source: '原文', … }, none: [写了「无」的项] }；没有交付报告时返回 null
function parseReport(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /交付报告|delivery report/i.test(l));
  if (start < 0) return null;
  const out = { fields: {}, none: [] };
  let begun = false;
  for (const raw of lines.slice(start + 1)) {
    const l = raw
      .trim()
      .replace(/^(?:[-*+•]|\d+[.)、])\s*/, '')
      .replace(/\*\*/g, '');
    if (!l || /^```/.test(l)) continue;
    const m = l.match(/^([^:：]{1,24}?)\s*[:：]\s*(.*)$/);
    const f = m && FIELDS.find(([, re]) => re.test(m[1].trim()));
    if (!f) {
      if (begun) break; // 报告后面的正文
      continue;
    }
    begun = true;
    const v = m[2].trim();
    if (NONE.test(v.replace(/[。.]$/, ''))) out.none.push(f[0]);
    else if (v) out.fields[f[0]] = v;
  }
  return begun ? out : null;
}

// 一行里的几个路径：顿号、逗号、分号隔开；Markdown 链接取地址，去掉反引号、引号和每个路径后面括号里的说明
// （说明里也可能有顿号，所以先去掉说明再拆；路径中间的括号不动，比如 My App (x86)/a.py）
function splitPaths(v) {
  return String(v || '')
    .replace(/\[[^\]]*\]\(([^)]+)\)/g, '$1')
    .replace(/[（(][^）)]*[）)](?=\s*(?:[、，,；;]|$))/g, '')
    .split(/\s*[、，,；;]\s*|\s+(?:和|及|and)\s+/)
    .map((s) => s.replace(/[`"'“”‘’<>]/g, '').trim())
    .filter((s) => s && !NONE.test(s));
}

// 报告里的一个路径在哪：ok（在项目里）/ missing（在项目里但不存在）/ outside（跑出了项目文件夹）。
// 路径后面跟了说明（「dist/calc.exe 已打包」）时按前面那段算
const looksPath = (s) => /\.\w{1,8}$|[\\/]$/.test(s);
function where(root, token) {
  const first = token.split(/\s+/)[0];
  const shown = first !== token && looksPath(first) && !looksPath(token) ? first : token;
  for (const c of [token, shown]) {
    const full = files.resolveInside(root, c);
    if (full && fs.existsSync(full)) return { state: 'ok', full, rel: relOf(root, full) || '.' };
  }
  const full = files.resolveInside(root, shown);
  if (!full) return { state: 'outside', rel: fwd(files.absolutePath(shown) || shown) };
  return { state: 'missing', full, rel: relOf(root, full) };
}

// ---------- 什么时候核对 ----------
// 说做完了（前面紧挨着「没、未、不」这类否定词的不算）
const DONE = /完成|做完|做好|写好|改好|修好|搞定|实现了|交付|验收|可以用了|可以使用|可以运行|都通过|全部通过|\b(?:done|finished|completed?|ready|deliver(?:ed|y)?|all set)\b/gi;
const NEG = /(?:没有|没能|未能|不能|无法|没|未|不|\bnot(?:\s+yet)?|n't(?:\s+yet)?|\bnever)\s*$/i;
function claimsDone(text) {
  const s = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  for (const m of s.matchAll(DONE)) {
    if (!NEG.test(s.slice(Math.max(0, m.index - 12), m.index))) return true;
  }
  return false;
}

// 算不算「交给用户验收」：写了交付报告；或者没有 @ 别的成员接着做（接力到这里结束），并且说做完了。
// 只是交接给队友、向用户提问的不算，普通聊天不受影响
function isDelivery({ text, report, handoff }) {
  if (report) return true;
  return !handoff && claimsDone(text);
}

// ---------- 工具记录里的命令 ----------
// 测试框架，或者用解释器运行测试文件。安装、查看文件的命令不算（cat tests/x.py、pip install pytest 都不是跑测试）
const RUNNERS =
  /\b(?:pytest|py\.test|unittest|nose2|tox|jest|vitest|mocha|ava|jasmine|karma|phpunit|rspec|ctest)\b|\b(?:go|cargo|dotnet|deno|bun|swift|flutter)\s+test\b|\bnode\s+--test\b|\b(?:npm|pnpm|yarn)(?:\s+run)?\s+test\b|\bplaywright\s+test\b|\bcypress\s+run\b|\bmvnw?\b[^|;&\n]*\s(?:test|verify)\b|\bgradlew?(?:\.bat)?\b[^|;&\n]*\s(?:test|check)\b/gi;
const INTERP = /^(?:&\s*)?["']?(?:[^"'\s]*[\\/])?(?:python[\d.]*|py|node|deno|bun|ruby|php|bash|sh|pwsh|powershell)(?:\.exe)?["']?\s/i;
const TEST_FILE = /(?:^|[\s"'\\/])((?:tests?|__tests__|specs?)[\\/][^\s"'|;&]+|test[\w.-]*\.(?:py|js|mjs|cjs|ts|rb|php|sh|ps1|bat)|[\w.-]+[._-](?:tests?|spec)\.(?:py|js|mjs|cjs|ts|rb|php|sh|ps1|bat))/gi;
const IS_TEST_FILE = new RegExp(TEST_FILE.source, 'i');
const NOT_RUN =
  /^(?:sudo\s+)?(?:cat|type|gc|get-content|more|less|head|tail|grep|rg|findstr|select-string|sls|ls|dir|gci|get-childitem|echo|write-host|write-output|code|notepad|git|pip3?|conda|choco|winget|scoop|brew|apt(?:-get)?|gem|composer|npm\s+(?:i|install|ci|add|uninstall)|pnpm\s+(?:i|install|add)|yarn\s+(?:add|install)|cargo\s+install|go\s+(?:install|get)|dotnet\s+(?:add|tool))\b|^(?:python[\d.]*|py)\s+-m\s+pip\b/i;
const segments = (cmd) =>
  String(cmd || '')
    .split(/\s*(?:&&|\|\||[;|\n])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

// 命令里跑了哪些测试（测试框架名，或者测试文件名），不是跑测试的命令返回 []
function testTokens(cmd) {
  const out = new Set();
  for (const seg of segments(cmd)) {
    if (NOT_RUN.test(seg)) continue;
    for (const m of seg.matchAll(RUNNERS)) out.add(m[0].toLowerCase().replace(/\s+run\s+test/, ' test').replace(/\s+/g, ' '));
    // 用解释器运行测试文件（python tests/test_calc.py），或者直接运行测试脚本（.\run_tests.bat）
    if (INTERP.test(seg + ' ') || IS_TEST_FILE.test(' ' + seg.split(/\s+/)[0])) {
      for (const m of seg.matchAll(TEST_FILE)) out.add(fwd(m[1]).split('/').pop().toLowerCase());
    }
  }
  return [...out];
}

// 删除文件的命令
const RM = /^(?:sudo\s+)?(?:rm|rmdir|rd|del|erase|remove-item|ri|unlink)\b/i;
const RM_ANY = /shutil\.rmtree|os\.(?:remove|unlink|rmdir)\(|\bgit\s+clean\b|\bclear-recyclebin\b/i;
const isRemove = (cmd) => RM_ANY.test(cmd) || segments(cmd).some((s) => RM.test(s));

// 命令里启动过这些程序没有：直接运行（dist\calc.exe、& "C:\My App\calc.exe" --version），
// 或者用 start / Start-Process 打开。只是查看、复制、打包时提到名字的不算
const OPENERS = /^(?:start|start-process|saps|invoke-item|ii|explorer(?:\.exe)?|cmd(?:\.exe)?)$/;
const exeName = (p) => fwd(p).split('/').pop().toLowerCase().replace(/\.exe$/, '');
function launches(cmd, names) {
  return segments(cmd).some((seg) => {
    const quoted = seg.match(/^&?\s*["']([^"']+)["']/);
    const first = (quoted ? quoted[1] : seg.replace(/^&\s*/, '').split(/\s+/)[0]).toLowerCase();
    if (names.includes(exeName(first))) return true;
    const low = seg.toLowerCase();
    return OPENERS.test(first) && names.some((n) => low.includes(n));
  });
}

// 说测试通过了（「测试未通过」这类不算）
const SAID_PASS = /(?:测试|单元测试|自测|用例)[^。\n]{0,12}?(?:通过|成功|全绿|都过了)|全部通过|\btests?\b[^.\n]{0,24}?\b(?:pass(?:ed|es|ing)?|succeed(?:ed)?|green)\b/gi;
function saidPass(text) {
  for (const m of String(text || '').matchAll(SAID_PASS)) if (!/未|没|不|失败|\bnot\b|n't|fail/i.test(m[0])) return true;
  return false;
}

// 工具记录里一步改到的文件（Codex 的补丁一步改好几个，写成「a.py（新建）、b.py」）
const stepFiles = (it) =>
  String(it.d || '')
    .split(/、|, /)
    .map((s) => s.replace(/[（(][^）)]*[）)]$/, '').trim())
    .filter(Boolean);

// ---------- 文件 ----------
const SRC = /\.(py|pyw|js|mjs|cjs|ts|tsx|jsx|vue|svelte|java|kt|kts|scala|c|h|cc|cpp|cxx|hpp|cs|fs|vb|go|rs|rb|php|swift|dart|lua|r|m|mm|pl|sh|ps1|psm1|bat|cmd|html?|css|scss|sass|less|sql|ipynb)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)test_[^/]*$|[._-](test|tests|spec)\.\w+$/i;
const TEXT = /\.(md|markdown|txt|rst|log|py|pyw|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|html?|css|scss|less|csv|tsv|ini|cfg|conf|toml|ya?ml|xml|bat|cmd|ps1|sh|java|kt|c|h|cc|cpp|hpp|cs|go|rs|rb|php|swift|dart|lua|sql|r|spec|nsi|iss)$/i;
const LOG = /\.log$|(^|\/)logs?\//i;
// 交付清单是给人看的文档（网页应用的 manifest.json 不算）
const MANIFEST = /(^|\/)[^/]*(deliver|manifest|交付|清单|release[-_ ]?notes|changelog)[^/]*\.(md|markdown|txt|rst|html?|pdf|docx?)$/i;
// 打包输出的文件夹：没写交付报告时，只在这些地方找 EXE（项目里自带的工具程序不算）
const OUT_DIR = /(^|\/)(dist|build|out|release|releases|bin|target)\//i;
const EXE_SKIP = new Set(['node_modules', 'venv', 'env', '__pycache__', 'site-packages', 'bower_components']);

const stat = (full) => {
  try {
    return fs.statSync(full);
  } catch {
    return null;
  }
};

// 项目里的 .exe：dist、build 这些快照不看的文件夹也要找，依赖和虚拟环境里的不算
function findExes(root, limit = 20) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= limit) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !EXE_SKIP.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && /\.exe$/i.test(e.name)) out.push({ full, rel: relOf(root, full) });
    }
  };
  walk(root, 0);
  return out;
}

// Windows 程序的文件开头是 MZ
function isPe(full) {
  try {
    const fd = fs.openSync(full, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === 'MZ';
  } catch {
    return false;
  }
}

// 文本文件里的乱码：一串串问号（中文用不支持的编码写出去就变成这样）、替换字符 �、不是 UTF-8（多半是 GBK）
function textIssues(full) {
  const st = stat(full);
  if (!st || !st.isFile() || st.size > 1024 * 1024) return null;
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return null;
  }
  if (buf.includes(0)) return null; // 二进制，或者 UTF-16
  let s;
  let utf8 = true;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    utf8 = false;
    s = buf.toString('latin1');
  }
  const runs = s.match(/\?{3,}/g) || [];
  return { utf8, qmarks: runs.length >= 2 || runs.some((r) => r.length >= 5) ? runs.length : 0, fffd: utf8 ? (s.match(/�/g) || []).length : 0 };
}

// 这次任务里项目文件夹的变化（相对路径）。有任务开始时的快照就精确对比；没有就把每一轮的文件卡片拼起来（每轮最多 60 个）。
// truncated：项目文件太多，快照只拍了一部分
function taskChanges(root, base, after, turns) {
  const truncated = !!((base && base.snap.truncated) || (after && after.truncated));
  if (base && after && !truncated) {
    const added = [];
    const modified = [];
    const deleted = [];
    for (const [p, a] of after.map) {
      const b = base.snap.map.get(p);
      if (!b) added.push(relOf(root, p));
      else if (b.m !== a.m || b.s !== a.s) modified.push(relOf(root, p));
    }
    for (const p of base.snap.map.keys()) if (!after.map.has(p)) deleted.push(relOf(root, p));
    return { exact: true, added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
  }
  const seen = new Map();
  for (const t of turns) {
    for (const f of t.files || []) {
      const prev = seen.get(f.path);
      if (f.change === 'delete') {
        if (prev === 'add') seen.delete(f.path);
        else seen.set(f.path, 'delete');
      } else if (!prev) seen.set(f.path, f.change);
      else if (prev === 'delete') seen.set(f.path, 'update'); // 删了又建：算改过
    }
  }
  const pick = (c) => [...seen].filter(([, v]) => v === c).map(([p]) => p).sort();
  return { exact: false, truncated: !!base && truncated, added: pick('add'), modified: pick('update'), deleted: pick('delete') };
}

// ---------- 逐项核对 ----------
function sourceItem(root, report, ch, turns) {
  const f = [];
  let fail = false;
  const listed = report ? splitPaths(report.fields.source) : [];
  if (listed.length) {
    const w = listed.map((p) => where(root, p));
    const by = (s) => w.filter((x) => x.state === s).map((x) => x.rel);
    if (by('ok').length) f.push({ c: 'src-ok', ...some(by('ok')) });
    if (by('missing').length) f.push({ c: 'src-missing', ...some(by('missing')) });
    if (by('outside').length) f.push({ c: 'src-outside', ...some(by('outside')) });
    if (by('missing').length || by('outside').length) fail = true;
  }
  const changed = [...ch.added, ...ch.modified].filter((p) => SRC.test(p));
  if (changed.length) f.push({ c: 'src-changed', ...some(changed) });
  else if (!listed.length) {
    f.push({ c: 'src-none' });
    fail = true;
  }
  const out = [...new Set(turns.flatMap((t) => t.outside || []))];
  if (out.length) {
    f.push({ c: 'wrote-outside', ...some(out) });
    fail = true;
  }
  return { s: fail ? 'fail' : 'pass', f };
}

function testsItem(report, steps, text) {
  const f = [];
  const runs = [];
  steps.forEach((it, i) => {
    if (it.k !== 'cmd') return;
    const tok = testTokens(it.d);
    if (tok.length) runs.push({ i, who: it.who, cmd: it.d, ok: it.s === 'ok' ? true : it.s === 'error' ? false : null, tok });
  });
  // 同一种测试只看最后一次
  const groups = new Map();
  for (const r of runs) groups.set(r.tok.join(' '), r);
  const last = [...groups.values()].sort((a, b) => a.i - b.i).slice(-3);
  for (const r of last) f.push({ c: 'test-ran', who: r.who, cmd: clip(r.cmd, 200), ok: r.ok });
  // 测试通过以后又改了代码（测试文件不算）：结果已经过时
  const okAt = Math.max(-1, ...last.filter((r) => r.ok).map((r) => r.i));
  let stale = null;
  if (okAt >= 0) {
    for (const it of steps.slice(okAt + 1)) {
      if ((it.k !== 'write' && it.k !== 'edit') || it.s === 'error' || it.out) continue;
      const file = stepFiles(it).find((p) => SRC.test(p) && !TEST_PATH.test(fwd(p)));
      if (file) stale = { c: 'test-stale', who: it.who, file };
    }
  }
  if (stale) f.push(stale);
  // 报告里写的测试命令，工具记录里一次也没运行过
  const said = report && report.fields.test;
  const ran = new Set(runs.flatMap((r) => r.tok));
  const claimed = said ? testTokens(said) : [];
  const missing = claimed.length && !claimed.some((t) => ran.has(t));
  if (missing) f.push({ c: 'test-claimed', cmd: clip(said, 200) });
  if (!runs.length) {
    f.push({ c: saidPass(text) ? 'test-said' : 'test-none' });
    if (!steps.some((it) => it.k === 'cmd')) f.push({ c: 'no-cmds' });
  }
  const pass = last.length && last.every((r) => r.ok === true) && !stale && !missing;
  return { s: pass ? 'pass' : 'fail', f };
}

function exeItem(root, report, ch, since) {
  const f = [];
  let fail = false;
  const exes = [];
  const listed = report ? splitPaths(report.fields.exe) : [];
  if (listed.length) {
    for (const p of listed) {
      const w = where(root, p);
      if (w.state !== 'ok') {
        f.push({ c: w.state === 'outside' ? 'exe-outside' : 'exe-missing', file: w.rel });
        fail = true;
      } else if (stat(w.full).isDirectory()) {
        // 写的是文件夹（dist/）：看里面的 EXE
        const inside = findExes(w.full, 5).map((e) => ({ full: e.full, rel: relOf(root, e.full) }));
        if (inside.length) exes.push(...inside);
        else {
          f.push({ c: 'exe-missing', file: w.rel + '/*.exe' });
          fail = true;
        }
      } else exes.push(w);
    }
  } else if (!(report && report.none.includes('exe'))) {
    const all = findExes(root);
    exes.push(...all.filter((e) => OUT_DIR.test(e.rel) && !/(^|\/)build\//i.test(e.rel)).slice(0, 5));
    if (!exes.length) exes.push(...all.filter((e) => OUT_DIR.test(e.rel)).slice(0, 5)); // 只在 build/ 里有
  }
  if (!exes.length && !f.length) return { s: 'na', f: [{ c: 'exe-na' }], exes };
  // 最后一次改代码（测试文件不算）的时间：EXE 比它早，说明改完代码没有重新打包
  let src = null;
  for (const p of [...ch.added, ...ch.modified]) {
    if (!SRC.test(p) || TEST_PATH.test(p)) continue;
    const st = stat(path.join(root, p));
    if (st && (!src || st.mtimeMs > src.m)) src = { rel: p, m: st.mtimeMs };
  }
  for (const e of exes) {
    const st = stat(e.full);
    if (!st.size) f.push({ c: 'exe-empty', file: e.rel });
    else if (/\.(exe|dll)$/i.test(e.full) && !isPe(e.full)) f.push({ c: 'exe-invalid', file: e.rel });
    else if (src && st.mtimeMs < src.m - 1000) f.push({ c: 'exe-older', file: e.rel, src: src.rel });
    else {
      f.push({ c: 'exe-ok', file: e.rel, size: st.size, at: Math.round(st.mtimeMs), fresh: st.mtimeMs >= since.at - 2000 });
      continue;
    }
    fail = true;
  }
  const deps = report ? splitPaths(report.fields.deps) : [];
  if (deps.length) {
    const w = deps.map((p) => where(root, p));
    const by = (s) => w.filter((x) => x.state === s).map((x) => x.rel);
    if (by('ok').length) f.push({ c: 'deps-ok', ...some(by('ok')) });
    if (by('missing').length) f.push({ c: 'deps-missing', ...some(by('missing')) });
    if (by('outside').length) f.push({ c: 'deps-outside', ...some(by('outside')) });
    if (by('missing').length || by('outside').length) fail = true;
  } else if (exes.length && report && !report.none.includes('deps')) f.push({ c: 'deps-none' });
  return { s: fail ? 'fail' : 'pass', f, exes };
}

// 启动测试：Nightshift 不替用户运行成员做的程序（可能有窗口、可能不安全），只列出依据，交给用户确认
function launchItem(report, exes, steps) {
  const f = [];
  const said = report && report.fields.launch;
  if (said) f.push({ c: 'launch-said', text: clip(said, 300) });
  const names = exes.map((e) => exeName(e.rel));
  const ran = names.length ? steps.filter((it) => it.k === 'cmd' && launches(it.d, names)) : [];
  for (const it of ran.slice(-2)) f.push({ c: 'launch-ran', who: it.who, cmd: clip(it.d, 200), ok: it.s === 'ok' ? true : it.s === 'error' ? false : null });
  if (!exes.length && !said) return { s: 'na', f: [{ c: 'launch-na' }] };
  if (!said) f.push({ c: 'launch-unsaid' });
  for (const e of exes.slice(0, 2)) f.push({ c: 'launch-try', file: e.rel });
  return { s: 'user', f };
}

// 日志和交付清单：报告里写了就看那几个文件，没写就在项目里找（这次生成的优先）。
// 有、但不是这次任务里生成的也算有，只是写明，给用户判断
function logsItem(root, report, ch, all, since) {
  const f = [];
  let fail = false;
  for (const [kind, AUTO] of [
    ['log', LOG],
    ['manifest', MANIFEST],
  ]) {
    const listed = report ? splitPaths(report.fields[kind]) : [];
    let fresh = [];
    let old = [];
    if (listed.length) {
      const w = listed.map((p) => where(root, p));
      for (const x of w.filter((x) => x.state === 'ok')) (stat(x.full).mtimeMs < since.at - 2000 ? old : fresh).push(x.rel);
      const bad = w.filter((x) => x.state !== 'ok');
      if (bad.length) {
        f.push({ c: `${kind}-missing`, ...some(bad.map((x) => x.rel)) });
        fail = true;
      }
    } else if (report && report.none.includes(kind)) {
      f.push({ c: `${kind}-said-none` });
      fail = true;
      continue;
    } else {
      fresh = [...ch.added, ...ch.modified].filter((p) => AUTO.test(p));
      if (!fresh.length) old = all.filter((p) => AUTO.test(p));
      if (!fresh.length && !old.length) {
        f.push({ c: `${kind}-none` });
        fail = true;
      }
    }
    if (fresh.length) f.push({ c: `${kind}-ok`, ...some(fresh) });
    if (old.length) f.push({ c: `${kind}-old`, ...some(old) });
  }
  return { s: fail ? 'fail' : 'pass', f };
}

function originalsItem(base, ch, steps) {
  const f = [];
  const rm = steps.filter((it) => it.k === 'cmd' && isRemove(it.d)).slice(-3);
  const rmFacts = rm.map((it) => ({ c: 'rm-cmd', who: it.who, cmd: clip(it.d, 200) }));
  if (!ch.exact) return { s: 'user', f: [{ c: ch.truncated ? 'orig-toomany' : 'orig-nobase' }, ...rmFacts] };
  if (ch.deleted.length) f.push({ c: 'orig-deleted', ...some(ch.deleted) });
  if (ch.modified.length) f.push({ c: 'orig-modified', ...some(ch.modified) });
  f.push(...rmFacts);
  if (!f.length) f.push({ c: 'orig-kept', n: base.snap.map.size });
  return { s: ch.deleted.length ? 'fail' : f[0].c === 'orig-kept' ? 'pass' : 'user', f };
}

function encodingItem(root, ch, extra) {
  const list = [...new Set([...ch.added, ...ch.modified, ...extra])].filter((p) => TEXT.test(p)).slice(0, 100);
  const f = [];
  let fail = false;
  let warn = false;
  let checked = 0;
  for (const p of list) {
    const r = textIssues(path.join(root, p));
    if (!r) continue;
    checked++;
    if (r.qmarks) f.push({ c: 'enc-qmarks', file: p, n: r.qmarks });
    else if (r.fffd) f.push({ c: 'enc-fffd', file: p, n: r.fffd });
    else if (!r.utf8) {
      f.push({ c: 'enc-gbk', file: p });
      warn = true;
      continue;
    } else continue;
    fail = true;
  }
  if (!checked) return { s: 'na', f: [{ c: 'enc-na' }] };
  if (!f.length) f.push({ c: 'enc-ok', n: checked });
  return { s: fail ? 'fail' : warn ? 'user' : 'pass', f: f.slice(0, 6) };
}

// root：项目文件夹；text：交付的那条发言；report：parseReport 的结果；
// turns：这次任务里成员的每一轮 { name, items, outside, files }（最后一个是交付的这一轮）；
// base：任务开始时的快照 { at, snap }（没有就是 null）；after：这一轮结束时的快照；since：任务从哪条消息、什么时候开始 { seq, at }
function check({ root, text, report, turns, base, after, since }) {
  const ch = taskChanges(root, base, after, turns);
  // 按先后顺序摊开这次任务里所有的工具记录，记下是谁做的
  const steps = turns.flatMap((t) => (t.items || []).filter((it) => it.k !== 'note').map((it) => ({ ...it, who: t.name })));
  const exe = exeItem(root, report, ch, since);
  // 报告里列出的日志、交付清单、依赖文件也查一下编码
  const listed = report ? [...splitPaths(report.fields.log), ...splitPaths(report.fields.manifest), ...splitPaths(report.fields.deps)] : [];
  const extra = listed.map((p) => where(root, p)).filter((w) => w.state === 'ok' && stat(w.full).isFile()).map((w) => w.rel);
  const all = after ? [...after.map.keys()].map((p) => relOf(root, p)).sort() : [...ch.added, ...ch.modified];
  const items = {
    source: sourceItem(root, report, ch, turns),
    tests: testsItem(report, steps, text),
    exe,
    launch: launchItem(report, exe.exes, steps),
    logs: logsItem(root, report, ch, all, since),
    originals: originalsItem(base, ch, steps),
    encoding: encodingItem(root, ch, extra),
  };
  return {
    at: Date.now(),
    since: since.seq,
    report: !!report,
    items: ITEMS.map((id) => ({ id, s: items[id].s, f: items[id].f })),
    cleanup: report ? splitPaths(report.fields.cleanup).slice(0, 20) : [],
  };
}

// ---------- 给成员看的（提示词保持中文） ----------
// 打开了验收清单的会话，每一轮都附在「轮到你」前面：中途打开的、有会话记忆的成员也能看到
function promptSection() {
  return [
    '## 交付验收清单（这个会话已打开）',
    '把成果交给用户验收时（说做完了、请用户验收），Nightshift 会按下面的清单核对实际的文件和工具记录，不只看你怎么说：',
    '1. 源代码已创建，都在项目文件夹里',
    '2. 自动化测试真的运行过并且通过（以工具记录里运行过的命令为准；没运行就写明没运行，不要说通过了）',
    '3. EXE 和它需要的依赖文件真的存在（改了代码要重新打包）',
    '4. 启动测试：Nightshift 不会替你运行程序。在本机启动过就写明怎么启动、看到了什么；不能自动验证的，写明请用户打开哪个文件验收',
    '5. 日志和交付清单已经写成项目里的文件',
    '6. 项目原有的文件没有被删除或覆盖',
    '7. 中文没有变成问号或乱码（文本文件用 UTF-8 保存）',
    '交付时在最终回复的最后附上交付报告，格式如下（每项一行；路径相对项目文件夹；没有的写「无」）：',
    '【交付报告】',
    '- 源代码：（源代码文件或文件夹）',
    '- 测试命令：（你实际运行过的测试命令）',
    '- 可执行文件：（例如 dist/app.exe）',
    '- 依赖文件：（程序运行需要的其他文件）',
    '- 启动测试：（怎么启动的、看到了什么；没法自动验证就写请用户打开哪个文件验收）',
    '- 日志：（日志文件）',
    '- 交付清单：（交付清单文件：交付了哪些文件、怎么使用）',
    '- 可以清理的中间产物：（等用户批准才能删）',
    '只是交接给队友、或者向用户提问时，不要写交付报告。',
    '不要删除任何文件。构建中间产物（build/、__pycache__/、*.spec 这类）要清理的话，列在「可以清理的中间产物」里，等用户批准后再删。',
  ].join('\n');
}

const TITLE = { source: '源代码', tests: '自动化测试', exe: 'EXE 和依赖文件', launch: '启动测试', logs: '日志和交付清单', originals: '原有文件', encoding: '文字编码' };
const MARK = { pass: '✓', fail: '✗', user: '?', na: '-' };
const list = (x) => x.files.join('、') + (x.n > x.files.length ? ` 等 ${x.n} 个` : '');
const ranText = (x) => `${x.who} 运行了 ${x.cmd}，${x.ok ? '成功' : x.ok === false ? '失败' : '没有拿到结果'}`;

function factText(x) {
  switch (x.c) {
    case 'src-ok': return `${list(x)} 在项目文件夹里`;
    case 'src-missing': return `报告里写的 ${list(x)} 不存在`;
    case 'src-outside': return `${list(x)} 不在项目文件夹里`;
    case 'src-changed': return `这次改动了 ${list(x)}`;
    case 'src-none': return '这次没有新建或修改源代码，报告里也没有列出';
    case 'wrote-outside': return `有文件写到了项目文件夹以外：${list(x)}`;
    case 'test-ran': return ranText(x);
    case 'test-stale': return `测试之后 ${x.who} 又改了 ${x.file}，需要重新运行测试`;
    case 'test-claimed': return `报告里写的 ${x.cmd} 没有在工具记录里出现`;
    case 'test-said': return '成员说测试通过了，但工具记录里没有运行测试的命令';
    case 'test-none': return '工具记录里没有运行测试的命令';
    case 'no-cmds': return '这次没有成员运行过任何命令';
    case 'exe-ok': return `${x.file} 存在${x.fresh ? '（这次打包的）' : ''}`;
    case 'exe-missing': return `${x.file} 不存在`;
    case 'exe-outside': return `${x.file} 不在项目文件夹里`;
    case 'exe-empty': return `${x.file} 是空文件`;
    case 'exe-invalid': return `${x.file} 不是有效的 Windows 程序`;
    case 'exe-older': return `${x.file} 比最后一次改代码（${x.src}）还早，没有重新打包`;
    case 'exe-na': return '这次交付没有可执行文件';
    case 'deps-ok': return `依赖文件 ${list(x)} 都在`;
    case 'deps-missing': return `依赖文件 ${list(x)} 不存在`;
    case 'deps-outside': return `依赖文件 ${list(x)} 不在项目文件夹里`;
    case 'deps-none': return '报告里没有列出依赖文件';
    case 'launch-said': return `成员写的：${x.text}`;
    case 'launch-ran': return ranText(x);
    case 'launch-unsaid': return '成员没有写启动测试的情况';
    case 'launch-try': return `等用户打开 ${x.file} 验收`;
    case 'launch-na': return '没有找到要启动的程序';
    case 'log-ok': return `日志 ${list(x)}`;
    case 'log-old': return `日志 ${list(x)} 不是这次生成的`;
    case 'log-missing': return `日志 ${list(x)} 不存在`;
    case 'log-said-none': return '成员说没有日志';
    case 'log-none': return '没有找到日志';
    case 'manifest-ok': return `交付清单 ${list(x)}`;
    case 'manifest-old': return `交付清单 ${list(x)} 不是这次生成的`;
    case 'manifest-missing': return `交付清单 ${list(x)} 不存在`;
    case 'manifest-said-none': return '成员说没有交付清单';
    case 'manifest-none': return '没有找到交付清单';
    case 'orig-kept': return `开始时的 ${x.n} 个文件都在，也没有被修改`;
    case 'orig-deleted': return `删除了原有的 ${list(x)}`;
    case 'orig-modified': return `修改了原有的 ${list(x)}`;
    case 'orig-nobase': return '没有任务开始时的文件记录，没法核对';
    case 'orig-toomany': return '项目文件太多，没法逐个核对';
    case 'rm-cmd': return `${x.who} 运行过删除文件的命令：${x.cmd}`;
    case 'enc-qmarks': return `${x.file} 里有一串串问号，中文可能被写坏了`;
    case 'enc-fffd': return `${x.file} 里有乱码字符`;
    case 'enc-gbk': return `${x.file} 不是 UTF-8 编码`;
    case 'enc-ok': return `检查了 ${x.n} 个文本文件，没有发现乱码`;
    case 'enc-na': return '这次没有改动文本文件';
    default: return '';
  }
}

// 附在发言后面给下一位成员看的核对结果。用户点过「通过 / 不通过」的也写上
function promptText(acc) {
  if (!acc || !Array.isArray(acc.items)) return '';
  const lines = acc.items.map((it) => {
    const who = it.u ? `（用户确认：${it.u === 'pass' ? '通过' : '不通过'}）` : it.s === 'user' ? '（等用户确认）' : '';
    return `${MARK[it.s] || '?'} ${TITLE[it.id] || it.id}：${(it.f || []).map(factText).filter(Boolean).join('；')}${who}`;
  });
  return `（交付验收清单，系统按实际文件和工具记录核对${acc.report ? '' : '，成员没有写交付报告'}：\n${lines.join('\n')}）`;
}

module.exports = { ITEMS, parseReport, splitPaths, isDelivery, claimsDone, testTokens, isRemove, textIssues, check, promptSection, promptText };
