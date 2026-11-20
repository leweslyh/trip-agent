/**
 * tools.js —— 智能体可调用的高德工具（Function Calling）
 *
 * 每个工具包含：
 *   definition  —— 传给 DeepSeek 的 JSON Schema
 *   label/icon  —— 界面上工具调用轨迹的展示文案
 *   run(args)   —— 实际执行，返回 { ok, brief, data }
 *                  brief 给用户看，data 回传给模型
 */
(function (global) {
  'use strict';

  var TOOLS = [];

  function define(def, label, icon, run) {
    TOOLS.push({ definition: def, label: label, icon: icon, run: run });
  }

  function num(v, def, min, max) {
    var n = Number(v);
    if (!isFinite(n)) n = def;
    return Math.max(min, Math.min(max, n));
  }

  function trimList(pois, limit) {
    return pois.slice(0, limit || 8).map(function (p, i) {
      return {
        no: i + 1,
        name: p.name,
        address: p.address,
        type: (p.type || '').split(';')[0],
        tel: p.tel || '',
        distance: p.distance ? Math.round(p.distance) : null,
        location: p.lnglat[0].toFixed(6) + ',' + p.lnglat[1].toFixed(6)
      };
    });
  }

  /** 只要有任意高德 Key（Web 服务 或 JS API）即可执行 */
  function requireKey() {
    if (!global.AMapKit.hasKey()) {
      throw new Error('请先在右上角「API 设置」中填写高德 Key（Web 服务或 Web 端均可）');
    }
  }

  /** 需要交互地图的功能（覆盖物、路径规划） */
  function requireMap() {
    requireKey();
    if (!global.AMapKit.isReady()) {
      throw new Error('该功能需要交互地图，请补充「Web 端（JS API）」Key 与安全密钥；当前为 Web 服务模式');
    }
  }

  /**
   * Web 服务模式（无交互地图）下用静态地图展示结果。
   * @returns {boolean} true 表示已用静态图展示
   */
  function showStaticFallback(lnglat, name, zoom) {
    if (global.AMapKit.isReady() || !lnglat) return false;
    var z = zoom || 14;
    var url = AMapKit.staticMapUrl({ lnglat: lnglat, zoom: z, size: '500*400' });
    if (UI.renderWebMap) UI.renderWebMap(url, { city: name, name: name, lnglat: lnglat });
    else UI.renderStatic(url, { name: name, lnglat: lnglat }, z);
    return true;
  }

  /* ==================== 1. 关键字搜索 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_search_places',
      description: '按关键字（地点名称、类型，如“咖啡馆”“故宫”）搜索 POI，可限定城市。结果会在地图上标注。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键字，例如“西湖”“人民医院”' },
          city: { type: 'string', description: '城市名或 adcode，如“杭州”。不填则用当前城市或全国' },
          page: { type: 'integer', description: '页码，从 1 开始，默认 1' }
        },
        required: ['keyword']
      }
    }
  }, '关键字搜索', 'search', function (args) {
    requireKey();
    var keyword = String(args.keyword || '').trim();
    if (!keyword) throw new Error('缺少搜索关键字');
    return AMapKit.searchPlaces({
      keyword: keyword,
      city: args.city || AMapKit.getCity() || '',
      pageIndex: num(args.page, 1, 1, 20),
      pageSize: 10
    }).then(function (pois) {
      if (!pois.length) {
        return { ok: false, brief: '没有找到「' + keyword + '」', data: { keyword: keyword, total: 0 } };
      }
      if (!showStaticFallback(pois[0].lnglat, pois[0].name, 14)) AMapKit.renderPois(pois);
      if (pois[0].cityname) AMapKit.setCity(pois[0].cityname);
      return {
        ok: true,
        brief: '「' + keyword + '」找到 ' + pois.length + ' 条结果',
        data: {
          keyword: keyword,
          total: pois.length,
          list: trimList(pois, 8),
          tip: '结果已在地图上用带序号的标记展示，用户可点击查看详情'
        }
      };
    });
  });

  /* ==================== 2. 周边搜索 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_search_nearby',
      description: '以某个位置为中心做周边搜索（半径内找 POI）。中心点可以是地点名、地址，或留空表示用户当前位置。结果会在地图上标注并画出搜索范围。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键字，如“咖啡馆”“停车场”' },
          center: { type: 'string', description: '中心位置：地点名称、地址或“当前位置”。不填则用当前位置' },
          radius: { type: 'integer', description: '搜索半径（米），默认 1000，最大 50000' },
          city: { type: 'string', description: '城市名，用于辅助解析中心点' }
        },
        required: ['keyword']
      }
    }
  }, '周边搜索', 'nearby', function (args) {
    requireKey();
    var keyword = String(args.keyword || '').trim();
    if (!keyword) throw new Error('缺少搜索关键字');
    var radius = num(args.radius, 1000, 50, 50000);
    return AMapKit.resolveLocation(args.center, args.city || AMapKit.getCity())
      .then(function (loc) {
        if (!loc.lnglat) throw new Error('无法确定中心位置');
        return AMapKit.searchNearby({
          keyword: keyword,
          center: loc.lnglat,
          radius: radius,
          pageSize: 10
        }).then(function (pois) {
          if (!showStaticFallback(loc.lnglat, loc.name + ' 周边', 15)) {
            AMapKit.renderPois(pois, { center: loc.lnglat, radius: radius });
          }
          return {
            ok: pois.length > 0,
            brief: pois.length
              ? loc.name + ' 周边 ' + Util.distance(radius) + ' 内找到 ' + pois.length + ' 个「' + keyword + '」'
              : loc.name + ' 周边 ' + Util.distance(radius) + ' 内没有找到「' + keyword + '」',
            data: {
              keyword: keyword,
              center: { name: loc.name, location: loc.lnglat.join(',') },
              radius: radius,
              total: pois.length,
              list: trimList(pois, 8)
            }
          };
        });
      });
  });

  /* ==================== 3. 路径规划 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_plan_route',
      description: '规划两点之间的路线并在地图上绘制。支持驾车、步行、骑行、公交四种方式。起终点可以是地点名称、地址或“当前位置”。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['driving', 'walking', 'riding', 'transit'], description: '出行方式：driving 驾车 / walking 步行 / riding 骑行 / transit 公交' },
          origin: { type: 'string', description: '起点名称或地址，“当前位置”表示用户位置' },
          destination: { type: 'string', description: '终点名称或地址' },
          city: { type: 'string', description: '城市名，公交规划必填，其他方式用于解析地址' }
        },
        required: ['destination']
      }
    }
  }, '路径规划', 'route', function (args) {
    requireMap();
    var mode = ['driving', 'walking', 'riding', 'transit'].indexOf(args.mode) >= 0 ? args.mode : 'driving';
    var city = args.city || AMapKit.getCity() || '';
    var destinationText = String(args.destination || '').trim();
    if (!destinationText) throw new Error('缺少终点');

    return AMapKit.resolveLocation(args.origin || '当前位置', city)
      .then(function (origin) {
        return AMapKit.resolveLocation(destinationText, city).then(function (dest) {
          return AMapKit.planRoute({
            mode: mode,
            origin: origin.lnglat,
            destination: dest.lnglat,
            city: city || origin.city || dest.city
          }).then(function (route) {
            UI.renderRoute(route, origin.name, dest.name);
            return {
              ok: true,
              brief: route.modeText + ' ' + Util.distance(route.distance) + ' · ' + Util.duration(route.time),
              data: {
                mode: route.modeText,
                origin: origin.name,
                destination: dest.name,
                distance: Util.distance(route.distance),
                duration: Util.duration(route.time),
                cost: route.cost ? route.cost + ' 元' : undefined,
                steps: (route.steps || []).slice(0, 12),
                tip: '路线已在地图上绘制，起点用“起”、终点用“终”标记'
              }
            };
          });
        });
      });
  });

  /* ==================== 4. 天气查询 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_weather',
      description: '查询城市实时天气与未来三天预报，结果会显示在地图左上角的天气卡片上。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名或 adcode，如“杭州”“330100”。不填则用当前城市' }
        },
        required: []
      }
    }
  }, '天气查询', 'weather', function (args) {
    requireKey();
    var city = String(args.city || AMapKit.getCity() || '').trim();
    var task = city ? Promise.resolve(city) : AMapKit.locateIP().then(function (r) { return r.city; });
    return task.then(function (cityName) {
      return AMapKit.getWeather(cityName).then(function (w) {
        UI.renderWeather(w);
        var live = w.live;
        return {
          ok: true,
          brief: cityName + ' ' + live.weather + ' ' + live.temperature + '℃',
          data: {
            city: cityName,
            reportTime: live.report_time,
            live: {
              weather: live.weather,
              temperature: live.temperature + '℃',
              windDirection: live.winddirection,
              windPower: live.windpower + '级',
              humidity: live.humidity + '%'
            },
            forecast: (w.forecasts || []).map(function (c) {
              return {
                date: c.date,
                dayWeather: c.dayweather,
                nightWeather: c.nightweather,
                dayTemp: c.daytemp + '℃',
                nightTemp: c.nighttemp + '℃',
                dayWind: c.daywind + '风 ' + c.daypower + '级'
              };
            })
          }
        };
      });
    });
  });

  /* ==================== 5. 静态地图 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_static_map',
      description: '针对某个地点生成一张高德静态地图图片（无需交互的图片快照），会显示在地图面板右下角。',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '地点名称、地址或“经度,纬度”' },
          zoom: { type: 'integer', description: '缩放级别 1-17，默认 14' },
          city: { type: 'string', description: '城市名，用于解析地点' }
        },
        required: ['location']
      }
    }
  }, '静态地图', 'static', function (args) {
    requireKey();
    return AMapKit.resolveLocation(args.location, args.city || AMapKit.getCity()).then(function (loc) {
      if (!loc.lnglat) throw new Error('无法解析该地点');
      var zoom = num(args.zoom, 14, 1, 17);
      var url = AMapKit.staticMapUrl({ lnglat: loc.lnglat, zoom: zoom, size: '500*320' });
      UI.renderStatic(url, loc, zoom);
      return {
        ok: true,
        brief: '已生成「' + loc.name + '」静态地图',
        data: {
          location: loc.name,
          coordinate: loc.lnglat.map(function (n) { return n.toFixed(6); }).join(','),
          zoom: zoom,
          tip: '静态地图图片已展示在页面右下角，可直接右键保存'
        }
      };
    });
  });

  /* ==================== 6. IP 定位 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_ip_location',
      description: '根据用户公网 IP 判断所在城市（无需用户授权、精度到城市级），并可将地图移动到该城市。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }, 'IP 定位', 'locate', function () {
    requireKey();
    return AMapKit.locateIP().then(function (ip) {
      return {
        ok: true,
        brief: 'IP 定位：' + (ip.province && ip.province !== ip.city ? ip.province + ' ' : '') + ip.city,
        data: {
          province: ip.province,
          city: ip.city,
          citycode: ip.citycode,
          center: ip.center ? ip.center.map(function (n) { return n.toFixed(6); }).join(',') : '',
          accuracy: '城市级（基于 IP）'
        }
      };
    });
  });

  /* ==================== 7. 地理编码 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_geocode',
      description: '把结构化地址或地名解析成经纬度坐标，并在图上标记。不确定坐标时可用它先换算。',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: '地址或地名，如“杭州市西湖区文三路 90 号”' },
          city: { type: 'string', description: '城市名，用于缩小解析范围' }
        },
        required: ['address']
      }
    }
  }, '地理编码', 'geocode', function (args) {
    requireKey();
    var address = String(args.address || '').trim();
    if (!address) throw new Error('缺少地址');
    return AMapKit.geocode(address, args.city || AMapKit.getCity()).then(function (g) {
      if (!showStaticFallback(g.lnglat, g.name || address, 16)) {
        AMapKit.renderPois([{
          name: g.name || address,
          address: g.name,
          lnglat: g.lnglat,
          type: '地址解析',
          tel: '',
          distance: 0
        }]);
      }
      return {
        ok: true,
        brief: '已定位「' + (g.name || address) + '」',
        data: {
          address: g.name,
          city: g.city,
          location: g.lnglat.map(function (n) { return n.toFixed(6); }).join(',')
        }
      };
    });
  });

  /* ==================== 8. 清除图层 ==================== */
  define({
    type: 'function',
    function: {
      name: 'amap_clear_map',
      description: '清除地图上的所有标记、路线和范围圈。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }, '清除图层', 'clear', function () {
    AMapKit.clearOverlays();
    UI.closeRoute();
    return { ok: true, brief: '已清除地图图层', data: { cleared: true } };
  });

  /* ==================== 导出 ==================== */
  var MAP = {};
  TOOLS.forEach(function (t) { MAP[t.definition.function.name] = t; });

  global.ToolKit = {
    definitions: TOOLS.map(function (t) { return t.definition; }),
    meta: function (name) {
      var t = MAP[name];
      return { label: t ? t.label : name, icon: t ? t.icon : 'tool' };
    },
    execute: function (name, rawArgs) {
      var tool = MAP[name];
      if (!tool) return Promise.reject(new Error('未知工具：' + name));
      var args = {};
      try {
        args = typeof rawArgs === 'string' ? (rawArgs ? JSON.parse(rawArgs) : {}) : (rawArgs || {});
      } catch (e) {
        return Promise.reject(new Error('工具参数解析失败'));
      }
      return Promise.resolve()
        .then(function () { return tool.run(args); })
        .catch(function (err) {
          return {
            ok: false,
            brief: err && err.message ? err.message : '工具执行失败',
            data: { error: err && err.message ? err.message : String(err) }
          };
        });
    }
  };
})(window);
