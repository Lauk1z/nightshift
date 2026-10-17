'use strict';
// 左下角的账户区（照着 Claude 桌面版）：头像和名字，点开是菜单 —— 设置、用量、语言、使用说明……
// 「用量」页：每个模型用了多少 token，一年的热力图（每天 / 每周 / 累计），外加按模型的明细表。
// app.js 调用 createAccount(ctx) 创建。
window.createAccount = function createAccount(ctx) {
  const { S, $, el, esc, api, toast, md, ICONS, openMenu, openModal, footButtons, confirmBox, desktop, envOf, ADAPTERS, redetect, aboutModal, copyText, appName } = ctx;
  const t = window.I18N.t;
  const COLORS = ['#2B7BB9', '#3F6AD8', '#13897A', '#B4610C', '#B0357A', '#5B47C7', '#2F8A3B', '#9A3412'];
  const TOOLS = ['claude', 'codex', 'opencode', 'gemini', 'grok', 'pi', 'hermes'];

  // ---------- 你是谁 ----------
  const userName = () => (S.settings && S.settings.name) || (S.env && S.env.user) || t('我');
  const userColor = () => (S.settings && S.settings.color) || COLORS[0];
  function initials(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const words = s.split(/\s+/).filter(Boolean);
    // 英文名取每个词的首字母（JENSEN LIU → JL），中文名取第一个字
    if (/^[A-Za-z]/.test(s) && words.length > 1) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    return [...s][0].toUpperCase();
  }

  // ---------- 数字和日期，按界面语言写 ----------
  const lang = () => window.I18N.lang;
  function fmtTokens(n) {
    n = Math.round(Number(n) || 0);
    const trim = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString();
    if (lang() === 'en') {
      if (n >= 1e9) return trim(n / 1e9) + 'B';
      if (n >= 1e6) return trim(n / 1e6) + 'M';
      if (n >= 1e4) return trim(n / 1e3) + 'K';
      return n.toLocaleString('en-US');
    }
    const [wan, yi] = lang() === 'zh-Hant' ? ['萬', '億'] : ['万', '亿'];
    if (n >= 1e8) return trim(n / 1e8) + yi;
    if (n >= 1e4) return trim(n / 1e4) + wan;
    return n.toLocaleString('zh-CN');
  }
  function fmtLong(ms) {
    const m = Math.round((Number(ms) || 0) / 60000);
    if (m < 1) return t('{n} 秒', { n: Math.max(0, Math.round((Number(ms) || 0) / 1000)) });
    if (m < 60) return t('{n} 分钟', { n: m });
    return t('{h} 小时 {m} 分', { h: Math.floor(m / 60), m: m % 60 });
  }
  const parseDay = (s) => {
    const [y, mo, d] = s.split('-').map(Number);
    return new Date(y, mo - 1, d);
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const LOC = () => (lang() === 'en' ? 'en-US' : lang() === 'zh-Hant' ? 'zh-TW' : 'zh-CN');
  function fmtDay(d, withWeekday) {
    return d.toLocaleDateString(LOC(), { year: 'numeric', month: 'short', day: 'numeric', ...(withWeekday ? { weekday: 'short' } : {}) });
  }
  const fmtMonth = (d) => d.toLocaleDateString(LOC(), { month: 'short' });
  const fmtWeekday = (d) => d.toLocaleDateString(LOC(), { weekday: 'short' });

  // ---------- 左下角那一行 ----------
  function renderFoot() {
    const box = $('#envFoot');
    if (!box) return;
    const name = userName();
    // 只画装好了的工具；还在检测时画三个灰点，一个都没装时画一个空心点
    const states = !S.env ? ['wait', 'wait', 'wait'] : TOOLS.filter((id) => envOf(id).installed).map((id) => (envOf(id).outdated ? 'old' : 'ok'));
    const dots = (states.length ? states : ['no']).map((s) => `<i class="tool-pip ${s}"></i>`).join('');
    const ready = S.env ? TOOLS.filter((id) => envOf(id).installed && !envOf(id).outdated).length : 0;
    box.innerHTML = `<div class="acct-row">
      <button type="button" class="acct" data-acct aria-haspopup="menu" title="${esc(t('账户和设置'))}">
        <span class="avatar acct-av" style="--c:${userColor()}">${esc(initials(name))}</span>
        <span class="acct-name">${esc(name)}</span>${ICONS.chevDown}</button>
      <button type="button" class="acct-tools" data-acct-tools aria-haspopup="menu" title="${esc(
        S.env ? t('本机能用的 AI 工具：{n} 个。点开看版本、重新检测', { n: ready }) : t('正在检测本机的 AI 工具……')
      )}">${dots}</button></div>`;
  }

  function accountMenu(anchor) {
    const env = S.env || {};
    const items = [];
    if (env.user) items.push({ label: env.host ? `${env.user}@${env.host}` : env.user, header: true, run() {} });
    items.push(
      { label: t('设置'), icon: ICONS.gear, hint: 'Ctrl+,', run: openSettings },
      { label: t('用量'), icon: ICONS.gauge, run: openUsage },
      { label: t('语言'), icon: ICONS.web, sub: true, keep: true, run: () => languageMenu(anchor) },
      { label: t('使用说明'), icon: ICONS.help, run: openHelp },
      '-',
      { label: t('重新检测 AI 工具'), icon: ICONS.refresh, run: () => redetect() }
    );
    if (desktop) items.push({ label: t('打开数据文件夹'), icon: ICONS.folder, run: () => api('POST', '/api/open-data') });
    items.push('-', { label: t('关于 {app}', { app: appName() }), icon: ICONS.info, run: aboutModal });
    openMenu(anchor, items, { align: 'left', width: anchor.closest('.acct-row').offsetWidth, above: true });
  }

  function languageMenu(anchor) {
    const cur = window.I18N.lang;
    openMenu(
      anchor,
      Object.entries(window.I18N.names).map(([code, name]) => ({
        label: name,
        checked: code === cur,
        run: () => setLanguage(code),
      })),
      { align: 'left', width: anchor.closest('.acct-row').offsetWidth, above: true, force: true }
    );
  }

  async function setLanguage(code) {
    if (code === window.I18N.lang) return;
    try {
      S.settings = await api('PATCH', '/api/settings', { language: code });
      location.reload(); // 整个界面换语言，重新载入最省事也最不会漏
    } catch (e) {
      toast(e.message, true);
    }
  }

  function toolsMenu(anchor) {
    const rank = (id) => (S.env && envOf(id).installed ? 0 : 1);
    const items = [...TOOLS].sort((x, y) => rank(x) - rank(y)).map((id) => {
      const e = envOf(id);
      const state = !S.env ? 'wait' : !e.installed ? 'no' : e.outdated ? 'old' : 'ok';
      const how = ADAPTERS[id] && ADAPTERS[id].install;
      const install = S.env && !e.installed && how ? (S.env.platform === 'win32' ? how.win : how.other) : '';
      return {
        label: ADAPTERS[id].label,
        icon: `<i class="tool-pip ${state}"></i>`,
        hint: !S.env ? t('检测中') : !e.installed ? t('未安装') : e.outdated ? t('版本太旧') : e.version || t('已安装'),
        title: install ? t('点一下复制安装命令：{cmd}', { cmd: install }) : e.hint || '',
        // 没装的工具：点一下复制官方的安装命令
        run: () => install && copyText(install, t('已复制安装命令。在 PowerShell（或终端）里运行，装好后点「重新检测」')),
      };
    });
    items.push('-', { label: t('重新检测'), icon: ICONS.refresh, run: () => redetect() });
    openMenu(anchor, items, { align: 'right', above: true });
  }

  // ---------- 外观 ----------
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (desktop && desktop.setTheme) desktop.setTheme(theme || 'system');
    window.dispatchEvent(new Event('themechange'));
  }

  // ---------- 设置 ----------
  function openSettings() {
    const st = { ...(S.settings || {}) };
    const env = S.env || {};
    const body = el(`<form class="settings">
      <section class="set-sec">
        <h3>${esc(t('个人资料'))}</h3>
        <div class="set-profile">
          <span class="avatar set-av" style="--c:${st.color || COLORS[0]}">${esc(initials(st.name || env.user))}</span>
          <div class="field grow"><label for="st-name">${esc(t('名字'))}</label>
            <input class="input" id="st-name" maxlength="24" value="${esc(st.name || '')}" placeholder="${esc(env.user || '')}">
            <span class="hint">${esc(t('显示在左下角和用量页。不填就用这台电脑的用户名。'))}</span></div>
        </div>
        <div class="field"><span class="label">${esc(t('头像颜色'))}</span><div class="swatches">${COLORS.map(
          (c) =>
            `<button type="button" class="swatch" style="--c:${c}" data-st-color="${c}" aria-label="${esc(t('颜色'))} ${c}" aria-pressed="${
              c.toUpperCase() === String(st.color || COLORS[0]).toUpperCase()
            }"></button>`
        ).join('')}</div></div>
      </section>
      <section class="set-sec">
        <h3>${esc(t('外观'))}</h3>
        <div class="seg" role="radiogroup" aria-label="${esc(t('外观'))}">${[
          ['system', t('跟随系统')],
          ['light', t('浅色')],
          ['dark', t('深色')],
        ]
          .map(([v, l]) => `<label class="seg-opt"><input type="radio" name="st-theme" value="${v}" ${(st.theme || 'system') === v ? 'checked' : ''}><span>${esc(l)}</span></label>`)
          .join('')}</div>
      </section>
      <section class="set-sec">
        <h3>${esc(t('语言'))}</h3>
        <select class="input set-select" id="st-lang">${Object.entries(window.I18N.names)
          .map(([code, name]) => `<option value="${code}" ${code === (st.language || 'zh-Hans') ? 'selected' : ''}>${esc(name)}</option>`)
          .join('')}</select>
        <span class="hint">${esc(t('界面上的文字用这种语言。AI 成员默认也用它回复，你用别的语言跟它们说话时，它们会跟着换。'))}</span>
      </section>
      <section class="set-sec">
        <h3>${esc(t('发送消息'))}</h3>
        <div class="choices">
          <label class="choice"><input type="radio" name="st-send" value="enter" ${st.sendKey !== 'ctrl-enter' ? 'checked' : ''}><b>${esc(t('按 Enter 发送'))}</b><span>${esc(t('Shift+Enter 换行'))}</span></label>
          <label class="choice"><input type="radio" name="st-send" value="ctrl-enter" ${st.sendKey === 'ctrl-enter' ? 'checked' : ''}><b>${esc(t('按 Ctrl+Enter 发送'))}</b><span>${esc(t('Enter 换行，适合经常写长消息'))}</span></label>
        </div>
      </section>
      ${
        desktop
          ? `<section class="set-sec">
        <h3>${esc(t('通知'))}</h3>
        <label class="check"><input type="checkbox" id="st-notify" ${st.notify !== false ? 'checked' : ''}>${esc(t('窗口不在前台时，成员 @ 你、出错或接力结束，弹出 Windows 通知'))}</label>
      </section>`
          : ''
      }
      <section class="set-sec">
        <h3>${esc(t('数据'))}</h3>
        <div class="set-data"><code>${esc(env.dataDir || '')}</code>${desktop ? `<button type="button" class="btn small" data-st-open>${esc(t('打开文件夹'))}</button>` : ''}</div>
        <span class="hint">${esc(t('项目、聊天记录、成员配置、API Key 和用量统计都只保存在这台电脑上。'))}</span>
      </section>
    </form>`);
    const m = openModal({ title: t('设置'), body, wide: true });
    m.back.querySelector('.modal').classList.add('settings-modal');
    const before = S.settings ? S.settings.theme : 'system';
    let saved = false;
    let color = st.color || COLORS[0];
    const nameInput = $('#st-name', body);
    const av = $('.set-av', body);
    const refreshAv = () => {
      av.style.setProperty('--c', color);
      av.textContent = initials(nameInput.value.trim() || env.user);
    };
    nameInput.addEventListener('input', refreshAv);
    body.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-st-color]');
      if (sw) {
        color = sw.dataset.stColor;
        for (const x of body.querySelectorAll('[data-st-color]')) x.setAttribute('aria-pressed', String(x === sw));
        refreshAv();
      }
      if (e.target.closest('[data-st-open]')) api('POST', '/api/open-data').catch((err) => toast(err.message, true));
    });
    // 外观点了就先换上看看；取消的话换回去
    body.addEventListener('change', (e) => {
      if (e.target.name === 'st-theme') applyTheme(e.target.value);
    });
    m.onClose = () => {
      if (!saved) applyTheme(before);
    };
    const save = async () => {
      const lang = $('#st-lang', body).value;
      const next = await api('PATCH', '/api/settings', {
        name: nameInput.value,
        color,
        theme: (body.querySelector('input[name=st-theme]:checked') || {}).value || 'system',
        language: lang,
        sendKey: (body.querySelector('input[name=st-send]:checked') || {}).value || 'enter',
        notify: desktop ? $('#st-notify', body).checked : undefined,
      });
      const langChanged = next.language !== window.I18N.lang;
      S.settings = next;
      saved = true;
      m.close();
      applyTheme(next.theme);
      renderFoot();
      if (ctx.onSettings) ctx.onSettings(next);
      if (langChanged) location.reload();
      else toast(t('已保存'));
    };
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      save().catch((err) => toast(err.message, true));
    });
    footButtons(m, ['spacer', { label: t('取消') }, { label: t('保存'), kind: 'primary', onClick: save }]);
  }

  // ---------- 使用说明（README） ----------
  async function openHelp() {
    const body = el(`<div class="md help-md"><p>${esc(t('正在读取……'))}</p></div>`);
    const m = openModal({ title: t('使用说明'), body, wide: true });
    m.back.querySelector('.modal').classList.add('help-modal');
    footButtons(m, ['spacer', { label: t('关闭'), kind: 'primary' }]);
    try {
      const r = await api('GET', '/api/readme');
      body.innerHTML = md(r.text);
    } catch (e) {
      body.innerHTML = `<p>${esc(e.message)}</p>`;
    }
  }

  // =====================================================================
  // 用量
  // =====================================================================
  const WEEKS = 53;
  const CELL = 12;
  const GAP = 3;
  const STEP = CELL + GAP;
  const GUTTER = 46; // 左边留给纵轴刻度（三种视图都留，切换时每一周的位置不变）
  const PLOT_H = 7 * STEP - GAP;
  const WIDTH = GUTTER + WEEKS * STEP - GAP;

  // 好看的刻度：1、2、5 乘 10 的几次方
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * p) return k * p;
    return 10 * p;
  }

  function streaks(days, today) {
    // days：有用量的日期（YYYY-MM-DD）集合
    const sorted = [...days].sort();
    let best = 0;
    let run = 0;
    let prev = null;
    for (const s of sorted) {
      const d = parseDay(s);
      run = prev && dayKey(addDays(prev, 1)) === s ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
    // 当前连续：今天有就从今天往回数；今天还没有，就从昨天往回数
    let cur = 0;
    let d = parseDay(today);
    if (!days.has(today)) d = addDays(d, -1);
    while (days.has(dayKey(d))) {
      cur++;
      d = addDays(d, -1);
    }
    return { best, cur };
  }

  async function openUsage() {
    const body = el(`<div class="usage"><p class="hint">${esc(t('正在读取……'))}</p></div>`);
    const m = openModal({ title: t('用量'), body, wide: true });
    m.back.querySelector('.modal').classList.add('usage-modal');
    footButtons(m, ['spacer', { label: t('关闭'), kind: 'primary' }]);
    let data;
    try {
      data = await api('GET', '/api/usage');
    } catch (e) {
      body.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
      return;
    }
    const state = { model: '', view: 'day', table: false };
    const tip = el('<div class="viz-tip" role="tooltip" hidden></div>');
    // 记录时不知道名字的默认模型存成 default:<工具>
    const modelLabel = (x) => (/^default(:|$)/.test(x.model) ? t('默认模型') : x.model);

    function series() {
      const map = new Map();
      for (const r of data.daily) {
        if (state.model && r.m !== state.model) continue;
        map.set(r.d, (map.get(r.d) || 0) + r.t);
      }
      return map;
    }

    function header() {
      const env = S.env || {};
      return `<div class="usage-head">
        <span class="avatar usage-av" style="--c:${userColor()}">${esc(initials(userName()))}</span>
        <h3>${esc(userName())}</h3>${env.user ? `<p>@${esc(env.user)}</p>` : ''}</div>`;
    }

    function render() {
      if (!data.runs) {
        body.innerHTML = `${header()}<div class="usage-empty">
          <p><b>${esc(t('还没有用量记录'))}</b></p>
          <p class="hint">${esc(t('成员每跑完一轮（群聊或侧边对话），用了多少 token 都会记在这里，按模型分开统计。'))}</p></div>`;
        return;
      }
      const daily = series();
      const today = dayKey(new Date());
      const days = new Set([...daily].filter(([, v]) => v > 0).map(([d]) => d));
      let total = 0;
      let peak = 0;
      let peakDay = '';
      for (const [d, v] of daily) {
        total += v;
        if (v > peak) {
          peak = v;
          peakDay = d;
        }
      }
      const longest = state.model ? data.longest.byModel[state.model] || 0 : data.longest.all;
      const sk = streaks(days, today);
      const tiles = [
        [fmtTokens(total), t('累计 Token 数'), ''],
        [fmtTokens(peak), t('单日峰值'), peakDay ? fmtDay(parseDay(peakDay)) : ''],
        [fmtLong(longest), t('最长一轮用时'), ''],
        [t('{n} 天', { n: sk.best }), t('最长连续天数'), ''],
        [t('{n} 天', { n: sk.cur }), t('当前连续天数'), ''],
      ];
      const opts = data.models
        .map((x) => `<option value="${esc(x.model)}" ${x.model === state.model ? 'selected' : ''}>${esc(modelLabel(x))}</option>`)
        .join('');
      body.innerHTML = `${header()}
        <div class="usage-filter"><label for="u-model">${esc(t('模型'))}</label>
          <select class="input" id="u-model"><option value="">${esc(t('全部模型'))}</option>${opts}</select>
          <span class="hint">${esc(t('从 {date} 开始记录', { date: fmtDay(new Date(data.since)) }))}</span></div>
        <div class="usage-tiles">${tiles
          .map(([v, l, sub]) => `<div class="tile"${sub ? ` title="${esc(sub)}"` : ''}><b>${esc(v)}</b><span>${esc(l)}</span></div>`)
          .join('')}</div>
        <div class="usage-chart">
          <div class="chart-head"><h4>${esc(t('Token 活动'))}</h4>
            <div class="chart-views" role="tablist">${[
              ['day', t('每天')],
              ['week', t('每周')],
              ['total', t('累计总量')],
            ]
              .map(([v, l]) => `<button type="button" role="tab" data-u-view="${v}" aria-selected="${state.view === v}">${esc(l)}</button>`)
              .join('')}</div></div>
          <div class="chart-body">${chartSvg(daily, today)}</div>
          <div class="chart-foot">${
            state.view === 'day'
              ? `<span class="scale-legend">${esc(t('少'))}${[0, 1, 2, 3, 4].map((l) => `<i class="lv${l}"></i>`).join('')}${esc(t('多'))}</span>`
              : '<span></span>'
          }<button type="button" class="link-btn" data-u-table>${esc(state.table ? t('收起数据表') : t('查看数据表'))}</button></div>
          ${state.table ? dataTable(daily) : ''}
        </div>
        <div class="usage-models"><h4>${esc(t('各模型用量'))}</h4>${modelTable()}</div>`;
      body.querySelector('.usage-chart').append(tip); // 放在卡片上：图那一层会横向滚动，提示放里面会被裁掉
    }

    // 每天：53 周 × 7 天的格子，周一在最上面，最后一列是这一周
    function weeksStart(today) {
      const end = parseDay(today);
      const dow = (end.getDay() + 6) % 7; // 周一 = 0
      return addDays(end, -dow - (WEEKS - 1) * 7);
    }

    function chartSvg(daily, today) {
      const start = weeksStart(today);
      const end = parseDay(today);
      const months = [];
      let lastMonth = -1;
      for (let w = 0; w < WEEKS; w++) {
        const d = addDays(start, w * 7);
        if (d.getMonth() !== lastMonth) {
          if (!months.length || w - months[months.length - 1].w >= 3) months.push({ w, label: fmtMonth(d) });
          lastMonth = d.getMonth();
        }
      }
      const monthRow = months
        .map((x) => `<text x="${GUTTER + x.w * STEP}" y="${PLOT_H + 16}" class="axis">${esc(x.label)}</text>`)
        .join('');
      const H = PLOT_H + 22;
      if (state.view === 'day') {
        const vals = [...daily.values()].filter((v) => v > 0).sort((a, b) => a - b);
        const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 0;
        const cuts = [q(0.25), q(0.5), q(0.75)];
        const level = (v) => (!v ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
        let cells = '';
        for (let w = 0; w < WEEKS; w++) {
          for (let dy = 0; dy < 7; dy++) {
            const d = addDays(start, w * 7 + dy);
            if (d > end) continue;
            const k = dayKey(d);
            const v = daily.get(k) || 0;
            cells += `<rect class="cell lv${level(v)}" x="${GUTTER + w * STEP}" y="${dy * STEP}" width="${CELL}" height="${CELL}" rx="3" data-d="${k}" data-v="${v}"></rect>`;
          }
        }
        // 左边标出周一、周三、周五
        const weekdays = [0, 2, 4]
          .map((dy) => `<text class="axis tick" x="${GUTTER - 8}" y="${dy * STEP + CELL - 2}">${esc(fmtWeekday(addDays(start, dy)))}</text>`)
          .join('');
        return `<svg class="viz" viewBox="0 0 ${WIDTH} ${H}" role="img" aria-label="${esc(t('每天的 Token 用量热力图'))}">${weekdays}${cells}${monthRow}</svg>`;
      }
      if (state.view === 'week') {
        const sums = [];
        for (let w = 0; w < WEEKS; w++) {
          let s = 0;
          for (let dy = 0; dy < 7; dy++) s += daily.get(dayKey(addDays(start, w * 7 + dy))) || 0;
          sums.push(s);
        }
        const top = niceMax(Math.max(...sums));
        const y = (v) => PLOT_H - (v / top) * (PLOT_H - 4);
        const grid = [0, top / 2, top]
          .map((v) => `<line class="grid" x1="${GUTTER}" x2="${WIDTH}" y1="${y(v)}" y2="${y(v)}"></line><text class="axis tick" x="${GUTTER - 8}" y="${y(v) + 4}">${esc(fmtTokens(v))}</text>`)
          .join('');
        const bw = 9;
        const bars = sums
          .map((s, w) => {
            const x = GUTTER + w * STEP + (CELL - bw) / 2;
            const k = dayKey(addDays(start, w * 7));
            const hit = `<rect class="hit" x="${GUTTER + w * STEP - 1}" y="0" width="${STEP}" height="${PLOT_H}" data-w="${k}" data-v="${s}"></rect>`;
            if (!s) return hit;
            const h = Math.max(2, PLOT_H - y(s));
            const r = Math.min(4, h, bw / 2);
            const top0 = PLOT_H - h;
            // 只有顶上是圆角，贴着横轴的一端是平的
            return `<path class="bar" d="M${x},${PLOT_H} V${top0 + r} Q${x},${top0} ${x + r},${top0} H${x + bw - r} Q${x + bw},${top0} ${x + bw},${top0 + r} V${PLOT_H} Z"></path>${hit}`;
          })
          .join('');
        return `<svg class="viz" viewBox="0 0 ${WIDTH} ${H}" role="img" aria-label="${esc(t('每周的 Token 用量柱状图'))}">${grid}${bars}${monthRow}</svg>`;
      }
      // 累计总量：一条线，从这一年第一天之前已经用掉的量开始往上加
      const startKey = dayKey(start);
      let acc = 0;
      for (const [d, v] of daily) if (d < startKey) acc += v;
      const pts = [];
      const nDays = Math.round((end - start) / 864e5) + 1;
      for (let i = 0; i < nDays; i++) {
        acc += daily.get(dayKey(addDays(start, i))) || 0;
        pts.push(acc);
      }
      const top = niceMax(Math.max(...pts));
      const x = (i) => GUTTER + (i / Math.max(1, WEEKS * 7 - 1)) * (WEEKS * STEP - GAP);
      const y = (v) => PLOT_H - (v / top) * (PLOT_H - 4);
      const grid = [0, top / 2, top]
        .map((v) => `<line class="grid" x1="${GUTTER}" x2="${WIDTH}" y1="${y(v)}" y2="${y(v)}"></line><text class="axis tick" x="${GUTTER - 8}" y="${y(v) + 4}">${esc(fmtTokens(v))}</text>`)
        .join('');
      const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const area = `${line}L${x(pts.length - 1).toFixed(1)},${PLOT_H}L${x(0)},${PLOT_H}Z`;
      return `<svg class="viz" viewBox="0 0 ${WIDTH} ${H}" role="img" aria-label="${esc(t('累计 Token 用量折线图'))}" data-n="${pts.length}" data-start="${startKey}">
        ${grid}<path class="area" d="${area}"></path><path class="line" d="${line}"></path>
        <line class="cross" x1="0" x2="0" y1="0" y2="${PLOT_H}" hidden></line><circle class="dot" r="4" hidden></circle>
        <rect class="hit" x="${GUTTER}" y="0" width="${WEEKS * STEP}" height="${PLOT_H}" data-cum="1"></rect>${monthRow}</svg>`;
    }

    // 数据表：图的文字版（最近有用量的日子，新的在前）
    function dataTable(daily) {
      const rows = [...daily].filter(([, v]) => v > 0).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 120);
      if (!rows.length) return `<p class="hint">${esc(t('这段时间没有用量'))}</p>`;
      return `<div class="data-table"><table><thead><tr><th>${esc(t('日期'))}</th><th class="num">${esc(t('Token 数'))}</th></tr></thead><tbody>${rows
        .map(([d, v]) => `<tr><td>${esc(fmtDay(parseDay(d), true))}</td><td class="num">${esc(v.toLocaleString())}</td></tr>`)
        .join('')}</tbody></table></div>`;
    }

    function modelTable() {
      const all = data.models.reduce((s, x) => s + x.total, 0) || 1;
      const tool = (x) => x.adapters.map((a) => (ADAPTERS[a] ? ADAPTERS[a].label : a)).join(t('、'));
      return `<table class="model-table"><thead><tr><th>${esc(t('模型'))}</th><th>${esc(t('占比'))}</th><th class="num">${esc(t('合计'))}</th><th class="num">${esc(t('输入'))}</th><th class="num">${esc(
        t('输出')
      )}</th><th class="num">${esc(t('缓存'))}</th><th class="num">${esc(t('次数'))}</th></tr></thead><tbody>${data.models
        .map((x) => {
          const share = x.total / all;
          return `<tr data-u-model="${esc(x.model)}" class="${x.model === state.model ? 'on' : ''}" tabindex="0" title="${esc(t('只看这个模型'))}">
            <td><span class="m-name">${esc(modelLabel(x))}</span><span class="m-tool">${esc(tool(x))}</span></td>
            <td><span class="share"><i style="width:${Math.max(2, Math.round(share * 100))}%"></i></span><small>${Math.round(share * 100)}%</small></td>
            <td class="num"><b>${esc(fmtTokens(x.total))}</b></td>
            <td class="num">${esc(fmtTokens(x.input))}</td>
            <td class="num">${esc(fmtTokens(x.output))}</td>
            <td class="num">${esc(fmtTokens(x.cacheRead + x.cacheWrite))}</td>
            <td class="num">${x.runs}</td></tr>`;
        })
        .join('')}</tbody></table>`;
    }

    // 鼠标停在格子、柱子、折线上：显示那一天 / 那一周的数
    function showTip(target, html, ev) {
      tip.innerHTML = html;
      tip.hidden = false;
      const box = tip.parentElement.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      let left = (ev && ev.type === 'pointermove' && target.dataset.cum ? ev.clientX : r.left + r.width / 2) - box.left;
      left = Math.max(tip.offsetWidth / 2 + 4, Math.min(box.width - tip.offsetWidth / 2 - 4, left));
      tip.style.left = left + 'px';
      tip.style.top = r.top - box.top - tip.offsetHeight - 8 + 'px';
    }

    body.addEventListener('pointermove', (ev) => {
      const g = ev.target.closest('.viz rect, .viz path.bar');
      if (!g || !body.contains(g)) return;
      if (g.dataset.d !== undefined) {
        const v = Number(g.dataset.v);
        showTip(g, `<b>${esc(v ? t('{n} Token', { n: fmtTokens(v) }) : t('没有用量'))}</b><span>${esc(fmtDay(parseDay(g.dataset.d), true))}</span>`);
      } else if (g.dataset.w !== undefined) {
        const from = parseDay(g.dataset.w);
        showTip(g, `<b>${esc(t('{n} Token', { n: fmtTokens(Number(g.dataset.v)) }))}</b><span>${esc(t('{date} 那一周', { date: fmtDay(from) }))}</span>`);
      } else if (g.dataset.cum) {
        const svg = g.ownerSVGElement;
        const n = Number(svg.dataset.n);
        const pt = svg.createSVGPoint();
        pt.x = ev.clientX;
        pt.y = ev.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM().inverse());
        const i = Math.max(0, Math.min(n - 1, Math.round(((p.x - GUTTER) / (WEEKS * STEP - GAP)) * (WEEKS * 7 - 1))));
        const daily = series();
        const start = parseDay(svg.dataset.start);
        let acc = 0;
        for (const [d, v] of daily) if (d <= dayKey(addDays(start, i))) acc += v;
        const line = svg.querySelector('.line').getAttribute('d').split(/[ML]/).filter(Boolean)[i];
        const [cx, cy] = line.split(',').map(Number);
        const cross = svg.querySelector('.cross');
        const dot = svg.querySelector('.dot');
        cross.setAttribute('x1', cx);
        cross.setAttribute('x2', cx);
        cross.removeAttribute('hidden');
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', cy);
        dot.removeAttribute('hidden');
        showTip(g, `<b>${esc(t('{n} Token', { n: fmtTokens(acc) }))}</b><span>${esc(t('截至 {date}', { date: fmtDay(addDays(start, i)) }))}</span>`, ev);
      }
    });
    body.addEventListener('pointerleave', () => {
      tip.hidden = true;
      for (const x of body.querySelectorAll('.viz .cross, .viz .dot')) x.setAttribute('hidden', '');
    }, true);
    body.addEventListener('pointerout', (ev) => {
      if (!ev.relatedTarget || !ev.relatedTarget.closest || !ev.relatedTarget.closest('.viz')) {
        tip.hidden = true;
        for (const x of body.querySelectorAll('.viz .cross, .viz .dot')) x.setAttribute('hidden', '');
      }
    });
    body.addEventListener('click', (ev) => {
      const v = ev.target.closest('[data-u-view]');
      if (v) {
        state.view = v.dataset.uView;
        return render();
      }
      if (ev.target.closest('[data-u-table]')) {
        state.table = !state.table;
        return render();
      }
      const row = ev.target.closest('[data-u-model]');
      if (row) {
        state.model = state.model === row.dataset.uModel ? '' : row.dataset.uModel;
        render();
      }
    });
    body.addEventListener('keydown', (ev) => {
      const row = ev.target.closest && ev.target.closest('[data-u-model]');
      if (row && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        row.click();
      }
    });
    body.addEventListener('change', (ev) => {
      if (ev.target.id === 'u-model') {
        state.model = ev.target.value;
        render();
      }
    });
    render();
  }

  return { renderFoot, accountMenu, toolsMenu, openSettings, openUsage, openHelp, applyTheme, initials, fmtTokens };
};
