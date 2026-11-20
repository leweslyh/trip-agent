/* ============================================================
 * DeepSeek-V4.1 接口层
 * - 流式对话（SSE），解析 content / reasoning_content / tool_calls
 * - 智能体工具回环：本地执行高德工具后继续对话
 * - 联网能力：调用 DeepSeek 原生 deepseek_web_search / deepseek_read_url
 * ============================================================ */
(function (global) {
  'use strict';

  const BASE = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-flash';

  const cfg = { apiKey: '', model: DEFAULT_MODEL, effort: 'high', thinking: true };

  function setConfig(next) { Object.assign(cfg, next || {}); }
  function getConfig() { return { ...cfg }; }

  /* ---------- 通用请求 ---------- */
  async function postJSON(path, body, signal) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) { /* ignore */ }
      throw new Error(`DeepSeek 接口 ${res.status}：${trimErr(detail) || res.statusText}`);
    }
    return res.json();
  }

  function trimErr(t) {
    try {
      const j = JSON.parse(t);
      return j.error && (j.error.message || j.error.code) || t.slice(0, 200);
    } catch (_) { return String(t || '').slice(0, 200); }
  }

  /* ---------- 流式对话 ---------- */
  /**
   * @param {object} opt {messages, tools, toolChoice, model, effort, thinking, signal,
   *                      onContent, onReasoning, onToolCalls(finalCalls), onFinish}
   */
  async function streamChat(opt) {
    const body = {
      model: opt.model || cfg.model,
      messages: opt.messages,
      stream: true,
      max_tokens: opt.maxTokens || 8000,
      thinking: { type: opt.thinking === false ? 'disabled' : 'enabled' },
    };
    if (opt.effort) body.reasoning_effort = opt.effort;
    if (opt.tools && opt.tools.length) {
      body.tools = opt.tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: opt.signal,
    });

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) { /* ignore */ }
      throw new Error(`DeepSeek 接口 ${res.status}：${trimErr(detail) || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finish = null;
    const calls = {};
    let usage = null;

    const handle = (payload) => {
      const choice = (payload.choices || [])[0];
      if (!choice) { if (payload.usage) usage = payload.usage; return; }
      const d = choice.delta || {};
      if (d.content) { content += d.content; opt.onContent && opt.onContent(d.content); }
      if (d.reasoning_content) { reasoning += d.reasoning_content; opt.onReasoning && opt.onReasoning(d.reasoning_content); }
      (d.tool_calls || []).forEach((tc) => {
        const i = tc.index || 0;
        if (!calls[i]) calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        const f = tc.function || {};
        if (f.name) calls[i].function.name = f.name;
        if (f.arguments) calls[i].function.arguments += f.arguments;
      });
      if (choice.finish_reason) finish = choice.finish_reason;
      if (payload.usage) usage = payload.usage;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { handle(JSON.parse(data)); } catch (_) { /* 忽略半包 */ }
      }
    }

    const toolCalls = Object.keys(calls).sort((a, b) => a - b).map((k) => calls[k]);
    return { content, reasoning, finish, toolCalls, usage };
  }

  /* ---------- DeepSeek 原生联网搜索 / 网页抓取 ---------- */
  async function nativeWebCall(userText, toolType, signal) {
    const data = await postJSON('/chat/completions', {
      model: cfg.model === 'deepseek-v4-pro' ? 'deepseek-flash' : cfg.model,
      messages: [
        { role: 'system', content: '你是检索助手。请使用联网工具获取真实信息，输出结构化要点，保留关键数字与时间，语言简洁。不要编造。' },
        { role: 'user', content: userText },
      ],
      tools: [{ type: toolType }],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      max_tokens: 3000,
    }, signal);

    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const sources = [];
    (msg.annotations || []).forEach((a) => {
      if (a.type === 'url_citation' && a.url_citation) {
        sources.push({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url });
      }
    });
    ((msg.server_tool_calls) || []).forEach((c) => {
      // 结构可能是 { calls:[{sources:[...]}] }，也兼容直接带 sources 的情况
      const callList = Array.isArray(c.calls) ? c.calls : [c];
      callList.forEach((cc) => {
        (cc.sources || []).forEach((s) => {
          if (s.url) sources.push({ title: s.title || s.url, url: s.url, site: s.site_name, snippet: s.snippet, date: s.published_at });
        });
      });
    });
    const uniq = [];
    const seen = new Set();
    sources.forEach((s) => { if (!seen.has(s.url)) { seen.add(s.url); uniq.push(s); } });
    return { text: msg.content || '', sources: uniq.slice(0, 8) };
  }

  const webSearch = (query, signal) =>
    nativeWebCall(`请联网搜索并回答：${query}\n\n要求：给出 3-5 条要点，包含关键事实、数字、时间；若涉及政策/活动/营业信息，注明信息来源。`, 'deepseek_web_search', signal);

  const readUrl = (url, signal) =>
    nativeWebCall(`请阅读并总结这个链接的内容：${url}\n\n要求：提取核心信息与关键结论，200 字以内。`, 'deepseek_read_url', signal);

  /* ---------- 智能体循环 ---------- */
  const MAX_ROUNDS = 6;

  function webTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: '联网搜索（DeepSeek 原生搜索）：用于查询最新资讯、政策、活动、实时营业信息等模型不确定的内容。',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '搜索问题，尽量具体' } },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_url',
          description: '网页抓取（DeepSeek 原生 URL 阅读）：读取并总结指定网页链接的正文内容。',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '要阅读的完整网页地址' } },
            required: ['url'],
          },
        },
      },
    ];
  }

  function buildSystemPrompt(ctx) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} 星期${'日一二三四五六'[now.getDay()]}`;
    const loc = ctx.location
      ? `用户当前位置：${ctx.location.city || '未知城市'}${ctx.location.address ? '，' + ctx.location.address : ''}，坐标 ${ctx.location.lng},${ctx.location.lat}（来源：${ctx.location.source || '定位'}）`
      : '用户当前位置：暂未获取到，可在需要时调用 amap_ip_location。';

    return `你是「出行小助手」，一个基于 DeepSeek-V4.1 与高德开放平台的出行智能体，说话干脆、靠谱、有人情味。

当前时间：${timeStr}
${loc}

工作规则：
1. 涉及真实地点、距离、电话、评分、天气、路线时，必须先调用工具获取，严禁编造。
2. 用户说“附近/我在哪/怎么去”且上下文已有坐标时，直接用该坐标作为中心或起点，不要重复询问。
3. 路线规划：先用地名调用 amap_route_plan（工具会自动地理编码），结果用「距离 + 耗时 + 1-2 条关键走法」概括，不要罗列全部路段。
4. 需要最新资讯、政策、活动、实时营业状态时调用 web_search；用户给了链接要你读，调用 read_url。
5. 地图、POI 列表、天气、路线卡片已由界面自动渲染，正文中不要重复贴经纬度或原始 JSON。
6. 回答用简体中文 + Markdown：先给结论，再给 2-4 条要点，可加一句贴心提示（天气/交通/时间）。控制在 350 字内，除非用户要求详细。
7. 工具失败时说明原因并提供替代方案，不要假装成功。`;
  }

  function toApiMessages(history, systemPrompt) {
    const msgs = [{ role: 'system', content: systemPrompt }];
    history.forEach((m) => {
      if (m.role === 'user') {
        if (m.images && m.images.length) {
          msgs.push({
            role: 'user',
            content: [
              { type: 'text', text: m.text || '请看这张图片' },
              ...m.images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
            ],
          });
        } else {
          msgs.push({ role: 'user', content: m.text || '' });
        }
      } else if (m.role === 'assistant' && m.text) {
        msgs.push({ role: 'assistant', content: m.text });
      }
    });
    return msgs;
  }

  /**
   * 运行一轮智能体对话
   * @param {object} opt {history, ctx:{location}, tools:[], enableWeb, enableAmap, signal, on{...}}
   */
  async function runAgent(opt) {
    const tools = [];
    if (opt.enableAmap !== false && global.AMapAPI && global.AMapAPI.hasKey()) {
      tools.push(...global.AMapAPI.TOOLS);
    }
    if (opt.enableWeb !== false) tools.push(...webTools());

    const messages = toApiMessages(opt.history, buildSystemPrompt(opt.ctx || {}));
    const emit = opt.on || {};
    let accumulated = '';
    let allSources = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await streamChat({
        messages,
        tools,
        model: opt.model,
        effort: opt.effort,
        thinking: opt.thinking,
        signal: opt.signal,
        onContent: (d) => { accumulated += d; emit.content && emit.content(d); },
        onReasoning: (d) => emit.reasoning && emit.reasoning(d),
      });

      if (r.finish !== 'tool_calls' || !r.toolCalls.length) {
        return { text: accumulated, sources: allSources };
      }

      // 回填 assistant 的工具调用消息
      messages.push({
        role: 'assistant',
        content: r.content || null,
        tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } })),
      });

      for (const call of r.toolCalls) {
        const name = call.function.name;
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { args = {}; }
        emit.toolStart && emit.toolStart({ id: call.id, name, args });

        let resultText = '';
        let ok = true;
        try {
          if (name === 'web_search') {
            const res = await webSearch(args.query || '', opt.signal);
            resultText = res.text || '（未检索到内容）';
            allSources = allSources.concat(res.sources);
            emit.toolResult && emit.toolResult({ id: call.id, name, args, ok: true, model: resultText, sources: res.sources, summary: '已联网检索' });
          } else if (name === 'read_url') {
            const res = await readUrl(args.url || '', opt.signal);
            resultText = res.text || '（未读取到内容）';
            allSources = allSources.concat(res.sources);
            emit.toolResult && emit.toolResult({ id: call.id, name, args, ok: true, model: resultText, sources: res.sources, summary: '已抓取网页' });
          } else if (global.AMapAPI) {
            const res = await global.AMapAPI.execute(name, args, opt.ctx || {});
            resultText = res.model;
            emit.toolResult && emit.toolResult({ id: call.id, name, args, ok: true, model: resultText, card: res.card, map: res.map, summary: '调用成功' });
          } else {
            throw new Error('高德能力未加载');
          }
        } catch (e) {
          ok = false;
          resultText = `工具执行失败：${e.message}`;
          emit.toolResult && emit.toolResult({ id: call.id, name, args, ok: false, model: resultText, summary: e.message });
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      }
    }

    return { text: accumulated || '抱歉，工具调用轮次已达上限，请把问题拆得更具体一些再试试。', sources: allSources };
  }

  /* ---------- 语音转文字（硅基流动） ---------- */
  async function transcribe(blob, apiKey) {
    const form = new FormData();
    form.append('file', blob, 'voice.webm');
    form.append('model', 'FunAudioLLM/SenseVoiceSmall');
    const res = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form,
    });
    if (!res.ok) {
      let t = '';
      try { t = await res.text(); } catch (_) { /* ignore */ }
      throw new Error(`语音识别失败 ${res.status}：${trimErr(t)}`);
    }
    const j = await res.json();
    return (j.text || '').trim();
  }

  global.DS = { setConfig, getConfig, streamChat, runAgent, webSearch, readUrl, transcribe, DEFAULT_MODEL };
})(window);
