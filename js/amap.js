/* 高德开放平台 Web 服务封装（JSONP，纯前端免跨域） */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};
  const U = App.utils;
  const HOST = 'https://restapi.amap.com';

  const cache = new Map();
  const CACHE_TTL = 90 * 1000;

  function key() {
    const k = (App.store.readConfig().amapKey || '').trim();
    if (!k) {
      const err = new Error('尚未配置高德 Web 服务 Key，请点击「配置密钥」填写');
      err.code = 'NO_AMAP_KEY';
      throw err;
    }
    return k;
  }

  async function call(path, params, options) {
    const opts = options || {};
    const finalParams = Object.assign({}, params, {
      key: key(),
      output: 'json',
      _t: Date.now()
    });
    const cacheKey = opts.cache === false ? null : path + '|' + JSON.stringify(finalParams, (k, v) => (k === '_t' ? undefined : v));
    if (cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;
    }
    const data = await U.jsonp(HOST + path, finalParams, { timeout: opts.timeout || 15000 });
    if (opts.cache !== false && cacheKey) {
      cache.set(cacheKey, { time: Date.now(), data });
      if (cache.size > 160) cache.delete(cache.keys().next().value);
    }
    return data;
  }

  function ensureOk(data, label) {
    if (!data) throw new Error((label || '高德') + '接口返回为空');
    if (String(data.status) !== '1') {
      const info = data.info || 'UNKNOWN_ERROR';
      const map = {
        INVALID_USER_KEY: '高德 Key 无效，请确认是「Web服务」类型的 Key',
        INVALID_USER_SCODE: '高德 Key 校验失败，请在高德控制台检查 Key 类型与白名单',
        USER_KEY_RESTRICTED: '该 Key 被限制调用，请检查配额或 IP 白名单',
        INSUFFICIENT_PRIVILEGES: '该 Key 权限不足，请确认已开通 Web 服务 API',
        DAILY_QUERY_OVER_LIMIT: '高德接口今日配额已用完',
        SERVICE_NOT_AVAILABLE: '高德服务暂不可用，请稍后再试',
        INVALID_PARAMS: '请求参数不合法，请换一种说法重试',
        OVER_QUERY_LIMIT: '请求过于频繁，请稍后再试'
      };
      throw new Error(map[info] || ((label || '高德') + '查询失败：' + info));
    }
    return data;
  }

  const isCoord = (str) => /^\s*-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?\s*$/.test(String(str || ''));
  const round = (v, n) => Number(Number(v || 0).toFixed(n === undefined ? 3 : n));
  const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  function distanceBetween(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const [lng1, lat1] = String(a).split(',').map(Number);
    const [lng2, lat2] = String(b).split(',').map(Number);
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }

  function normPoi(poi, origin) {
    const rating = poi.biz_ext && (poi.biz_ext.rating || poi.biz_ext.score);
    return {
      id: poi.id || '',
      name: poi.name || '未命名地点',
      type: stripHtml(poi.type).split(';').pop() || '',
      address: typeof poi.address === 'string' ? poi.address : (poi.address && poi.address[0]) || '',
      location: poi.location || '',
      tel: typeof poi.tel === 'string' ? poi.tel : (poi.tel || [])[0] || '',
      rating: rating && Number(rating) > 0 ? Number(rating) : null,
      cost: poi.biz_ext && poi.biz_ext.cost ? Number(poi.biz_ext.cost) : null,
      tag: poi.tag || '',
      distance: poi.distance ? Number(poi.distance) : (origin && poi.location ? distanceBetween(origin, poi.location) : null),
      photo: poi.photos && poi.photos[0] ? poi.photos[0].url : ''
    };
  }

  /* ---------------- 基础能力 ---------------- */

  async function geocode(address, city) {
    const data = ensureOk(await call('/v3/geocode/geo', { address, city: city || '' }, { cache: false }), '地理编码');
    const list = (data.geocodes || []).filter((g) => g.location);
    if (!list.length) throw new Error('无法解析地址「' + address + '」，请换一个更明确的说法');
    const g = list[0];
    return {
      name: g.formatted_address || address,
      location: g.location,
      lng: Number(g.location.split(',')[0]),
      lat: Number(g.location.split(',')[1]),
      province: g.province || '',
      city: g.city || g.province || '',
      district: g.district || '',
      adcode: g.adcode || '',
      level: g.level || ''
    };
  }

  async function regeo(location) {
    const data = ensureOk(await call('/v3/geocode/regeo', { location, extensions: 'base' }, { cache: false }), '逆地理编码');
    const r = data.regeocode || {};
    return {
      formatted: r.formatted_address || '',
      province: (r.addressComponent || {}).province || '',
      city: (r.addressComponent || {}).city || '',
      district: (r.addressComponent || {}).district || '',
      adcode: (r.addressComponent || {}).adcode || ''
    };
  }

  async function ipLocation() {
    const data = ensureOk(await call('/v3/ip', {}, { cache: false }), 'IP 定位');
    const province = typeof data.province === 'string' ? data.province : '';
    const city = typeof data.city === 'string' ? data.city : '';
    if (!province && !city) throw new Error('高德未能解析出当前 IP 的城市，请手动输入城市名');
    let center = '';
    if (data.rectangle) {
      const parts = String(data.rectangle).split(';');
      if (parts.length === 2) {
        const p1 = parts[0].split(',').map(Number);
        const p2 = parts[1].split(',').map(Number);
        center = round((p1[0] + p2[0]) / 2) + ',' + round((p1[1] + p2[1]) / 2);
      }
    }
    return { province, city: city || province, adcode: data.adcode || '', center, rectangle: data.rectangle || '' };
  }

  async function textSearch(args) {
    const params = {
      keywords: args.keywords,
      city: args.city || '',
      citylimit: args.citylimit === false ? 'false' : 'true',
      types: args.types || '',
      offset: Math.min(Math.max(Number(args.limit) || 10, 1), 25),
      page: Math.max(Number(args.page) || 1, 1),
      extensions: 'all'
    };
    const data = ensureOk(await call('/v3/place/text', params), '关键字搜索');
    const pois = (data.pois || []).map((p) => normPoi(p));
    return {
      count: Number(data.count || pois.length),
      city: args.city || '',
      pois,
      keyword: args.keywords
    };
  }

  async function aroundSearch(args) {
    let location = args.location;
    if (!isCoord(location)) {
      if (location) {
        const g = await geocode(location, args.city);
        location = g.location;
      } else {
        const ip = await ipLocation();
        if (ip.center) location = ip.center;
        else {
          const g = await geocode((args.city || App.store.readConfig().city) + '市中心', args.city);
          location = g.location;
        }
      }
    }
    const params = {
      location,
      keywords: args.keywords || '',
      types: args.types || '',
      radius: Math.min(Math.max(Number(args.radius) || 3000, 100), 50000),
      sortrule: args.sortrule === 'weight' ? 'weight' : 'distance',
      offset: Math.min(Math.max(Number(args.limit) || 10, 1), 25),
      page: 1,
      extensions: 'all'
    };
    const data = ensureOk(await call('/v3/place/around', params), '周边搜索');
    const pois = (data.pois || []).map((p) => normPoi(p, location));
    return { center: location, radius: params.radius, count: pois.length, pois, keyword: args.keywords || '' };
  }

  /* ---------------- 路径规划 ---------------- */

  async function resolvePoint(input, city, fallback) {
    const raw = String(input || '').trim();
    if (isCoord(raw)) return { name: fallback || '指定坐标', location: raw.replace(/\s/g, '') };
    if (!raw) throw new Error('缺少起点或终点');
    const g = await geocode(raw, city);
    return { name: g.name, location: g.location, city: g.city };
  }

  function mergePolyline(steps) {
    const pts = [];
    (steps || []).forEach((s) => {
      String(s.polyline || '').split(';').forEach((p) => { if (p) pts.push(p); });
    });
    return pts;
  }

  function sampleLine(points, max) {
    const limit = max || 60;
    if (points.length <= limit) return points;
    const step = Math.ceil(points.length / limit);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  async function route(args) {
    const mode = ['driving', 'walking', 'bicycling', 'transit'].indexOf(args.mode) >= 0 ? args.mode : 'driving';
    const cfg = App.store.readConfig();
    const city = args.city || cfg.city;
    const origin = await resolvePoint(args.origin, city, '起点');
    const destination = await resolvePoint(args.destination, city, '终点');

    if (mode === 'transit') {
      const data = ensureOk(await call('/v3/direction/transit/integrated', {
        origin: origin.location, destination: destination.location,
        city: args.city || cfg.city || '', cityd: args.cityd || '', extensions: 'all'
      }, { cache: false }), '公交路径规划');
      const r = data.route || {};
      const transits = r.transits || [];
      if (!transits.length) throw new Error('未找到可用的公交方案，可能两地距离过近或过远');
      const t = transits[0];
      const segments = [];
      (t.segments || []).forEach((seg) => {
        if (seg.walking && Number(seg.walking.distance) > 0) {
          segments.push({ type: 'walk', text: '步行 ' + U.fmtDistance(seg.walking.distance) + ' 至 ' + ((seg.walking.destination && seg.walking.destination) ? '' : '下一站') });
        }
        if (seg.bus && seg.bus.buslines && seg.bus.buslines.length) {
          const line = seg.bus.buslines[0];
          segments.push({
            type: 'bus',
            text: line.name + '（' + (line.departure_stop ? line.departure_stop.name : '') + ' 上车 → ' + (line.arrival_stop ? line.arrival_stop.name : '') + ' 下车，' + (line.via_num || 0) + ' 站）'
          });
        }
      });
      return {
        mode, origin: origin.name, destination: destination.name,
        distance: Number(t.distance) || 0,
        duration: Number(t.duration) || 0,
        cost: t.cost ? Number(t.cost) : null,
        walkingDistance: t.walking_distance ? Number(t.walking_distance) : null,
        steps: segments.map((s) => s.text),
        polyline: [],
        alternatives: transits.slice(0, 3).map((x) => ({ distance: Number(x.distance) || 0, duration: Number(x.duration) || 0, cost: x.cost || null }))
      };
    }

    let paths;
    if (mode === 'bicycling') {
      const data = ensureOk(await call('/v4/direction/bicycling', {
        origin: origin.location, destination: destination.location
      }, { cache: false }), '骑行路径规划');
      paths = (data.data && data.data.paths) || [];
      if (!paths.length) throw new Error('未找到骑行路线');
    } else {
      const data = ensureOk(await call('/v3/direction/' + mode, {
        origin: origin.location, destination: destination.location, extensions: 'all',
        strategy: mode === 'driving' ? 0 : undefined
      }, { cache: false }), mode === 'driving' ? '驾车路径规划' : '步行路径规划');
      paths = (data.route && data.route.paths) || [];
      if (!paths.length) throw new Error('未找到可用路线');
    }
    const pathData = paths[0];
    const steps = pathData.steps || [];

    const stepTexts = steps.slice(0, 22).map((s) => {
      let text = stripHtml(s.instruction || s.road || '继续前行');
      if (s.distance) text += '（' + U.fmtDistance(s.distance) + '）';
      if (s.tmc && s.tmc.tmc_status) text += ' ' + s.tmc.tmc_status;
      return text;
    });

    return {
      mode, origin: origin.name, destination: destination.name,
      distance: Number(pathData.distance) || 0,
      duration: Number(pathData.duration) || 0,
      tolls: pathData.tolls ? Number(pathData.tolls) : null,
      trafficLights: pathData.traffic_lights ? Number(pathData.traffic_lights) : null,
      steps: stepTexts,
      polyline: sampleLine(mergePolyline(steps), 60),
      alternatives: paths.slice(1, 4).map((p) => ({ distance: Number(p.distance) || 0, duration: Number(p.duration) || 0 }))
    };
  }

  /* ---------------- 天气 ---------------- */

  async function weather(args) {
    let city = args.city;
    if (!city) {
      const ip = await ipLocation();
      city = ip.city || App.store.readConfig().city;
    }
    const type = args.type === 'forecast' ? 'all' : (args.type === 'now' ? 'base' : 'all');
    const data = ensureOk(await call('/v3/weather/weatherInfo', { city, extensions: type === 'all' ? 'all' : 'base' }), '天气查询');
    const lives = (data.lives || []).map((l) => ({
      province: l.province, city: l.city, adcode: l.adcode,
      weather: l.weather, temperature: l.temperature, windDirection: l.winddirection,
      windPower: l.windpower, humidity: l.humidity, reportTime: l.reporttime
    }));
    const forecasts = (data.forecasts || []).map((f) => ({
      city: f.city, adcode: f.adcode, reportTime: f.reporttime,
      casts: (f.casts || []).map((c) => ({
        date: c.date, week: c.week, dayWeather: c.dayweather, nightWeather: c.nightweather,
        dayTemp: c.daytemp, nightTemp: c.nighttemp, dayWind: c.daywind, nightWind: c.nightwind,
        dayPower: c.daypower, nightPower: c.nightpower
      }))
    }));
    if (!lives.length && !forecasts.length) throw new Error('未查询到「' + city + '」的天气数据');
    return { city, lives, forecasts };
  }

  /* ---------------- 静态地图 ---------------- */

  async function staticMap(args) {
    const cfg = App.store.readConfig();
    let center = args.center;
    if (isCoord(center)) {
      center = center.replace(/\s/g, '');
    } else if (center) {
      const g = await geocode(center, args.city || cfg.city);
      center = g.location;
    }

    const markers = (args.markers || []).filter((m) => m && isCoord(m.location)).slice(0, 6);
    let pathStr = '';
    if (Array.isArray(args.path) && args.path.length > 1) {
      pathStr = sampleLine(args.path.map((p) => String(p).replace(/\s/g, '')), 55).join(';');
    }

    if (!center && markers.length) center = markers[0].location;
    if (!center && !markers.length && !pathStr) {
      const ip = await ipLocation();
      center = ip.center;
    }
    if (!center && pathStr) center = pathStr.split(';')[0];

    const size = args.size && /^\d{3,4}\*\d{3,4}$/.test(args.size) ? args.size : '900*520';
    const zoom = Math.min(Math.max(Number(args.zoom) || 13, 3), 18);
    const params = {
      location: center || '',
      zoom: String(zoom),
      size,
      scale: '1',
      traffic: args.traffic ? '1' : '0',
      key: key()
    };

    if (markers.length) {
      // 高德静态地图：markers=大小,颜色,标签:lng,lat;lng,lat
      const colors = ['0x0B63F2', '0xD94848', '0x12A150', '0xD97B06', '0x7A5AF8', '0x0F8FA8'];
      const groups = markers.map((m, i) => {
        const label = String(m.label || String.fromCharCode(65 + i)).slice(0, 1).toUpperCase();
        return 'mid,' + colors[i % colors.length] + ',' + label + ':' + String(m.location).replace(/\s/g, '');
      });
      params.markers = groups.join('|');
    }
    if (pathStr) {
      params.path = '6,0x0B63F2,0.85,0x0B63F2,0.16:' + pathStr;
    }

    const qs = Object.keys(params)
      .filter((k) => params[k] !== '' && params[k] !== undefined)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&');

    return {
      url: HOST + '/v3/staticmap?' + qs,
      center: center || '',
      zoom,
      markers: markers.map((m) => ({ name: m.name || m.label || '', location: m.location })),
      hasPath: !!pathStr
    };
  }

  App.amap = {
    geocode, regeo, ipLocation, textSearch, aroundSearch, route, weather, staticMap,
    isCoord, distanceBetween, stripHtml
  };
})(window);
