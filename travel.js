/* 高德 Web 服务（REST）封装 · 纯前端直接调用 */
(function (global) {
  "use strict";

  var BASE = "https://restapi.amap.com";
  var TIMEOUT = 15000;

  var conf = { key: "", city: "" };

  function configure(next) {
    if (!next) return conf;
    if (typeof next.key === "string") conf.key = next.key.trim();
    /* 兼容旧字段：历史配置里可能把 Key 存在 webKey / security 上 */
    if (!conf.key && typeof next.webKey === "string") conf.key = next.webKey.trim();
    if (typeof next.city === "string") conf.city = next.city;
    return conf;
  }

  function getConfig() {
    return { key: conf.key, city: conf.city };
  }

  function hasKey() {
    return !!conf.key;
  }

  /* 保留旧接口，REST 方案不需要加载脚本 */
  function load() {
    if (!conf.key) return Promise.reject(new Error("尚未配置高德 Key"));
    return Promise.resolve(global.AMap);
  }

  function reset() {
    /* 无脚本可卸载 */
  }

  function getStatus() {
    return { key: conf.key, city: conf.city, loaded: !!conf.key, loading: false };
  }

  /* ---------------- 错误处理 ---------------- */

  var HINTS = {
    "10001": "Key 无效或已过期，请到高德控制台重新复制",
    "10002": "该 Key 没有开通对应服务，请在控制台检查 Key 类型",
    "10003": "今日调用配额已用完，请明天再试",
    "10004": "请求过于频繁，请稍后再试",
    "10005": "IP 白名单限制：请在控制台为这个 Key 配置 IP 白名单，或关闭白名单校验",
    "10006": "当前 IP 不在白名单内",
    "10007": "数字签名校验失败（Key 开启了数字签名，纯前端无法使用，请关闭签名校验）",
    "10009": "该 Key 缺少安全密钥或密钥错误（JS API 专用，Web 服务 Key 不受影响）",
    "10010": "IP 访问量超出限制",
    "10012": "该 Key 权限不足，无法调用此服务",
    "10013": "Key 已被删除或停用",
    "10020": "该 Key 未开通此接口的权限",
    "10021": "该 Key 对应的服务不存在",
    "10026": "账号已被封禁",
    "10029": "Key 与请求的服务类型不匹配",
    "20000": "请求参数不合法",
    "20001": "缺少必要参数",
    "20800": "规划点超出服务范围",
    "20802": "起终点太近或太远，无法规划路线",
    "20803": "无法在该城市规划公交路线",
    "30001": "引擎返回数据异常",
    "40000": "坐标格式错误，应为「经度,纬度」"
  };

  function normalizeError(json, fallback) {
    if (!json) return new Error(fallback || "高德接口无响应");
    var info = json.info || json.message || "";
    var code = String(json.infocode || json.code || "");
    var hint = HINTS[code] || "";
    var text;
    if (hint) {
      text = hint + (info && info !== "OK" ? "（" + info + (code ? " / " + code : "") + "）" : "");
    } else {
      text = info || fallback || "高德接口返回错误";
      if (code) text += "（" + code + "）";
    }
    var err = new Error(text);
    err.info = info;
    err.code = code;
    return err;
  }

  /* ---------------- 请求 ---------------- */

  function request(path, params) {
    if (!conf.key) return Promise.reject(new Error("尚未配置高德 Key，请在设置里填写"));

    var all = { key: conf.key };
    if (params) {
      Object.keys(params).forEach(function (k) {
        all[k] = params[k];
      });
    }
    var qs = [];
    Object.keys(all).forEach(function (k) {
      var v = all[k];
      if (v === undefined || v === null || v === "") return;
      qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    var url = BASE + path + "?" + qs.join("&");

    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, TIMEOUT);

    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("高德接口返回 HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        clearTimeout(timer);
        if (!json) throw new Error("高德接口返回空数据");
        /* v4 骑行接口用的是 errcode / errmsg，没有 status */
        if (json.errcode !== undefined && json.status === undefined) {
          if (Number(json.errcode) !== 0) throw new Error(json.errmsg || "高德接口返回错误");
          return json;
        }
        if (String(json.status) !== "1") throw normalizeError(json, "高德接口返回错误");
        return json;
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === "AbortError") throw new Error("高德接口请求超时（15 秒），请检查网络");
        if (err && err instanceof TypeError) {
          throw new Error("无法连接高德接口：请检查网络，或浏览器插件/代理是否拦截了 restapi.amap.com");
        }
        throw err;
      });
  }

  /* ---------------- 通用工具 ---------------- */

  function txt(v) {
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) return v.length ? txt(v[0]) : "";
    return String(v);
  }

  function isCoord(s) {
    return typeof s === "string" && /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(s.trim());
  }

  function fmtCoord(loc) {
    if (!loc) return "";
    var parts = String(loc).split(",");
    if (parts.length !== 2) return String(loc);
    return Number(parts[0]).toFixed(4) + ", " + Number(parts[1]).toFixed(4);
  }

  function metersText(m) {
    var n = Number(m);
    if (!n && n !== 0) return "";
    return n < 1000 ? Math.round(n) + " 米" : (n / 1000).toFixed(n < 10000 ? 1 : 0) + " 公里";
  }

  function secondsText(s) {
    var n = Number(s);
    if (!n) return "";
    if (n < 60) return Math.round(n) + " 秒";
    var min = Math.round(n / 60);
    if (min < 60) return min + " 分钟";
    var h = Math.floor(min / 60);
    var rest = min % 60;
    return h + " 小时" + (rest ? " " + rest + " 分" : "");
  }

  function brief(data, max) {
    var s;
    try {
      s = JSON.stringify(data);
    } catch (e) {
      s = String(data);
    }
    max = max || 1600;
    return s.length > max ? s.slice(0, max) + "…（已截断）" : s;
  }

  /* ---------------- 地理编码 ---------------- */

  function geocode(address, city) {
    return request("/v3/geocode/geo", { address: address, city: city || conf.city })
      .then(function (json) {
        var g = (json.geocodes || [])[0];
        if (!g) throw new Error("没有解析到「" + address + "」的坐标，请补充更详细的地址");
        return {
          location: txt(g.location),
          formattedAddress: txt(g.formatted_address),
          level: txt(g.level),
          adcode: txt(g.adcode),
          province: txt(g.province),
          city: txt(g.city) || txt(g.province),
          district: txt(g.district)
        };
      });
  }

  function regeocode(location) {
    var loc = isCoord(location) ? location : "";
    if (!loc) return Promise.reject(new Error("坐标格式应为「经度,纬度」，例如 120.15,30.28"));
    return request("/v3/geocode/regeo", { location: loc, extensions: "base" }).then(function (json) {
      var r = json.regeocode;
      if (!r) throw new Error("该坐标无法逆地理编码");
      var c = r.addressComponent || {};
      return {
        location: loc,
        formattedAddress: txt(r.formatted_address),
        province: txt(c.province),
        city: txt(c.city) || txt(c.province),
        district: txt(c.district),
        adcode: txt(c.adcode),
        township: txt(c.township)
      };
    });
  }

  /* 输入可以是地址，也可以是「经度,纬度」 */
  function resolvePlace(input, city) {
    if (isCoord(input)) {
      return regeocode(input)
        .then(function (r) {
          return { coord: input, name: r.formattedAddress || fmtCoord(input) };
        })
        .catch(function () {
          return { coord: input, name: fmtCoord(input) };
        });
    }
    return geocode(input, city).then(function (g) {
      return { coord: g.location, name: g.formattedAddress || input, adcode: g.adcode };
    });
  }

  /* ---------------- POI ---------------- */

  function normalizePois(pois, limit) {
    var list = (pois || []).filter(function (p) {
      return p && !Array.isArray(p);
    });
    return list.slice(0, limit || 8).map(function (p) {
      var addr = txt(p.address);
      if (!addr) {
        addr = [txt(p.pname), txt(p.cityname), txt(p.adname)].join("");
      }
      var typeText = txt(p.type);
      var typeArr = typeText.split(";").filter(Boolean);
      return {
        name: txt(p.name),
        address: addr,
        tel: txt(p.tel),
        distance: p.distance ? metersText(p.distance) : "",
        type: typeArr.length > 1 ? typeArr[typeArr.length - 1] : typeText,
        location: txt(p.location),
        city: txt(p.cityname),
        district: txt(p.adname)
      };
    });
  }

  function searchPoi(args) {
    args = args || {};
    var limit = Math.min(Math.max(args.limit || 6, 1), 10);
    var params = {
      keywords: args.keywords,
      types: args.types,
      city: args.city || conf.city,
      citylimit: args.city || conf.city ? "true" : "",
      offset: limit,
      page: 1,
      extensions: "base"
    };
    return request("/v3/place/text", params).then(function (json) {
      var pois = normalizePois(json.pois, limit);
      if (!pois.length) throw new Error("没有搜索到与「" + args.keywords + "」相关的地点");
      return { keywords: args.keywords, city: txt(args.city) || conf.city, pois: pois };
    });
  }

  function searchNearby(args) {
    args = args || {};
    var limit = Math.min(Math.max(args.limit || 6, 1), 10);
    return resolvePlace(args.location, args.city).then(function (place) {
      return request("/v3/place/around", {
        location: place.coord,
        keywords: args.keywords,
        types: args.types,
        radius: args.radius || 3000,
        offset: limit,
        page: 1,
        extensions: "base"
      }).then(function (json) {
        var pois = normalizePois(json.pois, limit);
        if (!pois.length) throw new Error("「" + args.keywords + "」附近没有找到相关地点");
        return { keywords: args.keywords, center: place.name, pois: pois };
      });
    });
  }

  /* ---------------- 路径规划 ---------------- */

  var MODE_TEXT = { driving: "驾车", walking: "步行", bicycling: "骑行", transit: "公交" };

  function routeSteps(steps, max) {
    return (steps || [])
      .map(function (s) {
        return {
          instruction: txt(s.instruction) || txt(s.action),
          distance: metersText(txt(s.distance))
        };
      })
      .filter(function (s) {
        return s.instruction;
      })
      .slice(0, max || 6);
  }

  function transitSteps(segs, max) {
    var out = [];
    (segs || []).forEach(function (seg) {
      if (!seg) return;
      var w = seg.walking;
      if (w && txt(w.distance)) {
        out.push({ instruction: "步行至车站", distance: metersText(txt(w.distance)) });
      }
      var bl = seg.bus && seg.bus.buslines && seg.bus.buslines[0];
      if (bl) {
        var dep = txt(bl.departure_stop && bl.departure_stop.name);
        var arr = txt(bl.arrival_stop && bl.arrival_stop.name);
        out.push({
          instruction:
            "乘坐 " + txt(bl.name) + (dep ? "（" + dep + " 上车" : "") + (arr ? "，" + arr + " 下车）" : "）"),
          distance: txt(bl.via_num) ? txt(bl.via_num) + " 站" : ""
        });
      }
      var rw = seg.railway;
      if (rw && txt(rw.name)) {
        out.push({
          instruction:
            "乘坐 " +
            txt(rw.name) +
            "（" +
            txt(rw.departure_stop && rw.departure_stop.name) +
            " → " +
            txt(rw.arrival_stop && rw.arrival_stop.name) +
            "）",
          distance: txt(rw.via_num) ? txt(rw.via_num) + " 站" : ""
        });
      }
      if (seg.taxi && txt(seg.taxi.distance)) {
        out.push({ instruction: "打车", distance: metersText(txt(seg.taxi.distance)) });
      }
    });
    return out.slice(0, max || 6);
  }

  function routePlan(args) {
    args = args || {};
    var mode = MODE_TEXT[args.mode] ? args.mode : "driving";
    var cityHint = args.city || conf.city;

    return Promise.all([
      resolvePlace(args.origin, cityHint),
      resolvePlace(args.destination, args.cityd || cityHint)
    ]).then(function (arr) {
      var o = arr[0];
      var d = arr[1];
      var req;
      if (mode === "driving") {
        req = request("/v3/direction/driving", {
          origin: o.coord,
          destination: d.coord,
          strategy: args.strategy === undefined ? 0 : args.strategy,
          extensions: "all"
        });
      } else if (mode === "walking") {
        req = request("/v3/direction/walking", { origin: o.coord, destination: d.coord, extensions: "all" });
      } else if (mode === "bicycling") {
        req = request("/v4/direction/bicycling", { origin: o.coord, destination: d.coord });
      } else {
        req = request("/v3/direction/transit/integrated", {
          origin: o.coord,
          destination: d.coord,
          city: o.adcode || cityHint,
          cityd: d.adcode || args.cityd || cityHint,
          extensions: "base"
        });
      }

      return req.then(function (json) {
        var base = {
          mode: mode,
          modeText: MODE_TEXT[mode],
          origin: o.coord,
          originName: o.name,
          destination: d.coord,
          destinationName: d.name,
          distanceText: "",
          durationText: "",
          cost: "",
          steps: []
        };

        if (mode === "bicycling") {
          var bPath = json.data && json.data.paths && json.data.paths[0];
          if (!bPath) throw new Error("没有规划出骑行路线");
          base.distanceText = metersText(bPath.distance);
          base.durationText = secondsText(bPath.duration);
          base.steps = routeSteps(bPath.steps);
          return base;
        }

        if (mode === "transit") {
          var t = ((json.route && json.route.transits) || [])[0];
          if (!t) throw new Error("没有规划出公交路线，可以换驾车或骑行试试");
          base.distanceText = metersText(t.distance);
          base.durationText = secondsText(t.duration);
          base.cost = txt(t.cost) ? "票价约 " + txt(t.cost) + " 元" : "";
          base.steps = transitSteps(t.segments);
          return base;
        }

        var path = ((json.route && json.route.paths) || [])[0];
        if (!path) throw new Error("没有规划出" + MODE_TEXT[mode] + "路线");
        base.distanceText = metersText(path.distance);
        base.durationText = secondsText(path.duration);
        base.steps = routeSteps(path.steps);
        if (mode === "driving" && txt(json.route.taxi_cost)) {
          base.cost = "打车约 " + txt(json.route.taxi_cost) + " 元";
        }
        return base;
      });
    });
  }

  /* ---------------- 天气 ---------------- */

  function resolveAdcode(city) {
    var c = txt(city).trim();
    if (/^\d{6}$/.test(c)) return Promise.resolve({ adcode: c, name: c });
    return request("/v3/config/district", { keywords: c, subdistrict: 0, extensions: "base" }).then(function (json) {
      var d = (json.districts || [])[0];
      if (!d) throw new Error("没有找到城市「" + c + "」");
      return { adcode: txt(d.adcode), name: txt(d.name) || c };
    });
  }

  function weatherQuery(args) {
    args = args || {};
    var wantForecast = args.forecast !== false;
    var city = args.city || conf.city;
    if (!city) return Promise.reject(new Error("请提供城市名称"));

    return resolveAdcode(city).then(function (c) {
      return request("/v3/weather/weatherInfo", { city: c.adcode, extensions: "base" }).then(function (json) {
        var l = (json.lives || [])[0];
        if (!l) throw new Error("没有查到「" + c.name + "」的实时天气");
        var out = {
          city: txt(l.city) || c.name,
          province: txt(l.province),
          adcode: c.adcode,
          weather: txt(l.weather),
          temperature: txt(l.temperature),
          wind:
            (txt(l.winddirection) ? txt(l.winddirection) + "风" : "") +
            (txt(l.windpower) ? " " + txt(l.windpower) + "级" : ""),
          humidity: txt(l.humidity),
          reportTime: txt(l.reporttime),
          forecast: []
        };
        if (!wantForecast) return out;
        return request("/v3/weather/weatherInfo", { city: c.adcode, extensions: "all" })
          .then(function (j2) {
            var f = (j2.forecasts || [])[0];
            out.forecast = ((f && f.casts) || []).slice(0, 4).map(function (x) {
              return {
                date: txt(x.date),
                week: txt(x.week),
                dayWeather: txt(x.dayweather),
                nightWeather: txt(x.nightweather),
                dayTemp: txt(x.daytemp),
                nightTemp: txt(x.nighttemp),
                dayWind: txt(x.daywind),
                dayPower: txt(x.daypower)
              };
            });
            return out;
          })
          .catch(function () {
            return out;
          });
      });
    });
  }

  /* ---------------- IP 定位 ---------------- */

  function ipLocation() {
    return request("/v3/ip", {}).then(function (json) {
      var province = txt(json.province);
      var city = txt(json.city);
      if (!province && !city) throw new Error("高德无法根据当前 IP 判断城市");
      return {
        province: province,
        city: city || province,
        adcode: txt(json.adcode),
        rectangle: txt(json.rectangle)
      };
    });
  }

  /* ---------------- 静态地图 ---------------- */

  function staticMap(args) {
    args = args || {};
    var center = args.center;
    if (!isCoord(center)) throw new Error("静态地图需要「经度,纬度」格式的中心点");
    var zoom = Math.min(Math.max(Number(args.zoom) || 13, 3), 17);
    var size = args.size || "750*420";

    var params = ["location=" + center, "zoom=" + zoom, "size=" + size, "scale=2"];

    var markers = (args.markers || []).slice(0, 8);
    if (markers.length) {
      var ms = markers
        .map(function (m, i) {
          var loc = isCoord(m) ? m : m && m.location;
          if (!isCoord(loc)) return "";
          var label = m && m.label ? String(m.label).slice(0, 1) : String(i + 1);
          return "mid,0xFF6B6B," + label + ":" + loc;
        })
        .filter(Boolean);
      if (ms.length) params.push("markers=" + ms.join("|"));
    }

    var url = BASE + "/v3/staticmap?key=" + encodeURIComponent(conf.key) + "&" + params.join("&");
    return { url: url, center: center, zoom: zoom };
  }

  /* ---------------- 高德 App 深链 ---------------- */

  function mapUri(kind, data) {
    data = data || {};
    var src = "&src=travel-assistant&coordinate=gaode&callnative=1";
    if (kind === "marker") {
      return (
        "https://uri.amap.com/marker?position=" +
        encodeURIComponent(data.location || "") +
        "&name=" +
        encodeURIComponent(data.name || "地点") +
        (data.address ? "&address=" + encodeURIComponent(data.address) : "") +
        src
      );
    }
    if (kind === "navigation") {
      var mode =
        data.mode === "walking" ? "walk" : data.mode === "transit" ? "bus" : data.mode === "bicycling" ? "ride" : "car";
      return (
        "https://uri.amap.com/navigation?from=" +
        encodeURIComponent((data.origin || "") + "," + (data.originName || "起点")) +
        "&to=" +
        encodeURIComponent((data.destination || "") + "," + (data.destinationName || "终点")) +
        "&mode=" +
        mode +
        src
      );
    }
    if (kind === "search") {
      return (
        "https://uri.amap.com/search?keyword=" +
        encodeURIComponent(data.keywords || "") +
        (data.center ? "&center=" + encodeURIComponent(data.center) : "") +
        src
      );
    }
    return "";
  }

  /* ---------------- 工具定义 ---------------- */

  var TOOLS = [
    {
      type: "function",
      function: {
        name: "search_poi",
        description:
          "按关键词搜索地点（餐厅、景点、酒店、车站等），返回名称、地址、电话、类型。用户问「某地有什么好吃的」「某景点在哪」时使用。",
        parameters: {
          type: "object",
          properties: {
            keywords: { type: "string", description: "搜索关键词，如「西湖」「火锅」「杭州东站」" },
            city: { type: "string", description: "限定城市，如「杭州」，不填则用默认城市" },
            limit: { type: "integer", description: "返回条数，1-10，默认 6" }
          },
          required: ["keywords"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_nearby",
        description: "以某个地点或坐标为圆心，搜索周边一定半径内的地点。",
        parameters: {
          type: "object",
          properties: {
            keywords: { type: "string", description: "搜索关键词，如「咖啡」「停车场」" },
            location: { type: "string", description: "圆心，可以是地址或「经度,纬度」" },
            radius: { type: "integer", description: "搜索半径（米），默认 3000，最大 50000" },
            limit: { type: "integer", description: "返回条数，1-10，默认 6" }
          },
          required: ["keywords", "location"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "geocode",
        description: "把地址解析成经纬度坐标，返回标准地址、所属省市与坐标。",
        parameters: {
          type: "object",
          properties: {
            address: { type: "string", description: "结构化地址，如「杭州市西湖区文三路 100 号」" },
            city: { type: "string", description: "限定城市，可选" }
          },
          required: ["address"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "route_plan",
        description: "规划两点之间的路线，返回距离、预计耗时、费用和主要路段。",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["driving", "walking", "bicycling", "transit"],
              description: "出行方式：driving 驾车 / walking 步行 / bicycling 骑行 / transit 公交"
            },
            origin: { type: "string", description: "起点，地址或「经度,纬度」" },
            destination: { type: "string", description: "终点，地址或「经度,纬度」" },
            city: { type: "string", description: "起点城市，公交路线必填" },
            cityd: { type: "string", description: "终点城市，跨城公交时填写" }
          },
          required: ["origin", "destination"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "weather_query",
        description: "查询城市实时天气和未来几天预报。",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "城市名称或 adcode，如「杭州」或「330100」" },
            forecast: { type: "boolean", description: "是否包含未来预报，默认 true" }
          },
          required: ["city"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "static_map",
        description: "生成一张静态地图图片，可标注中心点与若干标记点。需要地图缩略图时使用。",
        parameters: {
          type: "object",
          properties: {
            center: { type: "string", description: "地图中心「经度,纬度」" },
            zoom: { type: "integer", description: "缩放级别 3-17，默认 13" },
            markers: {
              type: "array",
              description: "标记点，最多 8 个，每项为「经度,纬度」或 {location,label}",
              items: { type: "string" }
            }
          },
          required: ["center"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ip_location",
        description: "根据用户当前网络 IP 判断所在省市，用于确定默认城市。",
        parameters: { type: "object", properties: {} }
      }
    }
  ];

  /* ---------------- 工具执行 ---------------- */

  function executeTool(name, args) {
    args = args || {};

    if (name === "search_poi" || name === "search_nearby") {
      var run = name === "search_poi" ? searchPoi(args) : searchNearby(args);
      return run.then(function (r) {
        return {
          content: brief(r, 1800),
          cards: [
            {
              type: "pois",
              title: "「" + args.keywords + "」" + (name === "search_poi" ? "搜索结果" : "周边结果"),
              link: mapUri("search", { keywords: args.keywords, center: r.pois[0].location }),
              items: r.pois
            }
          ]
        };
      });
    }

    if (name === "geocode") {
      return geocode(args.address, args.city).then(function (g) {
        return {
          content: brief(g, 800),
          cards: [
            {
              type: "map",
              title: g.formattedAddress || args.address,
              url: staticMap({ center: g.location, zoom: 15, markers: [{ location: g.location, label: "1" }] })
                .url,
              link: mapUri("marker", { location: g.location, name: g.formattedAddress || args.address })
            }
          ]
        };
      });
    }

    if (name === "route_plan") {
      return routePlan(args).then(function (r) {
        return {
          content: brief(r, 1800),
          cards: [
            {
              type: "route",
              modeText: r.modeText,
              distanceText: r.distanceText,
              durationText: r.durationText,
              cost: r.cost,
              origin: r.origin,
              originName: r.originName,
              destination: r.destination,
              destinationName: r.destinationName,
              steps: r.steps,
              link: mapUri("navigation", {
                mode: r.mode,
                origin: r.origin,
                originName: r.originName,
                destination: r.destination,
                destinationName: r.destinationName
              })
            }
          ]
        };
      });
    }

    if (name === "weather_query") {
      return weatherQuery(args).then(function (w) {
        return { content: brief(w, 1200), cards: [{ type: "weather", data: w }] };
      });
    }

    if (name === "static_map") {
      var sm = staticMap(args);
      return Promise.resolve({
        content: brief(sm, 600),
        cards: [
          {
            type: "map",
            title: "静态地图",
            url: sm.url,
            link: mapUri("marker", { location: sm.center, name: "地图中心" })
          }
        ]
      });
    }

    if (name === "ip_location") {
      return ipLocation().then(function (loc) {
        return {
          content: brief(loc, 400),
          cards: [{ type: "location", province: loc.province, city: loc.city, adcode: loc.adcode }]
        };
      });
    }

    return Promise.reject(new Error("未知工具：" + name));
  }

  /* ---------------- 自检 ---------------- */

  async function diagnose() {
    var report = [];
    function step(name, ok, detail) {
      report.push({ name: name, ok: !!ok, detail: detail || "" });
    }

    step("高德 Key", !!conf.key, conf.key ? conf.key.slice(0, 4) + "…" + conf.key.slice(-4) : "未填写");
    if (!conf.key) return { ok: false, report: report };

    try {
      var g = await geocode("天安门", "北京");
      step("地理编码", true, g.formattedAddress + " · " + g.location);
    } catch (e) {
      step("地理编码", false, e.message);
    }

    try {
      var p = await searchPoi({ keywords: "咖啡", city: conf.city || "北京", limit: 2 });
      step("POI 搜索", true, p.pois.length + " 条 · " + p.pois[0].name);
    } catch (e) {
      step("POI 搜索", false, e.message);
    }

    try {
      var w = await weatherQuery({ city: conf.city || "杭州", forecast: false });
      step("天气查询", true, w.city + " " + w.weather + " " + w.temperature + "℃");
    } catch (e) {
      step("天气查询", false, e.message);
    }

    try {
      var ip = await ipLocation();
      step("IP 定位", true, (ip.province || "") + " " + ip.city);
    } catch (e) {
      step("IP 定位", false, e.message);
    }

    var critical = ["高德 Key", "地理编码", "POI 搜索", "天气查询"];
    return {
      ok: report.every(function (r) {
        return critical.indexOf(r.name) < 0 || r.ok;
      }),
      report: report
    };
  }

  global.Travel = {
    configure: configure,
    getConfig: getConfig,
    hasKey: hasKey,
    hasWebKey: hasKey,
    reset: reset,
    load: load,
    getStatus: getStatus,
    geocode: geocode,
    regeocode: regeocode,
    resolvePlace: resolvePlace,
    searchPoi: searchPoi,
    searchNearby: searchNearby,
    routePlan: routePlan,
    weatherQuery: weatherQuery,
    ipLocation: ipLocation,
    staticMap: staticMap,
    mapUri: mapUri,
    TOOLS: TOOLS,
    executeTool: executeTool,
    diagnose: diagnose,
    fmtCoord: fmtCoord,
    isCoord: isCoord
  };
})(window);
