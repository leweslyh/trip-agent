/**
 * config.js —— 配置与本地存储
 *
 * 三种配置来源（优先级从高到低）：
 *   1. 页面「API 设置」中保存到 localStorage 的配置
 *   2. js/config.local.js 中通过 window.APP_CONFIG 预置的配置（可选，方便开发者）
 *   3. 下面的 DEFAULTS 默认值
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'travel-agent.settings.v1';

  var DEFAULTS = {
    deepseekKey: '',
    deepseekBase: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-chat',
    amapJsKey: '',
    amapSecurity: '',
    amapWebKey: ''
  };

  var preset = global.APP_CONFIG || {};

  function readSaved() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  var cache = null;

  var Store = {
    /** 读取完整配置（含默认值） */
    get: function () {
      if (cache) return cache;
      var saved = readSaved();
      cache = {};
      Object.keys(DEFAULTS).forEach(function (k) {
        cache[k] = saved[k] || preset[k] || DEFAULTS[k];
      });
      cache.deepseekBase = String(cache.deepseekBase || DEFAULTS.deepseekBase).replace(/\/+$/, '');
      cache.deepseekModel = cache.deepseekModel || DEFAULTS.deepseekModel;
      return cache;
    },

    save: function (patch) {
      var next = Object.assign({}, Store.get(), patch);
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        /* 隐私模式下可能不可写，忽略 */
      }
      cache = next;
      return next;
    },

    reset: function () {
      try {
        global.localStorage.removeItem(STORAGE_KEY);
      } catch (e) { /* ignore */ }
      cache = null;
    },

    /** 关键 Key 是否齐备：map = 交互地图（JS API），web = Web 服务 */
    ready: function () {
      var s = Store.get();
      return {
        model: !!s.deepseekKey,
        map: !!s.amapJsKey,
        web: !!(s.amapWebKey || s.amapJsKey)
      };
    }
  };

  /* ---------------- 小工具 ---------------- */
  var Util = {
    escapeHtml: function (str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /** 米 -> 友好文本 */
    distance: function (meters) {
      var n = Number(meters);
      if (!isFinite(n) || n <= 0) return '—';
      return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + ' 公里' : Math.round(n) + ' 米';
    },

    /** 秒 -> 友好文本 */
    duration: function (seconds) {
      var n = Number(seconds);
      if (!isFinite(n) || n <= 0) return '—';
      var h = Math.floor(n / 3600);
      var m = Math.round((n % 3600) / 60);
      if (h > 0) return h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
      return m + ' 分钟';
    },

    now: function () {
      var d = new Date();
      var pad = function (v) { return v < 10 ? '0' + v : '' + v; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },

    /** 把 "116.397,39.909" 解析成 [lng, lat] */
    parseLngLat: function (str) {
      if (Array.isArray(str) && str.length === 2) {
        return [Number(str[0]), Number(str[1])];
      }
      if (str && typeof str === 'object' && str.lng != null && str.lat != null) {
        return [Number(str.lng), Number(str.lat)];
      }
      if (typeof str !== 'string') return null;
      var m = str.replace(/\s/g, '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (!m) return null;
      var lng = Number(m[1]);
      var lat = Number(m[2]);
      if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
      return [lng, lat];
    },

    sleep: function (ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }
  };

  global.Store = Store;
  global.Util = Util;
})(window);
