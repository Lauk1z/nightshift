'use strict';
// 界面语言。代码里的文字以简体中文为准（也就是「源文」），其他语言按源文查表：
// public/i18n/en.json、public/i18n/zh-Hant.json，查不到就照原样显示简体中文。
// 写法：t('发给 {name}', { name })；英文里的单复数写成 {n|file|files}。
(function () {
  const dicts = {};
  let lang = 'zh-Hans';

  // 同一个中文在不同地方意思不一样时（按钮「关闭」/ 思考强度「关闭」），键写成「语境::原文」，中文界面只显示原文
  const plain = (key) => (key.includes('::') ? key.slice(key.indexOf('::') + 2) : key);

  function t(key, vars) {
    let s = (lang !== 'zh-Hans' && dicts[lang] && dicts[lang][key]) || plain(key);
    if (vars) {
      s = s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (m, k, one, many) => (Number(vars[k]) === 1 ? one : many));
      s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
    }
    return s;
  }

  async function load(l) {
    if (l === 'zh-Hans' || dicts[l]) return;
    try {
      const r = await fetch(`i18n/${l}.json`, { cache: 'no-store' });
      if (r.ok) dicts[l] = await r.json();
    } catch {}
  }

  function setLang(l) {
    lang = ['zh-Hans', 'zh-Hant', 'en'].includes(l) ? l : 'zh-Hans';
    document.documentElement.lang = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-Hant', en: 'en' }[lang];
  }

  // boot.js 直接把词典带过来，不用再去下载
  function preload(l, dict) {
    if (dict && typeof dict === 'object') dicts[l] = dict;
  }

  window.I18N = {
    t,
    load,
    preload,
    setLang,
    get lang() {
      return lang;
    },
    // 每种语言用它自己的文字写名字（和 Claude 的语言菜单一样）
    names: { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English' },
  };
})();
