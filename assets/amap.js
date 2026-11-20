/* ============================================================
 * 高德开放平台 Web 服务 SDK（纯前端调用）
 * 能力：IP 定位 / 关键字搜索 / 周边搜索 / 路径规划 / 天气 / 静态地图 / 地理编码
 * 特性：多 Key 自动轮换、超时控制、结果归一化（模型摘要 + UI 卡片）
 * ============================================================ */
(function (global) {
  'use strict';

  const HOST = 'https://restapi.amap.com';

  const state = {
    keys: [],
    cursor: 0,
    dead: new Set(),
  };

  function setKeys(keys) {
    state.keys = (keys || []).map((k) => String(k || '').trim()).filter(Boolean);
    state.cursor = 0;
    state.dead.clear();
  }
  const hasKey = () => state.keys.length > 0;

  /* ---------- 通用请求：自动轮换 Key ---------- */
  async function request(path, params, retry = 0) {
    if (!hasKey()) throw new Error('尚未配置高德 Key');
    const key = state.keys[state.cursor % state.keys.length];
    const qs = new URLSearchParams({ ...params, key });
    const url = `${HOST}${path}?${qs.toString()}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let json;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      json = await res.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '高德接口请求超时' : '高德接口网络异常');
    } finally {
      clearTimeout(timer);
    }

    // Key 失效 / 配额耗尽 → 换下一个 Key 重试
    const badCodes = ['10001', '10002', '10005', '10009', '10044'];
    if (json && badCodes.includes(String(json.infocode)) && retry < state.keys.length - 1) {
      state.dead.add(key);
      state.cursor = (state.cursor + 1) % state.keys.length;
      return request(path, params, retry + 1);
    }
    if (json && String(json.status) === '0') {
      throw new Error(`高德接口错误：${json.info || '未知'}（${json.infocode || '-'}）`);
    }
    return json;
  }

  /* ---------- 工具函数 ---------- */
  const num = (v) => (v === undefined || v === null || v === '' || Array.isArray(v) ? null : Number(v));
  const fmtDist = (m) => {
    const n = num(m);
    if (n === null) return '未知';
    return n >= 1000 ? (n / 1000).toFixed(1) + ' 公里' : Math.round(n) + ' 米';
  };
  const fmtDur = (s) => {
    const n = num(s);
    if (n === null) return '未知';
    const h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60);
    return h > 0 ? `${h} 小时 ${m} 分钟` : `${Math.max(m, 1)} 分钟`;
  };
  const parseLoc = (loc) => {
    if (Array.isArray(loc)) return { lng: Number(loc[0]), lat: Number(loc[1]) };
    if (typeof loc === 'string' && loc.includes(',')) {
      const [a, b] = loc.split(',').map(Number);
      return { lng: a, lat: b };
    }
    return null;
  };
  const str = (v) => (Array.isArray(v) ? v.filter(Boolean).join(' ') : (v || ''));

  function normPoi(p) {
    const loc = parseLoc(p.location);
    return {
      id: p.id,
      name: str(p.name),
      address: str(p.address) || '暂无地址',
      type: str(p.type),
      tel: str(p.tel),
      distance: num(p.distance),
      lng: loc ? loc.lng : null,
      lat: loc ? loc.lat : null,
      location: p.location,
      photos: (p.photos || []).slice(0, 3).map((x) => x.url),
      rating: p.biz_ext && !Array.isArray(p.biz_ext) ? p.biz_ext.rating : '',
      cost: p.biz_ext && !Array.isArray(p.biz_ext) ? p.biz_ext.cost : '',
      cityname: str(p.cityname),
    };
  }

  /* ---------- 静态地图 ---------- */
  function staticMapUrl(opts) {
    const o = opts || {};
    const key = state.keys[state.cursor % state.keys.length];
    const size = o.size || '760*440';
    const q = new URLSearchParams({
      key,
      size,
      zoom: String(o.zoom || 13),
      scale: '2',
    });
    if (o.center) q.set('location', o.center);

    const markers = (o.markers || []).filter((m) => m && m.location).slice(0, 12);
    if (markers.length) {
      q.set('markers', markers.map((m, idx) =>
        `mid,${m.color || '0x2563eb'},${m.label || String.fromCharCode(65 + idx)}:${m.location}`
      ).join('|'));
    }
    if (o.path && o.path.length > 1) {
      q.set('paths', `6,0x2563eb,0.95,,:${o.path.join(';')}`);
    }
    return `${HOST}/v3/staticmap?${q.toString()}`;
  }

  /* ---------- 地图数据载荷：交给前端交互式地图渲染 ---------- */
  /**
   * 统一结构：
   * { center:{lng,lat}, zoom, markers:[{lng,lat,label,title,desc,kind}],
   *   path:[[lng,lat],...], caption, imageUrl }
   * imageUrl 仅作降级用（Leaflet/瓦片不可用时显示静态图），构建不消耗配额。
   */
  function mapPayload(o) {
    const opt = o || {};
    const markers = (opt.markers || [])
      .map((m) => {
        const p = parseLoc(String((m && m.location) || ''));
        if (!p) return null;
        return { lng: p.lng, lat: p.lat, label: m.label, title: m.title, desc: m.desc, kind: m.kind || 'poi', color: m.color };
      })
      .filter(Boolean)
      .slice(0, 30);
    const path = (opt.path || []).map((s) => parseLoc(String(s))).filter(Boolean).map((p) => [p.lng, p.lat]);
    const center = parseLoc(String(opt.center || ''));
    const zoom = opt.zoom || 13;
    const imageUrl = staticMapUrl({
      center: opt.center,
      zoom,
      markers: (opt.markers || []).slice(0, 12),
      path: opt.path ? (opt.path.length > 90 ? samplePolyline(opt.path.join(';'), 90) : opt.path) : null,
      size: opt.size || '760*440',
    });
    return {
      center: center || null,
      zoom,
      markers,
      path,
      caption: opt.caption || '',
      imageUrl,
    };
  }

  /* 把 polyline 抽样成不超过 n 个点，控制 URL 长度 */
  function samplePolyline(polyline, max = 90) {
    const pts = String(polyline || '').split(';').filter((x) => x.includes(','));
    if (pts.length <= max) return pts;
    const step = Math.ceil(pts.length / max);
    const out = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }

  /* ---------- 各项能力 ---------- */
  async function ipLocation() {
    const j = await request('/v3/ip', {});
    // rectangle 形如 "lng1,lat1;lng2,lat2"，取对角线两点求中心
    const corners = String(j.rectangle || '').split(';').map(parseLoc).filter(Boolean);
    let center = null;
    if (corners.length === 2) {
      center = { lng: +((corners[0].lng + corners[1].lng) / 2).toFixed(6), lat: +((corners[0].lat + corners[1].lat) / 2).toFixed(6) };
    } else if (corners.length === 1) {
      center = corners[0];
    }
    return {
      province: str(j.province),
      city: str(j.city) || str(j.province),
      adcode: str(j.adcode),
      center: center ? `${center.lng},${center.lat}` : null,
    };
  }

  async function geocode(address, city) {
    const j = await request('/v3/geocode/geo', { address, ...(city ? { city } : {}) });
    const g = (j.geocodes || [])[0];
    if (!g) return null;
    return { location: g.location, city: str(g.city) || str(g.province), level: str(g.level), formatted: str(g.formatted_address) };
  }

  async function regeo(location) {
    const j = await request('/v3/geocode/regeo', { location, extensions: 'base' });
    const rc = j.regeocode || {};
    const ac = rc.addressComponent || {};
    return {
      address: str(rc.formatted_address),
      province: str(ac.province),
      city: str(ac.city) || str(ac.province),
      district: str(ac.district),
      adcode: str(ac.adcode),
      poi: str((rc.pois && rc.pois[0] && rc.pois[0].name) || ''),
    };
  }

  async function textSearch(keywords, city, offset = 8) {
    const j = await request('/v3/place/text', {
      keywords, ...(city ? { city, citylimit: 'true' } : {}),
      offset: String(Math.min(offset, 25)), page: '1', extensions: 'base',
    });
    const list = (j.pois || []).map(normPoi);
    return { count: num(j.count) || list.length, pois: list };
  }

  async function aroundSearch(location, keywords, radius = 2000, offset = 8) {
    const j = await request('/v3/place/around', {
      location, ...(keywords ? { keywords } : {}),
      radius: String(Math.min(Math.max(radius, 100), 50000)),
      offset: String(Math.min(offset, 25)), page: '1', extensions: 'base', sortrule: 'distance',
    });
    const list = (j.pois || []).map(normPoi);
    return { count: num(j.count) || list.length, pois: list };
  }

  async function weather(city) {
    const j = await request('/v3/weather/weatherInfo', { city, extensions: 'all' });
    const f = (j.forecasts || [])[0];
    if (!f) throw new Error('未查询到该城市天气：' + city);
    const cast = (f.casts || []).map((c) => ({
      date: c.date, week: c.week, dayWeather: c.dayweather, nightWeather: c.nightweather,
      dayTemp: c.daytemp, nightTemp: c.nighttemp, dayWind: `${c.daywind}风 ${c.daypower}级`,
    }));
    // 实时天气（v3 weatherInfo 的 lives 需要不带 extensions）
    let live = null;
    try {
      const j2 = await request('/v3/weather/weatherInfo', { city });
      const l = (j2.lives || [])[0];
      if (l) live = { weather: l.weather, temperature: l.temperature, wind: `${l.winddirection}风 ${l.windpower}级`, humidity: l.humidity, reporttime: l.reporttime };
    } catch (_) { /* 忽略实时天气失败 */ }
    return { city: str(f.city), province: str(f.province), adcode: str(f.adcode), live, casts: cast, reporttime: str(f.reporttime) };
  }

  async function route(mode, origin, destination, city) {
    const o = origin, d = destination;
    if (mode === 'walking') {
      const j = await request('/v3/direction/walking', { origin: o, destination: d });
      return buildRoute('walking', j.route);
    }
    if (mode === 'bicycling' || mode === 'riding') {
      const j = await request('/v4/direction/bicycling', { origin: o, destination: d });
      return buildRoute('bicycling', j.data, true);
    }
    if (mode === 'transit' || mode === 'bus') {
      const cityName = city || '';
      const j = await request('/v3/direction/transit/integrated', {
        origin: o, destination: d, city: cityName, cityd: cityName, extensions: 'base',
      });
      const r = j.route || {};
      const t = (r.transits || [])[0];
      if (!t) throw new Error('未找到公共交通方案');
      const segs = (t.segments || []).map((s) => {
        const bus = (s.buslines || [])[0];
        const walk = s.walking || {};
        if (bus) {
          return {
            text: `乘坐 ${bus.name}（${bus.departure_stop && bus.departure_stop.name} → ${bus.arrival_stop && bus.arrival_stop.name}，${bus.via_num} 站）`,
            distance: num(bus.distance), duration: num(bus.duration),
            polyline: samplePolyline(bus.polyline, 40),
          };
        }
        return { text: `步行 ${fmtDist(walk.distance)}`, distance: num(walk.distance), duration: num(walk.duration), polyline: samplePolyline(walk.polyline, 40) };
      });
      return {
        mode: 'transit',
        distance: num(t.distance), duration: num(t.duration), cost: num(t.cost),
        taxiCost: num(r.taxi_cost), walkingDistance: num(t.walking_distance),
        steps: segs,
        path: segs.flatMap((s) => s.polyline),
      };
    }
    const j = await request('/v3/direction/driving', {
      origin: o, destination: d, extensions: 'all', strategy: '0',
    });
    return buildRoute('driving', j.route);
  }

  function buildRoute(mode, routeObj, isV4) {
    const r = routeObj || {};
    const p = (r.paths || [])[0];
    if (!p) throw new Error('未找到可用路线');
    const steps = (p.steps || []).map((s) => ({
      text: s.instruction || s.action || '',
      distance: num(s.distance), duration: num(s.duration),
      polyline: samplePolyline(s.polyline, 40),
    }));
    return {
      mode,
      distance: num(p.distance),
      duration: num(p.duration),
      tolls: num(p.tolls),
      trafficLights: num(p.traffic_lights),
      steps,
      path: steps.flatMap((s) => s.polyline),
      taxiCost: isV4 ? null : (r.taxi_cost ? num(r.taxi_cost) : null),
    };
  }

  /* ---------- 供大模型调用的工具定义 ---------- */
  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'amap_ip_location',
        description: '基于用户IP定位当前所在城市，返回省市区与城市中心坐标。用户问“我在哪”“我这附近”时优先调用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_geocode',
        description: '地理编码：把中文地址/地名转换成经纬度坐标。需要坐标但还没有坐标时使用（如“西湖”“杭州东站”）。',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '结构化地址或地名' },
            city: { type: 'string', description: '限定城市，可省略' },
          },
          required: ['address'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_regeo',
        description: '逆地理编码：把经纬度转换为详细地址（省市区、街道）。',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string', description: '经纬度，格式 "经度,纬度"' } },
          required: ['location'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_poi_search',
        description: '关键字搜索：按名称/类型检索全国地点（景点、餐厅、酒店、地铁站等），返回名称、地址、电话、坐标、评分。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词，如“西湖”“咖啡馆”' },
            city: { type: 'string', description: '城市名，可省略（省略则全国范围）' },
            offset: { type: 'number', description: '返回条数，默认 8，最大 20' },
          },
          required: ['keywords'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_around_search',
        description: '周边搜索：以某个坐标为中心，按关键词/半径检索附近地点。用户问“附近有什么”“最近的地铁站”时使用。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '关键词，如“咖啡”“停车场”，可省略' },
            location: { type: 'string', description: '中心点 "经度,纬度"，省略则使用用户当前定位' },
            radius: { type: 'number', description: '半径（米），默认 2000，最大 50000' },
            offset: { type: 'number', description: '返回条数，默认 8' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_route_plan',
        description: '路径规划：计算两点间的驾车/步行/骑行/公交路线，返回距离、预计耗时、主要路段，并自动绘制路线图。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['driving', 'walking', 'bicycling', 'transit'], description: '出行方式' },
            destination: { type: 'string', description: '终点，可传中文地名或 "经度,纬度"' },
            origin: { type: 'string', description: '起点，可传中文地名或 "经度,纬度"，省略则使用用户当前定位' },
            city: { type: 'string', description: '公交规划所需城市名' },
          },
          required: ['mode', 'destination'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_weather',
        description: '天气查询：查询城市实时天气与未来4天预报。省略 city 时使用用户当前城市。',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名或 adcode，可省略' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'amap_static_map',
        description: '地图展示：把中心点、标注点、路径画到界面右侧地图上（可交互缩放拖动），用于可视化回答。',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: '地图中心 "经度,纬度"，可省略' },
            zoom: { type: 'number', description: '缩放级别 3-18，默认 13' },
            markers: { type: 'array', items: { type: 'string' }, description: '标注点列表，格式 "名称:经度,纬度" 或 "经度,纬度"' },
            path: { type: 'string', description: '路径折线，格式 "经度,纬度;经度,纬度;..."，可省略' },
          },
        },
      },
    },
  ];

  /* ---------- 工具执行器 ---------- */
  async function execute(name, args, ctx) {
    const a = args || {};
    const me = ctx.getLocation ? ctx.getLocation() : null;

    switch (name) {
      case 'amap_ip_location': {
        const r = await ipLocation();
        const center = r.center || (me && `${me.lng},${me.lat}`);
        const map = center ? mapPayload({
          center, zoom: 11,
          markers: [{ location: center, label: '我', kind: 'me', title: `${r.province} ${r.city}`, desc: 'IP 定位城市中心' }],
          caption: `IP 定位：${r.province} ${r.city}`,
        }) : null;
        return {
          model: `IP 定位结果：省=${r.province}，市=${r.city}，adcode=${r.adcode}，中心坐标=${r.center || '未知'}`,
          card: { type: 'ip', data: r },
          map,
        };
      }

      case 'amap_geocode': {
        const g = await geocode(a.address, a.city);
        if (!g) return { model: `未找到“${a.address}”的坐标，可换个更具体的名称。`, card: null };
        return {
          model: `地理编码：“${a.address}” → 坐标 ${g.location}，城市 ${g.city}，级别 ${g.level}。`,
          card: { type: 'geo', data: { ...g, query: a.address } },
        };
      }

      case 'amap_regeo': {
        const loc = a.location || (me && `${me.lng},${me.lat}`);
        if (!loc) return { model: '缺少坐标，无法逆地理编码。', card: null };
        const r = await regeo(loc);
        return {
          model: `逆地理编码 ${loc}：${r.address}（${r.province}${r.city}${r.district}）`,
          card: { type: 'regeo', data: r },
        };
      }

      case 'amap_poi_search': {
        const city = a.city || (me && me.city) || '';
        const r = await textSearch(a.keywords, city, a.offset || 8);
        const pts = r.pois.filter((p) => p.location).slice(0, 10);
        const map = pts.length ? mapPayload({
          center: pts[0].location, zoom: pts.length === 1 ? 15 : 12,
          markers: pts.map((p, i) => ({
            location: p.location, label: String(i + 1),
            title: p.name, desc: [p.address, p.type, p.tel ? '电话 ' + p.tel : ''].filter(Boolean).join(' · '),
          })),
          caption: `关键字搜索「${a.keywords}」${city ? ' · ' + city : ''}，共 ${r.count} 条结果`,
        }) : null;
        return {
          model: `关键字搜索「${a.keywords}」共 ${r.count} 条，前 ${r.pois.length} 条：\n` +
            r.pois.map((p, i) => `${i + 1}. ${p.name}｜${p.address}｜${p.type}${p.tel ? '｜电话 ' + p.tel : ''}｜坐标 ${p.location}`).join('\n'),
          card: { type: 'poi', data: { title: `搜索「${a.keywords}」`, city, count: r.count, pois: r.pois } },
          map,
        };
      }

      case 'amap_around_search': {
        let loc = a.location;
        let centerDesc = '指定位置';
        if (!loc && me) { loc = `${me.lng},${me.lat}`; centerDesc = me.address || '当前定位'; }
        if (!loc) {
          const ip = await ipLocation();
          loc = ip.center;
          centerDesc = ip.city;
        }
        const r = await aroundSearch(loc, a.keywords, a.radius || 2000, a.offset || 8);
        const pts = r.pois.filter((p) => p.location).slice(0, 10);
        const map = mapPayload({
          center: loc, zoom: 14,
          markers: [{ location: loc, label: '我', kind: 'me', title: centerDesc, desc: '搜索中心点' }]
            .concat(pts.map((p, i) => ({
              location: p.location, label: String(i + 1),
              title: p.name, desc: [p.distance ? fmtDist(p.distance) : '', p.address].filter(Boolean).join(' · '),
            }))),
          caption: `周边搜索「${a.keywords || '全部'}」· ${centerDesc} · 半径 ${a.radius || 2000} 米`,
        });
        return {
          model: `周边搜索（中心 ${loc}，半径 ${a.radius || 2000} 米）共 ${r.count} 条，前 ${r.pois.length} 条：\n` +
            r.pois.map((p, i) => `${i + 1}. ${p.name}｜${fmtDist(p.distance)}｜${p.address}${p.tel ? '｜电话 ' + p.tel : ''}｜坐标 ${p.location}`).join('\n'),
          card: { type: 'poi', data: { title: `附近「${a.keywords || '全部'}」`, city: centerDesc, count: r.count, pois: r.pois, around: true } },
          map,
        };
      }

      case 'amap_route_plan': {
        const destText = String(a.destination || '');
        let dest = parseLoc(destText) ? destText : null;
        if (!dest) {
          const g = await geocode(destText, a.city || (me && me.city));
          if (!g) return { model: `无法解析终点“${destText}”，请给出更明确的地址。`, card: null };
          dest = g.location;
        }
        let origin = a.origin ? String(a.origin) : null;
        if (origin && !parseLoc(origin)) {
          const g = await geocode(origin, me && me.city);
          origin = g ? g.location : null;
        }
        if (!origin) {
          if (me) origin = `${me.lng},${me.lat}`;
          else { const ip = await ipLocation(); origin = ip.center; }
        }
        let cityName = a.city || (me && me.city) || '';
        if (!cityName) {
          try { cityName = (await regeo(dest)).city; } catch (_) { /* ignore */ }
        }

        const r = await route(a.mode, origin, dest, cityName);
        const modeName = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '公交' }[r.mode] || r.mode;
        const map = mapPayload({
          center: r.path[0] || origin, zoom: r.distance && r.distance > 20000 ? 10 : 12,
          markers: [
            { location: origin, label: '起', kind: 'origin', title: '起点', desc: a.origin || (me && me.address) || origin },
            { location: dest, label: '终', kind: 'dest', title: '终点', desc: destText },
          ],
          path: r.path,
          caption: `${modeName}路线 · 全程 ${fmtDist(r.distance)} · 约 ${fmtDur(r.duration)}`,
        });
        const stepText = r.steps.slice(0, 12).map((s, i) => `${i + 1}. ${s.text}（${fmtDist(s.distance)}）`).join('\n');
        return {
          model: `${modeName}路线（${origin} → ${dest}）：全程 ${fmtDist(r.distance)}，预计 ${fmtDur(r.duration)}` +
            (r.cost ? `，票价 ${r.cost} 元` : '') + (r.tolls ? `，过路费 ${r.tolls} 元` : '') +
            `。\n主要路段：\n${stepText}`,
          card: {
            type: 'route',
            data: {
              mode: r.mode, modeName, origin, dest, destination: destText,
              distance: r.distance, duration: r.duration, tolls: r.tolls,
              cost: r.cost, taxiCost: r.taxiCost, steps: r.steps,
            },
          },
          map,
        };
      }

      case 'amap_weather': {
        let cityName = a.city || (me && me.city);
        if (!cityName) { const ip = await ipLocation(); cityName = ip.city; }
        const r = await weather(cityName);
        const live = r.live;
        return {
          model: `${r.city} 天气：${live ? `当前 ${live.weather} ${live.temperature}℃，${live.wind}，湿度 ${live.humidity}%` : '（实时数据缺失）'}。` +
            `未来预报：` + r.casts.map((c) => `${c.date}(${c.week}) ${c.dayWeather}/${c.nightWeather} ${c.nightTemp}~${c.dayTemp}℃`).join('；'),
          card: { type: 'weather', data: r },
        };
      }

      case 'amap_static_map': {
        const center = a.location || (me && `${me.lng},${me.lat}`);
        const markers = [];
        (a.markers || []).forEach((mRaw) => {
          const m = String(mRaw || '');
          const [maybeLabel, maybeLoc] = m.split(':');
          const loc = parseLoc(maybeLoc || maybeLabel);
          if (!loc) return;
          markers.push({
            location: `${loc.lng},${loc.lat}`,
            label: maybeLoc ? maybeLabel.slice(0, 2) : String(markers.length + 1),
          });
        });
        const path = a.path ? samplePolyline(a.path, 90) : null;
        if (!center && !markers.length) return { model: '缺少地图中心点或标注点，无法生成地图。', card: null };
        const map = mapPayload({
          center: center || markers[0].location,
          zoom: a.zoom || 13,
          markers,
          path,
          caption: a.caption || `地图展示 · 缩放 ${a.zoom || 13}`,
        });
        return {
          model: `已生成地图（中心 ${center || markers[0].location}，缩放 ${a.zoom || 13}，${markers.length} 个标注）。`,
          card: null,
          map,
        };
      }

      default:
        return { model: `未知工具：${name}`, card: null };
    }
  }

  global.AMapAPI = {
    setKeys, hasKey, execute, TOOLS, staticMapUrl, mapPayload,
    ipLocation, geocode, regeo, weather, route,
    fmtDist, fmtDur,
  };
})(window);
