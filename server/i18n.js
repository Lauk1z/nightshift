'use strict';
// 服务端的界面文字（报错、系统消息、新项目的默认职责……）跟着设置里的语言走。
// 和界面共用同一套词典：public/i18n/<语言>.json，键是简体中文原文。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'i18n');
const dicts = {};
let current = 'zh-Hans';
let getLang = () => current;

function dict(lang) {
  if (lang === 'zh-Hans') return null;
  if (!(lang in dicts)) {
    try {
      dicts[lang] = JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8'));
    } catch {
      dicts[lang] = null;
    }
  }
  return dicts[lang];
}

// 键可以写成「语境::原文」（同一个中文在不同地方意思不一样时），中文只显示原文
const plain = (key) => (key.includes('::') ? key.slice(key.indexOf('::') + 2) : key);

function t(key, vars) {
  const d = dict(getLang());
  let s = (d && d[key]) || plain(key);
  if (vars) {
    s = s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (m, k, one, many) => (Number(vars[k]) === 1 ? one : many));
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  }
  return s;
}

// 由 index.js 接上设置：每次都读当前设置里的语言
function bind(fn) {
  getLang = fn;
}

function setLang(lang) {
  current = lang;
}

module.exports = { t, bind, setLang, dict, lang: () => getLang() };
