/* 出行小助手 - DeepSeek 智能体（Function Calling） */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'keyword_search',
      description: '按关键字搜索地点/POI。如"搜索北京的咖啡店"、"帮我找故宫"。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键字' },
          city: { type: 'string', description: '城市名称或adcode，可选' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'surrounding_search',
      description: '周边搜索：在某地点周围指定半径内搜索某类型地点。如"天安门周边2公里的餐厅"。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '地点类型，如"餐厅"、"酒店"' },
          center: { type: 'string', description: '中心地点，地名或"lng,lat"' },
          radius: { type: 'number', description: '半径，单位米，默认2000' }
        },
        required: ['keyword', 'center']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'route_planning',
      description: '路径规划。如"从天安门开车到颐和园怎么走"。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '起点，地名或坐标' },
          destination: { type: 'string', description: '终点，地名或坐标' },
          mode: { type: 'string', enum: ['driving', 'walking', 'transit', 'riding'], description: 'driving驾车/walking步行/transit公交地铁/riding骑行' }
        },
        required: ['origin', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'weather_query',
      description: '查询某城市天气（实时+预报）。如"北京今天天气怎么样"。',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名称或adcode' } },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'static_map',
      description: '生成并展示某地点的静态地图图片。如"展示天安门的静态地图"。',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '地点名称或"lng,lat"' },
          zoom: { type: 'number', description: '缩放级别3-18，默认15' }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ip_location',
      description: 'IP定位：获取当前用户所在城市和位置。如"我现在在哪个城市"。',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const SYSTEM_PROMPT =
  '你是专业的出行小助手智能体，基于高德地图提供服务。' +
  '可调用工具完成：关键字搜索、周边搜索、路径规划、天气查询、静态地图展示、IP定位。' +
  '根据用户自然语言判断意图并调用合适工具，再用简洁友好的中文总结结果。无合适工具时直接友好回答，回答简短精炼。';

async function callDeepSeek(messages) {
  const cfg = getConfig();
  const res = await fetch(cfg.deepseekUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.deepseekKey },
    body: JSON.stringify({ model: cfg.deepseekModel, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.6 })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`DeepSeek API 请求失败 (${res.status})：${t}`);
  }
  return res.json();
}

function toolLabel(name, args) {
  const m = {
    keyword_search: `关键字搜索「${args.keyword || ''}」`,
    surrounding_search: `周边搜索「${args.keyword || ''}」`,
    route_planning: `路径规划 ${args.origin || ''} → ${args.destination || ''}`,
    weather_query: `查询「${args.city || ''}」天气`,
    static_map: `生成「${args.location || ''}」静态地图`,
    ip_location: 'IP定位'
  };
  return m[name] || name;
}

async function runAgent(userText) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversation, { role: 'user', content: userText }];
  for (let i = 0; i < 5; i++) {
    const data = await callDeepSeek(messages);
    const msg = data.choices[0].message;
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        let args = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }
        addAssistantNote('正在执行：' + toolLabel(fn.name, args));
        const result = await executeTool(fn.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    } else {
      return msg.content || '（无回复内容）';
    }
  }
  return '处理过程较长，请简化需求后重试。';
}
