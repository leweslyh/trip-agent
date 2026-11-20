/* 出行小助手 - 高德 Web 服务 REST 封装与六大功能 */
let conversation = [];

// 高德 Web 服务统一请求
async function amapRequest(path, params = {}) {
  const cfg = getConfig();
  const p = Object.assign({ key: cfg.amapKey }, params);
  const qs = Object.keys(p).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
  const res = await fetch('https://restapi.amap.com' + path + '?' + qs);
  if (!res.ok) throw new Error('高德接口 HTTP ' + res.status);
  const data = await res.json();
  if (String(data.status) !== '1') throw new Error((data.info || '高德接口错误') + '（错误码 ' + data.infocode + '）');
  return data;
}

function isCoord(s) { return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(String(s).trim()); }
function splitCoord(str) { return String(str).split(',').map(Number); }

// 地理编码：地名 -> 坐标
async function geocode(address, city = '') {
  const params = { address };
  if (city) params.city = city;
  const data = await amapRequest('/v3/geocode/geo', params);
  if (data.geocodes && data.geocodes.length) {
    const g = data.geocodes[0];
    const [lng, lat] = splitCoord(g.location);
    return { lng, lat, name: g.formatted_address || address };
  }
  return null;
}

// 静态地图 URL
function staticMapUrl(lng, lat, zoom = 15, markers = [], size = '750*420') {
  const cfg = getConfig();
  let m = markers.length
    ? markers.map((mk) => `${mk.style || 'mid'},${mk.color || '0x3B82F6'},${mk.label || 'A'}:${mk.lng},${mk.lat}`).join('|')
    : `mid,0x3B82F6,A:${lng},${lat}`;
  return `https://restapi.amap.com/v3/staticmap?key=${cfg.amapKey}&location=${lng},${lat}&zoom=${zoom}&size=${size}&scale=2&markers=${m}`;
}

// 1. 关键字搜索
async function keywordSearch(keyword, city) {
  const params = { keywords: keyword, offset: 10, page: 1, extensions: 'all' };
  if (city) params.city = city;
  const data = await amapRequest('/v3/place/text', params);
  if (!data.pois || !data.pois.length) return `没有找到与「${keyword}」相关的地址，换个关键词试试。`;
  const pois = data.pois;
  const markers = pois.map((p, i) => ({ lng: splitCoord(p.location)[0], lat: splitCoord(p.location)[1], label: String(i), color: '0x3B82F6' }));
  const c = splitCoord(pois[0].location);
  const img = staticMapUrl(c[0], c[1], 14, markers);
  let summary = `「${keyword}」共找到 ${data.count} 个相关地点，以下是前 ${pois.length} 个：\n`;
  pois.forEach((p, i) => { summary += `${i + 1}. ${p.name}${p.distance ? '（' + p.distance + 'm）' : ''}${p.address ? '，' + p.address : ''}\n`; });
  renderPOIs(`🔍 关键字搜索：${keyword}`, img, pois, data.count);
  return summary;
}

// 2. 周边搜索
async function surroundingSearch(keyword, center, radius = 2000) {
  let c;
  if (isCoord(center)) { const [lng, lat] = splitCoord(center); c = { lng, lat }; }
  else c = await geocode(center);
  if (!c) return `无法定位中心点「${center}」，请确认地址。`;
  const data = await amapRequest('/v3/place/around', {
    location: `${c.lng},${c.lat}`, keywords: keyword, radius: Math.round(radius), offset: 10, extensions: 'all'
  });
  if (!data.pois || !data.pois.length) return `「${center}」周边 ${Math.round(radius)} 米内没有找到${keyword}。`;
  const pois = data.pois;
  const markers = pois.map((p, i) => ({ lng: splitCoord(p.location)[0], lat: splitCoord(p.location)[1], label: String(i), color: '0x3B82F6' }));
  markers.push({ lng: c.lng, lat: c.lat, label: 'C', color: '0xEF4444' });
  const img = staticMapUrl(c.lng, c.lat, 15, markers);
  let summary = `「${center}」周边 ${Math.round(radius)} 米内的${keyword}共 ${data.count} 个，以下是前 ${pois.length} 个：\n`;
  pois.forEach((p, i) => { summary += `${i + 1}. ${p.name}（${p.distance || '-'}m）${p.address ? '，' + p.address : ''}\n`; });
  renderPOIs(`📍 周边搜索：${keyword}`, img, pois, data.count);
  return summary;
}

// 3. 路径规划
async function routePlanning(origin, destination, mode = 'driving') {
  const o = await geocode(origin);
  const d = await geocode(destination);
  if (!o) return `无法定位起点「${origin}」，请确认地址。`;
  if (!d) return `无法定位终点「${destination}」，请确认地址。`;
  const confMap = {
    driving: { label: '驾车', path: '/v3/direction/driving' },
    walking: { label: '步行', path: '/v3/direction/walking' },
    transit: { label: '公交/地铁', path: '/v3/direction/transit/integrated' },
    riding: { label: '骑行', path: '/v4/direction/bicycling' }
  };
  const conf = confMap[mode] || confMap.driving;
  const data = await amapRequest(conf.path, { origin: `${o.lng},${o.lat}`, destination: `${d.lng},${d.lat}` });

  let distKm, minutes, extra = '';
  if (mode === 'riding') {
    const p = data.data && data.data.paths && data.data.paths[0];
    distKm = ((p.distance || 0) / 1000).toFixed(1);
    minutes = Math.round((p.duration || 0) / 60);
  } else if (mode === 'transit') {
    const t = data.route && data.route.transits && data.route.transits[0];
    distKm = ((t.distance || 0) / 1000).toFixed(1);
    minutes = Math.round((t.duration || 0) / 60);
    extra = t.cost ? `，费用约 ${t.cost} 元` : '';
  } else {
    const p = data.route && data.route.paths && data.route.paths[0];
    distKm = ((p.distance || 0) / 1000).toFixed(1);
    minutes = Math.round((p.duration || 0) / 60);
  }
  const summary = `从「${origin}」到「${destination}」的${conf.label}路线：全程约 ${distKm} 公里，预计 ${minutes} 分钟${extra}。`;
  const img = staticMapUrl((o.lng + d.lng) / 2, (o.lat + d.lat) / 2, 13, [
    { lng: o.lng, lat: o.lat, label: 'A', color: '0x10B981' },
    { lng: d.lng, lat: d.lat, label: 'B', color: '0xEF4444' }
  ]);
  const info = `<div class="info-box">出行方式：<span class="strong">${conf.label}</span><br/>全程距离：<span class="strong">${distKm} 公里</span><br/>预计耗时：<span class="strong">${minutes} 分钟</span>${extra}<br/><span class="label">起点(A)：${escapeHtml(o.name)}</span><br/><span class="label">终点(B)：${escapeHtml(d.name)}</span></div>`;
  renderResult(`🛣 路径规划（${conf.label}）`, info + `<div class="map-preview"><img src="${img}" alt="路线示意图" onclick="zoomImage(this.src)"></div>`);
  return summary;
}

// 4. 天气查询
async function weatherQuery(city) {
  const data = await amapRequest('/v3/weather/weatherInfo', { city, extensions: 'all' });
  if (!data.lives || !data.lives.length) return `未能获取「${city}」的天气，请确认城市名称。`;
  const now = data.lives[0];
  let summary = `「${now.city}」当前：${now.weather}，气温 ${now.temperature}℃，${now.winddirection}风 ${now.windpower} 级，湿度 ${now.humidity}%。`;
  let detail = `<div class="weather-info"><div class="weather-now"><div class="temp">${now.temperature}℃</div><div class="cond">${escapeHtml(now.weather)}<br/>${escapeHtml(now.winddirection)}风 ${now.windpower}级<br/>湿度 ${now.humidity}%${now.reporttime ? '<br/>更新：' + now.reporttime : ''}</div></div>`;
  if (data.forecasts && data.forecasts.length && data.forecasts[0].casts) {
    summary += '\n未来几天预报：';
    detail += '<div class="weather-forecast">';
    data.forecasts[0].casts.forEach((c) => {
      summary += `\n${c.date} ${c.dayweather} ${c.nighttemp}~${c.daytemp}℃`;
      detail += `<div class="weather-day"><div class="d">${c.date.slice(5)}</div><div class="t">${c.daytemp}°/${c.nighttemp}°</div><div class="w">${escapeHtml(c.dayweather)}</div></div>`;
    });
    detail += '</div>';
  }
  detail += '</div>';
  renderResult(`🌤 天气查询：${now.city}`, detail);
  return summary;
}

// 5. 静态地图
async function staticMap(location, zoom = 15) {
  let lng, lat, name;
  if (isCoord(location)) { [lng, lat] = splitCoord(location); name = location; }
  else { const g = await geocode(location); if (!g) return `无法定位「${location}」，请确认地址。`; lng = g.lng; lat = g.lat; name = g.name; }
  const url = staticMapUrl(lng, lat, zoom, [{ lng, lat, label: 'A', color: '0xEF4444' }], '900*500');
  renderResult(`🗺 静态地图：${name}`, `<div class="map-preview"><img src="${url}" alt="静态地图" onclick="zoomImage(this.src)"></div><div class="info-box">地点：<span class="strong">${escapeHtml(name)}</span><br/>坐标：${lng}, ${lat}（缩放 ${zoom} 级）</div>`);
  return `已生成「${name}」的静态地图（缩放 ${zoom} 级）。`;
}

// 6. IP定位
async function ipLocation() {
  const data = await amapRequest('/v3/ip', {});
  const city = data.city, province = data.province, adcode = data.adcode;
  let img = '';
  if (data.rectangle) {
    const parts = data.rectangle.split(';');
    if (parts.length === 2) {
      const [a1, b1] = splitCoord(parts[0]);
      const [a2, b2] = splitCoord(parts[1]);
      const cl = (a1 + a2) / 2, cb = (b1 + b2) / 2;
      img = staticMapUrl(cl, cb, 10, [{ lng: cl, lat: cb, label: 'A', color: '0xEF4444' }]);
    }
  }
  const info = `<div class="info-box">当前城市：<span class="strong">${escapeHtml(city)}</span><br/>省份：${escapeHtml(province)}<br/>城市编码：${adcode}</div>`;
  renderResult('🌐 IP定位', info + (img ? `<div class="map-preview"><img src="${img}" alt="位置" onclick="zoomImage(this.src)"></div>` : ''));
  return `通过 IP 定位，你当前位于「${city}」（${province}），城市编码 ${adcode}。`;
}

// ---------------- 工具分发器 ----------------
const TOOL_EXECUTORS = {
  keyword_search: (a) => keywordSearch(a.keyword, a.city),
  surrounding_search: (a) => surroundingSearch(a.keyword, a.center, a.radius || 2000),
  route_planning: (a) => routePlanning(a.origin, a.destination, a.mode || 'driving'),
  weather_query: (a) => weatherQuery(a.city),
  static_map: (a) => staticMap(a.location, a.zoom || 15),
  ip_location: () => ipLocation()
};

async function executeTool(name, args) {
  try {
    const fn = TOOL_EXECUTORS[name];
    if (!fn) return '未找到对应功能。';
    const r = await fn(args || {});
    return typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e) {
    console.error('工具执行出错:', name, e);
    return `执行「${name}」时出错：${e.message}`;
  }
}
