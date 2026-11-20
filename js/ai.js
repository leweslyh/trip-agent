/* DeepSeek 对话内核 + 智能体工具编排 */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};
  const U = App.utils;

  /* ================= 工具定义 ================= */
  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'amap_text_search',
        description: '高德关键字搜索：按关键词在指定城市或全国范围搜索地点（POI），返回名称、地址、坐标、评分、电话等。适合找具体店名、景点、地标。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词，例如「西湖」「海底捞」「杭州东站」' },
            city: { type: 'string', description: '限定城市名或 adcode，例如「杭州」。全国范围搜索可留空' },
            types: { type: 'string', description: 'POI 分类编码，例如 050000 表示餐饮，100000 表示风景名胜，可留空' },
            limit: { type: 'integer', description: '返回条数，1-25，默认 8' },
            page: { type: 'integer', description: '页码，默认 1' }
          },
          required: ['keywords']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'amap_around_search',
        description: '高德周边搜索：以某个坐标（或地址、当前 IP 位置）为中心，搜索指定半径内的地点，按距离或权重排序。适合「附近有什么」「周边 3 公里」这类需求。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词，例如「咖啡」「餐厅」「停车场」，可为空' },
            location: { type: 'string', description: '中心点坐标「经度,纬度」，或地址名。留空则用 IP 定位城市中心' },
            city: { type: 'string', description: '城市名，用于地址解析与结果限定' },
            radius: { type: 'integer', description: '搜索半径（米），100-50000，默认 3000' },
            types: { type: 'string', description: 'POI 分类编码，可留空' },
            limit: { type: 'integer', description: '返回条数，1-25，默认 10' },
            sortrule: { type: 'string', enum: ['distance', 'weight'], description: '排序方式：distance 距离优先，weight 综合权重优先' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'amap_geocode',
        description: '地理编码：把地址、地名、地标转换成经纬度坐标及行政区信息。路径规划或地图标注前需要坐标时使用。',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '结构化地址，例如「杭州市西湖区龙井路1号」「西湖风景名胜区」' },
            city: { type: 'string', description: '城市名，用于提高解析准确度' }
          },
          required: ['address']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'amap_route',
        description: '高德路径规划：规划两点之间的驾车、步行、骑行或公交路线，返回距离、耗时、费用与分段导航指引。起点终点支持地址或「经度,纬度」坐标。',
        parameters: {
          type: 'object',
          properties: {
            origin: { type: 'string', description: '起点地址或坐标「经度,纬度」' },
            destination: { type: 'string', description: '终点地址或坐标「经度,纬度」' },
            mode: { type: 'string', enum: ['driving', 'walking', 'bicycling', 'transit'], description: '出行方式，默认 driving' },
            city: { type: 'string', description: '起点城市名，公交规划时用于确定城市' },
            cityd: { type: 'string', description: '终点城市名，跨城公交时填写' }
          },
          required: ['origin', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'amap_weather',
        description: '高德天气查询：查询指定城市的实时天气与未来三天预报。不传城市时按用户 IP 自动定位。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名或 adcode，例如「杭州」「110000」' },
            type: { type: 'string', enum: ['now', 'forecast', 'all'], description: 'now 实况，forecast 预报，all 两者都要（默认）' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'amap_static_map',
        description: '高德静态地图：生成一张带标记点或路线轨迹的地图图片，直接在对话中展示。用户想「看地图」「标注位置」「看路线」时调用。',
        parameters: {
          type: 'object',
          properties: {
            center: { type: 'string', description: '地图中心，坐标「经度,纬度」或地址名' },
            zoom: { type: 'integer', description: '缩放级别 3-18，城市级 11，街区级 14，默认 13' },
            markers: {
              type: 'array',
              description: '标记点，最多 6 个',
              items: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: '坐标「经度,纬度」' },
                  name: { type: 'string', description: '地点名称' },
                  label: { type: 'string', description: '单个字母或数字标签，如 A' }
                },
                required: ['location']
              }
            },
            path: { type: 'array', items: { type: 'string' }, description: '路线轨迹坐标数组，用于绘制连线' },
            traffic: { type: 'boolean', description: '是否显示实时路况' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'amap_ip_location',
        description: 'IP 定位：根据用户当前网络的 IP 判断所在省份、城市与大致中心坐标。用户没说城市、或问「我在哪」时先用它。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索：检索公开网页，获取最新资讯、活动、政策、攻略等实时信息。返回若干条标题、链接与摘要。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，尽量具体' },
            limit: { type: 'integer', description: '返回条数，默认 6' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '网页抓取：读取指定 URL 的正文内容并转成纯文本，用于精读网页、核对信息。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整网址，必须包含 http/https' }
          },
          required: ['url']
        }
      }
    }
  ];

  /* ================= 联网能力（Jina Reader 代理，免跨域） ================= */
  const JINA = 'https://r.jina.ai/';

  function parseSearchMarkdown(text, limit) {
    const out = [];
    const seen = new Set();
    const re = /\[([^\]\n]{2,120})\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = re.exec(text)) && out.length < (limit || 6)) {
      const title = m[1].replace(/\s+/g, ' ').trim();
      let url = m[2];
      if (/bing\.com|duckduckgo\.com|microsoft\.com|go\.microsoft/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 420);
      const snippet = after.split('\n').map((s) => s.trim())
        .filter((s) => s && !/^[#>*\-|]/.test(s) && !/^\[/.test(s))
        .join(' ').slice(0, 220);
      out.push({ title: title || url, url, snippet });
    }
    return out;
  }

  async function webSearch(query, limit) {
    const q = String(query || '').trim();
    if (!q) throw new Error('搜索关键词不能为空');
    const n = Math.min(Math.max(Number(limit) || 6, 1), 10);
    const engines = [
      'https://r.jina.ai/https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&count=' + n,
      'https://r.jina.ai/https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q)
    ];
    let lastErr = null;
    for (const url of engines) {
      try {
        const text = await U.fetchJSON(url, { headers: { Accept: 'text/plain' } }, 25000).catch(async () => {
          const res = await fetch(url, { headers: { Accept: 'text/plain' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        });
        const plain = typeof text === 'string' ? text : (text && text.raw) || '';
        const results = parseSearchMarkdown(plain, n);
        if (results.length) return { query: q, results, source: url.indexOf('bing') > 0 ? 'Bing' : 'DuckDuckGo' };
        lastErr = new Error('未解析到有效结果');
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('联网搜索失败：' + (lastErr ? lastErr.message : '未知错误') + '。可稍后重试，或直接使用高德搜索。');
  }

  async function webFetch(url) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('URL 必须以 http:// 或 https:// 开头');
    const res = await fetch(JINA + target, { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error('网页抓取失败：HTTP ' + res.status);
    const text = await res.text();
    return { url: target, content: String(text).slice(0, 8000) };
  }

  /* ================= 工具执行 ================= */
  function poiBrief(p) {
    return {
      名称: p.name, 地址: p.address || '', 坐标: p.location,
      类型: p.type, 评分: p.rating, 人均: p.cost,
      距离米: p.distance, 电话: p.tel || undefined, 特色: p.tag || undefined
    };
  }

  async function runTool(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    const started = Date.now();

    if (name === 'amap_text_search') {
      if (!a.keywords) throw new Error('缺少搜索关键词');
      const data = await App.amap.textSearch(a);
      const cards = [];
      if (data.pois.length) cards.push({ type: 'pois', title: '「' + data.keyword + '」搜索结果', subtitle: '共 ' + data.count + ' 条', items: data.pois.slice(0, 10), center: data.pois[0].location, keyword: data.keyword });
      return {
        cards,
        modelData: { 关键词: data.keyword, 结果数: data.count, 地点: data.pois.slice(0, 8).map(poiBrief) },
        summary: '搜索「' + data.keyword + '」找到 ' + data.count + ' 个地点',
        elapsed: Date.now() - started
      };
    }

    if (name === 'amap_around_search') {
      const data = await App.amap.aroundSearch(a);
      const cards = [];
      if (data.pois.length) {
        cards.push({
          type: 'pois',
          title: (data.keyword ? '「' + data.keyword + '」' : '') + '周边 ' + U.fmtDistance(data.radius) + ' 内',
          subtitle: '按' + (a.sortrule === 'weight' ? '综合排序' : '距离排序') + ' · ' + data.pois.length + ' 个地点',
          items: data.pois.slice(0, 10),
          center: data.center,
          keyword: data.keyword || '周边地点',
          radius: data.radius
        });
      }
      return {
        cards,
        modelData: { 中心坐标: data.center, 半径米: data.radius, 结果数: data.count, 地点: data.pois.slice(0, 8).map(poiBrief) },
        summary: '在周边 ' + U.fmtDistance(data.radius) + ' 内找到 ' + data.count + ' 个地点',
        elapsed: Date.now() - started
      };
    }

    if (name === 'amap_geocode') {
      if (!a.address) throw new Error('缺少地址');
      const g = await App.amap.geocode(a.address, a.city);
      return {
        cards: [{ type: 'ip', title: '地址解析', subtitle: g.level || '', data: { city: g.city, district: g.district, address: g.formatted || g.name, center: g.location } }],
        modelData: { 标准地址: g.name, 坐标: g.location, 省: g.province, 市: g.city, 区: g.district, 级别: g.level },
        summary: '「' + a.address + '」解析为 ' + g.location,
        elapsed: Date.now() - started
      };
    }

    if (name === 'amap_route') {
      if (!a.origin || !a.destination) throw new Error('起点和终点都不能为空');
      const r = await App.amap.route(a);
      const modeText = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '公交' }[r.mode];
      const cards = [{ type: 'route', data: r }];
      if (r.polyline && r.polyline.length > 1) {
        try {
          const map = await App.amap.staticMap({
            center: r.polyline[Math.floor(r.polyline.length / 2)],
            zoom: r.mode === 'transit' ? 12 : 12,
            path: r.polyline,
            markers: [{ location: r.polyline[0], name: r.origin, label: 'A' }, { location: r.polyline[r.polyline.length - 1], name: r.destination, label: 'B' }]
          });
          cards.push({ type: 'map', title: modeText + '路线', subtitle: U.fmtDistance(r.distance) + ' · ' + U.fmtDuration(r.duration), url: map.url });
        } catch (e) { /* 地图失败不影响主体结果 */ }
      }
      return {
        cards,
        modelData: {
          出行方式: modeText, 起点: r.origin, 终点: r.destination,
          距离米: r.distance, 耗时秒: r.duration, 费用元: r.cost,
          主要路段: r.steps.slice(0, 12)
        },
        summary: modeText + '方案 ' + U.fmtDistance(r.distance) + ' / ' + U.fmtDuration(r.duration),
        elapsed: Date.now() - started
      };
    }

    if (name === 'amap_weather') {
      const w = await App.amap.weather(a);
      const now = w.lives[0];
      const casts = w.forecasts[0] ? w.forecasts[0].casts : [];
      return {
        cards: [{ type: 'weather', data: w }],
        modelData: {
          城市: now ? now.city : w.city,
          实况: now ? { 天气: now.weather, 温度: now.temperature + '℃', 风向: now.windDirection, 风力: now.windPower, 湿度: now.humidity + '%', 发布时间: now.reportTime } : null,
          预报: casts.map((c) => ({ 日期: c.date, 星期: c.week, 白天: c.dayWeather, 夜间: c.nightWeather, 高温: c.dayTemp + '℃', 低温: c.nightTemp + '℃' }))
        },
        summary: '查询到 ' + (now ? now.city : w.city) + ' 天气',
        elapsed: Date.now() - started
      };
    }

    if (name === 'amap_static_map') {
      const map = await App.amap.staticMap(a);
      return {
        cards: [{ type: 'map', title: a.title || '静态地图', subtitle: '缩放 ' + map.zoom + (map.markers.length ? ' · ' + map.markers.length + ' 个标记' : ''), url: map.url }],
        modelData: { 地图地址: map.url, 中心: map.center, 缩放: map.zoom, 标记: map.markers },
        summary: '已生成静态地图',
        elapsed: Date.now() - started
      };
    }

    if (name === 'amap_ip_location') {
      const ip = await App.amap.ipLocation();
      let exact = { province: ip.province, city: ip.city, district: '', address: '' };
      if (ip.center) {
        try {
          const r = await App.amap.regeo(ip.center);
          exact = { province: r.province, city: r.city || ip.city, district: r.district, address: r.formatted };
        } catch (e) { /* 逆地理失败则忽略 */ }
      }
      return {
        cards: [{ type: 'ip', title: 'IP 定位', subtitle: '基于当前网络出口', data: { city: exact.city, district: exact.district, address: exact.address, center: ip.center, province: exact.province } }],
        modelData: { 省: exact.province, 市: exact.city, 区: exact.district, 位置描述: exact.address, 中心坐标: ip.center, adcode: ip.adcode },
        summary: '定位到 ' + (exact.city || exact.province),
        elapsed: Date.now() - started
      };
    }

    if (name === 'web_search') {
      if (!a.query) throw new Error('缺少搜索关键词');
      const data = await webSearch(a.query, a.limit);
      return {
        cards: [{ type: 'web', title: '联网搜索：' + data.query, subtitle: data.source + ' · ' + data.results.length + ' 条', items: data.results }],
        modelData: { 关键词: data.query, 来源: data.source, 结果: data.results },
        summary: '检索「' + data.query + '」得到 ' + data.results.length + ' 条结果',
        elapsed: Date.now() - started
      };
    }

    if (name === 'web_fetch') {
      const data = await webFetch(a.url);
      return {
        cards: [{ type: 'web', title: '网页抓取', subtitle: data.url, items: [{ title: data.url, url: data.url, snippet: data.content.slice(0, 300) + '…' }] }],
        modelData: { 网址: data.url, 正文节选: data.content },
        summary: '已抓取网页 ' + data.url,
        elapsed: Date.now() - started
      };
    }

    throw new Error('未知工具：' + name);
  }

  /* ================= DeepSeek 请求层 ================= */

  function buildUserContent(text, images) {
    if (!images || !images.length) return text || '';
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    images.forEach((img) => {
      if (img && img.dataUrl) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    });
    if (!parts.length) return text || '';
    return parts;
  }

  function translateError(status, payload) {
    const msg = (payload && payload.error && (payload.error.message || payload.error.code)) || (payload && payload.message) || '';
    if (status === 401) return 'DeepSeek API Key 无效或已失效，请在「配置密钥」中重新填写';
    if (status === 402) return 'DeepSeek 账户余额不足，请前往开放平台充值后重试';
    if (status === 403) return 'DeepSeek 拒绝访问（403），请检查 Key 权限';
    if (status === 429) return '请求过于频繁（429），请稍后再试';
    if (status === 404) return '接口地址或模型不存在（404）：' + (msg || '请检查 Base URL');
    if (status === 400) {
      if (/image|vision|modality|content type/i.test(msg)) {
        return '当前模型不支持图片输入（' + msg + '）。图片识别需要具备视觉能力的 DeepSeek 模型，请在配置中填写对应的模型 ID。';
      }
      if (/model/i.test(msg)) {
        return '模型不可用：' + msg + '。请在「模型」下拉中选择账号支持的项，或点「拉取账号可用模型」自动填充';
      }
      if (/tool|unknown variant|deserialize|tool_choice/i.test(msg)) {
        return '当前模型不支持工具调用（' + msg + '），已自动降级重试；也可以手动关闭「智能体工具」开关';
      }
      return '请求参数有误：' + (msg || '400');
    }
    if (status >= 500) return 'DeepSeek 服务暂时不可用（' + status + '），请稍后重试';
    return msg || ('请求失败 HTTP ' + status);
  }

  async function streamComplete(opts) {
    const cfg = opts.cfg;
    const key = (cfg.deepseekKey || '').trim();
    if (!key) throw new Error('尚未配置 DeepSeek API Key，请点击「配置密钥」填写');
    const base = (cfg.deepseekBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    const model = App.store.activeModel(cfg);
    const temperature = Number(cfg.temperature);
    const body = {
      model,
      messages: opts.messages,
      stream: true,
      temperature: isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : 0.7
    };

    /* DeepSeek 的 tools 只接受 type: "function"，这里做一次严格过滤，避免整包请求被 400 拒绝 */
    const tools = (opts.tools || []).filter((t) => t && t.type === 'function' && t.function && t.function.name);
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const controller = new AbortController();
    let timeoutTimer = setTimeout(() => controller.abort(), 180000);
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort);
    }

    let res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timeoutTimer);
      if (e.name === 'AbortError') throw new Error(opts.signal && opts.signal.aborted ? '已停止生成' : '请求超时，请检查网络');
      throw new Error('网络请求失败：' + e.message + '（请检查 Base URL 与网络连通性）');
    }

    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch (e) { /* ignore */ }
      clearTimeout(timeoutTimer);
      const raw = payload ? JSON.stringify(payload) : '';
      /* 服务端明确告知可用模型名时，自动纠正一次（模型 ID 填错 / 旧模型下线） */
      if (res.status === 400 && !opts.noModelRetry) {
        const msgText = (payload && payload.error && payload.error.message) || (payload && payload.message) || raw;
        const sup = String(msgText).match(/supported API model names are\s*([^.。\n"]+)/i);
        if (sup) {
          const names = sup[1].split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
          const pick = names.find((n) => /pro/i.test(n)) || names[0];
          if (pick && pick !== model) {
            App.utils.toast('模型「' + model + '」不可用，已自动切换为「' + pick + '」', 'err', 5200);
            App.store.saveConfig({ deepseekModel: pick, deepseekModelCustom: '' });
            return streamComplete(Object.assign({}, opts, { cfg: App.store.readConfig(), noModelRetry: true }));
          }
        }
      }
      /* 兜底：接口/模型不支持 tools 时，去掉工具静默重试一次，避免整轮对话直接失败 */
      const toolsRejected = res.status === 400 && body.tools && !/model/i.test(raw) && /tool|unknown variant|deserialize|function|tool_choice/i.test(raw);
      if (toolsRejected && !opts.noToolsRetry) {
        App.utils.toast('当前模型不支持工具调用，已临时关闭智能体工具重试', 'err', 4200);
        return streamComplete(Object.assign({}, opts, { tools: [], enableSearch: false, noToolsRetry: true }));
      }
      throw new Error(translateError(res.status, payload));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let reasoning = '';
    const calls = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let json;
          try { json = JSON.parse(payload); } catch (e) { continue; }
          const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (opts.onReasoning) opts.onReasoning(delta.reasoning_content);
          }
          if (delta.content) {
            content += delta.content;
            if (opts.onDelta) opts.onDelta(delta.content);
          }
          if (delta.tool_calls) {
            delta.tool_calls.forEach((tc) => {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              if (!calls[idx]) calls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) calls[idx].id = tc.id;
              if (tc.function && tc.function.name) calls[idx].function.name += tc.function.name;
              if (tc.function && tc.function.arguments) calls[idx].function.arguments += tc.function.arguments;
            });
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('已停止生成');
      throw new Error('读取流式响应失败：' + e.message);
    } finally {
      clearTimeout(timeoutTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }

    const toolCalls = calls.filter(Boolean).map((c, i) => ({
      id: c.id || ('call_' + Date.now().toString(36) + i),
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments || '{}' }
    }));

    return { content, reasoning, toolCalls, model };
  }

  /* ================= 智能体循环 ================= */
  async function agentRun(opts) {
    const cfg = opts.cfg;
    const handlers = opts.handlers || {};
    const messages = opts.messages.slice();
    if (cfg.systemPrompt && cfg.systemPrompt.trim()) {
      const extra = ['当前时间：' + new Date().toLocaleString('zh-CN', { hour12: false })];
      if (cfg.city) extra.push('用户常用城市（无明确城市时的默认检索范围）：' + cfg.city);
      const hasImage = messages.some((m) => Array.isArray(m.content) &&
        m.content.some((p) => p && p.type === 'image_url'));
      if (hasImage) {
        extra.push('本条用户消息附带图片：请先识别画面中的地点、招牌文字、建筑或菜品特征，再决定是否需要调用高德工具补齐坐标、周边与路线。');
      }
      messages.unshift({ role: 'system', content: cfg.systemPrompt.trim() + '\n\n' + extra.join('\n') });
    }

    const cards = [];
    const trace = [];
    let text = '';
    let reasoning = '';
    let model = App.store.activeModel(cfg);

    for (let round = 0; round < 6; round++) {
      if (opts.signal && opts.signal.aborted) throw new Error('已停止生成');
      const result = await streamComplete({
        cfg,
        messages,
        tools: opts.enableTools
          ? TOOLS.filter((t) => (opts.enableSearch ? true : !/^web_/.test(t.function.name)))
          : [],
        enableSearch: !!opts.enableSearch,
        signal: opts.signal,
        onDelta: (d) => { text += d; if (handlers.onDelta) handlers.onDelta(d, round); },
        onReasoning: (d) => { reasoning += d; if (handlers.onReasoning) handlers.onReasoning(d, round); }
      });
      model = result.model;

      if (!result.toolCalls.length) break;

      messages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.toolCalls
      });

      for (let i = 0; i < result.toolCalls.length; i++) {
        const tc = result.toolCalls[i];
        const name = tc.function.name || 'unknown';
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }
        if (handlers.onToolStart) handlers.onToolStart({ name, args, round });

        try {
          const res = await App.ai.runTool(name, args);
          trace.push({ name, ok: true, summary: res.summary, elapsed: res.elapsed });
          if (res.cards && res.cards.length) {
            res.cards.forEach((c) => cards.push(c));
            if (handlers.onCards) handlers.onCards(res.cards, trace);
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(res.modelData)
          });
          if (handlers.onToolEnd) handlers.onToolEnd({ name, ok: true, summary: res.summary, elapsed: res.elapsed, trace: trace.slice() });
        } catch (err) {
          const msg = err && err.message ? err.message : '工具执行失败';
          trace.push({ name, ok: false, summary: msg, elapsed: 0 });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ 错误: msg }) });
          if (handlers.onToolEnd) handlers.onToolEnd({ name, ok: false, error: msg, trace: trace.slice() });
        }
      }
    }

    return { text, reasoning, cards, trace, messages, model };
  }

  async function listModels(cfg) {
    const key = (cfg.deepseekKey || '').trim();
    if (!key) throw new Error('请先填写 DeepSeek API Key');
    const base = (cfg.deepseekBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    const data = await U.fetchJSON(base + '/models', {
      headers: { Authorization: 'Bearer ' + key }
    }, 20000);
    return (data.data || []).map((m) => m.id).filter(Boolean);
  }

  async function testConnection(cfg) {
    const models = await listModels(cfg);
    return models;
  }

  App.ai = { TOOLS, runTool, webSearch, webFetch, agentRun, streamComplete, buildUserContent, listModels, testConnection, translateError };
})(window);
