(function (global) {
  'use strict';

  var STORAGE_KEY = 'tripmind_config_v1';

  var DEFAULTS = {
    // 请勿在仓库中提交明文 Key，运行时通过页面设置填写
    deepseekKey: '',
    siliconflowKey: '',
    amapKey1: '',
    amapKey2: '',
    defaultCity: '北京',
    theme: 'dark'
  };

  function load() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      var saved = JSON.parse(raw);
      return Object.assign({}, DEFAULTS, saved || {});
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  var data = load();

  global.Config = {
    get: function (key) {
      return data[key];
    },
    set: function (key, value) {
      data[key] = value;
    },
    update: function (obj) {
      Object.keys(obj || {}).forEach(function (k) {
        data[k] = obj[k];
      });
    },
    save: function () {
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return true;
      } catch (e) {
        return false;
      }
    },
    clearKeys: function () {
      data.deepseekKey = '';
      data.siliconflowKey = '';
      data.amapKey1 = '';
      data.amapKey2 = '';
      this.save();
    },
    amapKeys: function () {
      return [data.amapKey1, data.amapKey2].filter(function (k) { return !!k; });
    },
    defaults: DEFAULTS
  };
})(window);
