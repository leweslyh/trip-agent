/**
 * DeepSeek 大模型智能体：工具调用循环（Function Calling）
 */
(function () {
  const MAX_ITER = 6;

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'geocode',
        description: '地址/地名转经纬度坐标（地理编码）。当地点名称需要转换为坐标时使用，例如"天安门"、"北京市海淀区中关村"。',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '地址或地名，如"天安门"' },
            city: { type: 'string', description: '所在城市，可选，如"北京"' }
          },
          required: ['address']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'place_search',
        description: '关键字搜索 POI 地点，例如搜索"故宫"、"咖啡店"、"酒店"等。适合查找具体地点或某类场所。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键字' },
            city: { type: 'string', description: '限定城市，可选，如"北京"，不填则全国搜索' },
            offset: { type: 'integer', description: '返回条数，默认10，最大25' }
          },
          required: ['keywords']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'place_around',
        description: '周边搜索：在指定经纬度坐标附近搜索 POI，例如"附近的地铁站"、"周边的餐馆"。',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: '中心点经纬度，格式"经度,纬度"，如"116.397428,39.90923"' },
            keywords: { type: 'string', description: '搜索关键字，可选，如"咖啡店"' },
            radius: { type: 'integer', description: '搜索半径（米），默认2000，最大50000' },
            offset: { type: 'integer', description: '返回条数，默认10，最大25' }
          },
          required: ['location']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'route_planning',
        description: '路径规划，支持驾车、步行、公交。返回距离、耗时和路线。',
        parameters: {
          type: 'object',
          properties: {
            origin: { type: 'string', description: '起点，可为"经度,纬度"或地名，如"天安门"' },
            destination: { type: 'string', description: '终点，可为"经度,纬度"或地名，如"鸟巢"' },
            mode: { type: 'string', enum: ['driving', 'walking', 'transit'], description: '出行方式：driving驾车，walking步行，transit公交' },
            city: { type: 'string', description: '城市，公交规划时建议填写' }
          },
          required: ['origin', 'destination', 'mode']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'weather',
        description: '查询指定城市的天气。base返回实况天气，all返回未来几天的预报。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名或adcode，如"北京"或"110000"' },
            extensions: { type: 'string', enum: ['base', 'all'], description: 'base实况，all预报' }
          },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ip_location',
        description: 'IP定位，获取当前设备所在省市及大致位置，用于"我在哪"、"当前城市"等需求。',
        parameters: {
          type: 'object',
          properties: {
            ip: { type: 'string', description: '可选，指定IP，不填则自动获取当前设备IP' }
          }
        }
      }
    }
  ];

  function systemPrompt() {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    return `你是"出行小助手"，一个基于高德地图数据的出行智能助手。请根据用户用自然语言表达的出行需求，调用合适的工具获取真实数据，再给出简洁、准确、友好的回答。

规则：
1. 必须优先使用工具获取真实数据，绝不编造地点、路线或天气信息。
2. 工具选择：查找某地用 place_search；把地名转坐标用 geocode；"附近/周边/离我近"用 place_around；"路线/怎么走/导航/多远"用 route_planning；"天气"用 weather；"我在哪/IP定位/当前城市"用 ip_location。
3. 当周边搜索或路径规划需要坐标、但用户只给出地名时，先用 geocode 解析成坐标。
4. 用简体中文回答，简洁友好。列出地点时逐个给出名称、地址，有距离则带上距离。
5. 若工具调用失败，可尝试换用其他工具或换种说法，并如实告知用户。
6. 当前时间：${now}。可作为天气/路线时效性参考，但不要编造实时数据。`;
  }

  async function chatCompletion(messages) {
    const cfg = Config.get();
    if (!cfg.deepseekKey) throw new Error('请先在设置中填写 DeepSeek API Key');

    let base = (cfg.deepseekBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    let url = base + '/chat/completions';
    if (cfg.proxyPrefix) url = cfg.proxyPrefix + encodeURIComponent(url);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.deepseekKey
        },
        body: JSON.stringify({
          model: cfg.deepseekModel || 'deepseek-chat',
          messages: messages,
          tools: TOOLS,
          temperature: 0.3,
          stream: false
        })
      });
    } catch (e) {
      throw new Error('请求 DeepSeek 失败（浏览器跨域可能被拦截）：' + e.message + '。可在设置中配置 CORS 代理前缀后重试。');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (e) {}
      throw new Error('DeepSeek 接口 HTTP ' + res.status + '：' + detail);
    }
    return res.json();
  }

  /* ---------- 工具执行 ---------- */

  function fmtDist(m) {
    if (m == null) return null;
    m = Number(m);
    return m >= 1000 ? (m / 1000).toFixed(1) + ' 公里' : m + ' 米';
  }
  function fmtDur(s) {
    if (s == null) return null;
    s = Number(s);
    const min = Math.round(s / 60);
    if (min < 60) return min + ' 分钟';
    return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分钟';
  }

  function poiSummary(data) {
    const src = data.pois || data.geocodes || [];
    return src.slice(0, 10).map((p) => ({
      name: p.name || p.formatted_address || '未知',
      address: p.address || [p.province, p.city, p.district, p.township].filter(Boolean).join(''),
      location: p.location,
      distance: p.distance ? fmtDist(p.distance) : undefined,
      type: p.type
    }));
  }

  // 是否为 "经度,纬度" 坐标格式
  function isCoord(s) {
    return /^[-+]?\d{1,3}(\.\d+)?\s*,\s*[-+]?\d{1,2}(\.\d+)?$/.test(String(s || '').trim());
  }

  // 将地名或坐标统一规范化为 "经度,纬度"；地名则先地理编码
  async function toCoordinate(str, cityHint) {
    const s = String(str || '').trim();
    if (!s) throw new Error('缺少地点/坐标参数');
    if (isCoord(s)) return s.replace(/\s+/g, '');
    const data = await AMapAPI.geocode(s, cityHint || '');
    const g = data.geocodes && data.geocodes[0];
    if (!g || !g.location) throw new Error('无法将"' + s + '"解析为坐标');
    return g.location;
  }

  // 解析地名对应的城市名（公交规划需要 city 参数）
  async function resolveCityName(str) {
    const s = String(str || '').trim();
    if (!s || isCoord(s)) return '';
    try {
      const data = await AMapAPI.geocode(s, '');
      const g = data.geocodes && data.geocodes[0];
      return (g && (g.city || g.province)) || '';
    } catch (e) {
      return '';
    }
  }

  async function execGeocode(args) {
    const data = await AMapAPI.geocode(args.address, args.city);
    const pois = poiSummary(data);
    return {
      data: { pois },
      summary: { type: 'geocode', results: pois }
    };
  }

  async function execPlaceSearch(args) {
    const data = await AMapAPI.placeText(args.keywords, args.city, args.offset, 1);
    const pois = poiSummary(data);
    return {
      data: { pois },
      summary: { type: 'place_search', count: data.count, results: pois }
    };
  }

  async function execPlaceAround(args) {
    const location = await toCoordinate(args.location);
    const data = await AMapAPI.placeAround(location, args.keywords, args.radius, args.offset, 1);
    const pois = poiSummary(data);
    return {
      data: { pois },
      summary: { type: 'place_around', center: location, count: data.count, results: pois }
    };
  }

  async function execRoute(args) {
    const mode = args.mode || 'driving';
    const origin = await toCoordinate(args.origin);
    const destination = await toCoordinate(args.destination);
    let city = args.city;
    if (mode === 'transit' && !city) {
      city = await resolveCityName(args.origin) || await resolveCityName(args.destination);
    }
    if (mode === 'transit' && !city) {
      throw new Error('公交路线规划需要指定城市，请提供城市名，或改用驾车/步行方式');
    }
    const data = await AMapAPI.direction(origin, destination, mode, city);
    const route = data.route || {};
    const info = { mode, origin: route.origin, destination: route.destination, polyline: '', distance: null, duration: null, taxiCost: null, desc: [] };

    if (mode === 'transit') {
      const t = route.transits && route.transits[0];
      if (t) {
        info.distance = Number(t.distance || 0);
        info.duration = Number(t.duration || 0);
        const segs = t.segments || [];
        const polys = [];
        segs.forEach((s) => {
          if (s.walking && s.walking.polyline) polys.push(s.walking.polyline);
          if (s.bus && s.bus.buslines && s.bus.buslines[0]) info.desc.push('公交：' + s.bus.buslines[0].name);
          if (s.railway && s.railway.name) info.desc.push('地铁：' + s.railway.name);
        });
        info.polyline = polys.join(';');
      }
    } else {
      const p = route.paths && route.paths[0];
      if (p) {
        info.distance = Number(p.distance || 0);
        info.duration = Number(p.duration || 0);
        if (p.taxi_cost != null) info.taxiCost = Number(p.taxi_cost);
        info.polyline = (p.steps || []).map((s) => s.polyline).filter(Boolean).join(';');
        info.desc = (p.steps || []).slice(0, 6).map((s) => s.instruction);
      }
    }

    const summary = {
      type: 'route',
      mode,
      origin: info.origin,
      destination: info.destination,
      distance: fmtDist(info.distance),
      duration: fmtDur(info.duration),
      taxi_cost: info.taxiCost != null ? info.taxiCost + ' 元' : undefined,
      steps: info.desc
    };
    return { data: info, summary };
  }

  async function execWeather(args) {
    const data = await AMapAPI.weatherInfo(args.city, args.extensions);
    let summary;
    if (data.lives && data.lives.length) {
      const l = data.lives[0];
      summary = {
        type: 'weather', extensions: 'base', province: l.province, city: l.city,
        weather: l.weather, temperature: l.temperature, wind: l.winddirection + '风 ' + l.windpower + '级',
        humidity: l.humidity, reporttime: l.reporttime
      };
    } else if (data.forecasts && data.forecasts.length) {
      const f = data.forecasts[0];
      summary = {
        type: 'weather', extensions: 'all', province: f.province, city: f.city,
        reporttime: f.reporttime,
        casts: (f.casts || []).map((c) => ({
          date: c.date, week: c.week, day: c.dayweather + ' ' + c.daytemp + '℃',
          night: c.nightweather + ' ' + c.nighttemp + '℃'
        }))
      };
    } else {
      summary = { type: 'weather', raw: data };
    }
    return { data: summary, summary };
  }

  async function execIp(args) {
    const data = await AMapAPI.ipLocation(args.ip);
    const summary = {
      type: 'ip',
      province: data.province,
      city: data.city,
      adcode: data.adcode,
      rectangle: data.rectangle,
      center: data.rectangle ? centerOfRect(data.rectangle) : null
    };
    return { data: summary, summary };
  }

  function centerOfRect(rect) {
    // rectangle 格式："lng1,lat1;lng2,lat2"
    const parts = String(rect).split(';');
    if (parts.length !== 2) return null;
    const [a, b] = parts.map((s) => s.split(',').map(Number));
    return ((a[0] + b[0]) / 2).toFixed(6) + ',' + ((a[1] + b[1]) / 2).toFixed(6);
  }

  async function executeTool(name, args) {
    switch (name) {
      case 'geocode': return execGeocode(args);
      case 'place_search': return execPlaceSearch(args);
      case 'place_around': return execPlaceAround(args);
      case 'route_planning': return execRoute(args);
      case 'weather': return execWeather(args);
      case 'ip_location': return execIp(args);
      default: throw new Error('未知工具：' + name);
    }
  }

  /* ---------- 主循环 ---------- */

  async function runAgent(userText, history) {
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...(history || []),
      { role: 'user', content: userText }
    ];
    const toolLog = [];

    for (let i = 0; i < MAX_ITER; i++) {
      const data = await chatCompletion(messages);
      const choice = data.choices && data.choices[0];
      if (!choice || !choice.message) throw new Error('DeepSeek 返回格式异常');

      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls && msg.tool_calls.length) {
        const toolMsgs = [];
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
          let entry;
          try {
            const result = await executeTool(tc.function.name, args);
            entry = { name: tc.function.name, args, data: result.data, summary: result.summary };
            toolMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.summary).slice(0, 2500) });
          } catch (e) {
            entry = { name: tc.function.name, args, data: null, summary: { error: e.message } };
            toolMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: e.message }) });
          }
          toolLog.push(entry);
        }
        messages.push(...toolMsgs);
        continue;
      }

      return { text: (msg.content || '').trim(), toolLog };
    }

    return { text: '处理步骤较多，请换一种更具体的说法试试。', toolLog };
  }

  window.Agent = { runAgent };
})();
