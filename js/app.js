/* 出行小助手 · 页面交互与渲染 */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};
  const U = App.utils;
  const $ = U.$, $$ = U.$$, el = U.el;
  const MAX_IMAGES = 6;

  const dom = {};
  const state = {
    messages: [],
    attachments: [],
    busy: false,
    controller: null,
    recorder: new App.asr.AudioRecorder(),
    recTimer: null,
    recSeconds: 0,
    renderQueued: false,
    liveText: '',
    liveBubble: null,
    liveCards: null,
    liveTrace: null,
    liveTraceSteps: null,
    lastUser: null
  };

  const AMAP_URI = 'https://uri.amap.com';

  function cacheDom() {
    const ids = [
      'chatScroll', 'messages', 'welcome', 'input', 'btnSend', 'btnMic', 'btnUpload', 'fileInput',
      'attachStrip', 'composer', 'composerHint', 'recordingBar', 'recTime', 'recWave',
      'btnRecCancel', 'btnRecDone', 'settingsModal', 'btnOpenSettings', 'btnSettingsTop',
      'btnNewChat', 'btnClear', 'btnOpenSidebar', 'btnCloseSidebar', 'sidebar', 'sidebarMask',
      'btnSaveCfg', 'btnResetCfg', 'btnFetchModels', 'btnTestDeepseek', 'modelListHint',
      'cfgDeepseekKey', 'cfgDeepseekBase', 'cfgDeepseekModel', 'cfgDeepseekModelCustom',
      'cfgTemperature', 'cfgAmapKey', 'cfgSiliconKey', 'cfgSiliconBase', 'cfgAsrModel',
      'cfgCity', 'cfgSystem', 'cfgAutoGeo', 'toggleTools', 'toggleSearch',
      'statusDeepseek', 'statusAmap', 'statusAsr', 'dotDeepseek', 'dotAmap', 'dotAsr',
      'chipModel', 'chipSearch', 'chipVision', 'lightbox', 'lightboxImg', 'btnCloseLightbox',
      'toastStack'
    ];
    ids.forEach((id) => { dom[id] = document.getElementById(id); });
  }

  /* ================= 初始化 ================= */
  function init() {
    try {
      cacheDom();
      fillConfigForm();
      bindEvents();
      refreshStatus();
      restoreSession();
      autoGrow();
    } catch (err) {
      console.error('[出行小助手] 初始化失败：', err);
      if (U && U.toast) U.toast('界面初始化异常：' + (err && err.message ? err.message : err), 'err', 6000);
    } finally {
      /* 无论初始化是否完全成功，都必须解除 loading，避免整页空白 */
      document.body.classList.remove('app-loading');
    }
    try {
      if (!App.store.readConfig().deepseekKey) {
        setTimeout(() => U.toast('先配置 DeepSeek 与高德 Key，就能开始规划行程了', 'ok', 4200), 700);
      }
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  /* ================= 配置表单 ================= */
  function fillConfigForm() {
    const cfg = App.store.readConfig();
    dom.cfgDeepseekKey.value = cfg.deepseekKey || '';
    dom.cfgDeepseekBase.value = cfg.deepseekBase || '';
    dom.cfgDeepseekModel.value = cfg.deepseekModel || App.store.DEFAULT_MODEL;
    dom.cfgDeepseekModelCustom.value = cfg.deepseekModelCustom || '';
    dom.cfgTemperature.value = cfg.temperature;
    dom.cfgAmapKey.value = cfg.amapKey || '';
    dom.cfgSiliconKey.value = cfg.siliconKey || '';
    dom.cfgSiliconBase.value = cfg.siliconBase || '';
    dom.cfgAsrModel.value = cfg.asrModel || 'FunAudioLLM/SenseVoiceSmall';
    dom.cfgCity.value = cfg.city || '';
    dom.cfgSystem.value = cfg.systemPrompt || App.store.DEFAULT_SYSTEM;
    dom.cfgAutoGeo.checked = cfg.autoGeo !== false;
  }

  function readConfigForm() {
    let custom = dom.cfgDeepseekModelCustom.value.trim();
    /* 防止把 API Key 粘进「自定义模型 ID」，否则会把 sk-xxx 当模型名发给接口 */
    if (custom && !App.store.sanitizeModel(custom)) {
      custom = '';
      dom.cfgDeepseekModelCustom.value = '';
      U.toast('「自定义模型 ID」不是合法模型名（不能填 API Key），已自动清空', 'err', 4600);
    }
    return {
      deepseekKey: dom.cfgDeepseekKey.value.trim(),
      deepseekBase: dom.cfgDeepseekBase.value.trim() || 'https://api.deepseek.com',
      deepseekModel: dom.cfgDeepseekModel.value || App.store.DEFAULT_MODEL,
      deepseekModelCustom: custom,
      temperature: Number(dom.cfgTemperature.value) || 0.7,
      amapKey: dom.cfgAmapKey.value.trim(),
      siliconKey: dom.cfgSiliconKey.value.trim(),
      siliconBase: dom.cfgSiliconBase.value.trim() || 'https://api.siliconflow.cn/v1',
      asrModel: dom.cfgAsrModel.value,
      city: dom.cfgCity.value.trim() || '杭州',
      systemPrompt: dom.cfgSystem.value.trim() || App.store.DEFAULT_SYSTEM,
      autoGeo: dom.cfgAutoGeo.checked
    };
  }

  function refreshStatus() {
    const cfg = App.store.readConfig();
    const set = (dot, label, ok, text, warn) => {
      dot.className = 'dot' + (ok ? ' on' : warn ? ' warn' : '');
      label.textContent = text;
    };
    set(dom.dotDeepseek, dom.statusDeepseek, !!cfg.deepseekKey, cfg.deepseekKey ? App.store.modelLabel(App.store.activeModel(cfg)) : '未配置');
    set(dom.dotAmap, dom.statusAmap, !!cfg.amapKey, cfg.amapKey ? '已配置' : '未配置');
    set(dom.dotAsr, dom.statusAsr, !!cfg.siliconKey, cfg.siliconKey ? '已配置' : '未配置');
    dom.chipModel.textContent = App.store.modelLabel(App.store.activeModel(cfg));
    dom.chipSearch.classList.toggle('off', !dom.toggleSearch.checked);
    dom.chipVision.classList.toggle('off', false);
  }

  function openSettings() {
    fillConfigForm();
    dom.settingsModal.classList.add('open');
    dom.settingsModal.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    dom.settingsModal.classList.remove('open');
    dom.settingsModal.setAttribute('aria-hidden', 'true');
  }

  /* ================= 会话恢复 ================= */
  function restoreSession() {
    const saved = App.store.loadSession();
    if (!saved.length) return;
    saved.forEach((m) => {
      state.messages.push({ role: m.role, content: m.content, images: [], imageCount: m.imageCount || 0, time: m.time });
    });
    dom.welcome.style.display = 'none';
    saved.forEach((m) => {
      if (m.role === 'user') renderUserMessage({ content: m.content, images: [], imageCount: m.imageCount }, false);
      else renderRestoredAssistant(m);
    });
    scrollBottom(true);
  }

  function renderRestoredAssistant(m) {
    const wrap = el('div', { class: 'msg msg-ai' }, [
      el('div', { class: 'msg-avatar' }, [el('svg', {}, [el('use', { href: '#i-spark' })])]),
      el('div', { class: 'msg-body' }, [
        el('div', { class: 'bubble md', html: App.markdown.render(m.content) })
      ])
    ]);
    dom.messages.appendChild(wrap);
  }

  /* ================= 渲染消息 ================= */
  function hideWelcome() {
    if (dom.welcome) dom.welcome.style.display = 'none';
  }

  function renderUserMessage(msg, animate) {
    const body = el('div', { class: 'msg-body' });
    if (msg.images && msg.images.length) {
      const strip = el('div', { class: 'bubble-img-strip' });
      msg.images.forEach((img) => {
        const node = el('img', { src: img.dataUrl, alt: '上传的图片' });
        node.addEventListener('click', () => openLightbox(img.dataUrl));
        strip.appendChild(node);
      });
      body.appendChild(strip);
    } else if (msg.imageCount) {
      body.appendChild(el('div', { class: 'msg-meta', text: '（含 ' + msg.imageCount + ' 张图片，刷新后不保留）' }));
    }
    if (msg.content) body.appendChild(el('div', { class: 'bubble', text: msg.content }));
    const wrap = el('div', { class: 'msg msg-user' }, [body]);
    if (!animate) wrap.style.animation = 'none';
    dom.messages.appendChild(wrap);
  }

  function createAssistantShell() {
    state.liveText = '';

    const trace = el('div', { class: 'trace' }, [
      el('button', { class: 'trace-head', type: 'button' }, [
        el('span', { class: 'spin' }),
        el('strong', { text: '正在思考…' }),
        el('svg', { class: 'caret' }, [el('use', { href: '#i-chevron' })])
      ]),
      el('div', { class: 'trace-steps' })
    ]);
    const traceHead = trace.querySelector('.trace-head');
    traceHead.addEventListener('click', () => trace.classList.toggle('open'));
    trace.style.display = 'none';

    const bubble = el('div', { class: 'bubble md' });
    const typing = el('div', { class: 'typing' }, [el('i'), el('i'), el('i')]);
    bubble.appendChild(typing);

    const cards = el('div', { class: 'cards' });
    const meta = el('div', { class: 'msg-meta' });
    const actions = el('div', { class: 'msg-actions' });

    const body = el('div', { class: 'msg-body' }, [trace, bubble, cards, meta, actions]);
    const wrap = el('div', { class: 'msg msg-ai' }, [
      el('div', { class: 'msg-avatar' }, [el('svg', {}, [el('use', { href: '#i-spark' })])]),
      body
    ]);
    dom.messages.appendChild(wrap);

    state.liveBubble = bubble;
    state.liveCards = cards;
    state.liveTrace = trace;
    state.liveTraceSteps = trace.querySelector('.trace-steps');
    state.liveMeta = meta;
    state.liveActions = actions;
    scrollBottom(true);
    return { wrap, bubble, cards, trace, meta, actions };
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      if (!state.liveBubble) return;
      const typing = state.liveBubble.querySelector('.typing');
      if (typing) typing.remove();
      state.liveBubble.innerHTML = App.markdown.render(state.liveText);
      scrollBottom();
    });
  }

  function renderLiveTrace(trace, done) {
    if (!state.liveTrace || !state.liveTraceSteps) return;
    state.liveTrace.style.display = '';
    state.liveTrace.classList.toggle('done', !!done);
    const head = state.liveTrace.querySelector('.trace-head strong');
    const okCount = trace.filter((t) => t.ok).length;
    const failCount = trace.filter((t) => !t.ok).length;
    if (done) {
      head.textContent = '已调用 ' + trace.length + ' 个工具' + (failCount ? '，' + failCount + ' 个失败' : '');
    } else {
      head.textContent = '正在调用高德 / 联网能力…';
    }
    state.liveTraceSteps.innerHTML = trace.map((t) => {
      const status = t.ok ? '<span class="ok">完成</span>' : '<span class="fail">失败</span>';
      const extra = t.elapsed ? '<span>' + (t.elapsed / 1000).toFixed(1) + 's</span>' : '';
      return '<div class="trace-step"><b>' + U.escapeHtml(t.name) + '</b>' + status +
        '<span>' + U.escapeHtml(t.summary || '') + '</span>' + extra + '</div>';
    }).join('');
  }

  function scrollBottom(force) {
    const scroller = dom.chatScroll;
    if (!scroller) return;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 220;
    if (force || near) scroller.scrollTop = scroller.scrollHeight;
  }

  /* ================= 发送流程 ================= */
  async function send(textOverride) {
    if (state.busy) return;
    const text = (textOverride !== undefined ? textOverride : dom.input.value).trim();
    const images = state.attachments.slice();
    if (!text && !images.length) return;

    const cfg = App.store.readConfig();
    if (!cfg.deepseekKey) {
      U.toast('请先配置 DeepSeek API Key', 'err');
      openSettings();
      return;
    }

    hideWelcome();
    dom.input.value = '';
    autoGrow();
    clearAttachments();

    const userMsg = { role: 'user', content: text, images: images.map((i) => ({ dataUrl: i.dataUrl })), time: Date.now() };
    state.messages.push(userMsg);
    state.lastUser = userMsg;
    renderUserMessage(userMsg, true);
    scrollBottom(true);

    setBusy(true);
    createAssistantShell();
    state.controller = new AbortController();

    const apiMessages = buildApiMessages();
    let finalText = '';
    let result = null;

    try {
      result = await App.ai.agentRun({
        cfg,
        messages: apiMessages,
        enableTools: dom.toggleTools.checked,
        enableSearch: dom.toggleSearch.checked,
        signal: state.controller.signal,
        handlers: {
          onDelta: (delta) => { finalText += delta; state.liveText = finalText; queueRender(); },
          onReasoning: () => { /* 思考内容用于状态提示 */ },
          onToolStart: (info) => {
            const label = toolLabel(info.name);
            if (state.liveTrace) {
              state.liveTrace.style.display = '';
              state.liveTrace.classList.add('open');
              state.liveTrace.querySelector('.trace-head strong').textContent = '正在调用 ' + label + '…';
            }
          },
          onToolEnd: (info) => renderLiveTrace(info.trace, false),
          onCards: (cards) => cards.forEach((c) => appendCard(c))
        }
      });

      finalText = result.text || finalText;
      state.liveText = finalText;
      queueRender();
      renderLiveTrace(result.trace, true);
      if (result.trace.length) state.liveTrace.classList.remove('open');

      const assistant = {
        role: 'assistant',
        content: finalText,
        images: [],
        time: Date.now(),
        cards: result.cards || [],
        trace: result.trace || [],
        model: result.model
      };
      state.messages.push(assistant);
      finishAssistant(result);
      App.store.saveSession(state.messages);
    } catch (err) {
      const aborted = err && (err.message === '已停止生成' || (state.controller && state.controller.signal.aborted));
      if (state.liveBubble) {
        const typing = state.liveBubble.querySelector('.typing');
        if (typing) typing.remove();
        if (finalText) state.liveBubble.innerHTML = App.markdown.render(finalText);
      }
      if (aborted) {
        if (finalText) {
          state.messages.push({ role: 'assistant', content: finalText, images: [], time: Date.now() });
          if (state.liveBubble) state.liveBubble.innerHTML = App.markdown.render(finalText);
          if (state.liveMeta) state.liveMeta.textContent = '已停止生成';
        } else {
          U.toast('已停止生成');
          const wrap = state.liveBubble ? state.liveBubble.closest('.msg') : null;
          if (wrap) wrap.remove();
        }
      } else {
        const msg = err && err.message ? err.message : '未知错误';
        if (state.liveTrace) state.liveTrace.style.display = state.liveTraceSteps && state.liveTraceSteps.children.length ? '' : 'none';
        const box = el('div', { class: 'err-box', html: U.escapeHtml(msg) });
        if (state.liveBubble && state.liveBubble.parentNode) {
          state.liveBubble.parentNode.insertBefore(box, state.liveCards);
        }
        U.toast(msg, 'err', 5200);
        if (/API Key|Key 无效|余额/.test(msg)) openSettings();
      }
    } finally {
      setBusy(false);
      state.controller = null;
    }
  }

  function finishAssistant(result) {
    if (!state.liveMeta) return;
    const bits = [];
    bits.push(App.store.modelLabel(result.model || App.store.activeModel()));
    if (result.trace && result.trace.length) bits.push(result.trace.length + ' 次工具调用');
    bits.push(U.fmtClock());
    state.liveMeta.innerHTML = bits.map((b) => '<span>' + U.escapeHtml(b) + '</span>').join(' · ');

    const actions = state.liveActions;
    if (!actions) return;
    actions.classList.add('show');
    actions.innerHTML = '';
    const copyBtn = el('button', { class: 'mini-btn', type: 'button' }, [
      el('svg', {}, [el('use', { href: '#i-copy' })]), el('span', { text: '复制' })
    ]);
    copyBtn.addEventListener('click', async () => {
      const ok = await U.copyText(result.text || '');
      U.toast(ok ? '已复制回复' : '复制失败', ok ? 'ok' : 'err');
    });
    const retryBtn = el('button', { class: 'mini-btn', type: 'button' }, [
      el('svg', {}, [el('use', { href: '#i-refresh' })]), el('span', { text: '重新生成' })
    ]);
    retryBtn.addEventListener('click', regenerate);
    actions.appendChild(copyBtn);
    actions.appendChild(retryBtn);
  }

  function buildApiMessages() {
    const list = state.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content || (m.images && m.images.length)))
      .slice(-24)
      .map((m) => {
        if (m.role === 'user') {
          return { role: 'user', content: App.ai.buildUserContent(m.content, m.images) };
        }
        return { role: 'assistant', content: m.content || '' };
      });
    return list;
  }

  async function regenerate() {
    if (state.busy) return;
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // 移除最后一条 assistant 及其之后的 UI
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'assistant') { state.messages.splice(i, 1); break; }
    }
    const wraps = $$('.msg-ai', dom.messages);
    const lastAi = wraps[wraps.length - 1];
    if (lastAi) lastAi.remove();

    const text = lastUser.content;
    const images = lastUser.images || [];
    state.messages.pop();

    setBusy(true);
    createAssistantShell();
    state.controller = new AbortController();
    const cfg = App.store.readConfig();
    let finalText = '';
    try {
      const result = await App.ai.agentRun({
        cfg,
        messages: buildApiMessages().concat([{ role: 'user', content: App.ai.buildUserContent(text, images) }]),
        enableTools: dom.toggleTools.checked,
        enableSearch: dom.toggleSearch.checked,
        signal: state.controller.signal,
        handlers: {
          onDelta: (d) => { finalText += d; state.liveText = finalText; queueRender(); },
          onToolStart: () => { if (state.liveTrace) state.liveTrace.style.display = ''; },
          onToolEnd: (info) => renderLiveTrace(info.trace, false),
          onCards: (cards) => cards.forEach((c) => appendCard(c))
        }
      });
      state.liveText = result.text || finalText;
      queueRender();
      renderLiveTrace(result.trace, true);
      state.messages.push({ role: 'user', content: text, images });
      state.messages.push({ role: 'assistant', content: result.text || finalText, images: [], time: Date.now() });
      finishAssistant(result);
      App.store.saveSession(state.messages);
    } catch (e) {
      const box = el('div', { class: 'err-box', text: e.message || '重新生成失败' });
      if (state.liveBubble) state.liveBubble.after(box);
      U.toast(e.message || '重新生成失败', 'err');
    } finally {
      setBusy(false);
      state.controller = null;
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    dom.btnSend.classList.toggle('busy', busy);
    dom.btnSend.disabled = busy ? false : !canSend();
    dom.btnSend.title = busy ? '停止生成' : '发送';
    dom.btnMic.disabled = busy;
    dom.toggleTools.disabled = busy;
    dom.toggleSearch.disabled = busy;
  }

  function canSend() {
    return !!(dom.input.value.trim() || state.attachments.length);
  }

  function autoGrow() {
    const ta = dom.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 168) + 'px';
    dom.btnSend.disabled = state.busy ? false : !canSend();
  }

  /* ================= 工具结果卡片 ================= */
  const TOOL_LABELS = {
    amap_text_search: '关键字搜索',
    amap_around_search: '周边搜索',
    amap_geocode: '地址解析',
    amap_route: '路径规划',
    amap_weather: '天气查询',
    amap_static_map: '静态地图',
    amap_ip_location: 'IP 定位',
    web_search: '联网搜索',
    web_fetch: '网页抓取'
  };

  function toolLabel(name) {
    return TOOL_LABELS[name] || name;
  }

  function iconUse(id) {
    return el('svg', {}, [el('use', { href: '#' + id })]);
  }

  function appendCard(card) {
    if (!state.liveCards) return;
    const node = renderCard(card);
    if (!node) return;
    state.liveCards.appendChild(node);
    scrollBottom();
  }

  function renderCard(card) {
    if (!card || !card.type) return null;
    switch (card.type) {
      case 'pois': return renderPoiCard(card);
      case 'route': return renderRouteCard(card.data);
      case 'weather': return renderWeatherCard(card.data);
      case 'ip': return renderIpCard(card);
      case 'map': return renderMapCard(card);
      case 'web': return renderWebCard(card);
      default: return null;
    }
  }

  function cardHead(icon, title, sub) {
    return el('div', { class: 'card-head' }, [
      iconUse(icon),
      el('strong', { text: title }),
      sub ? el('span', { class: 'sub', text: sub }) : null
    ]);
  }

  function amapMarkerUrl(poi) {
    return AMAP_URI + '/marker?position=' + encodeURIComponent(poi.location) +
      '&name=' + encodeURIComponent(poi.name) + '&src=travel-ai&coordinate=gaode&callnative=0';
  }

  function amapNavUrl(poi) {
    return AMAP_URI + '/navigation?to=' + encodeURIComponent(poi.location) +
      '&toName=' + encodeURIComponent(poi.name) + '&mode=car&src=travel-ai&coordinate=gaode&callnative=0';
  }

  function renderPoiCard(card) {
    const body = el('div', { class: 'card-body' });
    if (!card.items || !card.items.length) {
      body.appendChild(el('div', { class: 'cfg-hint', text: '没有找到匹配的地点，可以换个关键词试试。' }));
    }
    (card.items || []).forEach((poi, idx) => {
      const metaBits = [];
      if (poi.rating) metaBits.push('<span class="star">★ ' + poi.rating.toFixed(1) + '</span>');
      if (poi.distance) metaBits.push('<span>' + U.fmtDistance(poi.distance) + '</span>');
      if (poi.cost) metaBits.push('<span>人均 ¥' + poi.cost + '</span>');
      if (poi.type) metaBits.push('<span>' + U.escapeHtml(poi.type) + '</span>');
      if (poi.address) metaBits.push('<span>' + U.escapeHtml(poi.address) + '</span>');

      const nav = el('a', {
        class: 'poi-link',
        href: amapNavUrl(poi),
        target: '_blank',
        rel: 'noopener noreferrer',
        text: '导航'
      });
      nav.addEventListener('click', (e) => e.stopPropagation());

      const row = el('div', { class: 'poi' }, [
        el('div', { class: 'poi-idx', text: String(idx + 1) }),
        el('div', { class: 'poi-main' }, [
          el('div', { class: 'poi-name', text: poi.name }),
          el('div', { class: 'poi-meta', html: metaBits.join('') })
        ]),
        el('div', { class: 'poi-actions' }, [nav])
      ]);
      row.addEventListener('click', () => {
        if (poi.location) window.open(amapMarkerUrl(poi), '_blank', 'noopener');
      });
      body.appendChild(row);
    });
    return el('div', { class: 'card' }, [cardHead('i-search', card.title || '搜索结果', card.subtitle), body]);
  }

  function renderRouteCard(r) {
    const modeText = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '公交' }[r.mode] || '路线';
    const stats = [
      { label: '总距离', value: U.fmtDistance(r.distance) || '—' },
      { label: '预计耗时', value: U.fmtDuration(r.duration) || '—' }
    ];
    if (r.tolls) stats.push({ label: '过路费', value: '¥' + r.tolls });
    if (r.cost) stats.push({ label: '票价', value: '¥' + r.cost });
    if (r.trafficLights) stats.push({ label: '红绿灯', value: r.trafficLights + ' 个' });
    if (r.walkingDistance) stats.push({ label: '步行', value: U.fmtDistance(r.walkingDistance) });

    const body = el('div', { class: 'card-body' }, [
      el('div', { class: 'route-line' }, [
        el('div', { class: 'route-nodes' }, [
          el('span', { class: 'n' }),
          el('span', { class: 'bar' }),
          el('span', { class: 'n end' })
        ]),
        el('div', { class: 'route-texts' }, [
          el('div', {}, [el('span', { text: '起点' }), el('strong', { text: r.origin })]),
          el('div', {}, [el('span', { text: '终点' }), el('strong', { text: r.destination })])
        ])
      ]),
      el('div', { class: 'route-summary' }, stats.map((s) => el('div', { class: 'route-stat' }, [
        el('span', { text: s.label }),
        el('b', { text: s.value })
      ])))
    ]);

    if (r.steps && r.steps.length) {
      const ol = el('ol', { class: 'route-steps' });
      r.steps.slice(0, 10).forEach((step) => ol.appendChild(el('li', { text: step })));
      body.appendChild(ol);
    }
    return el('div', { class: 'card' }, [cardHead('i-route', modeText + '路线方案', U.fmtDuration(r.duration)), body]);
  }

  function renderWeatherCard(w) {
    const now = w.lives && w.lives[0];
    const cast = w.forecasts && w.forecasts[0] ? w.forecasts[0] : null;
    const body = el('div', { class: 'card-body' });
    if (now) {
      body.appendChild(el('div', { class: 'weather-now' }, [
        el('div', { class: 'weather-temp', html: U.escapeHtml(String(now.temperature)) + '<sup>℃</sup>' }),
        el('div', { class: 'weather-info' }, [
          el('strong', { text: now.weather + ' · ' + now.city }),
          el('span', { text: now.windDirection + '风 ' + now.windPower + ' 级 · 湿度 ' + now.humidity + '% · ' + (now.reportTime || '') })
        ])
      ]));
    }
    if (cast && cast.casts && cast.casts.length) {
      if (!now) {
        body.appendChild(el('div', { class: 'weather-info' }, [
          el('strong', { text: cast.city + ' 未来天气' }),
          el('span', { text: '发布时间 ' + (cast.reportTime || '') })
        ]));
      }
      body.appendChild(el('div', { class: 'weather-forecast' }, cast.casts.slice(0, 4).map((c) => el('div', { class: 'wf-item' }, [
        el('span', { text: c.week || c.date }),
        el('b', { text: c.dayWeather }),
        el('em', { text: c.nightTemp + '° ~ ' + c.dayTemp + '°' })
      ]))));
    }
    return el('div', { class: 'card' }, [cardHead('i-weather', (now ? now.city : w.city) + ' 天气', now ? '实况 + 预报' : '预报'), body]);
  }

  function renderIpCard(card) {
    const d = card.data || {};
    return el('div', { class: 'card' }, [
      cardHead('i-locate', card.title || '位置', card.subtitle),
      el('div', { class: 'card-body' }, [
        el('div', { class: 'ip-row' }, [
          el('div', { class: 'ip-pin' }, [iconUse('i-locate')]),
          el('div', { class: 'ip-main' }, [
            el('strong', { text: [d.province, d.city, d.district].filter(Boolean).join(' ') || d.city || '未知' }),
            el('span', { text: d.address || (d.center ? '中心坐标 ' + d.center : '') })
          ])
        ])
      ])
    ]);
  }

  function renderMapCard(card) {
    const img = el('img', { src: card.url, alt: card.title || '静态地图', loading: 'lazy' });
    img.addEventListener('click', () => openLightbox(card.url, true));
    const openLink = el('a', {
      href: card.url, target: '_blank', rel: 'noopener noreferrer'
    }, [el('span', { text: '查看大图' }), iconUse('i-download')]);

    return el('div', { class: 'card map-card' }, [
      el('div', { class: 'map-overlay' }, [iconUse('i-map'), el('span', { text: card.title || '静态地图' })]),
      img,
      el('div', { class: 'map-foot' }, [
        el('span', { text: card.subtitle || '高德静态地图' }),
        openLink
      ])
    ]);
  }

  function renderWebCard(card) {
    const body = el('div', { class: 'card-body' });
    (card.items || []).forEach((item, idx) => {
      const link = el('a', {
        class: 'poi-name', href: item.url, target: '_blank', rel: 'noopener noreferrer',
        text: item.title || item.url, style: 'display:block'
      });
      const row = el('div', { class: 'poi' }, [
        el('div', { class: 'poi-idx', text: String(idx + 1) }),
        el('div', { class: 'poi-main' }, [
          link,
          el('div', { class: 'poi-meta' }, [el('span', { text: item.snippet || '' })])
        ])
      ]);
      body.appendChild(row);
    });
    return el('div', { class: 'card' }, [cardHead('i-globe', card.title || '联网结果', card.subtitle), body]);
  }

  /* ================= 图片输入 ================= */
  async function addFiles(files) {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type || ''));
    if (!list.length) {
      U.toast('请选择图片文件（jpg / png / webp）', 'err');
      return;
    }
    const room = MAX_IMAGES - state.attachments.length;
    if (room <= 0) {
      U.toast('最多上传 ' + MAX_IMAGES + ' 张图片', 'err');
      return;
    }
    for (const file of list.slice(0, room)) {
      if (file.size > 12 * 1024 * 1024) {
        U.toast(file.name + ' 超过 12MB，已跳过', 'err');
        continue;
      }
      try {
        const img = await U.compressImage(file, 1280, 0.86);
        state.attachments.push({ id: U.uid('img'), dataUrl: img.dataUrl, name: img.name, size: img.size });
      } catch (e) {
        U.toast('图片处理失败：' + e.message, 'err');
      }
    }
    renderAttachments();
    autoGrow();
  }

  function renderAttachments() {
    const strip = dom.attachStrip;
    strip.innerHTML = '';
    strip.classList.toggle('has', state.attachments.length > 0);
    state.attachments.forEach((att) => {
      const img = el('img', { src: att.dataUrl, alt: att.name || '图片' });
      img.addEventListener('click', () => openLightbox(att.dataUrl));
      const remove = el('button', { type: 'button', title: '移除图片' }, [iconUse('i-close')]);
      remove.addEventListener('click', () => {
        state.attachments = state.attachments.filter((x) => x.id !== att.id);
        renderAttachments();
        autoGrow();
      });
      strip.appendChild(el('div', { class: 'attach-item' }, [img, remove]));
    });
  }

  function clearAttachments() {
    state.attachments = [];
    if (dom.attachStrip) {
      dom.attachStrip.innerHTML = '';
      dom.attachStrip.classList.remove('has');
    }
  }

  function openLightbox(src, isMap) {
    dom.lightboxImg.src = src;
    dom.lightboxImg.alt = isMap ? '静态地图大图' : '图片预览';
    dom.lightbox.classList.add('open');
    dom.lightbox.setAttribute('aria-hidden', 'false');
  }

  function closeLightbox() {
    dom.lightbox.classList.remove('open');
    dom.lightbox.setAttribute('aria-hidden', 'true');
    setTimeout(() => { dom.lightboxImg.src = ''; }, 200);
  }

  /* ================= 语音输入 ================= */
  const WAVE_BARS = 26;

  function buildWave() {
    dom.recWave.innerHTML = '';
    for (let i = 0; i < WAVE_BARS; i++) dom.recWave.appendChild(el('i'));
  }

  function updateWave(level) {
    const bars = dom.recWave.children;
    for (let i = 0; i < bars.length; i++) {
      if (Math.random() > 0.55) continue;
      const h = Math.max(3, Math.round((level * 0.75 + Math.random() * 0.35) * 22));
      bars[i].style.height = Math.min(h, 20) + 'px';
    }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  async function startRecording() {
    const cfg = App.store.readConfig();
    if (!cfg.siliconKey) {
      U.toast('语音输入需要配置硅基流动 API Key', 'err', 4200);
      openSettings();
      return;
    }
    if (state.busy || state.recorder.recording) return;
    try {
      await state.recorder.start(updateWave);
    } catch (e) {
      const msg = (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
        ? '麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风'
        : '无法开始录音：' + (e && e.message ? e.message : '未知错误');
      U.toast(msg, 'err', 4600);
      return;
    }
    buildWave();
    dom.recordingBar.classList.add('on');
    dom.btnMic.classList.add('recording');
    dom.recTime.textContent = '00:00';
    dom.btnRecDone.disabled = false;
    dom.btnRecDone.textContent = '完成';
    state.recSeconds = 0;
    clearInterval(state.recTimer);
    state.recTimer = setInterval(() => {
      state.recSeconds++;
      dom.recTime.textContent = pad2(Math.floor(state.recSeconds / 60)) + ':' + pad2(state.recSeconds % 60);
      if (state.recSeconds >= 60) finishRecording();
    }, 1000);
  }

  function resetRecUI() {
    clearInterval(state.recTimer);
    state.recTimer = null;
    dom.recordingBar.classList.remove('on');
    dom.btnMic.classList.remove('recording');
    dom.btnRecDone.disabled = false;
    dom.btnRecDone.textContent = '完成';
    if (dom.recWave) {
      Array.from(dom.recWave.children).forEach((b) => { b.style.height = '3px'; });
    }
  }

  async function finishRecording() {
    if (!state.recorder.recording) return;
    clearInterval(state.recTimer);
    dom.btnRecDone.disabled = true;
    dom.btnRecDone.textContent = '识别中…';
    let audio;
    try {
      audio = await state.recorder.stop();
    } catch (e) {
      resetRecUI();
      U.toast(e.message || '录音结束失败', 'err');
      return;
    }
    dom.recordingBar.classList.remove('on');
    dom.btnMic.classList.remove('recording');
    U.toast('正在转写语音…', 'ok', 1600);
    try {
      const text = await App.asr.transcribe(audio.blob, audio.ext);
      const cur = dom.input.value.trim();
      const joiner = cur && !/[，。,.\s]$/.test(cur) ? '，' : '';
      dom.input.value = cur ? cur + joiner + text : text;
      autoGrow();
      dom.input.focus();
      U.toast('语音已转写为文字', 'ok');
    } catch (e) {
      U.toast(e.message || '语音识别失败', 'err', 5200);
      if (/Key|权限/.test(e.message || '')) openSettings();
    } finally {
      resetRecUI();
    }
  }

  function cancelRecording() {
    clearInterval(state.recTimer);
    state.recTimer = null;
    if (state.recorder.recording) state.recorder.cancel();
    resetRecUI();
    U.toast('已取消录音');
  }

  /* ================= 配置操作 ================= */
  function saveConfigFromForm() {
    const next = readConfigForm();
    if (!next.deepseekKey) {
      U.toast('DeepSeek API Key 不能为空', 'err');
      dom.cfgDeepseekKey.focus();
      return;
    }
    App.store.saveConfig(next);
    refreshStatus();
    closeSettings();
    U.toast('配置已保存', 'ok');
  }

  async function fetchModels() {
    const key = dom.cfgDeepseekKey.value.trim();
    if (!key) {
      U.toast('请先填写 DeepSeek API Key', 'err');
      dom.cfgDeepseekKey.focus();
      return;
    }
    const btn = dom.btnFetchModels;
    btn.disabled = true;
    btn.innerHTML = '<svg><use href="#i-refresh"></use></svg>拉取中…';
    try {
      const models = await App.ai.listModels(readConfigForm());
      if (!models.length) throw new Error('该账号下没有可用模型');
      const presets = [
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（V4 Pro 通用·推荐）' },
        { id: 'deepseek-flash', label: 'deepseek-flash（V4 Flash 快速）' }
      ];
      const current = dom.cfgDeepseekModel.value;
      /* 以接口真实返回的列表为准，预设只作为兜底补充，避免下拉里出现该账号不可用的模型 */
      const all = models.map((m) => ({
        id: m,
        label: (presets.find((p) => p.id === m) || {}).label || m
      }));
      presets.forEach((p) => { if (!all.some((o) => o.id === p.id)) all.push(p); });
      dom.cfgDeepseekModel.innerHTML = all
        .map((o) => '<option value="' + U.escapeHtml(o.id) + '">' + U.escapeHtml(o.label) + '</option>')
        .join('');
      dom.cfgDeepseekModel.value = all.some((o) => o.id === current) ? current : all[0].id;
      dom.modelListHint.textContent = '账号可用模型（' + models.length + '）：' + models.join('、');
      U.toast('已获取 ' + models.length + ' 个可用模型', 'ok');
    } catch (e) {
      U.toast(e.message || '获取模型列表失败', 'err', 5200);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg><use href="#i-refresh"></use></svg>拉取账号可用模型';
    }
  }

  async function testDeepseek() {
    const btn = dom.btnTestDeepseek;
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = '<svg><use href="#i-refresh"></use></svg>测试中…';
    try {
      const models = await App.ai.listModels(readConfigForm());
      U.toast('连接成功，账号下共 ' + models.length + ' 个模型', 'ok', 3600);
      dom.modelListHint.textContent = '连接正常 · 可用模型：' + models.join('、');
    } catch (e) {
      U.toast(e.message || '连接失败', 'err', 5200);
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  function resetConfigForm() {
    if (!window.confirm('确定恢复默认配置吗？已填写的 Key 会被清除。')) return;
    App.store.resetConfig();
    fillConfigForm();
    refreshStatus();
    U.toast('已恢复默认配置');
  }

  /* ================= 会话操作 ================= */
  function newChat() {
    if (state.busy) {
      U.toast('请先停止当前生成', 'err');
      return;
    }
    state.messages = [];
    state.lastUser = null;
    state.liveText = '';
    state.liveBubble = null;
    clearAttachments();
    dom.messages.innerHTML = '';
    dom.input.value = '';
    dom.welcome.style.display = '';
    App.store.clearSession();
    autoGrow();
    dom.input.focus();
    scrollBottom(true);
  }

  function clearChat() {
    if (!state.messages.length) {
      U.toast('当前没有对话内容');
      return;
    }
    if (!window.confirm('确定清空当前对话吗？此操作不可恢复。')) return;
    newChat();
    U.toast('对话已清空', 'ok');
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    // 输入
    dom.input.addEventListener('input', autoGrow);
    dom.input.addEventListener('focus', () => dom.composer.classList.add('focus'));
    dom.input.addEventListener('blur', () => dom.composer.classList.remove('focus'));
    dom.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (state.busy) return;
        send();
      }
    });

    dom.btnSend.addEventListener('click', () => {
      if (state.busy) {
        if (state.controller) state.controller.abort();
        return;
      }
      send();
    });

    // 图片
    dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    ['dragenter', 'dragover'].forEach((type) => {
      dom.composer.addEventListener(type, (e) => {
        e.preventDefault();
        dom.composer.classList.add('dragover');
      });
    });
    ['dragleave', 'dragend'].forEach((type) => {
      dom.composer.addEventListener(type, () => dom.composer.classList.remove('dragover'));
    });
    dom.composer.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.composer.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    // 语音
    dom.btnMic.addEventListener('click', () => {
      if (state.recorder.recording) finishRecording();
      else startRecording();
    });
    dom.btnRecDone.addEventListener('click', finishRecording);
    dom.btnRecCancel.addEventListener('click', cancelRecording);

    // 快捷提问
    $$('[data-prompt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prompt = btn.getAttribute('data-prompt');
        if (state.busy) {
          U.toast('正在生成回复，请稍候', 'err');
          return;
        }
        closeSidebar();
        send(prompt);
      });
    });

    // 侧栏
    dom.btnOpenSidebar.addEventListener('click', () => {
      dom.sidebar.classList.add('open');
      dom.sidebarMask.classList.add('show');
    });
    const closeSidebar = () => {
      dom.sidebar.classList.remove('open');
      dom.sidebarMask.classList.remove('show');
    };
    dom.btnCloseSidebar.addEventListener('click', closeSidebar);
    dom.sidebarMask.addEventListener('click', closeSidebar);
    dom.closeSidebar = closeSidebar;

    // 设置
    [dom.btnOpenSettings, dom.btnSettingsTop].forEach((b) => b.addEventListener('click', openSettings));
    dom.settingsModal.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-close') !== null) closeSettings();
    });
    dom.btnSaveCfg.addEventListener('click', saveConfigFromForm);
    dom.btnResetCfg.addEventListener('click', resetConfigForm);
    dom.btnFetchModels.addEventListener('click', fetchModels);
    dom.btnTestDeepseek.addEventListener('click', testDeepseek);

    // 会话
    dom.btnNewChat.addEventListener('click', newChat);
    dom.btnClear.addEventListener('click', clearChat);

    // 开关
    dom.toggleSearch.addEventListener('change', refreshStatus);
    dom.toggleTools.addEventListener('change', () => {
      U.toast(dom.toggleTools.checked ? '已开启智能体工具' : '已关闭工具调用，仅保留纯对话', 'ok', 2000);
    });

    // 图片查看器
    dom.btnCloseLightbox.addEventListener('click', closeLightbox);
    dom.lightbox.addEventListener('click', (e) => {
      if (e.target === dom.lightbox) closeLightbox();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dom.lightbox.classList.contains('open')) { closeLightbox(); return; }
      if (dom.settingsModal.classList.contains('open')) { closeSettings(); return; }
      if (state.recorder.recording) cancelRecording();
    });
  }

  /* 兜底：任何未捕获的脚本错误都不要让界面停留在隐藏状态 */
  global.addEventListener('error', (event) => {
    document.body.classList.remove('app-loading');
    console.error('[出行小助手] 运行错误：', event.error || event.message);
  });
  global.addEventListener('unhandledrejection', () => {
    document.body.classList.remove('app-loading');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
