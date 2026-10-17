'use strict';
// 重新生成 README 的截图（docs/screenshots/<语言>/）：
//   npm run screenshots                    全部 15 张：三种语言各一套 main-dark、main-light、preview、member、usage
//   npm run screenshots -- usage en        只生成其中几张：写图名（可以只写开头，比如 main）或语言，两样都写时取交集
//   npm run screenshots -- --out 文件夹    存到别的文件夹，不覆盖 docs/screenshots（先看看效果）
// 每张图启动一次桌面版：演示数据（seed.js）加替身命令行工具（fake-cli.js），按 shots.js 里的脚本点开对应的界面后截图，
// 最后用 frame.js 加上窗口的圆角、细边框和阴影。数据、设置和各工具的配置都换成临时文件夹里的，不碰真实的；不会调用任何 AI。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { seed } = require('./seed');
const { captureJs } = require('./shots');
const CONTENT = require('./content');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = require('electron'); // 在 Node 里 require('electron') 得到的是 Electron 程序的路径
const WORK = path.join(os.tmpdir(), 'nightshift-screenshots');
const SCALE = 1.5; // 按 150% 缩放截图：1280 宽的窗口存成 1920 像素
const LANGS = ['zh-Hans', 'en', 'zh-Hant'];
// 每种图：在界面里执行哪段脚本（shots.js）、外观、窗口大小；live = DeepSeek 截图时才开始跑，done = DeepSeek 已经检查完
const KINDS = {
  'main-dark': { shot: 'main', theme: 'dark', variant: 'live', size: [1280, 900] },
  'main-light': { shot: 'main', theme: 'light', variant: 'live', size: [1280, 900] },
  preview: { shot: 'preview', theme: 'dark', variant: 'done', size: [1440, 900] },
  member: { shot: 'member', theme: 'dark', variant: 'done', size: [1280, 1000] },
  usage: { shot: 'usage', theme: 'dark', variant: 'done', size: [1280, 1000] },
};
const PLAN = LANGS.flatMap((lang) => Object.entries(KINDS).map(([kind, k]) => ({ name: `${kind}-${lang}`, kind, lang, ...k })));
const DICT = { en: require('../../public/i18n/en.json'), 'zh-Hant': require('../../public/i18n/zh-Hant.json') };
const tr = (lang, s) => (DICT[lang] && DICT[lang][s]) || s;

function usageError(msg) {
  console.log(msg);
  console.log(`\n用法：npm run screenshots [-- 图名或语言…] [--out 文件夹]\n图名：${Object.keys(KINDS).join('、')}（后面可以接 -语言，比如 usage-en）\n语言：${LANGS.join('、')}`);
  process.exit(1);
}

function parseArgs(argv) {
  let out = path.join(ROOT, 'docs', 'screenshots');
  const langs = [];
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      if (!argv[i + 1]) usageError('--out 后面要写文件夹');
      out = path.resolve(process.env.INIT_CWD || process.cwd(), argv[++i]); // npm run 会切到仓库根目录，相对路径按运行命令时的位置算
    } else if (LANGS.includes(a)) langs.push(a);
    else if (PLAN.some((s) => s.name.startsWith(a))) names.push(a);
    else usageError(`没有叫「${a}」的图`);
  }
  const list = PLAN.filter((s) => (!langs.length || langs.includes(s.lang)) && (!names.length || names.some((n) => s.name.startsWith(n))));
  if (!list.length) usageError('没有符合条件的图');
  return { out, list };
}

// 替身命令行工具放在 PATH 最前面。Nightshift 会读 .cmd 里写的入口文件，用 node 直接运行它（见 server/proc.js），
// 所以每个工具要有自己的入口：先设好是哪个工具，再加载 fake-cli.js
function makeFakeTools(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of ['claude', 'codex', 'opencode', 'gemini', 'grok', 'pi', 'hermes', 'dsh']) {
    fs.writeFileSync(path.join(dir, `fake-${t}.js`), `process.env.FAKE_TOOL = '${t}';\nrequire(${JSON.stringify(path.join(__dirname, 'fake-cli.js'))});\n`);
    fs.writeFileSync(path.join(dir, `${t}.cmd`), `@node "%~dp0\\fake-${t}.js" %*\r\n`);
  }
}

// 替身 dsh 被叫去干活时输出的事件：DeepSeek 写测试、跑测试，最后停在「运行 npx playwright test」这一步
function dshScript(lang) {
  const b = CONTENT[lang].build;
  const f = path.join(WORK, `dsh-${lang}.json`);
  fs.writeFileSync(
    f,
    JSON.stringify({
      hold: 60000,
      events: [
        { type: 'status', phase: 'turn_start', delay: 300 },
        { type: 'status', phase: 'step_start' },
        { type: 'text', text: b.dsNote1, delay: 300 },
        { type: 'tool_call', callId: 'c1', tool: 'write', input: { path: 'tests/app.test.js' } },
        { type: 'tool_result', callId: 'c1', status: 'ok', result: '' },
        { type: 'tool_call', callId: 'c2', tool: 'bash', input: { command: 'node --test tests/' } },
        { type: 'tool_result', callId: 'c2', status: 'ok', result: 'pass 12' },
        { type: 'tool_call', callId: 'c3', tool: 'read', input: { path: 'src/app.js' } },
        { type: 'tool_result', callId: 'c3', status: 'ok', result: '' },
        { type: 'text', text: b.dsNote2, delay: 300 },
        { type: 'tool_call', callId: 'c4', tool: 'bash', input: { command: 'npx playwright test drag.spec.js' } },
      ],
    })
  );
  return f;
}

// 截图用的环境：用户文件夹（各工具的配置在这里面）换成临时文件夹里的，PATH 最前面放替身工具
function shotEnv(extra = {}) {
  const env = { ...process.env };
  // 在 Claude Code、Codex 里运行时它们注入的变量、各工具自己的配置位置都不带进去；ELECTRON_RUN_AS_NODE 会让 Electron 变成 Node
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC|CODEX_|ELECTRON_RUN_AS_NODE$|(GROK|DSH|HERMES)_HOME$)/i.test(k)) delete env[k];
  const home = path.join(WORK, 'home');
  const vars = {
    PATH: path.join(WORK, 'bin') + path.delimiter + process.env.PATH,
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ...extra,
  };
  // Windows 的环境变量不分大小写（Path 和 PATH 是同一个），先把原来的删掉
  for (const [k, v] of Object.entries(vars)) {
    for (const x of Object.keys(env)) if (x.toUpperCase() === k.toUpperCase()) delete env[x];
    env[k] = v;
  }
  return env;
}

// 每次启动用一个空闲的端口，不用默认的 37210，免得和正在用的 Nightshift 撞上
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 拍一张原图：写演示数据，用 electron/main.js 里的 AGENT_CHAT_CAPTURE* 启动桌面版，截完自己退出
async function capture(shot) {
  const data = path.join(WORK, 'data', shot.name);
  seed({ lang: shot.lang, variant: shot.variant, theme: shot.theme, dataDir: data, wsRoot: path.join(WORK, 'ws', shot.lang) });
  // Electron 的配置文件夹每次都换新的，窗口大小写在 window.json 里
  const ud = path.join(WORK, 'ud', shot.name);
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'window.json'), JSON.stringify({ x: 40, y: 40, width: shot.size[0], height: shot.size[1], maximized: false }));
  const png = path.join(WORK, 'raw', shot.name + '.png');
  const info = path.join(WORK, 'raw', shot.name + '.json');
  for (const f of [png, info]) fs.rmSync(f, { force: true });
  const env = shotEnv({
    FAKE_DSH_SCRIPT: dshScript(shot.lang),
    AGENT_CHAT_USER_DATA: ud,
    AGENT_CHAT_DATA: data,
    AGENT_CHAT_PORT: String(await freePort()),
    AGENT_CHAT_THEME: shot.theme,
    AGENT_CHAT_CAPTURE: png,
    AGENT_CHAT_CAPTURE_DELAY: '2500',
    AGENT_CHAT_CAPTURE_EXIT: '1',
    AGENT_CHAT_CAPTURE_JS: captureJs(shot.shot, { usage: tr(shot.lang, '用量'), handle: CONTENT[shot.lang].handle }),
  });
  const log = await new Promise((resolve) => {
    const child = spawn(ELECTRON, [ROOT, `--force-device-scale-factor=${SCALE}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (text += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (text += d));
    const timer = setTimeout(() => {
      text += '\n两分钟还没截完，停掉了';
      child.kill();
    }, 120000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
  // 界面脚本的返回值（比如要裁剪的区域）存在原图旁边；脚本出错时不要这张图
  const line = log.split(/\r?\n/).find((l) => l.startsWith('[capture-js] '));
  let result;
  try {
    result = line ? JSON.parse(line.slice('[capture-js] '.length)) : { error: '桌面版没有执行截图脚本' };
  } catch {
    result = { error: '看不懂截图脚本的返回值：' + line };
  }
  if (!result.error && !fs.existsSync(png)) result = { error: '没有存下截图' };
  if (result.error) return { error: result.error, log };
  fs.writeFileSync(info, JSON.stringify({ lang: shot.lang, kind: shot.kind, theme: shot.theme, scale: SCALE, ...result }));
  return {};
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('README 的截图按 Windows 的窗口样式画，要在 Windows 上生成');
    process.exit(1);
  }
  const { out, list } = parseArgs(process.argv.slice(2));
  for (const d of ['raw', 'home/AppData/Roaming', 'home/AppData/Local']) fs.mkdirSync(path.join(WORK, d), { recursive: true });
  makeFakeTools(path.join(WORK, 'bin'));
  console.log(`要生成 ${list.length} 张图，临时文件放在 ${WORK}`);
  const ok = [];
  for (const shot of list) {
    const r = await capture(shot);
    if (r.error) {
      console.log(`✗ ${shot.name}：${r.error}`);
      console.log('  ' + r.log.trim().split(/\r?\n/).slice(-15).join('\n  '));
    } else {
      ok.push(shot.name);
      console.log(`✓ ${shot.name}`);
    }
  }
  let framed = false;
  if (ok.length) {
    const r = spawnSync(ELECTRON, [path.join(__dirname, 'frame.js'), WORK, out, ...ok], { env: shotEnv(), encoding: 'utf8' });
    process.stdout.write((r.stdout || '').trimStart()); // Electron 在 Windows 上会先输出一个空行
    framed = r.status === 0;
    if (!framed) process.stdout.write(r.stderr || (r.error ? String(r.error) + '\n' : ''));
  }
  const failed = list.length - ok.length;
  if (failed || !framed) {
    console.log(`\n${failed ? `${failed} 张没截成，见上面的报错` : '加框失败，见上面的报错'}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${ok.length} 张图已存到 ${out}`);
  }
})();
