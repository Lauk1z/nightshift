// 小巧的 Markdown 渲染器：只处理 AI 回复里常见的语法。所有文字先转义再加标签，不会执行任何 HTML。
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  // 界面语言（i18n.js）；单独测试这个文件时没有它，就原样显示
  const tr = (k) => (window.I18N ? window.I18N.t(k) : k);

  function inline(src, opts) {
    const codes = [];
    let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    // 指向本机文件的链接（AI 常写成 [index.html](/E:/test/index.html) 或相对路径）：点了交给 Agent Chat 打开
    s = s.replace(/\[([^\]\n]+)\]\(((?!https?:|mailto:|#)[^\s)]+)\)/g, (_, t, u) => `<a href="#" class="file-link" data-file-link="${u}">${t}</a>`);
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    if (opts && opts.mention) s = opts.mention(s);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
    return s;
  }

  function itemText(text, opts) {
    const m = text.match(/^\[([ xX])\]\s+(.*)$/s);
    const body = (m ? m[2] : text).split('\n').map((l) => inline(l, opts)).join('<br>');
    if (!m) return body;
    return `<span class="task ${m[1] === ' ' ? '' : 'done'}" aria-hidden="true"></span>${body}`;
  }

  function list(lines, i, opts) {
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (m) {
        items.push({ ind: m[1].replace(/\t/g, '    ').length, ord: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
        i++;
        continue;
      }
      if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i])) {
        items[items.length - 1].text += '\n' + lines[i].trim();
        i++;
        continue;
      }
      break;
    }
    let html = '';
    const stack = [];
    for (const it of items) {
      while (stack.length && it.ind < stack[stack.length - 1].ind) html += `</li></${stack.pop().tag}>`;
      const top = stack[stack.length - 1];
      if (!top || it.ind > top.ind) {
        const tag = it.ord ? 'ol' : 'ul';
        stack.push({ ind: it.ind, tag });
        html += `<${tag}${it.ord && it.start > 1 ? ` start="${it.start}"` : ''}><li>`;
      } else {
        html += '</li><li>';
      }
      html += itemText(it.text, opts);
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return { html, next: i };
  }

  const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function render(src, opts) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    const para = [];
    const flush = () => {
      if (!para.length) return;
      html += '<p>' + para.map((l) => inline(l, opts)).join('<br>') + '</p>';
      para.length = 0;
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m = line.match(/^\s*(```+|~~~+)\s*([\w+#.\-]*)\s*$/);
      if (m) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]);
        i++;
        // 代码块：顶上一行写语言和「复制」按钮（按钮由界面统一处理）
        html += `<div class="code-block"><div class="code-head"><span>${esc(m[2] || tr('代码'))}</span><button type="button" class="code-copy" data-copy-code>${tr('复制')}</button></div><pre${
          m[2] ? ` data-lang="${esc(m[2])}"` : ''
        }><code>${esc(buf.join('\n'))}</code></pre></div>`;
        continue;
      }
      if (!line.trim()) {
        flush();
        i++;
        continue;
      }
      m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flush();
        const lvl = Math.min(6, m[1].length + 2);
        html += `<h${lvl}>${inline(m[2].replace(/\s+#+\s*$/, ''), opts)}</h${lvl}>`;
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) && !para.length) {
        html += '<hr>';
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${render(buf.join('\n'), opts)}</blockquote>`;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush();
        // 单元格里写成 \| 的竖线不算分隔（比如代码里的管道符）
        const row = (l) =>
          l
            .trim()
            .replace(/^\|/, '')
            .replace(/(^|[^\\])\|$/, '$1')
            .split(/(?<!\\)\|/)
            .map((c) => c.trim().replace(/\\\|/g, '|'));
        const head = row(line);
        const align = row(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
        const st = (k) => (align[k] ? ` style="text-align:${align[k]}"` : '');
        i += 2;
        const body = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(row(lines[i++]));
        html +=
          '<div class="table"><table><thead><tr>' +
          head.map((c, k) => `<th${st(k)}>${inline(c, opts)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + head.map((_, k) => `<td${st(k)}>${inline(r[k] || '', opts)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>';
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const r = list(lines, i, opts);
        html += r.html;
        i = r.next;
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return html;
  }

  window.Markdown = { render, escape: esc };
})();
