/* 通用工具层 */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        const val = attrs[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val;
        else if (key === 'dataset') Object.assign(node.dataset, val);
        else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
        else node.setAttribute(key, val === true ? '' : val);
      });
    }
    (Array.isArray(children) ? children : children ? [children] : []).forEach((child) => {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  const escapeHtml = (str) => String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const uid = (prefix) => (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /* ---------- JSONP：绕过高德 Web 服务的跨域限制 ---------- */
  function jsonp(url, params, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
      const cbName = 'amap_cb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const query = Object.assign({}, params, { callback: cbName });
      const qs = Object.keys(query)
        .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== '')
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
        .join('&');
      const script = document.createElement('script');
      let done = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error('高德接口请求超时，请检查网络或 Key 是否可用')); }, opts.timeout || 15000);

      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete global[cbName]; } catch (e) { global[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      global[cbName] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error('高德接口加载失败，请检查 Key 与网络')); };
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs;
      script.async = true;
      document.head.appendChild(script);
    });
  }

  /* ---------- 带超时的 fetch ---------- */
  async function fetchJSON(url, options, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 60000);
    try {
      const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      if (!res.ok) {
        const msg = (data && (data.error && (data.error.message || data.error.code) || data.message)) || ('HTTP ' + res.status);
        const err = new Error(msg);
        err.status = res.status;
        err.payload = data;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时，请检查网络或接口地址');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- Toast ---------- */
  function toast(message, type, duration) {
    const stack = $('#toastStack');
    if (!stack) return;
    const icon = type === 'err' ? 'i-close' : type === 'ok' ? 'i-check' : 'i-spark';
    const node = el('div', { class: 'toast ' + (type || '') }, [
      el('svg', {}, [el('use', { href: '#' + icon })]),
      el('span', { text: message })
    ]);
    stack.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 240);
    }, duration || 2600);
  }

  /* ---------- 格式化 ---------- */
  function fmtDistance(meters) {
    const m = Number(meters);
    if (!isFinite(m) || m <= 0) return '';
    if (m < 1000) return Math.round(m) + ' 米';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' 公里';
  }

  function fmtDuration(seconds) {
    const s = Number(seconds);
    if (!isFinite(s) || s <= 0) return '';
    const min = Math.round(s / 60);
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? h + ' 小时 ' + rest + ' 分' : h + ' 小时';
  }

  function fmtClock(ts) {
    const d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtDate(str) {
    if (!str) return '';
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + week;
  }

  /* ---------- 图片处理 ---------- */
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve({ img, dataUrl: reader.result });
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
  }

  async function compressImage(file, maxSize, quality) {
    const limit = maxSize || 1280;
    const { img, dataUrl } = await fileToImage(file);
    let { width, height } = img;
    if (Math.max(width, height) > limit) {
      const scale = limit / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const out = canvas.toDataURL('image/jpeg', quality || 0.85);
    return { dataUrl: out, name: file.name || 'image.jpg', size: Math.round(out.length * 0.75), original: dataUrl };
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || ('image_' + Date.now() + '.jpg');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait || 200);
    };
  }

  App.utils = {
    $, $$, el, escapeHtml, uid, sleep, jsonp, fetchJSON, toast,
    fmtDistance, fmtDuration, fmtClock, fmtDate,
    fileToImage, compressImage, copyText, downloadDataUrl, debounce
  };
})(window);
