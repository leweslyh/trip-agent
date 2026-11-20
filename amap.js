(function (global) {
  'use strict';

  var BASE = 'https://restapi.amap.com';
  var seq = 0;
  var RETRY_CODES = ['10001', '10002', '10003', '10005', '10019', '10020', '10021', '10022'];

  function keys() {
    if (global.Config && global.Config.amapKeys) return global.Config.amapKeys();
    return [];
  }

  function primaryKey() {
    var list = keys();
    return list.length ? list[0] : '';
  }

  function defaultCity() {
    return (global.Config && global.Config.get('defaultCity')) || '北京';
  }

  /**
   * 高德 Web 服务 API 的 JSONP 请求，主/备 Key 自动切换。
   */
  function jsonp(path, params) {
    var list = keys();
    if (!list.length) return Promise.reject(new Error('尚未配置高德地图密钥，请在设置中填写。'));

    var idx = 0;
    return new Promise(function (resolve, reject) {
      function attempt() {
        var cbName = '__tripmind_cb_' + Date.now() + '_' + (++seq);
        var query = new URLSearchParams();
        Object.keys(params || {}).forEach(function (k) {
          var v = params[k];
          if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
        });
        query.set('key', list[idx]);
        query.set('callback', cbName);

        var script = document.createElement('script');
        var settled = false;
        var timer = setTimeout(function () { fail(new Error('高德接口请求超时，请检查网络。')); }, 15000);

        function cleanup() {
          clearTimeout(timer);
          try { delete global[cbName]; } catch (e) { global[cbName] = undefined; }
          if (script.parentNode) script.parentNode.removeChild(script);
        }

        function fail(err) {
          if (settled) return;
          settled = true;
          cleanup();
          if (idx < list.length - 1) {
            idx++;
            attempt();
          } else {
            reject(err);
          }
        }

        global[cbName] = function (data) {
          if (settled) return;
          settled = true;
          cleanup();
          if (data && RETRY_CODES.indexOf(String(data.infocode)) !== -1 && idx < list.length - 1) {
            idx++;
            attempt();
            return;
          }
          var ok = data && (String(data.status) === '1' || String(data.infocode) === '10000' ||
            (!data.status && !data.infocode && data.data));
          if (ok) {
            resolve(data);
          } else {
            reject(new Error((data && (data.info || data.errmsg)) || '高德接口返回异常。'));
          }
        };

        script.onerror = function () { fail(new Error('高德接口网络错误。')); };
        script.src = BASE + path + '?' + query.toString();
        document.head.appendChild(script);
      }
      attempt();
    });
  }

  function isCoordinate(value) {
    return /^\s*-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\s*$/.test(String(value || ''));
  }

  function clean(value) {
    return String(value || '').replace(/\s/g, '');
  }

  function geocode(address, city) {
    return jsonp('/v3/geocode/geo', { address: address, city: city || '' }).then(function (data) {
      var item = data.geocodes && data.geocodes[0];
      if (!item || !item.location) throw new Error('没有找到“' + address + '”对应的位置。');
      return {
        location: item.location,
        formatted: item.formatted_address || address,
        adcode: item.adcode || '',
        province: item.province || '',
        city: item.city || ''
      };
    });
  }

  function resolveLocation(value, city) {
    if (value && isCoordinate(value)) return Promise.resolve({ location: clean(value) });
    if (!value) return geocode(defaultCity(), '');
    return geocode(String(value), city || '');
  }

  function resolveCity(value) {
    if (!value) return Promise.resolve(defaultCity());
    if (isCoordinate(value)) {
      return jsonp('/v3/geocode/regeo', { location: clean(value) }).then(function (data) {
        var c = data.regeocode && data.regeocode.addressComponent;
        return (c && (c.city || c.province)) || defaultCity();
      }).catch(function () { return defaultCity(); });
    }
    return Promise.resolve(String(value));
  }

  function staticMapUrl(opts) {
    opts = opts || {};
    var key = primaryKey();
    if (!key) return '';
    // 静态地图接口要求逗号、分号、竖线保持字面量，不能按常规做 URL 编码。
    var parts = ['key=' + key, 'size=' + (opts.size || '680*300')];
    if (opts.zoom) parts.push('zoom=' + Number(opts.zoom));
    if (opts.center) parts.push('location=' + clean(opts.center));
    if (opts.markers && opts.markers.length) {
      parts.push('markers=' + opts.markers.map(function (m) {
        return ['mid', m.color || '0x6d5efc', m.label || ''].join(',') + ':' + clean(m.location);
      }).join('|'));
    }
    if (opts.paths && opts.paths.length) parts.push('paths=' + opts.paths.join('|'));
    if (opts.scale) parts.push('scale=' + Number(opts.scale));
    return BASE + '/v3/staticmap?' + parts.join('&');
  }

  function markersFromPois(pois) {
    var colors = ['0x6d5efc', '0x38a9ff', '0x25d0c0', '0xff9f43', '0xff6b7a'];
    var labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return pois.slice(0, 10).map(function (p, i) {
      return { location: clean(p.location), label: labels[i] || '', color: colors[i % colors.length] };
    });
  }

  function poiBrief(p) {
    return {
      id: p.id || '',
      name: p.name || '',
      address: p.address || '',
      location: p.location || '',
      distance: p.distance === undefined ? '' : p.distance,
      category: p.typename || p.type || '',
      tel: p.tel || ''
    };
  }

  /** 关键字搜索 */
  function searchPlace(keywords, city) {
    if (!keywords) return Promise.reject(new Error('请提供要搜索的关键词。'));
    return jsonp('/v3/place/text', {
      keywords: keywords,
      city: city || defaultCity(),
      offset: 12,
      page: 1,
      extensions: 'base'
    }).then(function (data) {
      var pois = (data.pois || []).map(poiBrief);
      var center = pois.length ? clean(pois[0].location) : '';
      return {
        type: 'place',
        keywords: keywords,
        city: city || defaultCity(),
        count: Number(data.count || pois.length),
        pois: pois,
        mapUrl: pois.length ? staticMapUrl({ center: center, markers: markersFromPois(pois), zoom: 13 }) : ''
      };
    });
  }

  /** 周边搜索 */
  function searchNearby(keywords, location, radius, city) {
    return resolveLocation(location, city).then(function (loc) {
      return jsonp('/v3/place/around', {
        location: loc.location,
        keywords: keywords || '',
        city: city || '',
        radius: radius || 3000,
        offset: 12,
        page: 1,
        extensions: 'base',
        sortrule: 'distance'
      }).then(function (data) {
        var pois = (data.pois || []).map(poiBrief);
        return {
          type: 'nearby',
          keywords: keywords || '周边',
          center: loc.location,
          centerName: loc.formatted || String(location),
          radius: Number(radius || 3000),
          count: Number(data.count || pois.length),
          pois: pois,
          mapUrl: staticMapUrl({ center: loc.location, markers: markersFromPois(pois), zoom: 14 })
        };
      });
    });
  }

  function collectPolyline(steps) {
    if (!steps || !steps.length) return '';
    var pts = [];
    steps.forEach(function (s) {
      if (s.polyline) pts.push(s.polyline);
    });
    var points = pts.join(';').replace(/\s/g, '').replace(/;+$/, '').split(';').filter(Boolean);
    return points.slice(0, 120).join(';');
  }

  function fmtDuration(seconds) {
    var n = Number(seconds || 0);
    if (!n) return '—';
    if (n < 60) return n + ' 分钟';
    var h = Math.floor(n / 3600);
    var m = Math.round((n % 3600) / 60);
    return h ? h + ' 小时 ' + (m ? m + ' 分钟' : '') : m + ' 分钟';
  }

  function fmtDistance(meters) {
    var n = Number(meters || 0);
    if (!n) return '—';
    return n >= 1000 ? (n / 1000).toFixed(1) + ' 公里' : Math.round(n) + ' 米';
  }

  function routeMapUrl(origin, destination, polyline, zoom) {
    return staticMapUrl({
      center: '',
      zoom: zoom || 12,
      markers: [
        { location: origin, label: '起', color: '0x35d39a' },
        { location: destination, label: '终', color: '0xff6b7a' }
      ],
      paths: polyline ? ['5,0x38a9ff,1,,:' + polyline] : []
    });
  }

  /** 路径规划 */
  function planRoute(origin, destination, mode, city) {
    mode = mode || 'driving';
    return Promise.all([
      resolveLocation(origin, city),
      resolveLocation(destination, city),
      resolveCity(city || '')
    ]).then(function (r) {
      var o = clean(r[0].location);
      var d = clean(r[1].location);
      var c = r[2];
      var path = '/v3/direction/transit/integrated';
      var params = { origin: o, destination: d, city: c };

      if (mode === 'walking') {
        path = '/v3/direction/walking';
        params = { origin: o, destination: d };
      } else if (mode === 'riding') {
        path = '/v4/direction/bicycling';
        params = { origin: o, destination: d };
      } else if (mode === 'transit') {
        params = { origin: o, destination: d, city: c, cityd: c };
      } else {
        path = '/v3/direction/driving';
        params = { origin: o, destination: d };
      }

      return jsonp(path, params).then(function (data) {
        var plans = [];
        var polyline = '';

        if (mode === 'transit') {
          var transits = (data.route && data.route.transits) || [];
          plans = transits.slice(0, 3).map(function (t, i) {
            var lines = [];
            (t.segments || []).forEach(function (seg) {
              var bus = seg.bus && seg.bus.buslines;
              if (bus && bus.length) {
                bus.forEach(function (b) { lines.push(b.name || b.type || '公交'); });
              } else if (seg.walking && seg.walking.distance) {
                lines.push('步行 ' + fmtDistance(seg.walking.distance));
              }
            });
            return {
              index: i + 1,
              distance: fmtDistance(t.distance),
              duration: fmtDuration(t.duration),
              cost: t.cost ? '¥' + t.cost : '—',
              summary: lines.join(' → ') || '公交换乘方案',
              steps: lines
            };
          });
        } else {
          var paths = mode === 'riding'
            ? ((data.data && data.data.paths) || [])
            : ((data.route && data.route.paths) || []);
          plans = paths.slice(0, 3).map(function (p, i) {
            var steps = (p.steps || []).map(function (s) { return s.instruction || s.road || '继续前行'; });
            return {
              index: i + 1,
              distance: fmtDistance(p.distance),
              duration: fmtDuration(p.duration),
              cost: mode === 'driving' ? (p.taxi_cost ? '约 ¥' + p.taxi_cost : '—') : '—',
              summary: steps.slice(0, 2).join('；') || '沿推荐道路行驶',
              steps: steps
            };
          });
          if (paths.length) polyline = collectPolyline(paths[0].steps);
        }

        if (!plans.length) throw new Error('没有找到可行的路线，请检查起点和终点。');

        var modeName = { driving: '驾车', walking: '步行', transit: '公交/地铁', riding: '骑行' }[mode] || '驾车';
        return {
          type: 'route',
          mode: modeName,
          modeKey: mode,
          originName: r[0].formatted || String(origin),
          destinationName: r[1].formatted || String(destination),
          origin: o,
          destination: d,
          plans: plans,
          mapUrl: routeMapUrl(o, d, polyline, mode === 'walking' || mode === 'riding' ? 15 : 12)
        };
      });
    });
  }

  /** 天气查询 */
  function getWeather(city) {
    return resolveCity(city || '').then(function (c) {
      return jsonp('/v3/weather/weatherInfo', { city: c, extensions: 'all' }).then(function (data) {
        var live = (data.lives || [])[0] || {};
        var forecast = (data.forecasts || [])[0] || {};
        var days = (forecast.casts || []).map(function (f) {
          return {
            date: f.date || '',
            weekday: f.weekday || '',
            dayWeather: f.dayweather || '',
            nightWeather: f.nightweather || '',
            dayTemp: f.daytemp || '',
            nightTemp: f.nighttemp || '',
            dayWind: f.daywind || '',
            nightWind: f.nightwind || '',
            dayPower: f.daypower || ''
          };
        });
        return {
          type: 'weather',
          city: live.city || forecast.city || c,
          province: live.province || forecast.province || '',
          weather: live.weather || '',
          temperature: live.temperature || '',
          winddirection: live.winddirection || '',
          windpower: live.windpower || '',
          humidity: live.humidity || '',
          reporttime: live.reporttime || '',
          days: days
        };
      });
    });
  }

  /** IP 定位 */
  function getIpLocation(ip) {
    return jsonp('/v3/ip', { ip: ip || '' }).then(function (data) {
      var province = (data.province || []);
      var city = (data.city || []);
      var adcode = (data.adcode || []);
      if (Array.isArray(province)) province = province.join('');
      if (Array.isArray(city)) city = city.join('');
      if (Array.isArray(adcode)) adcode = adcode.join('');
      return {
        type: 'ip',
        ip: ip || '',
        province: province || '未知',
        city: city || '未知',
        adcode: adcode || '',
        rectangle: data.rectangle || '',
        located: !!(province || city)
      };
    });
  }

  /** 静态地图（返回图片 URL，供 <img> 直接加载，无跨域限制） */
  function showStaticMap(place, markers, zoom) {
    return resolveLocation(place || defaultCity(), '').then(function (loc) {
      var tasks = (markers || []).slice(0, 10).map(function (m) {
        var value = m && m.location;
        if (!value) return Promise.resolve('');
        if (isCoordinate(value)) return Promise.resolve(clean(value));
        return geocode(String(value), '').then(function (g) { return g.location; }).catch(function () { return ''; });
      });

      return Promise.all(tasks).then(function (coords) {
        var list = [];
        coords.forEach(function (c, i) {
          if (!c) return;
          list.push({
            location: c,
            label: (markers[i] && markers[i].label) || String.fromCharCode(65 + i),
            color: (markers[i] && markers[i].color) || '0x6d5efc'
          });
        });
        if (!list.length) list.push({ location: loc.location, label: '中', color: '0x6d5efc' });
        return {
          type: 'staticmap',
          title: loc.formatted || String(place || defaultCity()),
          center: loc.location,
          zoom: zoom || 14,
          markers: list,
          mapUrl: staticMapUrl({ center: loc.location, markers: list, zoom: zoom || 14, size: '680*320' })
        };
      });
    });
  }

  /** 连通性测试 */
  function test() {
    return jsonp('/v3/weather/weatherInfo', { city: '110000', extensions: 'base' }).then(function (data) {
      return { ok: String(data.status) === '1', message: String(data.status) === '1' ? '高德接口正常' : '高德接口异常' };
    });
  }

  global.Amap = {
    jsonp: jsonp,
    geocode: geocode,
    resolveLocation: resolveLocation,
    staticMapUrl: staticMapUrl,
    searchPlace: searchPlace,
    searchNearby: searchNearby,
    planRoute: planRoute,
    getWeather: getWeather,
    getIpLocation: getIpLocation,
    showStaticMap: showStaticMap,
    test: test,
    fmtDistance: fmtDistance,
    fmtDuration: fmtDuration
  };
})(window);
