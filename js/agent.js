/**
 * agent.js —— DeepSeek 智能体主循环（Function Calling）
 *
 * 流程：用户输入 -> 请求 DeepSeek（携带工具定义）-> 模型返回 tool_calls
 *      -> 本地调用高德工具 -> 结果回填 -> 再次请求 -> 直到模型给出最终回答
 */
(function (global) {
  'use strict';

  var history = [];          // 对话历史（不含 system）
  var MAX_ROUNDS = 5;        // 单次提问最多工具循环轮数
  var MAX_HISTORY = 30;      // 历史消息条数上限

  function systemPrompt() {
    var city = global.AMapKit ? (AMapKit.getCity() || '未知') : '未知';
    var loc = global.AMapKit && AMapKit.state.currentLocation;
    return [
      '你是「出行小助手」，一个中文出行规划智能体，可以调用高德开放平台的地图能力。',
      '当前时间：' + Util.now() + '；当前城市：' + city + '；',
      '已获取的用户位置：' + (loc && loc.lnglat ? (loc.name + '（' + loc.lnglat.join(',') + '）') : '暂无'),
      '',
      '工作原则：',
      '1. 凡是涉及具体地点、周边、路线、天气、定位的问题，必须先调用工具获取真实数据，绝不编造 POI、距离、耗时或天气。',
      '2. 用户一句话里有多个需求时，可以连续调用多个工具逐个完成。',
      '3. 需要用户当前位置作为起点/中心时，参数直接传「当前位置」即可。',
      '4. 最终回答使用简体中文 + Markdown（小标题、列表），简洁清晰，突出关键数据：距离、耗时、温度、地址、电话。',
      '5. 工具返回的 JSON 是内部数据，不要原样粘贴给用户，要转述成人话。',
      '6. 工具失败时如实说明原因，并给出替代建议（如换个关键字、补充城市名），不要假装成功。',
      '7. 结尾用一句话提示用户可在地图上查看结果。'
    ].join('\n');
  }

  function trimHistory() {
    if (history.length <= MAX_HISTORY) return;
    // 从第 2 条开始裁剪，避免把 tool 消息和它的 assistant 消息拆开
    var cut = history.length - MAX_HISTORY;
    while (cut < history.length && history[cut].role === 'tool') cut++;
    history = history.slice(cut);
  }

  function buildMessages() {
    var msgs = [{ role: 'system', content: systemPrompt() }];
    history.forEach(function (m) {
      var item = { role: m.role, content: m.content == null ? '' : String(m.content) };
      if (m.tool_calls) item.tool_calls = m.tool_calls;
      if (m.tool_call_id) item.tool_call_id = m.tool_call_id;
      if (m.name) item.name = m.name;
      msgs.push(item);
    });
    return msgs;
  }

  function callModel(signal) {
    var cfg = Store.get();
    if (!cfg.deepseekKey) {
      return Promise.reject(new Error('未配置 DeepSeek API Key，请点击右上角「API 设置」填写'));
    }
    var url = cfg.deepseekBase + '/chat/completions';
    var body = {
      model: cfg.deepseekModel || 'deepseek-chat',
      messages: buildMessages(),
      temperature: 0.3,
      max_tokens: 1600,
      stream: false
    };
    if (global.ToolKit && ToolKit.definitions.length) {
      body.tools = ToolKit.definitions;
      body.tool_choice = 'auto';
    }

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.deepseekKey
      },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (resp) {
      return resp.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        if (!resp.ok) {
          var msg = data && data.error && data.error.message ? data.error.message : text.slice(0, 200);
          throw new Error('DeepSeek 接口错误（' + resp.status + '）：' + msg);
        }
        if (!data) throw new Error('DeepSeek 返回内容无法解析');
        if (!data.choices || !data.choices.length) throw new Error('DeepSeek 未返回结果');
        return data.choices[0].message || {};
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
      if (err && /Failed to fetch|NetworkError|Load failed/i.test(err.message || '')) {
        throw new Error('无法连接 DeepSeek 接口：可能是网络问题或浏览器跨域限制，可在设置中更换为可用代理地址');
      }
      throw err;
    });
  }

  /**
   * 发送一条用户消息，跑完整个工具循环
   * @param {string} text
   * @param {{onToolStart:Function,onToolEnd:Function,onStatus:Function}} handlers
   */
  function send(text, handlers) {
    handlers = handlers || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 90000);

    history.push({ role: 'user', content: text });
    trimHistory();

    var round = 0;

    function loop() {
      round++;
      if (handlers.onStatus) handlers.onStatus(round === 1 ? '思考中…' : '整理结果…');
      return callModel(controller.signal).then(function (msg) {
        var toolCalls = msg.tool_calls || [];
        var content = msg.content || '';

        if (!toolCalls.length) {
          clearTimeout(timer);
          history.push({ role: 'assistant', content: content || '（模型没有返回内容）' });
          trimHistory();
          return content || '抱歉，我这次没有组织出答案，可以换个说法再问一次吗？';
        }

        history.push({ role: 'assistant', content: content, tool_calls: toolCalls });

        // 串行执行工具，保证地图渲染顺序稳定
        return toolCalls.reduce(function (chain, tc) {
          return chain.then(function () {
            var name = tc.function && tc.function.name;
            var meta = ToolKit.meta(name);
            if (handlers.onToolStart) handlers.onToolStart({ id: tc.id, name: name, meta: meta, args: tc.function.arguments });

            return ToolKit.execute(name, tc.function && tc.function.arguments).then(function (res) {
              if (handlers.onToolEnd) handlers.onToolEnd({ id: tc.id, name: name, meta: meta, res: res });
              history.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ ok: !!res.ok, brief: res.brief, data: res.data })
              });
            });
          });
        }, Promise.resolve()).then(function () {
          if (round >= MAX_ROUNDS) {
            clearTimeout(timer);
            var fallback = '我已经完成了 ' + round + ' 轮工具查询，信息都在上面的地图和卡片里了。需要我继续补充吗？';
            history.push({ role: 'assistant', content: fallback });
            return fallback;
          }
          return loop();
        });
      });
    }

    return loop().catch(function (err) {
      clearTimeout(timer);
      // 出错时回滚最后一条用户消息，避免历史被污染
      if (history.length && history[history.length - 1].role === 'user') history.pop();
      throw err;
    });
  }

  global.Agent = {
    send: send,
    reset: function () { history = []; },
    getHistory: function () { return history.slice(); }
  };
})(window);
