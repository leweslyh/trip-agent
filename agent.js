(function (global) {
  'use strict';

  var SYSTEM_PROMPT = [
    '你是「行知 TripMind」，一个专业、友好的中文出行智能助手。你的「大脑」是大模型，「手脚」是下面可用的高德地图工具。',
    '',
    '工作规则：',
    '1. 涉及地点、周边、路线、天气、地图、IP 所在地等实时地理信息时，必须调用对应工具获取真实数据，严禁凭记忆编造地址、距离、天气、耗时。',
    '2. 用户未说明城市时，工具会使用默认城市；若用户描述的地点明显属于其他城市，请从上下文推断并把城市传给工具。',
    '3. 调用工具时参数要完整准确。地点名称使用用户原话；坐标格式为「经度,纬度」。',
    '4. 路径规划的 mode 只能是 driving（驾车）、walking（步行）、transit（公交地铁）、riding（骑行）；公交规划务必传 city。',
    '5. 用户想「看看地图 / 展示位置 / 在地图上标记」时，调用 show_static_map。',
    '6. 工具返回数据后，用自然简洁的中文总结关键信息：地点给出名称和地址；路线给出推荐方案的时长、距离与关键转向；天气给出实况与未来趋势；IP 给出省市。',
    '7. 工具报错时如实告知用户并给出重试建议，不要虚构结果。',
    '8. 不要输出工具调用的原始 JSON，不要输出思考过程。使用简短段落或列表，尽量控制在 200 字以内（用户要求详细时除外）。'
  ].join('\n');

  var TOOLS = [
    {
      type: 'function',
      function: {
        name: 'search_place',
        description: '高德关键字搜索：根据关键词搜索地点、POI、地址，返回名称、地址、坐标、距离等。适合「去哪找某地点」「搜索 XX」等需求。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '搜索关键词，例如「故宫博物院」「火锅」「停车场」' },
            city: { type: 'string', description: '查询城市名称或 adcode，例如「北京」。用户未指定时可留空使用默认城市。' }
          },
          required: ['keywords']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_nearby',
        description: '高德周边搜索：以某个地点或坐标为中心，搜索附近指定范围内的 POI。适合「附近」「周边」「旁边」等需求。',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'string', description: '周边要找的类别或关键词，如「咖啡馆」「地铁站」；留空表示搜索全部周边 POI' },
            location: { type: 'string', description: '中心点地点名称或「经度,纬度」坐标，例如「天安门」或「116.397,39.909」' },
            radius: { type: 'integer', description: '搜索半径，单位米，默认 3000，最大 50000' },
            city: { type: 'string', description: '可选，中心点所在城市名称' }
          },
          required: ['location']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan_route',
        description: '高德路径规划：规划驾车、步行、公交地铁或骑行路线，返回距离、耗时、换乘或转向步骤与路线地图。',
        parameters: {
          type: 'object',
          properties: {
            origin: { type: 'string', description: '起点名称或「经度,纬度」坐标' },
            destination: { type: 'string', description: '终点名称或「经度,纬度」坐标' },
            mode: { type: 'string', enum: ['driving', 'walking', 'transit', 'riding'], description: '出行方式，默认 driving' },
            city: { type: 'string', description: '公交/地铁规划必须提供城市名称；跨城驾车可留空' }
          },
          required: ['origin', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_weather',
        description: '高德天气查询：查询城市实时天气与未来 3-4 天预报。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名称、adcode 或「经度,纬度」坐标；用户未说明时可留空使用默认城市' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_static_map',
        description: '高德静态地图：生成带标记的静态地图图片。当用户要求「看看地图」「展示位置」「标记在哪里」时调用。',
        parameters: {
          type: 'object',
          properties: {
            place: { type: 'string', description: '地图中心地点名称或「经度,纬度」坐标' },
            zoom: { type: 'integer', description: '缩放级别 3-17，默认 14' },
            markers: {
              type: 'array',
              description: '可选，额外标记点数组',
              items: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: '标记点地点名称或「经度,纬度」坐标' },
                  label: { type: 'string', description: '标记文字，如 A、B' },
                  color: { type: 'string', description: '十六进制颜色，如 0xff0000' }
                },
                required: ['location']
              }
            }
          },
          required: ['place']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_ip_location',
        description: '高德 IP 定位：根据 IP 地址查询所在省市。不传 ip 时定位当前网页访问者。',
        parameters: {
          type: 'object',
          properties: {
            ip: { type: 'string', description: '可选，IPv4 地址；留空则定位当前用户' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'geocode',
        description: '地理编码：把地点名称转换成「经度,纬度」坐标。当用户只想知道坐标，或需要为地图、路线准备坐标时调用。',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '地点或地址名称' },
            city: { type: 'string', description: '可选，所在城市名称' }
          },
          required: ['address']
        }
      }
    }
  ];

  var LABELS = {
    search_place: '关键字搜索',
    search_nearby: '周边搜索',
    plan_route: '路径规划',
    query_weather: '天气查询',
    show_static_map: '静态地图',
    get_ip_location: 'IP 定位',
    geocode: '地理编码'
  };

  var EXECUTORS = {
    search_place: function (a) { return global.Amap.searchPlace(a.keywords, a.city); },
    search_nearby: function (a) { return global.Amap.searchNearby(a.keywords, a.location, a.radius, a.city); },
    plan_route: function (a) { return global.Amap.planRoute(a.origin, a.destination, a.mode, a.city); },
    query_weather: function (a) { return global.Amap.getWeather(a.city); },
    show_static_map: function (a) { return global.Amap.showStaticMap(a.place, a.markers, a.zoom); },
    get_ip_location: function (a) { return global.Amap.getIpLocation(a.ip); },
    geocode: function (a) {
      return global.Amap.geocode(a.address, a.city).then(function (r) {
        return {
          type: 'geocode',
          address: a.address,
          location: r.location,
          formatted: r.formatted,
          adcode: r.adcode,
          province: r.province,
          city: r.city,
          mapUrl: global.Amap.staticMapUrl({ center: r.location, zoom: 15, markers: [{ location: r.location, label: '位', color: '0x6d5efc' }] })
        };
      });
    }
  };

  var PROVIDERS = [
    {
      name: 'DeepSeek',
      url: 'https://api.deepseek.com/chat/completions',
      key: function () { return global.Config.get('deepseekKey'); },
      models: ['deepseek-chat']
    },
    {
      name: '硅基流动',
      url: 'https://api.siliconflow.cn/v1/chat/completions',
      key: function () { return global.Config.get('siliconflowKey'); },
      models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct']
    }
  ];

  function emit(onEvent, payload) {
    if (typeof onEvent === 'function') onEvent(payload);
  }

  function requestModel(url, apiKey, model, messages) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 1800,
        stream: false
      })
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (txt) {
          throw new Error('HTTP ' + resp.status + '：' + String(txt || '').slice(0, 180));
        });
      }
      return resp.json();
    }).then(function (json) {
      if (!json || !json.choices || !json.choices.length) throw new Error('接口未返回有效结果');
      return json;
    });
  }

  function callLLM(messages, onEvent) {
    var errors = [];
    var chain = [];

    PROVIDERS.forEach(function (p) {
      var key = p.key();
      if (!key) return;
      p.models.forEach(function (model) {
        chain.push({ name: p.name, url: p.url, key: key, model: model });
      });
    });

    if (!chain.length) return Promise.reject(new Error('尚未配置大模型密钥，请在设置中填写。'));

    function next(i) {
      if (i >= chain.length) {
        return Promise.reject(new Error('所有大模型引擎均不可用：' + errors.join(' | ')));
      }
      var cfg = chain[i];
      emit(onEvent, { type: 'engine-try', name: cfg.name, model: cfg.model });
      return requestModel(cfg.url, cfg.key, cfg.model, messages).then(function (data) {
        emit(onEvent, { type: 'engine-ok', name: cfg.name, model: cfg.model });
        return { data: data, provider: cfg.name };
      }).catch(function (err) {
        errors.push(cfg.name + '(' + cfg.model + '): ' + err.message);
        emit(onEvent, { type: 'engine-fail', name: cfg.name, error: err.message });
        return next(i + 1);
      });
    }
    return next(0);
  }

  function executeTool(name, args) {
    var fn = EXECUTORS[name];
    if (!fn) return Promise.resolve({ ok: false, error: '未知工具：' + name });
    try {
      return Promise.resolve(fn(args || {})).then(function (data) {
        return { ok: true, data: data };
      }).catch(function (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      });
    } catch (e) {
      return Promise.resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  function run(userText, history, onEvent) {
    var messages = [{ role: 'system', content: SYSTEM_PROMPT }]
      .concat(history || [])
      .concat([{ role: 'user', content: userText }]);

    function loop(iter) {
      if (iter > 6) {
        return Promise.resolve({ text: '抱歉，工具调用次数过多，请简化问题后重试。', provider: '' });
      }
      return callLLM(messages, onEvent).then(function (res) {
        var msg = res.data.choices[0].message || {};
        var calls = msg.tool_calls || [];
        var outgoing = { role: 'assistant', content: msg.content || '' };
        if (calls.length) {
          outgoing.tool_calls = calls.map(function (c) {
            return {
              id: c.id,
              type: 'function',
              function: {
                name: (c.function || {}).name || '',
                arguments: (c.function || {}).arguments || '{}'
              }
            };
          });
        }
        messages.push(outgoing);

        if (!calls.length) {
          var text = msg.content || '';
          if (!text.trim()) text = '抱歉，这次没有生成有效内容，请再试一次。';
          return { text: text, provider: res.provider };
        }

        var chain = Promise.resolve();
        calls.forEach(function (call) {
          chain = chain.then(function () {
            var fn = call.function || {};
            var name = fn.name || 'unknown';
            var args = {};
            try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }
            var meta = {
              id: call.id,
              name: name,
              label: LABELS[name] || name,
              args: args
            };
            emit(onEvent, Object.assign({ type: 'tool-start' }, meta));
            return executeTool(name, args).then(function (result) {
              emit(onEvent, Object.assign({ type: 'tool-end', result: result }, meta));
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result)
              });
            });
          });
        });
        return chain.then(function () { return loop(iter + 1); });
      });
    }

    return loop(0);
  }

  function testLLM() {
    return callLLM([{ role: 'user', content: '请只回复两个字：正常' }]).then(function (res) {
      return { ok: true, message: '大模型连接正常（' + res.provider + '）' };
    });
  }

  global.Agent = {
    run: run,
    testLLM: testLLM,
    TOOLS: TOOLS,
    LABELS: LABELS
  };
})(window);
