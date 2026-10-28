'use strict';
// README 截图：每张图截图前在界面里执行的脚本（打开会话、让 DeepSeek 跑起来、点开面板或弹窗）。
// 这些函数会转成字符串，通过 AGENT_CHAT_CAPTURE_JS 交给桌面版在界面里执行（见 electron/main.js），
// 所以只能用界面里有的东西，不能引用这个文件里的其他变量。
// 返回值存在原图旁边：rect 是要裁剪的区域（CSS 像素，弹窗才有），radius 是弹窗的圆角。
// 界面改了（按钮、class 改名）这里要跟着改；找不到元素时这张图会报错，不会存下不对的截图。

// 公共的小工具和「系统窗口按钮」：截图只截网页内容，系统画的最小化 / 最大化 / 关闭按钮要自己补上
function prelude() {
  window.__shot = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    need(sel) {
      const n = document.querySelector(sel);
      if (!n) throw new Error('找不到 ' + sel);
      return n;
    },
    async waitFor(sel, ms = 8000) {
      const t = Date.now();
      while (Date.now() - t < ms) {
        const n = document.querySelector(sel);
        if (n) return n;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('找不到 ' + sel);
    },
    async api(method, url, body) {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-agent-chat': '1' }, body: body ? JSON.stringify(body) : undefined }).then((x) => x.json());
      if (r && r.error) throw new Error(url + '：' + r.error);
      return r;
    },
    async open(room, collapse = []) {
      const s = window.__shot;
      await s.waitFor('[data-room]');
      for (const id of collapse) {
        const t = document.querySelector(`[data-proj-toggle="${id}"]`);
        if (t && t.getAttribute('aria-expanded') === 'true') t.click();
      }
      if (!document.querySelector(`[data-room="${room}"][aria-current="true"]`)) s.need(`[data-room="${room}"]`).click();
      await s.waitFor(`[data-room="${room}"][aria-current="true"]`);
      await s.sleep(900);
    },
    // 账户菜单里的一项（按界面语言的文字找）
    async menu(label) {
      window.__shot.need('[data-acct]').click();
      await window.__shot.sleep(300);
      const item = [...document.querySelectorAll('.menu [role=menuitem]')].find((b) => b.textContent.trim().startsWith(label));
      if (!item) throw new Error('账户菜单里找不到「' + label + '」');
      item.click();
    },
    bottom() {
      const sc = document.querySelector('#scroller');
      if (sc) sc.scrollTop = sc.scrollHeight;
      const j = document.querySelector('#jump');
      if (j) j.hidden = true;
    },
    caption() {
      const css = getComputedStyle(document.documentElement);
      const bg = css.getPropertyValue('--titlebar').trim();
      const fg = css.getPropertyValue('--ink-2').trim();
      const wco = navigator.windowControlsOverlay;
      let w = 138;
      if (wco && wco.visible) {
        const r = wco.getTitlebarAreaRect();
        w = Math.round(window.innerWidth - (r.x + r.width));
      }
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;top:0;right:0;height:40px;width:${w}px;display:flex;z-index:99999;background:${bg};pointer-events:none`;
      const icon = {
        min: '<path d="M0.5 5.5h10"/>',
        max: '<rect x="0.5" y="0.5" width="10" height="10" rx="1.5"/>',
        close: '<path d="M0.5 0.5l10 10M10.5 0.5l-10 10"/>',
      };
      box.innerHTML = ['min', 'max', 'close']
        .map((k) => `<span style="flex:1;display:grid;place-items:center"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="${fg}" stroke-width="1">${icon[k]}</svg></span>`)
        .join('');
      document.body.append(box);
    },
    noScrollbars() {
      const st = document.createElement('style');
      st.textContent = '.modal, .modal * { scrollbar-width: none !important; }';
      document.head.append(st);
    },
    done() {
      if (document.activeElement) document.activeElement.blur();
      window.__shot.caption();
    },
  };
}

const SHOTS = {
  // 主界面：DeepSeek 正在检查（替身 dsh 停在最后一步）
  async main() {
    const s = window.__shot;
    await s.open('r_build', ['p_weekly']);
    await s.api('POST', '/api/rooms/r_build/agents/a_ds/run', {});
    await s.waitFor('#live .live-items li.running', 15000);
    await s.sleep(1200);
    s.bottom();
    s.done();
    return { title: document.title };
  },

  // 右侧面板预览成员做好的网页：DeepSeek 已经检查完
  async preview() {
    const s = window.__shot;
    await s.open('r_build', ['p_weekly']);
    (await s.waitFor('[data-file-open="index.html"]')).click();
    const frame = await s.waitFor('iframe.preview-frame');
    await new Promise((r) => (frame.contentDocument && frame.contentDocument.readyState === 'complete' ? r() : frame.addEventListener('load', r, { once: true })));
    await s.sleep(1500);
    s.bottom();
    s.done();
    return { title: document.title };
  },

  // 成员设置：Claude，只要上半部分（接入方式、模型、思考强度）
  async member() {
    const s = window.__shot;
    await s.open('r_build', ['p_weekly']);
    s.bottom();
    (await s.waitFor('#tbMembers')).click();
    (await s.waitFor('#membersPop [data-agent="a_cl"]')).click();
    const m = await s.waitFor('.modal');
    await s.sleep(1500);
    s.noScrollbars();
    s.done();
    const r = m.getBoundingClientRect();
    const cut = s.need('#mm-effort-hint').getBoundingClientRect().bottom + 26;
    return { rect: [r.left, r.top, r.width, cut - r.top], radius: parseFloat(getComputedStyle(m).borderTopLeftRadius) };
  },

  // 右侧面板的「上下文」：DeepSeek 已经检查完，三个成员都有数。只要面板里那张卡片，到最后一个成员为止
  async context() {
    const s = window.__shot;
    await s.open('r_build', ['p_weekly']);
    s.bottom();
    const tab = await s.waitFor('[data-tb-panel="context"]');
    if (tab.getAttribute('aria-pressed') !== 'true') tab.click();
    await s.waitFor('.ctx-card .ctx-legend');
    await s.sleep(1500);
    s.done();
    const v = s.need('.pview.active');
    const r = v.getBoundingClientRect();
    const cards = v.querySelectorAll('.ctx-card');
    const cut = Math.min(r.bottom, cards[cards.length - 1].getBoundingClientRect().bottom + 12);
    return { rect: [r.left, r.top, r.width, cut - r.top], radius: parseFloat(getComputedStyle(v).borderTopLeftRadius) };
  },

  // 用量页：到「各模型用量」的第四行为止
  async usage({ usage, handle }) {
    const s = window.__shot;
    await s.open('r_build', ['p_weekly']);
    s.bottom();
    await s.menu(usage);
    await s.waitFor('.usage-tiles');
    await s.sleep(1500);
    // 名字下面的 @ 是这台电脑的用户名，换成演示用的
    const h = document.querySelector('.usage-head p');
    if (h) h.textContent = '@' + handle;
    s.noScrollbars();
    s.done();
    const m = s.need('.modal');
    const r = m.getBoundingClientRect();
    const rows = [...m.querySelectorAll('.usage-models tbody tr')];
    const cut = rows[3] ? rows[3].getBoundingClientRect().bottom + 14 : r.bottom;
    return { rect: [r.left, r.top, r.width, cut - r.top], radius: parseFloat(getComputedStyle(m).borderTopLeftRadius) };
  },
};

// 拼成交给 AGENT_CHAT_CAPTURE_JS 的一段脚本：先装好公共工具，再执行这张图的函数，返回它的结果
function captureJs(shot, params) {
  const fn = SHOTS[shot].toString().replace(/^async \w+\(/, 'async function (');
  return `(async () => { (${prelude.toString()})(); return await (${fn})(${JSON.stringify(params)}); })()`;
}

module.exports = { captureJs };
