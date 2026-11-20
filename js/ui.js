/**
 * ui.js —— 界面渲染：对话流、工具轨迹、地图卡片、设置弹窗
 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  var typingTimer = null;
  var typingResolve = null;

  /* ==================== Markdown 轻量渲染 ==================== */
  function inline(text) {
    var html = Util.escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html;
  }

  function renderMarkdown(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n');
    var out = [];
    var listType = null;
    var buf = [];

    function flushParagraph() {
      if (!buf.length) return;
      out.push('<p>' + buf.map(inline).join('<br />') + '</p>');
      buf = [];
    }
    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; }
    }

    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) {
        flushParagraph();
        closeList();
        return;
      }
      var h = t.match(/^(#{2,4})\s+(.*)$/);
      if (h) {
        flushParagraph(); closeList();
        out.push('<h4>' + inline(h[2]) + '</h4>');
        return;
      }
      if (/^[-*]\s+/.test(t)) {
        flushParagraph();
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>');
        return;
      }
      if (/^\d+[.、]\s*/.test(t)) {
        flushParagraph();
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + inline(t.replace(/^\d+[.、]\s*/, '')) + '</li>');
        return;
      }
      if (/^---+$/.test(t)) {
        flushParagraph(); closeList();
        out.push('<hr />');
        return;
      }
      closeList();
      buf.push(t);
    });
    flushParagraph();
    closeList();
    return out.join('');
  }

  /* ==================== 对话 ==================== */
  function scrollBottom() {
    var box = els.chatScroll;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }

  function hideWelcome() {
    if (els.welcome) els.welcome.style.display = 'none';
  }

  function addUserMessage(text) {
    hideWelcome();
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.innerHTML = '<div class="avatar">我</div><div class="bubble"></div>';
    wrap.querySelector('.bubble').textContent = text;
    els.chatScroll.appendChild(wrap);
    scrollBottom();
  }

  function addAgentMessage(text, options) {
    options = options || {};
    hideWelcome();
    var wrap = document.createElement('div');
    wrap.className = 'msg agent';
    wrap.innerHTML = '<div class="avatar">行</div><div class="bubble"></div>';
    els.chatScroll.appendChild(wrap);
    var bubble = wrap.querySelector('.bubble');

    if (!options.typewriter) {
      bubble.innerHTML = renderMarkdown(text);
      scrollBottom();
      return wrap;
    }

    // 逐字显示效果
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
      if (typingResolve) { typingResolve(wrap); typingResolve = null; }
    }
    var full = String(text || '');
    var i = 0;
    bubble.innerHTML = '<span class="caret"></span>';
    scrollBottom();
    return new Promise(function (resolve) {
      typingResolve = resolve;
      typingTimer = setInterval(function () {
        i = Math.min(full.length, i + 4);
        bubble.innerHTML = renderMarkdown(full.slice(0, i)) + (i < full.length ? '<span class="caret"></span>' : '');
        scrollBottom();
        if (i >= full.length) {
          clearInterval(typingTimer);
          typingTimer = null;
          typingResolve = null;
          resolve(wrap);
        }
      }, 16);
    });
  }

  function addErrorMessage(text) {
    hideWelcome();
    var wrap = document.createElement('div');
    wrap.className = 'msg agent';
    wrap.innerHTML = '<div class="avatar">行</div><div class="bubble err"></div>';
    wrap.querySelector('.bubble').innerHTML = renderMarkdown(text);
    els.chatScroll.appendChild(wrap);
    scrollBottom();
  }

  function addStatusChip(text) {
    var el = document.createElement('div');
    el.className = 'trace';
    el.innerHTML = '<div class="trace-item"><span class="t-ic">◍</span>' +
      '<span class="t-name">' + Util.escapeHtml(text) + '</span></div>';
    els.chatScroll.appendChild(el);
    scrollBottom();
    return el;
  }

  var ICONS = {
    search: '◎', nearby: '⌖', route: '⇢', weather: '☁',
    static: '▣', locate: '◉', geocode: '⌂', clear: '⌫', tool: '⚙'
  };

  function addTrace(info) {
    hideWelcome();
    var wrapper = document.createElement('div');
    wrapper.className = 'trace';
    var argText = '';
    try {
      var args = typeof info.args === 'string' ? JSON.parse(info.args || '{}') : (info.args || {});
      var first = args.keyword || args.destination || args.location || args.address || args.city || '';
      if (first) argText = '· ' + String(first).slice(0, 18);
    } catch (e) { /* ignore */ }
    wrapper.innerHTML = '<div class="trace-item" data-trace="' + info.id + '">' +
      '<span class="t-ic">' + (ICONS[info.meta.icon] || ICONS.tool) + '</span>' +
      '<span class="t-name">' + Util.escapeHtml(info.meta.label) + '</span>' +
      '<span class="t-arg" style="color:#66748c">' + Util.escapeHtml(argText) + '</span>' +
      '<span class="t-res">执行中…</span></div>';
    els.chatScroll.appendChild(wrapper);
    scrollBottom();
    return wrapper.querySelector('.trace-item');
  }

  function updateTrace(info) {
    var node = els.chatScroll.querySelector('[data-trace="' + info.id + '"]');
    if (!node) return;
    var res = node.querySelector('.t-res');
    res.textContent = info.res.brief || (info.res.ok ? '完成' : '失败');
    node.classList.add(info.res.ok ? 'done' : 'fail');
    scrollBottom();
  }

  /* ==================== 地图卡片 ==================== */
  function renderWeather(w) {
    var live = w.live || {};
    var card = els.weatherCard;
    els.wcCity.textContent = (live.city || '') + (live.province && live.province !== live.city ? ' · ' + live.province : '');
    els.wcReport.textContent = (live.report_time ? live.report_time + ' 发布' : '') + ' · ' + (live.weather || '');
    els.wcTemp.textContent = live.temperature || '--';
    els.wcMeta.innerHTML = [
      '风向 ' + (live.winddirection || '—'),
      '风力 ' + (live.windpower || '—') + ' 级',
      '湿度 ' + (live.humidity || '—') + '%'
    ].map(function (t) { return '<span>' + Util.escapeHtml(t) + '</span>'; }).join('');

    var rows = (w.forecasts || []).slice(0, 3).map(function (c) {
      var d = String(c.date || '').slice(5);
      return '<div class="wf-row"><b>' + Util.escapeHtml(d) + '</b>' +
        '<span>' + Util.escapeHtml(c.dayweather || '') + '</span>' +
        '<span class="wf-temp">' + Util.escapeHtml(c.nighttemp || '') + '~' + Util.escapeHtml(c.daytemp || '') + '℃</span></div>';
    });
    els.wcForecast.innerHTML = rows.join('') || '<div class="wf-row">暂无预报数据</div>';
    card.hidden = false;
  }

  function renderRoute(route, originName, destName) {
    els.rcMode.textContent = route.modeText + (route.cost ? ' · ' + route.cost + ' 元' : '');
    els.rcDistance.textContent = Util.distance(route.distance);
    els.rcTime.textContent = Util.duration(route.time);
    var steps = (route.steps || []).slice(0, 10);
    els.rcSteps.innerHTML = steps.length
      ? steps.map(function (s) { return '<li>' + Util.escapeHtml(s) + '</li>'; }).join('')
      : '<li>' + Util.escapeHtml(originName + ' → ' + destName) + '</li>';
    els.routeCard.hidden = false;
  }

  function closeRoute() {
    if (els.routeCard) els.routeCard.hidden = true;
  }

  function renderStatic(url, loc, zoom) {
    var img = els.scImg;
    els.staticCard.hidden = false;
    els.scLoading.style.display = 'grid';
    els.scLoading.textContent = '正在生成…';
    els.scFoot.textContent = (loc.name || '') + ' · 缩放 ' + zoom + ' · ' + loc.lnglat.map(function (n) { return n.toFixed(4); }).join(', ');
    img.onload = function () {
      els.scLoading.style.display = 'none';
    };
    img.onerror = function () {
      els.scLoading.textContent = '生成失败：请检查「Web 服务」类型 Key';
      els.scLoading.style.display = 'grid';
    };
    img.src = url;
  }

  /**
   * Web 服务模式（无交互地图）：把静态地图铺在占位区，直观展示定位结果
   * @param {string} url 静态地图图片地址
   * @param {{city?:string, name?:string, lnglat?:Array}} info
   */
  function renderWebMap(url, info) {
    var loc = info || {};
    var ph = els.mapPlaceholder;
    if (!ph) {
      renderStatic(url, { name: loc.name || loc.city || '当前位置', lnglat: loc.lnglat || [0, 0] }, 10);
      return;
    }
    ph.hidden = false;
    ph.classList.add('web');
    if (els.phStatic) {
      els.phStatic.hidden = false;
      els.phStatic.src = url;
    }
    if (els.phTitle) {
      els.phTitle.textContent = loc.city ? loc.city + '（IP 定位）' : '当前位置';
    }
    if (els.phDesc) {
      els.phDesc.innerHTML =
        '当前为「Web 服务」Key 模式，已用静态地图显示大致位置<br />' +
        '补充「Web 端（JS API）」Key 后可切换为可拖拽的交互地图';
    }
    if (els.phBtn) els.phBtn.textContent = '补充 JS API Key';
  }

  /* ==================== Toast ==================== */
  function toast(message, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    els.toastWrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }

  /* ==================== 状态 ==================== */
  function updatePills() {
    var ready = Store.ready();
    var modelPill = els.pillModel;
    var mapPill = els.pillMap;

    modelPill.className = 'pill ' + (ready.model ? 'ok' : 'warn');
    modelPill.querySelector('span').textContent = ready.model ? 'DeepSeek 已连接' : '模型未配置';

    var mapOk = global.AMapKit && AMapKit.isReady();
    var pillClass = '';
    var pillText = '地图未就绪';
    if (mapOk) {
      pillClass = 'ok';
      pillText = '高德地图已就绪';
    } else if (ready.web) {
      pillClass = 'warn';
      pillText = 'Web 服务模式';
    } else if (ready.map) {
      pillClass = 'warn';
      pillText = '地图加载中…';
    }
    mapPill.className = 'pill ' + pillClass;
    mapPill.querySelector('span').textContent = pillText;
  }

  function setBusy(busy) {
    els.btnSend.disabled = busy;
    els.input.disabled = busy;
    if (!busy) els.input.focus();
  }

  /* ==================== 设置弹窗 ==================== */
  function fillSettings() {
    var cfg = Store.get();
    els.inDeepseekKey.value = cfg.deepseekKey;
    els.inDeepseekBase.value = cfg.deepseekBase;
    els.inDeepseekModel.value = cfg.deepseekModel;
    els.inAmapJsKey.value = cfg.amapJsKey;
    els.inAmapSecurity.value = cfg.amapSecurity;
    els.inAmapWebKey.value = cfg.amapWebKey;
  }

  function openSettings() {
    fillSettings();
    els.settingsModal.hidden = false;
    setTimeout(function () { els.inDeepseekKey.focus(); }, 60);
  }

  function closeSettings() {
    els.settingsModal.hidden = true;
  }

  function collectSettings() {
    return {
      deepseekKey: els.inDeepseekKey.value.trim(),
      deepseekBase: (els.inDeepseekBase.value.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
      deepseekModel: els.inDeepseekModel.value.trim() || 'deepseek-chat',
      amapJsKey: els.inAmapJsKey.value.trim(),
      amapSecurity: els.inAmapSecurity.value.trim(),
      amapWebKey: els.inAmapWebKey.value.trim()
    };
  }

  function clearChat() {
    els.chatScroll.innerHTML = '';
    els.chatScroll.appendChild(els.welcome);
    els.welcome.style.display = '';
    closeRoute();
    els.staticCard.hidden = true;
    els.weatherCard.hidden = true;
    if (global.AMapKit) AMapKit.clearOverlays();
  }

  function init() {
    els = {
      chatScroll: $('chatScroll'),
      welcome: $('welcome'),
      input: $('input'),
      composer: $('composer'),
      btnSend: $('btnSend'),
      btnSettings: $('btnSettings'),
      btnClear: $('btnClear'),
      pillModel: $('pillModel'),
      pillMap: $('pillMap'),
      settingsModal: $('settingsModal'),
      inDeepseekKey: $('inDeepseekKey'),
      inDeepseekBase: $('inDeepseekBase'),
      inDeepseekModel: $('inDeepseekModel'),
      inAmapJsKey: $('inAmapJsKey'),
      inAmapSecurity: $('inAmapSecurity'),
      inAmapWebKey: $('inAmapWebKey'),
      btnSaveKeys: $('btnSaveKeys'),
      btnResetKeys: $('btnResetKeys'),
      weatherCard: $('weatherCard'),
      wcCity: $('wcCity'),
      wcReport: $('wcReport'),
      wcTemp: $('wcTemp'),
      wcMeta: $('wcMeta'),
      wcForecast: $('wcForecast'),
      routeCard: $('routeCard'),
      rcMode: $('rcMode'),
      rcDistance: $('rcDistance'),
      rcTime: $('rcTime'),
      rcSteps: $('rcSteps'),
      rcClose: $('rcClose'),
      staticCard: $('staticCard'),
      scImg: $('scImg'),
      scLoading: $('scLoading'),
      scFoot: $('scFoot'),
      scClose: $('scClose'),
      mapPlaceholder: $('mapPlaceholder'),
      phStatic: $('phStatic'),
      phTitle: $('phTitle'),
      phDesc: $('phDesc'),
      phBtn: $('btnPlaceholderSettings'),
      toastWrap: $('toastWrap')
    };
  }

  global.UI = {
    get els() { return els; },
    init: init,
    renderMarkdown: renderMarkdown,
    addUserMessage: addUserMessage,
    addAgentMessage: addAgentMessage,
    addErrorMessage: addErrorMessage,
    addStatusChip: addStatusChip,
    addTrace: addTrace,
    updateTrace: updateTrace,
    renderWeather: renderWeather,
    renderRoute: renderRoute,
    closeRoute: closeRoute,
    renderStatic: renderStatic,
    renderWebMap: renderWebMap,
    toast: toast,
    updatePills: updatePills,
    setBusy: setBusy,
    openSettings: openSettings,
    closeSettings: closeSettings,
    collectSettings: collectSettings,
    clearChat: clearChat,
    scrollBottom: scrollBottom
  };
})(window);
