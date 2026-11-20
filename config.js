/* ============================================================
 *  出行小助手智能体 - 配置中心
 *  只需两个 Key：高德 Web 服务 Key + DeepSeek Key
 *  均通过前端「设置界面」填写，保存在 localStorage
 * ============================================================ */

const DEFAULT_CONFIG = {
  amapKey: '',            // 高德开放平台 Web 服务 API Key（一个即可，用于所有高德接口）
  deepseekKey: '',        // DeepSeek API Key
  deepseekModel: 'deepseek-chat',
  deepseekUrl: 'https://api.deepseek.com/chat/completions'
};

const STORAGE_KEY = 'travel-assistant-config';

function getConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(saved));
  } catch (e) { /* 忽略 */ }
  return Object.assign({}, DEFAULT_CONFIG);
}

function saveConfig(cfg) {
  const merged = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

function isConfigured() {
  const c = getConfig();
  return !!(c.amapKey && c.deepseekKey);
}
