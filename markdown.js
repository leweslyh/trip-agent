/* 轻量 Markdown 渲染器：输出安全 HTML，支持代码块、表格、列表、链接等 */
(function (global) {
  "use strict";

  function esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var KEYWORDS = (
    "const let var function return if else for while do break continue class new import from export default " +
    "async await try catch finally throw typeof instanceof this super extends static null undefined true false " +
    "def elif None True False lambda pass with as in is not and or yield global nonlocal assert del raise " +
    "public private protected void int double float long char boolean interface implements enum struct package " +
    "switch case goto sizeof typedef unsigned signed namespace using template typename virtual override " +
    "fn mut impl use mod pub match loop where trait string bool vec " +
    "select from where group order by limit join left right inner outer on as insert update delete values set " +
    "create table primary key index default distinct having union all exists like between is"
  ).split(/\s+/);

  var KW_SET = {};
  KEYWORDS.forEach(function (k) {
    KW_SET[k] = 1;
  });

  function highlight(code, lang) {
    var l = String(lang || "").toLowerCase();
    var hashLang = /^(py|python|sh|bash|shell|zsh|rb|ruby|yaml|yml|toml|r|perl|conf|ini|dockerfile|makefile|pl)$/.test(l);
    var sqlLang = /^(sql|mysql|postgres|sqlite|pgsql)$/.test(l);

    var commentSrc = hashLang ? "#[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
    var re = new RegExp(
      "(" + commentSrc + ")" +
        "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)" +
        "|\\b(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b" +
        "|([A-Za-z_$][\\w$]*)",
      "g"
    );

    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      last = re.lastIndex;

      var token = m[0];
      if (m[1]) {
        out += '<span class="tok-com">' + esc(token) + "</span>";
      } else if (m[2]) {
        out += '<span class="tok-str">' + esc(token) + "</span>";
      } else if (m[3]) {
        out += '<span class="tok-num">' + esc(token) + "</span>";
      } else {
        var low = token.toLowerCase();
        var isKw = KW_SET[token] || (sqlLang && KW_SET[low]);
        if (isKw) {
          out += '<span class="tok-key">' + esc(token) + "</span>";
        } else if (/^\s*\(/.test(code.slice(re.lastIndex, re.lastIndex + 3))) {
          out += '<span class="tok-fn">' + esc(token) + "</span>";
        } else {
          out += esc(token);
        }
      }
    }
    out += esc(code.slice(last));
    return out;
  }

  var CODE_STORE = [];

  function inline(text) {
    var s = esc(text);

    /* 行内代码先占位，避免内部被其它规则改写 */
    s = s.replace(/`([^`\n]+)`/g, function (_, code) {
      CODE_STORE.push('<code class="inline">' + code + "</code>");
      return "\u0000" + (CODE_STORE.length - 1) + "\u0000";
    });

    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (all, label, href) {
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return all;
      return (
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        label +
        "</a>"
      );
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    s = s.replace(/\u0000(\d+)\u0000/g, function (_, idx) {
      return CODE_STORE[Number(idx)] || "";
    });
    CODE_STORE.length = 0;
    return s;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return s.split("|").map(function (c) {
      return c.trim();
    });
  }

  function render(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    var html = "";
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      /* 代码块 */
      var fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (fence) {
        var mark = fence[1].charAt(0);
        var lang = fence[2] || "text";
        var buf = [];
        i++;
        while (i < lines.length && !new RegExp("^\\s{0,3}" + mark + "{3,}\\s*$").test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        var closed = i < lines.length;
        i++;
        var code = buf.join("\n");
        html +=
          '<div class="code-block"><div class="code-head"><span>' +
          esc(lang) +
          '</span><button class="code-copy" type="button">复制</button></div><pre><code>' +
          highlight(code, lang) +
          (closed ? "" : "\n") +
          "</code></pre></div>";
        continue;
      }

      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      /* 分割线 */
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        html += "<hr />";
        i++;
        continue;
      }

      /* 标题 */
      var h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var lv = h[1].length;
        html += "<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">";
        i++;
        continue;
      }

      /* 表格 */
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          if (/^:-+:$/.test(c)) return "center";
          if (/^-+:$/.test(c)) return "right";
          return "left";
        });
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && !/^\s*$/.test(lines[i])) {
          body.push(splitRow(lines[i]));
          i++;
        }
        var t = "<table><thead><tr>";
        head.forEach(function (c, ci) {
          t += '<th style="text-align:' + (aligns[ci] || "left") + '">' + inline(c) + "</th>";
        });
        t += "</tr></thead><tbody>";
        body.forEach(function (row) {
          t += "<tr>";
          for (var k = 0; k < head.length; k++) {
            t +=
              '<td style="text-align:' +
              (aligns[k] || "left") +
              '">' +
              inline(row[k] == null ? "" : row[k]) +
              "</td>";
          }
          t += "</tr>";
        });
        html += t + "</tbody></table>";
        continue;
      }

      /* 引用 */
      if (/^\s{0,3}>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i++;
        }
        html += "<blockquote>" + render(quote.join("\n")) + "</blockquote>";
        continue;
      }

      /* 列表 */
      var li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        var ordered = /\d/.test(li[2]);
        var items = [];
        while (i < lines.length) {
          var lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!lm) break;
          items.push(lm[3]);
          i++;
          /* 续行合入当前条目 */
          while (
            i < lines.length &&
            /^\s{2,}\S/.test(lines[i]) &&
            !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
          ) {
            items[items.length - 1] += "\n" + lines[i].trim();
            i++;
          }
        }
        var tag = ordered ? "ol" : "ul";
        html += "<" + tag + ">";
        items.forEach(function (it) {
          html += "<li>" + inline(it).replace(/\n/g, "<br />") + "</li>";
        });
        html += "</" + tag + ">";
        continue;
      }

      /* 段落 */
      var para = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s{0,3}(`{3,}|~{3,})/.test(lines[i]) &&
        !/^\s{0,3}#{1,6}\s+/.test(lines[i]) &&
        !/^\s{0,3}>\s?/.test(lines[i]) &&
        !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) &&
        !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      html += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br />") + "</p>";
    }

    return html;
  }

  function renderPlain(text) {
    return esc(text).replace(/\n/g, "<br />");
  }

  global.Markdown = { render: render, renderPlain: renderPlain, escape: esc };
})(window);
