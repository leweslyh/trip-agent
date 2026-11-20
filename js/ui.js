/* 界面渲染：消息气泡、工具卡片、静态地图面板、状态 */
(function (global) {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function inline(text, parent) {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const token = m[0];
      if (token.slice(0, 2) === '**') {
        parent.appendChild(el('strong', null, token.slice(2, -2)));
      } else if (token.charAt(0) === '`') {
        parent.appendChild(el('code', null, token.slice(1, -1)));
      } else {
        const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        const a = el('a', null, parts[1]);
        a.href = parts[2];
        a.target = '_blank';
        a.rel = 'noopener';
        parent.appendChild(a);
      }
      last = m.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderRichText(target, text) {
    target.textContent = '';
    const lines = String(text || '').split(/\r?\n/);
    let list = null;
    lines.forEach(function (line) {
      const t = line.trim();
      if (!t) { list = null; return; }
      if (/^[-*•]\s+/.test(t)) {
        if (!list) { list = el('ul', 'md-list'); target.appendChild(list); }
        const li = el('li');
        inline(t.replace(/^[-*•]\s+/, ''), li);
        list.appendChild(li);
        return;
      }
      if (/^#{1,5}\s+/.test(t)) {
        const p = el('p');
        const b = el('strong', null, t.replace(/^#{1,5}\s+/, ''));
        p.appendChild(b);
        target.appendChild(p);
        list = null;
        return;
      }
      list = null;
      const p = el('p');
      inline(t, p);
      target.appendChild(p);
    });
  }

  /* ---------- 消息 ---------- */

  let messagesEl = null;

  function initMessages() {
    messagesEl = $('messages');
  }

  function scrollBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMessage(text) {
    const welcome = $('welcome');
    if (welcome) welcome.remove();
    const wrap = el('div', 'msg user');
    wrap.appendChild(el('div', 'avatar', '我'));
    const bubble = el('div', 'bubble');
    renderRichText(bubble, text);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  function addAssistantMessage() {
    const welcome = $('welcome');
    if (welcome) welcome.remove();
    const wrap = el('div', 'msg assistant');
    wrap.appendChild(el('div', 'avatar', 'AI'));
    const bubble = el('div', 'bubble');
    const toolList = el('div', 'tool-list');
    const content = el('div', 'content');
    bubble.appendChild(toolList);
    bubble.appendChild(content);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollBottom();

    let raw = '';
    let raf = 0;

    function paint() {
      raf = 0;
      renderRichText(content, raw);
      scrollBottom();
    }

    return {
      wrap: wrap,
      toolList: toolList,
      content: content,
      setText: function (text) {
        raw = text || '';
        if (raf) cancelAnimationFrame(raf);
        paint();
      },
      appendText: function (chunk) {
        raw += chunk;
        if (!raf) raf = requestAnimationFrame(paint);
      },
      rawText: function () { return raw; },
      setTyping: function (on) {
        if (!on) return;
        raw = '';
        const box = el('div', 'typing');
        box.appendChild(el('i')); box.appendChild(el('i')); box.appendChild(el('i'));
        content.textContent = '';
        content.appendChild(box);
      },
      remove: function () { wrap.remove(); }
    };
  }

  /* ---------- 工具卡片 ---------- */

  const TITLES = {
    search_keywords: '关键字搜索',
    search_nearby: '周边搜索',
    plan_route: '路径规划',
    query_weather: '天气查询',
    show_static_map: '静态地图',
    locate_ip: 'IP 定位',
    geocode_address: '地址解析',
    reverse_geocode: '逆地理编码'
  };

  function cardHead(title, sub) {
    const head = el('div', 'tool-head');
    head.appendChild(el('span', 'dot'));
    head.appendChild(el('b', null, title));
    if (sub) head.appendChild(el('span', null, '· ' + sub));
    head.appendChild(el('span', 'spin', '运行中…'));
    return head;
  }

  function addToolCard(name, args) {
    const card = el('div', 'tool-card');
    let sub = '';
    if (name === 'search_keywords') sub = args.keywords || '';
    else if (name === 'search_nearby') sub = (args.keywords || '周边') + (args.radius ? ' · ' + args.radius + ' 米' : '');
    else if (name === 'plan_route') sub = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '公交' }[args.mode] || '';
    else if (name === 'query_weather') sub = args.city || '';
    else if (name === 'show_static_map') sub = args.title || '';
    const head = cardHead(TITLES[name] || name, sub);
    card.appendChild(head);
    const body = el('div', 'tool-body');
    body.appendChild(el('span', 'muted', '正在调用高德接口…'));
    card.appendChild(body);
    return { card: card, head: head, body: body };
  }

  function finishHead(head, ok, note) {
    head.classList.toggle('fail', !ok);
    const spin = head.querySelector('.spin');
    if (spin) spin.textContent = note || (ok ? '已完成' : '失败');
  }

  function kvItem(label, value) {
    const s = el('span');
    s.appendChild(el('b', null, label + ' '));
    s.appendChild(document.createTextNode(String(value)));
    return s;
  }

  function poiList(pois, limit) {
    const box = el('div', 'poi-list');
    (pois || []).slice(0, limit || 5).forEach(function (p, i) {
      const item = el('div', 'poi');
      item.appendChild(el('div', 'idx', i + 1));
      const main = el('div');
      main.appendChild(el('div', 'name', p.name));
      const metaBits = [];
      if (p.distance) metaBits.push('距中心约 ' + Amap.formatDistance(p.distance));
      if (p.type) metaBits.push(p.type);
      if (p.address) metaBits.push(p.address);
      if (p.tel) metaBits.push('电话 ' + p.tel);
      main.appendChild(el('div', 'meta', metaBits.join(' · ') || '暂无更多信息'));
      item.appendChild(main);
      box.appendChild(item);
    });
    return box;
  }

  function renderRoute(body, d) {
    const kv = el('div', 'kv');
    kv.appendChild(kvItem('距离', Amap.formatDistance(d.distance)));
    kv.appendChild(kvItem('耗时', Amap.formatDuration(d.duration)));
    if (d.mode === 'driving') {
      if (d.taxiCost) kv.appendChild(kvItem('打车约', d.taxiCost + ' 元'));
      if (d.trafficLights) kv.appendChild(kvItem('红绿灯', d.trafficLights + ' 个'));
    }
    if (d.mode === 'transit' && d.cost) kv.appendChild(kvItem('票价约', d.cost + ' 元'));
    body.appendChild(kv);

    const from = el('div', 'meta', '起点：' + ((d.origin && d.origin.name) || d.origin.location));
    const to = el('div', 'meta', '终点：' + ((d.destination && d.destination.name) || d.destination.location));
    body.appendChild(from);
    body.appendChild(to);

    if (d.mode === 'transit' && d.plans) {
      d.plans.forEach(function (plan) {
        const box = el('div', 'poi');
        box.appendChild(el('div', 'idx', plan.index));
        const main = el('div');
        main.appendChild(el('div', 'name',
          '方案 ' + plan.index + '：' + Amap.formatDuration(plan.duration) + ' · ' + Amap.formatDistance(plan.distance) +
          (plan.cost ? ' · ' + plan.cost + ' 元' : '')));
        (plan.segments || []).forEach(function (seg) {
          main.appendChild(el('div', 'meta', seg.join(' ')));
        });
        box.appendChild(main);
        body.appendChild(box);
      });
      return;
    }

    const list = el('ol', 'reason-list');
    (d.steps || []).slice(0, 8).forEach(function (s) {
      list.appendChild(el('li', null, s.instruction + '（' + Amap.formatDistance(s.distance) + '）'));
    });
    if (list.children.length) body.appendChild(list);
  }

  function renderWeather(body, d) {
    const kv = el('div', 'kv');
    kv.appendChild(kvItem('城市', d.city));
    if (d.live) {
      kv.appendChild(kvItem('实况', d.live.weather + ' ' + d.live.temperature + '℃'));
      kv.appendChild(kvItem('风', d.live.wind));
      kv.appendChild(kvItem('湿度', d.live.humidity ? d.live.humidity + '%' : '-'));
    }
    body.appendChild(kv);

    if (d.casts && d.casts.length) {
      const grid = el('div', 'weather-grid');
      d.casts.forEach(function (c) {
        const cell = el('div', 'weather-cell');
        cell.appendChild(el('div', 'd', c.date + ' ' + (c.week || '')));
        cell.appendChild(el('div', 'w', c.day + ' / ' + c.night));
        cell.appendChild(el('div', 't', c.dayTemp + '℃ / ' + c.nightTemp + '℃'));
        grid.appendChild(cell);
      });
      body.appendChild(grid);
    }
  }

  function renderLocation(body, d) {
    const kv = el('div', 'kv');
    if (d.province) kv.appendChild(kvItem('省份', d.province));
    if (d.city) kv.appendChild(kvItem('城市', d.city));
    if (d.adcode) kv.appendChild(kvItem('adcode', d.adcode));
    if (d.center) kv.appendChild(kvItem('坐标', d.center));
    body.appendChild(kv);
    if (d.address) body.appendChild(el('div', 'meta', '附近：' + d.address));
  }

  function renderGeocode(body, d) {
    const kv = el('div', 'kv');
    kv.appendChild(kvItem('地址', d.formatted));
    kv.appendChild(kvItem('坐标', d.location));
    if (d.level) kv.appendChild(kvItem('精度', d.level));
    body.appendChild(kv);
  }

  function renderToolResult(card, name, output) {
    const body = card.body;
    body.textContent = '';

    if (!output || !output.ok) {
      finishHead(card.head, false, '失败');
      body.appendChild(el('div', 'err-text', (output && output.error) || '调用失败'));
      scrollBottom();
      return;
    }

    const d = output.data || {};
    finishHead(card.head, true);

    if (name === 'search_keywords' || name === 'search_nearby') {
      const kv = el('div', 'kv');
      kv.appendChild(kvItem('结果数', (d.count || (d.pois || []).length) + ' 条'));
      if (d.city) kv.appendChild(kvItem('城市', d.city));
      if (d.radius) kv.appendChild(kvItem('半径', Amap.formatDistance(d.radius)));
      body.appendChild(kv);
      if (!(d.pois || []).length) {
        body.appendChild(el('div', 'meta', '没有找到相关结果，换个关键词或扩大半径试试。'));
      } else {
        body.appendChild(poiList(d.pois, 5));
      }
    } else if (name === 'plan_route') {
      renderRoute(body, d);
    } else if (name === 'query_weather') {
      renderWeather(body, d);
    } else if (name === 'locate_ip') {
      renderLocation(body, d);
    } else if (name === 'geocode_address' || name === 'reverse_geocode') {
      renderGeocode(body, d);
    } else if (name === 'show_static_map') {
      body.appendChild(el('div', 'meta', '已生成地图：' + (d.title || '静态地图') + '（见右侧面板）'));
    } else {
      body.appendChild(el('div', 'meta', JSON.stringify(d).slice(0, 300)));
    }
    scrollBottom();
  }

  /* ---------- 地图面板 ---------- */

  const mapState = { url: '', title: '', caption: '', openUrl: '' };

  function setMapLoading(on) {
    const box = $('map-loading');
    if (box) box.classList.toggle('show', !!on);
  }

  function setMap(spec) {
    const img = $('map-img');
    const empty = $('map-empty');
    if (!spec || !spec.url) return;

    $('map-title').textContent = spec.title || '静态地图';
    $('map-sub').textContent = '由高德静态地图 API 实时渲染';
    $('map-caption').textContent = spec.caption || '';
    mapState.url = spec.url;
    mapState.openUrl = spec.openUrl || '';

    const link = $('btn-map-open');
    if (spec.openUrl) {
      link.href = spec.openUrl;
      link.classList.remove('disabled');
    } else {
      link.classList.add('disabled');
      link.removeAttribute('href');
    }

    setMapLoading(true);
    img.classList.remove('show');
    if (empty) empty.style.display = 'none';

    img.onload = function () { setMapLoading(false); img.classList.add('show'); };
    img.onerror = function () {
      setMapLoading(false);
      img.classList.remove('show');
      if (empty) {
        empty.style.display = '';
        empty.querySelector('p').textContent = '静态地图加载失败';
        empty.querySelector('span').textContent = '请检查高德 Key 是否开通静态地图权限';
      }
    };
    img.src = spec.url;
  }

  function currentMap() { return mapState; }

  function updateLocation(data) {
    const box = $('loc-body');
    if (!box) return;
    box.textContent = '';
    if (!data) {
      box.appendChild(el('p', 'muted', '尚未定位'));
      return;
    }
    box.appendChild(el('div', 'loc-city', data.city || data.province || '未知城市'));
    if (data.address) box.appendChild(el('div', 'loc-addr', data.address));
    const meta = el('div', 'loc-meta');
    if (data.adcode) meta.appendChild(el('span', null, 'adcode ' + data.adcode));
    if (data.center || (data.lng && data.lat)) meta.appendChild(el('span', null, data.center || (data.lng.toFixed(4) + ',' + data.lat.toFixed(4))));
    if (data.source) meta.appendChild(el('span', null, data.source));
    box.appendChild(meta);
  }

  function updateStatus(hasDS, hasAmap) {
    const ds = $('chip-ds');
    const am = $('chip-amap');
    ds.textContent = hasDS ? 'DeepSeek 已就绪' : 'DeepSeek 未配置';
    ds.className = 'chip ' + (hasDS ? 'ok' : 'bad');
    am.textContent = hasAmap ? '高德 Key 已就绪' : '高德 Key 未配置';
    am.className = 'chip ' + (hasAmap ? 'ok' : 'bad');
  }

  global.UI = {
    $: $,
    el: el,
    renderRichText: renderRichText,
    initMessages: initMessages,
    scrollBottom: scrollBottom,
    addUserMessage: addUserMessage,
    addAssistantMessage: addAssistantMessage,
    addToolCard: addToolCard,
    renderToolResult: renderToolResult,
    finishHead: finishHead,
    setMap: setMap,
    setMapLoading: setMapLoading,
    currentMap: currentMap,
    updateLocation: updateLocation,
    updateStatus: updateStatus
  };
})(window);
