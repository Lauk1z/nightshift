'use strict';
(() => {
  // 界面文字的翻译（见 i18n.js）。源文是简体中文；这里叫 tr，因为很多地方已经有局部变量叫 t
  const tr = window.I18N.t;

  // ---------- 基础 ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.Markdown.escape;
  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const local = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  const PALETTE = ['#3F6AD8', '#13897A', '#B4610C', '#B0357A', '#5B47C7', '#2F8A3B', '#0E7490', '#9A3412'];
  const USER_ALIASES = ['用户', 'user', 'human', '人类'];
  const ALL_ALIASES = ['所有人', '全体成员', '全体', 'all', 'everyone'];
  const NAMES = { codex: 'GPT', claude: 'Claude', opencode: 'OpenCode', gemini: 'Gemini', grok: 'Grok', pi: 'Pi', hermes: 'Hermes', dsh: 'DeepSeek', openai: tr('助手') };
  // 能接入的命令行 AI 工具（顺序就是界面上列出来的顺序）
  const CLI_TOOLS = ['claude', 'codex', 'opencode', 'gemini', 'grok', 'pi', 'hermes', 'dsh'];

  const ADAPTERS = {
    claude: {
      label: 'Claude Code',
      what: tr('Anthropic 的编程助手，擅长写代码、改代码'),
      modelHint: tr('列表来自 Claude Code 的设置（~/.claude/settings.json）。别名会按你的设置指向实际的模型。'),
    },
    codex: {
      label: 'Codex',
      what: tr('OpenAI 的编程助手，用你的 ChatGPT 账号'),
      modelHint: tr('列表来自 Codex 的模型目录，默认模型在 ~/.codex/config.toml 里设置。'),
    },
    opencode: {
      label: 'OpenCode',
      what: tr('开源编程助手，可接 DeepSeek、Kimi、Ollama 等'),
      modelHint: tr('列表来自 OpenCode，按提供商分组。要设置思考强度，需要先选一个具体的模型。'),
    },
    gemini: {
      label: 'Gemini CLI',
      install: { win: 'npm install -g @google/gemini-cli', other: 'npm install -g @google/gemini-cli' },
      what: tr('Google 的编程助手，用 Google 账号或 Gemini API Key'),
      modelHint: tr('auto 会按任务在 Pro 和 Flash 之间自动选；要用具体的模型，选「自己输入……」填模型名。'),
    },
    grok: {
      label: 'Grok Build',
      install: { win: 'irm https://x.ai/cli/install.ps1 | iex', other: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
      what: tr('xAI 的编程助手，用 SuperGrok 账号或 xAI API Key'),
      modelHint: tr('列表来自 grok models。不同模型支持的思考强度不一样，选了不支持的档位会报错。'),
    },
    pi: {
      label: 'pi',
      install: { win: 'npm install -g @earendil-works/pi-coding-agent', other: 'npm install -g @earendil-works/pi-coding-agent' },
      what: tr('轻量的开源编程助手，可接 Anthropic、OpenAI、Google 等几十家模型'),
      modelHint: tr('列表来自 pi --list-models，只列出已经登录或配好 Key 的提供商，按提供商分组。'),
    },
    hermes: {
      label: 'Hermes Agent',
      install: {
        win: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
        other: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
      },
      what: tr('Nous Research 的开源智能体，会自己积累技能，可接 OpenRouter 等'),
      modelHint: tr('Hermes 的模型在它自己的设置里选（命令行里运行 hermes model）。这里可以用默认模型，或者选「自己输入……」填模型名。'),
    },
    dsh: {
      label: 'DeepSeek Harness',
      install: { win: 'npm install -g @deepseek-ai/dsh', other: 'npm install -g @deepseek-ai/dsh' },
      what: tr('DeepSeek 官方的开源智能体（dsh），用 DeepSeek API Key'),
      modelHint: tr('列表是 DeepSeek Harness 自带的模型。在 dsh 里接了别的提供商的话，选「自己输入……」写成「提供商/模型」。改了模型、思考强度或权限，下一轮会换一个新会话。'),
    },
    openai: {
      label: tr('API 模型'),
      what: tr('任何兼容 OpenAI 接口的模型：DeepSeek、通义千问、Kimi……'),
      modelHint: tr('必填，例如 deepseek-chat、qwen-plus。'),
    },
  };

  const PERMS = {
    readonly: {
      label: tr('只读'),
      desc: {
        claude: tr('只能阅读项目文件，不能修改'),
        codex: tr('只读沙箱：能看文件、跑只读命令，不能改动'),
        opencode: tr('用 OpenCode 的 plan 模式，只分析不修改'),
        gemini: tr('需要确认的工具一律不运行：只能看，不能改文件或运行命令'),
        grok: tr('只放行只读的工具和命令（dontAsk 模式）'),
        pi: tr('只给它 read、grep、find、ls 这几个只读工具'),
        hermes: tr('去掉命令行工具，并要求它不改文件（Hermes 没有只读的文件工具，无法完全限制）'),
        dsh: tr('只读沙箱：能看文件、运行只读命令，不能改动'),
        openai: tr('只能列出和读取项目文件'),
      },
    },
    edit: {
      label: tr('可改文件'),
      desc: {
        claude: tr('能直接修改项目文件，但不能运行命令'),
        codex: tr('能修改项目文件，命令在沙箱里运行'),
        opencode: tr('按 OpenCode 自己的权限设置（默认能改文件和运行命令）'),
        gemini: tr('自动批准改文件，不能运行命令'),
        grok: tr('自动批准改文件；需要确认的命令不会运行'),
        pi: tr('能读写文件，不能运行命令'),
        hermes: tr('能改文件、运行普通命令；危险的命令没人批准就不运行'),
        dsh: tr('能改项目文件夹里的文件，命令在沙箱里运行；需要批准的操作不会执行'),
        openai: tr('能读写项目文件，不能运行命令'),
      },
    },
    full: {
      label: tr('完全权限'),
      desc: {
        claude: tr('能改文件、运行任何命令，不再询问'),
        codex: tr('关闭沙箱，能运行任何命令'),
        opencode: tr('自动批准所有操作'),
        gemini: tr('自动批准所有操作（yolo 模式）'),
        grok: tr('自动批准所有操作（always-approve）'),
        pi: tr('用 pi 的默认工具，能运行任何命令'),
        hermes: tr('危险的命令也直接运行，不再拦截（--yolo）'),
        dsh: tr('关闭沙箱，能运行任何命令（danger-full-access）'),
        openai: tr('能读写文件，还能在项目文件夹里运行命令'),
      },
    },
  };

  // 思考强度：各家工具的取值不完全一样，这里只负责中文名称和说明，可选的档位由服务端按模型给出
  const EFFORT_LABEL = { none: tr('思考强度::关闭'), minimal: tr('最低'), low: tr('低'), medium: tr('中'), high: tr('高'), xhigh: tr('超高'), max: tr('最大'), ultra: tr('极限') };
  const EFFORT_HINT = {
    none: tr('不进行额外思考，直接回答，最快。'),
    minimal: tr('几乎不思考，速度最快。'),
    low: tr('思考较少，速度快，适合简单、明确的任务。'),
    medium: tr('速度和思考深度比较平衡。'),
    high: tr('思考更深入，适合复杂的问题。'),
    xhigh: tr('思考非常深入，速度更慢。'),
    max: tr('最深入的思考，最慢，也最耗用量。'),
    ultra: tr('最深入的思考，还会自动把任务分给子代理去做。'),
  };
  const effortName = (v) => EFFORT_LABEL[v] || v;

  // 桌面版（exe）里由 electron/preload.js 提供；浏览器里打开时没有
  const desktop = window.desktop || null;

  const API_PRESETS = [
    ['DeepSeek', 'https://api.deepseek.com/v1'],
    [tr('通义千问（阿里云百炼）'), 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    [tr('Kimi（月之暗面）'), 'https://api.moonshot.cn/v1'],
    [tr('智谱 GLM'), 'https://open.bigmodel.cn/api/paas/v4'],
    ['OpenAI', 'https://api.openai.com/v1'],
    ['Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['OpenRouter', 'https://openrouter.ai/api/v1'],
    [tr('Ollama（本机）'), 'http://127.0.0.1:11434/v1'],
  ];
  // 接口地址对得上哪个常用服务（末尾的 / 和 /chat/completions 不算）：下拉框就显示那个服务
  const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').toLowerCase();
  const presetFor = (u) => (API_PRESETS.find(([, url]) => normUrl(u) && normUrl(url) === normUrl(u)) || [])[1] || '';

  const I = (d, cls = '') =>
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${d}</svg>`;
  const ICONS = {
    read: I('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/><path d="M6 8.2h4.5M6 10.8h4.5"/>'),
    write: I('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/><path d="M8.2 7.4v4.8M5.8 9.8h4.8"/>'),
    edit: I('<path d="M3 13l.8-3.2 7-7a1.4 1.4 0 012 2l-7 7z"/><path d="M9.6 4l2.4 2.4"/>'),
    cmd: I('<path d="M2.5 4.2l3.6 3.6-3.6 3.6"/><path d="M7.8 12.2h5.7"/>'),
    search: I('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>'),
    web: I('<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z"/>'),
    agent: I('<circle cx="4" cy="3.8" r="1.6"/><circle cx="4" cy="12.2" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.4v5.2M5.4 4.6c3 .4 4.6 1.4 5.2 2.6"/>'),
    todo: I('<path d="M2.5 4l1.3 1.3L6 3"/><path d="M8 4.2h5.5M2.5 10l1.3 1.3L6 9"/><path d="M8 10.2h5.5"/>'),
    note: I('<path d="M2.5 3.5h11v7h-6.2L4.5 13v-2.5h-2z"/>'),
    other: I('<circle cx="8" cy="8" r="2.2"/>'),
    plus: I('<path d="M8 3v10M3 8h10"/>'),
    chev: I('<path d="M6 3.5L10.5 8 6 12.5"/>', 'chev'),
    folder: I('<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6h5.3c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>'),
    gear: I('<circle cx="8" cy="8" r="2.3"/><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8L3.6 3.6"/>'),
    menu: I('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>'),
    up: I('<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>'),
    chevDown: I('<path d="M4.5 6.2L8 9.7l3.5-3.5"/>', 'chev-down'),
    eye: I('<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/>'),
    open: I('<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/><path d="M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3"/>'),
    apps: I('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>'),
    copy: I('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2"/>'),
    // 标题栏和右侧面板
    sidebar: I('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6.2 2.5v11"/>'),
    panelRight: I('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M9.8 2.5v11"/>'),
    back: I('<path d="M13 8H3.5M7.5 4L3.5 8l4 4"/>'),
    forward: I('<path d="M3 8h9.5M8.5 4l4 4-4 4"/>'),
    more: I('<circle cx="8" cy="3.6" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="8" cy="12.4" r=".6"/>', 'dots'),
    chat: I('<path d="M2.5 3.2h11v7.6H8.3l-3.3 2.6v-2.6H2.5z"/>'),
    terminal: I('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.8"/><path d="M4.6 6.2l2 1.8-2 1.8M8.2 10.2h3.2"/>'),
    close: I('<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
    refresh: I('<path d="M13.2 8.2A5.2 5.2 0 1 1 11.6 4.3"/><path d="M12.2 1.9v2.8H9.4"/>'),
    trash: I('<path d="M2.8 4.4h10.4M6.3 4.4V2.8h3.4v1.6M4.3 4.4l.7 9h6l.7-9"/>'),
    eraser: I('<path d="M6.5 13.2h7"/><path d="M2.6 10.1l6.6-6.6a1.4 1.4 0 012 0l2 2a1.4 1.4 0 010 2l-5.3 5.4H5.6z"/><path d="M6.3 6.4l4 4"/>'),
    home: I('<path d="M2.5 7.4L8 2.8l5.5 4.6"/><path d="M4 6.3v7h3v-3.6h2v3.6h3v-7"/>'),
    code: I('<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>'),
    quote: I('<path d="M3 4.5h10M3 8h10M3 11.5h6"/>'),
    check: I('<path d="M3.5 8.5l3 3 6-7"/>'),
    info: I('<circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.6M8 5.1v.1"/>'),
    plusCircle: I('<circle cx="8" cy="8" r="6.2"/><path d="M8 5.2v5.6M5.2 8h5.6"/>'),
    arrowUp: I('<path d="M8 13V3.4M3.8 7.4L8 3.2l4.2 4.2"/>', 'thick'),
    arrowDown: I('<path d="M8 3v9.6M3.8 8.6L8 12.8l4.2-4.2"/>'),
    stopSq: I('<rect x="4.5" y="4.5" width="7" height="7" rx="1.4" fill="currentColor" stroke="none"/>'),
    gauge: I('<path d="M2.6 11.6a5.6 5.6 0 1110.8 0"/><path d="M8 9.6l2.6-3.2"/><circle cx="8" cy="9.8" r=".9"/>'),
    pin: I('<path d="M5.5 2.2h5M6.5 2.2v4L4.2 9.4h7.6L9.5 6.2v-4M8 9.4v4.4"/>'),
    help: I('<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 113 1.4c-.6.4-1.3.8-1.3 1.6M8 11.1v.1"/>'),
  };
  // 名字和标志跟着深浅色换：深色叫 Nightshift（夜班，月亮里亮着 >_），浅色叫 Dayshift（日班，太阳里写着 >_）。
  // 和 scripts/make-icon.js 画的应用图标是同一个图案。两个标志都放进页面，样式表按当前外观只显示一个
  const BRAND = { night: 'Nightshift', day: 'Dayshift' };
  const isDark = () => {
    const theme = document.documentElement.dataset.theme;
    return theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const appName = () => (isDark() ? BRAND.night : BRAND.day);
  const MARK_NIGHT = `<svg class="bm-night" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="14" fill="#12183A"/><circle cx="27" cy="34" r="18" fill="#F3E9CF"/><circle cx="37" cy="27" r="15" fill="#12183A"/><path d="M35 22l6 5.5-6 5.5M44 33h6" fill="none" stroke="#FFB547" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="51" cy="13" r="1.6" fill="#F3E9CF"/><circle cx="56" cy="20" r="1.2" fill="#F3E9CF"/></svg>`;
  const MARK_DAY = `<svg class="bm-day" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="14" fill="#CFE6FF"/><path d="M53 32h4M46.85 46.85l2.83 2.83M32 53v4M17.15 46.85l-2.83 2.83M11 32H7M17.15 17.15l-2.83-2.83M32 11V7M46.85 17.15l2.83-2.83" stroke="#FFB23A" stroke-width="3.4" stroke-linecap="round"/><circle cx="32" cy="32" r="16" fill="#FFB23A"/><path d="M23.5 25l7 6.5-7 6.5M33.5 38h7" fill="none" stroke="#24304F" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const brandMark = () => `<span class="brand-mark">${MARK_NIGHT}${MARK_DAY}</span>`;
  // 浏览器版标签页上的小图标也跟着换
  const faviconOf = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/ class="bm-\w+"/, '').replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  // 右侧面板的四个功能（标题栏右边的图标）
  const PANEL_TABS = [
    ['files', tr('文件'), 'folder'],
    ['side', tr('侧边对话'), 'chat'],
    ['term', tr('终端'), 'terminal'],
    ['browser', tr('浏览器'), 'web'],
  ];

  // 文件类型：显示名、图标、能不能在 Agent Chat 里预览
  const FILE_TYPES = [
    [/^(html?|xhtml)$/, tr('网页'), 'web', 'html'],
    [/^(md|markdown|mdx)$/, tr('Markdown 文档'), 'doc', 'md'],
    [/^(txt|log)$/, tr('文本文件'), 'doc', 'text'],
    [/^(docx?|rtf|odt)$/, tr('Word 文档'), 'word', ''],
    [/^(xlsx?|xlsm|ods)$/, tr('Excel 表格'), 'sheet', ''],
    [/^(csv|tsv)$/, tr('表格数据'), 'sheet', 'text'],
    [/^(pptx?|odp|key)$/, tr('演示文稿'), 'slide', ''],
    [/^pdf$/, tr('PDF 文档'), 'pdf', ''],
    [/^(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/, tr('图片'), 'image', 'image'],
    [/^(mp4|webm|mov|mkv|avi)$/, tr('视频'), 'media', ''],
    [/^(mp3|wav|ogg|flac|m4a)$/, tr('音频'), 'media', ''],
    [/^(zip|7z|rar|tar|gz|tgz|bz2)$/, tr('压缩包'), 'archive', ''],
    [/^(bat|cmd|ps1|sh|vbs)$/, tr('脚本'), 'exec', 'text'],
    [/^(exe|msi|com|lnk|scr|appx|msix)$/, tr('可执行程序'), 'exec', ''],
    [/^(json|jsonc|ya?ml|toml|ini|cfg|conf|env|xml|lock|properties|gitignore)$/, tr('配置文件'), 'code', 'text'],
    [/^(js|mjs|cjs|ts|tsx|jsx|vue|svelte|css|scss|sass|less|py|java|kt|c|h|cc|cpp|hpp|cs|go|rs|rb|php|swift|dart|lua|sql|r|m|ipynb)$/, tr('代码'), 'code', 'text'],
  ];
  const FILE_ICON = {
    web: ICONS.web,
    doc: ICONS.read,
    word: I('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/><path d="M5.6 8l.9 3.6L8 8.8l1.5 2.8.9-3.6"/>'),
    sheet: I('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M2.5 10h11M6.5 2.5v11"/>'),
    slide: I('<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M8 11v2.5M5.5 13.5h5"/>'),
    pdf: I('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/><path d="M6 9.4h4M6 11.6h2.6"/>'),
    image: I('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.5" r="1.3"/><path d="M2.5 12l3.8-3.8 2.7 2.7 2-2 2.5 2.5"/>'),
    media: I('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6.6 5.8v4.4L10.2 8z"/>'),
    archive: I('<rect x="2.5" y="3.5" width="11" height="10" rx="1.2"/><path d="M2.5 6.5h11M7 9h2"/>'),
    exec: ICONS.cmd,
    code: I('<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>'),
    other: ICONS.read,
  };
  function fileType(p) {
    const base = String(p).split(/[\\/]/).pop();
    const ext = (base.match(/\.([^.]+)$/) || [])[1] || (base.startsWith('.') ? base.slice(1) : '');
    const e = ext.toLowerCase();
    for (const [re, label, kind, preview] of FILE_TYPES) {
      if (re.test(e)) return { ext: e, label: kind === 'code' && label === tr('代码') ? tr('{ext} 代码', { ext: e.toUpperCase() }) : label, kind, preview };
    }
    return { ext: e, label: e ? tr('{ext} 文件', { ext: e.toUpperCase() }) : tr('文件类型::文件'), kind: 'other', preview: '' };
  }

  const S = {
    env: null,
    projects: [], // 项目（一个文件夹）和它里面的会话
    rooms: [], // 所有会话，按最近动过排
    projectId: null, // 当前项目（会话都删完了也还停在这个项目里）
    roomId: null, // 当前会话
    room: null,
    messages: [],
    state: null,
    progress: null,
    drafts: {},
    liveKey: null,
    open: new Set(),
    loading: null,
    catalogs: {}, // 每种接入方式可选的模型和思考强度
    busyRooms: {},
    notifiedAt: {},
    nav: { list: [], i: -1 }, // 标题栏的后退 / 前进：打开过的项目
  };
  let panel = null; // 右侧面板（panel.js），启动时创建
  let account = null; // 左下角的账户区（account.js）

  // ---------- 小工具 ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-agent-chat': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new Error(data.error || tr('请求失败（{status}）', { status: res.status }));
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast' + (isError ? ' error' : '')), isError ? 5000 : 2400);
  }

  const pad = (n) => String(n).padStart(2, '0');
  // 日期按界面语言写（10月14日 / Oct 14）
  const LOCALE = () => ({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en-US' })[window.I18N.lang] || 'zh-CN';
  function fmtTime(ts) {
    const d = new Date(ts);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString(LOCALE(), { month: 'short', day: 'numeric' })} ${hm}`;
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return tr('{n} 秒', { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return tr('{m} 分 {s} 秒', { m, s: s % 60 });
    return tr('{h} 小时 {m} 分', { h: Math.floor(m / 60), m: m % 60 });
  }
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };
  const initial = (name) => {
    const ch = [...String(name || '?').trim()][0] || '?';
    return ch.toUpperCase();
  };
  function hashColor(s) {
    let h = 0;
    for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  const agents = () => (S.room ? S.room.agents : []);
  const enabledAgents = () => agents().filter((a) => a.enabled !== false);
  const agentById = (id) => agents().find((a) => a.id === id);
  const envOf = (id) => (S.env && S.env.adapters && S.env.adapters[id]) || {};
  // 成员用的模型，显示成人能看懂的名字（模型目录读到了就用目录里的名字）
  function modelName(adapter, id) {
    const cat = S.catalogs[adapter];
    const m = id && cat && cat.models && cat.models.find((x) => x.id === id);
    return m ? m.label : id;
  }
  function adapterLabel(a) {
    if (a.adapter === 'openai') return a.model || 'API';
    return (ADAPTERS[a.adapter] ? ADAPTERS[a.adapter].label : a.adapter) + (a.model ? ` ${modelName(a.adapter, a.model)}` : '');
  }

  async function loadCatalog(adapter, force) {
    if (!force && S.catalogs[adapter]) return S.catalogs[adapter];
    try {
      S.catalogs[adapter] = await api('GET', `/api/models?adapter=${adapter}${force ? '&refresh=1' : ''}`);
    } catch (e) {
      S.catalogs[adapter] = { models: [], efforts: [], error: e.message };
    }
    return S.catalogs[adapter];
  }

  // 重新检测：服务端会读一遍系统最新的 PATH、重新探测各工具的版本，这里把模型列表也清掉重读
  async function redetect(btn) {
    const before = S.env ? S.env.adapters : {};
    btn = btn || $('[data-refresh-env]');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('spin'); // 图标转起来表示正在检测
    }
    toast(tr('正在重新检测本机的 AI 工具……'));
    try {
      S.env = await api('GET', '/api/env?refresh=1');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('spin');
      }
    }
    S.catalogs = {};
    if (S.roomId) loadSkills(S.roomId, true); // 新装的技能也重新读一遍
    renderEnv();
    renderMembers();
    if (!S.room) renderMain();
    const now = S.env.adapters;
    const found = CLI_TOOLS.filter((id) => now[id] && now[id].installed && !(before[id] && before[id].installed));
    const upgraded = CLI_TOOLS.filter(
      (id) => now[id] && before[id] && now[id].installed && before[id].installed && now[id].version !== before[id].version
    );
    const parts = [];
    if (found.length) parts.push(tr('发现 ') + found.map((id) => ADAPTERS[id].label).join(tr('、')));
    if (upgraded.length) parts.push(upgraded.map((id) => tr('{tool} 已更新到 {version}', { tool: ADAPTERS[id].label, version: now[id].version })).join(tr('，')));
    toast(parts.length ? tr('已重新检测：{changes}', { changes: parts.join(tr('；')) }) : tr('已重新检测，没有变化'));
    // 当前项目用到的工具，在后台重读模型列表，成员列表里的模型名会跟着更新
    for (const ad of new Set(agents().map((a) => a.adapter).filter((x) => x !== 'openai'))) {
      loadCatalog(ad).then(() => renderMembers());
    }
  }

  function pickFolderAny(start) {
    return desktop && desktop.pickFolder ? desktop.pickFolder(start || '') : folderPicker(start);
  }

  // 和服务端同样的 @ 解析规则
  function parseMentions(text, list) {
    const clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ');
    const keys = [
      ...list.map((a) => ({ key: a.name, id: a.id })),
      ...USER_ALIASES.map((k) => ({ key: k, id: 'user' })),
      ...ALL_ALIASES.map((k) => ({ key: k, id: 'all' })),
    ].sort((x, y) => y.key.length - x.key.length);
    const found = [];
    const lower = clean.toLowerCase();
    for (let i = clean.indexOf('@'); i >= 0; i = clean.indexOf('@', i + 1)) {
      const prev = clean[i - 1];
      if (prev && /[A-Za-z0-9_.]/.test(prev)) continue;
      for (const k of keys) {
        const kk = k.key.toLowerCase();
        if (!lower.startsWith(kk, i + 1)) continue;
        const next = clean[i + 1 + kk.length];
        if (/[A-Za-z0-9_]$/.test(k.key) && next && /[A-Za-z0-9_]/.test(next)) continue;
        if (!found.includes(k.id)) found.push(k.id);
        break;
      }
    }
    return found;
  }

  let mentionRe = null;
  let mentionSig = '';
  let skillRe = null;
  function highlightMentions(html) {
    const list = agents();
    const skillsList = S.skills || [];
    const sig = list.map((a) => a.name + a.color).join('|') + '#' + skillsList.length;
    const quote = (k) => esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/[A-Za-z0-9_]$/.test(k) ? '(?![A-Za-z0-9_-])' : '');
    if (sig !== mentionSig) {
      mentionSig = sig;
      const keys = [...list.map((a) => a.name), ...USER_ALIASES, ...ALL_ALIASES].sort((x, y) => y.length - x.length);
      // 和服务端认 @ 的规则一致：前面紧挨着英文字母、数字时不算（比如邮箱），中文后面的 @ 也算（「交给@GPT」）。
      // 另外排除网址、链接属性里会出现的字符，免得改坏链接。
      mentionRe = new RegExp(`(?<![A-Za-z0-9_.\\/=:~%"'#-])@(${keys.map(quote).join('|')})`, 'gi');
      const sk = skillsList.map((s) => s.name).sort((x, y) => y.length - x.length);
      skillRe = sk.length ? new RegExp(`(^|[\\s(（,，。!！?？:：;；、>])\\/(${sk.map(quote).join('|')})`, 'gi') : null;
    }
    let out = html.replace(mentionRe, (all, name) => {
      const a = list.find((x) => esc(x.name).toLowerCase() === name.toLowerCase());
      return a ? `<span class="mention" style="--c:${a.color}">@${name}</span>` : `<span class="mention me">@${name}</span>`;
    });
    if (skillRe) out = out.replace(skillRe, (all, pre, name) => `${pre}<span class="mention skill" title="${tr('技能')}">/${name}</span>`);
    return out;
  }
  const md = (text) => window.Markdown.render(text, { mention: highlightMentions });

  // ---------- 侧栏（像 Claude 桌面版：搜索、新建、两行的列表项） ----------
  // 搜索框和「新建项目」只画一次，列表刷新时不会打断正在输入的搜索词
  function renderRailTop() {
    $('#railTop').innerHTML = `
      <label class="side-search">${ICONS.search}<input id="projSearch" type="search" placeholder="${tr('搜索项目和会话')}" autocomplete="off" spellcheck="false" aria-label="${tr('搜索项目和会话')}"></label>
      <button type="button" class="nav-item" data-new-project><span class="nav-ico">${ICONS.plusCircle}</span>${tr('新建项目')}</button>`;
    const input = $('#projSearch');
    input.addEventListener('input', () => {
      S.projectQuery = input.value.trim().toLowerCase();
      renderProjects();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.stopPropagation();
        input.value = '';
        S.projectQuery = '';
        renderProjects();
      }
    });
  }

  // 列表里的最后一条消息：去掉 Markdown 记号，只留文字
  const previewText = (s) => plain(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 多久以前：刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 10月3日
  function ago(ts) {
    const m = Math.floor((Date.now() - (ts || 0)) / 60000);
    if (m < 1) return tr('刚刚');
    if (m < 60) return tr('{n} 分钟前', { n: m });
    if (m < 60 * 24) return tr('{n} 小时前', { n: Math.floor(m / 60) });
    if (m < 60 * 24 * 7) return tr('{n} 天前', { n: Math.floor(m / 1440) });
    return new Date(ts).toLocaleDateString(LOCALE(), { month: 'short', day: 'numeric' });
  }

  // 收起来的项目（记在本机），打开某个会话时它所在的项目会自动展开
  const collapsed = new Set(String(local.get('agentchat.collapsed') || '').split(',').filter(Boolean));
  const saveCollapsed = () => local.set('agentchat.collapsed', [...collapsed].join(','));
  const projectById = (id) => S.projects.find((p) => p.id === id) || null;

  // 左边栏：项目（一个文件夹）下面是它的会话。点项目名展开或收起；鼠标移上去右边有「新建会话」和「更多」
  function renderProjects() {
    // 正在拖动排序时先不重画（不然拖着的那一行就没了），松手以后再画；刚按下还没拖起来的就当没按
    if (drag) {
      if (drag.on) return void (drag.dirty = true);
      drag = null;
    }
    const box = $('#projects');
    // 焦点在左边栏里的话，重画后放回同一个按钮上（用键盘挪顺序、置顶以后焦点不会丢）
    const f = document.activeElement;
    const keep = f && box.contains(f) && ['data-room', 'data-chat-menu', 'data-proj-toggle', 'data-proj-menu', 'data-new-chat'].find((k) => f.hasAttribute(k));
    const keepSel = keep ? `[${keep}="${f.getAttribute(keep)}"]` : '';
    const q = S.projectQuery || '';
    const has = (s) => String(s || '').toLowerCase().includes(q);
    // 一个会话一行：置顶的左边有图钉；右边是最近一条消息的时间，鼠标移上去换成「⋯」（右键也是同一个菜单）
    const chat = (r) => {
      const last = r.last ? tr('{name}：{text}', { name: r.last.name, text: previewText(r.last.text) }) : '';
      return `<li class="chat-li${r.pinned ? ' pinned' : ''}" data-id="${r.id}">
          <button type="button" class="chat" data-room="${r.id}" aria-current="${r.id === S.roomId}"${last ? ` title="${esc(last)}"` : ''}>${
            r.pinned ? `<span class="chat-pin">${ICONS.pin}</span>` : ''
          }<span class="chat-name">${esc(r.name)}</span><span class="chat-end">${
            r.busy ? `<span class="project-busy" title="${tr('有成员在工作')}"></span>` : `<span class="chat-time">${esc(ago(r.updatedAt))}</span>`
          }</span></button>
          <button type="button" class="icon-btn chat-act" data-chat-menu="${r.id}" data-menu-anchor aria-haspopup="menu" title="${esc(tr('会话操作'))}" aria-label="${esc(
            tr('会话操作：{name}', { name: r.name })
          )}">${ICONS.more}</button></li>`;
    };
    const groups = S.projects
      .map((p) => {
        // 搜索时：项目名或文件夹对得上就整个列出来，不然只列名字对得上的会话
        const whole = !q || has(p.name) || has(p.workspace);
        const rooms = whole ? p.rooms : p.rooms.filter((r) => has(r.name));
        if (!whole && !rooms.length) return '';
        const open = !!q || !collapsed.has(p.id);
        return `<li class="proj${p.id === S.projectId ? ' cur' : ''}" data-id="${p.id}">
          <div class="proj-row">
            <button type="button" class="proj-head" data-proj-toggle="${p.id}" aria-expanded="${open}" title="${esc(p.workspace)}">
              <span class="proj-chev">${ICONS.chev}</span><span class="proj-ico">${ICONS.folder}</span><span class="proj-name">${esc(p.name)}</span>${
                p.busy && !open ? `<span class="project-busy" title="${tr('有成员在工作')}"></span>` : ''
              }</button>
            <button type="button" class="icon-btn proj-act" data-new-chat="${p.id}" title="${esc(tr('在「{name}」里新建会话', { name: p.name }))}" aria-label="${esc(tr('新建会话'))}">${ICONS.plus}</button>
            <button type="button" class="icon-btn proj-act" data-proj-menu="${p.id}" data-menu-anchor aria-haspopup="menu" title="${esc(tr('项目操作'))}" aria-label="${esc(tr('项目操作'))}">${ICONS.more}</button>
          </div>
          ${open ? `<ul class="chat-list">${rooms.map(chat).join('') || `<li class="chat-new-li"><button type="button" class="chat chat-new" data-new-chat="${p.id}">${ICONS.plus}<span class="chat-name">${tr('新建会话')}</span></button></li>`}</ul>` : ''}
        </li>`;
      })
      .join('');
    box.innerHTML = `<div class="sec-head"><h2>${tr('项目')}</h2></div>
      ${groups ? `<ul class="proj-list">${groups}</ul>` : `<p class="rail-empty">${q ? tr('没有名字里带这几个字的项目或会话') : tr('还没有项目')}</p>`}`;
    const back = keepSel && box.querySelector(keepSel);
    if (back) back.focus({ preventScroll: true });
  }

  // 会话成员：标题栏里会话名旁边一排头像，点开是成员列表（接入方式、模型、思考强度、正在做什么）
  function renderMembers() {
    renderMembersChip();
    const pop = $('#membersPop');
    if (pop) fillMembersPop(pop);
  }

  function renderMembersChip() {
    const chip = $('#tbMembers');
    if (!chip) return;
    chip.hidden = !S.room;
    if (!S.room) return;
    const list = agents();
    const st = S.state || {};
    const busy = st.running && st.running.agentId;
    chip.setAttribute('aria-label', list.length ? tr('会话成员：{names}', { names: list.map((a) => a.name).join(tr('、')) }) : tr('添加成员'));
    chip.title = list.length ? tr('会话成员：点开看每个成员的模型和思考强度') : tr('这个会话还没有成员，点一下添加');
    chip.innerHTML = list.length
      ? `<span class="tb-avs">${list
          .slice(0, 4)
          .map((a) => `<span class="avatar xs${a.id === busy ? ' working' : ''}${a.enabled === false ? ' off' : ''}" style="--c:${a.color}">${esc(initial(a.name))}</span>`)
          .join('')}${list.length > 4 ? `<span class="tb-more">+${list.length - 4}</span>` : ''}</span><span class="tb-mlabel">${esc(
          tr('{n} 位成员', { n: list.length })
        )}</span>${ICONS.chevDown}`
      : `${ICONS.plus}<span class="tb-mlabel">${esc(tr('添加成员'))}</span>`;
  }

  function toggleMembersPop() {
    if ($('#membersPop')) return closeMembersPop();
    if (!S.room) return;
    if (!agents().length) return memberModal(null);
    closeMenu();
    const chip = $('#tbMembers');
    const pop = el(`<div class="members-pop" id="membersPop" role="dialog" aria-label="${esc(tr('会话成员'))}"></div>`);
    document.body.append(pop);
    fillMembersPop(pop);
    const r = chip.getBoundingClientRect();
    pop.style.top = r.bottom + 6 + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    chip.setAttribute('aria-expanded', 'true');
    const first = pop.querySelector('.member');
    if (first) first.focus();
  }

  function closeMembersPop() {
    const pop = $('#membersPop');
    if (pop) pop.remove();
    const chip = $('#tbMembers');
    if (chip) chip.setAttribute('aria-expanded', 'false');
  }

  function fillMembersPop(pop) {
    if (!S.room) return closeMembersPop();
    const list = agents();
    pop.innerHTML = `<div class="mp-head"><b>${esc(tr('会话成员'))}</b><span class="mp-count">${list.length}</span>
        <button type="button" class="btn small" data-add-member>${ICONS.plus}${esc(tr('添加成员'))}</button></div>
      ${list.length ? `<ul class="member-list">${memberRows()}</ul>` : `<p class="member-empty">${esc(tr('这个会话还没有成员。'))}</p>`}
      <p class="mp-foot">${esc(tr('点成员改模型、思考强度和权限。每个会话的成员各自独立。'))}</p>`;
  }

  function memberRows() {
    const st = S.state || {};
    return agents()
      .map((a) => {
        const working = st.running && st.running.agentId === a.id;
        const queued = (st.queue || []).some((q) => q.agentId === a.id);
        let state = '';
        if (a.enabled === false) state = `<span class="member-state">${tr('已停用')}</span>`;
        else if (working) state = `<span class="member-state working">${tr('工作中')}</span>`;
        else if (queued) state = `<span class="member-state queued">${st.paused ? tr('暂停中') : tr('排队中')}</span>`;
        else state = `<button class="icon-btn member-at" data-at="${a.id}" title="${esc(tr('在输入框里 @{name}', { name: a.name }))}">@</button>`;
        // 第二行：接入方式、模型、思考强度、权限。没单独选模型或强度的，显示这个工具自己设置里的默认值
        const tool = ADAPTERS[a.adapter] ? ADAPTERS[a.adapter].label : a.adapter;
        const cat = S.catalogs[a.adapter] || {};
        const model = a.model
          ? modelName(a.adapter, a.model)
          : cat.defaultModel
            ? tr('默认（{model}）', { model: modelName(a.adapter, cat.defaultModel) })
            : tr('默认模型');
        const effort = a.effort || cat.defaultEffort || '';
        const perm = PERMS[a.permission] ? PERMS[a.permission].label : '';
        return `<li class="member ${a.enabled === false ? 'off' : ''}" data-agent="${a.id}" style="--c:${a.color}" tabindex="0" title="${esc(tr('编辑 {name}', { name: a.name }))}">
          <span class="avatar">${esc(initial(a.name))}</span>
          <div class="member-main"><div class="member-name">${esc(a.name)}${a.role ? `<span class="member-role">${esc(a.role)}</span>` : ''}</div>
            <div class="member-sub"><span class="member-tool">${esc(tool)}</span><span class="member-model${a.model ? '' : ' dim'}" title="${esc(model)}">${esc(model)}</span>${
              effort ? `<span class="chip" title="${esc(tr('思考强度'))}">${esc(effortName(effort))}</span>` : ''
            }${perm ? `<span class="chip" title="${esc(tr('权限'))}">${esc(perm)}</span>` : ''}</div></div>
          ${state}
        </li>`;
      })
      .join('');
  }

  // 侧栏底部：账户区（头像、名字，点开是设置、用量、语言……），右边的小圆点是本机 AI 工具的状态。见 account.js
  function renderEnv() {
    if (account) account.renderFoot();
  }

  // ---------- 主区 ----------
  function renderMain() {
    const main = $('#main');
    if (!S.room) {
      main.innerHTML = '';
      const p = projectById(S.projectId);
      // 项目里的会话都删完了：停在这个项目，给一个「新建会话」
      main.append(
        p
          ? el(`<div class="welcome"><div class="welcome-inner project-empty">
              <div class="welcome-mark">${brandMark()}</div>
              <h1>${esc(p.name)}</h1>
              <p class="lead">${esc(tr('这个项目还没有会话。新建一个会话，给它配上成员，就可以开始了。'))}</p>
              <p class="hint mono">${esc(p.workspace)}</p>
              <button class="btn primary large" data-new-chat="${p.id}">${ICONS.plus}${tr('新建会话')}</button>
            </div></div>`)
          : welcomeNode()
      );
      renderHeader();
      return;
    }
    // 项目名、文件夹和设置都在标题栏里。对话在中间一栏；底下是接力条、提示条和输入框，和 Claude 桌面版一样
    main.innerHTML = `
      <div class="offline" id="offline" hidden>${tr('和本地服务的连接断开了，正在重连……')}</div>
      <div class="scroll-area" id="scrollArea">
        <div class="scroller" id="scroller">
          <div class="transcript" id="transcript"></div>
        </div>
        <nav class="timeline" id="timeline" aria-label="${tr('对话轴：每一道是你发的一条消息')}" hidden></nav>
        <div class="tl-pop" id="tlPop" role="tooltip"></div>
      </div>
      <div class="dock">
        <div class="dock-inner">
          <button type="button" class="jump" id="jump" hidden title="${tr('有新消息，回到底部')}" aria-label="${tr('回到底部')}">${ICONS.arrowDown}</button>
          <div class="relay" id="relay" aria-live="polite" hidden></div>
          <div class="banner" id="banner" hidden></div>
          <form class="composer" id="composer" autocomplete="off">
            <div class="mention-pop" id="mentionPop" role="listbox" hidden></div>
            <div id="input" class="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${tr('消息')}" spellcheck="false"
              data-placeholder="${tr('给团队发消息，用 @ 指定成员，/ 选择技能')}"></div>
            <div class="composer-row">
              <div class="composer-tools">
                <button type="button" class="tool-btn" data-insert="@" title="${tr('指定成员（输入 @）')}" aria-label="${tr('指定成员')}">@</button>
                <button type="button" class="tool-btn" data-insert="/" title="${tr('选择技能（输入 /）')}" aria-label="${tr('选择技能')}">/</button>
              </div>
              <div class="to" id="to"></div>
              <button type="button" class="send-btn" id="sendBtn"></button>
            </div>
          </form>
        </div>
      </div>`;
    S.liveKey = null;
    renderHeader();
    renderTranscript();
    renderRelay();
    renderComposerState();
    setupComposer();
    const scroller = $('#scroller');
    scroller.addEventListener('scroll', () => {
      if (nearBottom()) $('#jump').hidden = true;
      syncTimeline();
    });
    setupTimeline();
    scrollToBottom();
  }

  // 还没有项目时的首页：居中的大标题、一个主按钮，下面是这台电脑上能用的 AI
  function welcomeNode() {
    // 装好的排在前面，没装的放后面
    const rank = (id) => (envOf(id).installed ? 0 : 1);
    const tools = [...CLI_TOOLS]
      .sort((x, y) => (S.env ? rank(x) - rank(y) : 0))
      .map((id) => {
        const e = envOf(id);
        const state = !S.env ? 'wait' : !e.installed ? 'no' : e.outdated ? 'old' : 'ok';
        const note = !S.env ? tr('正在检测……') : !e.installed ? tr('这台电脑上还没装') : e.outdated ? tr('版本太旧，需要先升级') : esc(tr('已安装 {version}', { version: e.version || '' }));
        const how = ADAPTERS[id].install;
        const cmd = S.env && !e.installed && how ? (S.env.platform === 'win32' ? how.win : how.other) : '';
        return `<li class="${state}"${cmd ? ` title="${esc(tr('安装命令：{cmd}', { cmd }))}"` : ''}><span class="tool-dot"></span><b>${ADAPTERS[id].label}</b><span class="what">${esc(ADAPTERS[id].what)}</span><span class="tool-note">${note}</span></li>`;
      })
      .join('');
    const team = templatePreview('trio');
    const demo = [
      { name: tr('你'), me: true, sub: tr('提需求') },
      ...team.map((t) => ({ name: t.name, sub: t.role, color: t.color })),
    ];
    const hops = demo
      .map(
        (h, i) =>
          `<li class="hop ${i === 2 ? 'running' : i < 2 ? 'done' : 'queued'} ${h.me ? 'me' : ''}" style="--c:${h.color || 'var(--ink)'};--c-prev:${
            i > 0 ? demo[i - 1].color || 'var(--ink)' : 'var(--rule)'
          }"><span class="dot"></span>${esc(h.name)}<small>${esc(h.sub)}</small></li>`
      )
      .join('');
    return el(`<div class="welcome"><div class="welcome-inner">
      <div class="welcome-mark">${brandMark()}</div>
      <h1>${tr('让几个 AI 在同一个项目里一起干活')}</h1>
      <p class="lead">${tr('你提需求，它们自己分工：一个出设计，一个写代码，一个做审查。谁做完就在群里 @ 下一位，接力往下做。你随时可以插话、叫停。')}</p>
      <button class="btn primary large" data-new-project>${ICONS.plus}${tr('新建项目')}</button>
      <div class="welcome-card">
        <ol class="relay-track demo">${hops}</ol>
        <p class="demo-caption">${tr('一次接力：实心点是做完的成员，闪动的正在工作，空心的在排队。')}</p>
      </div>
      <div class="welcome-card">
        <h2>${tr('这台电脑上能用的 AI')}</h2>
        <ul class="tool-list">${tools}
          <li class="ok"><span class="tool-dot"></span><b>${tr('API 模型')}</b><span class="what">${tr('DeepSeek、通义千问、Kimi、智谱、Ollama 等兼容 OpenAI 接口的模型')}</span><span class="tool-note">${tr('填地址和 Key 就能加入')}</span></li>
        </ul>
      </div>
    </div></div>`);
  }

  function renderHeader() {
    updateTitlebar();
    setDocTitle();
  }

  // 窗口标题（任务栏上鼠标移过去看到的）：会话名 · Nightshift / Dayshift
  function setDocTitle() {
    document.title = S.room ? `${S.room.name} · ${appName()}` : appName();
  }

  // 深浅色变了：窗口标题、标签页图标、标题栏里的名字跟着换（窗口和任务栏的图标由桌面版主进程换）
  function syncBrand() {
    setDocTitle();
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = faviconOf(isDark() ? MARK_NIGHT : MARK_DAY);
    if (!S.room && $('#tbTitle') && !projectById(S.projectId)) $('#tbTitle').textContent = appName();
  }

  // ---------- 标题栏：沉浸式，和界面连成一体；Windows 的最小化 / 最大化 / 关闭按钮由系统画在最右边 ----------
  function renderTitlebar() {
    $('#titlebar').innerHTML = `
      <div class="tb-left">
        <button type="button" class="tb-btn" data-tb="menu" data-menu-anchor title="${tr('菜单')}" aria-label="${tr('菜单')}" aria-haspopup="menu">${ICONS.menu}</button>
        <button type="button" class="tb-btn" data-tb="rail" title="${tr('显示或隐藏左侧边栏（Ctrl+B）')}" aria-label="${tr('显示或隐藏左侧边栏')}">${ICONS.sidebar}</button>
        <button type="button" class="tb-btn" data-tb="back" title="${tr('后退（Alt+←）')}" aria-label="${tr('后退')}">${ICONS.back}</button>
        <button type="button" class="tb-btn" data-tb="forward" title="${tr('前进（Alt+→）')}" aria-label="${tr('前进')}">${ICONS.forward}</button>
      </div>
      <div class="tb-mid">
        <button type="button" class="tb-crumb" data-tb="project" data-menu-anchor aria-haspopup="menu" hidden><span id="tbProject"></span></button>
        <span class="tb-slash" id="tbSlash" aria-hidden="true" hidden>/</span>
        <button type="button" class="tb-title" data-tb="title" data-menu-anchor aria-haspopup="menu" title="${tr('切换会话')}"><span id="tbTitle">${esc(appName())}</span>${ICONS.chevDown}</button>
        <button type="button" class="tb-members" id="tbMembers" data-members aria-haspopup="dialog" aria-expanded="false" hidden></button>
      </div>
      <div class="tb-right">
        ${PANEL_TABS.map(
          ([id, label, icon]) =>
            `<button type="button" class="tb-btn" data-tb-panel="${id}" title="${label}" aria-label="${label}" aria-pressed="false">${ICONS[icon]}</button>`
        ).join('')}
        <span class="tb-sep" aria-hidden="true"></span>
        <button type="button" class="tb-btn" data-tb="panel" title="${tr('显示或隐藏右侧面板（Ctrl+J）')}" aria-label="${tr('显示或隐藏右侧面板')}" aria-pressed="false">${ICONS.panelRight}</button>
        <button type="button" class="tb-btn" data-tb="more" data-menu-anchor title="${tr('更多')}" aria-label="${tr('更多')}" aria-haspopup="menu">${ICONS.more}</button>
      </div>`;
    updateTitlebar();
  }

  function updateTitlebar() {
    const tb = $('#titlebar');
    if (!tb || !tb.firstElementChild) return;
    // 项目名 / 会话名 ▾，后面是这个会话的成员
    const project = projectById(S.projectId);
    $('#tbProject').textContent = project ? project.name : '';
    tb.querySelector('[data-tb="project"]').hidden = !project;
    tb.querySelector('[data-tb="project"]').title = project ? `${project.workspace}\n${tr('点击查看项目操作')}` : '';
    $('#tbSlash').hidden = !project;
    $('#tbTitle').textContent = S.room ? S.room.name : project ? tr('还没有会话') : appName();
    const title = tb.querySelector('[data-tb="title"]');
    title.title = S.room ? tr('点击切换会话') : '';
    renderMembersChip();
    tb.querySelector('[data-tb="back"]').disabled = S.nav.i <= 0;
    tb.querySelector('[data-tb="forward"]').disabled = S.nav.i >= S.nav.list.length - 1;
    tb.querySelector('[data-tb="more"]').disabled = !S.room;
    const ps = panel ? panel.state() : { open: false };
    for (const b of tb.querySelectorAll('[data-tb-panel]')) b.setAttribute('aria-pressed', String(ps.open && ps.tab === b.dataset.tbPanel));
    tb.querySelector('[data-tb="panel"]').setAttribute('aria-pressed', String(!!ps.open));
    tb.querySelector('[data-tb="rail"]').setAttribute('aria-pressed', String(!$('#app').classList.contains('rail-collapsed')));
  }

  // 系统画的窗口按钮要和标题栏同色：颜色取自样式表，深浅色切换时跟着变
  function syncTitlebarColors() {
    if (!desktop || !desktop.setTitleBar) return;
    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue('--titlebar').trim();
    const symbolColor = css.getPropertyValue('--ink-2').trim();
    if (/^#[0-9a-f]{6}$/i.test(color) && /^#[0-9a-f]{6}$/i.test(symbolColor)) desktop.setTitleBar({ color, symbolColor });
  }

  // 标题栏右边要给系统的窗口按钮留出位置（Window Controls Overlay）
  function syncControlsInset() {
    const wco = navigator.windowControlsOverlay;
    let inset = 0;
    if (wco && wco.visible) {
      const r = wco.getTitlebarAreaRect();
      inset = Math.max(0, Math.round(window.innerWidth - (r.x + r.width)));
    } else if (desktop && desktop.platform === 'win32') inset = 138;
    document.documentElement.style.setProperty('--wco-right', inset + 'px');
  }

  function toggleRail() {
    const app = $('#app');
    if (window.innerWidth <= 860) {
      app.classList.toggle('rail-open');
      return;
    }
    app.classList.toggle('rail-collapsed');
    local.set('agentchat.rail', app.classList.contains('rail-collapsed') ? 'collapsed' : '');
    updateTitlebar();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 0); // 终端跟着调整宽度
  }

  // 后退 / 前进：在打开过的项目之间切换
  function goHistory(step) {
    const i = S.nav.i + step;
    if (i < 0 || i >= S.nav.list.length) return;
    const id = S.nav.list[i];
    if (!S.rooms.some((r) => r.id === id)) {
      S.nav.list.splice(i, 1);
      if (step < 0) S.nav.i = Math.max(0, S.nav.i - 1);
      updateTitlebar();
      return goHistory(step);
    }
    S.nav.i = i;
    openRoom(id, { fromHistory: true });
  }

  function appMenu(anchor) {
    const items = [
      { label: tr('新建项目'), icon: ICONS.plus, run: newProjectModal },
      { label: tr('重新检测 AI 工具'), icon: ICONS.refresh, run: () => redetect() },
    ];
    if (desktop && desktop.action) {
      items.push(
        '-',
        { label: tr('放大'), hint: 'Ctrl+=', run: () => desktop.action('zoom-in') },
        { label: tr('缩小'), hint: 'Ctrl+-', run: () => desktop.action('zoom-out') },
        { label: tr('实际大小'), hint: 'Ctrl+0', run: () => desktop.action('zoom-reset') },
        '-',
        { label: tr('重新加载界面'), hint: 'Ctrl+Shift+R', run: () => desktop.action('reload') },
        { label: tr('开发者工具'), hint: 'F12', run: () => desktop.action('devtools') }
      );
    }
    items.push('-', { label: tr('关于 {app}', { app: appName() }), icon: ICONS.info, run: aboutModal });
    openMenu(anchor, items, { align: 'left' });
  }

  // 标题栏里的会话名 ▾：这个项目里的会话，点一下切过去；下面是新建、重命名、会话设置
  function conversationMenu(anchor) {
    const p = projectById(S.projectId);
    if (!p) return;
    const items = p.rooms.slice(0, 15).map((r) => ({
      label: r.name,
      hint: r.busy ? tr('工作中') : ago(r.updatedAt),
      checked: r.id === S.roomId,
      run: () => openRoom(r.id),
    }));
    if (p.rooms.length > 15) items.push({ label: tr('……还有 {n} 个会话，在左边侧边栏里', { n: p.rooms.length - 15 }), disabled: true, run() {} });
    if (items.length) items.push('-');
    items.push({ label: tr('新建会话'), icon: ICONS.plus, run: () => newConversation(p.id, S.roomId) });
    if (S.room) {
      const r = S.room;
      items.push(
        { label: r.pinned ? tr('取消置顶') : tr('置顶'), icon: ICONS.pin, run: () => pinConversation(r, !r.pinned) },
        { label: tr('重命名会话…'), icon: ICONS.edit, run: () => renameConversation(r) },
        { label: tr('会话设置…'), icon: ICONS.gear, run: settingsModal }
      );
    }
    openMenu(anchor, items, { align: 'left' });
  }

  // 会话的操作：右键左边栏里的会话，或者点它右边的「⋯」。pos 是鼠标位置（右键时）
  function chatMenu(anchor, id, pos) {
    const r = S.rooms.find((x) => x.id === id);
    if (!r) return;
    openMenu(
      anchor,
      [
        { label: r.pinned ? tr('取消置顶') : tr('置顶'), icon: ICONS.pin, run: () => pinConversation(r, !r.pinned) },
        { label: tr('重命名会话…'), icon: ICONS.edit, run: () => renameConversation(r) },
        { label: tr('会话设置…'), icon: ICONS.gear, run: () => conversationSettings(r.id) },
        { label: tr('用相同的成员新建会话…'), icon: ICONS.plus, run: () => newConversation(r.projectId, r.id) },
        '-',
        { label: tr('删除会话'), icon: ICONS.trash, danger: true, run: () => deleteConversation(r) },
      ],
      pos || {}
    );
  }

  // 项目的操作：标题栏里的项目名，或者左边栏项目右边的「⋯」，或者右键项目
  function projectMenu(anchor, pid, pos) {
    const p = projectById(pid);
    if (!p) return;
    const fromHere = S.room && S.room.projectId === p.id ? S.roomId : null;
    openMenu(
      anchor,
      [
        { header: true, label: p.workspace },
        { label: tr('新建会话'), icon: ICONS.plus, run: () => newConversation(p.id, fromHere) },
        { label: tr('项目设置…'), icon: ICONS.gear, run: () => projectSettingsModal(p.id) },
        { label: tr('在文件管理器中打开'), icon: ICONS.open, run: () => api('POST', `/api/rooms/${p.rooms[0] ? p.rooms[0].id : ''}/open`).catch((e) => toast(e.message, true)), disabled: !p.rooms.length },
        { label: tr('复制项目文件夹路径'), icon: ICONS.copy, run: () => copyText(p.workspace, tr('已复制路径')) },
        '-',
        { label: tr('删除项目'), icon: ICONS.trash, danger: true, run: () => deleteProject(p.id) },
      ],
      pos || {}
    );
  }

  function moreMenu(anchor) {
    if (!S.room) return;
    openMenu(anchor, [
      { label: tr('会话设置…'), icon: ICONS.gear, run: settingsModal },
      { label: tr('项目设置…'), icon: ICONS.folder, run: () => projectSettingsModal(S.room.projectId) },
      { label: tr('在文件管理器中打开'), icon: ICONS.open, run: () => api('POST', `/api/rooms/${S.roomId}/open`).catch((e) => toast(e.message, true)) },
      { label: tr('复制项目文件夹路径'), icon: ICONS.copy, run: () => copyText(S.room.workspace, tr('已复制路径')) },
      '-',
      ...PANEL_TABS.map(([id, label, icon]) => ({ label: tr('打开{panel}', { panel: label }), icon: ICONS[icon], run: () => panel.show(id) })),
    ]);
  }

  function aboutModal() {
    const env = S.env || {};
    const body = el(`<div class="about">
      <div class="about-brand">${brandMark()}<div><b>${esc(appName())}</b>
        <span>${esc(tr('白天叫 Dayshift，晚上叫 Nightshift：名字和图标跟着浅色、深色外观一起换。'))}</span></div></div>
      <p>${tr('让多个 AI（Claude Code、Codex、OpenCode、各种 API 模型）在同一个项目里分工协作、互相交流。')}</p>
      <dl>
        <dt>${tr('版本')}</dt><dd>${esc(env.version || '')}${env.desktop ? tr('（桌面版）') : tr('（浏览器版）')}</dd>
        <dt>${tr('数据保存在')}</dt><dd><code>${esc(env.dataDir || '')}</code></dd>
        <dt>Node.js</dt><dd>${esc(env.node || '')}</dd>
      </dl></div>`);
    const m = openModal({ title: tr('关于 {app}', { app: appName() }), body });
    footButtons(m, ['spacer', { label: tr('关闭'), kind: 'primary' }]);
  }

  // 把文字插到群聊输入框里光标的位置（文件面板的「插入路径」、侧边对话的「引用到群聊」）
  function insertIntoComposer(text) {
    const input = inputEl();
    if (!input) return toast(tr('先打开一个项目'), true);
    input.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !input.contains(sel.anchorNode)) caretToEnd(input);
    const before = textBeforeCaret() || '';
    const sep = before && !/\s$/.test(before) && !/^\s/.test(text) ? ' ' : '';
    document.execCommand('insertHTML', false, textToHtml(sep + text));
    onComposerInput();
  }

  // 本次接力的链条：最后一条用户消息 → 之后发言的成员 → 正在工作的 → 排队中的
  function relayChain() {
    const msgs = S.messages;
    let start = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].from === 'user') {
        start = i;
        break;
      }
    }
    const chain = [];
    if (start >= 0) {
      chain.push({ who: 'user', state: 'done' });
      for (const m of msgs.slice(start + 1)) {
        if (m.kind === 'agent') chain.push({ who: m.from, name: m.name, state: m.status === 'done' ? 'done' : m.status });
      }
    }
    const st = S.state || {};
    if (st.running) chain.push({ who: st.running.agentId, state: 'running' });
    for (const q of st.queue || []) chain.push({ who: q.agentId, state: st.paused ? 'queued paused' : 'queued' });
    return chain;
  }

  function hopColor(h) {
    if (h.who === 'user') return 'var(--ink)';
    const a = agentById(h.who);
    return a ? a.color : hashColor(h.name || h.who);
  }

  function renderRelay() {
    const box = $('#relay');
    if (!box) return;
    const chain = relayChain();
    const st = S.state || {};
    // 还没开始接力时不占位置；空项目的引导写在对话区中间
    box.hidden = !chain.length;
    if (!chain.length) {
      box.innerHTML = '';
      return;
    }
    const MAX = 10;
    const hidden = Math.max(0, chain.length - MAX);
    const shown = chain.slice(hidden);
    const hops = shown.map((h, i) => {
      const prev = i > 0 ? shown[i - 1] : hidden ? chain[hidden - 1] : null;
      const a = h.who === 'user' ? null : agentById(h.who);
      const name = h.who === 'user' ? tr('你') : a ? a.name : h.name || tr('已删除的成员');
      const status = h.state === 'running' && S.progress ? `<span class="hop-status">${esc(S.progress.status || '')}</span>` : '';
      const label = { done: tr('已完成'), running: tr('正在工作'), queued: tr('排队中'), 'queued paused': tr('暂停中'), error: tr('出错'), stopped: tr('已中止') }[h.state] || '';
      return `<li class="hop ${h.state} ${h.who === 'user' ? 'me' : ''}" style="--c:${hopColor(h)};--c-prev:${prev ? hopColor(prev) : 'var(--rule)'}" title="${esc(tr('{name}：{text}', { name, text: label }))}">
        <span class="dot"></span>${esc(name)}${status}</li>`;
    });
    if (hidden) hops.unshift(`<li class="hop done"><span class="relay-meta">${tr('前面还有 {n} 站', { n: hidden })}</span></li>`);
    const max = (S.room && S.room.settings && S.room.settings.maxAutoTurns) || 10;
    const meta = st.paused ? tr('已暂停') : st.autoTurns ? tr('自动接力 {n}/{max}', { n: st.autoTurns, max }) : '';
    box.innerHTML = `<span class="relay-label">${tr('接力')}</span><ol class="relay-track">${hops.join('')}</ol>${meta ? `<span class="relay-meta">${meta}</span>` : ''}`;
    const track = box.querySelector('.relay-track');
    track.scrollLeft = track.scrollWidth;
  }

  // ---------- 聊天记录 ----------
  function summarize(items) {
    const files = new Set();
    const reads = new Set();
    let cmds = 0;
    let looks = 0;
    let notes = 0;
    let errors = 0;
    let other = 0;
    for (const it of items) {
      if (it.s === 'error') errors++;
      if (it.k === 'write' || it.k === 'edit') String(it.d || '').split(tr('、')).forEach((f) => f && files.add(f));
      else if (it.k === 'read') reads.add(it.d);
      else if (it.k === 'cmd') cmds++;
      else if (it.k === 'search' || it.k === 'web') looks++;
      else if (it.k === 'note') notes++;
      else other++;
    }
    const out = [];
    if (files.size) out.push(['edit', tr('改了 {n} 个文件', { n: files.size })]);
    if (cmds) out.push(['cmd', tr('运行 {n} 条命令', { n: cmds })]);
    if (reads.size) out.push(['read', tr('看了 {n} 个文件', { n: reads.size })]);
    if (looks) out.push(['search', tr('查找 {n} 次', { n: looks })]);
    if (other) out.push(['other', tr('其他操作 {n} 次', { n: other })]);
    if (notes) out.push(['note', tr('过程说明 {n} 段', { n: notes })]);
    if (errors) out.push(['bad', tr('{n} 步失败', { n: errors })]);
    return out;
  }

  const VERB = { read: tr('阅读'), write: tr('写入'), edit: tr('修改'), cmd: tr('运行'), search: tr('查找'), web: tr('查资料'), agent: tr('子任务'), todo: tr('待办') };
  function workItem(it) {
    const cls = [it.k === 'note' ? 'note' : '', it.s === 'error' ? 'error' : '', it.s === 'running' ? 'running' : ''].join(' ');
    const verb = it.k === 'note' ? '' : `<span class="verb">${esc(VERB[it.k] || it.n || tr('工具'))}${it.s === 'error' ? tr('失败') : ''}</span>`;
    return `<li class="${cls}">${ICONS[it.k] || ICONS.other}<div class="d">${verb}${esc(it.d || '')}</div></li>`;
  }

  function workNode(items, key) {
    const stats = summarize(items);
    const open = S.open.has(key);
    const node = el(`<div class="work ${open ? 'open' : ''}">
      <button class="work-toggle" aria-expanded="${open}" data-work="${key}">${ICONS.chev}${stats
        .map(([k, t]) => `<span class="stat ${k === 'bad' ? 'bad' : ''}">${k === 'bad' ? '' : ICONS[k]}${t}</span>`)
        .join('')}</button>
      ${open ? `<ol class="work-list">${items.map(workItem).join('')}</ol>` : ''}</div>`);
    return node;
  }

  // ---------- 文件卡片：这一轮新建 / 修改的文件，像桌面版 Claude、ChatGPT 那样列在消息底部 ----------
  function filesNode(m) {
    const shown = m.files.filter((f) => f.change !== 'delete');
    const deleted = m.files.filter((f) => f.change === 'delete');
    const all = S.open.has('files:' + m.id);
    const cards = (all ? shown : shown.slice(0, 4))
      .map((f) => {
        const t = fileType(f.path);
        const name = f.path.split('/').pop();
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const act = t.kind === 'exec' && !t.preview ? tr('点击在文件夹中显示') : OPEN_OUTSIDE.includes(t.kind) && !t.preview ? tr('点击打开') : tr('点击预览');
        return `<div class="file-card">
          <button type="button" class="file-main" data-file-open="${esc(f.path)}" title="${esc(f.path)}">
            <span class="file-icon k-${t.kind}">${FILE_ICON[t.kind] || FILE_ICON.other}</span>
            <span class="file-text"><span class="file-name">${esc(name)}</span>
              <span class="file-sub"><span>${esc(f.change === 'add' ? tr('新建的{type}', { type: t.label }) : tr('修改过的{type}', { type: t.label }))}</span>${dir ? `<span>${esc(dir)}</span>` : ''}<span class="file-act">${act}</span></span></span>
          </button>
          <button type="button" class="btn small file-menu-btn" data-file-menu="${esc(f.path)}" aria-haspopup="menu">${tr('打开方式')}${ICONS.chevDown}</button>
        </div>`;
      })
      .join('');
    const more =
      shown.length > 4
        ? `<button type="button" class="link-btn files-more" data-files-more="${m.id}">${all ? tr('收起') : tr('还有 {n} 个文件', { n: shown.length - 4 })}</button>`
        : '';
    const del = deleted.length
      ? `<p class="files-deleted">${tr('删除了 {n} 个文件：', { n: deleted.length })}${deleted
          .slice(0, 5)
          .map((f) => esc(f.path))
          .join(tr('、'))}${deleted.length > 5 ? tr(' 等') : ''}</p>`
      : '';
    return el(`<div class="files">${cards}${more}${del}</div>`);
  }

  // 把 AI 写的各种路径（/E:/x/y.html、file://、绝对路径、带 :行号）变成项目里的相对路径
  function toRel(p) {
    let s = String(p || '').trim().replace(/^file:\/\/\/?/i, '');
    try {
      s = decodeURIComponent(s);
    } catch {}
    s = s.replace(/^\/([A-Za-z]:)/, '$1').replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/');
    const ws = (S.room ? S.room.workspace : '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (ws && s.toLowerCase().startsWith(ws.toLowerCase() + '/')) return s.slice(ws.length + 1);
    return s.replace(/^\.\//, '');
  }

  function fullPath(rel) {
    if (/^([A-Za-z]:[\\/]|\/)/.test(rel)) return rel.replace(/\//g, '\\');
    const ws = S.room ? S.room.workspace : '';
    const sep = ws.includes('\\') ? '\\' : '/';
    return ws.replace(/[\\/]+$/, '') + sep + String(rel).replace(/[\\/]+/g, sep);
  }

  const fileUrl = (rel) => `/files/${encodeURIComponent(S.roomId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

  async function fileAction(p, how) {
    try {
      const r = await api('POST', `/api/rooms/${S.roomId}/files/open`, { path: toRel(p), how });
      if (r.revealed) toast(tr('这是能直接运行的文件，为了安全，先在文件夹里把它找出来'));
    } catch (e) {
      toast(e.message, true);
    }
  }

  // 复制：桌面版走系统剪贴板；浏览器里先试新接口，不行再用老办法。
  // msg：成功后的提示，传 null 就不提示（比如终端里选中复制）
  async function copyText(s, msg = tr('已复制路径')) {
    let ok = false;
    try {
      if (desktop && desktop.copy) ok = await desktop.copy(s);
      else {
        await navigator.clipboard.writeText(s);
        ok = true;
      }
    } catch {}
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {}
      ta.remove();
    }
    if (msg !== null || !ok) toast(ok ? msg : tr('复制失败，请手动复制：') + s, !ok);
  }

  // 点文件卡片或消息里的文件链接：在右侧面板里预览（能预览的直接显示，不能的给出打开方式）。
  // 可执行文件不预览，直接在文件夹里找出来
  // Word、Excel、PPT、压缩包这类在这里看不了，还是交给系统里对应的程序
  const OPEN_OUTSIDE = ['word', 'sheet', 'slide', 'archive'];
  function openFileSmart(p) {
    const rel = toRel(p);
    const t = fileType(rel);
    if (t.kind === 'exec' && !t.preview) return fileAction(rel, 'reveal');
    if (OPEN_OUTSIDE.includes(t.kind) && !t.preview) return fileAction(rel, 'open');
    return previewFile(rel);
  }

  function previewFile(rel) {
    if (!S.roomId) return;
    panel.openFile(toRel(rel));
  }

  // 小菜单（「打开方式」、标题栏菜单、右键菜单）。
  // opts.align = 'left'：和按钮左对齐；opts.x / opts.y：在鼠标位置弹出（右键菜单）
  let menuEl = null;
  let menuAnchor = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
    menuAnchor = null;
  }
  // opts.width：菜单宽度（比如和左下角的账户那一行一样宽）；opts.above：优先在按钮上方弹出
  // 菜单项 header: true 是最上面那行灰色的小字（Claude 的菜单在那里写邮箱），不能点
  function openMenu(anchor, items, opts = {}) {
    // 再点一次同一个按钮就是收起
    if (menuEl && menuAnchor === anchor && opts.x === undefined && !opts.force) return closeMenu();
    closeMenu();
    const box = el(
      `<div class="menu" role="menu">${items
        .map((it, i) =>
          it === '-'
            ? '<hr>'
            : it.header
              ? `<div class="menu-head">${esc(it.label)}</div>`
              : `<button type="button" role="menuitem" data-menu-i="${i}"${it.danger ? ' class="danger"' : ''}${it.disabled ? ' disabled' : ''}${it.checked ? ' aria-checked="true"' : ''}${
                  it.title ? ` title="${esc(it.title)}"` : ''
                }>${
                // 有图标（比如成员头像）的项，勾放在最右边；没有图标的，勾放在图标的位置
                it.icon || (it.checked ? ICONS.check : '<i class="menu-pad"></i>')
              }<span class="menu-label">${esc(it.label)}${it.desc ? `<small class="menu-desc">${esc(it.desc)}</small>` : ''}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}${
                it.icon && it.checked ? `<span class="menu-check">${ICONS.check}</span>` : ''
              }${it.sub ? `<span class="menu-sub">${ICONS.chev}</span>` : ''}</button>`
        )
        .join('')}</div>`
    );
    if (opts.width) box.style.width = Math.max(210, opts.width) + 'px';
    document.body.append(box);
    let top;
    let left;
    if (opts.x !== undefined) {
      top = opts.y + 2;
      left = opts.x + 2;
      if (top + box.offsetHeight > window.innerHeight - 8) top = Math.max(8, opts.y - box.offsetHeight - 2);
    } else {
      const r = anchor.getBoundingClientRect();
      const row = opts.width ? anchor.closest('.acct-row') || anchor : anchor;
      const rr = row.getBoundingClientRect();
      top = r.bottom + 6;
      if (opts.above || top + box.offsetHeight > window.innerHeight - 8) top = Math.max(8, rr.top - box.offsetHeight - 6);
      left = opts.align === 'left' ? rr.left : r.right - box.offsetWidth;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - box.offsetWidth - 8));
    box.style.top = top + 'px';
    box.style.left = left + 'px';
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-menu-i]');
      if (!b || b.disabled) return;
      const it = items[Number(b.dataset.menuI)];
      closeMenu();
      try {
        const r = it.run();
        if (r && r.catch) r.catch((err) => toast(err.message, true));
      } catch (err) {
        toast(err.message, true);
      }
    });
    menuEl = box;
    menuAnchor = anchor;
    const first = box.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu();
  });
  window.addEventListener('blur', () => closeMenu()); // 点到 webview、终端以外的地方也收起
  window.addEventListener('resize', () => closeMenu());
  document.addEventListener('keydown', (e) => {
    // Esc 收起成员面板，焦点回到标题栏里的成员按钮
    if (e.key === 'Escape' && $('#membersPop') && !menuEl) {
      e.stopPropagation();
      closeMembersPop();
      const chip = $('#tbMembers');
      if (chip) chip.focus();
      return;
    }
    if (!menuEl) return;
    const btns = [...menuEl.querySelectorAll('button:not(:disabled)')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      const a = menuAnchor;
      closeMenu();
      if (a && a.focus) a.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && btns.length) {
      e.preventDefault();
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
    }
  }, true);

  function fileMenu(anchor, p) {
    const rel = toRel(p);
    const t = fileType(rel);
    const items = [];
    if (t.kind !== 'exec' || t.preview) items.push({ label: tr('在右侧面板预览'), icon: ICONS.eye, run: () => previewFile(rel) });
    if (t.preview === 'html') items.push({ label: tr('在浏览器标签中打开'), icon: ICONS.web, run: () => panel.openHtmlInBrowser(rel) });
    if (t.kind !== 'exec') items.push({ label: tr('用默认程序打开'), icon: ICONS.open, run: () => fileAction(rel, 'open') });
    items.push(
      { label: tr('选择其他程序打开…'), icon: ICONS.apps, run: () => fileAction(rel, 'with') },
      { label: tr('在文件夹中显示'), icon: ICONS.folder, run: () => fileAction(rel, 'reveal') },
      '-',
      { label: tr('复制文件路径'), icon: ICONS.copy, run: () => copyText(fullPath(rel)) }
    );
    openMenu(anchor, items);
  }

  function msgNode(m) {
    if (m.kind === 'system') {
      return el(`<div class="msg system ${m.pause ? 'pause' : ''}" data-id="${m.id}">${esc(m.text)}</div>`);
    }
    const time = `<time datetime="${new Date(m.ts).toISOString()}">${fmtTime(m.ts)}</time>`;
    const copyBtn = m.text ? `<button type="button" class="act" data-copy-msg="${m.id}" title="${tr('复制')}" aria-label="${tr('复制')}">${ICONS.copy}</button>` : '';
    // 你发的消息：靠右的气泡，和 Claude 桌面版一样
    if (m.from === 'user') {
      return el(`<article class="msg user" data-id="${m.id}">
        <div class="bubble md">${md(m.text)}</div>
        <div class="foot"><span class="acts">${copyBtn}</span>${time}</div></article>`);
    }
    // 成员的发言：上面一行是头像、名字和职责，下面是正文、出错信息、文件卡片、工作过程
    const a = agentById(m.from);
    const color = a ? a.color : hashColor(m.name);
    const name = a ? a.name : m.name;
    const role = (a ? a.role : m.role) || '';
    const node = el(`<article class="msg agent" data-id="${m.id}" style="--c:${color}">
      <header class="who"><span class="avatar">${esc(initial(name))}</span><span class="who-name">${esc(name)}</span>${
        role ? `<span class="who-role">${esc(role)}</span>` : ''
      }</header>
      <div class="body"></div></article>`);
    const body = node.querySelector('.body');
    if (m.text) body.append(el(`<div class="md">${md(m.text)}</div>`));
    if (m.status === 'error') {
      body.append(el(`<div class="err"><b>${esc(tr('{name} 运行出错', { name }))}</b><pre>${esc(m.error || tr('未知错误'))}</pre></div>`));
    }
    if (m.files && m.files.length) body.append(filesNode(m));
    if (m.items && m.items.length) body.append(workNode(m.items, m.id));
    const meta = [time];
    if (m.meta && m.meta.ms) meta.push(`<span>${tr('用时 {time}', { time: fmtDur(m.meta.ms) })}</span>`);
    if (m.meta && m.meta.model) meta.push(`<span>${esc(m.meta.model)}</span>`);
    if (m.meta && m.meta.effort) meta.push(`<span>${esc(tr('思考强度 {effort}', { effort: effortName(m.meta.effort) }))}</span>`);
    if (m.status === 'stopped') meta.push(`<span class="bad">${tr('已中止')}</span>`);
    const retry = a && (m.status === 'error' || m.status === 'stopped') ? `<button type="button" class="btn small" data-poke="${a.id}">${esc(tr('让 {name} 再试一次', { name: a.name }))}</button>` : '';
    body.append(el(`<div class="foot"><span class="acts">${copyBtn}</span>${meta.join('')}${retry}</div>`));
    return node;
  }

  function emptyTranscript() {
    const list = enabledAgents();
    const d = list.find((a) => /设计|design/i.test(a.role)) || list[0];
    const dev = list.find((a) => /开发|develop/i.test(a.role) && a !== d) || list.find((a) => a !== d);
    const examples = [];
    if (d && dev) examples.push(tr('做一个待办清单网页。@{designer} 先出设计方案，写好后交给 @{developer} 实现。', { designer: d.name, developer: dev.name }));
    if (list[0]) examples.push(tr('@{name} 先看看这个文件夹里有什么，给大家讲讲项目现状。', { name: (dev || list[0]).name }));
    if (list.length > 1) examples.push(tr('@所有人 用一两句话介绍一下自己擅长做什么。'));
    // 像 Claude 桌面版的新对话：居中的问候和几条可以直接点的示例
    return el(`<div class="transcript-empty">
      <div class="te-team">${list
        .slice(0, 5)
        .map((x) => `<span class="avatar" style="--c:${x.color}" title="${esc(x.name)}">${esc(initial(x.name))}</span>`)
        .join('')}</div>
      <h2>${list.length ? tr('今天想让团队做点什么？') : tr('先给这个会话添加成员')}</h2>
      <p>${
        list.length
          ? esc(tr('用 @名字 指定由谁先做，没有 @ 的消息会交给 {name}。成员之间会自己 @ 对方交接。', { name: (agentById(S.room.settings.defaultAgent) || list[0]).name }))
          : tr('每个会话的成员是分开配的。点下面的按钮添加一个 AI，就可以开始了。')
      }</p>
      ${list.length ? '' : `<button type="button" class="btn primary" data-add-member>${ICONS.plus}${tr('添加成员')}</button>`}
      ${
        examples.length
          ? `<div class="examples">${examples
              .map((t) => `<button type="button" class="example" data-example="${esc(t)}">${ICONS.chat}<span>${md(t).replace(/^<p>|<\/p>$/g, '')}</span></button>`)
              .join('')}</div>`
          : ''
      }
    </div>`);
  }

  function renderTranscript() {
    const box = $('#transcript');
    if (!box) return;
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    if (!S.messages.length) frag.append(emptyTranscript());
    for (const m of S.messages) frag.append(msgNode(m));
    const live = el('<div id="live"></div>');
    frag.append(live);
    box.append(frag);
    S.liveKey = null;
    renderLive();
    renderTimeline();
  }

  // ---------- 左边的对话轴（像 Codex 那样）：你发的每条消息是一道刻度，正在看的那一轮最长 ----------
  // 鼠标停上去（或者用 Tab 移过去）能看到这一轮说了什么、谁接的力，点一下就跳到那条消息
  function turns() {
    const out = [];
    for (const m of S.messages) {
      if (m.kind === 'user') out.push({ user: m, replies: [] });
      else if (m.kind === 'agent' && out.length) out[out.length - 1].replies.push(m);
    }
    return out;
  }

  function renderTimeline() {
    const nav = $('#timeline');
    if (!nav) return;
    const list = turns();
    const on = list.length >= 2; // 只有一轮时用不着
    nav.hidden = !on;
    $('#main').classList.toggle('has-tl', on);
    hideTurn();
    if (!on) {
      nav.innerHTML = '';
      return;
    }
    nav.innerHTML = list
      .map((t, i) => {
        const bad = t.replies.some((r) => r.status === 'error');
        const label = tr('第 {n} 轮：{text}', { n: i + 1, text: plain(t.user.text).slice(0, 60) });
        return `<button type="button" class="tl-tick${bad ? ' err' : ''}" data-tl="${esc(t.user.id)}" aria-label="${esc(label)}"><i></i></button>`;
      })
      .join('');
    sizeTimeline();
    syncTimeline();
  }

  // 刻度的间距：轮数多时挤一挤（最小 4px），再多就让对话轴自己滚动
  function sizeTimeline() {
    const nav = $('#timeline');
    const area = $('#scrollArea');
    if (!nav || nav.hidden || !area) return;
    const n = nav.children.length || 1;
    const step = Math.max(4, Math.min(12, Math.floor((area.clientHeight - 64) / n)));
    nav.style.setProperty('--tl-step', step + 'px');
  }

  let tlFrame = 0;
  function syncTimeline() {
    if (tlFrame) return;
    tlFrame = requestAnimationFrame(() => {
      tlFrame = 0;
      const nav = $('#timeline');
      const sc = $('#scroller');
      if (!nav || nav.hidden || !sc) return;
      // 「正在看的那一轮」：最后一条已经滚到视口顶上的消息；滚到底就是最后一轮
      const line = sc.scrollTop + 64;
      let cur = nav.firstElementChild;
      for (const b of nav.children) {
        const node = sc.querySelector(`.msg[data-id="${CSS.escape(b.dataset.tl)}"]`);
        if (node && node.offsetTop <= line) cur = b;
      }
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4) cur = nav.lastElementChild;
      for (const b of nav.children) {
        const now = b === cur;
        b.classList.toggle('on', now);
        if (now) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
      if (cur && nav.scrollHeight > nav.clientHeight + 1) {
        const top = cur.offsetTop - nav.scrollTop;
        if (top < 8 || top > nav.clientHeight - 16) nav.scrollTop = cur.offsetTop - nav.clientHeight / 2;
      }
    });
  }

  function showTurn(btn) {
    const pop = $('#tlPop');
    const area = $('#scrollArea');
    const t = turns().find((x) => x.user.id === btn.dataset.tl);
    if (!pop || !area || !t) return;
    const last = t.replies[t.replies.length - 1];
    const colorOf = (m) => (agentById(m.from) || {}).color || hashColor(m.name || '');
    const chain = [];
    for (const r of t.replies) if (chain[chain.length - 1] !== r.name) chain.push(r.name);
    const reply = !last
      ? `<p class="tl-reply none">${esc(tr('还没有回复'))}</p>`
      : last.status === 'error'
        ? `<p class="tl-reply bad" style="--c:${colorOf(last)}"><b>${esc(last.name)}</b>${esc(tr('运行出错：{error}', { error: plain(last.error || tr('未知错误')).slice(0, 140) }))}</p>`
        : `<p class="tl-reply" style="--c:${colorOf(last)}"><b>${esc(last.name)}</b>${esc(plain(last.text).slice(0, 160))}</p>`;
    pop.innerHTML = `<b class="tl-title">${esc(plain(t.user.text).slice(0, 200))}</b>${reply}
      <small class="tl-meta"><span>${chain.map((n) => esc(n)).join(' → ')}</span><span>${esc(fmtTime(t.user.ts))}</span></small>`;
    // 第一次出现时直接放到位置上；之后换刻度时卡片顺着滑过去
    const first = !pop.classList.contains('show');
    pop.classList.toggle('jump', first);
    const a = area.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const top = b.top - a.top + b.height / 2 - pop.offsetHeight / 2;
    pop.style.top = Math.max(8, Math.min(area.clientHeight - pop.offsetHeight - 8, top)) + 'px';
    pop.classList.add('show');
    if (first) requestAnimationFrame(() => pop.classList.remove('jump'));
  }

  function hideTurn() {
    const pop = $('#tlPop');
    if (pop) pop.classList.remove('show');
    tlHot = null;
  }

  // 像 macOS 程序坞那样：离鼠标越近的刻度越长，最近的那道是白色的。
  // 每道刻度的长度都有过渡动画，鼠标划过时会拖出一条慢慢缩回去的尾巴
  let tlHot = null;
  function applyLens(nav, y) {
    const ticks = [...nav.children];
    if (!ticks.length) return;
    // 先把位置都读出来再改样式，免得每改一道就重新排一次版
    const mids = ticks.map((b) => {
      const r = b.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    // 影响范围大约上下各四道（和 Codex 一样，一道比一道短）
    const radius = Math.max(40, (ticks[0].offsetHeight || 12) * 4.3);
    let hot = 0;
    mids.forEach((m, i) => {
      if (Math.abs(y - m) < Math.abs(y - mids[hot])) hot = i;
    });
    ticks.forEach((b, i) => {
      const k = Math.max(0, 1 - Math.abs(y - mids[i]) / radius);
      b.style.setProperty('--k', k.toFixed(3));
      b.classList.toggle('hot', i === hot);
    });
    if (ticks[hot] !== tlHot) {
      tlHot = ticks[hot];
      showTurn(tlHot);
    }
  }

  function clearLens(nav) {
    for (const b of nav.children) {
      b.style.removeProperty('--k');
      b.classList.remove('hot');
    }
    hideTurn();
  }

  function jumpToTurn(id) {
    const sc = $('#scroller');
    const node = sc && sc.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
    if (!node) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    sc.scrollTo({ top: Math.max(0, node.offsetTop - 20), behavior: still ? 'auto' : 'smooth' });
    // 跳过去之后让那条消息亮一下，知道是哪条
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  }

  function setupTimeline() {
    const nav = $('#timeline');
    if (!nav) return;
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tl]');
      if (b) jumpToTurn(b.dataset.tl);
    });
    let frame = 0;
    let lastY = 0;
    nav.addEventListener('mousemove', (e) => {
      lastY = e.clientY;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          applyLens(nav, lastY);
        });
    });
    nav.addEventListener('mouseleave', () => {
      cancelAnimationFrame(frame);
      frame = 0;
      clearLens(nav);
    });
    // 用 Tab 移到刻度上：和鼠标停在那里一样
    nav.addEventListener('focusin', (e) => {
      const b = e.target.closest('[data-tl]');
      if (!b) return;
      const r = b.getBoundingClientRect();
      applyLens(nav, r.top + r.height / 2);
    });
    nav.addEventListener('focusout', () => clearLens(nav));
  }

  const nearBottom = () => {
    const s = $('#scroller');
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  };
  const scrollToBottom = () => {
    const s = $('#scroller');
    if (s) s.scrollTop = s.scrollHeight;
    const j = $('#jump');
    if (j) j.hidden = true;
  };
  function keepBottom(fn) {
    const stick = nearBottom();
    fn();
    if (stick) scrollToBottom();
    else if ($('#jump')) $('#jump').hidden = false;
  }

  function addMessage(m) {
    if (S.messages.some((x) => x.id === m.id)) return;
    S.messages.push(m);
    const box = $('#transcript');
    if (!box) return;
    keepBottom(() => {
      const empty = box.querySelector('.transcript-empty');
      if (empty) empty.remove();
      box.insertBefore(msgNode(m), $('#live'));
    });
    if (m.kind === 'user' || m.kind === 'agent') renderTimeline();
  }

  function renderLive() {
    const live = $('#live');
    if (!live) return;
    const p = S.progress;
    if (!p) {
      if (S.liveKey) keepBottom(() => (live.innerHTML = ''));
      S.liveKey = null;
      return;
    }
    const key = p.agentId + ':' + p.startedAt;
    const a = agentById(p.agentId);
    const name = a ? a.name : tr('成员');
    keepBottom(() => {
      if (S.liveKey !== key) {
        S.liveKey = key;
        live.innerHTML = '';
        live.append(
          el(`<article class="msg agent live" style="--c:${a ? a.color : '#888'}">
            <header class="who"><span class="avatar">${esc(initial(name))}</span><span class="who-name">${esc(name)}</span>${
              a && a.role ? `<span class="who-role">${esc(a.role)}</span>` : ''
            }</header>
            <div class="body">
              <div class="live-status"><span class="now"></span><span class="elapsed" data-since="${p.startedAt}"></span>
                <button type="button" class="btn small" data-stop>${tr('停止')}</button></div>
              <ol class="work-list live-items" hidden></ol>
              <div class="md live-text" hidden></div>
            </div></article>`)
        );
      }
      live.querySelector('.now').textContent = p.status || tr('工作中');
      live.querySelector('.elapsed').textContent = fmtClock(Date.now() - p.startedAt);
      const list = live.querySelector('.live-items');
      const items = (p.items || []).slice(-8);
      const more = (p.total || 0) - items.length;
      list.hidden = !items.length;
      list.innerHTML = (more > 0 ? `<li class="work-more">${tr('前面还有 {n} 步', { n: more })}</li>` : '') + items.map(workItem).join('');
      const txt = live.querySelector('.live-text');
      txt.hidden = !p.live;
      if (p.live) txt.innerHTML = md(p.live);
    });
  }

  setInterval(() => {
    const e = $('#live .elapsed');
    if (e) e.textContent = fmtClock(Date.now() - Number(e.dataset.since));
  }, 1000);

  // ---------- 输入区 ----------
  function previewTargets(text) {
    const list = enabledAgents();
    if (!list.length) return { ids: [], how: 'none' };
    let ids = parseMentions(text, list);
    if (ids.includes('all')) ids = [...ids.filter((x) => x !== 'all'), ...list.map((a) => a.id)];
    ids = [...new Set(ids)].filter((x) => x !== 'user' && x !== 'all');
    if (ids.length) return { ids, how: 'mention' };
    const st = S.state || {};
    if (st.running) return { ids: [st.running.agentId], how: 'running' };
    if (st.queue && st.queue.length) return { ids: [], how: 'queue' };
    const def = list.find((a) => a.id === S.room.settings.defaultAgent) || list[0];
    return { ids: [def.id], how: 'default' };
  }

  function updateTo() {
    const to = $('#to');
    const input = $('#input');
    if (!to || !input) return;
    const { ids, how } = previewTargets(getText(input));
    // 没 @ 人、也没有人在接力时，消息交给项目的默认接收人：做成一个按钮（像 Claude 的模型选择），点开换成员。
    // 还没有成员时，按钮就是「添加成员」
    if (how === 'default' || how === 'none') {
      const a = agentById(ids[0]);
      const html = a
        ? `<button type="button" class="to-pick" data-to-pick aria-haspopup="menu" title="${esc(tr('没有 @ 任何人时发给谁，点一下可以换成员'))}">
            <span class="avatar xs" style="--c:${a.color}">${esc(initial(a.name))}</span><span class="to-name">${esc(a.name)}</span>${ICONS.chevDown}</button>`
        : `<button type="button" class="to-pick" data-add-member title="${esc(tr('添加成员'))}">${ICONS.plus}<span class="to-name">${esc(tr('添加成员'))}</span></button>`;
      // 每打一个字都会调这里：内容没变就不重画，免得打开着的菜单找不到按钮
      if (to._html !== html) {
        to.innerHTML = html;
        to._html = html;
      }
      to.title = '';
      updateSendBtn();
      return;
    }
    to._html = '';
    const names = ids
      .map((id) => agentById(id))
      .filter(Boolean)
      .map((a) => `<b style="--c:${a.color}">${esc(a.name)}</b>`)
      .join(tr('、'));
    // 就在发送按钮旁边，写短一点；完整的解释放在鼠标悬停的提示里
    const text =
      how === 'queue'
        ? tr('排队的成员接着做时会看到')
        : how === 'running'
          ? tr('发给 {names}，做完手上这一步就会看到', { names })
          : tr('发给 {names}', { names }) + (ids.length > 1 ? tr('，轮流做') : '');
    to.innerHTML = `<span class="to-text">${text}</span>`;
    to.title = how === 'mention' && ids.length > 1 ? tr('按 @ 的顺序一个接一个做') : '';
    updateSendBtn();
  }

  // 输入框右下角的成员选择：列出这个项目里参与接力的成员，选中的就是项目的「默认接收人」（项目设置里也能改）
  function toPicker(anchor) {
    const list = enabledAgents();
    const cur = (list.find((a) => a.id === S.room.settings.defaultAgent) || list[0] || {}).id;
    openMenu(
      anchor,
      [
        { label: tr('没有 @ 任何人时，发给'), header: true },
        ...list.map((a) => ({
          label: a.name,
          desc: [a.role, a.model ? modelName(a.adapter, a.model) : adapterLabel(a)].filter(Boolean).join(' · '),
          icon: `<span class="avatar sm" style="--c:${a.color}">${esc(initial(a.name))}</span>`,
          checked: a.id === cur,
          run: () => setDefaultAgent(a.id),
        })),
        '-',
        { label: tr('添加成员'), icon: ICONS.plus, run: () => memberModal(null) },
      ],
      { align: 'right', above: true }
    );
  }

  async function setDefaultAgent(id) {
    if (S.room.settings.defaultAgent === id) return;
    const roomId = S.roomId;
    const room = await api('PATCH', `/api/rooms/${roomId}`, { settings: { defaultAgent: id } });
    if (S.roomId !== roomId) return;
    S.room = room; // 服务端还会推一次 room 事件（会重画其余部分），这里先换上，按钮马上就变
    updateTo();
  }

  // 发送按钮：有内容时发送；没内容并且成员正在接力时，变成「停止接力」（和 Claude 桌面版一样）
  function updateSendBtn() {
    const btn = $('#sendBtn');
    if (!btn) return;
    const st = S.state || {};
    const busy = (!!st.running || (st.queue || []).length > 0) && !st.paused;
    const has = !!getText().trim();
    const mode = !has && busy ? 'stop' : 'send';
    const sig = mode + (has ? '1' : '0');
    if (btn.dataset.sig === sig) return;
    btn.dataset.sig = sig;
    btn.dataset.mode = mode;
    btn.disabled = mode === 'send' && !has;
    btn.classList.toggle('stop', mode === 'stop');
    btn.innerHTML = mode === 'stop' ? ICONS.stopSq : ICONS.arrowUp;
    btn.title = mode === 'stop' ? tr('停止接力') : tr('发送（Enter）');
    btn.setAttribute('aria-label', btn.title);
  }

  // 输入框下面的 @ 和 / 按钮：在光标处插入，弹出成员或技能列表
  function insertTrigger(ch) {
    const input = inputEl();
    if (!input) return;
    input.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !input.contains(sel.anchorNode)) caretToEnd(input);
    const before = textBeforeCaret() || '';
    const prev = before.slice(-1);
    const needSpace = prev && (ch === '@' ? MENTION_BEFORE.test(prev) : !SKILL_BEFORE.test(prev));
    document.execCommand('insertText', false, (needSpace ? ' ' : '') + ch);
    onComposerInput();
  }

  function renderComposerState() {
    const st = S.state || {};
    const banner = $('#banner');
    if (banner) {
      if (st.paused) {
        const names = [...new Set((st.queue || []).map((q) => agentById(q.agentId)).filter(Boolean).map((a) => a.name))].join(tr('、'));
        banner.hidden = false;
        const f = st.pauseReason === 'error' && st.failed;
        banner.classList.toggle('error', !!f);
        banner.innerHTML = f
          ? `<span class="grow">${tr('{name} 运行出错，接力已暂停，排在后面的 {names} 先不做。处理好后让它再试一次，就会从这一步接着往下做。', { name: `<b>${esc(f.name)}</b>`, names: esc(names) })}</span>
            <button class="btn small primary" data-poke="${esc(f.agentId)}">${esc(tr('让 {name} 再试一次', { name: f.name }))}</button>
            <button class="btn small" data-continue>${tr('跳过，继续接力')}</button><button class="btn small" data-stop>${tr('停止')}</button>`
          : `<span class="grow">${tr('AI 之间已经自动接力 {n} 轮，先停下来等你看一眼。接下来轮到 {names}。', { n: st.autoTurns, names: esc(names) })}</span>
            <button class="btn small primary" data-continue>${tr('继续接力')}</button><button class="btn small" data-stop>${tr('停止')}</button>`;
      } else {
        banner.hidden = true;
        banner.innerHTML = '';
      }
    }
    updateTo();
  }

  // ---------- 输入框 ----------
  // 用可编辑的 div 代替 textarea：@成员 和 /技能 显示成带颜色的整块标签（contenteditable=false），
  // 退格一次就删掉整个标签。发送时再还原成纯文字 @名字、/技能名。
  let pop = { open: false, kind: '', items: [], index: 0, query: '' };
  const inputEl = () => $('#input');
  const MENTION_BEFORE = /[A-Za-z0-9_.]/; // 和服务端一样：@ 前面紧挨着这些字符时不算 @（比如邮箱）
  const SKILL_BEFORE = /[\s(（,，。!！?？:：;；、]/;

  // opaque：把标签当成一个占位字符，用来判断光标前是不是正在输入 @xxx，免得把已经是标签的名字又当成在输入
  function nodeText(node, root, opaque) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    if (node.nodeType !== 1) return '';
    if (node.dataset && node.dataset.token) return opaque ? '\u0001' : node.dataset.token;
    if (node.tagName === 'BR') return '\n';
    let s = '';
    for (const c of node.childNodes) s += nodeText(c, root, opaque);
    // 粘贴或换行时浏览器可能包一层 div：除了第一块，每块前面换一行
    if ((node.tagName === 'DIV' || node.tagName === 'P') && node !== root && node.previousSibling) s = '\n' + s;
    return s;
  }

  function getText(root = inputEl(), opaque = false) {
    if (!root) return '';
    let s = '';
    for (const c of root.childNodes) s += nodeText(c, root, opaque);
    return s;
  }

  // 可以变成标签的词：成员名、@所有人/@用户，以及本机装好的技能
  function tokenKeys() {
    return [
      ...agents().map((a) => ({ key: '@' + a.name, kind: 'mention', color: a.color })),
      ...[...ALL_ALIASES, ...USER_ALIASES].map((k) => ({ key: '@' + k, kind: 'mention', color: '' })),
      ...(S.skills || []).map((s) => ({ key: '/' + s.name, kind: 'skill', color: '' })),
    ].sort((x, y) => y.key.length - x.key.length);
  }

  // 找出文字里所有完整的 @成员 / /技能（规则和服务端一致：中文后面的 @ 也算）
  function findTokens(text) {
    const keys = tokenKeys();
    const lower = text.toLowerCase();
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== '@' && ch !== '/') continue;
      const prev = text[i - 1];
      if (ch === '@' ? prev && MENTION_BEFORE.test(prev) : prev && !SKILL_BEFORE.test(prev)) continue;
      const k = keys.find((x) => {
        if (x.key[0] !== ch || !lower.startsWith(x.key.toLowerCase(), i)) return false;
        const next = text[i + x.key.length];
        return !(/[A-Za-z0-9_]$/.test(x.key) && next && /[A-Za-z0-9_-]/.test(next));
      });
      if (!k) continue;
      out.push({ start: i, end: i + k.key.length, kind: k.kind, key: k.key, color: k.color });
      i += k.key.length - 1;
    }
    return out;
  }

  // 把纯文字切成「文字」和「标签」两种片段
  function tokenize(text) {
    const out = [];
    let last = 0;
    for (const t of findTokens(text)) {
      if (t.start > last) out.push({ t: 'text', v: text.slice(last, t.start) });
      out.push({ t: t.kind, v: t.key, color: t.color });
      last = t.end;
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
    return out;
  }

  // 手动打出来的 @名字、/技能：后面已经接着打了别的字，就变成标签（还在打的名字先不动）
  function autoChip() {
    const sel = window.getSelection();
    const root = inputEl();
    if (!root || !sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || !root.contains(node)) return;
    const text = node.nodeValue;
    const toks = findTokens(text).filter((t) => t.end < text.length);
    if (!toks.length) return;
    const caret = sel.anchorOffset;
    const frag = document.createDocumentFragment();
    let last = 0;
    let caretNode = null;
    let caretOff = 0;
    const addText = (s, from) => {
      if (!s) return;
      const tn = document.createTextNode(s);
      frag.append(tn);
      if (!caretNode && caret >= from && caret <= from + s.length) {
        caretNode = tn;
        caretOff = caret - from;
      }
    };
    for (const t of toks) {
      addText(text.slice(last, t.start), last);
      frag.append(el(chipHtml(t.kind, t.key, t.color)));
      last = t.end;
    }
    addText(text.slice(last), last);
    const lastNode = frag.lastChild;
    node.replaceWith(frag);
    const r = document.createRange();
    if (caretNode) r.setStart(caretNode, caretOff);
    else r.setStartAfter(lastNode);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  const chipHtml = (kind, token, color) =>
    `<span class="tok tok-${kind}" contenteditable="false" data-token="${esc(token)}"${color ? ` style="--c:${color}"` : ''}>${esc(token)}</span>`;

  function textToHtml(text) {
    return tokenize(String(text || ''))
      .map((p) => (p.t === 'text' ? esc(p.v).replace(/\n/g, '<br>') : chipHtml(p.t, p.v, p.color)))
      .join('');
  }

  function caretToEnd(el) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function setText(text) {
    const el = inputEl();
    if (!el) return;
    el.innerHTML = textToHtml(text);
  }

  // 光标前面的文字。标签算成一个占位字符：光标紧跟在标签后面时，不会被当成正在输入 @名字
  function textBeforeCaret() {
    const el = inputEl();
    const sel = window.getSelection();
    if (!el || !sel.rangeCount || !el.contains(sel.anchorNode)) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    const cur = sel.getRangeAt(0);
    r.setEnd(cur.endContainer, cur.endOffset);
    const box = document.createElement('div');
    box.append(r.cloneContents());
    return getText(box, true);
  }

  function normalizeEmpty() {
    const el = inputEl();
    if (el && !getText(el).trim() && el.childNodes.length && !el.querySelector('.tok')) el.innerHTML = '';
  }

  function onComposerInput(e) {
    if (e && e.isComposing) return;
    normalizeEmpty();
    autoChip();
    S.drafts[S.roomId] = getText();
    updateTo();
    updatePop();
  }

  function setupComposer() {
    const form = $('#composer');
    const el = inputEl();
    if (!form || !el) return;
    setText(S.drafts[S.roomId] || '');
    updateTo();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send();
    });
    $('#sendBtn').addEventListener('click', () => {
      if ($('#sendBtn').dataset.mode === 'stop') api('POST', `/api/rooms/${S.roomId}/stop`).catch((err) => toast(err.message, true));
      else send();
    });
    for (const b of form.querySelectorAll('[data-insert]')) {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 不让输入框失去焦点和光标位置
      b.addEventListener('click', () => insertTrigger(b.dataset.insert));
    }
    // 点输入框四周的空白也能开始打字（输入框本身只有一行高）
    form.addEventListener('mousedown', (e) => {
      if (e.target === form || e.target.classList.contains('composer-row') || e.target.id === 'to') {
        e.preventDefault();
        caretToEnd(el);
      }
    });
    el.addEventListener('input', onComposerInput);
    el.addEventListener('compositionend', () => onComposerInput());
    el.addEventListener('click', updatePop);
    el.addEventListener('blur', () => setTimeout(closePop, 150));
    // 只接受纯文字，粘贴进来的 @成员 /技能 也变成标签
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (text) document.execCommand('insertHTML', false, textToHtml(text));
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (!text) return;
      const r = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      document.execCommand('insertHTML', false, textToHtml(text));
    });
    el.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 中文输入法选词时不要发送
      if (pop.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          pop.index = (pop.index + (e.key === 'ArrowDown' ? 1 : -1) + pop.items.length) % pop.items.length;
          drawPop();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          pickPop(pop.items[pop.index]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closePop();
          return;
        }
        // 手动打完整个名字再按空格，也变成标签
        if (e.key === ' ') {
          const exact = pop.items.find((o) => o.name.toLowerCase() === pop.query.toLowerCase());
          if (exact) {
            e.preventDefault();
            pickPop(exact);
            return;
          }
        }
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (deleteChip(e.key === 'Backspace')) {
          e.preventDefault();
          onComposerInput();
          return;
        }
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 设置里可以选「Ctrl+Enter 发送，Enter 换行」
        const ctrlMode = S.settings && S.settings.sendKey === 'ctrl-enter';
        if (ctrlMode) {
          if (e.ctrlKey || e.metaKey) send();
          else document.execCommand('insertLineBreak');
        } else if (e.shiftKey) document.execCommand('insertLineBreak');
        else if (!e.ctrlKey && !e.altKey) send();
      }
    });
  }

  // 光标紧挨着标签时，退格（或 Delete）一次删掉整个标签
  function deleteChip(backward) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    let node = sel.anchorNode;
    let off = sel.anchorOffset;
    const el = inputEl();
    if (!el || !el.contains(node)) return false;
    let target = null;
    if (node.nodeType === 3) {
      if (backward && off === 0) target = node.previousSibling;
      else if (!backward && off === node.nodeValue.length) target = node.nextSibling;
    } else {
      target = backward ? node.childNodes[off - 1] : node.childNodes[off];
    }
    if (!target || target.nodeType !== 1 || !target.classList.contains('tok')) return false;
    const r = document.createRange();
    r.selectNode(target);
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('delete'); // 用编辑命令删，Ctrl+Z 还能撤销
    return true;
  }

  function updatePop() {
    const before = textBeforeCaret();
    if (before === null) return closePop();
    let m = before.match(/(?:^|[^A-Za-z0-9_.])@([^\s@/]*)$/);
    let kind = 'mention';
    if (!m) {
      m = before.match(/(?:^|[\s(（,，。!！?？:：;；、])\/([\w.:-]*)$/);
      kind = 'skill';
    }
    if (!m) return closePop();
    const q = m[1].toLowerCase();
    let items;
    if (kind === 'mention') {
      items = enabledAgents()
        .map((a) => ({ kind, name: a.name, sub: a.role || adapterLabel(a), color: a.color }))
        .concat(enabledAgents().length > 1 ? [{ kind, name: tr('所有人'), sub: tr('每位成员按顺序轮流'), all: true }] : [])
        .filter((o) => o.name.toLowerCase().startsWith(q));
    } else {
      items = (S.skills || [])
        .filter((s) => s.name.toLowerCase().includes(q))
        .sort((a, b) => b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q))
        .slice(0, 50)
        .map((s) => ({ kind, name: s.name, sub: s.description, tag: s.tools.length ? s.tools.map((t) => (ADAPTERS[t] ? ADAPTERS[t].label : t)).join(tr('、')) : tr('通用') }));
    }
    if (!items.length) return closePop();
    if (pop.kind !== kind || pop.query !== q) pop.index = 0;
    pop = { open: true, kind, items, index: Math.min(pop.index, items.length - 1), query: m[1] };
    drawPop();
  }

  function drawPop() {
    const box = $('#mentionPop');
    box.hidden = false;
    box.classList.toggle('skills', pop.kind === 'skill');
    box.innerHTML =
      (pop.kind === 'skill' ? `<div class="pop-head">${tr('技能：让接手的成员按这个技能来做')}</div>` : '') +
      pop.items
        .map((o, i) => {
          const icon =
            o.kind === 'skill'
              ? '<span class="avatar sm skill">/</span>'
              : o.all
                ? `<span class="avatar sm me">${tr('全')}</span>`
                : `<span class="avatar sm">${esc(initial(o.name))}</span>`;
          return `<button type="button" class="mention-opt" role="option" aria-selected="${i === pop.index}" data-pick="${i}"${o.color ? ` style="--c:${o.color}"` : ''}>
            ${icon}<span class="opt-name">${esc(o.kind === 'skill' ? '/' + o.name : o.name)}</span><small>${esc(o.sub || '')}</small>${o.tag ? `<em>${esc(o.tag)}</em>` : ''}</button>`;
        })
        .join('');
    const cur = box.querySelector('[aria-selected="true"]');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function closePop() {
    pop = { open: false, kind: '', items: [], index: 0, query: '' };
    const box = $('#mentionPop');
    if (box) box.hidden = true;
  }

  // 把光标前正在输入的 @xxx 或 /xxx 换成标签
  function pickPop(o) {
    if (!o) return;
    const el = inputEl();
    const len = pop.query.length + 1;
    const sel = window.getSelection();
    el.focus();
    if (sel.rangeCount) {
      const cur = sel.getRangeAt(0);
      const node = cur.endContainer;
      const off = cur.endOffset;
      if (node.nodeType === 3 && off >= len) {
        const r = document.createRange();
        r.setStart(node, off - len);
        r.setEnd(node, off);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        for (let i = 0; i < len; i++) document.execCommand('delete');
      }
    }
    const token = (o.kind === 'skill' ? '/' : '@') + o.name;
    document.execCommand('insertHTML', false, chipHtml(o.kind, token, o.color || '') + ' ');
    closePop();
    onComposerInput();
  }

  // 点成员旁边的 @：在输入框末尾加上这个成员
  function insertMention(name) {
    const el = inputEl();
    const a = agents().find((x) => x.name === name);
    if (!el) return;
    caretToEnd(el);
    const text = getText(el);
    const sep = text && !/\s$/.test(text) ? ' ' : '';
    document.execCommand('insertHTML', false, esc(sep) + chipHtml('mention', '@' + name, a ? a.color : '') + ' ');
    closePop();
    onComposerInput();
  }

  async function send() {
    const el = inputEl();
    const text = getText(el).trim();
    if (!text || !S.roomId) return;
    const roomId = S.roomId;
    el.innerHTML = '';
    S.drafts[roomId] = '';
    updateTo();
    closePop();
    try {
      const msg = await api('POST', `/api/rooms/${roomId}/messages`, { text });
      if (roomId === S.roomId) {
        addMessage(msg);
        scrollToBottom();
      }
    } catch (e) {
      if (!getText(el).trim()) setText(text);
      S.drafts[roomId] = getText(el);
      toast(e.message, true);
    }
  }

  async function loadSkills(roomId, force) {
    try {
      const list = await api('GET', `/api/skills?room=${encodeURIComponent(roomId || '')}${force ? '&refresh=1' : ''}`);
      if (roomId === S.roomId) S.skills = list;
    } catch {}
  }

  // ---------- 打开项目 ----------
  async function openRoom(id, opts = {}) {
    S.loading = id;
    try {
      const data = await api('GET', `/api/rooms/${id}`);
      if (S.loading !== id) return;
      if (!opts.fromHistory && S.roomId !== id) {
        // 像浏览器一样：从中间位置打开新项目，后面的「前进」记录就不要了
        S.nav.list = S.nav.list.slice(0, S.nav.i + 1).filter((x) => x !== id);
        S.nav.list.push(id);
        if (S.nav.list.length > 50) S.nav.list.shift();
        S.nav.i = S.nav.list.length - 1;
      }
      closeMembersPop();
      S.roomId = id;
      S.room = data.room;
      S.projectId = data.room.projectId || null;
      // 打开的会话所在的项目要展开，不然在左边找不到它
      if (S.projectId && collapsed.has(S.projectId)) {
        collapsed.delete(S.projectId);
        saveCollapsed();
      }
      S.messages = data.messages;
      S.state = data.state;
      S.progress = data.progress && data.progress.running;
      S.skills = [];
      await loadSkills(id); // 先读技能列表，草稿里的 /技能 才能显示成标签
      if (S.roomId !== id) return;
      local.set('agentchat.room', id);
      $('#app').classList.remove('rail-open');
      renderProjects();
      renderMembers();
      renderMain();
      renderHeader();
      panel.onRoom();
      // 在后台读取模型目录，成员列表里就能显示模型的正式名字
      for (const ad of new Set(agents().map((a) => a.adapter).filter((x) => x !== 'openai'))) {
        if (!S.catalogs[ad]) loadCatalog(ad).then(() => id === S.roomId && renderMembers());
      }
    } catch (e) {
      toast(e.message, true);
    }
  }

  // 项目和它们的会话；S.rooms 是所有会话摊平以后按最近动过排的列表
  function setProjects(list) {
    S.projects = Array.isArray(list) ? list : [];
    S.rooms = S.projects.flatMap((p) => p.rooms).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function refreshRooms() {
    setProjects(await api('GET', '/api/projects'));
    renderProjects();
    updateTitlebar();
  }

  function toggleProject(pid) {
    if (collapsed.has(pid)) collapsed.delete(pid);
    else collapsed.add(pid);
    saveCollapsed();
    renderProjects();
  }

  // 在项目里新建会话：先在弹窗里起名字（不填就等发第一条消息时自动起），再选成员从哪来。
  // 默认照搬 from 那个会话的成员（没有就用项目里最近的会话），也可以用团队模板，或者先空着
  function newConversation(pid, from) {
    const p = projectById(pid);
    if (!p) return;
    const src = (from && p.rooms.find((r) => r.id === from)) || p.rooms[0] || null;
    const copy = !!(src && src.agents.length);
    const noCli = !templatePreview('duo').length;
    const def = copy ? 'copy' : noCli ? 'blank' : 'duo';
    const choice = (value, title, inner, disabled) =>
      `<label class="choice"><input type="radio" name="nc-team" value="${value}"${value === def ? ' checked' : ''}${disabled ? ' disabled' : ''}><b>${esc(title)}</b>${inner}</label>`;
    const body = el(`<form>
      <div class="field"><label for="nc-name">${tr('会话名称')}</label>
        <input class="input" id="nc-name" autofocus maxlength="40" placeholder="${esc(tr('不填的话，发第一条消息时自动起名字'))}"></div>
      <div class="field"><span class="label">${tr('成员')}</span>
        <div class="choices">
          ${copy ? choice('copy', tr('照搬「{name}」的成员', { name: src.name }), `<span class="team">${teamLine(src.agents)}</span>`) : ''}
          ${choice('duo', tr('设计 + 开发'), `<span class="team">${teamLine(templatePreview('duo')) || `<span>${tr('没检测到命令行 AI')}</span>`}</span>`, noCli)}
          ${choice('trio', tr('设计 + 开发 + 审查'), `<span class="team">${teamLine(templatePreview('trio')) || `<span>${tr('没检测到命令行 AI')}</span>`}</span>`, noCli)}
          ${choice('blank', tr('空白'), `<span>${tr('先不加成员，之后自己添加（比如接入 DeepSeek 等 API 模型）')}</span>`)}
        </div>
        <span class="hint">${tr('每个会话的成员是分开的，建好以后可以在标题栏的成员面板里改。')}</span></div>
    </form>`);
    const m = openModal({ title: tr('新建会话'), desc: tr('在项目「{name}」里', { name: p.name }), body, wide: true });
    let busy = false; // 回车和点按钮连着来时只建一个
    const create = async () => {
      if (busy) return;
      busy = true;
      try {
        const pick = (body.querySelector('input[name=nc-team]:checked') || {}).value || 'blank';
        const room = await api('POST', `/api/projects/${p.id}/rooms`, {
          name: $('#nc-name', body).value,
          ...(pick === 'copy' ? { from: src.id } : { template: pick }),
        });
        m.close();
        await refreshRooms();
        await openRoom(room.id);
        const input = $('#input');
        if (input) input.focus();
      } finally {
        busy = false;
      }
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      create().catch((err) => toast(err.message, true));
    });
    footButtons(m, ['spacer', { label: tr('取消') }, { label: tr('创建会话'), kind: 'primary', onClick: create }]);
  }

  // 置顶 / 取消置顶：服务端会把它放到那一组的最上面，然后推送新的列表
  function pinConversation(r, on) {
    return api('PATCH', `/api/rooms/${r.id}`, { pinned: on });
  }

  // 左边栏里任意一个会话的设置：先打开它，设置弹窗用的是当前会话
  async function conversationSettings(id) {
    if (S.roomId !== id) await openRoom(id);
    if (S.roomId === id) settingsModal();
  }

  // 重命名会话：默认是当前会话，左边栏右键菜单里传的是那一行的会话
  function renameConversation(room) {
    const r = room || S.room;
    if (!r) return;
    const body = el(`<form><div class="field"><label for="rn-name">${tr('会话名称')}</label>
      <input class="input" id="rn-name" maxlength="40" value="${esc(r.name)}" autofocus></div></form>`);
    const m = openModal({ title: tr('重命名会话'), body });
    const save = async () => {
      await api('PATCH', `/api/rooms/${r.id}`, { name: $('#rn-name', body).value });
      m.close();
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      save().catch((err) => toast(err.message, true));
    });
    footButtons(m, ['spacer', { label: tr('取消') }, { label: tr('保存'), kind: 'primary', onClick: save }]);
    setTimeout(() => $('#rn-name', body).select(), 0);
  }

  // 删掉会话以后：打开同一个项目里的另一个会话；没有了就停在这个项目的空白页
  async function afterRoomGone(pid) {
    S.room = null;
    S.roomId = null;
    S.projectId = pid;
    await refreshRooms();
    const p = projectById(pid);
    if (p && p.rooms[0]) return openRoom(p.rooms[0].id);
    if (!p) {
      S.projectId = null;
      if (S.rooms[0]) return openRoom(S.rooms[0].id);
    }
    renderMembers();
    renderMain();
    renderHeader();
    panel.onRoom();
  }

  async function deleteConversation(r) {
    const ok = await confirmBox(tr('删除会话'), tr('确定删除会话「{name}」？聊天记录会一起删掉，项目文件夹里的文件不会动。', { name: r.name }), tr('删除会话'), true);
    if (!ok) return false;
    await api('DELETE', `/api/rooms/${r.id}`);
    // 删的是正在看的会话才要换到别的会话；删左边栏里别的会话，只刷新列表
    if (r.id === S.roomId) await afterRoomGone(r.projectId);
    else await refreshRooms();
    toast(tr('会话已删除'));
    return true;
  }

  async function deleteProject(pid) {
    const p = projectById(pid);
    if (!p) return;
    const ok = await confirmBox(
      tr('删除项目'),
      tr('确定删除项目「{name}」和它里面的 {n} 个会话？项目文件夹里的文件不会被删除。', { name: p.name, n: p.rooms.length }),
      tr('删除项目'),
      true
    );
    if (!ok) return;
    try {
      await api('DELETE', `/api/projects/${pid}`);
      if (S.projectId === pid) {
        S.room = null;
        S.roomId = null;
        S.projectId = null;
      }
      await refreshRooms();
      if (!S.roomId) {
        if (S.rooms[0]) await openRoom(S.rooms[0].id);
        else {
          renderMembers();
          renderMain();
          renderHeader();
          panel.onRoom();
        }
      }
      toast(tr('项目已删除'));
    } catch (e) {
      toast(e.message, true);
    }
  }

  // 项目设置：名字和文件夹（项目里所有会话共用这个文件夹）
  function projectSettingsModal(pid) {
    const p = projectById(pid);
    if (!p) return;
    const body = el(`<form>
      <div class="field"><label for="pj-name">${tr('项目名称')}</label><input class="input" id="pj-name" maxlength="40" value="${esc(p.name)}"></div>
      <div class="field"><label for="pj-ws">${tr('项目文件夹')}</label>
        <div class="row"><input class="input mono grow" id="pj-ws" value="${esc(p.workspace)}"><button type="button" class="btn" data-browse>${tr('浏览…')}</button></div>
        <span class="hint">${tr('项目里的 {n} 个会话都在这个文件夹里工作。', { n: p.rooms.length })}</span>
        <span class="hint warn" id="pj-ws-warn" hidden>${tr('换了文件夹以后，所有会话里的成员都会从头开始（重新读一遍聊天记录）。')}</span></div>
      <div class="danger-zone"><div class="row"><button type="button" class="btn danger" data-delete>${tr('删除项目')}</button></div>
        <p class="hint" style="margin:8px 0 0">${tr('删除项目会删掉它里面所有会话的记录，不会动项目文件夹里的文件。')}</p></div>
    </form>`);
    const m = openModal({ title: tr('项目设置'), body, wide: true });
    const ws = $('#pj-ws', body);
    ws.addEventListener('input', () => ($('#pj-ws-warn', body).hidden = ws.value.trim() === p.workspace));
    $('[data-browse]', body).addEventListener('click', async () => {
      const picked = await pickFolderAny(ws.value);
      if (picked) {
        ws.value = picked;
        ws.dispatchEvent(new Event('input'));
      }
    });
    $('[data-delete]', body).addEventListener('click', async () => {
      m.close();
      await deleteProject(p.id);
    });
    const save = async () => {
      await api('PATCH', `/api/projects/${p.id}`, { name: $('#pj-name', body).value, workspace: ws.value, create: true });
      m.close();
      await refreshRooms();
      toast(tr('已保存'));
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      save().catch((err) => toast(err.message, true));
    });
    footButtons(m, ['spacer', { label: tr('取消') }, { label: tr('保存'), kind: 'primary', onClick: save }]);
  }

  // ---------- 弹窗 ----------
  const modals = [];
  function openModal({ title, desc, body, wide }) {
    const back = el(`<div class="backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>
      <div class="modal-body"></div><div class="modal-foot"></div></div></div>`);
    back.querySelector('.modal-body').append(body);
    $('#modalRoot').append(back);
    const prev = document.activeElement;
    const m = {
      back,
      body: back.querySelector('.modal-body'),
      foot: back.querySelector('.modal-foot'),
      close() {
        back.remove();
        const i = modals.indexOf(m);
        if (i >= 0) modals.splice(i, 1);
        if (prev && prev.focus) prev.focus();
        if (m.onClose) m.onClose();
      },
    };
    modals.push(m);
    setTimeout(() => {
      const f = back.querySelector('[autofocus]') || back.querySelector('input:not([type=radio]):not([type=checkbox]), select, textarea');
      if (f) f.focus();
    }, 0);
    return m;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modals.length) {
      e.preventDefault();
      modals[modals.length - 1].close();
    }
  });

  function footButtons(m, buttons) {
    m.foot.innerHTML = '';
    for (const b of buttons) {
      if (b === 'spacer') {
        m.foot.append(el('<span class="spacer"></span>'));
        continue;
      }
      const btn = el(`<button type="button" class="btn ${b.kind || ''}">${esc(b.label)}</button>`);
      btn.addEventListener('click', async () => {
        if (!b.onClick) return m.close();
        btn.disabled = true;
        try {
          await b.onClick(btn);
        } catch (e) {
          toast(e.message, true);
        } finally {
          btn.disabled = false;
        }
      });
      m.foot.append(btn);
    }
  }

  function confirmBox(title, text, okLabel, danger) {
    return new Promise((resolve) => {
      const m = openModal({ title, body: el(`<p style="margin:6px 0 4px">${esc(text)}</p>`) });
      let ok = false;
      m.onClose = () => resolve(ok);
      footButtons(m, [
        'spacer',
        { label: tr('取消') },
        {
          label: okLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => {
            ok = true;
            m.close();
          },
        },
      ]);
    });
  }

  function templatePreview(kind) {
    if (kind === 'blank') return [];
    const has = (id) => envOf(id).installed;
    const first = (...ids) => ids.find(has);
    const plan = [
      [tr('产品设计'), first('codex', 'gemini', 'opencode', 'grok', 'claude', 'pi', 'hermes', 'dsh')],
      [tr('开发'), first('claude', 'codex', 'opencode', 'gemini', 'grok', 'pi', 'hermes', 'dsh')],
    ];
    if (kind === 'trio') plan.push([tr('测试审查'), first('opencode', 'gemini', 'grok', 'codex', 'claude', 'pi', 'hermes', 'dsh')]);
    const out = [];
    for (const [role, ad] of plan) {
      if (!ad) continue;
      // 和服务端建项目时一样：同一个工具担任好几个角色时名字加编号（Claude、Claude-2）
      const same = out.filter((o) => o.adapter === ad).length;
      const name = same ? `${NAMES[ad]}-${same + 1}` : NAMES[ad];
      out.push({ name, role, adapter: ad, color: PALETTE[out.length % PALETTE.length] });
    }
    return out;
  }

  // 选团队时的一行成员预览：彩色圆点 + 「Claude（开发，Claude Code）」
  function teamLine(list) {
    return list
      .map((t) => {
        const tool = ADAPTERS[t.adapter] ? ADAPTERS[t.adapter].label : '';
        const label =
          t.role && tool
            ? tr('{name}（{role}，{tool}）', { name: t.name, role: t.role, tool })
            : t.role || tool
              ? tr('{name}（{tool}）', { name: t.name, tool: t.role || tool })
              : t.name;
        return `<i style="--c:${t.color}">${esc(label)}</i>`;
      })
      .join('');
  }

  function newProjectModal() {
    const home = (S.env && S.env.home) || '';
    const sep = home.includes('\\') ? '\\' : '/';
    const base = local.get('agentchat.parent') || (home ? home + sep + 'AgentChat' : '');
    const teamHtml = (kind) => teamLine(templatePreview(kind));
    const noCli = !templatePreview('duo').length;
    const body = el(`<form>
      <div class="field"><label for="np-name">${tr('项目名称')}</label>
        <input class="input" id="np-name" autofocus placeholder="${tr('例如：待办清单 App')}" maxlength="40"></div>
      <div class="field"><label for="np-ws">${tr('项目文件夹')}</label>
        <div class="row"><input class="input mono grow" id="np-ws" placeholder="${tr('例如')} E:\\Projects\\todo-app">
          <button type="button" class="btn" data-browse>${tr('浏览…')}</button></div>
        <label class="check"><input type="checkbox" id="np-create" checked>${tr('文件夹不存在时自动创建')}</label>
        <span class="hint">${tr('所有成员都在这个文件夹里读写文件。可以选已有的项目，也可以新建一个空文件夹。')}</span></div>
      <div class="field"><span class="label">${tr('第一个会话的成员')}</span>
        <div class="choices">
          <label class="choice"><input type="radio" name="np-team" value="duo" ${noCli ? 'disabled' : 'checked'}><b>${tr('设计 + 开发')}</b>
            <span class="team">${teamHtml('duo') || `<span>${tr('没检测到命令行 AI')}</span>`}</span></label>
          <label class="choice"><input type="radio" name="np-team" value="trio" ${noCli ? 'disabled' : ''}><b>${tr('设计 + 开发 + 审查')}</b>
            <span class="team">${teamHtml('trio') || `<span>${tr('没检测到命令行 AI')}</span>`}</span></label>
          <label class="choice"><input type="radio" name="np-team" value="blank" ${noCli ? 'checked' : ''}><b>${tr('空白')}</b>
            <span>${tr('先不加成员，之后自己添加（比如接入 DeepSeek 等 API 模型）')}</span></label>
        </div>
        <span class="hint">${tr('之后可以随时改成员的名字、职责、模型和权限。项目里的每个会话都可以配不同的成员。')}</span></div>
    </form>`);
    const m = openModal({ title: tr('新建项目'), desc: tr('项目就是一个文件夹。项目里可以开好几个会话，每个会话有自己的成员和聊天记录。'), body });
    const name = $('#np-name', body);
    const ws = $('#np-ws', body);
    let wsTouched = false;
    name.addEventListener('input', () => {
      if (wsTouched || !base) return;
      const safe = name.value.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
      ws.value = safe ? base + sep + safe : '';
    });
    ws.addEventListener('input', () => (wsTouched = true));
    $('[data-browse]', body).addEventListener('click', async () => {
      const p = await pickFolderAny(ws.value || base);
      if (p) {
        ws.value = p;
        wsTouched = true;
      }
    });
    const create = async () => {
      const team = (body.querySelector('input[name=np-team]:checked') || {}).value || 'blank';
      // 新建项目时一起建好第一个会话，成员按选的团队来
      const { room } = await api('POST', '/api/projects', {
        name: name.value,
        workspace: ws.value,
        create: $('#np-create', body).checked,
        template: team,
      });
      const parent = room.workspace.replace(/[\\/][^\\/]+$/, '');
      if (parent) local.set('agentchat.parent', parent);
      m.close();
      await refreshRooms();
      await openRoom(room.id);
      toast(tr('项目已创建'));
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      create().catch((err) => toast(err.message, true));
    });
    footButtons(m, ['spacer', { label: tr('取消') }, { label: tr('创建项目'), kind: 'primary', onClick: create }]);
  }

  function folderPicker(start) {
    return new Promise((resolve) => {
      const body = el(`<div>
        <div class="fs-path"><button type="button" class="btn small" data-up>${ICONS.up}${tr('上一级')}</button><code></code></div>
        <ul class="fs-list"></ul>
        <div class="field"><label for="fs-new">${tr('在这里新建子文件夹（可选）')}</label>
          <input class="input" id="fs-new" placeholder="${tr('不填就直接选择当前文件夹')}"></div>
      </div>`);
      const m = openModal({ title: tr('选择项目文件夹'), body, wide: true });
      let result = null;
      let cur = '';
      let parent = null;
      m.onClose = () => resolve(result);
      const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
      async function load(p) {
        try {
          const d = await api('GET', '/api/fs?path=' + encodeURIComponent(p || ''));
          cur = d.path;
          parent = d.parent;
          $('code', body).textContent = cur || tr('此电脑');
          $('[data-up]', body).disabled = parent === null && !cur;
          const list = $('.fs-list', body);
          list.innerHTML = d.dirs.length
            ? d.dirs.map((x) => `<li><button type="button" data-path="${esc(x.path)}">${ICONS.folder}${esc(x.name)}</button></li>`).join('')
            : `<li class="hint" style="padding:8px">${tr('这里没有子文件夹')}</li>`;
          list.scrollTop = 0;
        } catch (e) {
          toast(e.message, true);
          if (p) load(parentOf(p));
        }
      }
      const parentOf = (p) => {
        const s = String(p).replace(/[\\/]+$/, '');
        const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        return i > 0 ? s.slice(0, i) + (/^[A-Za-z]:$/.test(s.slice(0, i)) ? '\\' : '') : '';
      };
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-path]');
        if (b) load(b.dataset.path);
        if (e.target.closest('[data-up]')) load(parent || '');
      });
      footButtons(m, [
        'spacer',
        { label: tr('取消') },
        {
          label: tr('选择这个文件夹'),
          kind: 'primary',
          onClick: () => {
            if (!cur) return toast(tr('请先进入一个磁盘或文件夹'), true);
            const sub = $('#fs-new', body).value.trim().replace(/[\\/:*?"<>|]/g, '');
            result = sub ? cur.replace(/[\\/]+$/, '') + sepOf(cur) + sub : cur;
            m.close();
          },
        },
      ]);
      load(start && /[\\/]/.test(start) ? start : '').then(() => {
        if (!cur && start) load(parentOf(start));
      });
    });
  }

  function memberModal(agent) {
    const isNew = !agent;
    const firstInstalled = CLI_TOOLS.find((id) => envOf(id).installed) || 'openai';
    const a = agent
      ? JSON.parse(JSON.stringify(agent))
      : {
          adapter: firstInstalled,
          permission: 'edit',
          color: PALETTE[agents().length % PALETTE.length],
          name: '',
          role: '',
          instructions: '',
          model: '',
          extraArgs: '',
          enabled: true,
          api: { baseUrl: '', apiKey: '', tools: true },
        };
    a.api = a.api || { baseUrl: '', apiKey: '', tools: true };
    const adapterOpts = Object.entries(ADAPTERS)
      .map(([id, d]) => {
        const e = envOf(id);
        const ok = id === 'openai' || e.installed;
        const note = id === 'openai' ? tr('填地址和 Key') : !e.installed ? tr('未安装') : e.outdated ? tr('版本太旧，需要先升级') : esc(tr('已安装 {version}', { version: e.version || '' }));
        return `<label class="choice"><input type="radio" name="mm-adapter" value="${id}" ${a.adapter === id ? 'checked' : ''} ${
          ok || a.adapter === id ? '' : 'disabled'
        }><b>${d.label}</b><span>${note}</span></label>`;
      })
      .join('');
    const body = el(`<form>
      <div class="field"><span class="label">${tr('接入方式')}</span><div class="choices cols">${adapterOpts}</div>
        <span class="hint" id="mm-what"></span></div>
      <div class="field" id="mm-api-wrap">
        <label for="mm-base">${tr('接口地址（Base URL）')}</label>
        <div class="row"><select class="input" id="mm-preset" style="max-width:190px"><option value="">${tr('常用服务…')}</option>${API_PRESETS.map(
          ([n, u]) => `<option value="${esc(u)}" ${presetFor(a.api.baseUrl) === u ? 'selected' : ''}>${esc(n)}</option>`
        ).join('')}</select>
          <input class="input mono grow" id="mm-base" value="${esc(a.api.baseUrl || '')}" placeholder="https://api.deepseek.com/v1"></div>
        <label for="mm-key" style="margin-top:8px">API Key</label>
        <input class="input mono" id="mm-key" type="password" value="${esc(a.api.apiKey || '')}" placeholder="${a.api.hasKey ? '' : tr('sk-…（本机 Ollama 可以不填）')}" autocomplete="off">
        <span class="hint">${tr('Key 只保存在这台电脑的 data 文件夹里，不会发给任何人（除了你填的接口地址）。')}</span>
        <label class="check"><input type="checkbox" id="mm-tools" ${a.api.tools !== false ? 'checked' : ''}>${tr('让它能读写项目文件（需要模型支持工具调用）')}</label>
      </div>
      <div class="field" id="mm-dsh-wrap">
        <label for="mm-dsh-key">DeepSeek API Key</label>
        <input class="input mono" id="mm-dsh-key" type="password" value="${esc(a.api.apiKey || '')}" placeholder="${a.api.hasKey ? '' : tr('sk-…（不填就用系统环境变量 DEEPSEEK_API_KEY）')}" autocomplete="off">
        <span class="hint">${tr('Key 只保存在这台电脑的 data 文件夹里，运行时交给 DeepSeek Harness，不会发给别人。')}</span>
      </div>
      <div class="field">
        <div class="label-row"><label for="mm-model-sel" id="mm-model-label">${tr('模型')}</label><button type="button" class="link-btn" id="mm-model-refresh">${tr('刷新列表')}</button></div>
        <select class="input" id="mm-model-sel"></select>
        <input class="input mono" id="mm-model" autocomplete="off" hidden>
        <datalist id="mm-model-list"></datalist>
        <span class="hint" id="mm-model-hint"></span></div>
      <div class="field"><span class="label" id="mm-effort-label">${tr('思考强度')}</span>
        <div class="seg" id="mm-effort" role="radiogroup" aria-labelledby="mm-effort-label"></div>
        <span class="hint" id="mm-effort-hint"></span></div>
      <div class="row">
        <div class="field grow"><label for="mm-name">${tr('名字')}</label><input class="input" id="mm-name" maxlength="16" value="${esc(a.name)}" placeholder="${tr('例如')} GPT">
          <span class="hint">${tr('群聊里用 @名字 呼叫它')}</span></div>
        <div class="field grow"><label for="mm-role">${tr('角色')}</label><input class="input" id="mm-role" maxlength="24" value="${esc(a.role || '')}" placeholder="${tr('例如 开发、产品设计')}"></div>
      </div>
      <div class="field"><label for="mm-inst">${tr('职责说明')}</label>
        <textarea class="input" id="mm-inst" placeholder="${tr('告诉它负责什么、做完交给谁。例如：负责写代码，每完成一个功能就交给负责审查的成员检查。')}">${esc(a.instructions || '')}</textarea></div>
      <div class="field"><span class="label">${tr('权限')}</span><div class="choices" id="mm-perms"></div></div>
      <div class="field"><span class="label">${tr('颜色')}</span><div class="swatches">${PALETTE.map(
        (c) => `<button type="button" class="swatch" style="--c:${c}" data-color="${c}" aria-label="${tr('颜色')} ${c}" aria-pressed="${c.toLowerCase() === String(a.color).toLowerCase()}"></button>`
      ).join('')}</div></div>
      <details class="more"><summary>${tr('更多设置')}</summary>
        <div class="field" id="mm-extra-wrap"><label for="mm-extra">${tr('额外命令行参数')}</label>
          <input class="input mono" id="mm-extra" value="${esc(a.extraArgs || '')}" placeholder="${tr('例如')} --add-dir D:\\shared">
          <span class="hint">${tr('会原样加在命令后面，不熟悉可以不填。')}</span></div>
        <div class="field" id="mm-body-wrap"><label for="mm-extra-body">${tr('额外请求参数（JSON）')}</label>
          <textarea class="input mono" id="mm-extra-body" placeholder='{"thinking": {"type": "enabled"}}'>${esc(a.api.extraBody ? JSON.stringify(a.api.extraBody, null, 2) : '')}</textarea>
          <span class="hint">${tr('会合并进每次请求，用来打开某些服务特有的功能，比如 DeepSeek、智谱的思考模式。不熟悉可以不填。')}</span></div>
        <label class="check"><input type="checkbox" id="mm-enabled" ${a.enabled !== false ? 'checked' : ''}>${tr('参与接力（取消勾选就暂时停用，不删除）')}</label>
      </details>
    </form>`);
    const m = openModal({
      title: isNew ? tr('添加成员') : tr('编辑成员：{name}', { name: a.name }),
      body,
      wide: true,
    });
    let color = a.color;
    let modelVal = a.model || '';
    let effortVal = a.effort || '';
    let customMode = false;
    let lastAdapter = a.adapter;
    const nameInput = $('#mm-name', body);
    const sel = $('#mm-model-sel', body);
    const inp = $('#mm-model', body);
    const refreshBtn = $('#mm-model-refresh', body);
    let nameTouched = !isNew;
    nameInput.addEventListener('input', () => (nameTouched = true));
    const adapterNow = () => (body.querySelector('input[name=mm-adapter]:checked') || {}).value || a.adapter;
    const permNow = () => (body.querySelector('input[name=mm-perm]:checked') || {}).value || a.permission || 'edit';

    // 当前选中的模型支持哪些思考强度档位
    function effortInfo() {
      const ad = adapterNow();
      if (ad === 'openai') return { levels: ['none', 'low', 'medium', 'high'], def: '' };
      const cat = S.catalogs[ad];
      if (!cat) return { loading: true, levels: [] };
      const m = (cat.models || []).find((x) => x.id === (modelVal || cat.defaultModel));
      if (ad === 'opencode') return { levels: modelVal && m ? m.efforts || [] : [], needModel: !modelVal, model: m };
      return {
        levels: m && m.efforts && m.efforts.length ? m.efforts : cat.efforts || [],
        model: m,
        def: cat.defaultEffort || (m && m.defaultEffort) || '',
      };
    }

    function effortHint() {
      const ad = adapterNow();
      const info = effortInfo();
      let t;
      if (!effortVal) {
        t = tr('不额外指定，用 {tool} 自己的设置', { tool: ADAPTERS[ad].label }) + (info.def ? tr('（现在是「{effort}」）。', { effort: effortName(info.def) }) : tr('。'));
      } else {
        const note = info.model && info.model.effortNotes && info.model.effortNotes[effortVal];
        t = EFFORT_HINT[effortVal] || note || '';
        if (ad === 'claude' && info.def && effortVal !== info.def) t += tr('会覆盖 Claude Code 设置里的「{effort}」，只对这个成员生效。', { effort: effortName(info.def) });
        if (ad === 'openai') t += tr('以 reasoning_effort 参数发送；接口不认这个参数时会报错，可以改用「更多设置」里的额外请求参数。');
      }
      $('#mm-effort-hint', body).textContent = t;
    }

    function renderEffort() {
      const box = $('#mm-effort', body);
      const info = effortInfo();
      if (info.loading) {
        box.innerHTML = '';
        $('#mm-effort-hint', body).textContent = tr('正在读取……');
        return;
      }
      if (!info.levels.length) {
        box.innerHTML = '';
        effortVal = '';
        const cat = S.catalogs[adapterNow()];
        $('#mm-effort-hint', body).textContent =
          (cat && cat.effortNote) ||
          (info.needModel ? tr('先在上面选一个具体的模型，才能设置它的思考强度。') : tr('这个模型没有可以调节的思考强度。'));
        return;
      }
      if (effortVal && !info.levels.includes(effortVal)) effortVal = '';
      const opts = [['', info.def ? tr('默认（{effort}）', { effort: effortName(info.def) }) : tr('默认')], ...info.levels.map((l) => [l, effortName(l)])];
      box.innerHTML = opts
        .map(
          ([v, t]) =>
            `<label class="seg-opt"><input type="radio" name="mm-effort" value="${esc(v)}" ${effortVal === v ? 'checked' : ''}><span>${esc(t)}</span></label>`
        )
        .join('');
      effortHint();
    }

    function renderModel() {
      const ad = adapterNow();
      const hint = $('#mm-model-hint', body);
      if (ad === 'openai') {
        sel.hidden = true;
        inp.hidden = false;
        inp.setAttribute('list', 'mm-model-list');
        inp.placeholder = tr('例如 deepseek-chat');
        inp.value = modelVal;
        $('#mm-model-label', body).htmlFor = 'mm-model';
        refreshBtn.textContent = tr('获取模型列表');
        hint.textContent = ADAPTERS.openai.modelHint + tr('填好接口地址后，可以点「获取模型列表」。');
        renderEffort();
        return;
      }
      inp.removeAttribute('list');
      inp.placeholder = tr('输入完整的模型名称');
      refreshBtn.textContent = tr('刷新列表');
      $('#mm-model-label', body).htmlFor = 'mm-model-sel';
      sel.hidden = false;
      const cat = S.catalogs[ad];
      if (!cat) {
        sel.disabled = true;
        sel.innerHTML = `<option>${tr('正在读取可用的模型……')}</option>`;
        inp.hidden = true;
        hint.textContent = '';
        renderEffort();
        loadCatalog(ad).then(() => adapterNow() === ad && renderModel());
        return;
      }
      sel.disabled = false;
      const list = cat.models || [];
      const custom = customMode || (modelVal && !list.some((x) => x.id === modelVal));
      const def = cat.defaultModel ? tr('默认（{model}）', { model: modelName(ad, cat.defaultModel) }) : tr('默认（跟随 {tool} 自己的设置）', { tool: ADAPTERS[ad].label });
      const option = (x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`;
      let opts;
      // OpenCode 和 pi 的模型来自很多家提供商，按提供商分组
      if (ad === 'opencode' || ad === 'pi') {
        const groups = {};
        for (const x of list) (groups[x.note] = groups[x.note] || []).push(x);
        opts = Object.entries(groups)
          .map(([g, xs]) => `<optgroup label="${esc(g)}">${xs.map(option).join('')}</optgroup>`)
          .join('');
      } else {
        opts = list.map(option).join('');
      }
      sel.innerHTML = `<option value="">${esc(def)}</option>${opts}<option value="__custom">${tr('自己输入……')}</option>`;
      sel.value = custom ? '__custom' : modelVal;
      inp.hidden = !custom;
      if (custom) inp.value = modelVal;
      const m = list.find((x) => x.id === (modelVal || cat.defaultModel));
      if (cat.error) hint.textContent = tr('{error}。可以选「自己输入……」手动填写。', { error: cat.error });
      else if (m && m.note && ad !== 'opencode' && ad !== 'pi') hint.textContent = m.note;
      else hint.textContent = ADAPTERS[ad].modelHint;
      renderEffort();
    }

    function sync() {
      const ad = adapterNow();
      if (ad !== lastAdapter) {
        // 换了接入方式，原来的模型和思考强度不再适用
        modelVal = '';
        effortVal = '';
        customMode = false;
        lastAdapter = ad;
      }
      const e = envOf(ad);
      $('#mm-what', body).textContent = e.outdated && e.hint ? e.hint : ADAPTERS[ad].what;
      $('#mm-what', body).classList.toggle('warn', !!e.outdated);
      $('#mm-api-wrap', body).hidden = ad !== 'openai';
      $('#mm-dsh-wrap', body).hidden = ad !== 'dsh';
      $('#mm-extra-wrap', body).hidden = ad === 'openai';
      $('#mm-body-wrap', body).hidden = ad !== 'openai';
      renderModel();
      const cur = permNow();
      $('#mm-perms', body).innerHTML = Object.entries(PERMS)
        .map(
          ([id, p]) =>
            `<label class="choice"><input type="radio" name="mm-perm" value="${id}" ${cur === id ? 'checked' : ''}><b>${p.label}</b><span>${esc(p.desc[ad])}</span></label>`
        )
        .join('');
      if (!nameTouched) {
        let n = NAMES[ad];
        let k = 2;
        while (agents().some((x) => x.name.toLowerCase() === n.toLowerCase())) n = NAMES[ad] + k++;
        nameInput.value = n;
      }
    }
    sel.addEventListener('change', () => {
      customMode = sel.value === '__custom';
      if (customMode) {
        modelVal = inp.value.trim();
        inp.hidden = false;
        inp.focus();
        renderEffort();
      } else {
        modelVal = sel.value;
        renderModel();
      }
    });
    inp.addEventListener('input', () => {
      modelVal = inp.value.trim();
      renderEffort();
    });
    refreshBtn.addEventListener('click', async () => {
      const ad = adapterNow();
      const hint = $('#mm-model-hint', body);
      if (ad !== 'openai') {
        delete S.catalogs[ad];
        renderModel();
        await loadCatalog(ad, true);
        if (adapterNow() === ad) renderModel();
        return;
      }
      hint.textContent = tr('正在获取……');
      try {
        const r = await api('POST', '/api/models/remote', {
          baseUrl: $('#mm-base', body).value,
          apiKey: $('#mm-key', body).value,
          roomId: S.roomId,
          agentId: agent ? agent.id : '',
        });
        $('#mm-model-list', body).innerHTML = r.models.map((id) => `<option value="${esc(id)}"></option>`).join('');
        hint.textContent = r.models.length ? tr('找到 {n} 个模型，点一下输入框就能选。', { n: r.models.length }) : tr('接口没有返回任何模型，请手动填写。');
      } catch (e) {
        hint.textContent = e.message;
      }
    });
    body.addEventListener('change', (e) => {
      if (e.target.name === 'mm-adapter') sync();
      if (e.target.name === 'mm-effort') {
        effortVal = e.target.value;
        effortHint();
      }
      // 选了常用服务：填上它的地址，下拉框保持显示这个服务
      if (e.target.id === 'mm-preset' && e.target.value) $('#mm-base', body).value = e.target.value;
    });
    // 手动改了接口地址：对得上常用服务就显示那个服务，对不上就回到「常用服务…」
    body.addEventListener('input', (e) => {
      if (e.target.id === 'mm-base') $('#mm-preset', body).value = presetFor(e.target.value);
    });
    body.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-color]');
      if (!sw) return;
      color = sw.dataset.color;
      $$('.swatch', body).forEach((x) => x.setAttribute('aria-pressed', String(x === sw)));
    });
    sync();

    const collect = () => {
      const ad = adapterNow();
      const data = {
        name: nameInput.value,
        adapter: ad,
        role: $('#mm-role', body).value,
        instructions: $('#mm-inst', body).value,
        model: modelVal.trim(),
        effort: effortVal,
        permission: permNow(),
        color,
        extraArgs: $('#mm-extra', body).value,
        enabled: $('#mm-enabled', body).checked,
      };
      if (ad === 'openai') {
        data.api = {
          baseUrl: $('#mm-base', body).value,
          apiKey: $('#mm-key', body).value,
          tools: $('#mm-tools', body).checked,
          extraBody: $('#mm-extra-body', body).value.trim(),
        };
      }
      if (ad === 'dsh') data.api = { apiKey: $('#mm-dsh-key', body).value };
      return data;
    };
    const save = async () => {
      const data = collect();
      if (data.permission === 'full' && (isNew || agent.permission !== 'full')) {
        const ok = await confirmBox(tr('开启完全权限？'), tr('{name}将可以在你的电脑上运行任何命令，并且不再询问。只在你信任它要做的事时开启。', { name: data.name || tr('这个成员') }), tr('开启'), true);
        if (!ok) return;
      }
      if (isNew) await api('POST', `/api/rooms/${S.roomId}/agents`, data);
      else await api('PATCH', `/api/rooms/${S.roomId}/agents/${agent.id}`, data);
      m.close();
      toast(isNew ? tr('已添加 {name}', { name: data.name }) : tr('已保存'));
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      save().catch((err) => toast(err.message, true));
    });
    const buttons = [];
    if (!isNew) {
      buttons.push({
        label: tr('删除成员'),
        kind: 'danger',
        onClick: async () => {
          const ok = await confirmBox(tr('删除成员'), tr('确定删除 {name}？聊天记录会保留。', { name: agent.name }), tr('删除'), true);
          if (!ok) return;
          await api('DELETE', `/api/rooms/${S.roomId}/agents/${agent.id}`);
          m.close();
          toast(tr('已删除 {name}', { name: agent.name }));
        },
      });
      if (S.room.sessions && S.room.sessions[agent.id]) {
        buttons.push({
          label: tr('清空记忆'),
          kind: 'ghost',
          onClick: async () => {
            const ok = await confirmBox(
              tr('清空记忆'),
              tr('{name} 会忘掉之前的对话过程。下次轮到它时，会重新读一遍群聊记录。', { name: agent.name }),
              tr('清空')
            );
            if (!ok) return;
            await api('POST', `/api/rooms/${S.roomId}/agents/${agent.id}/reset`);
            toast(tr('已清空 {name} 的记忆', { name: agent.name }));
          },
        });
      }
    }
    buttons.push('spacer', { label: tr('取消') }, { label: isNew ? tr('添加成员') : tr('保存'), kind: 'primary', onClick: save });
    footButtons(m, buttons);
  }

  // 会话设置：名字、没 @ 人时交给谁、自动接力上限、清空或删除这个会话（文件夹在项目设置里）
  function settingsModal() {
    const r = S.room;
    if (!r) return;
    const opts = agents()
      .map((a) => `<option value="${a.id}" ${r.settings.defaultAgent === a.id ? 'selected' : ''}>${esc(a.name)}</option>`)
      .join('');
    const body = el(`<form>
      <div class="field"><label for="ps-name">${tr('会话名称')}</label><input class="input" id="ps-name" maxlength="40" value="${esc(r.name)}"></div>
      <div class="row">
        <div class="field grow"><label for="ps-def">${tr('默认接收人')}</label>
          <select class="input" id="ps-def"><option value="">${tr('第一位成员')}</option>${opts}</select>
          <span class="hint">${tr('消息里没有 @ 任何人时交给谁')}</span></div>
        <div class="field grow"><label for="ps-max">${tr('自动接力上限')}</label>
          <input class="input" id="ps-max" type="number" min="1" max="100" value="${r.settings.maxAutoTurns || 10}">
          <span class="hint">${tr('AI 之间连续交接这么多轮后暂停，等你确认')}</span></div>
      </div>
      <div class="field"><span class="label">${tr('项目文件夹')}</span><code class="hint" style="font-family:var(--mono);overflow-wrap:anywhere">${esc(r.workspace)}</code>
        <span class="hint">${tr('项目里的会话都在这个文件夹里工作，要换的话去项目设置。')} <button type="button" class="link-btn" data-project-settings>${tr('项目设置…')}</button></span></div>
      ${
        r.logPath
          ? `<div class="field"><span class="label">${tr('聊天记录文件')}</span><code class="hint" style="font-family:var(--mono);overflow-wrap:anywhere">${esc(r.logPath)}</code>
        <span class="hint">${tr('每条消息也会写进这个文件，成员需要回顾时会去读。')}</span></div>`
          : ''
      }
      <div class="danger-zone"><div class="row">
        <button type="button" class="btn" data-clear>${tr('清空聊天记录')}</button>
        <button type="button" class="btn danger" data-delete>${tr('删除会话')}</button></div>
        <p class="hint" style="margin:8px 0 0">${tr('删除会话会删掉它的聊天记录和成员设置，不会动项目文件夹里的文件。')}</p></div>
    </form>`);
    const m = openModal({ title: tr('会话设置'), body, wide: true });
    $('[data-project-settings]', body).addEventListener('click', () => {
      m.close();
      projectSettingsModal(r.projectId);
    });
    $('[data-clear]', body).addEventListener('click', async () => {
      const ok = await confirmBox(tr('清空聊天记录'), tr('所有消息都会删除，各成员也会忘掉之前的对话。项目文件不受影响。'), tr('清空'), true);
      if (!ok) return;
      try {
        await api('POST', `/api/rooms/${r.id}/clear`);
        m.close();
        toast(tr('聊天记录已清空'));
      } catch (e) {
        toast(e.message, true);
      }
    });
    $('[data-delete]', body).addEventListener('click', async () => {
      try {
        if (await deleteConversation(r)) m.close();
      } catch (e) {
        toast(e.message, true);
      }
    });
    const save = async () => {
      await api('PATCH', `/api/rooms/${r.id}`, {
        name: $('#ps-name', body).value,
        settings: { defaultAgent: $('#ps-def', body).value, maxAutoTurns: Number($('#ps-max', body).value) },
      });
      m.close();
      toast(tr('已保存'));
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      save().catch((err) => toast(err.message, true));
    });
    footButtons(m, ['spacer', { label: tr('取消') }, { label: tr('保存'), kind: 'primary', onClick: save }]);
  }

  // ---------- 左边栏：右键菜单、拖动排序 ----------
  // 右键会话或项目：弹出它的操作菜单（和「⋯」是同一个）。用键盘的菜单键时没有鼠标位置，就贴着那一行弹出
  document.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('#projects .chat-li');
    const row = !li && e.target.closest('#projects .proj-row');
    if (!li && !row) return;
    e.preventDefault();
    const pos = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : {};
    if (li) chatMenu(li.querySelector('.chat'), li.dataset.id, pos);
    else projectMenu(row.querySelector('.proj-head'), row.closest('.proj').dataset.id, pos);
  });

  // 拖动排序：按住项目或会话拖到别的位置。拖过 5 像素才算拖动，不然就是普通的点击。
  // 原来那一行变成空位跟着鼠标移动，旁边的行滑开让位，一个浮起来的副本跟着鼠标走；松手后把新顺序存起来。
  // 会话只在自己的项目里排，置顶的和没置顶的各排各的；搜索时列表是筛过的，不能排。Esc 取消
  let drag = null;
  let dragEndedAt = 0;
  const sortIds = (list) => [...list.children].map((x) => x.dataset.id).filter(Boolean);

  // 能互换位置的那一组：同一个项目里、同样置顶或同样没置顶的会话；或者所有项目
  function sortGroup(item) {
    const chat = item.classList.contains('chat-li');
    const pinned = item.classList.contains('pinned');
    return [...item.parentElement.children].filter((x) => (chat ? x.classList.contains('chat-li') && x.classList.contains('pinned') === pinned : x.classList.contains('proj')));
  }

  // 挪动 DOM 以后，让位置变了的行从原来的地方滑过去（先记下位置，挪完再从旧位置动画到新位置）
  function slide(group, move) {
    const before = new Map(group.map((x) => [x, x.offsetTop]));
    move();
    for (const x of group) {
      const dy = before.get(x) - x.offsetTop;
      if (!dy) continue;
      x.style.transition = 'none';
      x.style.transform = `translateY(${dy}px)`;
      void x.offsetHeight;
      x.style.transition = 'transform .16s ease';
      x.style.transform = '';
    }
  }

  // 存新顺序：先改本地的数据（不用等服务端就不会闪），再告诉服务端；失败就按服务端的重新画
  function saveOrder(list) {
    const ids = sortIds(list);
    const by = (a, b) => ids.indexOf(a.id) - ids.indexOf(b.id);
    const fail = (e) => {
      toast(e.message, true);
      refreshRooms();
    };
    if (list.classList.contains('proj-list')) {
      S.projects.sort(by);
      return api('POST', '/api/projects/order', { ids }).catch(fail);
    }
    const pid = list.closest('.proj').dataset.id;
    const p = projectById(pid);
    if (p) p.rooms.sort(by);
    return api('POST', `/api/projects/${pid}/order`, { ids }).catch(fail);
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || S.projectQuery || !e.target.closest('#projects')) return;
    if (e.target.closest('.proj-act, .chat-act')) return;
    const li = e.target.closest('.chat-li');
    const row = !li && e.target.closest('.proj-row');
    const item = li || (row && row.closest('.proj'));
    if (item) drag = { item, id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
  });

  function startDrag() {
    const { item } = drag;
    const row = item.querySelector(item.classList.contains('chat-li') ? '.chat' : '.proj-row');
    const r = row.getBoundingClientRect();
    closeMenu();
    drag.on = true;
    drag.list = item.parentElement;
    drag.start = sortIds(drag.list);
    drag.grab = drag.y - r.top; // 鼠标按在这一行的哪个高度，副本保持同样的相对位置
    const ghost = row.cloneNode(true);
    ghost.classList.add('sort-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    document.body.append(ghost);
    drag.ghost = ghost;
    document.body.classList.add('sorting');
    // 拖项目时先把它的会话列表收起来，空位只占一行
    slide(sortGroup(item), () => item.classList.add('sort-src'));
    // 拖到窗口外面松手也能收到；只在真的拖起来以后才抓住鼠标，不然普通的点击会被吃掉
    $('#projects').setPointerCapture(drag.id);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function moveDrag(y) {
    const { item, list, ghost } = drag;
    const box = $('#projects').getBoundingClientRect();
    ghost.style.top = Math.min(Math.max(y - drag.grab, box.top - 4), box.bottom - ghost.offsetHeight + 4) + 'px';
    // 空位放到鼠标所在的位置：看鼠标在同组哪一行的中线上面
    const group = sortGroup(item);
    const others = group.filter((x) => x !== item);
    if (!others.length) return;
    const ly = y - list.getBoundingClientRect().top;
    const next = others.find((x) => ly < x.offsetTop + x.offsetHeight / 2) || null;
    const at = next ? others.indexOf(next) : others.length;
    if (at === group.indexOf(item)) return;
    slide(group, () => (next ? list.insertBefore(item, next) : others[others.length - 1].after(item)));
  }

  // 拖到左边栏的上下边缘时自动滚动
  function autoScroll() {
    if (!drag || !drag.on) return;
    const box = $('#projects');
    const r = box.getBoundingClientRect();
    const y = drag.lastY;
    const v = y < r.top + 36 ? -Math.ceil((r.top + 36 - y) / 4) : y > r.bottom - 36 ? Math.ceil((y - r.bottom + 36) / 4) : 0;
    if (v) {
      const before = box.scrollTop;
      box.scrollTop += v;
      if (box.scrollTop !== before) moveDrag(y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function finishDrag(commit) {
    const d = drag;
    drag = null;
    if (!d || !d.on) return; // 没拖起来：就是一次普通的点击
    cancelAnimationFrame(d.raf);
    dragEndedAt = Date.now();
    document.body.classList.remove('sorting');
    if (!commit) {
      d.ghost.remove();
      d.item.classList.remove('sort-src');
      renderProjects(); // 按原来的顺序重新画
      return;
    }
    // 副本落进空位，再换回真的那一行
    const row = d.item.querySelector(d.item.classList.contains('chat-li') ? '.chat' : '.proj-row');
    d.ghost.style.transition = 'top .14s ease';
    d.ghost.style.top = row.getBoundingClientRect().top + 'px';
    setTimeout(() => {
      d.ghost.remove();
      d.item.classList.remove('sort-src');
      if (d.dirty) renderProjects(); // 拖动时服务端推来的更新，这时候再画
    }, 140);
    if (sortIds(d.list).join() !== d.start.join()) saveOrder(d.list);
  }

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      if (!drag.item.isConnected) return (drag = null); // 按下以后列表重画过了
      startDrag();
    }
    drag.lastY = e.clientY;
    moveDrag(e.clientY);
  });
  document.addEventListener('pointerup', (e) => drag && e.pointerId === drag.id && finishDrag(true));
  document.addEventListener('pointercancel', (e) => drag && e.pointerId === drag.id && finishDrag(false));
  // 拖完松手时浏览器还会补一个 click，不能让它打开会话或者收起项目
  document.addEventListener(
    'click',
    (e) => {
      if (Date.now() - dragEndedAt < 300 && e.target.closest('#projects')) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );

  // 键盘：焦点在会话或项目上时，Alt+↑ / Alt+↓ 往上或往下挪一格；拖动时 Esc 取消
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && drag && drag.on) {
        e.stopPropagation();
        e.preventDefault();
        return finishDrag(false);
      }
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || S.projectQuery || drag) return;
      const li = e.target.closest('#projects .chat-li') || (e.target.closest('#projects .proj-row') && e.target.closest('.proj'));
      if (!li) return;
      e.preventDefault();
      const group = sortGroup(li);
      const i = group.indexOf(li);
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= group.length) return;
      const focused = e.target;
      slide(group, () => (j < i ? group[j].before(li) : group[j].after(li)));
      focused.focus(); // 挪动 DOM 会让它失去焦点
      saveOrder(li.parentElement);
    },
    true
  );

  // ---------- 点击 ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest(
      '[data-room],[data-new-project],[data-add-member],[data-agent],[data-at],[data-refresh-env],[data-settings],[data-open-folder],[data-stop],[data-continue],[data-work],[data-poke],[data-example],[data-tb],[data-tb-panel],[data-pick],[data-file-open],[data-file-menu],[data-file-link],[data-files-more],[data-copy-msg],[data-copy-code],[data-acct],[data-acct-tools],[data-to-pick],[data-proj-toggle],[data-new-chat],[data-proj-menu],[data-chat-menu],[data-members],#jump'
    );
    // 成员面板开着时，点到面板外面就收起
    if ($('#membersPop') && !e.target.closest('#membersPop') && !e.target.closest('[data-members]')) closeMembersPop();
    if (!t) {
      if ($('#app').classList.contains('rail-open') && !e.target.closest('.rail')) $('#app').classList.remove('rail-open');
      return;
    }
    const d = t.dataset;
    try {
      if (d.room) return openRoom(d.room);
      if ('newProject' in d) return newProjectModal();
      if (d.projToggle) return toggleProject(d.projToggle);
      if (d.newChat) return newConversation(d.newChat, S.room && S.room.projectId === d.newChat ? S.roomId : null);
      if (d.projMenu) {
        e.stopPropagation();
        return projectMenu(t, d.projMenu);
      }
      if (d.chatMenu) {
        e.stopPropagation();
        return chatMenu(t, d.chatMenu);
      }
      if ('members' in d) {
        e.stopPropagation();
        return toggleMembersPop();
      }
      if ('addMember' in d) {
        closeMembersPop();
        return memberModal(null);
      }
      if ('toPick' in d) return toPicker(t);
      if (d.at) {
        e.stopPropagation();
        closeMembersPop();
        const a = agentById(d.at);
        if (a) insertMention(a.name);
        return;
      }
      if (d.agent) {
        closeMembersPop();
        const a = agentById(d.agent);
        if (a) memberModal(a);
        return;
      }
      if ('refreshEnv' in d) return redetect(t);
      if ('settings' in d) return settingsModal();
      if ('openFolder' in d) return api('POST', `/api/rooms/${S.roomId}/open`);
      if ('stop' in d) return api('POST', `/api/rooms/${S.roomId}/stop`);
      if ('continue' in d) return api('POST', `/api/rooms/${S.roomId}/continue`);
      if (d.poke) return api('POST', `/api/rooms/${S.roomId}/agents/${d.poke}/run`);
      if (d.example) {
        setText(d.example);
        caretToEnd(inputEl());
        onComposerInput();
        return;
      }
      if (d.tbPanel) return panel.toggle(d.tbPanel);
      if ('acct' in d) return account.accountMenu(t);
      if ('acctTools' in d) return account.toolsMenu(t);
      if (d.tb) {
        e.stopPropagation();
        switch (d.tb) {
          case 'menu':
            return appMenu(t);
          case 'rail':
            return toggleRail();
          case 'back':
            return goHistory(-1);
          case 'forward':
            return goHistory(1);
          case 'title':
            return conversationMenu(t);
          case 'project':
            return projectMenu(t, S.projectId);
          case 'panel':
            return panel.toggle();
          case 'more':
            return moreMenu(t);
        }
        return;
      }
      if (d.pick !== undefined) {
        e.preventDefault();
        return pickPop(pop.items[Number(d.pick)]);
      }
      if (t.id === 'jump') return scrollToBottom();
      if (d.copyMsg) {
        const m = S.messages.find((x) => x.id === d.copyMsg);
        if (m) copyText(m.text, tr('已复制'));
        return;
      }
      if ('copyCode' in d) {
        const code = t.closest('.code-block').querySelector('code');
        await copyText(code.textContent, null);
        t.textContent = tr('已复制');
        setTimeout(() => (t.textContent = tr('复制')), 1500);
        return;
      }
      if (d.fileOpen) return await openFileSmart(d.fileOpen);
      if (d.fileMenu) return fileMenu(t, d.fileMenu);
      if (d.fileLink !== undefined) {
        e.preventDefault();
        return await openFileSmart(d.fileLink);
      }
      if (d.filesMore) {
        const key = 'files:' + d.filesMore;
        if (S.open.has(key)) S.open.delete(key);
        else S.open.add(key);
        const m = S.messages.find((x) => x.id === d.filesMore);
        const wrap = t.closest('.files');
        if (m && wrap) wrap.replaceWith(filesNode(m));
        return;
      }
      if (d.work) {
        const key = d.work;
        if (S.open.has(key)) S.open.delete(key);
        else S.open.add(key);
        const m = S.messages.find((x) => x.id === key);
        const wrap = t.closest('.work');
        if (m && wrap) wrap.replaceWith(workNode(m.items || [], key));
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-pick]')) e.preventDefault(); // 不让输入框失去焦点
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.member')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // ---------- 实时事件 ----------
  let everOpen = false;
  function connect() {
    const es = new EventSource('/api/events');
    const on = (name, fn) =>
      es.addEventListener(name, (e) => {
        try {
          fn(JSON.parse(e.data));
        } catch (err) {
          console.error(err);
        }
      });
    es.onopen = () => {
      const off = $('#offline');
      if (off) off.hidden = true;
      if (everOpen) resync();
      everOpen = true;
    };
    es.onerror = () => {
      const off = $('#offline');
      if (off) off.hidden = false;
    };
    on('message', ({ roomId, message }) => {
      if (roomId === S.roomId) addMessage(message);
      notifyMessage(roomId, message);
      // 成员这一轮改了文件：右侧文件面板跟着刷新
      if (message.files && message.files.length) panel.onFiles(roomId, message.files);
      if (roomId === S.roomId) panel.onMessages();
    });
    // 右侧面板：侧边对话和终端
    for (const name of ['side-message', 'side-progress', 'side-cleared', 'term', 'term-exit']) on(name, (data) => panel.onEvent(name, data));
    on('progress', (p) => {
      if (p.roomId !== S.roomId) return;
      S.progress = p.running;
      renderLive();
      renderRelay();
    });
    on('state', (st) => {
      const r = S.rooms.find((x) => x.id === st.roomId);
      const busy = !!st.running || st.queue.length > 0;
      notifyState(st, busy);
      if (r && r.busy !== busy) {
        r.busy = busy;
        renderProjects();
      }
      if (st.roomId !== S.roomId) return;
      S.state = st;
      if (S.room && st.sessions) S.room.sessions = Object.fromEntries(st.sessions.map((k) => [k, true]));
      if (!st.running) S.progress = null;
      renderRelay();
      renderMembers();
      renderComposerState();
      renderLive();
    });
    on('room', (room) => {
      if (room.id !== S.roomId) return;
      S.room = room;
      renderHeader();
      panel.onMembers();
      renderMembers();
      renderTranscript();
      renderRelay();
      renderComposerState();
    });
    on('projects', (list) => {
      setProjects(list);
      // 正在看的会话或项目在别处（比如另一个窗口里）被删掉了：和在这里删掉一样，换到同一个项目里的别的会话
      if ((S.roomId && !S.rooms.some((r) => r.id === S.roomId)) || (S.projectId && !projectById(S.projectId))) return afterRoomGone(S.projectId);
      renderProjects();
      updateTitlebar();
      // 还停在首页时出现了会话（比如在另一个窗口里新建的），直接打开它
      if (!S.roomId && !S.projectId && S.rooms[0]) openRoom(S.rooms[0].id);
    });
    on('settings', (next) => {
      const langChanged = next.language && next.language !== window.I18N.lang;
      S.settings = next;
      if (langChanged) return location.reload();
      account.applyTheme(next.theme || 'system');
      renderEnv();
    });
    on('cleared', ({ roomId }) => {
      if (roomId !== S.roomId) return;
      S.messages = [];
      renderTranscript();
      renderRelay();
      panel.onMessages();
    });
  }

  // ---------- 桌面通知（只在 exe 里、窗口不在前台时） ----------
  const plain = (s) =>
    String(s || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*`>_~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  // 通知里写「项目 / 会话」
  const roomName = (id) => {
    const r = S.rooms.find((x) => x.id === id);
    if (!r) return '';
    const p = projectById(r.projectId);
    return p ? `${p.name} / ${r.name}` : r.name;
  };
  function notify(roomId, title, body) {
    if (!desktop || !desktop.notify || document.hasFocus()) return;
    if (S.settings && S.settings.notify === false) return;
    S.notifiedAt[roomId] = Date.now();
    desktop.notify(title, body);
  }
  function notifyMessage(roomId, m) {
    if (m.kind !== 'agent') return;
    if (m.status === 'error') return notify(roomId, tr('{name} 出错了', { name: m.name }), tr('{name}：{text}', { name: roomName(roomId), text: plain(m.error).slice(0, 90) }));
    if (/@(用户|user|human|人类)/i.test(plain(m.text))) notify(roomId, tr('{name} 需要你', { name: m.name }), tr('{name}：{text}', { name: roomName(roomId), text: plain(m.text).slice(0, 100) }));
  }
  function notifyState(st, busy) {
    const was = S.busyRooms[st.roomId];
    S.busyRooms[st.roomId] = busy && !st.paused;
    if (st.paused && was) {
      // 出错时已经弹过「X 出错了」，不再重复
      if (Date.now() - (S.notifiedAt[st.roomId] || 0) > 4000) {
        notify(st.roomId, tr('接力暂停了'), tr('{name}：AI 之间已经自动接力 {n} 轮，等你确认', { name: roomName(st.roomId), n: st.autoTurns }));
      }
    }
    else if (was && !busy && Date.now() - (S.notifiedAt[st.roomId] || 0) > 4000) {
      notify(st.roomId, tr('接力完成'), tr('{name}：大家都做完了，回来看看结果', { name: roomName(st.roomId) }));
    }
  }

  async function resync() {
    try {
      await refreshRooms();
      if (S.roomId) {
        const data = await api('GET', `/api/rooms/${S.roomId}`);
        S.room = data.room;
        S.messages = data.messages;
        S.state = data.state;
        S.progress = data.progress && data.progress.running;
        renderMembers();
        renderHeader();
        renderTranscript();
        renderRelay();
        renderComposerState();
        scrollToBottom();
      }
    } catch {}
  }

  // ---------- 快捷键 ----------
  // Ctrl+B 左侧边栏、Ctrl+J 右侧面板、Ctrl+` 终端、Alt+←/→ 在项目之间后退前进。
  // 焦点在终端里时，Ctrl+B 和 Alt+方向键留给终端里的程序
  document.addEventListener('keydown', (e) => {
    if (modals.length || e.isComposing) return;
    const target = e.target instanceof Element ? e.target : document.body;
    const inTerm = !!target.closest('.xterm');
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      account.openSettings();
    } else if (ctrl && !e.shiftKey && !e.altKey && e.key === '`') {
      e.preventDefault();
      panel.toggle('term');
    } else if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      panel.toggle();
    } else if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !inTerm) {
      e.preventDefault();
      toggleRail();
    } else if (e.altKey && !ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !inTerm && !target.closest('input, textarea, [contenteditable="true"]')) {
      e.preventDefault();
      goHistory(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  // 鼠标侧键：后退 / 前进
  document.addEventListener('mouseup', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      goHistory(e.button === 3 ? -1 : 1);
    }
  });

  // ---------- 启动 ----------
  async function boot() {
    // 设置（语言、外观……）由 boot.js 在 app.js 之前载入；万一没有，再请求一次
    S.settings = (window.__BOOT__ && window.__BOOT__.settings) || null;
    if (!S.settings) {
      try {
        S.settings = await api('GET', '/api/settings');
      } catch {
        S.settings = {};
      }
    }
    if (local.get('agentchat.rail') === 'collapsed') $('#app').classList.add('rail-collapsed');
    if (desktop) document.documentElement.classList.add('desktop');
    // index.html 里写死的无障碍标签也换成界面语言
    $('#rail').setAttribute('aria-label', tr('项目和会话'));
    $('#panel').setAttribute('aria-label', tr('右侧面板'));
    renderTitlebar();
    renderRailTop();
    syncControlsInset();
    syncTitlebarColors();
    if (navigator.windowControlsOverlay) navigator.windowControlsOverlay.addEventListener('geometrychange', syncControlsInset);
    window.addEventListener('resize', syncControlsInset);
    window.addEventListener('resize', () => {
      sizeTimeline();
      syncTimeline();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      syncTitlebarColors();
      syncBrand();
    });
    panel = window.createPanel({
      S,
      $,
      el,
      esc,
      api,
      toast,
      md,
      ICONS,
      fileType,
      FILE_ICON,
      fullPath,
      fileUrl,
      fileAction,
      copyText,
      openMenu,
      confirmBox,
      agentById,
      enabledAgents,
      initial,
      hashColor,
      fmtTime,
      fmtDur,
      fmtClock,
      workItem,
      desktop,
      local,
      insertIntoComposer,
      onChange: () => updateTitlebar(),
    });
    panel.mount();
    account = window.createAccount({
      S,
      $,
      el,
      esc,
      api,
      toast,
      md,
      ICONS,
      openMenu,
      openModal,
      footButtons,
      confirmBox,
      desktop,
      envOf,
      ADAPTERS,
      redetect,
      aboutModal,
      appName,
      copyText,
      onSettings: () => updateTo(),
    });
    account.applyTheme(S.settings.theme || 'system');
    window.addEventListener('themechange', () =>
      setTimeout(() => {
        syncTitlebarColors();
        syncBrand();
      }, 0)
    );
    syncBrand();
    renderEnv();
    connect();
    try {
      setProjects(await api('GET', '/api/projects'));
    } catch (e) {
      toast(e.message, true);
    }
    renderProjects();
    const saved = local.get('agentchat.room');
    const pick = S.rooms.find((r) => r.id === saved) || S.rooms[0];
    if (pick) await openRoom(pick.id);
    else renderMain();
    try {
      S.env = await api('GET', '/api/env');
    } catch {}
    renderEnv();
    if (!S.room) renderMain();
  }

  boot();
})();
