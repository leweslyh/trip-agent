'use strict';

/* ============================================================
   出行小助手 · 纯前端智能体
   DeepSeek Tool Calling + 高德 Web 服务 API
   ============================================================ */

const $ = (selector) => document.querySelector(selector);
const CONFIG_KEY = 'travel-agent-config-v1';

const DEFAULT_CONFIG = {
  // 请勿在仓库中提交明文 Key，运行时通过页面设置填写
  deepseekKey: '',
  deepseekModel: 'deepseek-chat',
  siliconKey: '',
  siliconModel: 'Qwen/Qwen2.5-7B-Instruct',
  amapKey1: '',
  amapKey2: ''
};

const state = {
  config: loadConfig(),
  messages: [],
  lastLocation: '',
  lastCity: '',
  mapUrl: '',
  provider: '',
  busy: false,
  cardsInTurn: false
};

const TOOL_LABELS = {
  search_place: '关键字搜索',
  search_nearby: '周边搜索',
  plan_route: '路径规划',
  get_weather: '天气查询',
  show_static_map: '静态地图',
  locate_ip: 'IP 定位'
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_place',
      description: '高德关键字搜索。按名称或关键词查找地点、景点、餐厅、车站等，返回地点列表和经纬度坐标。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索关键词，例如“故宫”“北京火锅”' },
          city: { type: 'string', description: '限定城市，例如“北京”。不确定的时候可传空字符串' }
        },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_nearby',
      description: '高德周边搜索。查询某个位置附近或周边的地点。若用户没有给出位置，location 传空字符串，系统会自动通过 IP 定位。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '周边寻找的类别或名称，例如“咖啡馆”“加油站”“景点”' },
          location: { type: 'string', description: '中心点，可以是“经度,纬度”或地点名称；未知时传空字符串' },
          radius: { type: 'number', description: '搜索半径，单位米，默认 3000，最大 50000' },
          city: { type: 'string', description: '城市名称，可选' }
        },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_route',
      description: '高德路径规划。查询两个地点之间的驾车、步行、骑行或公交地铁路线，返回距离、耗时和分步指引。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '起点名称或“经度,纬度”，例如“天安门”' },
          destination: { type: 'string', description: '终点名称或“经度,纬度”，例如“故宫博物院”' },
          mode: { type: 'string', enum: ['driving', 'walking', 'bicycling', 'transit'], description: '出行方式：driving 驾车、walking 步行、bicycling 骑行、transit 公交地铁' },
          city: { type: 'string', description: '公交地铁规划所需城市，其他方式可传空字符串' }
        },
        required: ['origin', 'destination', 'mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '高德天气查询。查询指定城市的实时天气和未来四天预报。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称或城市编码，例如“杭州”“110000”；未知时传空字符串使用当前城市' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_static_map',
      description: '高德静态地图。生成一张地图图片并在页面右侧展示。用户要求“看地图 / 展示地图 / 标出某个地方”时调用。',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '地图中心点，可以是地点名称或“经度,纬度”；未知时传空字符串' },
          zoom: { type: 'number', description: '缩放级别 3-18，默认 13' },
          label: { type: 'string', description: '地图说明文字，可选' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'locate_ip',
      description: '高德 IP 定位。根据用户 IP 判断所在省份、城市并给出城市中心点。用户问“我在哪 / 我的位置 / IP 定位”时调用。',
      parameters: {
        type: 'object',
        properties: {
          ip: { type: 'string', description: '要查询的 IPv4 地址；查询用户自身位置时传空字符串' }
        },
        required: []
      }
    }
  }
];

const SUGGESTIONS = [
  '北京有哪些值得去的博物馆？',
  '我附近有什么咖啡馆？',
  '从天安门到故宫怎么走？',
  '上海明天的天气怎么样？',
  '给我展示故宫的静态地图',
  '通过 IP 定位看看我在哪个城市'
];

/* ============================================================
   配置与通用工具
   ============================================================ */

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    return { ...DEFAULT_CONFIG, ...saved };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch (_) { /* 隐私模式下忽略 */ }
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function richText(value = '') {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function isCoord(value) {
  return /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(String(value || ''));
}

function formatDistance(meters) {
  const m = Number(meters) || 0;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
}

function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return min ? `${h} 小时 ${min} 分` : `${h} 小时`;
  }
  return `${Math.max(1, Math.round(s / 60))} 分钟`;
}

function setStatus(text, kind = '') {
  $('#statusText').textContent = text;
  $('#statusPill').className = `status-pill${kind ? ' ' + kind : ''}`;
}

/* ============================================================
   高德 API：JSONP 请求 + 双 Key 容错
   ============================================================ */

let jsonpSeq = 0;

function amapJsonp(path, params, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const callbackName = `__amap_cb_${Date.now()}_${jsonpSeq++}`;
    const url = new URL(`https://restapi.amap.com${path}`);
    Object.entries({ ...params, output: 'json', callback: callbackName }).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });

    const script = document.createElement('script');
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('高德接口请求超时')), timeout);

    window[callbackName] = (data) => finish(resolve, data);
    script.onerror = () => finish(reject, new Error('高德接口网络错误'));
    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function amapCall(path, params = {}) {
  const keys = [state.config.amapKey1, state.config.amapKey2].filter(Boolean);
  if (!keys.length) throw new Error('尚未配置高德 Web 服务 Key，请在设置中填写');

  let lastError = null;
  for (const key of keys) {
    try {
      const data = await amapJsonp(path, { ...params, key });
      const succeeded = data && (String(data.status) === '1' || (data.errcode !== undefined && Number(data.errcode) === 0));
      if (succeeded) return data;
      const code = data?.infocode || data?.errcode;
      lastError = new Error(`${data?.info || data?.errmsg || '高德接口返回失败'}${code ? `（${code}）` : ''}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('高德接口不可用');
}

async function geocodeInfo(address, city = '') {
  const text = String(address || '').trim();
  if (isCoord(text)) return { location: text.replace(/\s/g, ''), city: city || '', adcode: '', citycode: '' };
  if (!text) throw new Error('地点名称不能为空');
  const data = await amapCall('/v3/geocode/geo', { address: text, city });
  const geo = data.geocodes?.[0];
  if (!geo?.location) throw new Error(`找不到地点「${text}」`);
  return {
    location: geo.location,
    city: city || geo.city || '',
    adcode: geo.adcode || '',
    citycode: geo.citycode || ''
  };
}

function centerFromRectangle(rectangle = '') {
  const parts = String(rectangle).split(';').map((p) => p.split(',').map(Number));
  if (parts.length < 2 || parts.some((p) => p.length < 2 || p.some(Number.isNaN))) return '';
  return `${((parts[0][0] + parts[1][0]) / 2).toFixed(6)},${((parts[0][1] + parts[1][1]) / 2).toFixed(6)}`;
}

async function locateInternal(ip = '') {
  const data = await amapCall('/v3/ip', ip ? { ip } : {});
  const province = data.province || '';
  const city = data.city || province || '';
  const rectangle = data.rectangle || '';
  let center = centerFromRectangle(rectangle);

  if (city) {
    const geo = await amapCall('/v3/geocode/geo', { address: city }).catch(() => null);
    center = geo?.geocodes?.[0]?.location || center;
  }
  if (city) state.lastCity = city;
  if (center) state.lastLocation = center;
  return { province, city, adcode: data.adcode || '', rectangle, center };
}

async function resolveLocation(value, city = '') {
  const text = String(value || '').trim();
  if (text) return (await geocodeInfo(text, city)).location;
  if (state.lastLocation) return state.lastLocation;
  const located = await locateInternal();
  if (located.center) return located.center;
  throw new Error('无法确定当前位置，请在问题中提供城市或地点名称');
}

/* ============================================================
   静态地图 URL
   ============================================================ */

function samplePolyline(polyline, maxPoints = 90) {
  const points = String(polyline || '').split(';').filter(Boolean);
  if (!points.length) return '';
  if (points.length <= maxPoints) return points.join(';');
  const step = points.length / maxPoints;
  const sampled = [];
  for (let i = 0; i < maxPoints; i += 1) sampled.push(points[Math.floor(i * step)]);
  return sampled.join(';');
}

function buildMapUrl({ center = '', zoom = 13, markers = [], paths = '' }) {
  const key = state.config.amapKey1 || state.config.amapKey2 || '';
  const parts = [`key=${key}`, 'size=750*420'];
  if (center) parts.push(`location=${center}`);
  parts.push(`zoom=${Math.min(18, Math.max(3, Number(zoom) || 13))}`);

  if (markers.length) {
    const markerText = markers.slice(0, 10).map((marker, index) => {
      const label = String.fromCharCode(65 + (index % 26));
      return `mid,${marker.color || '0x2563EB'},${label}:${marker.location}`;
    }).join('|');
    parts.push(`markers=${markerText}`);
  }

  const sampled = samplePolyline(paths);
  if (sampled) parts.push(`paths=4,0x4F46E5,0.9,,:${sampled}`);

  return `https://restapi.amap.com/v3/staticmap?${parts.join('&')}`;
}

function setMap(url, caption = '') {
  state.mapUrl = url;
  const img = $('#staticMap');
  const placeholder = $('#mapPlaceholder');
  const captionEl = $('#mapCaption');
  let triedFallback = false;

  img.onload = () => {
    img.hidden = false;
    placeholder.hidden = true;
    if (caption) { captionEl.textContent = caption; captionEl.hidden = false; }
  };
  img.onerror = () => {
    if (!triedFallback && state.config.amapKey2 && state.config.amapKey1 && url.includes(state.config.amapKey1)) {
      triedFallback = true;
      img.src = url.replace(state.config.amapKey1, state.config.amapKey2);
      return;
    }
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.querySelector('span').textContent = '静态地图加载失败，请检查高德 Key 的 Web 服务权限';
    captionEl.hidden = true;
  };
  img.src = url;
  $('#resultMeta').textContent = caption || '';
}

/* ============================================================
   结果渲染
   ============================================================ */

function renderCards(html) {
  const container = $('#resultCards');
  if (state.cardsInTurn && !container.querySelector('.empty-state')) {
    container.insertAdjacentHTML('beforeend', html);
  } else {
    container.innerHTML = html;
    state.cardsInTurn = true;
  }
}

function cardHead(title, tag) {
  return `<div class="card-head"><h3 class="card-title">${escapeHtml(title)}</h3><span class="card-tag">${escapeHtml(tag)}</span></div>`;
}

function renderPoiCard(title, pois) {
  if (!pois.length) {
    renderCards(`<div class="card">${cardHead(title, '暂无结果')}<p class="poi-meta">没有找到匹配的地点，试试更换关键词或城市。</p></div>`);
    return;
  }
  const list = pois.map((poi, index) => `
    <li class="poi-item">
      <span class="poi-index">${index + 1}</span>
      <div>
        <div class="poi-name">${escapeHtml(poi.name)}</div>
        <div class="poi-meta">
          <span>${escapeHtml(poi.address || '暂无详细地址')}</span>
          ${poi.distance !== undefined && poi.distance !== '' ? `<span class="accent">${formatDistance(poi.distance)}</span>` : ''}
          ${poi.tel ? `<span>${escapeHtml(poi.tel)}</span>` : ''}
        </div>
      </div>
    </li>`).join('');
  renderCards(`<div class="card">${cardHead(title, `共 ${pois.length} 个结果`)}<ul class="poi-list">${list}</ul></div>`);
}

function renderRouteCard(title, route, modeLabel) {
  const steps = route.steps.slice(0, 10).map((step) => `<li>${escapeHtml(step)}</li>`).join('');
  renderCards(`
    <div class="card">
      ${cardHead(title, modeLabel)}
      <div class="route-stats">
        <div class="stat"><div class="stat-value">${formatDistance(route.distance)}</div><div class="stat-label">全程距离</div></div>
        <div class="stat"><div class="stat-value">${formatDuration(route.duration)}</div><div class="stat-label">预计耗时</div></div>
        ${route.cost ? `<div class="stat"><div class="stat-value">${escapeHtml(route.cost)}</div><div class="stat-label">参考费用</div></div>` : ''}
      </div>
      <ol class="route-steps">${steps || '<li>暂无分步指引</li>'}</ol>
    </div>`);
}

function renderWeatherCard(city, live, casts) {
  const forecasts = casts.slice(0, 4).map((cast) => `
    <div class="forecast-day">
      <div class="d">${escapeHtml(cast.date || '')}</div>
      <div class="w">${escapeHtml(cast.dayweather || '')}</div>
      <div class="t">${escapeHtml(cast.daytemp || '')}° / ${escapeHtml(cast.nighttemp || '')}°</div>
    </div>`).join('');

  renderCards(`
    <div class="card">
      ${cardHead(`${city} 天气`, '高德天气')}
      <div class="weather-now">
        <div class="weather-temp">${live?.temperature ? `${escapeHtml(live.temperature)}<small>°C</small>` : '—'}</div>
        <div>
          <div class="weather-desc">${escapeHtml(live?.weather || casts[0]?.dayweather || '暂无实时数据')}</div>
          <div class="weather-sub">${escapeHtml([
            live?.winddirection ? `${live.winddirection} ${live.windpower || ''}级` : '',
            live?.humidity ? `湿度 ${live.humidity}%` : '',
            live?.reporttime ? `更新于 ${live.reporttime}` : ''
          ].filter(Boolean).join(' · '))}</div>
        </div>
      </div>
      ${forecasts ? `<div class="forecast">${forecasts}</div>` : ''}
    </div>`);
}

function renderKeyValueCard(title, tag, items) {
  const body = items.map((item) => `
    <div class="kv-item"><div class="k">${escapeHtml(item.key)}</div><div class="v">${escapeHtml(item.value || '—')}</div></div>
  `).join('');
  renderCards(`<div class="card">${cardHead(title, tag)}<div class="kv-grid">${body}</div></div>`);
}

/* ============================================================
   六个工具的执行函数
   ============================================================ */

function compactPois(pois) {
  return pois.map((poi) => ({
    name: poi.name,
    address: Array.isArray(poi.address) ? '' : (poi.address || ''),
    location: poi.location || '',
    distance: Array.isArray(poi.distance) ? '' : (poi.distance ?? ''),
    tel: Array.isArray(poi.tel) ? '' : (poi.tel || ''),
    city: poi.cityname || ''
  }));
}

async function toolSearchPlace(args) {
  const keywords = String(args.keywords || '').trim();
  if (!keywords) throw new Error('缺少搜索关键词');
  const city = String(args.city || '').trim();
  const data = await amapCall('/v3/place/text', { keywords, city, offset: 10, page: 1, extensions: 'base' });
  const pois = compactPois(data.pois || []);

  renderPoiCard(`“${keywords}”搜索结果`, pois);
  if (pois.length) {
    state.lastLocation = pois[0].location || state.lastLocation;
    state.lastCity = city || pois[0].city || state.lastCity;
    const markers = pois.slice(0, 6).filter((poi) => poi.location).map((poi) => ({ location: poi.location }));
    setMap(buildMapUrl({ center: pois[0].location, zoom: 13, markers }), `${keywords} · 共 ${data.count || pois.length} 个结果`);
  }
  return JSON.stringify({ ok: true, count: Number(data.count) || pois.length, pois: pois.slice(0, 6) });
}

async function toolSearchNearby(args) {
  const keywords = String(args.keywords || '').trim() || '附近';
  const radius = Math.min(50000, Math.max(100, Number(args.radius) || 3000));
  const city = String(args.city || '').trim();
  const location = await resolveLocation(args.location, city);

  const params = { location, radius, offset: 10, page: 1, extensions: 'base', sortrule: 'distance' };
  if (keywords !== '附近') params.keywords = keywords;
  const data = await amapCall('/v3/place/around', params);
  const pois = compactPois(data.pois || []);

  renderPoiCard(`${keywords} · 周边 ${radius / 1000} 公里`, pois);
  const markers = pois.slice(0, 6).filter((poi) => poi.location).map((poi) => ({ location: poi.location }));
  setMap(buildMapUrl({ center: location, zoom: 14, markers }), `周边搜索 · ${keywords}`);

  return JSON.stringify({ ok: true, center: location, radius, count: Number(data.count) || pois.length, pois: pois.slice(0, 6) });
}

function parseRoute(mode, data) {
  if (mode === 'transit') {
    const transit = data.route?.transits?.[0];
    if (!transit) return null;
    const steps = (transit.segments || []).map((segment) => {
      const bus = segment.bus?.buslines?.[0];
      if (bus) return `${bus.name || '公交'}：${bus.departure_stop?.name || ''} → ${bus.arrival_stop?.name || ''}，${bus.duration || '?'} 分钟`;
      const railway = segment.railway;
      if (railway) return `${railway.name || '轨道交通'}：${railway.departure_stop?.name || ''} → ${railway.arrival_stop?.name || ''}`;
      if (segment.walking) return `步行 ${segment.walking.distance || 0} 米`;
      if (segment.taxi) return `打车 ${segment.taxi.distance || 0} 米`;
      return '换乘';
    });
    return {
      distance: transit.distance,
      duration: transit.duration,
      cost: transit.cost?.transit_fee ? `¥${transit.cost.transit_fee}` : '',
      steps,
      polyline: ''
    };
  }

  const container = mode === 'bicycling' ? data.data : data.route;
  const path = container?.paths?.[0];
  if (!path) return null;
  return {
    distance: path.distance,
    duration: path.duration,
    cost: '',
    steps: (path.steps || []).map((step) => `${step.instruction || step.road || '继续前行'}（${step.distance || 0} 米）`),
    polyline: (path.steps || []).map((step) => step.polyline || '').filter(Boolean).join(';')
  };
}

async function toolPlanRoute(args) {
  const origin = String(args.origin || '').trim();
  const destination = String(args.destination || '').trim();
  if (!origin || !destination) throw new Error('路径规划需要起点和终点');
  const mode = ['driving', 'walking', 'bicycling', 'transit'].includes(args.mode) ? args.mode : 'driving';
  const cityHint = String(args.city || '').trim() || state.lastCity;

  const originInfo = await geocodeInfo(origin, cityHint);
  const destInfo = await geocodeInfo(destination, cityHint);

  const endpoints = {
    driving: ['/v3/direction/driving', { extensions: 'base' }],
    walking: ['/v3/direction/walking', {}],
    bicycling: ['/v4/direction/bicycling', {}],
    transit: ['/v3/direction/transit/integrated', {}]
  };
  const [path, extra] = endpoints[mode];
  const params = { origin: originInfo.location, destination: destInfo.location, ...extra };
  if (mode === 'transit') params.city = cityHint || originInfo.citycode || originInfo.adcode || '';

  const data = await amapCall(path, params);
  const route = parseRoute(mode, data);
  if (!route) throw new Error('没有查询到可用路线，请检查起终点是否正确');

  const modeLabel = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '公交地铁' }[mode];
  renderRouteCard(`${origin} → ${destination}`, route, modeLabel);

  const markers = [
    { location: originInfo.location, color: '0x22C55E' },
    { location: destInfo.location, color: '0xEF4444' }
  ];
  setMap(buildMapUrl({ center: originInfo.location, zoom: 12, markers, paths: route.polyline }), `${modeLabel}路线 · ${formatDistance(route.distance)}`);

  return JSON.stringify({
    ok: true,
    mode,
    origin: originInfo.location,
    destination: destInfo.location,
    distance: route.distance,
    duration: route.duration,
    cost: route.cost,
    steps: route.steps.slice(0, 8)
  });
}

async function toolGetWeather(args) {
  const city = String(args.city || '').trim() || state.lastCity || '北京';
  const [liveRes, forecastRes] = await Promise.all([
    amapCall('/v3/weather/weatherInfo', { city, extensions: 'base' }).catch(() => null),
    amapCall('/v3/weather/weatherInfo', { city, extensions: 'all' }).catch(() => null)
  ]);
  const live = liveRes?.lives?.[0] || null;
  const forecast = forecastRes?.forecasts?.[0] || null;
  const casts = forecast?.casts || [];
  if (!live && !casts.length) throw new Error(`未查询到「${city}」的天气信息`);

  const realCity = forecast?.city || live?.city || city;
  renderWeatherCard(realCity, live, casts);

  let center = state.lastLocation;
  if (realCity && realCity !== state.lastCity) {
    const geo = await amapCall('/v3/geocode/geo', { address: realCity }).catch(() => null);
    center = geo?.geocodes?.[0]?.location || center;
  }
  state.lastCity = realCity;
  if (center) setMap(buildMapUrl({ center, zoom: 10 }), `${realCity} · 天气查询`);

  return JSON.stringify({
    ok: true,
    city: realCity,
    reporttime: live?.reporttime || forecast?.reporttime || '',
    live: live ? { weather: live.weather, temperature: live.temperature, humidity: live.humidity, winddirection: live.winddirection, windpower: live.windpower } : null,
    forecast: casts.slice(0, 4).map((cast) => ({
      date: cast.date, dayweather: cast.dayweather, nightweather: cast.nightweather,
      daytemp: cast.daytemp, nighttemp: cast.nighttemp
    }))
  });
}

async function toolShowStaticMap(args) {
  const label = String(args.label || '').trim();
  const location = await resolveLocation(args.location, '');
  const zoom = Math.min(18, Math.max(3, Number(args.zoom) || 13));

  setMap(buildMapUrl({ center: location, zoom, markers: [{ location }] }), label || '静态地图展示');
  renderKeyValueCard('静态地图', '高德地图', [
    { key: '中心坐标', value: location },
    { key: '缩放级别', value: String(zoom) },
    { key: '说明', value: label || '—' }
  ]);

  return JSON.stringify({ ok: true, location, zoom, label });
}

async function toolLocateIp(args) {
  const ip = String(args.ip || '').trim();
  const result = await locateInternal(ip);
  if (!result.city && !result.province) throw new Error('IP 定位失败，请检查高德 Key 的 IP 定位权限');

  renderKeyValueCard('IP 定位结果', '高德 IP', [
    { key: 'IP 地址', value: ip || '当前访问 IP' },
    { key: '省份', value: result.province },
    { key: '城市', value: result.city },
    { key: '城市编码', value: result.adcode },
    { key: '城市中心坐标', value: result.center }
  ]);
  if (result.center) setMap(buildMapUrl({ center: result.center, zoom: 11, markers: [{ location: result.center }] }), `IP 定位 · ${result.city || result.province}`);

  return JSON.stringify(result);
}

const TOOL_HANDLERS = {
  search_place: toolSearchPlace,
  search_nearby: toolSearchNearby,
  plan_route: toolPlanRoute,
  get_weather: toolGetWeather,
  show_static_map: toolShowStaticMap,
  locate_ip: toolLocateIp
};

/* ============================================================
   DeepSeek / 硅基流动 工具调用引擎
   ============================================================ */

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `你是「出行小助手」，一个使用高德开放平台真实数据的中文出行智能体。今天是 ${today}。`,
    '你可以调用工具获取真实数据，禁止凭空编造地点、路线、天气、坐标或位置信息。',
    '工具：search_place 查地点；search_nearby 查附近/周边；plan_route 规划路线；get_weather 查天气；show_static_map 展示地图；locate_ip 查 IP 位置。',
    '规则：',
    '1. 只要问题涉及地理信息，就调用对应工具；必要时可以一次调用多个工具。',
    '2. 周边搜索若用户未给出位置，location 传空字符串，系统会自动用 IP 定位。',
    '3. 路线规划尽量传入完整地点名；地点名称比坐标更常见。',
    `4. 当前已知位置：${state.lastLocation || '未知'}；已知城市：${state.lastCity || '未知'}。`,
    '5. 工具返回 JSON 后，用简洁自然的中文总结关键数据（名称、地址、距离、耗时、温度等），不要原样输出 JSON。',
    '6. 工具返回错误时如实说明并给出可行建议，不要编造结果。'
  ].join('\n');
}

async function chatCompletion(messages, useTools = true) {
  const providers = [
    { name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', key: state.config.deepseekKey, model: state.config.deepseekModel },
    { name: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions', key: state.config.siliconKey, model: state.config.siliconModel }
  ].filter((provider) => provider.key);

  if (!providers.length) throw new Error('请先在设置中配置大模型 API Key');

  const body = { model: '', messages, temperature: 0.3, stream: false };
  if (useTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }

  let lastError = null;
  for (const provider of providers) {
    try {
      body.model = provider.model;
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 180);
        throw new Error(`${provider.name} 接口返回 ${response.status}：${detail}`);
      }
      const data = await response.json();
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error(`${provider.name} 返回内容为空`);
      state.provider = provider.name;
      $('#providerTag').textContent = `模型 · ${provider.name}`;
      return message;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('大模型调用失败');
}

/* ============================================================
   对话界面
   ============================================================ */

function scrollMessages() {
  const container = $('#messages');
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function addMessage(role, text) {
  const item = document.createElement('div');
  item.className = `message ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '我' : 'AI';
  const body = document.createElement('div');
  body.className = 'message-body';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = richText(text);
  body.appendChild(bubble);
  item.append(avatar, body);
  $('#messages').appendChild(item);
  scrollMessages();
  return item;
}

function addToolTrace(name, detail) {
  const trace = document.createElement('div');
  trace.className = 'tool-trace';
  trace.innerHTML = `<span class="trace-dot"></span><span>${escapeHtml(TOOL_LABELS[name] || name)} · ${escapeHtml(detail)}</span>`;
  $('#messages').appendChild(trace);
  scrollMessages();
  return trace;
}

function traceArgs(args) {
  return Object.entries(args).filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`).join('，') || '自动判断';
}

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.busy) return;

  state.busy = true;
  $('#sendBtn').disabled = true;
  $('#userInput').disabled = true;
  document.querySelectorAll('.chip').forEach((chip) => { chip.disabled = true; });
  setStatus('正在思考', 'busy');

  addMessage('user', text);
  state.messages.push({ role: 'user', content: text });
  state.cardsInTurn = false;
  $('#userInput').value = '';
  $('#userInput').style.height = 'auto';

  const conversation = [{ role: 'system', content: buildSystemPrompt() }, ...state.messages];

  try {
    let answered = false;
    for (let round = 0; round < 4; round += 1) {
      setStatus(round === 0 ? '正在思考' : `调用工具中（第 ${round} 轮）`, 'busy');
      const message = await chatCompletion(conversation);
      const calls = message.tool_calls || [];

      if (!calls.length) {
        const content = String(message.content || '').trim() || '已执行完毕，但没有生成文字总结。';
        addMessage('assistant', content);
        state.messages.push({ role: 'assistant', content });
        answered = true;
        break;
      }

      conversation.push({ role: 'assistant', content: message.content || '', tool_calls: calls });

      for (const call of calls) {
        const name = call.function?.name || '';
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) { args = {}; }
        const trace = addToolTrace(name, traceArgs(args));
        let result;
        try {
          const handler = TOOL_HANDLERS[name];
          if (!handler) throw new Error(`未知工具：${name}`);
          result = await handler(args);
          trace.classList.add('done');
        } catch (error) {
          result = JSON.stringify({ ok: false, error: error.message });
          trace.classList.add('failed');
          trace.querySelector('span:last-child').textContent += ` · ${error.message}`;
        }
        conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    if (!answered) {
      setStatus('生成最终回复', 'busy');
      const finalMessage = await chatCompletion(conversation, false);
      const content = String(finalMessage.content || '').trim() || '已为你完成查询，详情见右侧出行面板。';
      addMessage('assistant', content);
      state.messages.push({ role: 'assistant', content });
    }
    setStatus(`就绪 · ${state.lastCity || '随时出发'}`);
  } catch (error) {
    addMessage('assistant', `抱歉，这次请求没有成功：${error.message}\n\n请检查网络或点击右上角「设置」确认 API Key 是否正确。`);
    setStatus('请求失败', 'error');
  } finally {
    state.busy = false;
    $('#sendBtn').disabled = false;
    $('#userInput').disabled = false;
    document.querySelectorAll('.chip').forEach((chip) => { chip.disabled = false; });
    $('#userInput').focus();
  }
}

/* ============================================================
   设置与事件绑定
   ============================================================ */

const SETTING_FIELDS = {
  '#cfgDeepseekKey': 'deepseekKey',
  '#cfgDeepseekModel': 'deepseekModel',
  '#cfgSiliconKey': 'siliconKey',
  '#cfgSiliconModel': 'siliconModel',
  '#cfgAmapKey1': 'amapKey1',
  '#cfgAmapKey2': 'amapKey2'
};

function openSettings() {
  Object.entries(SETTING_FIELDS).forEach(([selector, field]) => {
    $(selector).value = state.config[field] || '';
  });
  $('#settingsModal').hidden = false;
}

function closeSettings() {
  $('#settingsModal').hidden = true;
}

function renderSuggestions() {
  $('#suggestions').innerHTML = SUGGESTIONS.map((text) => `<button class="chip" type="button">${escapeHtml(text)}</button>`).join('');
  $('#suggestions').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (state.busy) return;
      $('#userInput').value = chip.textContent;
      sendMessage(chip.textContent);
    });
  });
}

function bindEvents() {
  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage($('#userInput').value);
  });

  $('#userInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#chatForm').requestSubmit();
    }
  });

  $('#userInput').addEventListener('input', (event) => {
    const el = event.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  });

  $('#clearChatBtn').addEventListener('click', () => {
    if (state.busy) return;
    state.messages = [];
    state.cardsInTurn = false;
    $('#messages').innerHTML = '';
    addMessage('assistant', '对话已清空。有什么出行需求，随时告诉我。');
    $('#resultCards').innerHTML = '<div class="empty-state"><p>搜索结果、路线详情与天气信息会展示在这里</p></div>';
    $('#staticMap').hidden = true;
    $('#mapCaption').hidden = true;
    $('#mapPlaceholder').hidden = false;
    $('#mapPlaceholder').querySelector('span').textContent = '地图将在工具调用后显示';
    $('#resultMeta').textContent = '等待你的下一个出行指令';
    setStatus(`就绪 · ${state.lastCity || '随时出发'}`);
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', closeSettings);
  $('#cancelSettingsBtn').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (event) => {
    if (event.target === $('#settingsModal')) closeSettings();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#settingsModal').hidden) closeSettings();
  });

  $('#settingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    Object.entries(SETTING_FIELDS).forEach(([selector, field]) => {
      state.config[field] = $(selector).value.trim();
    });
    saveConfig();
    closeSettings();
    setStatus('设置已保存', '');
  });

  $('#resetConfigBtn').addEventListener('click', () => {
    state.config = { ...DEFAULT_CONFIG, deepseekKey: '', siliconKey: '', amapKey1: '', amapKey2: '' };
    saveConfig();
    Object.entries(SETTING_FIELDS).forEach(([selector, field]) => {
      $(selector).value = state.config[field] || '';
    });
    setStatus('密钥已清空', 'error');
  });
}

async function bootstrap() {
  bindEvents();
  renderSuggestions();
  setStatus('正在定位', 'busy');
  try {
    const result = await locateInternal();
    setStatus(result.city ? `就绪 · ${result.city}` : '就绪');
  } catch (_) {
    setStatus('就绪');
  }
}

bootstrap();
