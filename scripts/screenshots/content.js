'use strict';
// README 截图用的演示内容：简体和英文手写，繁体由 OpenCC 从简体转出来（和 scripts/i18n-hant.js 一样）
const OpenCC = require('opencc-js');

const zh = {
  locale: 'zh-CN',
  userName: '小林',
  handle: 'xiaolin', // 用量页名字下面的 @，本来显示的是这台电脑的用户名
  you: '用户',
  projects: {
    p_todo: '待办清单',
    p_blog: '个人博客',
    p_dash: '销售看板',
    p_weekly: '周报助手',
  },
  rooms: {
    r_build: '做待办清单网页',
    r_drag: '手机上拖不动卡片',
    r_docs: '写使用说明',
    r_home: '首页改版',
    r_astro: '迁移到 Astro',
    r_chart: '加一张月度对比图',
    r_api: '接入订单接口',
    r_mail: '每周一自动发邮件',
  },
  roles: { design: '产品设计', dev: '开发', review: '测试审查', front: '前端', docs: '文档', proof: '校对', data: '数据' },
  instr: {
    design: '负责需求分析和设计方案，写好后交给开发',
    dev: '负责写代码，完成后交给测试审查',
    review: '负责测试和代码审查，发现问题直接修好',
  },
  build: {
    user: '做一个待办清单网页。@GPT 先出设计方案，写好后交给 Claude 实现，最后让 DeepSeek 检查一遍。',
    gptNote: '文件夹还是空的，从头设计。',
    gpt: `设计方案写好了：\`docs/design.md\`。

- **三个分组**：今天、之后、已完成，卡片可以在分组之间拖动
- **快速添加**：顶部输入框回车就能添加，\`#标签\` 会自动识别
- **键盘操作**：\`N\` 新建，\`空格\` 完成，\`Delete\` 删除
- **数据**：存在浏览器的 localStorage 里，不需要后端

@Claude 请按方案实现，做成双击就能打开的网页。`,
    clNote: '按设计稿写：页面和样式放在 index.html，逻辑放在 src/app.js。',
    cl: `做好了，双击 \`index.html\` 就能打开：

1. 三个分组之间可以拖动，顺序会记住
2. 输入 \`#工作\` 这样的标签，点标签就能筛选
3. \`N\` 新建、\`空格\` 完成、\`Delete\` 删除

@DeepSeek 帮忙测一下拖动和键盘操作。`,
    dsNote1: '先给拖动和标签写单元测试，再到浏览器里实际拖一拖、按一按。',
    dsNote2: '单元测试都通过了。拖到空分组上松手时 dropIndex 会返回 -1，到浏览器里确认一下。',
    ds: `测完了，写了 13 个单元测试，修好了一个问题：

- 拖到**空的分组**上松手时，\`dropIndex\` 返回 -1，卡片会跑到别的分组最前面。现在会放在这个分组的末尾：

\`\`\`js
const i = cards.findIndex((r) => y < r.top + r.height / 2);
return i < 0 ? cards.length : i; // 空分组：放到末尾
\`\`\`

- 键盘操作都正常，\`Delete\` 删除前会先确认

@用户 请验收。`,
  },
  others: {
    drag: ['@Gemini 手机上长按卡片拖不动，帮忙看看', '原因是触屏不触发 HTML5 拖放。我加了 Pointer Events 的拖动，桌面和手机走同一套逻辑。@Claude 帮忙审查一下。'],
    docs: ['@Grok 写一份使用说明，放在 README.md', '写好了 `README.md`，包括快捷键和数据存在哪里。@Hermes 帮忙校对一下措辞。'],
    home: ['@Claude 首页的文章列表改成卡片，配图放左边', '改好了，窄屏时配图会移到标题上面。'],
    astro: ['@GPT 评估一下把博客迁移到 Astro 要多久', '大概半天：文章是 Markdown，可以直接搬；主要工作在模板和 RSS。'],
    chart: ['@Gemini 加一张图，对比这个月和上个月每天的销售额', '加好了：两条折线，上个月是灰色的虚线，鼠标停上去能看到当天的差额。'],
    api: ['@OpenCode 把订单接口接到看板上，每 5 分钟刷新一次', '接好了，接口出错时看板会显示上次的数据和更新时间。'],
    mail: ['@Claude 每周一早上 9 点把上周的周报发到团队邮箱', '写好了定时任务，第一次会在下周一 9:00 发出。'],
  },
  // 待办清单网页里的文字
  page: {
    title: '待办清单',
    placeholder: '添加任务，回车保存。用 #标签 分类',
    all: '全部',
    groups: { today: '今天', later: '之后', done: '已完成' },
    done: '{n}/{total} 已完成',
    empty: '拖到这里',
    confirmDelete: '删除「{title}」？',
    tasks: [
      ['today', '整理本周的会议纪要', ['工作']],
      ['today', '修好登录页的样式', ['工作']],
      ['today', '给妈妈打电话', ['生活']],
      ['later', '预约牙医', ['生活']],
      ['later', '读完《设计心理学》第三章', ['学习']],
      ['done', '交电费', ['生活']],
      ['done', '提交周报', ['工作']],
    ],
    tags: { 工作: 'work', 生活: 'life', 学习: 'study' },
  },
  design: `# 待办清单：设计方案

## 目标

一个打开就能用的待办清单：不用注册，不用后端，双击 \`index.html\` 就能用。

## 页面

- 顶部：标题、今天的日期、完成进度（2/7 已完成）
- 输入框：回车添加；标题里的 \`#标签\` 自动变成标签
- 标签栏：全部 / 工作 / 生活 / 学习，点一下只看这一类
- 三个分组：今天、之后、已完成。宽屏三列，窄屏从上往下排

## 交互

| 操作 | 效果 |
| --- | --- |
| 拖动卡片 | 换分组或者换顺序 |
| 点圆圈 | 完成，卡片移到「已完成」 |
| N | 光标放到输入框 |
| 空格 | 完成选中的卡片 |
| Delete | 删除选中的卡片（先确认） |

## 数据

存在 localStorage 的 \`todo.tasks.v1\` 里：\`{ id, title, tags, group }\`。
`,
  readme: {
    p_todo: '# 待办清单\n\n双击 index.html 打开。\n',
    p_blog: '# 个人博客\n\n用 Markdown 写文章。\n',
    p_dash: '# 销售看板\n\n订单和销售额的实时看板。\n',
    p_weekly: '# 周报助手\n\n每周一自动汇总上周的工作。\n',
  },
};

const en = {
  locale: 'en',
  userName: 'Sam',
  handle: 'sam',
  you: 'user',
  projects: {
    p_todo: 'Todo app',
    p_blog: 'Personal blog',
    p_dash: 'Sales dashboard',
    p_weekly: 'Weekly report bot',
  },
  rooms: {
    r_build: 'Build the todo page',
    r_drag: "Cards won't drag on phones",
    r_docs: 'Write the user guide',
    r_home: 'Homepage redesign',
    r_astro: 'Move to Astro',
    r_chart: 'Add a monthly sales chart',
    r_api: 'Connect the orders API',
    r_mail: 'Email the report on Mondays',
  },
  roles: { design: 'Product design', dev: 'Developer', review: 'Testing & review', front: 'Frontend', docs: 'Docs', proof: 'Proofreading', data: 'Data' },
  instr: {
    design: 'Works out the requirements and design, then hands off to the developer',
    dev: 'Writes the code, then hands off for testing and review',
    review: 'Tests and reviews the code, and fixes problems it finds',
  },
  build: {
    user: "Let's build a to-do list web page. @GPT draft the design first, then hand it to Claude to build, and have DeepSeek check it at the end.",
    gptNote: 'The folder is empty, so I am starting from scratch.',
    gpt: `The design is ready: \`docs/design.md\`.

- **Three groups**: Today, Later and Done. Drag cards between groups
- **Quick add**: press Enter in the top box; \`#tags\` are picked up automatically
- **Keyboard**: \`N\` new task, \`Space\` complete, \`Delete\` remove
- **Storage**: browser localStorage, no backend needed

@Claude please build it as a page that opens with a double-click.`,
    clNote: 'Following the design: page and styles in index.html, logic in src/app.js.',
    cl: `Done. Double-click \`index.html\` to open it:

1. Drag cards between the three groups; the order is saved
2. Type tags like \`#work\` and click a tag to filter
3. \`N\` adds, \`Space\` completes, \`Delete\` removes

@DeepSeek please test dragging and the keyboard shortcuts.`,
    dsNote1: 'Writing unit tests for dragging and tags first, then trying it in a real browser.',
    dsNote2: 'Unit tests pass. dropIndex returns -1 when you drop on an empty group, so checking that in the browser.',
    ds: `Testing done. I wrote 13 unit tests and fixed one problem:

- Dropping on an **empty group** made \`dropIndex\` return -1, so the card jumped to the top of another group. It now goes to the end of the group you dropped on:

\`\`\`js
const i = cards.findIndex((r) => y < r.top + r.height / 2);
return i < 0 ? cards.length : i; // empty group: add to the end
\`\`\`

- Keyboard shortcuts work, and \`Delete\` asks before removing

@user it's ready for you to check.`,
  },
  others: {
    drag: ["@Gemini Long-pressing a card on my phone doesn't drag it, can you take a look?", "Touch screens don't fire HTML5 drag events. I added Pointer Events dragging, so desktop and phones share one code path. @Claude please review."],
    docs: ['@Grok Write a user guide in README.md', 'Wrote `README.md`, covering shortcuts and where data is stored. @Hermes please proofread it.'],
    home: ['@Claude Turn the post list on the homepage into cards with the image on the left', 'Done. On narrow screens the image moves above the title.'],
    astro: ['@GPT How long would moving the blog to Astro take?', 'About half a day: posts are Markdown and move as they are; most of the work is templates and RSS.'],
    chart: ["@Gemini Add a chart comparing this month's daily sales with last month's", "Added: two lines, last month as a dashed gray line, and hovering shows the day's difference."],
    api: ['@OpenCode Hook the orders API up to the dashboard and refresh every 5 minutes', "Done. If the API fails, the dashboard shows the last data and when it was updated."],
    mail: ['@Claude Email last week\'s report to the team every Monday at 9 am', 'The scheduled job is set up; the first email goes out next Monday at 9:00.'],
  },
  page: {
    title: 'To-do',
    placeholder: 'Add a task and press Enter. Use #tags to sort',
    all: 'All',
    groups: { today: 'Today', later: 'Later', done: 'Done' },
    done: '{n} of {total} done',
    empty: 'Drop here',
    confirmDelete: 'Delete "{title}"?',
    tasks: [
      ['today', 'Tidy up this week\'s meeting notes', ['work']],
      ['today', 'Fix the login page styles', ['work']],
      ['today', 'Call Mom', ['life']],
      ['later', 'Book a dentist appointment', ['life']],
      ['later', 'Finish chapter 3 of the design book', ['study']],
      ['done', 'Pay the electricity bill', ['life']],
      ['done', 'Send the weekly report', ['work']],
    ],
    tags: { work: 'work', life: 'life', study: 'study' },
  },
  design: `# To-do list: design

## Goal

A to-do list that works right away: no sign-up, no backend. Double-click \`index.html\` and go.

## Page

- Top: title, today's date and progress (2 of 7 done)
- Input: press Enter to add; \`#tags\` in the title become tags
- Tag bar: All / work / life / study; click one to show only that kind
- Three groups: Today, Later, Done. Three columns on wide screens, stacked on narrow ones

## Interaction

| Action | Result |
| --- | --- |
| Drag a card | Change its group or order |
| Click the circle | Complete it; the card moves to Done |
| N | Focus the input |
| Space | Complete the selected card |
| Delete | Delete the selected card (asks first) |

## Data

Stored in localStorage under \`todo.tasks.v1\`: \`{ id, title, tags, group }\`.
`,
  readme: {
    p_todo: '# To-do\n\nDouble-click index.html to open it.\n',
    p_blog: '# Personal blog\n\nPosts are written in Markdown.\n',
    p_dash: '# Sales dashboard\n\nA live dashboard for orders and revenue.\n',
    p_weekly: '# Weekly report bot\n\nSums up last week every Monday.\n',
  },
};

// 繁体：把简体的每一段文字都转一遍（键名不转），再修正几个 OpenCC 转得不合适的词
const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });
const FIX = [
  ['許可權', '權限'],
  ['這臺', '這台'],
  ['配置', '設定'],
  ['新建', '新增'],
  ['透過了', '通過了'], // 测试「通过」，不是「透过」
  ['接入訂單介面', '串接訂單 API'],
  ['訂單介面', '訂單 API'],
  ['介面出錯', 'API 出錯'],
  ['返回 -1', '回傳 -1'],
  ['@使用者', '@用户'], // 交还给你时用的 @ 是协议里的关键词，不转
  ['訂單 API接', '訂單 API 接'],
];
const hant = (s) => FIX.reduce((v, [a, b]) => v.split(a).join(b), convert(s));
function deepConvert(v, key) {
  if (typeof v === 'string') return key === 'locale' ? 'zh-TW' : hant(v);
  if (Array.isArray(v)) return v.map((x) => deepConvert(x));
  if (v && typeof v === 'object') {
    const o = {};
    // 标签的键名也是给人看的文字（#工作），一起转
    for (const [k, x] of Object.entries(v)) o[key === 'tags' ? hant(k) : k] = deepConvert(x, k);
    return o;
  }
  return v;
}

module.exports = { 'zh-Hans': zh, en, 'zh-Hant': deepConvert(zh) };
