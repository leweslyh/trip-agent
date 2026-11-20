/* 高德能力扩展：路径规划 / 天气 / IP 定位 / 静态地图 */
(function (global) {
  'use strict';

  const A = global.Amap;
  if (!A) return;

  const { call, parseLocation, toLocString, resolvePoint, regeo, geocode, formatDistance } = A;
  const AmapError = A.AmapError;

  function stepsOf(list) {
    return (list || []).map(function (s) {
      return {
        instruction: s.instruction || s.road || '继续前行',
        road: s.road || '',
        distance: Number(s.distance) || 0,
        duration: Number(s.duration) || 0,
        polyline: s.polyline || ''
      };
    });
  }

  function polysOf(steps) {
    return (steps || []).map(function (s) { return s.polyline; }).filter(Boolean);
  }

  function segmentText(seg) {
    const out = [];
    if (seg.walking && Number(seg.walking.distance) > 0) {
      const first = (seg.walking.steps || [])[0];
      out.push('步行 ' + formatDistance(seg.walking.distance) + (first && first.instruction ? '（' + first.instruction + '）' : ''));
    }
    if (seg.bus && seg.bus.buslines && seg.bus.buslines.length) {
      const line = seg.bus.buslines[0];
      out.push('乘坐 ' + (line.name || '公交') + '：' +
        ((line.departure_stop || {}).name || '') + ' 上车 → ' +
        ((line.arrival_stop || {}).name || '') + ' 下车' +
        (line.via_num ? '（' + line.via_num + ' 站）' : ''));
    }
    if (seg.railway && seg.railway.name) {
      out.push('乘坐 ' + seg.railway.name + '：' +
        ((seg.railway.departure_stop || {}).name || '') + ' → ' +
        ((seg.railway.arrival_stop || {}).name || ''));
    }
    if (seg.taxi && Number(seg.taxi.distance) > 0) out.push('打车 ' + formatDistance(seg.taxi.distance));
    if (!out.length) out.push('换乘 ' + formatDistance(seg.distance || 0));
    return out;
  }

  const MODE_NAME = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '公交' };
  const MODE_ALIAS = {
    驾车: 'driving', 开车: 'driving', 打车: 'driving', 自驾: 'driving',
    步行: 'walking', 走路: 'walking',
    骑行: 'bicycling', 骑车: 'bicycling', 自行车: 'bicycling',
    公交: 'transit', 地铁: 'transit', 公共交通: 'transit'
  };

  async function planRoute(mode, options) {
    const opt = options || {};
    const key = String(mode || 'driving').trim();
    const m = MODE_NAME[key] ? key : (MODE_ALIAS[key] || 'driving');
    const origin = await resolvePoint(opt.origin, opt.city);
    const destination = await resolvePoint(opt.destination, opt.city);

    if (m === 'driving' || m === 'walking') {
      const data = m === 'driving'
        ? await call('/v3/direction/driving', {
            origin: origin.location, destination: destination.location,
            strategy: 0, extensions: 'all', ferry: 1
          })
        : await call('/v3/direction/walking', {
            origin: origin.location, destination: destination.location
          });
      const path = ((data.route || {}).paths || [])[0];
      if (!path) throw new AmapError('没有规划出' + MODE_NAME[m] + '路线');
      const steps = stepsOf(path.steps);
      return {
        mode: m,
        modeName: MODE_NAME[m],
        origin: origin,
        destination: destination,
        distance: Number(path.distance) || 0,
        duration: Number(path.duration) || 0,
        toll: m === 'driving' ? Number(path.tolls) || 0 : 0,
        taxiCost: m === 'driving' ? Number((data.route || {}).taxi_cost) || 0 : 0,
        trafficLights: m === 'driving' ? Number(path.traffic_lights) || 0 : 0,
        steps: steps,
        polylines: polysOf(steps)
      };
    }

    if (m === 'bicycling') {
      const data = await call('/v4/direction/bicycling', {
        origin: origin.location, destination: destination.location
      });
      const path = (((data.data || {}).paths) || [])[0];
      if (!path) throw new AmapError('没有规划出骑行路线');
      const steps = stepsOf(path.steps);
      return {
        mode: m, modeName: MODE_NAME[m], origin: origin, destination: destination,
        distance: Number(path.distance) || 0,
        duration: Number(path.duration) || 0,
        steps: steps,
        polylines: polysOf(steps)
      };
    }

    let city = opt.city || '';
    if (!city) {
      const r = await regeo(origin.location);
      city = r.city || r.province || A.cfg.defaultCity;
    }
    const data = await call('/v3/direction/transit/integrated', {
      origin: origin.location, destination: destination.location,
      city: city, cityd: opt.cityd || '', strategy: 0, extensions: 'all'
    });
    const transits = ((data.route || {}).transits) || [];
    if (!transits.length) throw new AmapError('没有规划出公交方案，可能距离过远或城市信息不正确');
    const plans = transits.slice(0, 3).map(function (t, i) {
      return {
        index: i + 1,
        distance: Number(t.distance) || 0,
        duration: Number(t.duration) || 0,
        cost: Number(t.cost) || 0,
        walking: Number(t.walking_distance) || 0,
        lines: (t.segments || []).map(function (seg) {
          return (seg.bus && seg.bus.buslines && seg.bus.buslines[0] && seg.bus.buslines[0].name) ||
            (seg.railway && seg.railway.name) || '';
        }).filter(Boolean),
        segments: (t.segments || []).map(function (seg) { return segmentText(seg); })
      };
    });
    const best = plans[0];
    return {
      mode: 'transit', modeName: MODE_NAME.transit, city: city,
      origin: origin, destination: destination,
      distance: best.distance, duration: best.duration, cost: best.cost,
      plans: plans, polylines: []
    };
  }

  // base 返回实况，all 返回预报，两次请求合并
  function fetchWeatherRaw(target) {
    function safe(ext) {
      return call('/v3/weather/weatherInfo', { city: target, extensions: ext })
        .catch(function (e) { return { __err: e }; });
    }
    return Promise.all([safe('base'), safe('all')]).then(function (res) {
      const base = res[0] || {};
      const fc = res[1] || {};
      return {
        lives: base.lives || [],
        forecasts: fc.forecasts || [],
        err: base.__err || fc.__err || null
      };
    });
  }

  async function weather(city) {
    let target = city || A.cfg.defaultCity;
    if (!target) throw new AmapError('请提供城市名称或 6 位 adcode');

    let data = await fetchWeatherRaw(target);
    if (!data.lives.length && !data.forecasts.length) {
      if (/^\d{6}$/.test(String(target))) throw data.err || new AmapError('没有查询到该地区的天气数据');
      const g = await geocode(String(target), '');
      data = await fetchWeatherRaw(g.adcode);
      target = g.city || target;
      if (!data.lives.length && !data.forecasts.length) throw data.err || new AmapError('没有查询到该地区的天气数据');
    }

    const live = (data.lives || [])[0] || null;
    const forecast = (data.forecasts || [])[0] || null;
    return {
      query: target,
      city: (live && live.city) || (forecast && forecast.city) || String(target),
      province: (live && live.province) || (forecast && forecast.province) || '',
      adcode: (live && live.adcode) || (forecast && forecast.adcode) || '',
      reportTime: (live && live.reporttime) || (forecast && forecast.reporttime) || '',
      live: live ? {
        weather: live.weather, temperature: live.temperature,
        wind: (live.winddirection || '') + '风 ' + (live.windpower || ''),
        humidity: live.humidity
      } : null,
      casts: ((forecast && forecast.casts) || []).map(function (c) {
        return {
          date: c.date, week: c.week,
          day: c.dayweather, night: c.nightweather,
          dayTemp: c.daytemp, nightTemp: c.nighttemp,
          wind: (c.daywind || '') + '风 ' + (c.daypower || '')
        };
      })
    };
  }

  async function ipLocate(ip) {
    const data = await call('/v3/ip', { ip: ip || '' });
    let center = null;
    if (data.rectangle) {
      const seg = String(data.rectangle).split(';');
      if (seg.length === 2) {
        const a = parseLocation(seg[0]);
        const b = parseLocation(seg[1]);
        if (a && b) center = { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 };
      }
    }
    const result = {
      province: data.province || '',
      city: data.city || '',
      adcode: data.adcode || '',
      rectangle: data.rectangle || '',
      center: center ? center.lng.toFixed(6) + ',' + center.lat.toFixed(6) : '',
      lng: center ? center.lng : null,
      lat: center ? center.lat : null,
      district: '',
      address: ''
    };
    if (center) {
      try {
        const r = await regeo(result.center);
        result.address = r.formatted;
        result.district = r.district;
        result.adcode = r.adcode || result.adcode;
        result.city = result.city || r.city;
      } catch (e) { /* 逆地理失败不影响定位 */ }
    }
    if (!result.city && !result.province) throw new AmapError('无法根据当前 IP 识别城市');
    return result;
  }

  /* ---------- 静态地图 ---------- */

  function buildMarkers(points) {
    if (!points || !points.length) return '';
    const colors = ['0x3155f5', '0x12b8a6', '0xe04057'];
    return points.slice(0, 4).map(function (pt, i) {
      const p = parseLocation(pt.location || pt);
      if (!p) return '';
      const color = pt.color || colors[i % colors.length];
      const label = String(pt.label || i + 1).charAt(0).toUpperCase();
      return 'mid,' + color + ',' + label + ':' + p.lng.toFixed(6) + ',' + p.lat.toFixed(6);
    }).filter(Boolean).join('|');
  }

  function buildPath(points, color) {
    const list = A.simplify(points, 85);
    if (!list || list.length < 2) return '';
    // 格式：粗细,颜色,透明度,填充色,填充透明度,线型:坐标序列
    return '6,' + (color || '0x3155f5') + ',0.9,,:' + list.join(';');
  }

  function estimateZoom(points) {
    const parsed = (points || []).map(parseLocation).filter(Boolean);
    if (parsed.length < 2) return 14;
    let minLng = 999, maxLng = -999, minLat = 999, maxLat = -999;
    parsed.forEach(function (p) {
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    });
    const span = Math.max(maxLng - minLng, maxLat - minLat);
    if (span < 0.004) return 15;
    if (span < 0.012) return 14;
    if (span < 0.035) return 12;
    if (span < 0.09) return 11;
    if (span < 0.3) return 10;
    if (span < 0.8) return 9;
    return 7;
  }

  /**
   * 生成高德静态地图 URL
   * @param {{center?:string, zoom?:number, points?:Array, path?:Array<string>,
   *          size?:string, scale?:number, color?:string}} opt
   */
  function bboxCenter(list) {
    const parsed = (list || []).map(parseLocation).filter(Boolean);
    if (!parsed.length) return null;
    let minLng = 999, maxLng = -999, minLat = 999, maxLat = -999;
    parsed.forEach(function (p) {
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    });
    return { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 };
  }

  function staticMapUrl(opt) {
    const o = opt || {};
    const path = Array.isArray(o.path) && o.path.length >= 2 ? o.path : [];
    const raw = path.concat((o.points || []).map(function (p) { return p.location || p; }));
    const c = parseLocation(o.center) || bboxCenter(raw);
    if (!c) return '';

    const params = new URLSearchParams();
    params.set('location', c.lng.toFixed(6) + ',' + c.lat.toFixed(6));
    params.set('zoom', String(o.zoom || estimateZoom(raw)));
    params.set('size', o.size || '750*460');
    params.set('scale', String(o.scale || 2));

    const markers = buildMarkers(o.points);
    if (markers) params.set('markers', markers);
    if (path.length) {
      const p = buildPath(path, o.color);
      if (p) params.set('paths', p);
    }
    params.set('key', A.cfg.key);
    return 'https://restapi.amap.com/v3/staticmap?' + params.toString();
  }

  function amapLink(opt) {
    const o = opt || {};
    const first = (o.points && o.points[0]) || {};
    const loc = parseLocation(first.location || first || o.center);
    if (!loc) return '';
    const name = encodeURIComponent(first.name || o.title || '目标位置');
    return 'https://uri.amap.com/marker?position=' + loc.lng + ',' + loc.lat +
      '&name=' + name + '&src=travel-assistant&coordinate=gaode&callnative=0';
  }

  Object.assign(A, {
    planRoute: planRoute,
    weather: weather,
    ipLocate: ipLocate,
    staticMapUrl: staticMapUrl,
    amapLink: amapLink,
    estimateZoom: estimateZoom
  });
})(window);
