/* 配置与本地会话存储 */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};
  const CFG_KEY = 'travel_ai_config_v2';
  const SESSION_KEY = 'travel_ai_session_v2';

  const DEFAULT_SYSTEM = [
    '你是「出行小助手」，一个基于 DeepSeek 大模型与高德开放平台的智能出行助理。你熟悉中国城市的地理、交通与生活服务，帮助用户完成与出行相关的一切任务：地点搜索、周边探索、路线规划、天气查询、地图展示、定位判断与行程编排。',
    '',
    '## 工作方式',
    '1. 只要涉及真实地点、路线、距离、耗时、天气、营业时间等事实信息，必须先调用工具获取，绝不凭记忆编造。',
    '2. 不确定用户位置时，先调用 amap_ip_location 获取当前城市；若仍不明确，再简短询问用户。',
    '3. 关键词查地点用 amap_text_search；查"附近/周边"用 amap_around_search（尽量带 location 坐标，没有就带 city）。',
    '4. 地名转坐标用 amap_geocode。路径规划前必须先确保拿到起终点坐标，再调用 amap_route，支持 driving/walking/bicycling/transit。',
    '5. 用户想看地图、要标注位置、要看路线走向时，调用 amap_static_map 生成静态地图（一次最多标注 6 个点）。',
    '6. 需要实时资讯、政策、活动、网页内容时用 web_search；需要精读某个网页时用 web_fetch。',
    '7. 一个任务可以连续调用多个工具，后一个工具可以使用前一个工具的结果（例如先搜地点，再规划到该地点的路线）。',
    '',
    '## 回答要求',
    '- 使用简体中文，语气自然、专业、简洁，像一位熟悉本地的朋友。',
    '- 先给结论，再给必要细节；能用列表就不要写长段落。',
    '- 介绍地点时给出：名称、距离或评分、地址、一句话推荐理由。',
    '- 介绍路线时给出：距离、预计耗时、关键路段或换乘提示。',
    '- 不要输出工具调用的 JSON 原文，不要暴露内部实现细节。',
    '- 不要编造工具未返回的数据；工具失败时说明原因并给出替代方案。',
    '- 涉及"今天/明天/现在"时，结合当前日期时间作答。'
  ].join('\n');

  const DEFAULT_MODEL = 'deepseek-v4-pro';

  const DEFAULTS = {
    deepseekKey: '',
    deepseekBase: 'https://api.deepseek.com',
    deepseekModel: DEFAULT_MODEL,
    deepseekModelCustom: '',
    temperature: 0.7,
    amapKey: '',
    siliconKey: '',
    siliconBase: 'https://api.siliconflow.cn/v1',
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    city: '杭州',
    autoGeo: true,
    systemPrompt: DEFAULT_SYSTEM
  };

  let cache = null;

  /* 清洗模型字段：空值、API Key（sk- 开头）、含空格或超长的值都不是合法模型 ID */
  function sanitizeModel(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 80 || /\s/.test(s)) return '';
    if (/^sk-/i.test(s) || /^bearer\s/i.test(s)) return '';
    return s;
  }

  function readConfig() {
    if (cache) return cache;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    cache = Object.assign({}, DEFAULTS, saved);
    /* 历史脏数据修复：模型名被误填成 API Key 时自动纠正，避免把 sk-xxx 当模型发出去 */
    cache.deepseekModel = sanitizeModel(cache.deepseekModel) || DEFAULT_MODEL;
    cache.deepseekModelCustom = sanitizeModel(cache.deepseekModelCustom);
    if (!cache.systemPrompt || !cache.systemPrompt.trim()) cache.systemPrompt = DEFAULT_SYSTEM;
    return cache;
  }

  function saveConfig(patch) {
    const next = Object.assign({}, readConfig(), patch || {});
    cache = next;
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(next));
      return true;
    } catch (e) {
      App.utils.toast('配置保存失败：浏览器存储空间不足', 'err');
      return false;
    }
  }

  function resetConfig() {
    cache = Object.assign({}, DEFAULTS);
    try { localStorage.removeItem(CFG_KEY); } catch (e) { /* ignore */ }
    return cache;
  }

  function activeModel(cfg) {
    const c = cfg || readConfig();
    return sanitizeModel(c.deepseekModelCustom) || sanitizeModel(c.deepseekModel) || DEFAULT_MODEL;
  }

  function modelLabel(model) {
    if (model === 'deepseek-v4-pro') return 'DeepSeek-V4 Pro';
    if (model === 'deepseek-flash') return 'DeepSeek-V4 Flash';
    if (model === 'deepseek-chat') return 'DeepSeek-V3.2';
    if (model === 'deepseek-reasoner') return 'DeepSeek-R1';
    return model;
  }

  /* 会话只保存文本，图片不落盘，避免 localStorage 超限与隐私残留 */
  function saveSession(messages) {
    try {
      const slim = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-60)
        .map((m) => ({
          role: m.role,
          content: m.content || '',
          imageCount: (m.images || []).length,
          time: m.time || Date.now()
        }));
      localStorage.setItem(SESSION_KEY, JSON.stringify(slim));
    } catch (e) { /* 忽略存储异常 */ }
  }

  function loadSession() {
    try {
      const list = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  App.store = {
    DEFAULT_SYSTEM, DEFAULTS, DEFAULT_MODEL,
    readConfig, saveConfig, resetConfig,
    activeModel, modelLabel, sanitizeModel,
    saveSession, loadSession, clearSession
  };
})(window);
