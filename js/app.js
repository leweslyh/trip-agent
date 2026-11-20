/**
 * UI 交互与结果渲染
 */
(function () {
  const chat = document.getElementById('chat');
  const welcome = document.getElementById('welcome');
  const input = document.getElementById('input');
  const btnSend = document.getElementById('btnSend');
  const btnSettings = document.getElementById('btnSettings');
  const mask = document.getElementById('modalMask');
  const btnClose = document.getElementById('btnCloseSettings');
  const btnSave = document.getElementById('btnSaveSettings');
  const btnClear = document.getElementById('btnClearStorage');

  let history = []; // 仅保存 user/assistant 的最终对话
  let busy = false;

  /* ---------- 工具函数 ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function md(text) {
    return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function scrollBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function append(html) {
    welcome && welcome.remove();
    chat.insertAdjacentHTML('beforeend', html);
    scrollBottom();
  }

  function addUser(text) {
    append('<div class="msg user"><div class="bubble">' + esc(text) + '</div></div>');
  }

  function addAssistantHtml(html) {
    append('<div class="msg assistant">' + html + '</div>');
  }

  function addTyping() {
    append('<div class="msg assistant"><div class="typing"><span></span><span></span><span></span></div></div>');
    return chat.lastElementChild;
  }

  function mapImg(url) {
    if (!url) return '';
    return '<div class="map-box"><img src="' + url + '" alt="地图" loading="lazy" /></div>';
  }

  /* ---------- 各类卡片渲染 ---------- */

  function renderPoiCard(entry, title) {
    const pois = (entry.data && entry.data.pois) || [];
    if (!pois.length) return '<div class="card muted">未查询到相关地点</div>';
    const markers = AMapAPI.buildPoiMarkers(pois, '0x3B82F6');
    const url = AMapAPI.staticMapUrl({ markers });
    const list = pois.map((p, i) => {
      return '<div class="poi-item"><span class="poi-idx">' + (i + 1) + '</span>' +
        '<div class="poi-info"><div class="poi-name">' + esc(p.name) + '</div>' +
        '<div class="poi-addr">' + esc(p.address || '') + (p.distance ? ' · ' + esc(p.distance) : '') + '</div></div></div>';
    }).join('');
    return '<div class="card"><div class="card-title">' + esc(title) + '</div>' +
      mapImg(url) + '<div class="poi-list">' + list + '</div></div>';
  }

  function renderRouteCard(entry) {
    const d = entry.data || {};
    const modeLabel = { driving: '驾车', walking: '步行', transit: '公交' }[d.mode] || '路线';
    let url = '';
    if (d.polyline && d.origin && d.destination) {
      const markers = 'mid,0x00C853,O:' + d.origin + '|mid,0xFF1744,D:' + d.destination;
      const paths = AMapAPI.buildPath(d.polyline, '0x2196F3', 6);
      url = AMapAPI.staticMapUrl({ markers: markers, paths: paths });
    }
    const stats = [];
    if (d.distance) stats.push('距离 ' + fmt(d.distance, 'dist'));
    if (d.duration) stats.push('预计 ' + fmt(d.duration, 'dur'));
    if (d.taxiCost != null) stats.push('打车约 ' + d.taxiCost + ' 元');

    let steps = '';
    if (d.desc && d.desc.length) {
      steps = '<div class="steps">' + d.desc.map((s) => '<div class="step">' + esc(s) + '</div>').join('') + '</div>';
    }
    return '<div class="card"><div class="card-title">🗺️ ' + modeLabel + '路线</div>' +
      mapImg(url) +
      '<div class="route-stats">' + stats.map((s) => '<span class="stat">' + esc(s) + '</span>').join('') + '</div>' +
      steps + '</div>';
  }

  function fmt(v, kind) {
    v = Number(v);
    if (kind === 'dist') return v >= 1000 ? (v / 1000).toFixed(1) + ' 公里' : v + ' 米';
    if (kind === 'dur') {
      const m = Math.round(v / 60);
      return m < 60 ? m + ' 分钟' : Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟';
    }
    return String(v);
  }

  function renderWeatherCard(entry) {
    const d = entry.data || {};
    if (d.extensions === 'all') {
      const rows = (d.casts || []).map((c) =>
        '<div class="w-row"><span class="w-date">' + esc(c.date) + ' ' + esc(c.week) + '</span>' +
        '<span class="w-desc">' + esc(c.day) + '</span></div>'
      ).join('');
      return '<div class="card"><div class="card-title">🌤️ ' + esc(d.province || '') + ' ' + esc(d.city || '') + ' 天气预报</div>' +
        '<div class="w-list">' + rows + '</div></div>';
    }
    return '<div class="card"><div class="card-title">🌤️ ' + esc(d.province || '') + ' ' + esc(d.city || '') + ' 实时天气</div>' +
      '<div class="w-now"><span class="w-temp">' + esc(d.temperature) + '℃</span>' +
      '<div class="w-meta"><div>' + esc(d.weather) + '</div>' +
      '<div>' + esc(d.wind || '') + ' · 湿度 ' + esc(d.humidity || '-') + '</div>' +
      '<div class="w-time">' + esc(d.reporttime || '') + '</div></div></div></div>';
  }

  function renderIpCard(entry) {
    const d = entry.data || {};
    let url = '';
    if (d.center) {
      url = AMapAPI.staticMapUrl({ location: d.center, zoom: 11, markers: 'large,0xFF1744,D:' + d.center });
    }
    return '<div class="card"><div class="card-title">🛰️ IP 定位</div>' +
      mapImg(url) +
      '<div class="ip-meta">所在位置：<strong>' + esc((d.province || '') + ' ' + (d.city || '')) + '</strong>' +
      (d.adcode ? '（adcode: ' + esc(d.adcode) + '）' : '') + '</div></div>';
  }

  function renderToolCard(entry) {
    const t = entry.summary && entry.summary.type;
    switch (t) {
      case 'geocode': return renderPoiCard(entry, '📍 定位结果');
      case 'place_search': return renderPoiCard(entry, '🔍 搜索结果');
      case 'place_around': return renderPoiCard(entry, '📍 周边搜索');
      case 'route': return renderRouteCard(entry);
      case 'weather': return renderWeatherCard(entry);
      case 'ip': return renderIpCard(entry);
      default: return '';
    }
  }

  function renderAssistant(answer, toolLog) {
    let html = '';
    if (answer) html += '<div class="bubble">' + md(answer) + '</div>';
    (toolLog || []).forEach((t) => {
      if (t.summary && t.summary.error) {
        html += '<div class="card err">工具调用失败：' + esc(t.summary.error) + '</div>';
      } else {
        html += renderToolCard(t);
      }
    });
    addAssistantHtml(html);
  }

  /* ---------- 发送流程 ---------- */

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    const cfg = Config.get();
    if (!cfg.deepseekKey || !cfg.amapKey) {
      addAssistantHtml('<div class="card warn">请先点击右上角 ⚙️，配置 <strong>DeepSeek API Key</strong> 与 <strong>高德 Web服务 Key</strong> 后再开始。</div>');
      openSettings();
      return;
    }

    addUser(text);
    busy = true;
    btnSend.disabled = true;
    const typing = addTyping();

    try {
      const res = await Agent.runAgent(text, history);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: res.text });
      if (typing && typing.parentNode) typing.remove();
      renderAssistant(res.text, res.toolLog);
    } catch (e) {
      if (typing && typing.parentNode) typing.remove();
      addAssistantHtml('<div class="card err">' + esc(e.message) + '</div>');
    } finally {
      busy = false;
      btnSend.disabled = false;
      input.focus();
      scrollBottom();
    }
  }

  /* ---------- 设置 ---------- */

  function fillSettings() {
    const c = Config.get();
    document.getElementById('cfgDeepseekKey').value = c.deepseekKey;
    document.getElementById('cfgDeepseekBase').value = c.deepseekBase;
    document.getElementById('cfgDeepseekModel').value = c.deepseekModel;
    document.getElementById('cfgProxy').value = c.proxyPrefix;
    document.getElementById('cfgAmapKey').value = c.amapKey;
  }

  function openSettings() {
    fillSettings();
    mask.hidden = false;
  }
  function closeSettings() {
    mask.hidden = true;
  }

  function saveSettings() {
    Config.save({
      deepseekKey: document.getElementById('cfgDeepseekKey').value.trim(),
      deepseekBase: document.getElementById('cfgDeepseekBase').value.trim() || 'https://api.deepseek.com',
      deepseekModel: document.getElementById('cfgDeepseekModel').value.trim() || 'deepseek-chat',
      proxyPrefix: document.getElementById('cfgProxy').value.trim(),
      amapKey: document.getElementById('cfgAmapKey').value.trim()
    });
    closeSettings();
    toast('配置已保存');
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    btnSend.addEventListener('click', () => send(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(input.value);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    btnSettings.addEventListener('click', openSettings);
    btnClose.addEventListener('click', closeSettings);
    mask.addEventListener('click', (e) => { if (e.target === mask) closeSettings(); });
    btnSave.addEventListener('click', saveSettings);
    btnClear.addEventListener('click', () => {
      Config.clear();
      fillSettings();
      toast('配置已清除');
    });

    document.querySelectorAll('#quickbar .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        input.value = chip.dataset.text;
        input.style.height = 'auto';
        send(input.value);
      });
    });
  }

  function init() {
    bindEvents();
    // 若已配置，展示欢迎语下的示例提示
    const c = Config.get();
    if (!c.deepseekKey || !c.amapKey) {
      // 保持欢迎语
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
