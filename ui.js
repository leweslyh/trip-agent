(function (global) {
  'use strict';

  var messagesEl = null;
  var chatAreaEl = null;
  var toastEl = null;
  var toastTimer = null;

  function init() {
    messagesEl = document.getElementById('messages');
    chatAreaEl = document.getElementById('chatArea');
    toastEl = document.getElementById('toast');
  }

  function el(cls, tag) {
    var node = document.createElement(tag || 'div');
    if (cls) node.className = cls;
    return node;
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inline(text) {
    return String(text || '')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function renderMarkdown(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    var listOpen = false;
    var para = [];

    function closeList() {
      if (listOpen) { out.push('</ul>'); listOpen = false; }
    }
    function flushPara() {
      if (para.length) {
        out.push('<p>' + para.map(inline).join('<br>') + '</p>');
        para = [];
      }
    }

    lines.forEach(function (line) {
      var t = line.trim();
      var bullet = t.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
      var heading = t.match(/^#{1,6}\s+(.*)$/);

      if (bullet) {
        flushPara();
        if (!listOpen) { out.push('<ul>'); listOpen = true; }
        out.push('<li>' + inline(bullet[1]) + '</li>');
      } else if (heading) {
        flushPara(); closeList();
        out.push('<div class="md-h">' + inline(heading[1]) + '</div>');
      } else if (!t) {
        flushPara(); closeList();
      } else {
        closeList();
        para.push(t);
      }
    });
    flushPara();
    closeList();
    return out.join('');
  }

  function scrollBottom() {
    if (chatAreaEl) chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
  }

  function clearMessages() {
    if (messagesEl) messagesEl.innerHTML = '';
  }

  function addMessage(role) {
    var isUser = role === 'user';
    var wrap = el('msg ' + (isUser ? 'user' : 'assistant'));
    var avatar = el('avatar ' + (isUser ? 'me' : 'ai'));
    avatar.innerHTML = isUser ? '我' : '<svg class="icon"><use href="#i-compass"/></svg>';
    var body = el('msg-body');
    var stack = el(isUser ? '' : 'assistant-stack');
    body.appendChild(stack);
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollBottom();
    return stack;
  }

  function addUserMessage(text) {
    var stack = addMessage('user');
    stack.className = 'bubble';
    stack.innerHTML = renderMarkdown(text);
    scrollBottom();
  }

  function addThinking(stack, text) {
    var node = el('thinking');
    node.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="thinking-text">' + esc(text || '正在思考…') + '</span>';
    stack.appendChild(node);
    scrollBottom();
    return node;
  }

  function setThinkingText(node, text) {
    if (node && node.isConnected) {
      var span = node.querySelector('.thinking-text');
      if (span) span.textContent = text;
    }
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function addTrace(stack, meta) {
    var trace = el('trace');
    var head = el('trace-head');
    head.innerHTML =
      '<i class="tool-dot loading"></i>' +
      '<svg class="icon"><use href="#i-spark"/></svg>' +
      '<span class="tool-name">' + esc(meta.label || meta.name) + '</span>' +
      '<span class="tool-label">正在调用 ' + esc(meta.name) + '…</span>' +
      '<span class="spacer"></span>' +
      '<svg class="icon chev"><use href="#i-chevron"/></svg>';
    var body = el('trace-body');
    body.innerHTML = '<pre>' + esc(JSON.stringify(meta.args || {}, null, 2)) + '</pre>';
    trace.appendChild(head);
    trace.appendChild(body);
    head.addEventListener('click', function () { trace.classList.toggle('open'); });
    stack.appendChild(trace);
    scrollBottom();
    return trace;
  }

  function updateTrace(trace, result) {
    if (!trace || !trace.isConnected) return;
    var dot = trace.querySelector('.tool-dot');
    var label = trace.querySelector('.tool-label');
    var body = trace.querySelector('.trace-body');
    if (dot) dot.classList.remove('loading');
    if (label) label.textContent = result.ok ? '调用成功' : '调用失败';
    if (body) body.innerHTML = '<pre>' + esc(JSON.stringify(result.ok ? result.data : { error: result.error }, null, 2)) + '</pre>';
  }

  function cardShell(iconId, tone, title, sub, count) {
    var card = el('card');
    var head = el('card-head');
    head.innerHTML =
      '<span class="card-icon ' + tone + '"><svg class="icon"><use href="#i-' + iconId + '"/></svg></span>' +
      '<span style="min-width:0"><div class="card-title">' + esc(title) + '</div><div class="card-sub">' + esc(sub || '') + '</div></span>' +
      (count !== undefined && count !== null ? '<span class="count">' + esc(count) + ' 条</span>' : '');
    var body = el('card-body');
    card.appendChild(head);
    card.appendChild(body);
    return { card: card, body: body };
  }

  function mapFrame(url, caption) {
    var frame = el('map-frame');
    if (url) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = '高德静态地图';
      img.loading = 'lazy';
      img.onerror = function () {
        frame.innerHTML = '<div class="map-fallback">地图图片加载失败，请检查高德密钥或网络连接。</div>';
        var cap = el('map-caption');
        cap.innerHTML = '<svg class="icon"><use href="#i-map"/></svg> ' + esc(caption || '高德静态地图');
        frame.appendChild(cap);
      };
      frame.appendChild(img);
    } else {
      frame.appendChild(el('map-fallback'));
      frame.lastChild.textContent = '暂无可展示的地图';
    }
    var cap2 = el('map-caption');
    cap2.innerHTML = '<svg class="icon"><use href="#i-map"/></svg> ' + esc(caption || '高德静态地图');
    frame.appendChild(cap2);
    return frame;
  }

  function renderPois(stack, data) {
    var isNearby = data.type === 'nearby';
    var sub = isNearby
      ? '中心：' + (data.centerName || data.center) + ' · 半径 ' + (global.Amap.fmtDistance(data.radius) || '3 公里')
      : (data.city ? data.city + ' · ' : '') + '关键词：' + data.keywords;
    var shell = cardShell(isNearby ? 'radar' : 'search', 'tone-map', isNearby ? '周边搜索结果' : '地点搜索结果', sub, data.count);
    var list = el('poi-list');

    (data.pois || []).forEach(function (p, i) {
      var item = el('poi-item');
      var idx = el('poi-index');
      idx.textContent = String(i + 1);
      var main = el('poi-main');
      var name = el('poi-name');
      name.textContent = p.name || '未命名地点';
      var addr = el('poi-addr');
      addr.textContent = p.address || '暂无详细地址';
      main.appendChild(name);
      main.appendChild(addr);

      var meta = el('poi-meta');
      if (p.category) {
        var tag = el('tag');
        tag.textContent = p.category;
        meta.appendChild(tag);
      }
      if (p.tel) {
        var tel = el('tag');
        tel.textContent = p.tel;
        meta.appendChild(tel);
      }
      if (meta.childNodes.length) main.appendChild(meta);
      item.appendChild(idx);
      item.appendChild(main);

      if (p.distance !== '' && p.distance !== undefined && p.distance !== null) {
        var dist = el('poi-distance');
        dist.textContent = global.Amap.fmtDistance(p.distance);
        item.appendChild(dist);
      }
      list.appendChild(item);
    });

    if (!(data.pois || []).length) {
      var empty = el('poi-addr');
      empty.textContent = '没有找到相关地点，换个关键词或城市试试。';
      list.appendChild(empty);
    }

    shell.body.appendChild(list);
    if (data.mapUrl) shell.body.appendChild(mapFrame(data.mapUrl, '地图中标记了前 10 个结果'));
    stack.appendChild(shell.card);
    scrollBottom();
  }

  function renderRoute(stack, data) {
    var shell = cardShell('route', 'tone-route', '路径规划 · ' + data.mode,
      (data.originName || data.origin) + ' → ' + (data.destinationName || data.destination));

    var od = el('route-od');
    var leg1 = el('leg');
    leg1.innerHTML = '<svg class="icon"><use href="#i-pin"/></svg><span>' + esc(data.originName || data.origin) + '</span>';
    var arrow = el('arrow');
    arrow.innerHTML = '<svg class="icon"><use href="#i-route"/></svg>';
    var leg2 = el('leg');
    leg2.innerHTML = '<svg class="icon"><use href="#i-pin"/></svg><span>' + esc(data.destinationName || data.destination) + '</span>';
    od.appendChild(leg1); od.appendChild(arrow); od.appendChild(leg2);
    shell.body.appendChild(od);

    var best = data.plans && data.plans[0] ? data.plans[0] : {};
    var summary = el('route-summary');
    var stats = [
      { icon: 'i-clock', label: '预计耗时', value: best.duration || '—' },
      { icon: 'i-distance', label: '全程距离', value: best.distance || '—' },
      { icon: 'i-car', label: '费用参考', value: best.cost || '—' }
    ];
    stats.forEach(function (s) {
      var box = el('route-stat');
      box.innerHTML = '<div class="label"><svg class="icon"><use href="#i-' + s.icon.slice(2) + '"/></svg>' + esc(s.label) + '</div><div class="value">' + esc(s.value) + '</div>';
      summary.appendChild(box);
    });
    shell.body.appendChild(summary);

    if (data.plans && data.plans.length > 1) {
      var alts = el('poi-meta');
      alts.style.marginTop = '10px';
      data.plans.slice(1).forEach(function (p) {
        var tag = el('tag');
        tag.textContent = '方案 ' + p.index + '：' + p.duration + ' / ' + p.distance;
        alts.appendChild(tag);
      });
      shell.body.appendChild(alts);
    }

    if (best.summary) {
      var desc = el('poi-addr');
      desc.style.marginTop = '10px';
      desc.textContent = best.summary;
      shell.body.appendChild(desc);
    }

    var steps = (best.steps || []).filter(Boolean);
    if (steps.length) {
      var toggle = el('steps-toggle');
      toggle.innerHTML = '<span>查看详细步骤（' + steps.length + ' 步）</span><svg class="icon chev"><use href="#i-chevron"/></svg>';
      var stepList = el('steps-list');
      steps.forEach(function (s) {
        var li = document.createElement('li');
        li.textContent = s;
        stepList.appendChild(li);
      });
      toggle.addEventListener('click', function () {
        toggle.classList.toggle('open');
        stepList.classList.toggle('open');
      });
      shell.body.appendChild(toggle);
      shell.body.appendChild(stepList);
    }

    if (data.mapUrl) shell.body.appendChild(mapFrame(data.mapUrl, '路线概览（起点 → 终点）'));
    stack.appendChild(shell.card);
    scrollBottom();
  }

  function renderWeather(stack, data) {
    var shell = cardShell('weather', 'tone-weather', '天气查询', data.province ? data.province + ' · ' + data.city : data.city);

    var now = el('weather-now');
    var temp = el('weather-temp');
    temp.innerHTML = esc(data.temperature || '—') + '<small>°C</small>';
    var info = el('weather-info');
    info.innerHTML = '<div class="cond">' + esc(data.weather || '暂无实况') + '</div>' +
      '<div class="meta">' + esc(data.winddirection || '') + '风 ' + esc(data.windpower || '') + '级 · 湿度 ' + esc(data.humidity || '') + '%</div>';
    var place = el('weather-place');
    place.innerHTML = '<span class="big">' + esc(data.city || '') + '</span>' +
      '<span class="time">更新 ' + esc(data.reporttime || '—') + '</span>';
    now.appendChild(temp); now.appendChild(info); now.appendChild(place);
    shell.body.appendChild(now);

    var stats = el('weather-stats');
    [
      { k: '天气', v: data.weather || '—' },
      { k: '气温', v: (data.temperature || '—') + '°C' },
      { k: '风力', v: (data.windpower || '—') + ' 级' },
      { k: '湿度', v: (data.humidity || '—') + '%' }
    ].forEach(function (s) {
      var box = el('weather-stat');
      box.innerHTML = '<div class="k">' + esc(s.k) + '</div><div class="v">' + esc(s.v) + '</div>';
      stats.appendChild(box);
    });
    shell.body.appendChild(stats);

    if (data.days && data.days.length) {
      var scroll = el('forecast-scroll');
      data.days.forEach(function (d) {
        var day = el('forecast-day');
        day.innerHTML =
          '<div class="d">' + esc(d.date ? d.date.slice(5) + ' ' + d.weekday : d.weekday) + '</div>' +
          '<div class="w">' + esc(d.dayWeather) + '<br>' + esc(d.nightWeather) + '</div>' +
          '<div class="t">' + esc(d.dayTemp) + '° <em>/ ' + esc(d.nightTemp) + '°</em></div>';
        scroll.appendChild(day);
      });
      shell.body.appendChild(scroll);
    }
    stack.appendChild(shell.card);
    scrollBottom();
  }

  function renderIp(stack, data) {
    var shell = cardShell('pin', 'tone-pin', 'IP 定位结果', data.ip ? '查询 IP：' + data.ip : '当前网络出口 IP');
    var grid = el('ip-grid');
    [
      { k: '省份', v: data.province },
      { k: '城市', v: data.city },
      { k: '行政区划代码', v: data.adcode },
      { k: '定位状态', v: data.located ? '定位成功' : '未能识别' }
    ].forEach(function (item) {
      var cell = el('ip-cell');
      cell.innerHTML = '<div class="k">' + esc(item.k) + '</div><div class="v">' + esc(item.v || '—') + '</div>';
      grid.appendChild(cell);
    });
    shell.body.appendChild(grid);
    if (data.rectangle) {
      var note = el('poi-addr');
      note.style.marginTop = '10px';
      note.textContent = '范围：' + data.rectangle;
      shell.body.appendChild(note);
    }
    stack.appendChild(shell.card);
    scrollBottom();
  }

  function renderStaticMap(stack, data) {
    var shell = cardShell('map', 'tone-map', '静态地图', data.title || '', data.markers ? data.markers.length : undefined);
    var meta = el('poi-meta');
    var tag = el('tag');
    tag.textContent = '中心 ' + data.center;
    meta.appendChild(tag);
    var tag2 = el('tag');
    tag2.textContent = '缩放级别 ' + data.zoom;
    meta.appendChild(tag2);
    shell.body.appendChild(meta);
    if (data.mapUrl) shell.body.appendChild(mapFrame(data.mapUrl, '高德静态地图 API 生成'));
    stack.appendChild(shell.card);
    scrollBottom();
  }

  function renderGeocode(stack, data) {
    var shell = cardShell('pin', 'tone-pin', '地理编码结果', data.address || '');
    var grid = el('ip-grid');
    [
      { k: '坐标（经度,纬度）', v: data.location },
      { k: '标准地址', v: data.formatted },
      { k: '行政区划代码', v: data.adcode },
      { k: '所在地区', v: [data.province, data.city].filter(Boolean).join(' / ') }
    ].forEach(function (item) {
      var cell = el('ip-cell');
      cell.innerHTML = '<div class="k">' + esc(item.k) + '</div><div class="v" style="font-size:12.5px">' + esc(item.v || '—') + '</div>';
      grid.appendChild(cell);
    });
    shell.body.appendChild(grid);
    if (data.mapUrl) shell.body.appendChild(mapFrame(data.mapUrl, '坐标位置'));
    stack.appendChild(shell.card);
    scrollBottom();
  }

  function addCard(stack, result) {
    if (!result || result.ok === false) {
      var note = el('err-note');
      note.innerHTML = '<svg class="icon"><use href="#i-info"/></svg><span>' +
        esc((result && result.error) || '工具调用失败，请稍后重试。') + '</span>';
      stack.appendChild(note);
      scrollBottom();
      return;
    }
    var data = result.data || {};
    switch (data.type) {
      case 'place':
      case 'nearby': renderPois(stack, data); break;
      case 'route': renderRoute(stack, data); break;
      case 'weather': renderWeather(stack, data); break;
      case 'ip': renderIp(stack, data); break;
      case 'staticmap': renderStaticMap(stack, data); break;
      case 'geocode': renderGeocode(stack, data); break;
      default:
        var generic = el('bubble');
        generic.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-all;margin:0">' + esc(JSON.stringify(data, null, 2)) + '</pre>';
        stack.appendChild(generic);
    }
    scrollBottom();
  }

  function addAssistantText(stack, text) {
    var bubble = el('bubble');
    bubble.innerHTML = renderMarkdown(text);
    stack.appendChild(bubble);
    scrollBottom();
  }

  function toast(message, isError) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2600);
  }

  global.UI = {
    init: init,
    esc: esc,
    renderMarkdown: renderMarkdown,
    clearMessages: clearMessages,
    addUserMessage: addUserMessage,
    addMessage: addMessage,
    addThinking: addThinking,
    setThinkingText: setThinkingText,
    removeNode: removeNode,
    addTrace: addTrace,
    updateTrace: updateTrace,
    addCard: addCard,
    addAssistantText: addAssistantText,
    scrollBottom: scrollBottom,
    toast: toast
  };
})(window);
