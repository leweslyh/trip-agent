/* DeepSeek 大模型客户端 + 工具定义 + 智能体循环 */
(function (global) {
  'use strict';

  const LS = { key: 'ds.key', base: 'ds.base', model: 'ds.model' };

  function getLS(k, d) {
    try { return localStorage.getItem(k) || d || ''; } catch (e) { return d || ''; }
  }
  function setLS(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* ignore */ }
  }

  const cfg = {
    get key() { return getLS(LS.key); },
    set key(v) { setLS(LS.key, (v || '').trim()); },
    get base() { return (getLS(LS.base, 'https://api.deepseek.com')).replace(/\/+$/, ''); },
    set base(v) { setLS(LS.base, (v || '').trim()); },
    get model() { return getLS(LS.model, 'deepseek-chat'); },
    set model(v) { setLS(LS.model, (v || '').trim()); }
  };

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'search_keywords',
        description: '按关键词搜索地点/POI，例如「西湖」「北京大学」「某连锁咖啡」。适合用户明确说出地点名称或类型时使用。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词' },
            city: { type: 'string', description: '限定城市名或 adcode，可省略' },
            citylimit: { type: 'boolean', description: '是否只返回该城市内的结果' }
          },
          required: ['keywords']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_nearby',
        description: '以某个坐标为中心做周边搜索，找附近餐厅、酒店、加油站、医院等。用户说「附近/周边」时使用。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '关键词，可为空表示不限类型' },
            location: { type: 'string', description: '中心点坐标，格式 "经度,纬度"；省略则用用户当前位置' },
            radius: { type: 'number', description: '搜索半径（米），100-50000，默认 2000' },
            types: { type: 'string', description: '高德 POI 类型码，如 050000 餐饮、100000 住宿，可省略' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan_route',
        description: '规划两点之间的路线，支持驾车、步行、骑行、公交。起点终点可以是「经度,纬度」或地名。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['driving', 'walking', 'bicycling', 'transit'], description: '出行方式' },
            origin: { type: 'string', description: '起点坐标或地名' },
            destination: { type: 'string', description: '终点坐标或地名' },
            city: { type: 'string', description: '公交规划所在城市，可省略（会自动识别）' }
          },
          required: ['mode', 'origin', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_weather',
        description: '查询城市实时天气和未来几天预报。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名（如 北京）或 6 位 adcode；省略则用用户当前城市' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_static_map',
        description: '生成一张静态地图图片展示给用户，可标注多个地点。用户想看地图、要标注位置时使用。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '地图标题，如「西湖周边咖啡馆」' },
            points: {
              type: 'array',
              description: '要在地图上标注的点，最多 4 个',
              items: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: '坐标 "经度,纬度" 或地名' },
                  name: { type: 'string', description: '地点名称' }
                },
                required: ['location']
              }
            },
            zoom: { type: 'number', description: '缩放级别 3-18，可省略自动计算' }
          },
          required: ['points']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'locate_ip',
        description: '通过 IP 定位用户所在城市与大致坐标，用户问「我在哪」或需要当前位置时使用。',
        parameters: {
          type: 'object',
          properties: { ip: { type: 'string', description: '指定 IP，省略表示当前访问 IP' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'geocode_address',
        description: '把详细地址解析成经纬度坐标，用于路径规划前确认地点。',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '结构化地址，如「北京市朝阳区阜通东大街6号」' },
            city: { type: 'string', description: '城市名，可省略' }
          },
          required: ['address']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'reverse_geocode',
        description: '把经纬度反查成详细地址，用于说明某个坐标在哪。',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string', description: '坐标 "经度,纬度"' } },
          required: ['location']
        }
      }
    }
  ];

  function buildSystemPrompt(ctx) {
    const c = ctx || {};
    const lines = [
      '你是「出行小助手」，一个中文出行规划智能体，可以调用高德开放平台的地图能力。',
      '当前时间：' + (c.now || new Date().toLocaleString('zh-CN')),
      c.city ? '用户当前城市（IP 定位）：' + c.city : '用户当前城市未知',
      c.location ? '用户当前坐标：' + c.location : '用户当前坐标未知',
      '',
      '工作规则：',
      '1. 用户提到「附近/周边」但没有给坐标时，先调用 locate_ip 获取当前位置，再调用 search_nearby。',
      '2. 需要坐标而用户只给了地名时，直接让 plan_route / search_nearby 处理地名，或先 geocode_address。',
      '3. 搜索、路线、天气、定位的结果都要口头总结给用户：先说结论，再列关键信息（距离、耗时、地址、电话）。',
      '4. 涉及位置或路线时，主动调用 show_static_map 把结果画在地图上（最多 4 个标注点）。',
      '5. POI 列表最多列 5 条，按距离或相关性排序，不要堆砌原始字段。',
      '6. 距离、时间要用自然语言表述（如「约 12.4 公里，驾车 28 分钟」）。',
      '7. 不要编造接口没返回的信息（如评分、营业时间、电话）。接口失败时如实说明并给出替代建议。',
      '8. 回答简洁，使用 Markdown 列表，不要输出大段 JSON。'
    ];
    return lines.join('\n');
  }

  async function streamChat(messages, handlers) {
    const h = handlers || {};
    if (!cfg.key) throw new Error('请先在「设置」中填写 DeepSeek API Key');

    let res;
    try {
      res = await fetch(cfg.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.3,
          stream: true
        }),
        signal: h.signal
      });
    } catch (err) {
      throw new Error('无法连接 DeepSeek 接口（' + cfg.base +
        '），可能是跨域或网络限制。可在「设置」中改为可跨域访问的兼容接口地址，或检查网络。');
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
      throw new Error('DeepSeek 接口错误 ' + res.status + (detail ? '：' + detail : ''));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    const calls = [];

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};

        if (delta.content) {
          content += delta.content;
          if (h.onText) h.onText(delta.content);
        }
        if (delta.tool_calls) {
          delta.tool_calls.forEach(function (tc) {
            const i = tc.index === undefined ? 0 : tc.index;
            if (!calls[i]) calls[i] = { id: '', name: '', args: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function && tc.function.name && !calls[i].name) calls[i].name = tc.function.name;
            if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments;
          });
        }
      }
    }

    return { content: content, toolCalls: calls.filter(function (c) { return c && c.name; }) };
  }

  function parseArgs(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  /**
   * 智能体循环：模型 -> 工具 -> 模型 ... 直到给出最终回答
   */
  async function run(opts) {
    const messages = opts.messages;
    const execute = opts.execute;
    const onEvent = opts.onEvent || function () {};
    const maxRounds = opts.maxRounds || 6;

    for (let round = 0; round < maxRounds; round++) {
      const result = await streamChat(messages, {
        signal: opts.signal,
        onText: function (t) { onEvent({ type: 'text', text: t }); }
      });

      const assistant = { role: 'assistant', content: result.content || '' };
      if (result.toolCalls.length) {
        assistant.tool_calls = result.toolCalls.map(function (c) {
          return { id: c.id || 'call_' + Math.random().toString(36).slice(2), type: 'function', function: { name: c.name, arguments: c.args || '{}' } };
        });
      }
      messages.push(assistant);

      if (!result.toolCalls.length) {
        onEvent({ type: 'done', content: result.content });
        return { messages: messages, content: result.content };
      }

      onEvent({ type: 'round' });

      for (const tc of assistant.tool_calls) {
        const args = parseArgs(tc.function.arguments);
        onEvent({ type: 'tool-start', name: tc.function.name, args: args });
        let output;
        try {
          const data = await execute(tc.function.name, args);
          output = { ok: true, data: data };
        } catch (err) {
          output = { ok: false, error: (err && err.message) || String(err) };
        }
        onEvent({ type: 'tool-result', name: tc.function.name, args: args, output: output });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toModelPayload(output)).slice(0, 14000)
        });
      }
    }

    onEvent({ type: 'done', content: '' });
    return { messages: messages, content: '' };
  }

  // 精简喂给模型的字段，避免超长（去掉折线等）
  function toModelPayload(output) {
    if (!output.ok) return { ok: false, error: output.error };
    const d = JSON.parse(JSON.stringify(output.data || {}));
    if (d.polylines) d.polylines = '（已在地图上展示，省略）';
    if (d.pois) {
      d.pois = d.pois.slice(0, 8).map(function (p) {
        return {
          name: p.name, address: p.address, distance: p.distance,
          tel: p.tel, type: p.type, location: p.location
        };
      });
    }
    if (d.steps) d.steps = d.steps.slice(0, 12).map(function (s) {
      return { instruction: s.instruction, distance: s.distance, duration: s.duration };
    });
    return { ok: true, data: d };
  }

  global.DeepSeek = {
    cfg: cfg,
    tools: TOOLS,
    buildSystemPrompt: buildSystemPrompt,
    streamChat: streamChat,
    run: run
  };
})(window);
