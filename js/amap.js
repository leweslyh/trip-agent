/* 高德 Web 服务 API 封装：请求层 / 工具 / 地理编码 / 搜索
 * 直连失败自动尝试 JSONP，仍失败可走用户配置的跨域代理。
 */
(function (global) {
  'use strict';

  const REST = 'https://restapi.amap.com';
  const LS = { key: 'amap.key', proxy: 'amap.proxy', transport: 'amap.transport', city: 'amap.defaultCity' };

  function getLS(k, d) {
    try { return localStorage.getItem(k) || d || ''; } catch (e) { return d || ''; }
  }
  function setLS(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* ignore */ }
  }

  const cfg = {
    get key() { return getLS(LS.key); },
    set key(v) { setLS(LS.key, (v || '').trim()); },
    get proxy() { return getLS(LS.proxy); },
    set proxy(v) { setLS(LS.proxy, (v || '').trim()); },
    get defaultCity() { return getLS(LS.city); },
    set defaultCity(v) { setLS(LS.city, (v || '').trim()); }
  };

  let transport = getLS(LS.transport, '');

  class AmapError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'AmapError';
      this.info = info || '';
    }
  }

  const HINTS = {
    INVALID_USER_KEY: '高德 Key 无效，请确认填写的是「Web 服务」类型的 Key',
    INVALID_USER_SCODE: 'Key 与安全密钥不匹配，或该 Key 不支持 Web 服务',
    USER_KEY_RECYCLED: '高德 Key 已被回收，请重新创建',
    DAILY_QUERY_OVER_LIMIT: '今日调用量已超出配额',
    ACCESS_TOO_FREQUENT: '请求过于频繁，请稍后再试',
    INSUFFICIENT_PRIVILEGES: '该 Key 无此接口权限，请在高德控制台开通',
    SERVICE_NOT_AVAILABLE: '高德服务暂不可用',
    INVALID_PARAMS: '请求参数不合法'
  };

  function describe(data) {
    return HINTS[String(data.info || '')] || data.info || '高德接口返回异常';
  }

  function buildUrl(path, params) {
    const p = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      p.set(k, Array.isArray(v) ? v.join('|') : String(v));
    });
    p.set('key', cfg.key);
    p.set('output', 'json');
    return REST + path + '?' + p.toString();
  }

  /* ---------- 传输层 ---------- */

  function fetchJson(url, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeout || 9000);
    return fetch(url, { signal: ctrl.signal, mode: 'cors' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') throw new Error('返回内容无法解析');
        return data;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      const cb = '__amap_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      let done = false;
      const timer = setTimeout(function () { finish(new Error('JSONP 超时')); }, timeout || 9000);

      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        script.onerror = script.onload = null;
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        err ? reject(err) : resolve(data);
      }

      global[cb] = function (data) { finish(null, data); };
      script.onerror = function () { finish(new Error('JSONP 加载失败')); };
      script.src = url + '&callback=' + cb;
      document.head.appendChild(script);
    });
  }

  function proxyUrl(url) {
    const p = cfg.proxy;
    if (!p) return '';
    return p.indexOf('{url}') >= 0 ? p.replace('{url}', encodeURIComponent(url)) : p + encodeURIComponent(url);
  }

  const RUNNER = {
    fetch: function (u) { return fetchJson(u, 9000); },
    jsonp: function (u) { return jsonp(u, 6000); },
    proxy: function (u) { return fetchJson(proxyUrl(u), 16000); }
  };

  function transportOrder() {
    const all = ['fetch', 'jsonp'];
    if (cfg.proxy) all.push('proxy');
    if (transport && all.indexOf(transport) > 0) {
      all.splice(all.indexOf(transport), 1);
      all.unshift(transport);
    }
    return all;
  }

  async function call(path, params) {
    if (!cfg.key) throw new AmapError('请先在「设置」中填写高德 Web 服务 Key');
    const url = buildUrl(path, params);
    let lastErr = null;

    for (const name of transportOrder()) {
      if (name === 'proxy' && !cfg.proxy) continue;
      try {
        const data = await RUNNER[name](url);
        if (data && data.errcode !== undefined && String(data.errcode) !== '0') {
          throw new AmapError(data.errmsg || '高德接口返回异常');
        }
        if (data && data.status !== undefined && String(data.status) !== '1') {
          throw new AmapError(describe(data), data.info);
        }
        if (!data || (data.status === undefined && data.errcode === undefined)) throw new Error('返回结构异常');
        transport = name;
        setLS(LS.transport, name);
        return data;
      } catch (err) {
        if (err instanceof AmapError) throw err;
        lastErr = err;
      }
    }

    const tip = cfg.proxy
      ? '网络或跨域请求失败，请检查代理地址。'
      : '浏览器跨域请求被拦截：可在「设置」中填写跨域代理前缀后重试。';
    throw new AmapError(tip + (lastErr ? '（' + lastErr.message + '）' : ''));
  }

  /* ---------- 工具 ---------- */

  const LATLNG_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

  function parseLocation(loc) {
    if (!loc) return null;
    if (typeof loc === 'object' && loc.lng !== undefined) return { lng: Number(loc.lng), lat: Number(loc.lat) };
    const m = LATLNG_RE.exec(String(loc));
    if (!m) return null;
    const lng = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    if (!isFinite(lng) || !isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    return { lng: lng, lat: lat };
  }

  function toLocString(loc) {
    const p = parseLocation(loc);
    return p ? p.lng.toFixed(6) + ',' + p.lat.toFixed(6) : '';
  }

  function isLatLng(v) { return !!parseLocation(v); }

  function formatDistance(meters) {
    const m = Number(meters) || 0;
    if (m < 1000) return Math.round(m) + ' 米';
    if (m < 100000) return (m / 1000).toFixed(1) + ' 公里';
    return Math.round(m / 1000) + ' 公里';
  }

  function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    if (s < 60) return Math.round(s) + ' 秒';
    const min = Math.round(s / 60);
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
  }

  function simplify(points, max) {
    const limit = max || 90;
    if (!Array.isArray(points) || points.length <= limit) return points || [];
    const step = Math.ceil(points.length / limit);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    const last = points[points.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }

  function normalizePoi(p) {
    const loc = parseLocation(p.location);
    return {
      id: p.id || '',
      name: p.name || '未命名地点',
      type: (p.type || '').split(';').slice(-1)[0] || '',
      address: typeof p.address === 'string' ? p.address : '',
      location: loc ? loc.lng.toFixed(6) + ',' + loc.lat.toFixed(6) : '',
      tel: typeof p.tel === 'string' ? p.tel : '',
      district: p.adname || '',
      distance: p.distance ? Math.round(Number(p.distance)) : null,
      rating: (p.biz_ext && p.biz_ext.rating) || '',
      cost: (p.biz_ext && p.biz_ext.cost) || '',
      lng: loc ? loc.lng : null,
      lat: loc ? loc.lat : null
    };
  }

  /* ---------- 地理编码 ---------- */

  async function geocode(address, city) {
    const data = await call('/v3/geocode/geo', { address: address, city: city || cfg.defaultCity });
    const g = (data.geocodes || [])[0];
    if (!g) throw new AmapError('没有找到「' + address + '」的坐标，请补充城市或换个说法');
    const loc = parseLocation(g.location);
    return {
      formatted: g.formatted_address || address,
      location: loc.lng.toFixed(6) + ',' + loc.lat.toFixed(6),
      lng: loc.lng,
      lat: loc.lat,
      level: g.level || '',
      adcode: g.adcode || '',
      province: g.province || '',
      city: typeof g.city === 'string' ? g.city : (g.province || ''),
      district: typeof g.district === 'string' ? g.district : ''
    };
  }

  async function regeo(location) {
    const data = await call('/v3/geocode/regeo', {
      location: toLocString(location), extensions: 'base', radius: 1000
    });
    const r = data.regeocode || {};
    const c = r.addressComponent || {};
    return {
      formatted: typeof r.formatted_address === 'string' ? r.formatted_address : '',
      province: c.province || '',
      city: typeof c.city === 'string' ? c.city : (c.province || ''),
      district: c.district || '',
      township: c.township || '',
      adcode: c.adcode || '',
      citycode: c.citycode || ''
    };
  }

  async function resolvePoint(input, city) {
    if (isLatLng(input)) {
      const p = parseLocation(input);
      return { location: toLocString(p), lng: p.lng, lat: p.lat, name: String(input), resolved: false };
    }
    const g = await geocode(String(input || ''), city);
    return { location: g.location, lng: g.lng, lat: g.lat, name: g.formatted, resolved: true, geocode: g };
  }

  /* ---------- 搜索 ---------- */

  async function searchKeywords(keywords, options) {
    const opt = options || {};
    if (!keywords) throw new AmapError('请提供搜索关键词');
    const data = await call('/v3/place/text', {
      keywords: keywords,
      types: opt.types || '',
      city: opt.city || cfg.defaultCity,
      citylimit: opt.citylimit === undefined ? 'false' : String(!!opt.citylimit),
      children: 1,
      offset: Math.min(Math.max(Number(opt.pageSize) || 10, 1), 25),
      page: Math.max(Number(opt.page) || 1, 1),
      extensions: 'all'
    });
    const pois = (data.pois || []).map(normalizePoi).filter(function (p) { return p.location; });
    return {
      keyword: keywords,
      count: Number(data.count) || pois.length,
      city: opt.city || cfg.defaultCity || '',
      pois: pois
    };
  }

  async function searchAround(keywords, options) {
    const opt = options || {};
    const center = await resolvePoint(opt.location, opt.city);
    const radius = Math.min(Math.max(Number(opt.radius) || 2000, 100), 50000);
    const data = await call('/v3/place/around', {
      location: center.location,
      keywords: keywords || '',
      types: opt.types || '',
      radius: radius,
      sortrule: opt.sortrule || 'distance',
      offset: Math.min(Math.max(Number(opt.pageSize) || 10, 1), 25),
      page: Math.max(Number(opt.page) || 1, 1),
      extensions: 'all'
    });
    const pois = (data.pois || []).map(normalizePoi).filter(function (p) { return p.location; });
    return { center: center, radius: radius, keyword: keywords || '全部类型', count: pois.length, pois: pois };
  }

  global.Amap = {
    cfg: cfg,
    AmapError: AmapError,
    call: call,
    parseLocation: parseLocation,
    toLocString: toLocString,
    isLatLng: isLatLng,
    formatDistance: formatDistance,
    formatDuration: formatDuration,
    simplify: simplify,
    geocode: geocode,
    regeo: regeo,
    resolvePoint: resolvePoint,
    searchKeywords: searchKeywords,
    searchAround: searchAround
  };
})(window);
