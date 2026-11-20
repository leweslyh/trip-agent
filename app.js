(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const STORAGE_KEY = 'trip-assistant-config-v1';

  const state = {
    deepseekKey: '',
    amapKey: '',
    location: null,
    busy: false,
  };

  const historyStack = [];
  const MAX_HISTORY = 20;

  const SYSTEM_PROMPT = `你是一个"出行小助手"的意图识别与参数抽取器。用户会用自然语言提出出行相关请求。请只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字。

intent 必须是以下之一：
- keyword_search：按关键字搜索地点（例：搜索星巴克、北京有哪些博物馆）
- nearby_search：搜索某处附近的地点（例：附近的咖啡馆、西单周边酒店）
- route：路径规划（例：从天安门到故宫怎么走、步行去三里屯、坐公交去机场）
- weather：天气查询（例：北京天气、明天上海下雨吗）
- static_map：展示某地点或当前位置的地图（例：看看故宫在地图上的位置、打开地图）
- ip_location：查询我当前的位置（例：我在哪、定位一下）
- chat：与出行无关的闲聊或无法归类的请求

params 按 intent 填写：
- keyword_search: {"keywords":"关键词","city":"城市名或空字符串"}
- nearby_search: {"keywords":"关键词或空字符串","location":"当前位置/具体地名/经纬度","radius":3000}
- route: {"from":"起点，缺省为当前位置","to":"终点","mode":"drive|walk|transit"}
- weather: {"city":"城市名；缺省为当前位置"}
- static_map: {"place":"地点名；缺省为当前位置"}
- ip_location: {}
- chat: {}

reply：用中文写一句不超过30字的简短回复，说明你正在做什么，不要包含 JSON。

输出格式严格为：
{"intent":"...","params":{...},"reply":"..."}`;

  const els = {
    chatScroll: $('#chatScroll'),
    chatForm: $('#chatForm'),
    chatInput: $('#chatInput'),
    sendBtn: $('#sendBtn'),
    resultCards: $('#resultCards'),
    mapPlaceholder: $('#mapPlaceholder'),
    staticMap: $('#staticMap'),
    mapCaption: $('#mapCaption'),
    resultSubtitle: $('#resultSubtitle'),
    statusPill: $('#statusPill'),
    toast: $('#toast'),
    settingsMask: $('#settingsMask'),
    undoBtn: $('#undoBtn'),
  };

  const WELCOME_HTML = els.chatScroll.innerHTML;
  const isMobile = () => window.innerWidth <= 900;

  /* ---------------- utilities ---------------- */

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function fmtDistance(meters) {
    const m = Number(meters);
    if (!isFinite(m)) return '--';
    return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
  }

  function fmtDuration(seconds) {
    const s = Number(seconds);
    if (!isFinite(s)) return '--';
    if (s < 60) return `${Math.round(s)} 秒`;
    const min = Math.round(s / 60);
    return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
  }

  let toastTimer;
  function toast(msg, type = 'info') {
    els.toast.textContent = msg;
    els.toast.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.className = 'toast'; }, 3200);
  }

  function samplePoints(points, max) {
    if (points.length <= max) return points;
    const step = Math.ceil(points.length / max);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  /* ---------------- config ---------------- */

  function loadConfig() {
    let cfg = {};
    try {
      cfg = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (_) { /* ignore broken storage */ }
    state.deepseekKey = cfg.deepseekKey || '';
    state.amapKey = cfg.amapKey || '';
    $('#deepseekKey').value = state.deepseekKey;
    $('#amapKey').value = state.amapKey;
    updateStatus();
  }

  function updateStatus() {
    if (!state.amapKey) {
      els.statusPill.textContent = '未配置';
      els.statusPill.className = 'status-pill';
    } else if (state.deepseekKey) {
      els.statusPill.textContent = 'AI 已就绪';
      els.statusPill.className = 'status-pill ready';
    } else {
      els.statusPill.textContent = '规则模式';
      els.statusPill.className = 'status-pill warn';
    }
  }

  /* ---------------- AMap via JSONP ---------------- */

  function probeAmapKey(key, cb) {
    const probe = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      probe.onload = probe.onerror = null;
      cb(ok);
    };
    probe.onload = () => finish(true);
    probe.onerror = () => finish(false);
    setTimeout(() => finish(false), 8000);
    probe.src = `https://restapi.amap.com/v3/staticmap?key=${encodeURIComponent(key)}&location=116.397428,39.90923&zoom=10&size=200*120`;
  }

  function jsonp(path, params, timeout = 16000) {
    return new Promise((resolve, reject) => {
      const cbName = '__tripCb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const url = new URL('https://restapi.amap.com/v3/' + path);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      });
      url.searchParams.set('callback', cbName);

      const script = document.createElement('script');
      let settled = false;
      let timer;

      const cleanup = () => {
        try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
        script.remove();
        clearTimeout(timer);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      timer = setTimeout(() => finish(reject, new Error('高德服务请求超时，请检查网络或 Key 权限')), timeout);
      window[cbName] = (data) => finish(resolve, data);
      script.onerror = () => finish(reject, new Error('网络请求失败，请检查网络连接'));
      script.src = url.toString();
      document.head.appendChild(script);
    });
  }

  async function amap(path, params = {}) {
    if (!state.amapKey) throw new Error('请先在右上角「设置」中填写高德 Web 服务 Key');
    const data = await jsonp(path, { key: state.amapKey, ...params });
    if (String(data.status) !== '1') {
      throw new Error(data.info ? `高德服务：${data.info}` : '高德服务请求失败');
    }
    return data;
  }

  async function detectLocation(force = false) {
    if (state.location && !force) return state.location;
    const data = await amap('ip', {});
    let lng = null; let lat = null;
    if (data.location) {
      const parts = String(data.location).split(',').map(Number);
      lng = parts[0]; lat = parts[1];
    }
    if ((!lng || !lat) && data.adcode) {
      try {
        const geo = await amap('geocode/geo', { address: `${data.province || ''}${data.city || ''}` });
        if (geo.geocodes && geo.geocodes.length) {
          const parts = geo.geocodes[0].location.split(',').map(Number);
          lng = parts[0]; lat = parts[1];
        }
      } catch (_) { /* keep unknown coordinates */ }
    }
    state.location = {
      lng, lat,
      province: data.province || '',
      city: data.city || '',
      adcode: data.adcode || '',
      desc: `${data.province || ''}${data.city || ''}`.trim() || '当前位置',
      source: 'IP 定位',
    };
    return state.location;
  }

  async function resolveLocation(expr) {
    const s = String(expr || '').trim();
    if (!s || /当前位置|这里|附近|我所在|本地|现在的位置|当前所在地|当前地/.test(s)) {
      if (!state.location) await detectLocation();
      return state.location;
    }
    const coord = s.match(/^([-\d.]+)\s*[,，]\s*([-\d.]+)$/);
    if (coord) return { lng: Number(coord[1]), lat: Number(coord[2]), desc: s };

    const geo = await amap('geocode/geo', { address: s });
    if (geo.geocodes && geo.geocodes.length) {
      const g = geo.geocodes[0];
      const parts = g.location.split(',').map(Number);
      return {
        lng: parts[0], lat: parts[1],
        desc: g.formatted_address || s,
        city: g.city || '', adcode: g.adcode || '',
      };
    }
    const search = await amap('place/text', { keywords: s, offset: 1 });
    const poi = (search.pois || [])[0];
    if (poi) {
      const parts = poi.location.split(',').map(Number);
      return { lng: parts[0], lat: parts[1], desc: poi.name, city: poi.cityname || '', adcode: poi.adcode || '' };
    }
    throw new Error(`无法识别地点「${s}」，请换个更具体的名称`);
  }

  /* ---------------- DeepSeek + local fallback ---------------- */

  async function recognize(text) {
    if (!state.deepseekKey) return localRecognize(text);
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.deepseekKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 600,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.json();
          detail = errBody.error?.message || '';
        } catch (_) { /* ignore */ }
        throw new Error(`DeepSeek HTTP ${res.status}${detail ? '：' + detail : ''}`);
      }
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content || '{}';
      const cleaned = String(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed.intent) throw new Error('意图解析结果无效');
      return parsed;
    } catch (err) {
      const fallback = localRecognize(text);
      fallback.notice = `AI 解析不可用（${err.message}），已使用内置规则处理`;
      return fallback;
    }
  }

  function localRecognize(raw) {
    const t = String(raw).trim();

    if (/天气|气温|温度|下雨|forecast/.test(t)) {
      const m = t.match(/([\u4e00-\u9fa5]{2,10}?)\s*(?:市)?\s*(?:今天|明天|这周)?\s*天气/)
        || t.match(/天气(?:怎么样|如何)?\s*[:：]?\s*([\u4e00-\u9fa5]{2,10})/);
      let city = m ? m[1] : '';
      city = city.replace(/(的|市|省|天气|今天|明天|这周|怎么样|如何)$/g, '');
      return { intent: 'weather', params: { city: city || '当前位置' }, reply: '正在查询天气…' };
    }

    if (/我在哪|我的位置|现在在哪|定位|IP\s*定位|当前位置在哪/.test(t)) {
      return { intent: 'ip_location', params: {}, reply: '正在获取当前位置…' };
    }

    if (/[到去至]/.test(t) && !/附近|周边/.test(t)) {
      const body = t.replace(/[？?。！!]/g, '').replace(/^(?:请|帮我|麻烦|我想|我要)\s*/, '').trim();
      const parts = body.split(/\s*(?:到|去|至)\s*/);
      if (parts.length >= 2) {
        let from = parts[0].replace(/^从\s*/, '').trim();
        let to = parts.slice(1).join('到');
        to = to.replace(/(怎么走|怎么去|路线|导航|开车|驾车|公交|地铁|步行|走路|骑车|骑行|多远|多久)$/g, '').trim();
        if (to) {
          const mode = /步行|走路|骑车|骑行/.test(t) ? 'walk' : /公交|地铁|大巴/.test(t) ? 'transit' : 'drive';
          return { intent: 'route', params: { from: from || '当前位置', to, mode }, reply: '正在规划路线…' };
        }
      }
    }

    if (/附近|周边|周围|旁边/.test(t)) {
      const kw = t.replace(/.*?(?:附近|周边|周围|旁边)/, '')
        .replace(/^的\s*/, '')
        .replace(/(有什么|有哪些|有啥|的吗?|[？?])$/g, '').trim();
      return { intent: 'nearby_search', params: { keywords: kw, location: '当前位置', radius: 3000 }, reply: '正在搜索附近地点…' };
    }

    if (/地图/.test(t)) {
      const place = t.replace(/(?:给我|帮我)?\s*(?:看看|展示|显示|打开)?\s*(?:一下)?\s*地图/g, '')
        .replace(/(?:上|的)?\s*(?:位置|在哪)?/g, '').trim();
      return { intent: 'static_map', params: { place: place || '当前位置' }, reply: '正在生成地图…' };
    }

    if (/搜索|查找|找一下|找找|哪里有|在哪/.test(t)) {
      const kw = t.replace(/^(?:请|帮我|麻烦)?\s*(?:搜索|查找|找一下|找找|找)\s*/, '')
        .replace(/(在哪里|在哪|吗|[？?])$/g, '').trim();
      return { intent: 'keyword_search', params: { keywords: kw || t }, reply: '正在搜索…' };
    }

    return {
      intent: 'chat',
      params: {},
      reply: '我是出行小助手，可以帮你搜地点、查路线、看天气。试着说「附近的咖啡馆」或「北京天气」吧。',
    };
  }

  /* ---------------- AMap business ---------------- */

  async function keywordSearch(keywords, city) {
    const data = await amap('place/text', { keywords, city: city || '', offset: 10, page: 1, extensions: 'base' });
    return data.pois || [];
  }

  async function nearbySearch(keywords, loc, radius) {
    const data = await amap('place/around', {
      location: `${loc.lng},${loc.lat}`,
      keywords: keywords || '',
      radius: radius || 3000,
      offset: 10,
      page: 1,
      extensions: 'base',
    });
    return data.pois || [];
  }

  async function routePlan({ from, to, mode }) {
    const originLoc = await resolveLocation(from || '当前位置');
    if (!originLoc || !originLoc.lng) throw new Error('无法确定起点，请先完成定位或给出明确起点');
    const destLoc = await resolveLocation(to);
    if (!destLoc || !destLoc.lng) throw new Error(`无法确定终点「${to}」`);

    const origin = `${originLoc.lng},${originLoc.lat}`;
    const destination = `${destLoc.lng},${destLoc.lat}`;
    const result = { originLoc, destLoc, mode, paths: [], transits: [] };

    if (mode === 'walk') {
      const data = await amap('direction/walking', { origin, destination });
      result.paths = data.route?.paths || [];
    } else if (mode === 'transit') {
      const city = originLoc.city || destLoc.city || '';
      const data = await amap('direction/transit/integrated', { origin, destination, city });
      result.transits = data.route?.transits || [];
    } else {
      const data = await amap('direction/driving', { origin, destination, extensions: 'all' });
      result.paths = data.route?.paths || [];
    }
    return result;
  }

  async function weatherQuery(cityExpr) {
    let city = String(cityExpr || '').trim();
    if (!city || /当前|这里|附近|我的位置|本地/.test(city)) {
      if (!state.location) await detectLocation();
      city = state.location?.adcode || state.location?.city || '北京';
    }
    const data = await amap('weather/weatherInfo', { city, extensions: 'all' });
    return data;
  }

  /* ---------------- result rendering ---------------- */

  function revealResultPanel() {
    if (isMobile()) switchView('result');
  }

  const MAP_NOTICE_DEFAULT = {
    title: '地图将在这里显示',
    hint: '完成一次地点或路线查询后自动生成静态地图',
  };

  function setMapNotice(title, hint) {
    const p = els.mapPlaceholder.querySelector('p');
    const small = els.mapPlaceholder.querySelector('small');
    if (p) p.textContent = title;
    if (small) small.textContent = hint;
    els.mapPlaceholder.hidden = false;
    els.staticMap.hidden = true;
  }

  function resetMapNotice() {
    setMapNotice(MAP_NOTICE_DEFAULT.title, MAP_NOTICE_DEFAULT.hint);
  }

  function showStaticMap({ center, zoom, markers, paths, caption }) {
    if (!state.amapKey) {
      setMapNotice('尚未配置高德 Key', '打开右上角「设置」填入 Web 服务 Key 后即可生成静态地图');
      els.mapCaption.hidden = true;
      return;
    }
    let url = `https://restapi.amap.com/v3/staticmap?key=${encodeURIComponent(state.amapKey)}&size=750*320`;
    if (center && center.lng && center.lat) url += `&location=${center.lng},${center.lat}`;
    if (zoom) url += `&zoom=${zoom}`;
    if (markers) url += `&markers=${markers}`;
    if (paths) url += `&paths=${paths}`;

    els.staticMap.onload = () => {
      els.staticMap.hidden = false;
      els.mapPlaceholder.hidden = true;
    };
    els.staticMap.onerror = () => {
      setMapNotice('静态地图加载失败', 'Key 需为「Web 服务」类型并开通静态地图权限；开启数字签名的 Key 还需附带 sig 参数');
      els.mapCaption.hidden = true;
      toast('静态地图加载失败：请检查高德 Key 类型与静态地图权限', 'error');
    };
    els.staticMap.hidden = true;
    els.staticMap.src = url;
    els.mapCaption.textContent = caption || '';
    els.mapCaption.hidden = !caption;
  }

  function setMapForPois(pois, centerLoc) {
    const labels = 'ABCDEFGH';
    const groups = [];
    pois.slice(0, 8).forEach((poi, i) => {
      if (!poi.location) return;
      groups.push(`markers=mid,0x2563EB,${labels[i]}:${poi.location}`);
    });
    if (!groups.length) return;
    const single = groups.length === 1;
    const [lng, lat] = (pois[0].location || '').split(',').map(Number);
    const center = single && lng && lat ? { lng, lat } : (centerLoc || null);
    showStaticMap({
      center,
      zoom: single ? 15 : null,
      markers: groups.join('|'),
      caption: `已标注 ${groups.length} 个地点`,
    });
  }

  function setMapForPoint(loc, label) {
    if (!loc || !loc.lng || !loc.lat) return;
    showStaticMap({
      center: { lng: loc.lng, lat: loc.lat },
      zoom: 14,
      markers: `markers=mid,0x2563EB,A:${loc.lng},${loc.lat}`,
      caption: label || '当前位置',
    });
  }

  function setMapForRoute(route) {
    const origin = route.originLoc;
    const dest = route.destLoc;
    let paths = '';
    const path = (route.paths || [])[0];
    if (path) {
      const points = (path.steps || []).flatMap((s) => (s.polyline || '').split(';')).filter(Boolean);
      const sampled = samplePoints(points, 60);
      if (sampled.length > 1) paths = `paths=5,0x2563EB,0.85,,:${sampled.join(';')}`;
    }
    showStaticMap({
      center: { lng: (origin.lng + dest.lng) / 2, lat: (origin.lat + dest.lat) / 2 },
      zoom: 12,
      markers: `markers=mid,0x10B981,A:${origin.lng},${origin.lat}|mid,0xEF4444,B:${dest.lng},${dest.lat}`,
      paths,
      caption: `${origin.desc || '起点'} → ${dest.desc || '终点'}`,
    });
  }

  function emptyCard(message) {
    els.resultCards.innerHTML = `<div class="empty-card"><div class="empty-icon">◎</div><p>${escapeHtml(message)}</p></div>`;
    els.resultSubtitle.textContent = '暂无结果';
  }

  function renderPois(pois, title) {
    if (!pois.length) { emptyCard('没有找到相关地点，换个关键词试试'); return; }
    const items = pois.map((poi, i) => {
      const dist = poi.distance ? ` · 距您 ${fmtDistance(poi.distance)}` : '';
      const type = (poi.type || '').split(';').filter(Boolean).pop() || '地点';
      return `<div class="poi-item">
        <div class="poi-idx">${i + 1}</div>
        <div class="poi-main">
          <div class="poi-name">${escapeHtml(poi.name)}</div>
          <div class="poi-addr">${escapeHtml(poi.address || '暂无详细地址')}</div>
          <div class="poi-tags"><span>${escapeHtml(type)}</span>${poi.tel ? `<span>${escapeHtml(poi.tel)}</span>` : ''}${dist ? `<span>${escapeHtml(dist)}</span>` : ''}</div>
        </div>
        <button class="mini-btn" type="button" data-nav="${escapeHtml(poi.name)}">去这里</button>
      </div>`;
    }).join('');
    els.resultCards.innerHTML = `<div class="section-card">
      <div class="section-head"><h3>${escapeHtml(title)}</h3><span class="count">共 ${pois.length} 条</span></div>
      <div class="poi-list">${items}</div>
    </div>`;
    els.resultSubtitle.textContent = title;
  }

  function renderRoute(route, mode) {
    const labels = { drive: '驾车', walk: '步行', transit: '公交地铁' };
    const label = labels[mode] || '出行';
    const head = `<div class="section-card">
      <div class="section-head"><h3>路线规划 · ${label}</h3><span class="count">推荐方案</span></div>
      <div class="route-endpoints">
        <div class="endpoint"><i class="dot start"></i><span>起点</span><strong>${escapeHtml(route.originLoc.desc || '当前位置')}</strong></div>
        <div class="endpoint"><i class="dot end"></i><span>终点</span><strong>${escapeHtml(route.destLoc.desc || '目的地')}</strong></div>
      </div>`;

    if (mode === 'transit') {
      const transits = route.transits.slice(0, 3);
      if (!transits.length) { emptyCard('未找到可用的公交地铁路线'); return; }
      const options = transits.map((t, i) => {
        const segs = (t.segments || []).map((seg) => {
          const line = seg.bus?.buslines?.[0];
          if (line) return `${line.name || '公交'}（${seg.bus?.geton?.name || ''} → ${seg.bus?.getoff?.name || ''}）`;
          return seg.instruction || '步行';
        }).join(' → ');
        return `<div class="transit-opt">
          <div class="transit-top"><span>方案 ${i + 1}</span><span>${fmtDuration(t.duration)} · ${fmtDistance(t.distance)} · ¥${t.cost || '0'}</span></div>
          <div class="transit-segs">${escapeHtml(segs || '详情请查看地图')}</div>
        </div>`;
      }).join('');
      els.resultCards.innerHTML = `${head}${options}</div>`;
      els.resultSubtitle.textContent = '公交地铁路线';
      return;
    }

    const path = (route.paths || [])[0];
    if (!path) { emptyCard('未找到可用路线，请检查起终点是否准确'); return; }
    const steps = (path.steps || []).slice(0, 8).map((s, i) => `
      <div class="step"><span class="step-dot">${i + 1}</span><div>
        <div>${escapeHtml(s.instruction || s.road || '继续前行')}</div>
        <small>${fmtDistance(s.distance)}${s.duration ? ` · ${fmtDuration(s.duration)}` : ''}</small>
      </div></div>`).join('');
    els.resultCards.innerHTML = `${head}
      <div class="route-metrics">
        <div><b>${fmtDistance(path.distance)}</b><span>总距离</span></div>
        <div><b>${fmtDuration(path.duration)}</b><span>预计耗时</span></div>
        <div><b>${label}</b><span>出行方式</span></div>
      </div>
      <div class="step-list">${steps || '<div class="step">暂无详细步骤</div>'}</div>
    </div>`;
    els.resultSubtitle.textContent = `${label}路线`;
  }

  function renderWeather(data) {
    const live = (data.lives || [])[0];
    const casts = data.forecasts?.[0]?.casts || [];
    if (!live) { emptyCard('未查询到天气信息，请检查城市名称'); return; }
    const daily = casts.slice(0, 4).map((c) => `
      <div class="forecast-day">
        <span>${escapeHtml(c.date)}</span>
        <span>${escapeHtml(c.dayweather)}</span>
        <span class="temp">${escapeHtml(c.daytemp)}° / ${escapeHtml(c.nighttemp)}°</span>
        <span>${escapeHtml(c.daywind || '')} ${escapeHtml(c.daypower || '')}级</span>
      </div>`).join('');
    els.resultCards.innerHTML = `<div class="section-card">
      <div class="section-head"><h3>天气 · ${escapeHtml(live.city || live.province || '')}</h3><span class="count">实时</span></div>
      <div class="weather-now">
        <div class="temp-big">${escapeHtml(live.temperature)}<sup>°</sup></div>
        <div class="weather-info">
          <strong>${escapeHtml(live.weather)}</strong>
          <span>${escapeHtml(live.winddirection || '')}风 ${escapeHtml(live.windpower || '0')} 级</span>
          <span>湿度 ${escapeHtml(live.humidity)}% · 发布 ${escapeHtml(live.reporttime || '')}</span>
        </div>
      </div>
      <div class="forecast-list">${daily}</div>
    </div>`;
    els.resultSubtitle.textContent = `${live.city || ''} 天气`;
  }

  function renderLocationCard(loc) {
    els.resultCards.innerHTML = `<div class="section-card">
      <div class="section-head"><h3>当前位置</h3><span class="count">${escapeHtml(loc.source || '定位')}</span></div>
      <div class="loc-grid">
        <div><span>所在地区</span><strong>${escapeHtml(loc.desc || '未知')}</strong></div>
        <div><span>经纬度</span><strong>${loc.lng ?? '--'}, ${loc.lat ?? '--'}</strong></div>
        <div><span>行政区划代码</span><strong>${escapeHtml(loc.adcode || '--')}</strong></div>
        <div><span>定位方式</span><strong>高德 IP 定位</strong></div>
      </div>
    </div>`;
    els.resultSubtitle.textContent = '当前位置';
  }

  /* ---------------- intent execution ---------------- */

  async function executeIntent(plan, original) {
    const p = plan.params || {};

    switch (plan.intent) {
      case 'keyword_search': {
        const keywords = p.keywords || original;
        const pois = await keywordSearch(keywords, p.city);
        renderPois(pois, `「${keywords}」搜索结果`);
        setMapForPois(pois);
        return { summary: `找到 ${pois.length} 个与「${keywords}」相关的地点，已展示在地图与列表中。`, meta: '关键字搜索 · 高德地图' };
      }
      case 'nearby_search': {
        const loc = await resolveLocation(p.location || '当前位置');
        const keywords = p.keywords || '';
        const radius = Number(p.radius) || 3000;
        const pois = await nearbySearch(keywords, loc, radius);
        const title = `${loc.desc || '附近'}${keywords ? `附近的${keywords}` : '周边的地点'}`;
        renderPois(pois, title);
        setMapForPois(pois, loc);
        return { summary: `在${loc.desc || '附近'} ${fmtDistance(radius)} 内找到 ${pois.length} 个${keywords ? `「${keywords}」` : '地点'}。`, meta: `周边搜索 · 半径 ${fmtDistance(radius)}` };
      }
      case 'route': {
        const route = await routePlan(p);
        renderRoute(route, p.mode || 'drive');
        setMapForRoute(route);
        const label = { drive: '驾车', walk: '步行', transit: '公交地铁' }[p.mode || 'drive'];
        return { summary: `已为你规划${label}路线：${route.originLoc.desc || '当前位置'} → ${route.destLoc.desc || '目的地'}。`, meta: '路径规划 · 高德地图' };
      }
      case 'weather': {
        const data = await weatherQuery(p.city);
        renderWeather(data);
        const live = data.lives?.[0];
        if (live) {
          try {
            const loc = await resolveLocation(live.city || p.city || '当前位置');
            setMapForPoint(loc, `天气 · ${live.city}`);
          } catch (_) { /* 地图标注失败不影响天气结果 */ }
        }
        return {
          summary: live ? `${live.city}当前${live.weather}，气温 ${live.temperature}°，已展示未来天气趋势。` : '天气信息已展示。',
          meta: '天气查询 · 高德地图',
        };
      }
      case 'static_map': {
        const loc = await resolveLocation(p.place || '当前位置');
        setMapForPoint(loc, p.place || '当前位置');
        renderLocationCard(loc);
        return { summary: `已在地图中标注「${loc.desc || p.place || '当前位置'}」。`, meta: '静态地图 · 高德地图' };
      }
      case 'ip_location': {
        const loc = await detectLocation(true);
        setMapForPoint(loc, '当前位置');
        renderLocationCard(loc);
        return { summary: `你当前大约位于${loc.desc || '未知位置'}，已在地图中标注。`, meta: 'IP 定位 · 高德地图' };
      }
      default:
        return { summary: plan.reply || '我是出行小助手，可以帮你搜地点、查路线、看天气。', noResult: true, meta: '对话' };
    }
  }

  /* ---------------- chat plumbing ---------------- */

  function scrollChat() {
    requestAnimationFrame(() => { els.chatScroll.scrollTop = els.chatScroll.scrollHeight; });
  }

  function addMessage(role, html, meta = '') {
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${role}`;
    const avatar = role === 'user' ? '我' : 'AI';
    wrap.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-main"><div class="msg-bubble">${html}</div>${meta ? `<div class="msg-meta">${escapeHtml(meta)}</div>` : ''}</div>`;
    els.chatScroll.appendChild(wrap);
    scrollChat();
    return wrap;
  }

  function addTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.innerHTML = '<div class="msg-avatar">AI</div><div class="msg-main"><div class="msg-bubble"><span class="dots"><i></i><i></i><i></i></span></div></div>';
    els.chatScroll.appendChild(wrap);
    scrollChat();
    return wrap;
  }

  function assistantHtml(plan, result) {
    const badges = {
      keyword_search: '地点搜索', nearby_search: '周边搜索', route: '路径规划',
      weather: '天气查询', static_map: '静态地图', ip_location: 'IP 定位', chat: '智能体',
    };
    const badge = badges[plan.intent] || '智能体';
    const notice = plan.notice ? `<div class="notice">${escapeHtml(plan.notice)}</div>` : '';
    const jump = result.noResult ? '' : '<button class="jump-btn" type="button" data-jump>查看地图与结果 →</button>';
    return `<div class="intent-badge">${badge}</div><div class="reply-text">${escapeHtml(result.summary || plan.reply || '已完成')}</div>${notice}${jump}`;
  }

  async function handleUserText(text) {
    if (state.busy) { toast('正在处理上一条请求，请稍候'); return; }
    const value = String(text || '').trim();
    if (!value) return;

    if (isMobile()) switchView('chat');
    pushHistory(value);
    els.chatInput.value = '';
    autoGrow();
    addMessage('user', escapeHtml(value));

    state.busy = true;
    updateUndoBtn();
    els.sendBtn.disabled = true;
    els.sendBtn.classList.add('loading');
    const typing = addTyping();

    try {
      const plan = await recognize(value);
      const result = await executeIntent(plan, value);
      typing.remove();
      addMessage('assistant', assistantHtml(plan, result), result.meta);
      if (!result.noResult && isMobile()) revealResultPanel();
    } catch (err) {
      typing.remove();
      addMessage('assistant', `<strong>抱歉，处理失败</strong><br><span class="err-text">${escapeHtml(err.message || '未知错误')}</span><br>请检查 API Key 或换一种说法重试。`, 'error');
      toast(err.message || '处理失败', 'error');
    } finally {
      state.busy = false;
      updateUndoBtn();
      els.sendBtn.disabled = false;
      els.sendBtn.classList.remove('loading');
      els.chatInput.focus();
    }
  }

  function autoGrow() {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 120) + 'px';
  }

  function switchView(view) {
    const toResult = view === 'result';
    document.body.classList.toggle('view-result', toResult);
    $$('.view-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  }

  /* ---------------- undo ---------------- */

  function snapshotState(inputText) {
    return {
      chatHTML: els.chatScroll.innerHTML,
      resultHTML: els.resultCards.innerHTML,
      resultSubtitle: els.resultSubtitle.textContent,
      input: inputText,
      map: {
        src: els.staticMap.getAttribute('src') || '',
        visible: !els.staticMap.hidden,
        placeholder: !els.mapPlaceholder.hidden,
        caption: els.mapCaption.textContent || '',
        captionHidden: els.mapCaption.hidden,
      },
    };
  }

  function updateUndoBtn() {
    if (!els.undoBtn) return;
    const count = historyStack.length;
    els.undoBtn.disabled = state.busy || count === 0;
    els.undoBtn.title = count === 0
      ? '暂无可撤回的对话'
      : `撤回上一轮对话（还可撤回 ${count} 轮）`;
  }

  function pushHistory(inputText) {
    historyStack.push(snapshotState(inputText));
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    updateUndoBtn();
  }

  function restoreMap(map) {
    if (map.src) {
      els.staticMap.src = map.src;
      els.staticMap.hidden = !map.visible;
      els.mapPlaceholder.hidden = map.placeholder;
    } else {
      els.staticMap.removeAttribute('src');
      resetMapNotice();
    }
    els.mapCaption.textContent = map.caption;
    els.mapCaption.hidden = map.captionHidden;
  }

  function undoLast() {
    if (state.busy) {
      toast('正在处理请求，请稍候再撤回');
      return;
    }
    const snap = historyStack.pop();
    if (!snap) {
      toast('暂无可撤回的对话');
      updateUndoBtn();
      return;
    }

    els.chatScroll.innerHTML = snap.chatHTML;
    els.resultCards.innerHTML = snap.resultHTML;
    els.resultSubtitle.textContent = snap.resultSubtitle;
    restoreMap(snap.map);

    const draft = els.chatInput.value;
    const keepDraft = draft.trim() !== '' && draft !== snap.input;
    if (!keepDraft) {
      els.chatInput.value = snap.input;
      autoGrow();
      els.chatInput.setSelectionRange(snap.input.length, snap.input.length);
    }

    if (isMobile()) switchView('chat');
    scrollChat();
    els.chatInput.focus();
    updateUndoBtn();

    const remain = historyStack.length;
    if (keepDraft) {
      toast(`已撤回上一轮对话，当前输入内容已保留${remain ? `（还可撤回 ${remain} 轮）` : ''}`);
    } else {
      toast(`已撤回上一轮对话${remain ? `，还可继续撤回 ${remain} 轮` : ''}，可修改后重新发送`);
    }
  }

  /* ---------------- events ---------------- */

  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleUserText(els.chatInput.value);
  });

  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleUserText(els.chatInput.value);
    }
  });
  els.chatInput.addEventListener('input', autoGrow);

  $('#quickChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) handleUserText(chip.dataset.query);
  });

  els.chatScroll.addEventListener('click', (e) => {
    if (e.target.closest('[data-jump]')) switchView('result');
  });

  els.resultCards.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    switchView('chat');
    els.chatInput.value = `从当前位置到${btn.dataset.nav}怎么走`;
    autoGrow();
    els.chatInput.focus();
  });

  $$('.view-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

  $('#undoBtn').addEventListener('click', undoLast);

  $('#clearBtn').addEventListener('click', () => {
    if (state.busy) return;
    historyStack.length = 0;
    updateUndoBtn();
    els.chatScroll.innerHTML = WELCOME_HTML;
    els.resultCards.innerHTML = '';
    els.staticMap.removeAttribute('src');
    resetMapNotice();
    els.mapCaption.hidden = true;
    els.mapCaption.textContent = '';
    els.resultSubtitle.textContent = '等待你的出行指令';
    switchView('chat');
    toast('对话已清空');
  });

  const openSettings = () => {
    $('#deepseekKey').value = state.deepseekKey;
    $('#amapKey').value = state.amapKey;
    els.settingsMask.hidden = false;
  };
  const closeSettings = () => { els.settingsMask.hidden = true; };

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#cancelSettings').addEventListener('click', closeSettings);
  els.settingsMask.addEventListener('click', (e) => { if (e.target === els.settingsMask) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.settingsMask.hidden) closeSettings();
  });

  $('#saveSettings').addEventListener('click', () => {
    state.deepseekKey = $('#deepseekKey').value.trim();
    state.amapKey = $('#amapKey').value.trim();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        deepseekKey: state.deepseekKey,
        amapKey: state.amapKey,
      }));
    } catch (_) {
      toast('浏览器存储不可用，配置仅在当前页面有效', 'error');
    }
    updateStatus();
    closeSettings();
    toast('配置已保存到浏览器本地', 'success');
    if (state.amapKey) {
      probeAmapKey(state.amapKey, (ok) => {
        if (ok) toast('高德 Key 校验通过，静态地图可正常生成', 'success');
        else toast('高德 Key 校验失败：需为「Web 服务」类型且已开通静态地图', 'error');
      });
    }
  });

  /* ---------------- init ---------------- */

  let firstVisit = false;
  try { firstVisit = !localStorage.getItem(STORAGE_KEY); } catch (_) { firstVisit = true; }
  loadConfig();
  updateUndoBtn();
  if (firstVisit) setTimeout(openSettings, 400);
})();
