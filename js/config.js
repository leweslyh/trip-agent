/**
 * 配置管理：默认值 + localStorage 持久化
 */
(function () {
  const STORAGE_KEY = 'travel_assistant_config';

  const DEFAULTS = {
    deepseekKey: '',
    deepseekBase: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-chat',
    proxyPrefix: '',
    amapKey: ''
  };

  let current = null;

  function load() {
    if (current) return current;
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (e) {
      saved = {};
    }
    current = Object.assign({}, DEFAULTS, saved);
    return current;
  }

  function save(cfg) {
    current = Object.assign({}, DEFAULTS, cfg || {});
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (e) {
      // localStorage 不可用（如隐私模式）时忽略
    }
    return current;
  }

  function clear() {
    current = Object.assign({}, DEFAULTS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    return current;
  }

  window.Config = {
    get: load,
    save: save,
    clear: clear
  };
})();
