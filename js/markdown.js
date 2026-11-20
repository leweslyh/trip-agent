/* 轻量 Markdown 渲染（无第三方依赖，默认转义 HTML） */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};
  const esc = App.utils.escapeHtml;

  function inline(src) {
    let text = esc(src);

    // 行内代码先抽出，避免内部内容被其它规则改写
    const codes = [];
    text = text.replace(/`([^`\n]+)`/g, (m, code) => {
      codes.push(code);
      return '\u0000CODE' + (codes.length - 1) + '\u0000';
    });

    // 链接
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    // 裸链接
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });

    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    text = text.replace(/\u0000CODE(\d+)\u0000/g, (m, idx) => '<code>' + codes[Number(idx)] + '</code>');
    return text;
  }

  function renderTable(lines) {
    const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    if (rows.length < 2) return '';
    const head = rows[0];
    const body = rows.slice(2);
    const headHtml = '<thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>';
    const bodyHtml = body.length
      ? '<tbody>' + body.map((r) => '<tr>' + head.map((_, i) => '<td>' + inline(r[i] || '') + '</td>').join('') + '</tr>').join('') + '</tbody>'
      : '';
    return '<table>' + headHtml + bodyHtml + '</table>';
  }

  function isTableSep(line) {
    return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.indexOf('|') >= 0;
  }

  function render(markdown) {
    const src = String(markdown || '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 空行
      if (!line.trim()) { i++; continue; }

      // 分割线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr />'); i++; continue; }

      // 标题
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + inline(heading[2].trim()) + '</h' + level + '>');
        i++;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + inline(buf.join('\n')).replace(/\n/g, '<br />') + '</blockquote>');
        continue;
      }

      // 表格
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const buf = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          buf.push(lines[i]);
          i++;
        }
        out.push(renderTable(buf));
        continue;
      }

      // 列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const ordered = !!ol;
        const items = [];
        while (i < lines.length) {
          const m = ordered ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/) : lines[i].match(/^\s*[-*+]\s+(.*)$/);
          if (!m) break;
          items.push('<li>' + inline(m[1]) + '</li>');
          i++;
        }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }

      // 段落
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
        !/^\s*```/.test(lines[i]) &&
        !/^#{1,4}\s/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        buf.push(lines[i]);
        i++;
      }
      if (!buf.length) { i++; continue; }
      out.push('<p>' + inline(buf.join('\n')).replace(/\n/g, '<br />') + '</p>');
    }

    return out.join('\n');
  }

  App.markdown = { render };
})(window);
