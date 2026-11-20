/**
 * 高德开放平台 Web服务 API 封装 + 静态地图构造
 * 全部为纯前端 HTTP GET 调用，无需后端。
 */
(function () {
  const HOST = 'https://restapi.amap.com';

  async function amapRequest(path, params) {
    const cfg = Config.get();
    if (!cfg.amapKey) {
      throw new Error('请先在设置中填写「高德 Web服务 Key」');
    }
    const qs = new URLSearchParams();
    for (const k in params) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        qs.set(k, params[k]);
      }
    }
    qs.set('key', cfg.amapKey);
    qs.set('output', 'json');

    let res;
    try {
      res = await fetch(`${HOST}${path}?${qs.toString()}`);
    } catch (e) {
      throw new Error('网络请求失败：' + e.message);
    }
    if (!res.ok) {
      throw new Error(`高德接口 HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.status !== '1') {
      const code = data.infocode ? '（infocode ' + data.infocode + '）' : '';
      throw new Error('高德接口 ' + path + ' 参数错误：' + (data.info || '未知错误') + code);
    }
    return data;
  }

  function assertOk(data, fallback) {
    if (!data || data.status !== '1') {
      throw new Error((data && data.info) || fallback || '查询失败');
    }
    return data;
  }

  // 地理编码 / 地址转坐标（关键字搜索兜底）
  async function geocode(address, city) {
    const data = await amapRequest('/v3/geocode/geo', { address, city });
    return assertOk(data, '地理编码失败');
  }

  // 关键字搜索 POI
  async function placeText(keywords, city, offset, page) {
    const data = await amapRequest('/v3/place/text', {
      keywords,
      city: city || '全国',
      citylimit: city ? 'false' : 'false',
      offset: offset || 10,
      page: page || 1,
      extensions: 'base'
    });
    return assertOk(data, '关键字搜索失败');
  }

  // 周边搜索
  async function placeAround(location, keywords, radius, offset, page) {
    const data = await amapRequest('/v3/place/around', {
      location,
      keywords: keywords || '',
      radius: radius || 2000,
      offset: offset || 10,
      page: page || 1,
      extensions: 'base'
    });
    return assertOk(data, '周边搜索失败');
  }

  // 路径规划
  async function direction(origin, destination, mode, city) {
    let path, params = { origin, destination, extensions: 'all' };
    if (mode === 'driving') path = '/v3/direction/driving';
    else if (mode === 'walking') path = '/v3/direction/walking';
    else if (mode === 'transit') {
      path = '/v3/direction/transit/integrated';
      params.city = city;
      params.extensions = 'all';
    } else {
      path = '/v3/direction/driving';
    }
    const data = await amapRequest(path, params);
    return assertOk(data, '路径规划失败');
  }

  // 天气查询（city 支持 adcode 或城市名）
  async function weatherInfo(city, extensions) {
    let adcode = city;
    if (!/^\d{6}$/.test(String(city || ''))) {
      try {
        const geo = await geocode(city, '');
        const g = geo.geocodes && geo.geocodes[0];
        adcode = (g && g.adcode) || city;
      } catch (e) {
        adcode = city;
      }
    }
    const data = await amapRequest('/v3/weather/weatherInfo', {
      city: adcode,
      extensions: extensions || 'base'
    });
    return assertOk(data, '天气查询失败');
  }

  // IP 定位
  async function ipLocation(ip) {
    const data = await amapRequest('/v3/ip', { ip: ip || '' });
    return assertOk(data, 'IP定位失败');
  }

  /* ---------------- 静态地图 ---------------- */

  function labelFor(i) {
    if (i < 10) return String(i);
    return String.fromCharCode(65 + (i - 10)); // A, B, C...
  }

  // 多个 POI 标注（最多 10 个，独立标签）
  function buildPoiMarkers(pois, color) {
    color = color || '0x3B82F6';
    return pois.slice(0, 10).map((p, i) => {
      const loc = typeof p === 'string' ? p : p.location;
      return `mid,${color},${labelFor(i)}:${loc}`;
    }).join('|');
  }

  // 折线（自动抽稀，避免 URL 过长）
  function buildPath(polyline, color, weight) {
    color = color || '0x2196F3';
    weight = weight || 6;
    const pts = String(polyline || '').split(';').filter(Boolean);
    if (!pts.length) return '';
    const maxPts = 80;
    let sampled = pts;
    if (pts.length > maxPts) {
      const step = Math.ceil(pts.length / maxPts);
      sampled = pts.filter((_, i) => i % step === 0);
      const last = pts[pts.length - 1];
      if (sampled[sampled.length - 1] !== last) sampled.push(last);
    }
    return `${weight},${color},1,,:${sampled.join(';')}`;
  }

  // 构造静态地图 URL
  function staticMapUrl(opts) {
    const qs = new URLSearchParams();
    qs.set('key', Config.get().amapKey);
    qs.set('size', opts.size || '512*288');
    qs.set('scale', '2');
    if (opts.location) qs.set('location', opts.location);
    if (opts.zoom) qs.set('zoom', String(opts.zoom));
    if (opts.markers) qs.set('markers', opts.markers);
    if (opts.paths) qs.set('paths', opts.paths);
    if (opts.labels) qs.set('labels', opts.labels);
    return `${HOST}/v3/staticmap?${qs.toString()}`;
  }

  window.AMapAPI = {
    geocode,
    placeText,
    placeAround,
    direction,
    weatherInfo,
    ipLocation,
    staticMapUrl,
    buildPoiMarkers,
    buildPath,
    labelFor
  };
})();
