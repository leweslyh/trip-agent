/* ============================================================
 * 极简 Markdown 渲染器（零依赖）
 * 支持：标题 / 列表 / 表格 / 代码块 / 引用 / 分隔线 / 粗斜体 / 行内代码 / 链接
 * ============================================================ */
(function (global) {
  'use strict';

  const escapeHtml = (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 只允许 http/https/mailto，防止 javascript: 注入
  const safeUrl = (u) => {
    const t = (u || '').trim().replace(/^<|>$/g, '');
    return /^(https?:\/\/|mailto:|\/|#)/i.test(t) ? t : '#';
  };

  function inline(text) {
    let out = '';
    let i = 0;
    const codeRe = /`([^`\n]+)`/g;
    let last = 0, m;

    // 行内代码优先处理，避免内部内容被二次解析
    while ((m = codeRe.exec(text)) !== null) {
      out += formatText(text.slice(last, m.index)) + '<code>' + escapeHtml(m[1]) + '</code>';
      last = m.index + m[0].length;
    }
    out += formatText(text.slice(last));
    return out;
  }

  function formatText(t) {
    let s = escapeHtml(t);
    // 图片 ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
      `<img src="${safeUrl(url)}" alt="${alt}" style="max-width:100%;border-radius:8px">`);
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) =>
      `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
    // 裸链接
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) =>
      `${pre}<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    // 粗体 / 斜体 / 删除线
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s;
  }

  function renderTable(lines) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    if (rows.length < 2) return '';
    const head = rows[0];
    const body = rows.slice(2);
    let html = '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
    body.forEach((r) => {
      html += '<tr>' + head.map((_, idx) => `<td>${inline(r[idx] || '')}</td>`).join('') + '</tr>';
    });
    return html + '</tbody></table>';
  }

  function render(src) {
    if (!src) return '';
    const lines = String(src).replace(/\r\n/g, '\n').replace(/\t/g, '    ').split('\n');
    let html = '';
    let i = 0;
    let listType = null;
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

    while (i < lines.length) {
      let line = lines[i];

      // 代码块
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        closeList();
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        html += `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`;
        continue;
      }

      // 表格
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
        closeList();
        const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]);
        html += renderTable(buf);
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const lv = Math.min(h[1].length + 1, 6);
        html += `<h${lv}>${inline(h[2])}</h${lv}>`;
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        closeList();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${render(buf.join('\n'))}</blockquote>`;
        continue;
      }

      // 列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const type = ul ? 'ul' : 'ol';
        if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
        i++;
        continue;
      }

      // 空行
      if (!line.trim()) { closeList(); i++; continue; }

      // 普通段落
      closeList();
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
             !/^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i++]);
      }
      html += `<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    return html;
  }

  global.MD = { render, escapeHtml };
})(window);
