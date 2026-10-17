'use strict';
// README 截图用的替身命令行工具：只回答版本、--help 和模型列表，让 Nightshift 认为八个工具都装好了。
// dsh 被叫去干活时，按 FAKE_DSH_SCRIPT 里的事件一条条输出，最后停在一个「正在运行」的步骤上等截图。
// 不联网，也不会调用任何 AI。由 index.js 生成的入口（fake-<工具>.js）先设好 FAKE_TOOL 再加载这个文件。
const fs = require('fs');
const tool = process.env.FAKE_TOOL;
const args = process.argv.slice(2);
const has = (a) => args.includes(a);
const out = (s) => process.stdout.write(s + '\n');

const VERSIONS = {
  claude: '2.4.1 (Claude Code)',
  codex: 'codex-cli 0.98.0',
  opencode: '1.6.3',
  gemini: '0.33.0',
  grok: 'grok 0.11.2',
  pi: '0.64.0',
  hermes: 'Hermes Agent v0.13.1',
  dsh: '0.2.0-rc.2',
};

// 各工具 --help 里 Nightshift 会找的参数都列上（按有没有某个参数判断支持哪些功能）
const HELP = `Usage: ${tool} [options] [command] [prompt]

Options:
  -p, --print                       Print the response and exit
  --json                            Output JSON lines
  --session-id <id>                 Continue a session
  --patch <file>                    Apply a config patch
  --output-format <format>          Output format: "text", "json", or "stream-json"
  --include-partial-messages        Stream partial messages
  --prompt-file <path>              Read the prompt from a file
  --verbatim                        Send the prompt as is
  --permission-mode <mode>          Permission mode (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")
  --approval-mode <mode>            default, auto_edit or yolo
  --skip-trust                      Trust the current folder
  --query-file PATH                 Read the query from a file
  --format {text,stream-json}       Output format
  --reasoning LEVEL                 Reasoning effort
  --mode <mode>                     text, json or rpc
  --thinking <level>                Thinking level
  --tools <list>                    Tools to enable
  --model <model>                   Model for the session. Alias such as 'fable', 'opus', 'sonnet' or 'haiku',
                                    or provider/model#variant
  --effort <level>                  Effort level (low, medium, high, xhigh, max)
  --settings <file>                 Extra settings file
  --resume <id>                     Resume a session
  -h, --help                        Show help
`;

if (has('--version') || has('-V')) {
  out(VERSIONS[tool] || '1.0.0');
  process.exit(0);
}
if (has('--help') || has('-h')) {
  out(HELP);
  process.exit(0);
}

// 模型列表（模型面板、成员设置里用）
if (tool === 'codex' && args[0] === 'debug' && args[1] === 'models') {
  const levels = ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort, description: '' }));
  out(
    JSON.stringify({
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest frontier model', priority: 1, supported_reasoning_levels: levels, default_reasoning_level: 'medium' },
        { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and efficient', priority: 2, supported_reasoning_levels: levels, default_reasoning_level: 'low' },
      ],
    })
  );
  process.exit(0);
}
if (tool === 'opencode' && args[0] === 'api') {
  if (args[1] === 'model.list') out(JSON.stringify([{ id: 'qwen4-coder-plus', providerID: 'dashscope', name: 'Qwen4 Coder Plus', variants: { low: {}, high: {} } }]));
  else if (args[1] === 'model.default') out(JSON.stringify({ providerID: 'dashscope', modelID: 'qwen4-coder-plus' }));
  else out('[]');
  process.exit(0);
}
if (tool === 'grok' && args[0] === 'models') {
  out('* grok-5 (default)\n  grok-5-mini');
  process.exit(0);
}
if (tool === 'pi' && has('--list-models')) {
  out('provider   model               context  max-out  thinking  images\nanthropic  claude-sonnet-5-5   1M       64K      yes       yes\nopenai     gpt-6.1-sol         400K     128K     yes       yes');
  process.exit(0);
}

// 其余的调用：只有 dsh 的 headless 会真的来干活
if (tool !== 'dsh' || args[0] !== 'headless') process.exit(0);

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const script = JSON.parse(fs.readFileSync(process.env.FAKE_DSH_SCRIPT, 'utf8'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  out(JSON.stringify({ type: 'session', sessionId: 'demo-session', cwd: process.cwd() }));
  for (const ev of script.events) {
    await wait(ev.delay || 150);
    const { delay, ...rest } = ev;
    out(JSON.stringify(rest));
  }
  // 停在最后一步，等截图；被 Nightshift 停掉或者过一会儿自己退出
  await wait(script.hold || 90000);
  process.exit(0);
});
