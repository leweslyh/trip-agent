/* 应用主逻辑：会话管理、工具执行、静态地图联动、设置 */
(function (global) {
  'use strict';

  const { Amap, DeepSeek, UI } = global;
  const $ = UI.$;

  const ctx = { city: '', location: '', address: '' };
  const history = [];
  let busy = false;
  let mapSpec = null;
  let locatePromise = null;

  /* ---------- 地图 ---------- */

  function showMap(spec) {
    if (!spec || !Amap.cfg.key) return;
    mapSpec = spec;
    const url = Amap.staticMapUrl({
      center: spec.center,
      zoom: spec.zoom,
      points: spec.points,
      path: spec.path,
      color: spec.color
    });
    if (!url) return;
    UI.setMap({
      url: url,
      title: spec.title || '静态地图',
      caption: spec.caption || '',
      openUrl: spec.openUrl || Amap.amapLink(spec)
    });
  }

  function poiMapSpec(pois, title, center) {
    const points = [];
    if (center) points.push({ location: center.location || center, name: '搜索中心', label: 'S', color: '0xe04057' });
    (pois || []).slice(0, 3).forEach(function (p, i) {
      points.push({ location: p.location, name: p.name, label: String(i + 1) });
    });
    return { title: title, points: points, caption: '共展示 ' + (pois || []).length + ' 个结果中的前 ' + Math.min((pois || []).length, 3) + ' 个' };
  }

  function routeMapSpec(d) {
    const pts = (d.polylines || []).join(';').split(';').filter(Boolean);
    const points = [
      { location: d.origin.location, name: d.origin.name || '起点', label: 'S', color: '0x12b8a6' },
      { location: d.destination.location, name: d.destination.name || '终点', label: 'E', color: '0xe04057' }
    ];
    return {
      title: d.modeName + '路线 · ' + Amap.formatDistance(d.distance),
      points: points,
      path: pts,
      zoom: Amap.estimateZoom(pts.length ? pts : [d.origin.location, d.destination.location]),
      caption: '全程 ' + Amap.formatDistance(d.distance) + '，预计 ' + Amap.formatDuration(d.duration),
      openUrl: 'https://uri.amap.com/navigation?from=' + d.origin.location + ',' +
        encodeURIComponent(d.origin.name || '起点') + '&to=' + d.destination.location + ',' +
        encodeURIComponent(d.destination.name || '终点') + '&mode=car&policy=1&src=travel-assistant&coordinate=gaode&callnative=0'
    };
  }

  /* ---------- 工具执行 ---------- */

  async function executeTool(name, args) {
    const a = args || {};

    if (name === 'search_keywords') {
      const data = await Amap.searchKeywords(a.keywords, { city: a.city || ctx.city, citylimit: a.citylimit });
      if (data.pois.length) showMap(poiMapSpec(data.pois, '搜索：' + a.keywords));
      return data;
    }

    if (name === 'search_nearby') {
      let center = a.location;
      if (!center) {
        const loc = await ensureLocation();
        center = loc.center;
      }
      const data = await Amap.searchAround(a.keywords, {
        location: center, radius: a.radius, types: a.types, city: ctx.city
      });
      if (data.pois.length) showMap(poiMapSpec(data.pois, '周边：' + (a.keywords || '全部'), data.center));
      return data;
    }

    if (name === 'plan_route') {
      const data = await Amap.planRoute(a.mode, {
        origin: a.origin, destination: a.destination, city: a.city || ctx.city
      });
      showMap(routeMapSpec(data));
      return data;
    }

    if (name === 'query_weather') {
      const data = await Amap.weather(a.city || ctx.city);
      if (!data.live && !data.casts.length) throw new Amap.AmapError('没有查询到天气数据');
      return data;
    }

    if (name === 'locate_ip') {
      const data = await Amap.ipLocate(a.ip);
      applyLocation(data);
      if (data.center) {
        showMap({
          title: 'IP 定位 · ' + (data.city || data.province),
          points: [{ location: data.center, name: data.city || data.province, label: 'A' }],
          caption: data.address || (data.province || '') + (data.city || '') + (data.district || '')
        });
      }
      return data;
    }

    if (name === 'geocode_address') {
      const data = await Amap.geocode(a.address, a.city);
      showMap({
        title: '地址定位：' + (a.address || '').slice(0, 12),
        points: [{ location: data.location, name: data.formatted, label: 'A' }],
        caption: data.formatted
      });
      return data;
    }

    if (name === 'reverse_geocode') {
      const data = await Amap.regeo(a.location);
      showMap({
        title: '坐标反查',
        points: [{ location: a.location, name: data.formatted || '目标位置', label: 'A' }],
        caption: data.formatted
      });
      return { location: a.location, ...data };
    }

    if (name === 'show_static_map') {
      const input = Array.isArray(a.points) ? a.points.slice(0, 4) : [];
      if (!input.length) throw new Amap.AmapError('缺少要标注的地点');
      const points = [];
      for (let i = 0; i < input.length; i++) {
        const item = input[i] || {};
        const raw = item.location || item.name || '';
        if (Amap.isLatLng(raw)) {
          const p = Amap.parseLocation(raw);
          points.push({ location: p.lng.toFixed(6) + ',' + p.lat.toFixed(6), name: item.name || raw, label: String(i + 1) });
        } else {
          const g = await Amap.geocode(raw, ctx.city);
          points.push({ location: g.location, name: item.name || g.formatted, label: String(i + 1) });
        }
      }
      const spec = {
        title: a.title || '静态地图',
        points: points,
        zoom: a.zoom,
        caption: points.map(function (p) { return p.name; }).join(' · ')
      };
      showMap(spec);
      return { title: spec.title, points: points, zoom: a.zoom || Amap.estimateZoom(points.map(function (p) { return p.location; })) };
    }

    throw new Error('未知工具：' + name);
  }

  /* ---------- 定位 ---------- */

  function applyLocation(data) {
    ctx.city = data.city || data.province || ctx.city;
    if (data.center) {
      ctx.location = data.center;
    } else if (data.lng && data.lat) {
      ctx.location = data.lng.toFixed(6) + ',' + data.lat.toFixed(6);
    }
    ctx.address = data.address || '';
    UI.updateLocation({
      city: ctx.city,
      address: ctx.address,
      adcode: data.adcode,
      center: ctx.location,
      source: data.source || 'IP 定位'
    });
  }

  async function ensureLocation() {
    if (ctx.location) return { city: ctx.city, center: ctx.location };
    if (!Amap.cfg.key) throw new Amap.AmapError('需要先配置高德 Key 才能定位');
    if (!locatePromise) {
      locatePromise = Amap.ipLocate().then(function (data) {
        applyLocation(data);
        return { city: ctx.city, center: ctx.location };
      }).finally(function () { locatePromise = null; });
    }
    return locatePromise;
  }

  async function locate(showMessage) {
    if (!Amap.cfg.key) {
      if (showMessage) addSystemNote('请先在「设置」中填写高德 Web 服务 Key，才能使用定位能力。');
      return;
    }
    try {
      const data = await Amap.ipLocate();
      applyLocation(data);
      if (data.center) {
        showMap({
          title: '当前位置 · ' + (ctx.city || data.province),
          points: [{ location: data.center, name: ctx.city, label: 'A' }],
          caption: data.address || (data.city + ' ' + (data.district || ''))
        });
      }
      if (showMessage) {
        addSystemNote('已通过 IP 定位到：' + (ctx.city || data.province) + (ctx.address ? '（' + ctx.address + '）' : ''));
      }
    } catch (err) {
      UI.updateLocation(null);
      if (showMessage) addSystemNote('定位失败：' + err.message);
    }
  }

  function addSystemNote(text) {
    const view = UI.addAssistantMessage();
    view.setText(text);
  }

  /* ---------- 会话 ---------- */

  function buildMessages() {
    const sys = DeepSeek.buildSystemPrompt({
      now: new Date().toLocaleString('zh-CN'),
      city: ctx.city,
      location: ctx.location
    });
    return [{ role: 'system', content: sys }].concat(history);
  }

  async function send(text) {
    const content = (text || '').trim();
    if (!content || busy) return;

    if (!DeepSeek.cfg.key) {
      openSettings();
      addSystemNote('还差一步：在「设置」里填入 DeepSeek API Key 就能开始对话了。');
      return;
    }

    UI.addUserMessage(content);
    history.push({ role: 'user', content: content });

    const view = UI.addAssistantMessage();
    view.setTyping(true);
    setBusy(true);

    const cards = [];
    let streamed = false;
    let failed = false;

    try {
      await DeepSeek.run({
        messages: buildMessages(),
        execute: executeTool,
        onEvent: function (ev) {
          if (ev.type === 'text') {
            streamed = true;
            view.appendText(ev.text);
          } else if (ev.type === 'tool-start') {
            cards.push(UI.addToolCard(ev.name, ev.args));
          } else if (ev.type === 'tool-result') {
            const card = cards.shift();
            if (card) UI.renderToolResult(card, ev.name, ev.output);
          }
        }
      });

      // 流式内容已写入，若模型只返回了工具没有文本，则补一句提示
      if (!streamed && !view.rawText()) {
        view.setText('已完成查询。需要我进一步规划路线或换个范围找找吗？');
      }
    } catch (err) {
      failed = true;
      view.setText('**出错了：** ' + (err && err.message ? err.message : String(err)));
    } finally {
      setBusy(false);
      if (failed) {
        // 失败时回滚本轮用户消息，避免污染上下文
        if (history.length && history[history.length - 1].role === 'user') history.pop();
      } else {
        history.push({ role: 'assistant', content: view.rawText() || '（无文本回复）' });
      }
      UI.scrollBottom();
    }
  }

  function setBusy(on) {
    busy = on;
    const btn = $('btn-send');
    btn.disabled = on;
    btn.textContent = on ? '思考中' : '发送';
  }

  /* ---------- 设置 ---------- */

  function openSettings() {
    $('ds-key').value = DeepSeek.cfg.key;
    $('ds-base').value = DeepSeek.cfg.base;
    $('ds-model').value = DeepSeek.cfg.model;
    $('amap-key').value = Amap.cfg.key;
    $('amap-proxy').value = Amap.cfg.proxy;
    $('default-city').value = Amap.cfg.defaultCity;
    $('settings-modal').classList.remove('hidden');
  }

  function closeSettings() {
    $('settings-modal').classList.add('hidden');
  }

  function saveSettings() {
    DeepSeek.cfg.key = $('ds-key').value;
    DeepSeek.cfg.base = $('ds-base').value || 'https://api.deepseek.com';
    DeepSeek.cfg.model = $('ds-model').value || 'deepseek-chat';
    Amap.cfg.key = $('amap-key').value;
    Amap.cfg.proxy = $('amap-proxy').value;
    Amap.cfg.defaultCity = $('default-city').value;
    if (!ctx.city && Amap.cfg.defaultCity) ctx.city = Amap.cfg.defaultCity;

    UI.updateStatus(!!DeepSeek.cfg.key, !!Amap.cfg.key);
    closeSettings();

    if (mapSpec && Amap.cfg.key) showMap(mapSpec);
    else if (Amap.cfg.key) locate(false);
  }

  /* ---------- 初始化 ---------- */

  let welcomeHTML = '';

  function bindPrompts() {
    document.querySelectorAll('[data-prompt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        send(btn.getAttribute('data-prompt'));
      });
    });
  }

  function resetChat() {
    history.length = 0;
    const box = $('messages');
    box.innerHTML = welcomeHTML;
    bindPrompts();
    UI.scrollBottom();
  }

  function bind() {
    UI.initMessages();
    UI.updateStatus(!!DeepSeek.cfg.key, !!Amap.cfg.key);
    UI.updateLocation(null);
    welcomeHTML = $('welcome') ? $('welcome').outerHTML : '';

    const form = $('chat-form');
    const input = $('input');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      input.style.height = 'auto';
      send(text);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    });

    bindPrompts();

    $('btn-settings').addEventListener('click', openSettings);
    $('btn-close-settings').addEventListener('click', closeSettings);
    $('btn-cancel-settings').addEventListener('click', closeSettings);
    $('btn-save-settings').addEventListener('click', saveSettings);

    $('settings-modal').addEventListener('click', function (e) {
      if (e.target === $('settings-modal')) closeSettings();
    });

    $('btn-clear').addEventListener('click', resetChat);

    $('btn-relocate').addEventListener('click', function () { locate(true); });

    $('btn-map-refresh').addEventListener('click', function () {
      if (mapSpec) showMap(mapSpec);
    });

    $('btn-map-open').addEventListener('click', function (e) {
      if (!mapSpec) e.preventDefault();
    });

    const city = Amap.cfg.defaultCity;
    if (city) ctx.city = city;

    if (Amap.cfg.key) {
      locate(false);
    } else if (!DeepSeek.cfg.key) {
      setTimeout(function () { openSettings(); }, 400);
    }
  }

  document.addEventListener('DOMContentLoaded', bind);
})(window);
