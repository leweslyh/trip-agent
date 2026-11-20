/* ============================================================
 * 出行小助手 · 前端主逻辑
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 常量与默认配置 ---------- */
  const LS_KEY = 'travel-agent-config-v1';
  const DEFAULTS = {
    // 请勿在仓库中提交明文 Key，运行时通过页面设置填写
    dsKey: '',
    sfKey: '',
    amapKeys: '',
    model: 'deepseek-flash',
    effort: 'high',
    showThinking: true,
    enableWeb: true,
    enableAmap: true,
    theme: 'light',
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const state = {
    cfg: loadCfg(),
    history: [],        // 用于发送给模型的历史
    location: null,     // {lng,lat,city,address,source}
    busy: false,
    abort: null,
    attachments: [],    // dataURL 数组
    cardSeq: 0,
    mapShown: false,    // 地图面板是否已有内容
  };

  /* ---------- 配置存取 ---------- */
  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (_) { return { ...DEFAULTS }; }
  }
  function saveCfg(patch) {
    state.cfg = { ...state.cfg, ...patch };
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.cfg)); } catch (_) { /* ignore */ }
    applyCfg();
  }

  function applyCfg() {
    const c = state.cfg;
    DS.setConfig({ apiKey: c.dsKey, model: c.model, effort: c.effort, thinking: c.showThinking });
    AMapAPI.setKeys(c.amapKeys.split(/[,，\s]+/).filter(Boolean));
    $('#modelChip').textContent = c.model;
    document.documentElement.dataset.theme = c.theme;
    $('#themeBtn').textContent = c.theme === 'dark' ? '☀️' : '🌙';
    updateCaps();
  }

  function updateCaps() {
    const c = state.cfg;
    const asrOk = !!c.sfKey || !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const set = (cap, on) => {
      const el = $(`.cap[data-cap="${cap}"]`);
      if (el) { el.classList.toggle('on', !!on); el.classList.toggle('off', !on); }
    };
    set('ds', !!c.dsKey);
    set('vision', !!c.dsKey && c.model === 'deepseek-flash');
    set('asr', asrOk);
    set('amap', !!c.amapKeys.trim());
    set('web', !!c.dsKey && c.enableWeb);
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
  }

  /* ---------- 定位 ---------- */
  function setLocChip(text, busy) {
    $('#locText').textContent = text;
    $('#locChip').classList.toggle('busy', !!busy);
  }

  async function detectLocation(opts) {
    const silent = opts && opts.silent;
    setLocChip('定位中…', true);

    // 1) 高德 IP 定位（拿到城市，作为兜底）
    let ip = null;
    if (AMapAPI.hasKey()) {
      try {
        ip = await AMapAPI.ipLocation();
        if (ip.center) {
          const [lng, lat] = ip.center.split(',').map(Number);
          state.location = { lng, lat, city: ip.city, address: ip.city + '（城市中心）', source: 'IP 定位' };
          setLocChip(ip.city || '未知位置');
        }
      } catch (e) {
        if (!silent) toast('IP 定位失败：' + e.message);
      }
    }

    // 2) 浏览器精确定位（更准，需用户授权）
    if (!navigator.geolocation) {
      setLocChip(state.location ? state.location.city : '未定位');
      $('#locChip').classList.remove('busy');
      syncMapLocation();
      return state.location;
    }

    await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const lng = +pos.coords.longitude.toFixed(6);
        const lat = +pos.coords.latitude.toFixed(6);
        let addr = `${lng},${lat}`;
        let city = state.location && state.location.city;
        if (AMapAPI.hasKey()) {
          try {
            const r = await AMapAPI.regeo(`${lng},${lat}`);
            addr = r.address || addr;
            city = r.city || city;
          } catch (_) { /* ignore */ }
        }
        state.location = { lng, lat, city, address: addr, source: '浏览器定位' };
        setLocChip((city ? city + ' · ' : '') + shortAddr(addr));
        $('#locChip').classList.remove('busy');
        resolve();
      }, () => {
        setLocChip(state.location ? state.location.city : '定位被拒绝');
        $('#locChip').classList.remove('busy');
        if (!silent && !state.location) toast('未获得定位权限，将使用 IP 定位结果');
        resolve();
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
    });

    syncMapLocation();
    return state.location;
  }

  function shortAddr(a) {
    if (!a) return '';
    return a.length > 16 ? a.slice(0, 15) + '…' : a;
  }

  /* ============================================================
   * 对话渲染
   * ============================================================ */
  const chatScroll = $('#chatScroll');
  const welcomeHTML = chatScroll.innerHTML;

  function hideWelcome() {
    const w = $('#welcome');
    if (w) w.remove();
  }

  function scrollBottom(force) {
    const near = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 220;
    if (near || force) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function userMsgEl(text, images) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="avatar">🙋</div><div class="msg-body"><div class="bubble"></div></div>`;
    const bubble = el.querySelector('.bubble');
    if (images && images.length) {
      const box = document.createElement('div');
      box.className = 'bubble-images';
      images.forEach((src) => {
        const img = document.createElement('img');
        img.src = src;
        box.appendChild(img);
      });
      bubble.appendChild(box);
    }
    if (text) {
      const p = document.createElement('div');
      p.textContent = text;
      bubble.appendChild(p);
    }
    chatScroll.appendChild(el);
    scrollBottom(true);
    return el;
  }

  function assistantShell() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `
      <div class="avatar">🧭</div>
      <div class="msg-body">
        <details class="reasoning" hidden><summary>思考过程</summary><div class="r-body"></div></details>
        <div class="tools"></div>
        <div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>
        <div class="sources" hidden><div class="sources-t">参考来源</div><div class="source-list"></div></div>
      </div>`;
    chatScroll.appendChild(el);
    scrollBottom(true);
    return {
      el,
      reasoning: el.querySelector('.reasoning'),
      rBody: el.querySelector('.r-body'),
      tools: el.querySelector('.tools'),
      bubble: el.querySelector('.bubble'),
      sources: el.querySelector('.sources'),
      sourceList: el.querySelector('.source-list'),
    };
  }

  /* ---------- 工具卡片 ---------- */
  const TOOL_LABEL = {
    amap_ip_location: 'IP 定位',
    amap_geocode: '地理编码',
    amap_regeo: '逆地理编码',
    amap_poi_search: '关键字搜索',
    amap_around_search: '周边搜索',
    amap_route_plan: '路径规划',
    amap_weather: '天气查询',
    amap_static_map: '静态地图',
    web_search: '联网搜索',
    read_url: '网页抓取',
  };
  const TOOL_ICON = {
    amap_ip_location: '📍', amap_geocode: '🧭', amap_regeo: '📮',
    amap_poi_search: '🔎', amap_around_search: '🧲', amap_route_plan: '🛣️',
    amap_weather: '🌤️', amap_static_map: '🗺️', web_search: '🌐', read_url: '📄',
  };

  function argsBrief(args) {
    if (!args) return '';
    const v = args.keywords || args.destination || args.address || args.city || args.query || args.url || args.location || '';
    const s = String(v).replace(/\s+/g, ' ');
    return s.length > 34 ? s.slice(0, 33) + '…' : s;
  }

  function toolCardEl(info) {
    const el = document.createElement('div');
    el.className = 'tool-card';
    el.innerHTML = `
      <div class="tool-head">
        <span>${TOOL_ICON[info.name] || '🛠️'}</span>
        <span class="tname">${TOOL_LABEL[info.name] || info.name}</span>
        <span class="targs">${MD.escapeHtml(argsBrief(info.args))}</span>
        <span class="tstat">执行中</span>
      </div>
      <div class="tool-body"><span class="typing"><i></i><i></i><i></i></span></div>`;
    return el;
  }

  function fillToolCard(el, res) {
    const stat = el.querySelector('.tstat');
    const body = el.querySelector('.tool-body');
    stat.textContent = res.ok ? '完成' : '失败';
    stat.classList.toggle('err', !res.ok);
    body.innerHTML = '';
    const line = document.createElement('div');
    if (res.ok) {
      line.innerHTML = MD.render(compactToolText(res));
    } else {
      line.textContent = res.summary || '调用失败';
    }
    body.appendChild(line);
  }

  function compactToolText(res) {
    const c = res.card;
    if (res.name === 'amap_weather' && c) {
      const d = c.data, live = d.live;
      return live
        ? `**${d.city}** 当前 ${live.weather} **${live.temperature}℃**，${live.wind}，湿度 ${live.humidity}%`
        : `**${d.city}** 已获取未来预报`;
    }
    if (res.name === 'amap_route_plan' && c) {
      const d = c.data;
      return `**${d.modeName}** · 全程 **${AMapAPI.fmtDist(d.distance)}** · 约 **${AMapAPI.fmtDur(d.duration)}**`;
    }
    if ((res.name === 'amap_poi_search' || res.name === 'amap_around_search') && c) {
      return `找到 **${c.data.count}** 个结果，地图已标注前 ${Math.min(c.data.pois.length, 10)} 个`;
    }
    if (res.name === 'amap_ip_location' && c) {
      return `定位到 **${c.data.province} ${c.data.city}**`;
    }
    if (res.name === 'amap_geocode' && c) {
      return `\`${c.data.query}\` → \`${c.data.location}\``;
    }
    if (res.name === 'amap_regeo' && c) {
      return `**${c.data.address}**`;
    }
    if (res.name === 'web_search' || res.name === 'read_url') {
      const n = (res.sources || []).length;
      return `已获取 ${n ? n + ' 个来源的' : ''}信息`;
    }
    return res.summary || '已完成';
  }

  /* ---------- 右侧画布 ---------- */
  /* 交互地图优先；Leaflet 不可用时退回高德静态图 */
  function showMap(map) {
    if (!map) return;
    state.mapShown = true;
    $('#mapEmpty').hidden = true;
    $('#mapWrap').hidden = false;
    $('#mapCaption').textContent = map.caption || '';
    $('#gmap').hidden = false;
    $('#staticMap').hidden = true;
    switchTab('map');          // 先让容器可见，Leaflet 才能拿到正确尺寸
    MapView.show(map);
    MapView.invalidate();
  }

  function useStaticMap(map) {
    const img = $('#staticMap');
    $('#gmap').hidden = true;
    img.hidden = false;
    img.onerror = () => {
      $('#mapCaption').textContent = '地图加载失败，请检查网络或高德 Key 的「静态地图」权限';
    };
    if (map && map.imageUrl) {
      img.src = map.imageUrl;
    } else {
      img.hidden = true;
      $('#mapCaption').textContent = '交互地图不可用（Leaflet CDN 未加载）';
    }
  }

  /* 定位成功后：同步我的位置，首次自动铺一张当前城市地图 */
  function syncMapLocation() {
    const loc = state.location;
    if (!loc) return;
    MapView.setMe(loc);
    if (state.mapShown) return;
    state.mapShown = true;
    showMap({
      center: { lng: loc.lng, lat: loc.lat },
      zoom: 14,
      markers: [{ lng: loc.lng, lat: loc.lat, label: '我', kind: 'me', title: '我的位置', desc: loc.address || loc.city || '' }],
      path: [],
      caption: `当前位置${loc.city ? ' · ' + loc.city : ''} · 可拖动缩放，或直接问我附近有什么`,
      imageUrl: AMapAPI.staticMapUrl({ center: `${loc.lng},${loc.lat}`, zoom: 14, markers: [{ location: `${loc.lng},${loc.lat}`, label: '我', color: '0xef4444' }] }),
    });
  }

  function pushCard(card) {
    if (!card) return;
    state.cardSeq += 1;
    const wrap = document.createElement('div');
    wrap.className = 'rcard';
    wrap.innerHTML = cardHtml(card, state.cardSeq);
    const list = $('#cardList');
    $('#listEmpty').style.display = 'none';
    list.insertBefore(wrap, list.firstChild);
    // 只保留最近 12 张卡片
    while (list.children.length > 12) list.removeChild(list.lastChild);
    switchTab('list');
  }

  function cardHtml(card, seq) {
    const d = card.data || {};
    if (card.type === 'poi') {
      const items = (d.pois || []).slice(0, 8).map((p, i) => `
        <div class="poi">
          <div class="poi-idx">${i + 1}</div>
          <div class="poi-main">
            <div class="poi-name">${MD.escapeHtml(p.name || '未命名')}</div>
            <div class="poi-meta">${MD.escapeHtml(p.address || '')}${p.tel ? ' · ' + MD.escapeHtml(p.tel) : ''}</div>
          </div>
          ${p.distance ? `<div class="poi-dist">${AMapAPI.fmtDist(p.distance)}</div>` : ''}
        </div>`).join('');
      return `<div class="rcard-h"><span class="ic">🔎</span><b>${MD.escapeHtml(d.title || '搜索结果')}</b><span class="tag">${d.count || 0} 条</span></div>${items}`;
    }
    if (card.type === 'route') {
      const steps = (d.steps || []).slice(0, 6).map((s, i) =>
        `<div class="poi"><div class="poi-idx">${i + 1}</div><div class="poi-main"><div class="poi-meta" style="-webkit-line-clamp:2">${MD.escapeHtml(s.text)}</div></div>
         <div class="poi-dist">${AMapAPI.fmtDist(s.distance)}</div></div>`).join('');
      return `<div class="rcard-h"><span class="ic">🛣️</span><b>${d.modeName}路线</b><span class="tag">${MD.escapeHtml((d.destination || '').slice(0, 12))}</span></div>
        <div class="kv"><span>全程距离</span><b>${AMapAPI.fmtDist(d.distance)}</b></div>
        <div class="kv"><span>预计耗时</span><b>${AMapAPI.fmtDur(d.duration)}</b></div>
        ${d.tolls ? `<div class="kv"><span>过路费</span><b>${d.tolls} 元</b></div>` : ''}
        ${d.cost ? `<div class="kv"><span>公交票价</span><b>${d.cost} 元</b></div>` : ''}
        ${d.taxiCost ? `<div class="kv"><span>打车参考</span><b>${d.taxiCost} 元</b></div>` : ''}
        ${steps}`;
    }
    if (card.type === 'weather') {
      const live = d.live || {};
      const days = (d.casts || []).slice(0, 4).map((c) =>
        `<div class="fday"><i>${MD.escapeHtml((c.date || '').slice(5))}</i><b>${MD.escapeHtml(c.dayWeather || '')}</b><span>${c.nightTemp}~${c.dayTemp}℃</span></div>`).join('');
      return `<div class="rcard-h"><span class="ic">🌤️</span><b>${MD.escapeHtml(d.city || '')} 天气</b><span class="tag">${MD.escapeHtml((d.reporttime || '').slice(5, 16))}</span></div>
        <div class="weather-now"><div class="weather-temp">${live.temperature !== undefined ? MD.escapeHtml(String(live.temperature)) : '--'}<span style="font-size:13px">℃</span></div>
        <div class="weather-desc">${MD.escapeHtml(live.weather || '')}<br>${MD.escapeHtml(live.wind || '')} · 湿度 ${MD.escapeHtml(String(live.humidity || '-'))}%</div></div>
        <div class="forecast">${days}</div>`;
    }
    if (card.type === 'ip') {
      return `<div class="rcard-h"><span class="ic">📍</span><b>IP 定位</b><span class="tag">#${seq}</span></div>
        <div class="kv"><span>省份</span><b>${MD.escapeHtml(d.province || '-')}</b></div>
        <div class="kv"><span>城市</span><b>${MD.escapeHtml(d.city || '-')}</b></div>
        <div class="kv"><span>adcode</span><b>${MD.escapeHtml(d.adcode || '-')}</b></div>
        <div class="kv"><span>中心坐标</span><b>${MD.escapeHtml(d.center || '-')}</b></div>`;
    }
    if (card.type === 'geo') {
      return `<div class="rcard-h"><span class="ic">🧭</span><b>地理编码</b><span class="tag">#${seq}</span></div>
        <div class="kv"><span>地址</span><b>${MD.escapeHtml(d.query || '')}</b></div>
        <div class="kv"><span>坐标</span><b>${MD.escapeHtml(d.location || '')}</b></div>
        <div class="kv"><span>城市</span><b>${MD.escapeHtml(d.city || '')}</b></div>`;
    }
    if (card.type === 'regeo') {
      return `<div class="rcard-h"><span class="ic">📮</span><b>逆地理编码</b><span class="tag">#${seq}</span></div>
        <div class="kv"><span>地址</span><b style="max-width:70%;text-align:right">${MD.escapeHtml(d.address || '')}</b></div>
        <div class="kv"><span>区域</span><b>${MD.escapeHtml((d.city || '') + (d.district || ''))}</b></div>`;
    }
    return '';
  }

  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.stage-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
    if (name === 'map') MapView.invalidate();
  }

  /* 地图放大：把右侧画布铺到整个内容区 */
  function toggleStageWide(force) {
    const stage = $('.stage');
    const wide = force === undefined ? !stage.classList.contains('expanded') : !!force;
    stage.classList.toggle('expanded', wide);
    $('#mapExpand').textContent = wide ? '⤡' : '⤢';
    $('#mapExpand').title = wide ? '收起地图' : '放大地图';
    switchTab('map');
    MapView.invalidate();
  }

  /* ---------- 追加内容（节流渲染） ---------- */
  function makeStreamRenderer(bubble) {
    let text = '';
    let raf = null;
    let lastPaint = 0;
    const paint = () => {
      bubble.innerHTML = MD.render(text) + '<span class="cursor"></span>';
      scrollBottom();
    };
    return {
      push(delta) {
        text += delta;
        const now = performance.now();
        if (now - lastPaint > 70) { lastPaint = now; if (raf) { cancelAnimationFrame(raf); raf = null; } paint(); }
        else if (!raf) {
          raf = requestAnimationFrame(() => { raf = null; lastPaint = performance.now(); paint(); });
        }
      },
      done(finalText) {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        text = finalText !== undefined ? finalText : text;
        bubble.innerHTML = MD.render(text);
        scrollBottom();
      },
      get text() { return text; },
    };
  }

  /* ============================================================
   * 发送 & 智能体调用
   * ============================================================ */
  function setBusy(b) {
    state.busy = b;
    const btn = $('#sendBtn');
    btn.textContent = b ? '⏹' : '➤';
    btn.title = b ? '停止生成 (Esc)' : '发送 (Enter)';
  }

  function renderSources(box, listEl, sources) {
    if (!sources || !sources.length) return;
    box.hidden = false;
    listEl.innerHTML = '';
    const seen = new Set();
    sources.forEach((s, i) => {
      if (!s.url || seen.has(s.url)) return;
      seen.add(s.url);
      let host = s.site || '';
      if (!host) {
        try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch (_) { host = ''; }
      }
      // 搜索结果的标题常形如「正文标题 - 站点」，取前半段更清爽
      const title = String(s.title || host || s.url).split(' - ')[0];
      const a = document.createElement('a');
      a.className = 'source';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = title;
      a.innerHTML = `<b>${i + 1}</b><span>${MD.escapeHtml(title.slice(0, 34))}</span>`;
      listEl.appendChild(a);
    });
  }

  async function send(textOverride) {
    if (state.busy) { abortRun(); return; }

    const input = $('#input');
    const text = (textOverride !== undefined ? textOverride : input.value).trim();
    const images = state.attachments.slice();
    if (!text && !images.length) return;

    if (!state.cfg.dsKey) {
      openModal();
      toast('请先填写 DeepSeek API Key');
      return;
    }
    if (images.length && state.cfg.model === 'deepseek-v4-pro') {
      saveCfg({ model: 'deepseek-flash' });
      toast('图片理解需要 deepseek-flash，已自动切换');
    }

    hideWelcome();
    userMsgEl(text, images);
    state.history.push({ role: 'user', text, images });

    input.value = '';
    autoResize();
    clearAttachments();

    const view = assistantShell();
    const renderer = makeStreamRenderer(view.bubble);
    const toolViews = new Map();
    const collectedSources = [];

    let reasoningText = '';
    const ctrl = new AbortController();
    state.abort = ctrl;
    setBusy(true);
    $('#hint').textContent = '正在为你查询…';

    try {
      const result = await DS.runAgent({
        history: state.history.slice(-20),
        ctx: { getLocation: () => state.location, location: state.location },
        model: state.cfg.model,
        effort: state.cfg.effort,
        thinking: state.cfg.showThinking,
        enableWeb: state.cfg.enableWeb,
        enableAmap: state.cfg.enableAmap,
        signal: ctrl.signal,
        on: {
          reasoning(delta) {
            if (!state.cfg.showThinking) return;
            reasoningText += delta;
            view.reasoning.hidden = false;
            if (!view.reasoning.open) view.reasoning.open = true;
            view.rBody.textContent = reasoningText;
            view.rBody.scrollTop = view.rBody.scrollHeight;
          },
          content(delta) {
            view.bubble.classList.remove('bubble-empty');
            renderer.push(delta);
          },
          toolStart(info) {
            const el = toolCardEl(info);
            view.tools.appendChild(el);
            toolViews.set(info.id, el);
            scrollBottom();
          },
          toolResult(res) {
            const el = toolViews.get(res.id);
            if (el) fillToolCard(el, res);
            if (res.card) pushCard(res.card);
            if (res.map) showMap(res.map);
            if (res.sources && res.sources.length) {
              collectedSources.push(...res.sources);
              renderSources(view.sources, view.sourceList, collectedSources);
            }
            scrollBottom();
          },
        },
      });

      renderer.done(result.text);
      view.reasoning.open = false;
      state.history.push({ role: 'assistant', text: result.text });
      if (result.sources && result.sources.length) {
        collectedSources.push(...result.sources);
        renderSources(view.sources, view.sourceList, collectedSources);
      }
      if (!result.text) view.bubble.innerHTML = '<i style="color:var(--ink-3)">（没有返回内容）</i>';
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      renderer.done('');
      if (aborted) {
        view.bubble.innerHTML = '<i style="color:var(--ink-3)">已停止生成</i>';
      } else {
        view.bubble.innerHTML = `<div style="color:var(--err)">⚠️ ${MD.escapeHtml(e.message || '请求失败')}</div>` +
          (/401|403|auth|key/i.test(e.message || '') ? '<div style="font-size:12px;color:var(--ink-3);margin-top:6px">请到右上角 ⚙️ 检查 API Key 是否正确。</div>' : '');
        toast(e.message || '请求失败', 4000);
      }
    } finally {
      setBusy(false);
      state.abort = null;
      $('#hint').textContent = 'Enter 发送 · Shift+Enter 换行 · 支持拖拽/粘贴图片';
      scrollBottom();
    }
  }

  function abortRun() {
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
      toast('已停止生成');
    }
  }

  /* ============================================================
   * 图片输入
   * ============================================================ */
  function autoResize() {
    const el = $('#input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }

  function renderAttachments() {
    const box = $('#attachments');
    box.innerHTML = '';
    state.attachments.forEach((src, i) => {
      const d = document.createElement('div');
      d.className = 'att';
      d.innerHTML = `<img src="${src}" alt="附件"><button title="移除">✕</button>`;
      d.querySelector('button').onclick = () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      };
      box.appendChild(d);
    });
  }
  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxSide = 1280;
          let { width: w, height: h } = img;
          if (Math.max(w, h) > maxSide) {
            const scale = maxSide / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files) {
    const imgs = Array.from(files || []).filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return;
    for (const f of imgs) {
      if (state.attachments.length >= 3) { toast('最多一次发送 3 张图片'); break; }
      try {
        state.attachments.push(await compressImage(f));
      } catch (_) { toast('图片读取失败'); }
    }
    renderAttachments();
  }

  /* ============================================================
   * 语音输入
   * ============================================================ */
  const voice = { recorder: null, chunks: [], stream: null, startedAt: 0, timer: null, recognition: null, mode: null };

  function voiceHint(text) { $('#hint').textContent = text; }

  async function toggleVoice() {
    if (voice.mode) { stopVoice(); return; }

    const useSF = !!state.cfg.sfKey && navigator.mediaDevices && window.MediaRecorder;
    if (useSF) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        voice.stream = stream;
        voice.recorder = rec;
        voice.chunks = [];
        voice.mode = 'recording';
        voice.startedAt = Date.now();
        rec.ondataavailable = (e) => { if (e.data.size) voice.chunks.push(e.data); };
        rec.onstop = onRecordStop;
        rec.start();
        $('#micBtn').classList.add('rec');
        voice.timer = setInterval(() => {
          const s = Math.floor((Date.now() - voice.startedAt) / 1000);
          voiceHint(`🔴 录音中 ${s}s · 再次点击结束并转写`);
          if (s >= 60) stopVoice();
        }, 300);
        voiceHint('🔴 录音中 · 再次点击结束并转写');
        return;
      } catch (e) {
        toast('无法访问麦克风：' + e.message);
      }
    }

    // 降级：浏览器内置识别
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      const rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = true;
      rec.continuous = false;
      voice.recognition = rec;
      voice.mode = 'browser';
      $('#micBtn').classList.add('rec');
      let finalText = '';
      rec.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalText += t; else interim += t;
        }
        if (finalText || interim) {
          $('#input').value = finalText + interim;
          autoResize();
          voiceHint('🎙️ 识别中：' + (finalText + interim).slice(-40));
        }
      };
      rec.onerror = (ev) => {
        if (ev.error !== 'aborted') toast('浏览器语音识别失败：' + ev.error);
        resetVoiceUI();
      };
      rec.onend = () => {
        resetVoiceUI();
        if ($('#input').value.trim()) {
          voiceHint('已转写，按 Enter 发送');
          $('#input').focus();
        }
      };
      try { rec.start(); voiceHint('🎙️ 请说话…（浏览器内置识别）'); }
      catch (e) { toast('语音识别启动失败'); resetVoiceUI(); }
      return;
    }

    toast('当前浏览器不支持语音输入，请配置硅基流动 Key');
  }

  async function onRecordStop() {
    const blob = new Blob(voice.chunks, { type: voice.chunks[0] ? voice.chunks[0].type : 'audio/webm' });
    resetVoiceUI(true);
    if (blob.size < 1200) { toast('录音太短，请重试'); return; }
    voice.mode = 'transcribing';
    $('#micBtn').classList.add('rec');
    voiceHint('⏳ 正在转写语音…');
    try {
      const text = await DS.transcribe(blob, state.cfg.sfKey);
      if (!text) { toast('没有识别到语音内容'); return; }
      const input = $('#input');
      input.value = (input.value ? input.value + ' ' : '') + text;
      autoResize();
      input.focus();
      voiceHint('已转写，按 Enter 发送');
    } catch (e) {
      toast(e.message || '语音转写失败', 4000);
    } finally {
      voice.mode = null;
      $('#micBtn').classList.remove('rec');
    }
  }

  function stopVoice() {
    if (voice.mode === 'recording' && voice.recorder && voice.recorder.state !== 'inactive') {
      voiceHint('⏳ 正在处理录音…');
      voice.recorder.stop();
    } else if (voice.mode === 'browser' && voice.recognition) {
      voice.recognition.stop();
    }
  }

  function resetVoiceUI(keepMode) {
    clearInterval(voice.timer);
    voice.timer = null;
    if (voice.stream) { voice.stream.getTracks().forEach((t) => t.stop()); voice.stream = null; }
    voice.recorder = null;
    voice.recognition = null;
    if (!keepMode) voice.mode = null;
    $('#micBtn').classList.remove('rec');
  }

  /* ============================================================
   * 设置弹窗
   * ============================================================ */
  function openModal() {
    const c = state.cfg;
    $('#dsKey').value = c.dsKey;
    $('#sfKey').value = c.sfKey;
    $('#amapKeys').value = c.amapKeys;
    $('#modelSelect').value = c.model;
    $('#effortSelect').value = c.effort;
    $('#swThinking').checked = c.showThinking;
    $('#swWeb').checked = c.enableWeb;
    $('#swAmap').checked = c.enableAmap;
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }

  /* ============================================================
   * 事件绑定 & 初始化
   * ============================================================ */
  function bind() {
    $('#sendBtn').addEventListener('click', () => send());
    $('#input').addEventListener('input', autoResize);
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
      if (e.key === 'Escape') abortRun();
    });

    $('#imgBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      addImages(e.target.files);
      e.target.value = '';
    });
    $('#micBtn').addEventListener('click', toggleVoice);

    document.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = Array.from(items).filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
      if (files.length) { e.preventDefault(); addImages(files); }
    });

    const dropZone = $('#composer');
    ['dragover', 'dragenter'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
      e.preventDefault(); dropZone.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
      e.preventDefault(); dropZone.classList.remove('dragging');
    }));
    dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) addImages(e.dataTransfer.files);
    });

    $$('#quickList .quick-item').forEach((b) => b.addEventListener('click', () => send(b.dataset.prompt)));
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    /* 地图：降级渲染 / 点图选点 / 回到我的位置 / 放大 */
    MapView.onFallback(useStaticMap);
    MapView.onPick((loc, addr) => {
      const text = `以「${addr}」为中心，搜索附近的美食和景点，并在地图上标注`;
      if (state.busy) {
        $('#input').value = text;
        autoResize();
        toast('正在生成中，已把问题填进输入框');
        return;
      }
      send(text);
    });
    $('#mapLocate').addEventListener('click', () => {
      if (!MapView.focusMe()) detectLocation({ silent: false });
    });
    $('#mapExpand').addEventListener('click', () => toggleStageWide());

    $('#locChip').addEventListener('click', () => detectLocation({ silent: false }));
    $('#settingsBtn').addEventListener('click', openModal);
    $$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));

    $('#themeBtn').addEventListener('click', () => {
      saveCfg({ theme: state.cfg.theme === 'dark' ? 'light' : 'dark' });
    });

    $('#newChatBtn').addEventListener('click', () => {
      abortRun();
      state.history = [];
      state.cardSeq = 0;
      clearAttachments();
      chatScroll.innerHTML = welcomeHTML;
      $('#cardList').innerHTML = '';
      $('#listEmpty').style.display = '';
      MapView.reset();
      state.mapShown = false;
      $('#mapWrap').hidden = true;
      $('#mapEmpty').hidden = false;
      $('#mapCaption').textContent = '';
      switchTab('map');
      syncMapLocation();
      toast('已开启新对话');
    });

    $('#saveKeys').addEventListener('click', () => {
      saveCfg({
        dsKey: $('#dsKey').value.trim(),
        sfKey: $('#sfKey').value.trim(),
        amapKeys: $('#amapKeys').value.trim(),
        model: $('#modelSelect').value,
        effort: $('#effortSelect').value,
        showThinking: $('#swThinking').checked,
        enableWeb: $('#swWeb').checked,
        enableAmap: $('#swAmap').checked,
      });
      closeModal();
      toast('设置已保存');
      detectLocation({ silent: true });
    });

    $('#clearKeys').addEventListener('click', () => {
      saveCfg({ dsKey: '', sfKey: '', amapKeys: '' });
      $('#dsKey').value = '';
      $('#sfKey').value = '';
      $('#amapKeys').value = '';
      toast('已清除本机保存的密钥');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#modal').hidden) { closeModal(); return; }
      if ($('.stage').classList.contains('expanded')) toggleStageWide(false);
    });
  }

  function init() {
    applyCfg();
    bind();
    autoResize();
    $('#input').focus();
    detectLocation({ silent: true });
  }

  init();
})();
