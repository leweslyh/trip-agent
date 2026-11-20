/**
 * amap.js —— 高德开放平台能力封装（Web 服务 REST + JS API 2.0）
 *
 * 两种 Key / 两种模式：
 *   1. 「Web 服务」Key（restapi.amap.com，支持 CORS）
 *      → IP 定位、天气、地理编码、POI 搜索、静态地图；不需要安全密钥，不需要交互地图。
 *   2. 「Web 端（JS API）」Key（webapi.amap.com）
 *      → 可拖拽交互地图、覆盖物、路径规划；需要配合安全密钥 securityJsCode。
 *
 * 因此：只配 Web 服务 Key 时，本模块会自动进入「Web 服务模式」（webMode），
 * 定位/天气/搜索照常可用，定位结果用静态地图图片展示。
 */
(function (global) {
  'use strict';

  var state = {
    map: null,
    loading: null,
    mapReady: false,
    webMode: false,
    jsError: '',
    city: '',
    citycode: '',
    cityCenter: null,
    currentLocation: null,
    overlays: [],
    infoWindow: null,
    locDot: null,
    ipPromise: null
  };

  var CORE_PLUGINS = [
    'AMap.PlaceSearch',
    'AMap.Driving',
    'AMap.Walking',
    'AMap.Riding',
    'AMap.Transfer',
    'AMap.Weather',
    'AMap.CitySearch',
    'AMap.Geocoder',
    'AMap.Geolocation',
    'AMap.Scale',
    'AMap.ToolBar'
  ];

  function getAMap() {
    if (!global.AMap) throw new Error('高德 JS API 尚未加载');
    return global.AMap;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var old = document.querySelector('script[data-amap-loader]');
      if (old) old.parentNode.removeChild(old);
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-amap-loader', '1');
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(new Error('高德 JS API 脚本加载失败，请检查网络或 Key 是否有效'));
      };
      document.head.appendChild(s);
    });
  }

  /** 加载 JS API + 初始化地图（失败时自动降级为 Web 服务模式） */
  function init(keys) {
    var key = keys.amapJsKey;
    if (!key) {
      state.webMode = true;
      return Promise.resolve(null);
    }

    if (state.mapReady) return Promise.resolve(state.map);

    if (!state.loading) {
      state.loading = probeWebServiceKey(key).then(function (isWebKey) {
        if (isWebKey) {
          // restapi 能接受的 Key 属于「Web 服务」类型，无法驱动 JS API 地图
          state.webMode = true;
          state.jsError = '当前高德 Key 为「Web 服务」类型，无法加载交互地图';
          throw new Error(state.jsError);
        }
        return loadMap(keys, key);
      }).catch(function (err) {
        state.loading = null;
        state.webMode = true;
        state.jsError = (err && err.message) || '交互地图不可用';
        throw err;
      });
    }
    return state.loading;
  }

  /** 探测 Key 是否为「Web 服务」类型：restapi 能接受即为 Web 服务 Key */
  function probeWebServiceKey(key) {
    if (!key || typeof fetch !== 'function') return Promise.resolve(false);
    return fetch(REST_HOST + '/v3/ip?key=' + encodeURIComponent(key), {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      return !!(data && String(data.status) === '1');
    }).catch(function () {
      return false;
    });
  }

  /** 真正加载 JS API 并创建地图 */
  function loadMap(keys, key) {
    return new Promise(function (resolve, reject) {
      if (keys.amapSecurity) {
        global._AMapSecurityConfig = { securityJsCode: keys.amapSecurity };
      }
      var src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key) +
        '&plugin=' + CORE_PLUGINS.map(encodeURIComponent).join(',');
      loadScript(src)
        .then(function () {
          var AMap = getAMap();
          return new Promise(function (res) {
            var done = false;
            var finish = function () { if (!done) { done = true; res(); } };
            try { AMap.plugin(CORE_PLUGINS, finish); } catch (e) { finish(); }
            setTimeout(finish, 6000);
          }).then(function () {
            return new Promise(function (res, rej) {
              try {
                state.map = new AMap.Map('map', {
                  viewMode: '2D',
                  zoom: 12,
                  center: [116.397428, 39.90923],
                  mapStyle: 'amap://styles/darkblue',
                  resizeEnable: true,
                  showLabel: true
                });
                state.map.addControl(new AMap.Scale());
                state.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -34), isCustom: false });
                state.map.on('complete', function () {
                  state.mapReady = true;
                  res();
                });
                // 兜底：部分环境不触发 complete
                setTimeout(function () {
                  if (!state.mapReady) { state.mapReady = true; res(); }
                }, 4000);
              } catch (e) {
                rej(e);
              }
            });
          });
        })
        .then(function (v) {
          state.webMode = false;
          state.jsError = '';
          resolve(v);
        })
        .catch(reject);
    });
  }

  /* ==================== 覆盖物管理 ==================== */

  function clearOverlays() {
    if (!state.map) return;
    if (state.infoWindow) state.infoWindow.close();
    state.map.remove(state.overlays);
    state.overlays = [];
    if (state.locDot) {
      state.map.remove(state.locDot);
      state.locDot = null;
    }
  }

  function addOverlay(overlay) {
    if (!state.map) return;
    state.overlays.push(overlay);
    state.map.add(overlay);
  }

  function fitView(extra) {
    if (!state.map) return;
    var list = state.overlays.slice();
    if (extra) list = list.concat(extra);
    if (!list.length) return;
    try {
      state.map.setFitView(list, false, [70, 70, 70, 70], 16);
    } catch (e) { /* ignore */ }
  }

  function pinContent(index) {
    return '<div class="amap-pin"><span>' + index + '</span></div>';
  }

  /** 在地图上渲染 POI 列表 */
  function renderPois(pois, options) {
    if (!state.map) return;
    var AMap = getAMap();
    clearOverlays();
    options = options || {};

    pois.forEach(function (p, i) {
      if (!p.lnglat) return;
      var marker = new AMap.Marker({
        position: p.lnglat,
        content: pinContent(i + 1),
        offset: new AMap.Pixel(-13, -32),
        title: p.name,
        zIndex: 120 + i,
        extData: p
      });
      marker.on('click', function () {
        openInfo(marker.getPosition(), p, i + 1);
      });
      addOverlay(marker);
    });

    if (options.center && options.radius) {
      var circle = new AMap.Circle({
        center: options.center,
        radius: options.radius,
        strokeColor: '#2ee6c5',
        strokeWeight: 1.5,
        strokeOpacity: 0.8,
        fillColor: '#2ee6c5',
        fillOpacity: 0.08
      });
      addOverlay(circle);
      var centerMarker = new AMap.Marker({
        position: options.center,
        content: '<div class="amap-center"></div>',
        offset: new AMap.Pixel(-8, -8),
        zIndex: 200
      });
      addOverlay(centerMarker);
    }

    fitView();
  }

  function openInfo(position, poi, index) {
    if (!state.map || !state.infoWindow) return;
    var html = '<div class="amap-iw">' +
      '<h5>' + (index ? '<i>' + index + '</i>' : '') + Util.escapeHtml(poi.name) + '</h5>' +
      '<p>' + Util.escapeHtml(poi.address || '暂无地址') + '</p>' +
      (poi.tel ? '<p>电话：' + Util.escapeHtml(poi.tel) + '</p>' : '') +
      (poi.distance ? '<p>距离：' + Util.distance(poi.distance) + '</p>' : '') +
      '</div>';
    state.infoWindow.setContent(html);
    state.infoWindow.open(state.map, position);
  }

  /** 绘制折线路径 */
  function drawPath(points, extraMarkers) {
    if (!state.map) return;
    var AMap = getAMap();
    clearOverlays();
    if (points && points.length > 1) {
      var line = new AMap.Polyline({
        path: points,
        strokeColor: '#2ee6c5',
        strokeWeight: 7,
        strokeOpacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
        showDir: true,
        zIndex: 90
      });
      addOverlay(line);
      var casing = new AMap.Polyline({
        path: points,
        strokeColor: '#0b3b3a',
        strokeWeight: 12,
        strokeOpacity: 0.5,
        lineJoin: 'round',
        zIndex: 80
      });
      addOverlay(casing);
    }
    (extraMarkers || []).forEach(function (m) {
      addOverlay(new AMap.Marker({
        position: m.position,
        content: '<div class="amap-flag ' + (m.type === 'end' ? 'end' : 'start') + '">' +
          (m.type === 'end' ? '终' : '起') + '</div>',
        offset: new AMap.Pixel(-14, -14),
        zIndex: 210
      }));
    });
    fitView();
  }

  /* ==================== Web 服务（REST）通用请求 ==================== */

  var REST_HOST = 'https://restapi.amap.com';

  function pickStr(v) {
    return typeof v === 'string' ? v : '';
  }

  /** 用于 REST 的 Key：优先「Web 服务」Key，其次 JS API Key */
  function restKey() {
    var cfg = Store.get();
    return cfg.amapWebKey || cfg.amapJsKey || '';
  }

  /** 任意高德 Key 是否已配置（Web 服务 或 JS API） */
  function hasKey() {
    return !!restKey();
  }

  /**
   * 调用高德 Web 服务接口。
   * restapi.amap.com 返回 Access-Control-Allow-Origin: *，前端可直接 fetch。
   */
  function restGet(path, params) {
    var key = restKey();
    if (!key) return Promise.reject(new Error('未配置高德 Key'));
    var qs = Object.keys(params || {}).filter(function (k) {
      var v = params[k];
      return v !== '' && v !== null && v !== undefined;
    }).map(function (k) {
      return k + '=' + encodeURIComponent(params[k]);
    }).join('&');
    var url = REST_HOST + path + '?key=' + encodeURIComponent(key) + (qs ? '&' + qs : '');
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || String(data.status) !== '1') {
          throw new Error(pickStr(data && data.info) || '高德接口返回异常');
        }
        return data;
      });
  }

  /* ==================== 定位 ==================== */

  /** 高德 rectangle 形如 "116.01,39.66;116.78,40.21"，取中心点 */
  function rectCenter(rect) {
    var parts = String(rect || '').split(';');
    if (parts.length !== 2) return null;
    var a = parts[0].split(',');
    var b = parts[1].split(',');
    var x1 = Number(a[0]), y1 = Number(a[1]), x2 = Number(b[0]), y2 = Number(b[1]);
    if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return null;
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }

  /**
   * REST 版 IP 定位（Web 服务接口）
   * 优点：支持 CORS、无需安全密钥 securityJsCode，前端可直接调用
   */
  function ipByRest() {
    return restGet('/v3/ip', {}).then(function (data) {
      var city = pickStr(data.city) || pickStr(data.province);
      if (!city) throw new Error('IP 定位未返回城市信息');
      return {
        city: city,
        province: pickStr(data.province),
        citycode: pickStr(data.adcode),
        center: rectCenter(data.rectangle),
        source: 'rest'
      };
    });
  }

  /** JS API 版 IP 定位（需要 Key 可用 + 安全密钥配置正确），带超时 */
  function ipByJS() {
    return new Promise(function (resolve, reject) {
      var AMap = getAMap();
      if (!AMap.CitySearch) {
        reject(new Error('AMap.CitySearch 插件未加载'));
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('IP 定位超时')); }
      }, 5000);
      function finish(fn, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(val);
      }
      try {
        new AMap.CitySearch().getLocalCity(function (status, result) {
          if (status === 'complete' && result && result.city) {
            var center = null;
            try {
              if (result.bounds) {
                var c = result.bounds.getCenter();
                center = [c.lng, c.lat];
              }
            } catch (e) { /* ignore */ }
            finish(resolve, {
              city: pickStr(result.city),
              province: pickStr(result.province),
              citycode: pickStr(result.citycode),
              center: center,
              source: 'js'
            });
          } else {
            finish(reject, new Error(pickStr(result && result.info) || 'CitySearch 请求失败'));
          }
        });
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  /** 依次尝试：REST -> JS 插件，并补齐中心点 */
  function runIP() {
    return ipByRest()
      .catch(function (restErr) {
        return ipByJS().catch(function (jsErr) {
          var msg = (restErr && restErr.message) || (jsErr && jsErr.message) || '未知错误';
          throw new Error('IP 定位失败：' + msg);
        });
      })
      .then(function (info) {
        if (info.center) return info;
        return ipByJS().then(function (js) {
          if (js.center) info.center = js.center;
          return info;
        }).catch(function () { return info; });
      })
      .then(function (info) {
        if (info.city) state.city = info.city;
        if (info.citycode) state.citycode = info.citycode;
        if (info.center) state.cityCenter = info.center;
        return info;
      });
  }

  /** 在地图上画一个脉冲点 + 信息窗，直观展示 IP 定位结果 */
  function showLocationDot(info) {
    if (!state.map || !info || !info.center) return;
    var AMap = getAMap();
    if (state.locDot) {
      state.map.remove(state.locDot);
      state.locDot = null;
    }
    state.locDot = new AMap.Marker({
      position: info.center,
      content: '<div class="amap-center"></div>',
      offset: new AMap.Pixel(-8, -8),
      zIndex: 300,
      title: info.city || '当前位置'
    });
    state.map.add(state.locDot);

    var html = '<div class="amap-iw">' +
      '<h5>' + Util.escapeHtml(info.city || '当前位置') + '</h5>' +
      '<p>根据 IP 推断的大致位置' +
      (info.province && info.province !== info.city ? '（' + Util.escapeHtml(info.province) + '）' : '') + '</p>' +
      '<p>坐标 ' + info.center.map(function (n) { return Number(n).toFixed(4); }).join(', ') + '</p>' +
      '</div>';
    if (state.infoWindow) {
      state.infoWindow.setContent(html);
      state.infoWindow.open(state.map, info.center);
    }
    state.map.setZoomAndCenter(11, info.center);
  }

  /** 没有交互地图时（Web 服务 Key 模式），用静态地图图片展示定位结果 */
  function showLocationStatic(info) {
    if (!info || !info.center || !hasKey()) return;
    try {
      var url = staticMapUrl({ lnglat: info.center, zoom: 10, size: '500*400' });
      if (!global.UI) return;
      if (UI.renderWebMap) {
        UI.renderWebMap(url, { city: info.city, name: info.city, lnglat: info.center });
      } else if (UI.renderStatic) {
        UI.renderStatic(url, { name: (info.city || '当前位置') + '（IP 定位）', lnglat: info.center }, 10);
      }
    } catch (e) { /* 图片生成失败不影响定位结果 */ }
  }

  /**
   * IP 定位：按请求 IP 判断所在城市
   * 有交互地图 → 打点 + 信息窗；只有 Web 服务 Key → 用静态地图图片展示
   * @param {{force?:boolean, show?:boolean}} opts
   */
  function locateIP(opts) {
    opts = opts || {};
    if (!state.ipPromise || opts.force) {
      state.ipPromise = runIP().catch(function (err) {
        state.ipPromise = null; // 失败允许重试
        throw err;
      });
    }
    return state.ipPromise.then(function (info) {
      if (opts.show !== false) {
        if (state.mapReady) showLocationDot(info);
        else showLocationStatic(info);
      }
      return info;
    });
  }

  /** 浏览器精确定位（失败则回退 IP 定位） */
  function locatePrecise() {
    var hasGeo = false;
    try { hasGeo = !!(global.AMap && global.AMap.Geolocation); } catch (e) { hasGeo = false; }

    // Web 服务模式：没有 Geolocation 插件，直接用 IP 定位
    if (!hasGeo) {
      return locateIP().then(function (ip) {
        if (!ip.center) {
          return { lnglat: null, name: ip.city || '', city: ip.city || state.city, source: 'ip' };
        }
        state.currentLocation = {
          lnglat: ip.center,
          name: ip.city + '（IP 定位）',
          city: ip.city,
          source: 'ip'
        };
        return state.currentLocation;
      }).catch(function () {
        return { lnglat: null, name: '', city: state.city, source: 'none' };
      });
    }

    return new Promise(function (resolve) {
      var AMap = getAMap();
      var geo = new AMap.Geolocation({
        enableHighAccuracy: true,
        timeout: 6000,
        needAddress: true,
        extensions: 'all'
      });
      geo.getCurrentPosition(function (status, result) {
        if (status === 'complete' && result && result.position) {
          var lnglat = [result.position.lng, result.position.lat];
          var comp = result.addressComponent || {};
          var city = typeof comp.city === 'string' ? comp.city : '';
          if (!city && typeof comp.province === 'string') city = comp.province;
          state.currentLocation = {
            lnglat: lnglat,
            name: result.formattedAddress || '我的位置',
            city: city || state.city
          };
          resolve(state.currentLocation);
        } else {
          locateIP().then(function (ip) {
            if (!ip.center) {
              resolve({ lnglat: null, name: ip.city, city: ip.city, source: 'ip' });
              return;
            }
            state.currentLocation = {
              lnglat: ip.center,
              name: ip.city + '（IP 定位）',
              city: ip.city,
              source: 'ip'
            };
            resolve(state.currentLocation);
          }).catch(function () {
            resolve({ lnglat: null, name: '', city: state.city, source: 'none' });
          });
        }
      });
    });
  }

  function getCurrentLocation() {
    if (state.currentLocation && state.currentLocation.lnglat) {
      return Promise.resolve(state.currentLocation);
    }
    return locatePrecise();
  }

  /* ==================== 地理编码 ==================== */

  /** REST 版地理编码 */
  function geocodeByRest(address, city) {
    return restGet('/v3/geocode/geo', {
      address: address,
      city: city || state.city || ''
    }).then(function (data) {
      var g = (data.geocodes && data.geocodes[0]) || null;
      var ll = g ? Util.parseLngLat(g.location) : null;
      if (!ll) throw new Error('未找到「' + address + '」的位置');
      return {
        lnglat: ll,
        name: pickStr(g.formatted_address) || address,
        city: pickStr(g.city) || city || state.city,
        adcode: pickStr(g.adcode)
      };
    });
  }

  function geocode(address, city) {
    var useJS = false;
    try { useJS = !!(global.AMap && global.AMap.Geocoder); } catch (e) { useJS = false; }
    if (!useJS) return geocodeByRest(address, city);

    return new Promise(function (resolve, reject) {
      var AMap = getAMap();
      var geocoder = new AMap.Geocoder({ city: city || state.city || '', radius: 1000 });
      geocoder.getLocation(address, function (status, result) {
        if (status === 'complete' && result.geocodes && result.geocodes.length) {
          var g = result.geocodes[0];
          resolve({
            lnglat: [g.location.lng, g.location.lat],
            name: g.formattedAddress || address,
            city: g.city || city || state.city,
            adcode: g.adcode
          });
        } else {
          reject(new Error('未找到「' + address + '」的位置'));
        }
      });
    }).catch(function () {
      return geocodeByRest(address, city);
    });
  }

  /** 把任意输入解析为坐标：坐标串 / 地址名 / 当前城市 */
  function resolveLocation(input, city) {
    var coords = Util.parseLngLat(input);
    if (coords) {
      return Promise.resolve({ lnglat: coords, name: input, source: 'coord' });
    }
    var text = String(input || '').trim();
    if (!text || /^(我的位置|当前位置|这里|附近|我附近)$/.test(text)) {
      return getCurrentLocation().then(function (loc) {
        if (loc.lnglat) return loc;
        if (state.cityCenter) {
          return { lnglat: state.cityCenter, name: state.city + '市中心', city: state.city, source: 'ip' };
        }
        return locateIP().then(function (ip) {
          if (!ip.center) throw new Error('无法定位当前位置');
          return { lnglat: ip.center, name: ip.city + '市中心', city: ip.city, source: 'ip' };
        });
      });
    }
    if (text.length > 40) {
      // 过长的自然语言，取前 20 字做地址匹配更容易命中
      text = text.slice(0, 20);
    }
    return geocode(text, city).catch(function () {
      // 地址解析失败再尝试 POI 关键字搜索首个结果
      return searchPlaces({ keyword: text, city: city || state.city, pageSize: 1 })
        .then(function (list) {
          if (!list.length) throw new Error('无法解析位置：' + input);
          return { lnglat: list[0].lnglat, name: list[0].name, city: list[0].cityname, source: 'poi' };
        });
    });
  }

  /* ==================== POI 搜索 ==================== */

  function normalizePoi(p) {
    var loc = p.location || {};
    var addr = p.address || '';
    if (!addr) {
      addr = [p.pname, p.cityname, p.adname].filter(Boolean).join('') + (addr || '');
    }
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      address: addr,
      tel: typeof p.tel === 'string' ? p.tel : '',
      lnglat: [Number(loc.lng), Number(loc.lat)],
      distance: p.distance ? Number(p.distance) : 0,
      cityname: p.cityname || '',
      adname: p.adname || '',
      businessArea: p.businessArea || ''
    };
  }

  function collectPois(result) {
    var list = (result && result.poiList && result.poiList.pois) || [];
    return list.filter(function (p) { return p.location && p.location.lng; }).map(normalizePoi);
  }

  /** REST 结果统一成内部 POI 结构 */
  function toPoiFromRest(p) {
    var ll = Util.parseLngLat(p.location);
    if (!ll) return null;
    return {
      id: pickStr(p.id) || pickStr(p.name),
      name: pickStr(p.name),
      type: pickStr(p.type),
      address: pickStr(p.address) ||
        [pickStr(p.pname), pickStr(p.cityname), pickStr(p.adname)].filter(Boolean).join(''),
      tel: pickStr(p.tel),
      lnglat: ll,
      distance: p.distance ? Number(p.distance) : 0,
      cityname: pickStr(p.cityname),
      adname: pickStr(p.adname),
      businessArea: pickStr(p.businessname)
    };
  }

  /** REST 关键字搜索（Web 服务 Key 可用） */
  function searchPlacesRest(opts) {
    return restGet('/v3/place/text', {
      keywords: opts.keyword || '',
      types: opts.type || '',
      city: opts.city || state.city || '',
      citylimit: opts.cityLimit ? 'true' : '',
      offset: Math.min(opts.pageSize || 10, 25),
      page: opts.pageIndex || opts.page || 1,
      extensions: 'all'
    }).then(function (data) {
      return (data.pois || []).map(toPoiFromRest).filter(Boolean);
    });
  }

  /** REST 周边搜索 */
  function searchNearbyRest(opts) {
    var center = Array.isArray(opts.center) ? opts.center.join(',') : opts.center;
    return restGet('/v3/place/around', {
      location: center,
      keywords: opts.keyword || '',
      types: opts.type || '',
      radius: opts.radius || 1000,
      offset: Math.min(opts.pageSize || 10, 25),
      page: 1,
      extensions: 'all'
    }).then(function (data) {
      return (data.pois || []).map(toPoiFromRest).filter(Boolean);
    });
  }

  /** 关键字搜索 */
  function searchPlaces(opts) {
    var useJS = false;
    try { useJS = !!(global.AMap && global.AMap.PlaceSearch); } catch (e) { useJS = false; }
    if (!useJS) return searchPlacesRest(opts);

    return new Promise(function (resolve, reject) {
      var AMap = getAMap();
      var service = new AMap.PlaceSearch({
        city: opts.city || state.city || '全国',
        citylimit: !!opts.cityLimit,
        pageSize: Math.min(opts.pageSize || 10, 25),
        pageIndex: opts.pageIndex || 1,
        extensions: 'all'
      });
      service.search(opts.keyword, function (status, result) {
        if (status === 'complete') {
          resolve(collectPois(result));
        } else if (status === 'no_data') {
          resolve([]);
        } else {
          reject(new Error((result && result.info) || '搜索失败'));
        }
      });
    }).catch(function () {
      return searchPlacesRest(opts);
    });
  }

  /** 周边搜索 */
  function searchNearby(opts) {
    var useJS = false;
    try { useJS = !!(global.AMap && global.AMap.PlaceSearch); } catch (e) { useJS = false; }
    if (!useJS) return searchNearbyRest(opts);

    return new Promise(function (resolve, reject) {
      var AMap = getAMap();
      var service = new AMap.PlaceSearch({
        pageSize: Math.min(opts.pageSize || 10, 25),
        pageIndex: 1,
        extensions: 'all',
        type: opts.type || ''
      });
      service.searchNearBy(opts.keyword || '', opts.center, opts.radius || 1000, function (status, result) {
        if (status === 'complete') {
          resolve(collectPois(result));
        } else if (status === 'no_data') {
          resolve([]);
        } else {
          reject(new Error((result && result.info) || '周边搜索失败'));
        }
      });
    }).catch(function () {
      return searchNearbyRest(opts);
    });
  }

  /* ==================== 路径规划 ==================== */

  function collectPath(steps) {
    var path = [];
    (steps || []).forEach(function (step) {
      (step.path || []).forEach(function (pt) {
        path.push([pt.lng, pt.lat]);
      });
    });
    return path;
  }

  function collectTransitPath(plan) {
    var path = [];
    (plan.segments || []).forEach(function (seg) {
      var walking = seg.walking && seg.walking.steps;
      if (walking) path = path.concat(collectPath(walking));
      var buslines = seg.transit && seg.transit.bus && seg.transit.bus.buslines;
      if (buslines && buslines[0] && buslines[0].path) {
        buslines[0].path.forEach(function (pt) { path.push([pt.lng, pt.lat]); });
      }
      var railway = seg.transit && seg.transit.railway;
      if (railway && railway.departure_stop && railway.arrival_stop) {
        path.push([railway.departure_stop.location.lng, railway.departure_stop.location.lat]);
        path.push([railway.arrival_stop.location.lng, railway.arrival_stop.location.lat]);
      }
    });
    return path;
  }

  var MODE_TEXT = { driving: '驾车', walking: '步行', riding: '骑行', transit: '公交' };

  /**
   * 路径规划
   * @param {{mode:string, origin:Array, destination:Array, city:string}} opts
   */
  function planRoute(opts) {
    if (!state.mapReady) {
      return Promise.reject(new Error('路径规划依赖交互地图，需要「Web 端（JS API）」Key；当前为 Web 服务模式'));
    }
    return new Promise(function (resolve, reject) {
      var AMap = getAMap();
      var mode = opts.mode || 'driving';
      var origin = opts.origin;
      var destination = opts.destination;

      function done(res) {
        drawPath(res.path, [
          { position: origin, type: 'start' },
          { position: destination, type: 'end' }
        ]);
        resolve(res);
      }

      if (mode === 'walking') {
        var walking = new AMap.Walking({});
        walking.search(origin, destination, function (status, result) {
          if (status !== 'complete' || !result.routes || !result.routes.length) {
            reject(new Error('未找到步行路线'));
            return;
          }
          var r = result.routes[0];
          done({
            mode: mode,
            modeText: MODE_TEXT[mode],
            distance: r.distance,
            time: r.time,
            path: collectPath(r.steps),
            steps: (r.steps || []).map(function (s) { return s.instruction; })
          });
        });
        return;
      }

      if (mode === 'riding') {
        var riding = new AMap.Riding({});
        riding.search(origin, destination, function (status, result) {
          if (status !== 'complete' || !result.routes || !result.routes.length) {
            reject(new Error('未找到骑行路线'));
            return;
          }
          var r = result.routes[0];
          done({
            mode: mode,
            modeText: MODE_TEXT[mode],
            distance: r.distance,
            time: r.time,
            path: collectPath(r.steps),
            steps: (r.steps || []).map(function (s) { return s.instruction; })
          });
        });
        return;
      }

      if (mode === 'transit') {
        var transfer = new AMap.Transfer({
          city: opts.city || state.city,
          cityd: opts.cityd || opts.city || state.city,
          policy: AMap.TransferPolicy ? AMap.TransferPolicy.LEAST_TIME : 0,
          extensions: 'all'
        });
        transfer.search(origin, destination, function (status, result) {
          if (status !== 'complete' || !result.plans || !result.plans.length) {
            reject(new Error('未找到公交方案'));
            return;
          }
          var plan = result.plans[0];
          var steps = [];
          (plan.segments || []).forEach(function (seg) {
            if (seg.walking && seg.walking.steps) {
              seg.walking.steps.forEach(function (s) { if (s.instruction) steps.push(s.instruction); });
            }
            var bus = seg.transit && seg.transit.bus;
            if (bus && bus.buslines && bus.buslines[0]) {
              var line = bus.buslines[0];
              steps.push('乘坐 ' + (line.name || '公交') + '，' +
                (line.departure_stop ? line.departure_stop.name : '') + ' 上车 → ' +
                (line.arrival_stop ? line.arrival_stop.name : '') + ' 下车');
            }
            var rail = seg.transit && seg.transit.railway;
            if (rail) steps.push('乘坐 ' + (rail.name || '铁路') + ' 前往 ' + (rail.arrival_stop ? rail.arrival_stop.name : ''));
          });
          done({
            mode: mode,
            modeText: MODE_TEXT[mode],
            distance: plan.distance,
            time: plan.time,
            cost: plan.cost,
            path: collectTransitPath(plan),
            steps: steps
          });
        });
        return;
      }

      // 默认驾车
      var driving = new AMap.Driving({
        policy: AMap.DrivingPolicy ? AMap.DrivingPolicy.LEAST_TIME : 0,
        extensions: 'all'
      });
      driving.search(origin, destination, function (status, result) {
        if (status !== 'complete' || !result.routes || !result.routes.length) {
          reject(new Error('未找到驾车路线'));
          return;
        }
        var r = result.routes[0];
        done({
          mode: 'driving',
          modeText: MODE_TEXT.driving,
          distance: r.distance,
          time: r.time,
          tolls: r.tolls,
          trafficLights: r.traffic_lights,
          path: collectPath(r.steps),
          steps: (r.steps || []).map(function (s) {
            var text = s.instruction || '';
            if (s.road && text.indexOf(s.road) < 0) text += '（' + s.road + '）';
            return text;
          })
        });
      });
    });
  }

  /* ==================== 天气 ==================== */

  /** REST 版天气（Web 服务 Key 即可，无需交互地图） */
  function weatherByRest(city) {
    var target = city || state.citycode || state.city;
    if (!target) return Promise.reject(new Error('缺少城市名，无法查询天气'));

    // extensions=base 返回实况 lives，extensions=all 才返回预报 forecasts
    return Promise.all([
      restGet('/v3/weather/weatherInfo', { city: target }).catch(function () { return null; }),
      restGet('/v3/weather/weatherInfo', { city: target, extensions: 'all' }).catch(function () { return null; })
    ]).then(function (res) {
      var live = (res[0] && res[0].lives && res[0].lives[0]) || null;
      var fc = (res[1] && res[1].forecasts && res[1].forecasts[0]) || null;
      if (!live && !fc) throw new Error('该城市暂无天气数据');

      var casts = (fc && fc.casts) || [];
      if (!live) {
        // 没有实况数据时，用当天预报补足，保证卡片字段完整
        var c0 = casts[0] || {};
        live = {
          city: pickStr(fc && fc.city),
          province: pickStr(fc && fc.province),
          weather: pickStr(c0.dayweather),
          temperature: pickStr(c0.daytemp),
          winddirection: pickStr(c0.daywind),
          windpower: pickStr(c0.daypower),
          humidity: '',
          report_time: pickStr(fc && fc.reporttime)
        };
      } else {
        live = {
          city: pickStr(live.city),
          province: pickStr(live.province),
          weather: pickStr(live.weather),
          temperature: pickStr(live.temperature),
          winddirection: pickStr(live.winddirection),
          windpower: pickStr(live.windpower),
          humidity: pickStr(live.humidity),
          report_time: pickStr(live.reporttime)
        };
      }
      return { live: live, forecasts: casts };
    });
  }

  function getWeather(city) {
    var target = city || state.city;
    var useJS = false;
    try { useJS = !!(global.AMap && global.AMap.Weather); } catch (e) { useJS = false; }
    if (!useJS) return weatherByRest(target);

    return new Promise(function (resolve, reject) {
      var AMap = getAMap();
      var weather = new AMap.Weather();
      weather.getLive(target, function (err, live) {
        if (err || !live) {
          reject(new Error('天气查询失败' + (err ? '：' + err : '')));
          return;
        }
        weather.getForecast(target, function (err2, forecast) {
          var casts = (forecast && forecast.forecasts && forecast.forecasts[0] && forecast.forecasts[0].casts) || [];
          resolve({ live: live, forecasts: casts });
        });
      });
    }).catch(function () {
      return weatherByRest(target);
    });
  }

  /* ==================== 静态地图 ==================== */

  function staticMapUrl(opts) {
    var key = restKey();
    var lnglat = opts.lnglat;
    var size = opts.size || '500*320';
    var params = [
      'location=' + lnglat[0] + ',' + lnglat[1],
      'zoom=' + (opts.zoom || 14),
      'size=' + size,
      'scale=2',
      'key=' + encodeURIComponent(key)
    ];
    if (opts.markers !== false) {
      var style = 'mid,0x2EE6C5,A';
      params.push('markers=' + encodeURIComponent(style + ':' + lnglat[0] + ',' + lnglat[1]));
    }
    return 'https://restapi.amap.com/v3/staticmap?' + params.join('&');
  }

  /* ==================== 导出 ==================== */
  global.AMapKit = {
    state: state,
    init: init,
    isReady: function () { return state.mapReady; },
    /** 是否处于「仅 Web 服务 Key」模式（无交互地图，走 REST） */
    isWebMode: function () { return !state.mapReady; },
    hasKey: hasKey,
    clearOverlays: clearOverlays,
    renderPois: renderPois,
    drawPath: drawPath,
    locateIP: locateIP,
    locatePrecise: locatePrecise,
    getCurrentLocation: getCurrentLocation,
    geocode: geocode,
    resolveLocation: resolveLocation,
    searchPlaces: searchPlaces,
    searchNearby: searchNearby,
    planRoute: planRoute,
    getWeather: getWeather,
    staticMapUrl: staticMapUrl,
    getCity: function () { return state.city; },
    setCity: function (city, center) {
      if (city) state.city = city;
      if (center) state.cityCenter = center;
    },
    focus: function (lnglat, zoom) {
      if (!state.map || !lnglat) return;
      state.map.setZoomAndCenter(zoom || 15, lnglat);
    },
    getMap: function () { return state.map; }
  };
})(window);
