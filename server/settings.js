'use strict';
// 应用设置（不分项目）：你的名字和头像颜色、外观、界面语言、发送键、桌面通知。
// 存在 data/settings.json；桌面版启动时也会读它（外观要在窗口出来之前定好）。
const fs = require('fs');
const path = require('path');

const LANGS = ['zh-Hans', 'zh-Hant', 'en'];
const THEMES = ['system', 'light', 'dark'];
const SEND_KEYS = ['enter', 'ctrl-enter'];
const DEFAULTS = { name: '', color: '#2B7BB9', theme: 'system', language: 'zh-Hans', sendKey: 'enter', notify: true };

function readFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function clean(input, prev) {
  const out = { ...prev };
  if (input.name !== undefined) out.name = String(input.name || '').trim().slice(0, 24);
  if (input.color !== undefined && /^#[0-9a-f]{6}$/i.test(String(input.color))) out.color = String(input.color).toUpperCase();
  if (input.theme !== undefined && THEMES.includes(input.theme)) out.theme = input.theme;
  if (input.language !== undefined && LANGS.includes(input.language)) out.language = input.language;
  if (input.sendKey !== undefined && SEND_KEYS.includes(input.sendKey)) out.sendKey = input.sendKey;
  if (input.notify !== undefined) out.notify = !!input.notify;
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = clean(readFile(this.file), DEFAULTS);
  }

  get() {
    return { ...this.data };
  }

  update(input) {
    this.data = clean(input || {}, this.data);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

// 桌面版启动时用：不用起服务，直接读文件
function readSettings(dir) {
  return clean(readFile(path.join(dir, 'settings.json')), DEFAULTS);
}

module.exports = { Settings, readSettings, LANGS, THEMES, DEFAULTS };
