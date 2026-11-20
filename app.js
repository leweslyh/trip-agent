/* 漫游 · Wayfarer AI — 纯前端出行小助手
   依托 DeepSeek（对话/视觉/联网/工具调用）与高德开放平台（搜索/路线/天气/静态地图/IP 定位） */
(() => {
  'use strict';

  const DEFAULTS = {
    // 请勿在仓库中提交明文 Key，运行时通过页面设置填写
    deepseek: '',
    silicon: '',
    amap1: '',
    amap2: '',
    model: 'deepseek-flash'
  };
  const LS_KEY = 'wayfarer.settings.v1';
  const DS_BASE = 'https://api.deepseek.com';
  const AMAP_BASE = 'https://restapi.amap.com';
  const SF_BASE = 'https://api.siliconflow.cn';
  const MODEL_LABEL = { 'deepseek-flash': 'DeepSeek V4.1 Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' };
  const DEFAULT_MAP = { center: [116.397, 39.909], zoom: 12, city: '北京' };

  /* ---------- DOM / utils ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const icon = (id, cls = 'ico') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/`/g, '&#96;'); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function nowLabel() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fmtClock(sec) {
    return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  }
  function truncate(str, n) {
    const s = String(str || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function toast(message, type = 'info', ms = 2600) {
    const stack = $('#toastStack');
    if (!stack) return;
    const node = document.createElement('div');
    node.className = 'toast' + (type === 'error' ? ' is-error' : '');
    node.innerHTML = `${icon(type === 'error' ? 'i-x' : 'i-check')}<span>${escapeHtml(message)}</span>`;
    stack.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制到剪贴板'); }
      catch { toast('复制失败，请手动选择文本', 'error'); }
      ta.remove();
    }
  }

  /* ---------- settings ---------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch { /* ignore */ }
    return Object.assign({}, DEFAULTS);
  }
  let settings = loadSettings();

  function persistSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }
  function apiKey(which) {
    if (which === 'amap') return [settings.amap1, settings.amap2].filter(Boolean);
    return settings[which] || '';
  }
  function applySettings() {
    const label = MODEL_LABEL[settings.model] || settings.model;
    $('#modelChipText').textContent = label;
    const ds = $('#dsServiceState');
    if (ds) ds.textContent = settings.deepseek ? label.replace('DeepSeek ', '') : '未配置';
    const amap = $('#amapServiceState');
    if (amap) amap.textContent = apiKey('amap').length ? 'Web 服务' : '未配置';
    const sf = $('#sfServiceState');
    if (sf) sf.textContent = settings.silicon ? '语音识别' : '未配置';
  }

  /* ---------- sessions ---------- */
  function newSession(key) {
    return {
      key,
      history: [],          // 发给模型的消息（含 reasoning/tool_calls）
      attachments: [],      // {id, name, dataUrl, size}
      web: true,
      think: key === 'travel',
      busy: false,
      controller: null,
      mapTouched: false
    };
  }
  const sessions = { chat: newSession('chat'), travel: newSession('travel') };

  const VIEW_META = {
    chat: { title: '旅行对话', eyebrow: 'DEEPSEEK × TRAVELER', thread: '#chatThread' },
    travel: { title: '出行助手', eyebrow: 'DEEPSEEK × AMAP × LIVE', thread: '#travelThread' }
  };
  let activeView = 'chat';

  function setView(view) {
    if (!VIEW_META[view]) return;
    activeView = view;
    $('#chatView').classList.toggle('is-active', view === 'chat');
    $('#travelView').classList.toggle('is-active', view === 'travel');
    $$('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
    $('#pageTitle').textContent = VIEW_META[view].title;
    $('#pageEyebrow').textContent = VIEW_META[view].eyebrow;
    $('#app').classList.remove('sidebar-open');
    const input = $(`[data-input="${view}"]`);
    if (input) setTimeout(() => input.focus(), 60);
    if (view === 'travel' && !sessions.travel.mapTouched) {
      sessions.travel.mapTouched = true;
      locateByIP(true);
    }
  }

  /* ---------- welcome ---------- */
  function promptCards() {
    return [
      { icon: 'i-map', tone: '', title: '北京一日游', desc: '景点 · 路线 · 天气一次给全', prompt: '帮我规划一条北京一日游路线，包含景点、路线和天气' },
      { icon: 'i-pin', tone: 'warm', title: '附近咖啡馆', desc: '以当前定位为中心周边搜索', prompt: '故宫附近有什么值得去的咖啡馆？帮我找几家' },
      { icon: 'i-route', tone: 'gold', title: '规划路线', desc: '步行 / 驾车 / 公交 / 骑行', prompt: '从国贸到颐和园怎么走？帮我规划一条最省时的路线' },
      { icon: 'i-sun', tone: '', title: '天气与玩法', desc: '未来天气 + 适合的去处', prompt: '杭州明天天气怎么样？适合去哪里玩？' }
    ];
  }

  function welcomeHTML(kind) {
    const cards = promptCards().map(c => `
      <button class="prompt-card" type="button" data-prompt="${escapeAttr(c.prompt)}">
        <span class="prompt-icon ${c.tone}">${icon(c.icon)}</span>
        <span class="prompt-copy"><strong>${c.title}</strong><span>${c.desc}</span></span>
        <span class="go">${icon('i-arrow-right')}</span>
      </button>`).join('');
    if (kind === 'travel') {
      return `<div class="welcome welcome-travel">
        <span class="welcome-kicker"><span class="spark">${icon('i-sparkles')}</span>DEEPSEEK × 高德开放平台</span>
        <h2>说个目的地<br>剩下的<em>交给我</em></h2>
        <p class="welcome-sub">我可以搜索地点、找周边、规划路线、查天气，并把结果直接画在地图上。所有地图数据来自高德，理解与规划来自 DeepSeek。</p>
        <div class="prompt-grid">${cards}</div>
        <div class="welcome-foot">
          <span>${icon('i-map')}静态地图</span><i></i>
          <span>${icon('i-route')}四种出行方式</span><i></i>
          <span>${icon('i-location')}IP 定位</span>
        </div>
      </div>`;
    }
    return `<div class="welcome">
      <span class="welcome-kicker"><span class="spark">${icon('i-sparkles')}</span>DEEPSEEK V4.1 FLASH · 视觉 + 语音</span>
      <h2>从一句<em>想去哪儿</em><br>开始你的旅程</h2>
      <p class="welcome-sub">这里可以聊行程、聊风景，也能直接发一张照片让我看看。支持语音输入，联网与深度思考随时开关。</p>
      <div class="prompt-grid">${cards}</div>
      <div class="welcome-foot">
        <span>${icon('i-image')}图片理解</span><i></i>
        <span>${icon('i-mic')}语音输入</span><i></i>
        <span>${icon('i-globe')}联网搜索</span>
      </div>
    </div>`;
  }

  function mountWelcome(key) {
    const thread = $(VIEW_META[key].thread);
    if (!thread) return;
    thread.innerHTML = welcomeHTML(key);
  }
  function clearWelcome(key) {
    const thread = $(VIEW_META[key].thread);
    const w = $('.welcome', thread);
    if (w) w.remove();
  }
  function resetSession(key) {
    const s = sessions[key];
    if (s.controller) { try { s.controller.abort(); } catch { /* ignore */ } }
    sessions[key] = newSession(key);
    sessions[key].web = s.web;
    sessions[key].think = s.think;
    sessions[key].mapTouched = s.mapTouched;
    $(VIEW_META[key].thread).innerHTML = '';
    mountWelcome(key);
    renderAttachments(key);
    syncComposer(key);
    toast('已开启新对话');
  }

  /* ---------- markdown ---------- */
  function inlineFormat(raw) {
    let s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (m, t, u) => `<a href="${u.replace(/&amp;/g, '&')}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    return s;
  }

  function renderMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        out.push(`<h${lv}>${inlineFormat(h[2])}</h${lv}>`);
        i++; continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr />'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && /^[\s|:\-]+$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
        out.push(`<table><thead><tr>${head.map(c => `<th>${inlineFormat(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineFormat(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map(t => `<li>${inlineFormat(t)}</li>`).join('')}</${tag}>`);
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
        !/^\s*(#{1,4}\s|```|>|([-*+]|\d+[.)])\s)/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push(`<p>${inlineFormat(buf.join('\n')).replace(/\n/g, '<br />')}</p>`);
    }
    return out.join('');
  }

  /* ---------- 高德开放平台 ---------- */
  function amapKeys() { return [settings.amap1, settings.amap2].filter(Boolean); }

  async function amapGet(path, params = {}) {
    const keys = amapKeys();
    if (!keys.length) throw new Error('请先在设置中填写高德 Key');
    let lastErr = null;
    for (const key of keys) {
      const url = new URL(AMAP_BASE + path);
      url.searchParams.set('key', key);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      });
      let data;
      try {
        const res = await fetch(url.toString());
        data = await res.json();
      } catch {
        lastErr = new Error('高德接口网络异常，请检查网络或 Key 配额');
        continue;
      }
      if (data && String(data.status) === '1') return data;
      lastErr = new Error(`高德接口：${(data && data.info) || '返回异常'}`);
    }
    throw lastErr || new Error('高德接口不可用');
  }

  function poiOf(p) {
    const loc = String(p.location || '').split(',').map(Number);
    const typeStr = typeof p.type === 'string' ? p.type : '';
    return {
      id: p.id || '',
      name: typeof p.name === 'string' ? p.name : '未命名地点',
      type: typeStr.split(';').filter(Boolean).pop() || '地点',
      address: [typeof p.pname === 'string' ? p.pname : '', typeof p.cityname === 'string' ? p.cityname : '',
        typeof p.adname === 'string' ? p.adname : '', typeof p.address === 'string' ? p.address : ''].filter(Boolean).join(''),
      tel: typeof p.tel === 'string' ? p.tel : '',
      lng: loc[0], lat: loc[1],
      distance: Number(p.distance) || 0
    };
  }

  function placeList(data) {
    return (Array.isArray(data.pois) ? data.pois : []).map(poiOf).filter(p => isFinite(p.lng) && isFinite(p.lat));
  }

  async function amapPlaceText(keywords, city) {
    const data = await amapGet('/v3/place/text', { keywords, city, citylimit: city ? 'true' : '', offset: 12, page: 1, extensions: 'base' });
    return placeList(data);
  }

  async function amapPlaceAround(keywords, location, radius = 2000, city) {
    const data = await amapGet('/v3/place/around', { keywords, location, radius, sortrule: 'distance', offset: 12, page: 1, extensions: 'base', city });
    return placeList(data);
  }

  async function amapGeocode(address, city) {
    const data = await amapGet('/v3/geocode/geo', { address, city });
    const g = (data.geocodes || [])[0];
    if (!g) return null;
    const [lng, lat] = String(g.location).split(',').map(Number);
    return { lng, lat, city: g.city, adcode: g.adcode, formatted: g.formatted_address };
  }

  async function amapRegeo(location) {
    const data = await amapGet('/v3/geocode/regeo', { location });
    const r = data.regeocode || {};
    return {
      formatted: r.formatted_address || '',
      city: (r.addressComponent && (r.addressComponent.city || r.addressComponent.province)) || ''
    };
  }

  const WEATHER_ICON = { '晴': 'i-sun', '多云': 'i-cloud', '阴': 'i-cloud', '小雨': 'i-rain', '中雨': 'i-rain', '大雨': 'i-rain', '暴雨': 'i-rain', '雷阵雨': 'i-rain', '阵雨': 'i-rain', '雪': 'i-rain', '雾': 'i-cloud', '霾': 'i-cloud', '风': 'i-cloud' };
  function weatherIcon(text) {
    const t = String(text || '');
    for (const k of Object.keys(WEATHER_ICON)) if (t.includes(k)) return WEATHER_ICON[k];
    return 'i-sun';
  }

  async function amapWeather(city) {
    const data = await amapGet('/v3/weather/weatherInfo', { city, extensions: 'all' });
    const f = (data.forecasts || [])[0];
    if (!f) throw new Error('没有查到该城市的天气');
    return {
      city: f.city, province: f.province,
      updated: f.reporttime,
      casts: (f.casts || []).map(c => ({
        date: c.date, week: c.week, dayWeather: c.dayweather, nightWeather: c.nightweather,
        dayTemp: Number(c.daytemp), nightTemp: Number(c.nighttemp),
        dayWind: `${c.daywind || ''}${c.daypower || ''}`, nightWind: `${c.nightwind || ''}${c.nightpower || ''}`
      }))
    };
  }

  /* ---------- 地图渲染 ---------- */
  const mapState = { center: DEFAULT_MAP.center.slice(), zoom: DEFAULT_MAP.zoom, city: DEFAULT_MAP.city, markers: [], paths: [], title: '北京 · 城市中心', caption: '' };
  let mapRenderSeq = 0;
  const PALETTE = ['DD5A35', '1F6F5C', '2F6FA8', 'B4761C', '7A4E9B'];

  function mapStaticUrl(state) {
    const key = settings.amap1 || settings.amap2;
    if (!key) return '';
    const p = new URLSearchParams();
    p.set('key', key);
    p.set('location', `${state.center[0].toFixed(6)},${state.center[1].toFixed(6)}`);
    p.set('zoom', String(Math.max(4, Math.min(17, Math.round(state.zoom)))));
    p.set('size', '600*360');
    p.set('scale', '2');
    if (state.markers.length) {
      p.set('markers', state.markers.slice(0, 10).map((m, idx) =>
        `mid,0x${m.color || PALETTE[idx % PALETTE.length]},${String.fromCharCode(65 + idx)}:${m.lng.toFixed(6)},${m.lat.toFixed(6)}`
      ).join('|'));
    }
    if (state.paths.length) {
      p.set('paths', state.paths.map(line => {
        const pts = line.filter(c => isFinite(c[0]) && isFinite(c[1]));
        if (pts.length < 2) return '';
        const step = Math.max(1, Math.floor(pts.length / 120));
        const sampled = pts.filter((_, idx) => idx % step === 0 || idx === pts.length - 1);
        return `6,0x1F6F5C,0.9,0x1F6F5C,0.12:${sampled.map(c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(';')}`;
      }).filter(Boolean).join('|'));
    }
    return `${AMAP_BASE}/v3/staticmap?${p.toString()}`;
  }

  function renderMap() {
    const img = $('#mapImage');
    const url = mapStaticUrl(mapState);
    if (!url) {
      $('#mapSkeleton').classList.add('is-hidden');
      $('#mapFallback').classList.add('is-visible');
      return;
    }
    mapRenderSeq++;
    img.classList.remove('is-loaded');
    $('#mapSkeleton').classList.remove('is-hidden');
    $('#mapFallback').classList.remove('is-visible');
    img.dataset.seq = String(mapRenderSeq);
    img.src = url;
  }

  function setMap(opts = {}) {
    if (Array.isArray(opts.center) && isFinite(opts.center[0]) && isFinite(opts.center[1])) {
      mapState.center = [Number(opts.center[0]), Number(opts.center[1])];
    }
    if (isFinite(opts.zoom)) mapState.zoom = Number(opts.zoom);
    if (Array.isArray(opts.markers)) {
      mapState.markers = opts.markers.filter(m => isFinite(m.lng) && isFinite(m.lat)).slice(0, 10);
      if (mapState.markers.length && opts.center === undefined) {
        const ms = mapState.markers;
        mapState.center = [
          ms.reduce((a, m) => a + m.lng, 0) / ms.length,
          ms.reduce((a, m) => a + m.lat, 0) / ms.length
        ];
        if (ms.length === 1) mapState.zoom = Math.max(mapState.zoom, 15);
      }
    }
    if (Array.isArray(opts.paths)) mapState.paths = opts.paths;
    if (opts.city) mapState.city = String(opts.city).replace(/市$/, '');
    if (opts.title) {
      mapState.title = opts.title;
      $('#canvasTitle').textContent = opts.title;
    }
    if (opts.caption) {
      mapState.caption = opts.caption;
      $('#mapCaptionText').textContent = opts.caption;
    }
    renderMap();
  }

  function showWeatherFloat(w) {
    const box = $('#weatherFloat');
    if (!w || !w.casts || !w.casts.length) { box.hidden = true; return; }
    const today = w.casts[0];
    box.innerHTML = `<span class="wf-icon">${icon(weatherIcon(today.dayWeather))}</span>
      <span class="wf-copy"><strong>${today.dayTemp}°</strong><span>${escapeHtml(w.city)} · ${escapeHtml(today.dayWeather)} ${today.nightTemp}°</span></span>`;
    box.hidden = false;
  }

  async function locateByIP(silent) {
    try {
      const data = await amapGet('/v3/ip', {});
      const city = String(data.city || data.province || '').replace(/市$/, '');
      let center = null;
      const rect = String(data.rectangle || '').split(';');
      if (rect.length === 2) {
        const a = rect[0].split(',').map(Number);
        const b = rect[1].split(',').map(Number);
        if (a.length === 2 && b.length === 2 && isFinite(a[0]) && isFinite(b[0])) {
          center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        }
      }
      if (!center && city) {
        const g = await amapGeocode(city, city);
        if (g) center = [g.lng, g.lat];
      }
      if (!city && !center) throw new Error('无法识别当前网络位置');
      setMap({
        center: center || undefined, zoom: 12, markers: [], paths: [],
        city: city || '当前位置',
        title: `${city || '当前位置'} · 城市中心`,
        caption: `IP 定位：${city || '未知'}`
      });
      if (!silent) toast(`已定位到 ${city || '当前城市'}`);
      return { city, center };
    } catch (e) {
      if (!silent) toast(e.message || '定位失败', 'error');
      return null;
    }
  }

  /* ---------- DeepSeek 客户端 ---------- */
  function dsHeaders() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseek}` };
  }

  async function readError(res, fallback) {
    try {
      const data = await res.json();
      return (data.error && data.error.message) || data.message || fallback;
    } catch {
      return fallback;
    }
  }

  async function dsStream({ messages, tools, think, model, signal, onEvent }) {
    if (!settings.deepseek) throw new Error('请先在设置中填写 DeepSeek API Key');
    const payload = {
      model: model || settings.model,
      messages,
      stream: true,
      max_tokens: 4096,
      thinking: { type: think ? 'enabled' : 'disabled' }
    };
    if (think) payload.reasoning_effort = 'high';
    if (tools && tools.length) payload.tools = tools;

    const res = await fetch(`${DS_BASE}/v1/chat/completions`, {
      method: 'POST', headers: dsHeaders(), body: JSON.stringify(payload), signal
    });
    if (!res.ok) throw new Error(await readError(res, `DeepSeek 请求失败（${res.status}）`));
    if (!res.body) throw new Error('当前浏览器不支持流式响应');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finish = null;
    let serverToolCalls = null;
    let annotations = null;
    const toolCalls = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let json;
        try { json = JSON.parse(raw); } catch { continue; }
        if (json.error) throw new Error(json.error.message || 'DeepSeek 返回错误');
        const choice = (json.choices || [])[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (onEvent) onEvent('reasoning', delta.reasoning_content);
        }
        if (delta.content) {
          content += delta.content;
          if (onEvent) onEvent('content', delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach((tc, n) => {
            const idx = typeof tc.index === 'number' ? tc.index : n;
            if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            const slot = toolCalls[idx];
            if (tc.id) slot.id = tc.id;
            if (tc.type) slot.type = tc.type;
            if (tc.function && tc.function.name) slot.function.name += tc.function.name;
            if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments;
          });
        }
        if (delta.server_tool_calls) serverToolCalls = delta.server_tool_calls;
        if (delta.annotations) annotations = delta.annotations;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    return {
      content: content.replace(/【\d+†[^】]*】/g, '').trim(),
      reasoning, finish, serverToolCalls, annotations,
      toolCalls: toolCalls.filter(Boolean).filter(t => t.function && t.function.name)
    };
  }

  async function dsSearch(query, count = 8) {
    const res = await fetch(`${DS_BASE}/v1/tools/search`, {
      method: 'POST', headers: dsHeaders(), body: JSON.stringify({ query, count })
    });
    if (!res.ok) throw new Error(await readError(res, '网页搜索失败'));
    const data = await res.json();
    const list = data.results || data.data || [];
    return list.map(r => ({
      title: r.title || r.name || '未命名结果',
      url: r.url || r.link || '',
      site: r.site_name || r.site || '',
      icon: r.site_icon || '',
      date: r.date || '',
      snippet: r.summary || r.snippet || r.content || ''
    })).filter(r => r.url);
  }

  async function dsFetch(url) {
    const res = await fetch(`${DS_BASE}/v1/tools/fetch`, {
      method: 'POST', headers: dsHeaders(), body: JSON.stringify({ url })
    });
    if (!res.ok) throw new Error(await readError(res, '正文抓取失败'));
    const data = await res.json();
    return { title: data.title || '', content: data.content || '' };
  }

  /* ---------- 智能体工具 ---------- */
  const TRAVEL_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'search_place',
        description: '按关键字搜索地点（POI），返回名称、详细地址、类型和经纬度。需要坐标或用户提到某个景点/餐厅/商场时优先调用。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词，例如“故宫博物院”“咖啡馆”“西湖”' },
            city: { type: 'string', description: '城市名，例如“北京”“杭州”，可留空使用当前定位城市' }
          },
          required: ['keywords']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_around',
        description: '以某个经纬度为中心做周边搜索，返回按距离排序的地点。用于“附近有什么”“周边 2 公里内的餐厅”。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词，例如“咖啡馆”“酒店”“地铁站”' },
            location: { type: 'string', description: '中心点经纬度，格式“经度,纬度”，例如“116.397,39.909”；不填则使用当前地图中心' },
            radius: { type: 'number', description: '搜索半径，单位米，默认 2000，最大 50000' },
            city: { type: 'string', description: '城市名，可选' }
          },
          required: ['keywords']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan_route',
        description: '规划两点之间的路线。返回距离、耗时、途经步骤和路线坐标，并自动画在地图上。起点终点可以是地名或“经度,纬度”。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['walking', 'driving', 'transit', 'bicycling'], description: '出行方式：步行 / 驾车 / 公交地铁 / 骑行' },
            origin: { type: 'string', description: '起点，地名或“经度,纬度”' },
            destination: { type: 'string', description: '终点，地名或“经度,纬度”' },
            city: { type: 'string', description: '城市名，公交规划必填' }
          },
          required: ['mode', 'origin', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询城市未来几天的天气预报（高德开放平台）。用户问天气、穿衣、适不适合出行时调用。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名或 adcode，例如“杭州”“110000”' }
          },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_map',
        description: '在右侧画布展示静态地图。可以指定中心点、缩放级别（4-17）、标记点和标题。展示搜索结果或路线后通常无需再调用。',
        parameters: {
          type: 'object',
          properties: {
            center: { type: 'string', description: '中心点“经度,纬度”' },
            zoom: { type: 'number', description: '缩放级别 4-17' },
            markers: {
              type: 'array',
              description: '标记点列表，最多 10 个',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  lng: { type: 'number' },
                  lat: { type: 'number' }
                },
                required: ['lng', 'lat']
              }
            },
            title: { type: 'string', description: '画布标题，例如“杭州 · 西湖”' },
            caption: { type: 'string', description: '地图底部说明文字' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ip_locate',
        description: '通过当前网络 IP 定位所在城市，并把地图移动到该城市中心。用户说“我在哪”“附近”但没给位置时调用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'geocode',
        description: '把地址或地名转换成经纬度。需要精确坐标时使用。',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '结构化地址或地名' },
            city: { type: 'string', description: '城市名，可选' }
          },
          required: ['address']
        }
      }
    }
  ];

  function toolsFor(key, web) {
    const list = [];
    if (key === 'travel') list.push(...TRAVEL_TOOLS);
    if (web) list.push({ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' });
    return list;
  }

  function parseCoord(str) {
    const m = String(str || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lng = Number(m[1]), lat = Number(m[2]);
    if (!isFinite(lng) || !isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    return { lng, lat };
  }

  async function resolvePoint(text, city) {
    const raw = String(text || '').trim();
    const coord = parseCoord(raw);
    if (coord) return Object.assign({ name: raw }, coord);
    const useCity = city || mapState.city;
    try {
      const g = await amapGeocode(raw, useCity);
      if (g) return { name: raw, lng: g.lng, lat: g.lat, city: typeof g.city === 'string' ? g.city : '' };
    } catch { /* 继续尝试 POI 搜索 */ }
    try {
      const pois = await amapPlaceText(raw, useCity);
      if (pois.length) return { name: raw, lng: pois[0].lng, lat: pois[0].lat, city: useCity };
    } catch { /* ignore */ }
    return null;
  }

  function parsePolyline(str) {
    return String(str || '').split(';').map(p => p.split(',').map(Number))
      .filter(c => c.length === 2 && isFinite(c[0]) && isFinite(c[1]));
  }

  function fmtDistance(meters) {
    const m = Number(meters) || 0;
    return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
  }
  function fmtDuration(seconds) {
    const s = Number(seconds) || 0;
    if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
    return `${Math.max(1, Math.round(s / 60))} 分钟`;
  }

  const MODE_LABEL = { walking: '步行', driving: '驾车', transit: '公交地铁', bicycling: '骑行' };

  async function executeRoute(mode, origin, destination, city) {
    const o = await resolvePoint(origin, city);
    const d = await resolvePoint(destination, city);
    if (!o || !d) return null;
    const params = { origin: `${o.lng},${o.lat}`, destination: `${d.lng},${d.lat}` };
    if (mode === 'transit') {
      params.city = city || o.city || mapState.city || o.name;
      params.cityd = city || d.city || mapState.city || d.name;
    }
    let data, path, steps = [], line = [];
    if (mode === 'bicycling') {
      data = await amapGet('/v4/direction/bicycling', params);
      path = data.data && data.data.paths && data.data.paths[0];
    } else if (mode === 'transit') {
      data = await amapGet('/v3/direction/transit/integrated', params);
      const t = data.route && data.route.transits && data.route.transits[0];
      if (!t) return null;
      path = { distance: t.distance, duration: t.duration };
      (t.segments || []).forEach(seg => {
        (seg.walking && seg.walking.steps || []).forEach(st => {
          const pts = parsePolyline(st.polyline);
          line = line.concat(pts);
          if (pts.length) steps.push({ instruction: `步行 ${fmtDistance(st.distance)}${st.instruction ? '：' + st.instruction : ''}`, distance: Number(st.distance) || 0 });
        });
        (seg.bus && seg.bus.buslines || []).forEach(bl => {
          const pts = parsePolyline(bl.polyline);
          line = line.concat(pts);
          steps.push({ instruction: `乘坐 ${bl.name}，${bl.departure_stop && bl.departure_stop.name} 上车 → ${bl.arrival_stop && bl.arrival_stop.name} 下车`, distance: Number(bl.distance) || 0 });
        });
        if (seg.railway) steps.push({ instruction: `乘坐 ${seg.railway.name || '城际列车'}`, distance: Number(seg.railway.distance) || 0 });
        if (seg.taxi) steps.push({ instruction: `打车约 ${fmtDistance(seg.taxi.distance)}`, distance: Number(seg.taxi.distance) || 0 });
      });
    } else {
      data = await amapGet(`/v3/direction/${mode}`, { origin: params.origin, destination: params.destination });
      path = data.route && data.route.paths && data.route.paths[0];
    }
    if (!path) return null;
    (path.steps || []).forEach(st => {
      const pts = parsePolyline(st.polyline);
      line = line.concat(pts);
      steps.push({ instruction: st.instruction || st.road || '继续前行', distance: Number(st.distance) || 0, duration: Number(st.duration) || 0 });
    });
    return {
      mode, distance: Number(path.distance) || 0, duration: Number(path.duration) || 0,
      origin: o, destination: d, steps: steps.slice(0, 30), line
    };
  }

  async function runTool(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    switch (name) {
      case 'search_place': {
        const pois = await amapPlaceText(a.keywords, a.city || mapState.city);
        if (!pois.length) return { ok: false, message: `没有找到「${a.keywords}」，可以换个关键词试试` };
        fillResultPanel(poiCardsHTML(pois, `${a.keywords} · 搜索结果`));
        setMap({
          markers: pois.slice(0, 8), city: a.city || mapState.city,
          zoom: Math.max(mapState.zoom, 13),
          title: `${a.city || mapState.city} · ${a.keywords}`,
          caption: `${a.keywords}：共找到 ${pois.length} 个结果`
        });
        return { ok: true, count: pois.length, places: pois.slice(0, 8).map(p => ({ name: p.name, address: p.address, type: p.type, lng: p.lng, lat: p.lat })) };
      }
      case 'search_around': {
        let center = a.location ? parseCoord(a.location) : null;
        if (!center && a.location) center = await resolvePoint(a.location, a.city);
        if (!center) center = { lng: mapState.center[0], lat: mapState.center[1] };
        const radius = Math.min(50000, Math.max(100, Number(a.radius) || 2000));
        const pois = await amapPlaceAround(a.keywords, `${center.lng},${center.lat}`, radius, a.city || mapState.city);
        if (!pois.length) return { ok: false, message: `此范围内没有找到「${a.keywords}」，可以扩大半径` };
        fillResultPanel(poiCardsHTML(pois, `周边 ${radius} 米 · ${a.keywords}`));
        setMap({
          center: [center.lng, center.lat], markers: pois.slice(0, 8), zoom: 14,
          title: `周边搜索 · ${a.keywords}`,
          caption: `${fmtDistance(radius)}内找到 ${pois.length} 个「${a.keywords}」`
        });
        return { ok: true, count: pois.length, center, places: pois.slice(0, 8).map(p => ({ name: p.name, address: p.address, distance: p.distance, lng: p.lng, lat: p.lat })) };
      }
      case 'plan_route': {
        const mode = ['walking', 'driving', 'transit', 'bicycling'].includes(a.mode) ? a.mode : 'driving';
        const route = await executeRoute(mode, a.origin, a.destination, a.city);
        if (!route) return { ok: false, message: '路线规划失败，请确认起点和终点是否可识别' };
        renderRoutePanel(route);
        setMap({
          center: [route.origin.lng, route.origin.lat],
          markers: [{ lng: route.origin.lng, lat: route.origin.lat, name: '起点' }, { lng: route.destination.lng, lat: route.destination.lat, name: '终点' }],
          paths: [route.line], zoom: 13,
          title: `${route.origin.name} → ${route.destination.name}`,
          caption: `${MODE_LABEL[mode]} · ${fmtDistance(route.distance)} · 约 ${fmtDuration(route.duration)}`
        });
        return {
          ok: true, mode: MODE_LABEL[mode], distance: fmtDistance(route.distance), duration: fmtDuration(route.duration),
          origin: { name: route.origin.name, lng: route.origin.lng, lat: route.origin.lat },
          destination: { name: route.destination.name, lng: route.destination.lng, lat: route.destination.lat },
          steps: route.steps.slice(0, 12).map(s => s.instruction)
        };
      }
      case 'get_weather': {
        const w = await amapWeather(a.city || mapState.city);
        showWeatherFloat(w);
        fillResultPanel(weatherHTML(w));
        return { ok: true, city: w.city, updated: w.updated, forecast: w.casts.map(c => ({ date: c.date, week: c.week, day: c.dayWeather, night: c.nightWeather, high: c.dayTemp, low: c.nightTemp, wind: c.dayWind })) };
      }
      case 'show_map': {
        const markers = (Array.isArray(a.markers) ? a.markers : []).map(m => ({
          lng: Number(m.lng), lat: Number(m.lat), name: m.name || ''
        })).filter(m => isFinite(m.lng) && isFinite(m.lat));
        const center = a.center ? parseCoord(a.center) : null;
        setMap({
          center: center ? [center.lng, center.lat] : undefined,
          zoom: isFinite(Number(a.zoom)) ? Number(a.zoom) : undefined,
          markers, title: a.title || mapState.title,
          caption: a.caption || (markers.length ? `已标记 ${markers.length} 个地点` : '地图已更新')
        });
        return { ok: true, center: mapState.center, zoom: mapState.zoom, markers: markers.length };
      }
      case 'ip_locate': {
        const r = await locateByIP(true);
        if (!r) return { ok: false, message: 'IP 定位失败，请让用户直接给出城市名' };
        return { ok: true, city: r.city, center: r.center };
      }
      case 'geocode': {
        const g = await amapGeocode(a.address, a.city || mapState.city);
        if (!g) return { ok: false, message: `无法解析「${a.address}」的坐标` };
        return { ok: true, address: a.address, lng: g.lng, lat: g.lat, city: g.city, formatted: g.formatted };
      }
      default:
        return { ok: false, message: `未知工具：${name}` };
    }
  }

  /* ---------- 右侧面板渲染 ---------- */
  function fillResultPanel(html) {
    const box = $('#toolResults');
    if (box) box.innerHTML = html;
  }

  function amapUri(lng, lat, name) {
    return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(name || '地点')}&src=wayfarer&coordinate=gaode&callnative=0`;
  }

  function poiCardsHTML(pois, caption) {
    const cards = pois.map((p, i) => {
      const payload = escapeAttr(JSON.stringify({ lng: p.lng, lat: p.lat, name: p.name }));
      return `<div class="result-card">
        <span class="result-index">${i + 1}</span>
        <div class="result-main">
          <div class="result-name">${escapeHtml(p.name)}<span class="result-tag">${escapeHtml(p.type || '地点')}</span></div>
          <div class="result-meta">
            <span>${escapeHtml(p.address || '暂无地址')}</span>
            ${p.tel ? `<span>${escapeHtml(p.tel)}</span>` : ''}
            ${p.distance ? `<span class="result-loc">距中心 ${fmtDistance(p.distance)}</span>` : ''}
          </div>
        </div>
        <div class="result-actions">
          <button class="result-btn" type="button" data-map-poi="${payload}" title="在地图上查看">${icon('i-pin')}</button>
          <button class="result-btn" type="button" data-open-poi="${payload}" title="在高德打开">${icon('i-external')}</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="tb-hint" style="margin-bottom:5px">${escapeHtml(caption || '')}</div><div class="result-list">${cards}</div>`;
  }

  function weatherHTML(w) {
    const today = w.casts[0] || {};
    const days = w.casts.map(c => `<div class="weather-day">${escapeHtml(c.week)}<b>${escapeHtml(c.dayWeather)}</b><em>${c.nightTemp}° / ${c.dayTemp}°</em></div>`).join('');
    return `<div class="weather-card">
      <div class="weather-now">
        <span class="wn-icon">${icon(weatherIcon(today.dayWeather))}</span>
        <span class="wn-copy"><strong>${today.dayTemp}°</strong><span>${escapeHtml(w.city)} · ${escapeHtml(today.dayWeather)} · ${escapeHtml(today.dayWind || '')}</span><span>${escapeHtml(w.updated || '')}</span></span>
      </div>
      <div class="weather-days">${days}</div>
    </div>`;
  }

  function renderRoutePanel(route) {
    const steps = route.steps.map((s, i) => `<div class="route-step"><b>${i + 1}</b><span>${escapeHtml(s.instruction)}${s.distance ? `<em>${fmtDistance(s.distance)}</em>` : ''}</span></div>`).join('');
    fillResultPanel(`<div class="route-summary"><strong>${fmtDuration(route.duration)}</strong><i></i><span>${fmtDistance(route.distance)}</span><i></i><span>${MODE_LABEL[route.mode]}</span></div>
      <div class="tb-hint" style="margin-bottom:4px">${escapeHtml(route.origin.name)} → ${escapeHtml(route.destination.name)}</div>
      <div class="route-steps">${steps || '<div class="tool-empty">没有详细步骤</div>'}</div>`);
  }

  /* ---------- 消息渲染 ---------- */
  function scrollThread(key) {
    const scroller = key === 'travel' ? $('#travelScroll') : $('#chatScroll');
    if (!scroller) return;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function appendUserMessage(key, text, images) {
    const thread = $(VIEW_META[key].thread);
    const node = document.createElement('div');
    node.className = 'message message-user';
    node.innerHTML = `<div class="message-meta">${nowLabel()}</div>
      ${images.length ? `<div class="user-images">${images.map(src => `<img src="${src}" alt="附图" data-zoom-img="${src}" />`).join('')}</div>` : ''}
      ${text ? `<div class="user-bubble">${escapeHtml(text)}</div>` : ''}`;
    thread.appendChild(node);
    scrollThread(key);
  }

  function modelShortLabel() {
    return settings.model === 'deepseek-v4-pro' ? 'V4 Pro' : 'V4.1 Flash';
  }

  function createAssistantMessage(key) {
    const thread = $(VIEW_META[key].thread);
    const root = document.createElement('div');
    root.className = 'message';
    root.innerHTML = `<div class="assistant-wrap">
      <div class="ai-mark" aria-hidden="true">
        <svg viewBox="0 0 44 44" fill="none">
          <circle cx="22" cy="22" r="19" stroke="currentColor" stroke-width="1.2" opacity=".4"/>
          <path d="M27.8 16.2 24.6 24.6 16.2 27.8 19.4 19.4 27.8 16.2Z" fill="currentColor"/>
        </svg>
      </div>
      <div class="assistant-main">
        <div class="assistant-head"><strong>漫游</strong><span class="model-tag">${modelShortLabel()}</span><span class="msg-time">${nowLabel()}</span></div>
        <div class="stream-status" hidden><span class="stream-spinner"></span><span data-status></span></div>
        <details class="thinking-box" hidden><summary>${icon('i-sparkles')}思考过程</summary><div class="thinking-content"></div></details>
        <div class="tool-trace" hidden><div class="trace-head">${icon('i-route')}执行过程</div><div class="trace-items"></div></div>
        <div class="assistant-body markdown"></div>
        <div class="source-block" hidden><div class="source-label">${icon('i-globe')}参考来源</div><div class="source-list"></div></div>
        <div class="message-actions">
          <button class="msg-action" type="button" data-copy-msg>${icon('i-copy')}复制</button>
        </div>
      </div>
    </div>`;
    thread.appendChild(root);

    const body = $('.assistant-body', root);
    const statusEl = $('.stream-status', root);
    const statusText = $('[data-status]', root);
    const thinkBox = $('.thinking-box', root);
    const thinkBody = $('.thinking-content', root);
    const traceBox = $('.tool-trace', root);
    const traceItems = $('.trace-items', root);
    const sourceBox = $('.source-block', root);
    const sourceList = $('.source-list', root);

    let text = '';
    let reasoning = '';
    let rendered = 0;
    let caret = null;

    function paint() {
      rendered = 0;
      if (!caret) {
        caret = document.createElement('span');
        caret.className = 'typing-caret';
      }
      body.innerHTML = renderMarkdown(text);
      body.appendChild(caret);
      scrollThread(key);
    }
    function schedule() {
      if (rendered) return;
      rendered = 1;
      requestAnimationFrame(() => { rendered = 0; paint(); });
    }

    return {
      root,
      get text() { return text; },
      setStatus(msg) {
        if (!msg) { statusEl.hidden = true; return; }
        statusEl.hidden = false;
        statusText.textContent = msg;
      },
      pushReasoning(chunk) {
        reasoning += chunk;
        if (thinkBox.hidden) thinkBox.hidden = false;
        thinkBody.textContent = reasoning;
        if (thinkBody.scrollHeight - thinkBody.scrollTop - thinkBody.clientHeight < 60) {
          thinkBody.scrollTop = thinkBody.scrollHeight;
        }
      },
      appendContent(chunk) {
        text += chunk;
        if (!caret) paint(); else schedule();
      },
      setContent(full) { text = full; paint(); },
      stripCitations() {
        const cleaned = text.replace(/【\d+†[^】]*】/g, '');
        if (cleaned !== text) { text = cleaned; paint(); }
      },
      addTrace(label, detail, state) {
        traceBox.hidden = false;
        const item = document.createElement('div');
        item.className = 'trace-item ' + (state || 'is-running');
        item.innerHTML = `<span class="trace-icon">${icon('i-check')}</span>
          <span class="trace-copy"><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>
          <span class="trace-state">${state === 'is-done' ? '完成' : '进行中'}</span>`;
        traceItems.appendChild(item);
        scrollThread(key);
        return {
          done(detail2) {
            item.className = 'trace-item is-done';
            $('.trace-state', item).textContent = '完成';
            if (detail2) $('.trace-copy small', item).textContent = detail2;
          },
          fail(reason) {
            item.className = 'trace-item is-error';
            $('.trace-state', item).textContent = '失败';
            if (reason) $('.trace-copy small', item).textContent = reason;
          }
        };
      },
      setSources(annotations) {
        const list = (annotations || []).filter(a => a && a.url).slice(0, 8);
        if (!list.length) return;
        sourceBox.hidden = false;
        sourceList.innerHTML = list.map(a => {
          let host = a.url;
          try { host = new URL(a.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
          const label = a.title || a.site_name || host;
          return `<a class="source-chip" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(label)}">
            ${a.site_icon ? `<img class="source-favicon" src="${escapeAttr(a.site_icon)}" alt="" onerror="this.remove()" />` : ''}
            <span>${escapeHtml(truncate(label, 34))}</span><span style="color:#b3b5ac">${escapeHtml(host)}</span></a>`;
        }).join('');
      },
      finish(statusMsg) {
        if (caret) { caret.remove(); caret = null; }
        setStatus('');
        if (!text.trim()) {
          body.innerHTML = `<p style="color:#98a097">${statusMsg || '（没有返回内容，请重试）'}</p>`;
        }
      },
      error(message) {
        if (caret) { caret.remove(); caret = null; }
        statusEl.hidden = true;
        body.innerHTML = (text ? renderMarkdown(text) : '') +
          `<div style="margin-top:8px;padding:8px 11px;border-radius:9px;background:#fbe9e4;color:#a4462f;font-size:11.5px">${escapeHtml(message)}</div>`;
        scrollThread(key);
      }
    };
  }

  /* ---------- 对话执行 ---------- */
  const TOOL_LABELS = {
    search_place: '搜索地点', search_around: '周边搜索', plan_route: '规划路线',
    get_weather: '查询天气', show_map: '更新地图', ip_locate: 'IP 定位', geocode: '地址解析'
  };

  function toolSummary(name, a) {
    switch (name) {
      case 'search_place': return `${a.keywords || ''}${a.city ? ' · ' + a.city : ''}`;
      case 'search_around': return `${a.keywords || ''} · 半径 ${a.radius || 2000} 米`;
      case 'plan_route': return `${MODE_LABEL[a.mode] || '驾车'} · ${a.origin || ''} → ${a.destination || ''}`;
      case 'get_weather': return String(a.city || '当前城市');
      case 'show_map': return a.title || '自定义视图';
      case 'ip_locate': return '按当前网络 IP';
      case 'geocode': return String(a.address || '');
      default: return '';
    }
  }

  function serverCallItems(stc) {
    const calls = Array.isArray(stc) ? stc : (stc && Array.isArray(stc.calls) ? stc.calls : []);
    return calls.map(c => {
      const action = c.action || {};
      const kind = String(c.kind || action.type || 'search');
      const isFetch = /fetch|read|open/i.test(kind) || (!action.query && !!action.url);
      return {
        kind: isFetch ? 'fetch' : 'search',
        detail: action.query || action.url || c.query || c.url || '',
        status: c.status || ''
      };
    });
  }

  function toApiMessage(m) {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    }
    const out = { role: m.role, content: m.content == null ? '' : m.content };
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
    if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
    if (m.server_tool_calls) out.server_tool_calls = m.server_tool_calls;
    return out;
  }

  async function runAgent(key, ui) {
    const s = sessions[key];
    const tools = toolsFor(key, s.web);
    const annotations = [];
    const seen = new Set();

    for (let round = 0; round < 6; round++) {
      ui.setStatus(round === 0 ? (s.think ? '正在思考…' : '正在连接 DeepSeek…') : '正在接着处理…');
      const result = await dsStream({
        messages: [{ role: 'system', content: systemPrompt(key) }].concat(s.history.map(toApiMessage)),
        tools,
        think: key === 'travel' ? true : s.think,
        signal: s.controller.signal,
        onEvent: (type, chunk) => {
          if (type === 'reasoning') { ui.pushReasoning(chunk); ui.setStatus('正在思考…'); }
          else { ui.setStatus(''); ui.appendContent(chunk); }
        }
      });

      ui.stripCitations();

      serverCallItems(result.serverToolCalls).forEach(item => {
        const label = item.kind === 'fetch' ? '读取网页' : '联网搜索';
        const node = ui.addTrace(label, item.detail, 'is-running');
        if (/error|fail/i.test(item.status)) node.fail('接口返回失败');
        else node.done(item.detail);
      });

      (result.annotations || []).forEach(raw => {
        const a = normalizeCitation(raw);
        if (a && !seen.has(a.url)) { seen.add(a.url); annotations.push(a); }
      });

      const assistant = { role: 'assistant', content: result.content || '' };
      if (result.reasoning) assistant.reasoning_content = result.reasoning;
      if (result.serverToolCalls) assistant.server_tool_calls = result.serverToolCalls;
      if (result.toolCalls.length) assistant.tool_calls = result.toolCalls;
      s.history.push(assistant);

      if (!result.toolCalls.length) break;

      for (let i = 0; i < result.toolCalls.length; i++) {
        const tc = result.toolCalls[i];
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        const label = TOOL_LABELS[name] || name;
        const node = ui.addTrace(label, toolSummary(name, args), 'is-running');
        ui.setStatus(`正在调用${label}…`);
        let payload;
        try {
          payload = await runTool(name, args);
          if (payload && payload.ok) node.done(toolSummary(name, args));
          else node.fail((payload && payload.message) || '没有结果');
        } catch (e) {
          payload = { ok: false, message: e.message || '工具执行失败' };
          node.fail(payload.message);
        }
        if (name === 'show_map' || name === 'plan_route' || name === 'search_place' || name === 'search_around' || name === 'get_weather') {
          s.mapTouched = true;
        }
        s.history.push({
          role: 'tool',
          tool_call_id: tc.id || `call_${round}_${i}`,
          content: JSON.stringify(payload).slice(0, 8000)
        });
      }
      ui.setStatus('正在整理结果…');
    }

    ui.setSources(annotations);
    if (!ui.text.trim()) {
      ui.finish(key === 'travel' ? '结果已经更新到右侧地图和面板。' : '（没有返回内容，请重试）');
    } else {
      ui.finish();
    }
    scrollThread(key);
  }

  function systemPrompt(key) {
    const city = mapState.city || '北京';
    if (key === 'travel') {
      return `你是「漫游」，一个中文出行小助手，说话自然、具体、简洁。

你可以调用高德地图工具：关键字搜索、周边搜索、路径规划、天气查询、IP 定位、经纬度解析，并用 show_map 把结果画在右侧静态地图上。当前参考城市：${city}。

工作规则：
1. 涉及真实地理数据（地点、坐标、距离、路线、天气）时必须调用工具，不要凭记忆编造。
2. 用户没说城市时先用当前城市；如果连城市都不确定，调用 ip_locate 或直接询问。
3. 搜索到地点后按重要性挑选 3-5 个，用「名称 + 距离/地址 + 一句推荐理由」的要点回答，不要罗列原始数据。
4. 路线回答要说清距离、耗时和关键换乘/转向，只使用工具返回的信息。
5. 结果会同步显示在右侧画布，正文不要重复整份列表，只点出重点。
6. 用 Markdown 组织答案，控制在 300 字内；用户要求详细攻略时可以更长。`;
    }
    return `你是「漫游」，一个中文旅行对话助手，擅长行程设计、目的地推荐与旅行答疑。语气真诚、具体、有画面感。
可以联网检索实时信息，也能理解用户上传的图片。回答用 Markdown，避免空话套话；不确定的信息要说明不确定性，不要编造。`;
  }

  function normalizeCitation(a) {
    if (!a) return null;
    const c = a.url_citation || a.citation || a;
    const url = c.url || c.uri || '';
    if (!url) return null;
    return {
      url,
      title: c.title || c.name || '',
      site_name: c.site_name || c.site || '',
      site_icon: c.site_icon || c.icon || c.favicon || ''
    };
  }

  async function sendMessage(key) {
    const s = sessions[key];
    if (s.busy) return;
    const input = $(`[data-input="${key}"]`);
    const text = input ? input.value.trim() : '';
    if (!text && !s.attachments.length) {
      toast('说点什么再出发吧');
      if (input) input.focus();
      return;
    }
    if (!settings.deepseek) { openSettings(); toast('请先填写 DeepSeek API Key', 'error'); return; }
    if (key === 'travel' && !s.think) {
      s.think = true;
      syncComposer(key);
      toast('调用地图工具需要思考模式，已自动开启', 'info', 2800);
    }

    const images = s.attachments.map(a => a.dataUrl);
    if (images.length && settings.model !== 'deepseek-flash') {
      settings.model = 'deepseek-flash';
      persistSettings(); applySettings();
      toast('已切换到支持图片的 DeepSeek V4.1 Flash', 'info', 3200);
    }

    clearWelcome(key);
    appendUserMessage(key, text, images);

    const userMsg = { role: 'user', content: text };
    if (images.length) {
      userMsg.content = [{ type: 'text', text: text || '帮我看看这张图片，给点出行建议' }];
      images.forEach(url => userMsg.content.push({ type: 'image_url', image_url: { url } }));
    }
    s.history.push(userMsg);

    if (input) { input.value = ''; autoGrow(input); }
    s.attachments = [];
    renderAttachments(key);

    s.busy = true;
    s.controller = new AbortController();
    syncComposer(key);
    const ui = createAssistantMessage(key);
    scrollThread(key);

    try {
      await runAgent(key, ui);
    } catch (e) {
      if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
        ui.finish('已停止生成');
      } else {
        ui.error(e.message || '请求失败，请稍后重试');
        toast(e.message || '请求失败', 'error', 4000);
      }
    } finally {
      s.busy = false;
      s.controller = null;
      syncComposer(key);
      scrollThread(key);
    }
  }

  function stopGeneration(key) {
    const s = sessions[key];
    if (s.controller) {
      try { s.controller.abort(); } catch { /* ignore */ }
    }
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 168) + 'px';
  }

  function syncComposer(key) {
    const s = sessions[key];
    const composer = $(`.composer[data-composer="${key}"]`);
    if (!composer) return;
    composer.classList.toggle('is-busy', s.busy);
    $$('[data-toggle]', composer).forEach(btn => {
      const on = btn.dataset.toggle === 'web' ? s.web : s.think;
      btn.classList.toggle('is-on', on);
      if (btn.dataset.toggle === 'think') btn.classList.add('think');
    });
    const send = $('[data-action="send"]', composer);
    if (send) {
      send.setAttribute('aria-label', s.busy ? '停止生成' : '发送');
      send.title = s.busy ? '停止生成' : '发送';
    }
  }

  /* ---------- 图片附件 ---------- */
  function renderAttachments(key) {
    const strip = $(`[data-attachments="${key}"]`);
    const s = sessions[key];
    if (!strip) return;
    if (!s.attachments.length) { strip.innerHTML = ''; return; }
    strip.innerHTML = s.attachments.map(a => `<div class="attachment-thumb">
        <img src="${a.dataUrl}" alt="${escapeAttr(a.name)}" />
        <button type="button" data-remove-attach="${a.id}" aria-label="移除图片">${icon('i-x')}</button>
      </div>`).join('') +
      `<button class="attachment-add" type="button" data-action="attach" data-target="${key}" aria-label="继续添加">${icon('i-image')}</button>`;
  }

  function addImages(files, key) {
    const list = Array.from(files || []).filter(f => /^image\//.test(f.type));
    if (!list.length) return;
    list.slice(0, 4).forEach(file => {
      if (file.size > 6 * 1024 * 1024) { toast(`${file.name} 超过 6MB，已跳过`, 'error'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        sessions[key].attachments.push({
          id: 'a' + Date.now() + Math.random().toString(16).slice(2, 6),
          name: file.name, dataUrl: String(reader.result)
        });
        renderAttachments(key);
      };
      reader.readAsDataURL(file);
    });
  }

  function openImage(src) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:150;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(12,18,15,.82);cursor:zoom-out';
    box.innerHTML = `<img src="${src}" style="max-width:92vw;max-height:88vh;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.5)" alt="预览" />`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  /* ---------- 语音输入（硅基流动 ASR） ---------- */
  const voice = { recorder: null, stream: null, chunks: [], timer: null, seconds: 0, target: 'chat', cancelled: false };

  function voiceEls() {
    return { overlay: $('#voiceOverlay'), title: $('#voiceTitle'), sub: $('#voiceSub'), timer: $('#voiceTimer') };
  }

  async function startVoice(key) {
    if (!settings.silicon) { openSettings(); toast('语音转写需要硅基流动 API Key', 'error'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('当前浏览器不支持录音，请更换 Chrome / Edge', 'error');
      return;
    }
    if (voice.recorder) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      voice.chunks = [];
      voice.target = key;
      voice.cancelled = false;
      voice.seconds = 0;
      rec.ondataavailable = e => { if (e.data && e.data.size) voice.chunks.push(e.data); };
      rec.onstop = () => { transcribeVoice(); };
      rec.start(300);
      voice.recorder = rec;
      voice.stream = stream;

      const { overlay, title, sub, timer } = voiceEls();
      overlay.hidden = false;
      overlay.classList.remove('is-busy');
      title.textContent = '正在聆听…';
      sub.textContent = '说完后点击完成，自动转写为文字';
      timer.textContent = '00:00';
      voice.timer = setInterval(() => {
        voice.seconds++;
        timer.textContent = fmtClock(voice.seconds);
        if (voice.seconds >= 60) stopVoice();
      }, 1000);
    } catch (e) {
      toast('无法访问麦克风：' + (e.message || '请检查权限'), 'error');
    }
  }

  function stopVoice(cancel) {
    if (!voice.recorder) return;
    voice.cancelled = !!cancel;
    try { voice.recorder.stop(); } catch { /* ignore */ }
  }

  function cleanupVoice() {
    clearInterval(voice.timer);
    voice.timer = null;
    if (voice.stream) voice.stream.getTracks().forEach(t => t.stop());
    voice.stream = null;
    voice.recorder = null;
    voice.chunks = [];
    const { overlay } = voiceEls();
    overlay.hidden = true;
    overlay.classList.remove('is-busy');
  }

  async function transcribeVoice() {
    const blob = new Blob(voice.chunks, { type: (voice.recorder && voice.recorder.mimeType) || 'audio/webm' });
    const target = voice.target;
    if (voice.cancelled) { cleanupVoice(); return; }
    if (blob.size < 1200) { cleanupVoice(); toast('没有录到声音，再试一次吧', 'error'); return; }

    const { overlay, title, sub, timer } = voiceEls();
    overlay.classList.add('is-busy');
    title.textContent = '正在转写…';
    sub.textContent = '硅基流动 SenseVoice 正在识别语音';
    timer.textContent = '·· ··';

    try {
      const ext = /mp4/.test(blob.type) ? 'm4a' : 'webm';
      const form = new FormData();
      form.append('model', 'FunAudioLLM/SenseVoiceSmall');
      form.append('file', new File([blob], `voice.${ext}`, { type: blob.type }));
      const res = await fetch(`${SF_BASE}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.silicon}` },
        body: form
      });
      if (!res.ok) throw new Error(await readError(res, '语音转写失败'));
      const data = await res.json();
      const text = String(data.text || '').trim();
      cleanupVoice();
      if (!text) { toast('没有识别到内容，请靠近麦克风', 'error'); return; }
      const input = $(`[data-input="${target}"]`);
      if (input) {
        input.value = input.value ? `${input.value} ${text}` : text;
        autoGrow(input);
        input.focus();
      }
      toast('语音已转写为文字');
    } catch (e) {
      cleanupVoice();
      toast(e.message || '语音转写失败', 'error', 4000);
    }
  }

  /* ---------- 工具箱 ---------- */
  let activeTool = 'search';

  function emptyHTML(msg, sub) {
    return `<div class="tool-empty">${icon('i-pin')}<span>${escapeHtml(msg)}</span>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div>`;
  }

  function renderToolForm(tool) {
    activeTool = tool;
    $$('#toolTabs button').forEach(b => b.classList.toggle('is-active', b.dataset.tool === tool));
    const form = $('#toolForm');
    if (!form) return;
    const city = escapeAttr(mapState.city || '北京');
    const center = `${mapState.center[0].toFixed(4)}, ${mapState.center[1].toFixed(4)}`;
    if (tool === 'search') {
      form.innerHTML = `<div class="tb-row">
          <label class="tb-field grow-2">${icon('i-search')}<input id="tbKw" placeholder="关键词，如 故宫 / 咖啡馆" /></label>
          <label class="tb-field" style="max-width:104px"><input id="tbCity" value="${city}" placeholder="城市" /></label>
        </div>
        <div class="tb-row"><button class="tb-btn" type="button" data-run="search">${icon('i-search')}搜索地点</button><button class="tb-btn subtle" type="button" data-locate>${icon('i-location')}定位我的城市</button></div>`;
    } else if (tool === 'around') {
      form.innerHTML = `<div class="tb-row">
          <label class="tb-field grow-2">${icon('i-pin')}<input id="tbKw" placeholder="找什么？如 咖啡 / 地铁站" /></label>
          <label class="tb-field" style="max-width:104px"><select id="tbRadius">
            <option value="500">500 米</option><option value="1000">1 公里</option>
            <option value="2000" selected>2 公里</option><option value="5000">5 公里</option>
          </select></label>
        </div>
        <div class="tb-row"><button class="tb-btn" type="button" data-run="around">${icon('i-pin')}周边搜索</button><button class="tb-btn subtle" type="button" data-locate>以我为中心</button></div>
        <div class="tb-hint">中心点 ${center}${mapState.city ? ' · ' + escapeHtml(mapState.city) : ''}</div>`;
    } else if (tool === 'route') {
      form.innerHTML = `<div class="tb-row"><label class="tb-field">${icon('i-pin')}<input id="tbFrom" placeholder="起点，地名或经纬度" value="${city}" /></label></div>
        <div class="tb-row"><label class="tb-field">${icon('i-location')}<input id="tbTo" placeholder="终点，如 颐和园" /></label></div>
        <div class="tb-row">
          <label class="tb-field" style="max-width:108px"><select id="tbMode">
            <option value="driving">驾车</option><option value="walking">步行</option>
            <option value="transit">公交地铁</option><option value="bicycling">骑行</option>
          </select></label>
          <button class="tb-btn" type="button" data-run="route">${icon('i-route')}规划路线</button>
          <button class="tb-btn subtle" type="button" data-swap title="交换起终点">${icon('i-swap')}</button>
        </div>`;
    } else if (tool === 'weather') {
      form.innerHTML = `<div class="tb-row">
          <label class="tb-field grow-2">${icon('i-sun')}<input id="tbWCity" value="${city}" placeholder="城市名或 adcode" /></label>
          <button class="tb-btn" type="button" data-run="weather">查天气</button>
        </div>
        <div class="tb-hint">数据来自高德开放平台 · 含未来几天预报</div>`;
    } else {
      form.innerHTML = `<div class="tb-row">
          <label class="tb-field grow-2">${icon('i-globe')}<input id="tbQuery" placeholder="搜索实时信息，如 杭州 周末 活动" /></label>
          <button class="tb-btn" type="button" data-run="web">搜索</button>
        </div>
        <div class="tb-hint">DeepSeek 搜索接口 · 结果可交给 AI 读正文</div>`;
    }
  }

  async function runToolbox(tool) {
    const box = $('#toolResults');
    const loading = msg => { box.innerHTML = `<div class="tool-loading"><span class="stream-spinner"></span>${escapeHtml(msg)}</div>`; };
    try {
      if (tool === 'search') {
        const kw = ($('#tbKw') || {}).value ? $('#tbKw').value.trim() : '';
        if (!kw) { toast('请输入搜索关键词'); return; }
        const city = ($('#tbCity') && $('#tbCity').value.trim()) || mapState.city;
        loading('正在高德搜索…');
        const pois = await amapPlaceText(kw, city);
        if (!pois.length) { box.innerHTML = emptyHTML(`没有找到「${kw}」`, '换个关键词或城市试试'); return; }
        fillResultPanel(poiCardsHTML(pois, `${kw} · ${city}`));
        setMap({ markers: pois.slice(0, 8), city, zoom: Math.max(mapState.zoom, 13), title: `${city} · ${kw}`, caption: `共找到 ${pois.length} 个结果` });
      } else if (tool === 'around') {
        const kw = ($('#tbKw') || {}).value ? $('#tbKw').value.trim() : '';
        if (!kw) { toast('请输入要找的内容'); return; }
        const radius = Number($('#tbRadius') && $('#tbRadius').value) || 2000;
        const center = `${mapState.center[0]},${mapState.center[1]}`;
        loading('正在搜索周边…');
        const pois = await amapPlaceAround(kw, center, radius, mapState.city);
        if (!pois.length) { box.innerHTML = emptyHTML('这个范围内没有找到结果', '试试扩大搜索半径'); return; }
        fillResultPanel(poiCardsHTML(pois, `周边 ${fmtDistance(radius)} · ${kw}`));
        setMap({ markers: pois.slice(0, 8), zoom: radius <= 1000 ? 15 : 14, title: `周边 · ${kw}`, caption: `${fmtDistance(radius)}内 ${pois.length} 个结果` });
      } else if (tool === 'route') {
        const from = ($('#tbFrom') || {}).value ? $('#tbFrom').value.trim() : '';
        const to = ($('#tbTo') || {}).value ? $('#tbTo').value.trim() : '';
        if (!from || !to) { toast('请填写起点和终点'); return; }
        const mode = ($('#tbMode') && $('#tbMode').value) || 'driving';
        loading('正在规划路线…');
        const route = await executeRoute(mode, from, to, mapState.city);
        if (!route) { box.innerHTML = emptyHTML('路线规划失败', '请确认起点终点可以被识别'); return; }
        renderRoutePanel(route);
        setMap({
          center: [route.origin.lng, route.origin.lat],
          markers: [{ lng: route.origin.lng, lat: route.origin.lat }, { lng: route.destination.lng, lat: route.destination.lat }],
          paths: [route.line], zoom: 13,
          title: `${route.origin.name} → ${route.destination.name}`,
          caption: `${MODE_LABEL[mode]} · ${fmtDistance(route.distance)} · 约 ${fmtDuration(route.duration)}`
        });
      } else if (tool === 'weather') {
        const city = ($('#tbWCity') || {}).value ? $('#tbWCity').value.trim() : mapState.city;
        if (!city) { toast('请输入城市名'); return; }
        loading('正在查询天气…');
        const w = await amapWeather(city);
        showWeatherFloat(w);
        fillResultPanel(weatherHTML(w));
        setMap({ city: w.city, title: `${w.city} · 天气`, caption: `${w.casts[0].dayWeather} ${w.casts[0].nightTemp}° ~ ${w.casts[0].dayTemp}°` });
      } else {
        const q = ($('#tbQuery') || {}).value ? $('#tbQuery').value.trim() : '';
        if (!q) { toast('请输入搜索内容'); return; }
        loading('正在用 DeepSeek 搜索网页…');
        const results = await dsSearch(q, 8);
        if (!results.length) { box.innerHTML = emptyHTML('没有搜到结果', '换个说法再试'); return; }
        box.innerHTML = `<div class="tb-hint" style="margin-bottom:5px">「${escapeHtml(q)}」的网页结果</div><div class="result-list">${results.map(r => `
          <div class="web-hit">
            <strong>${escapeHtml(r.title)}</strong>
            <p>${escapeHtml(r.snippet)}</p>
            <small>${r.icon ? `<img src="${escapeAttr(r.icon)}" alt="" onerror="this.remove()" />` : ''}${escapeHtml(r.site || '')}${r.date ? ' · ' + escapeHtml(r.date) : ''}</small>
            <div class="web-actions">
              <a class="tb-btn subtle" href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer">打开</a>
              <button class="tb-btn subtle" type="button" data-read-url="${escapeAttr(r.url)}" data-read-title="${escapeAttr(r.title)}">AI 读正文</button>
            </div>
          </div>`).join('')}</div>`;
      }
    } catch (e) {
      box.innerHTML = emptyHTML(e.message || '操作失败', '请稍后重试');
      toast(e.message || '操作失败', 'error', 3600);
    }
  }

  /* ---------- 文章弹窗 ---------- */
  const articleState = { title: '', url: '', content: '' };

  function openArticle({ title, url, content }) {
    articleState.title = title || '网页正文';
    articleState.url = url || '';
    articleState.content = content || '';
    $('#articleTitle').textContent = articleState.title;
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    $('#articleMeta').innerHTML = `${host ? `<span>${escapeHtml(host)}</span><span>·</span>` : ''}
      ${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(url, 70))}</a>` : ''}
      <span>·</span><span>${articleState.content.length} 字</span>`;
    const body = $('#articleBody');
    body.classList.toggle('is-empty', !articleState.content);
    body.innerHTML = articleState.content
      ? renderMarkdown(articleState.content.slice(0, 30000))
      : '这篇网页没有抓取到正文，可以直接点击上方链接查看原文。';
    body.scrollTop = 0;
    const dlg = $('#articleDialog');
    if (!dlg.open) dlg.showModal();
  }

  async function readArticle(url, title) {
    const box = $('#toolResults');
    try {
      box.innerHTML = `<div class="tool-loading"><span class="stream-spinner"></span>DeepSeek 正在抓取正文…</div>`;
      const data = await dsFetch(url);
      openArticle({ title: data.title || title, url, content: data.content });
      runToolbox(activeTool === 'web' ? 'web' : activeTool);
    } catch (e) {
      toast(e.message || '抓取失败', 'error', 3600);
      runToolbox(activeTool === 'web' ? 'web' : activeTool);
    }
  }

  /* ---------- 设置 ---------- */
  function openSettings() {
    $('#deepseekKeyInput').value = settings.deepseek || '';
    $('#siliconKeyInput').value = settings.silicon || '';
    $('#amapKey1Input').value = settings.amap1 || '';
    $('#amapKey2Input').value = settings.amap2 || '';
    $('#modelSelect').value = settings.model || 'deepseek-flash';
    const dlg = $('#settingsDialog');
    if (!dlg.open) dlg.showModal();
  }

  function closeDialog(id) {
    const dlg = document.getElementById(id);
    if (dlg && dlg.open) dlg.close();
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

    $$('.quick-link').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const view = btn.dataset.view || 'travel';
      setView(view);
      const input = $(`[data-input="${view}"]`);
      if (input) {
        input.value = btn.dataset.prompt || '';
        autoGrow(input);
        input.focus();
      }
    }));

    const menuBtn = $('#mobileMenu');
    if (menuBtn) menuBtn.addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));
    const backdrop = $('#sidebarBackdrop');
    if (backdrop) backdrop.addEventListener('click', () => $('#app').classList.remove('sidebar-open'));

    $$('#mobileTabs button').forEach(btn => btn.addEventListener('click', () => {
      $$('#mobileTabs button').forEach(x => x.classList.toggle('is-active', x === btn));
      const grid = $('.travel-grid');
      if (grid) grid.dataset.mobilePanel = btn.dataset.mobilePanel;
    }));

    ['chat', 'travel'].forEach(key => {
      const input = $(`[data-input="${key}"]`);
      if (!input) return;
      input.addEventListener('input', () => autoGrow(input));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          if (!sessions[key].busy) sendMessage(key);
        }
      });
    });

    const fileInput = $('#imageInput');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const key = fileInput.dataset.target || 'chat';
        addImages(fileInput.files, key);
        fileInput.value = '';
      });
    }

    const stopBtn = $('#voiceStop');
    if (stopBtn) stopBtn.addEventListener('click', () => stopVoice(false));
    const cancelBtn = $('#voiceCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => stopVoice(true));

    const toolTabs = $('#toolTabs');
    if (toolTabs) toolTabs.addEventListener('click', e => {
      const btn = e.target.closest('[data-tool]');
      if (btn) renderToolForm(btn.dataset.tool);
    });

    const mapImg = $('#mapImage');
    if (mapImg) {
      mapImg.addEventListener('load', () => {
        mapImg.classList.add('is-loaded');
        $('#mapSkeleton').classList.add('is-hidden');
        $('#mapFallback').classList.remove('is-visible');
      });
      mapImg.addEventListener('error', () => {
        $('#mapSkeleton').classList.add('is-hidden');
        $('#mapFallback').classList.add('is-visible');
      });
    }
    const zoomIn = $('#zoomInBtn');
    if (zoomIn) zoomIn.addEventListener('click', () => {
      mapState.zoom = Math.min(17, mapState.zoom + 1);
      renderMap();
    });
    const zoomOut = $('#zoomOutBtn');
    if (zoomOut) zoomOut.addEventListener('click', () => {
      mapState.zoom = Math.max(4, mapState.zoom - 1);
      renderMap();
    });
    const retry = $('#retryMapBtn');
    if (retry) retry.addEventListener('click', () => renderMap());
    const locateBtn = $('#canvasLocateBtn');
    if (locateBtn) locateBtn.addEventListener('click', () => locateByIP(false));
    const openAmap = $('#openAmapBtn');
    if (openAmap) openAmap.addEventListener('click', () => {
      window.open(amapUri(mapState.center[0], mapState.center[1], mapState.title), '_blank', 'noopener');
    });

    ['settingsBtn', 'sidebarSettings', 'modelChip'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', openSettings);
    });
    const newChat = $('#newChatBtn');
    if (newChat) newChat.addEventListener('click', () => resetSession(activeView));

    $$('[data-close-dialog]').forEach(btn => btn.addEventListener('click', () => closeDialog(btn.dataset.closeDialog)));
    $$('dialog.modal').forEach(dlg => dlg.addEventListener('click', e => {
      if (e.target === dlg) dlg.close();
    }));

    $$('[data-reveal]').forEach(btn => btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.reveal);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    }));

    const form = $('#settingsForm');
    if (form) form.addEventListener('submit', e => {
      e.preventDefault();
      settings = {
        deepseek: $('#deepseekKeyInput').value.trim() || DEFAULTS.deepseek,
        silicon: $('#siliconKeyInput').value.trim() || DEFAULTS.silicon,
        amap1: $('#amapKey1Input').value.trim() || DEFAULTS.amap1,
        amap2: $('#amapKey2Input').value.trim() || DEFAULTS.amap2,
        model: $('#modelSelect').value || 'deepseek-flash'
      };
      persistSettings();
      applySettings();
      closeDialog('settingsDialog');
      renderMap();
      syncComposer('chat');
      syncComposer('travel');
      toast('设置已保存到本地');
    });

    const resetBtn = $('#resetSettingsBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      $('#deepseekKeyInput').value = DEFAULTS.deepseek;
      $('#siliconKeyInput').value = DEFAULTS.silicon;
      $('#amapKey1Input').value = DEFAULTS.amap1;
      $('#amapKey2Input').value = DEFAULTS.amap2;
      $('#modelSelect').value = DEFAULTS.model;
      toast('已填入内置 Key，记得点保存');
    });

    const copyArticle = $('#copyArticleBtn');
    if (copyArticle) copyArticle.addEventListener('click', () => copyText(articleState.content));
    const askArticle = $('#askAboutArticleBtn');
    if (askArticle) askArticle.addEventListener('click', () => {
      if (!articleState.content) { toast('正文为空', 'error'); return; }
      closeDialog('articleDialog');
      setView('chat');
      const input = $('[data-input="chat"]');
      if (input) {
        input.value = `请解读这篇网页《${articleState.title}》，提炼与出行相关的关键信息，并给出可执行的建议：\n\n${articleState.content.slice(0, 4000)}`;
        autoGrow(input);
        input.focus();
        toast('已放入对话框，按 Enter 发送');
      }
    });

    document.addEventListener('click', e => {
      const t = e.target;

      const attach = t.closest('[data-action="attach"]');
      if (attach) {
        const fi = $('#imageInput');
        fi.dataset.target = attach.dataset.target || 'chat';
        fi.click();
        return;
      }
      const voiceBtn = t.closest('[data-action="voice"]');
      if (voiceBtn) { startVoice(voiceBtn.dataset.target || 'chat'); return; }

      const sendBtn = t.closest('[data-action="send"]');
      if (sendBtn) {
        const key = sendBtn.dataset.target || 'chat';
        if (sessions[key].busy) stopGeneration(key); else sendMessage(key);
        return;
      }
      const toggle = t.closest('[data-toggle]');
      if (toggle) {
        const key = toggle.dataset.target || 'chat';
        if (toggle.dataset.toggle === 'web') sessions[key].web = !sessions[key].web;
        else sessions[key].think = !sessions[key].think;
        syncComposer(key);
        return;
      }
      const rm = t.closest('[data-remove-attach]');
      if (rm) {
        const strip = rm.closest('[data-attachments]');
        const key = strip ? strip.dataset.attachments : 'chat';
        sessions[key].attachments = sessions[key].attachments.filter(a => a.id !== rm.dataset.removeAttach);
        renderAttachments(key);
        return;
      }
      const zoomImg = t.closest('[data-zoom-img]');
      if (zoomImg) { openImage(zoomImg.dataset.zoomImg); return; }

      const prompt = t.closest('[data-prompt]');
      if (prompt && !prompt.classList.contains('quick-link')) {
        const key = prompt.closest('.view-travel') ? 'travel' : 'chat';
        const input = $(`[data-input="${key}"]`);
        if (input) {
          input.value = prompt.dataset.prompt || '';
          autoGrow(input);
          sendMessage(key);
        }
        return;
      }
      const copyBtn = t.closest('[data-copy-msg]');
      if (copyBtn) {
        const body = $('.assistant-body', copyBtn.closest('.message'));
        if (body) copyText(body.innerText.trim());
        return;
      }
      const poiBtn = t.closest('[data-map-poi], [data-open-poi]');
      if (poiBtn) {
        let poi = null;
        try { poi = JSON.parse(poiBtn.dataset.mapPoi || poiBtn.dataset.openPoi || '{}'); } catch { poi = null; }
        if (poi && isFinite(poi.lng)) {
          if (poiBtn.dataset.openPoi) window.open(amapUri(poi.lng, poi.lat, poi.name), '_blank', 'noopener');
          else setMap({ center: [poi.lng, poi.lat], zoom: 16, markers: [poi], title: poi.name || '地图', caption: poi.name || '' });
        }
        return;
      }
      const readBtn = t.closest('[data-read-url]');
      if (readBtn) { readArticle(readBtn.dataset.readUrl, readBtn.dataset.readTitle); return; }

      const runBtn = t.closest('[data-run]');
      if (runBtn) { runToolbox(runBtn.dataset.run); return; }
      const locate = t.closest('[data-locate]');
      if (locate) { locateByIP(false); return; }
      const swap = t.closest('[data-swap]');
      if (swap) {
        const from = $('#tbFrom'), to = $('#tbTo');
        if (from && to) { const v = from.value; from.value = to.value; to.value = v; }
        return;
      }
    });

    window.addEventListener('beforeunload', () => { if (voice.recorder) stopVoice(true); });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    applySettings();
    mountWelcome('chat');
    mountWelcome('travel');
    renderAttachments('chat');
    renderAttachments('travel');
    syncComposer('chat');
    syncComposer('travel');
    renderToolForm('search');
    fillResultPanel(`<div class="tool-empty">${icon('i-pin')}<span>用上面的工具搜索地点、规划路线或查天气</span><span>结果会同步画在右侧地图上</span></div>`);
    $('#canvasTitle').textContent = mapState.title;
    bindEvents();
    renderMap();
    if (!settings.deepseek) setTimeout(openSettings, 600);
  }

  boot();
})();
