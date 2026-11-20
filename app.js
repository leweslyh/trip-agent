/* DeepSeek Chat · 纯前端实现 */
(function () {
  "use strict";

  const LS = {
    convs: "dschat.conversations.v1",
    active: "dschat.active.v1",
    settings: "dschat.settings.v1"
  };

  const DEFAULT_SETTINGS = {
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    systemPrompt: "",
    temperature: 1,
    model: "deepseek-flash",
    thinking: false,
    stream: true,
    amapKey: "",
    agent: true,
    city: ""
  };

  /* 旧模型名（deepseek-chat / deepseek-reasoner 等）已下线，统一迁移到 V4.1 Flash */
  const MODEL_ALIASES = {
    "deepseek-chat": "deepseek-flash",
    "deepseek-reasoner": "deepseek-flash",
    "deepseek-v4-flash": "deepseek-flash",
    "deepseek-v4-flash-vision-exp": "deepseek-flash",
    "deepseek-v3": "deepseek-flash",
    "deepseek-v3.2": "deepseek-flash"
  };

  function normalizeModel(name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return DEFAULT_SETTINGS.model;
    return MODEL_ALIASES[key] || key;
  }

  const $ = (id) => document.getElementById(id);

  const ui = {
    sidebar: $("sidebar"),
    scrim: $("scrim"),
    convList: $("convList"),
    chatScroll: $("chatScroll"),
    welcome: $("welcome"),
    messages: $("messages"),
    input: $("input"),
    sendBtn: $("sendBtn"),
    stopBtn: $("stopBtn"),
    counter: $("counter"),
    modelSelect: $("modelSelect"),
    streamToggle: $("streamToggle"),
    thinkingToggle: $("thinkingToggle"),
    keyChip: $("keyChip"),
    keyChipText: $("keyChipText"),
    notice: $("notice"),
    chatTitle: $("chatTitle"),
    settingsModal: $("settingsModal"),
    apiKey: $("apiKey"),
    baseUrl: $("baseUrl"),
    systemPrompt: $("systemPrompt"),
    temperature: $("temperature"),
    tempVal: $("tempVal"),
    saveSettings: $("saveSettings"),
    amapKey: $("amapKey"),
    testAmap: $("testAmap"),
    amapTestResult: $("amapTestResult"),
    agentToggle: $("agentToggle"),
    locateBtn: $("locateBtn"),
    cityText: $("cityText")
  };

  let settings = loadSettings();
  window.Travel.configure({ key: settings.amapKey, city: settings.city });
  let convs = loadConvs();
  let activeId = localStorage.getItem(LS.active) || "";
  let controller = null;
  let busy = false;
  let autoScroll = true;
  let noticeTimer = 0;

  /* ---------------- 存储 ---------------- */

  function loadSettings() {
    /* config.js 里的 APP_CONFIG 作为默认值，localStorage 中非空的值优先 */
    const base = Object.assign({}, DEFAULT_SETTINGS, window.APP_CONFIG || {});
    try {
      const raw = JSON.parse(localStorage.getItem(LS.settings) || "{}");
      Object.keys(raw).forEach((k) => {
        const v = raw[k];
        if (v !== "" && v !== null && v !== undefined) base[k] = v;
      });
    } catch (e) {
      /* 忽略损坏的本地配置 */
    }
    base.model = normalizeModel(base.model);
    base.thinking = base.thinking === true || base.thinking === "true";
    return base;
  }

  function persistSettings() {
    localStorage.setItem(LS.settings, JSON.stringify(settings));
  }

  function loadConvs() {
    try {
      const list = JSON.parse(localStorage.getItem(LS.convs) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function persistConvs() {
    try {
      localStorage.setItem(LS.convs, JSON.stringify(convs));
      localStorage.setItem(LS.active, activeId);
    } catch (e) {
      showNotice("本地存储空间不足，历史记录可能无法保存。", "error");
    }
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function getActiveConv() {
    return convs.find((c) => c.id === activeId) || null;
  }

  function ensureConv() {
    let conv = getActiveConv();
    if (!conv) {
      conv = { id: uid(), title: "新的对话", createdAt: Date.now(), messages: [] };
      convs.unshift(conv);
      activeId = conv.id;
    }
    return conv;
  }

  /* ---------------- 提示条 ---------------- */

  function showNotice(text, type) {
    clearTimeout(noticeTimer);
    ui.notice.textContent = text;
    ui.notice.className = "notice" + (type === "ok" ? " ok" : "");
    ui.notice.hidden = false;
    noticeTimer = setTimeout(() => {
      ui.notice.hidden = true;
    }, 6000);
  }

  /* ---------------- 渲染 ---------------- */

  function renderConvList() {
    ui.convList.innerHTML = "";
    if (!convs.length) {
      ui.convList.innerHTML = '<div class="conv-empty">还没有对话记录</div>';
      return;
    }
    convs.forEach((conv) => {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.id === activeId ? " active" : "");
      item.title = conv.title || "新的对话";

      const label = document.createElement("span");
      label.textContent = conv.title || "新的对话";

      const del = document.createElement("button");
      del.className = "conv-del";
      del.type = "button";
      del.title = "删除对话";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConv(conv.id);
      });

      item.appendChild(label);
      item.appendChild(del);
      item.addEventListener("click", () => switchConv(conv.id));
      ui.convList.appendChild(item);
    });
  }

  function updateTopbar() {
    const conv = getActiveConv();
    ui.chatTitle.textContent = (conv && conv.title) || "新的对话";
    ui.modelSelect.value = settings.model;
    ui.streamToggle.checked = settings.stream;
    ui.agentToggle.checked = !!settings.agent;
    if (settings.city) {
      ui.cityText.textContent = settings.city;
      ui.locateBtn.classList.add("ok");
    } else {
      ui.cityText.textContent = "定位";
      ui.locateBtn.classList.remove("ok");
    }
    if (settings.apiKey) {
      ui.keyChip.classList.add("ok");
      ui.keyChipText.textContent = "Key " + maskKey(settings.apiKey);
    } else {
      ui.keyChip.classList.remove("ok");
      ui.keyChipText.textContent = "未配置 Key";
    }
  }

  function maskKey(key) {
    if (key.length <= 10) return "已配置";
    return key.slice(0, 5) + "···" + key.slice(-4);
  }

  function renderChat(scroll) {
    const conv = getActiveConv();
    ui.messages.innerHTML = "";
    const hasContent = !!(conv && conv.messages.length);
    ui.welcome.classList.toggle("hide", hasContent);

    if (hasContent) {
      conv.messages.forEach((msg, idx) =>
        ui.messages.appendChild(buildMessageEl(msg, idx === conv.messages.length - 1))
      );
      if (scroll !== false) scrollToBottom(true);
    } else {
      ui.chatScroll.scrollTop = 0;
    }
    autoScroll = true;
  }

  function buildMessageEl(msg, isLast) {
    const isUser = msg.role === "user";
    const canRegen = isLast !== false;
    const wrap = document.createElement("div");
    wrap.className = "msg " + (isUser ? "user" : "bot");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = isUser ? "我" : "DS";

    const body = document.createElement("div");
    body.className = "msg-body";

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const name = document.createElement("strong");
    name.textContent = isUser ? "你" : "DeepSeek";
    meta.appendChild(name);
    if (!isUser && msg.model) {
      const tag = document.createElement("span");
      tag.textContent = msg.model;
      meta.appendChild(tag);
    }
    body.appendChild(meta);

    if (!isUser && msg.reasoning) {
      body.appendChild(buildReasoningEl(msg.reasoning));
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (isUser) {
      bubble.innerHTML = window.Markdown.renderPlain(msg.content);
    } else if (msg.content) {
      bubble.innerHTML = window.Markdown.render(msg.content);
    } else if (msg.reasoning) {
      bubble.innerHTML = '<span style="color:#6b768c">（该回复只有思考过程，未生成正文）</span>';
    } else {
      bubble.innerHTML = typingHTML();
    }
    body.appendChild(bubble);

    if (!isUser && msg.cards && msg.cards.length) {
      body.appendChild(buildCardsEl(msg.cards));
    }

    if (msg.content || isUser) {
      body.appendChild(buildActions(isUser, canRegen));
    }

    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  function buildCardsEl(cards) {
    const box = document.createElement("div");
    box.className = "tool-cards";
    cards.forEach((card) => box.appendChild(buildCardEl(card)));
    return box;
  }

  function cardHead(title, link, linkText) {
    const head = document.createElement("div");
    head.className = "tcard-head";
    const strong = document.createElement("strong");
    strong.textContent = title || "";
    head.appendChild(strong);
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = linkText || "在高德打开";
      head.appendChild(a);
    }
    return head;
  }

  function buildCardEl(card) {
    const wrap = document.createElement("div");
    wrap.className = "tcard";
    if (!card || !card.type) return wrap;

    if (card.type === "pois") {
      wrap.appendChild(cardHead(card.title || "地点", card.link, "在地图中查看"));
      const body = document.createElement("div");
      body.className = "tcard-body";
      const items = card.items || [];
      items.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = "poi";

        const rank = document.createElement("div");
        rank.className = "poi-rank";
        rank.textContent = String(i + 1);

        const main = document.createElement("div");
        main.className = "poi-main";
        const name = document.createElement("div");
        name.className = "poi-name";
        name.textContent = p.name || "未知地点";
        main.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "poi-meta";
        [p.address, p.tel, p.distance, p.type].filter(Boolean).forEach((t) => {
          const span = document.createElement("span");
          span.textContent = t;
          meta.appendChild(span);
        });
        main.appendChild(meta);

        row.appendChild(rank);
        row.appendChild(main);
        body.appendChild(row);
      });
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "map-empty";
        empty.textContent = "没有找到相关地点";
        body.appendChild(empty);
      }
      wrap.appendChild(body);
      return wrap;
    }

    if (card.type === "route") {
      wrap.appendChild(cardHead(card.modeText + "路线", card.link, "开始导航"));
      const body = document.createElement("div");
      body.className = "tcard-body";

      const head = document.createElement("div");
      head.className = "route-head";
      const big = document.createElement("span");
      big.className = "route-big";
      big.textContent = card.durationText || "—";
      const sub = document.createElement("span");
      sub.className = "route-sub";
      sub.textContent = [card.distanceText, card.cost].filter(Boolean).join(" · ");
      head.appendChild(big);
      head.appendChild(sub);
      body.appendChild(head);

      const from = document.createElement("div");
      from.className = "route-sub";
      from.textContent = "起：" + (card.originName || card.origin);
      const to = document.createElement("div");
      to.className = "route-sub";
      to.textContent = "终：" + (card.destinationName || card.destination);
      body.appendChild(from);
      body.appendChild(to);

      if ((card.steps || []).length) {
        const ul = document.createElement("ul");
        ul.className = "route-steps";
        card.steps.forEach((s) => {
          const li = document.createElement("li");
          li.textContent = [s.instruction, s.distance].filter(Boolean).join("（") + (s.distance ? "）" : "");
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      wrap.appendChild(body);
      return wrap;
    }

    if (card.type === "weather") {
      const d = card.data || {};
      wrap.appendChild(
        cardHead((d.city || "天气") + (d.reportTime ? " · " + d.reportTime : ""), null)
      );
      const body = document.createElement("div");
      body.className = "tcard-body";

      const now = document.createElement("div");
      now.className = "weather-now";
      const temp = document.createElement("div");
      temp.className = "weather-temp";
      temp.textContent = d.temperature ? d.temperature + "°C" : "--";
      const desc = document.createElement("div");
      desc.className = "weather-desc";
      desc.textContent = [d.weather, d.wind, d.humidity ? "湿度 " + d.humidity + "%" : ""]
        .filter(Boolean)
        .join(" · ");
      now.appendChild(temp);
      now.appendChild(desc);
      body.appendChild(now);

      if ((d.forecast || []).length) {
        const fc = document.createElement("div");
        fc.className = "forecast";
        d.forecast.forEach((f) => {
          const day = document.createElement("div");
          day.className = "forecast-day";
          const title = document.createElement("b");
          title.textContent = f.week || f.date;
          day.appendChild(title);
          day.appendChild(document.createTextNode(f.dayWeather + " / " + f.nightWeather));
          const t = document.createElement("div");
          t.textContent = f.nightTemp + "° ~ " + f.dayTemp + "°";
          day.appendChild(t);
          fc.appendChild(day);
        });
        body.appendChild(fc);
      }
      wrap.appendChild(body);
      return wrap;
    }

    if (card.type === "map") {
      wrap.className = "tcard map-card";
      wrap.appendChild(cardHead(card.title || "地图", card.link, "在高德打开"));
      const img = document.createElement("img");
      img.alt = card.title || "静态地图";
      img.loading = "lazy";
      img.src = card.url;
      img.addEventListener("error", () => {
        const tip = document.createElement("div");
        tip.className = "map-empty";
        tip.textContent = "地图图片加载失败，请检查高德「Web 服务 Key」是否有效。";
        img.replaceWith(tip);
      });
      wrap.appendChild(img);
      return wrap;
    }

    if (card.type === "location") {
      wrap.appendChild(cardHead("IP 定位", null));
      const body = document.createElement("div");
      body.className = "loc-card";
      const city = document.createElement("b");
      city.textContent = card.city || "未知";
      body.appendChild(city);
      const tip = document.createElement("div");
      tip.className = "route-sub";
      tip.textContent = (card.province || "") + " · 基于网络 IP 的城市级定位";
      body.appendChild(tip);
      wrap.appendChild(body);
      return wrap;
    }

    if (card.type === "error") {
      wrap.className = "tcard error-card";
      wrap.appendChild(cardHead(card.title || "调用失败", null));
      const body = document.createElement("div");
      body.className = "tcard-body";
      const msg = document.createElement("div");
      msg.className = "err-msg";
      msg.textContent = card.message || "未知错误";
      body.appendChild(msg);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn err-btn";
      btn.textContent = "打开设置检查 Key";
      btn.addEventListener("click", openSettings);
      body.appendChild(btn);
      wrap.appendChild(body);
      return wrap;
    }

    return wrap;
  }

  function buildReasoningEl(text) {
    const details = document.createElement("details");
    details.className = "reasoning";
    const summary = document.createElement("summary");
    summary.textContent = "思考过程";
    const p = document.createElement("div");
    p.className = "reasoning-body";
    p.textContent = text;
    details.appendChild(summary);
    details.appendChild(p);
    return details;
  }

  const typingHTML = () => '<div class="typing"><i></i><i></i><i></i></div>';

  function buildActions(isUser, canRegen) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyText(bar.closest(".msg")));
    bar.appendChild(copy);

    if (!isUser && canRegen) {
      const regen = document.createElement("button");
      regen.type = "button";
      regen.textContent = "重新生成";
      regen.addEventListener("click", () => regenerate());
      bar.appendChild(regen);
    }
    return bar;
  }

  function scrollToBottom(force) {
    if (!force && !autoScroll) return;
    ui.chatScroll.scrollTop = ui.chatScroll.scrollHeight;
  }

  /* ---------------- 会话操作 ---------------- */

  function switchConv(id) {
    if (id === activeId) {
      closeSidebar();
      return;
    }
    stopStream();
    activeId = id;
    persistConvs();
    renderConvList();
    updateTopbar();
    renderChat(true);
    closeSidebar();
  }

  function newChat() {
    stopStream();
    const active = getActiveConv();
    if (active && active.messages.length === 0) {
      ui.input.focus();
      closeSidebar();
      return;
    }
    const conv = { id: uid(), title: "新的对话", createdAt: Date.now(), messages: [] };
    convs.unshift(conv);
    activeId = conv.id;
    persistConvs();
    renderConvList();
    updateTopbar();
    renderChat();
    ui.input.focus();
    closeSidebar();
  }

  function deleteConv(id) {
    if (busy && id === activeId) stopStream();
    convs = convs.filter((c) => c.id !== id);
    if (activeId === id) {
      activeId = convs.length ? convs[0].id : "";
      renderChat();
    }
    persistConvs();
    renderConvList();
    updateTopbar();
  }

  function clearAll() {
    if (!convs.length) return;
    if (!confirm("确定清空全部对话记录？该操作不可撤销。")) return;
    stopStream();
    convs = [];
    activeId = "";
    persistConvs();
    renderConvList();
    updateTopbar();
    renderChat();
  }

  /* ---------------- 消息发送 ---------------- */

  async function sendMessage(text) {
    const content = text.trim();
    if (!content || busy) return;

    if (!settings.apiKey) {
      showNotice("请先配置 DeepSeek API Key 后再发送。");
      openSettings();
      return;
    }

    const conv = ensureConv();
    if (!conv.title || conv.title === "新的对话") {
      conv.title = content.replace(/\s+/g, " ").slice(0, 22) || "新的对话";
      ui.chatTitle.textContent = conv.title;
    }

    const userMsg = { role: "user", content, ts: Date.now() };
    conv.messages.push(userMsg);
    persistConvs();

    ui.welcome.classList.add("hide");
    ui.messages.appendChild(buildMessageEl(userMsg));
    ui.input.value = "";
    resizeInput();
    updateCounter();
    autoScroll = true;
    scrollToBottom(true);
    renderConvList();
    persistConvs();

    await runCompletion(conv);
  }

  async function regenerate() {
    if (busy) return;
    const conv = getActiveConv();
    if (!conv || !conv.messages.length) return;

    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") {
      conv.messages.pop();
    }
    if (!conv.messages.length) return;

    renderChat(true);
    persistConvs();
    await runCompletion(conv);
  }

  const AGENT_MAX_ROUNDS = 4;

  function agentEnabled() {
    return !!settings.agent && window.Travel.hasKey();
  }

  function buildSystemPrompt(withTools) {
    const now = new Date();
    const time = now.toLocaleString("zh-CN", { hour12: false });
    const lines = [
      "你是「出行小助手」，由 DeepSeek 大模型驱动，并接入高德开放平台的地图能力。",
      "当前时间：" + time + "。"
    ];
    if (settings.city) {
      lines.push("用户当前定位城市：" + settings.city + "（来自 IP 定位，可作为默认城市）。");
    } else {
      lines.push("用户尚未定位。涉及本地信息（附近、天气）时，可先调用 ip_location 获取城市。");
    }

    if (withTools) {
      lines.push(
        "",
        "工作规则：",
        "1. 地点、坐标、距离、耗时、天气必须来自工具结果，禁止编造 POI 名称、地址和数值；工具失败要如实说明原因。",
        "2. 路线规划的起终点可直接给地址，工具会自动地理编码；跨城公交需同时给 city 与 cityd。",
        "3. 推荐附近场所先用 search_nearby，再按需调用 static_map 展示地图；需要标注多个地点时，把坐标放进 markers。",
        "4. 用户问「我在哪」或需要默认城市时调用 ip_location。",
        "5. 回答使用中文，先给结论再给要点，适合手机阅读：短段落加少量列表；距离用公里或米，时间用分钟。",
        "6. 若工具报错提示未配置高德 Key，请告诉用户到「设置 → 高德开放平台」填写。"
      );
    } else {
      lines.push(
        "",
        "当前未启用地图工具：无法查询实时地点、路线和天气。遇到这类问题要说明需要配置高德 Key 并开启「出行模式」，不要编造数据。"
      );
    }

    if (settings.systemPrompt.trim()) {
      lines.push("", "用户额外要求：", settings.systemPrompt.trim());
    }
    return lines.join("\n");
  }

  function buildRequestMessages(conv, withTools) {
    const list = [{ role: "system", content: buildSystemPrompt(withTools) }];
    conv.messages.forEach((m) => {
      if (m.role === "assistant" && !m.content) return;
      list.push({ role: m.role, content: m.content });
    });
    return list;
  }

  async function runCompletion(conv) {
    const withTools = agentEnabled();
    const model = settings.model;
    const botMsg = {
      role: "assistant",
      content: "",
      reasoning: "",
      cards: [],
      model: model,
      ts: Date.now()
    };

    const requestMessages = buildRequestMessages(conv, withTools);
    conv.messages.push(botMsg);

    const el = buildMessageEl(botMsg);
    ui.messages.appendChild(el);
    const bubble = el.querySelector(".bubble");
    const actions = el.querySelector(".msg-actions");
    if (actions) actions.remove();

    setBusy(true);
    autoScroll = true;
    scrollToBottom(true);

    let reasoningEl = null;
    let dirty = false;
    const markDirty = () => {
      dirty = true;
    };
    const paint = () => {
      if (!dirty) return;
      dirty = false;
      if (botMsg.reasoning) {
        if (!reasoningEl) {
          reasoningEl = buildReasoningEl("");
          reasoningEl.open = true;
          el.querySelector(".msg-body").insertBefore(
            reasoningEl,
            el.querySelector(".bubble")
          );
        }
        reasoningEl.querySelector(".reasoning-body").textContent = botMsg.reasoning;
      }
      const hasText = !!botMsg.content;
      bubble.innerHTML = hasText
        ? window.Markdown.render(botMsg.content) + '<span class="caret"></span>'
        : botMsg.reasoning
        ? '<span class="caret"></span>'
        : typingHTML();
      scrollToBottom();
    };
    const timer = setInterval(paint, 90);

    controller = new AbortController();
    const signal = controller.signal;

    try {
      await agentLoop({
        messages: requestMessages,
        botMsg: botMsg,
        el: el,
        signal: signal,
        withTools: withTools,
        model: model,
        markDirty: markDirty
      });
    } catch (err) {
      if (err.name === "AbortError") {
        showNotice("已停止生成。", "ok");
        if (!botMsg.content && !botMsg.reasoning && !(botMsg.cards && botMsg.cards.length)) {
          const idx = conv.messages.indexOf(botMsg);
          if (idx >= 0) conv.messages.splice(idx, 1);
          el.remove();
        }
      } else {
        const idx = conv.messages.indexOf(botMsg);
        if (idx >= 0) conv.messages.splice(idx, 1);
        el.remove();
        showNotice(err.message || "请求失败，请稍后重试。");
        console.error(err);
      }
    } finally {
      clearInterval(timer);
      controller = null;
      setBusy(false);

      if (el.isConnected) {
        if (botMsg.reasoning) {
          if (!reasoningEl) {
            reasoningEl = buildReasoningEl("");
            el.querySelector(".msg-body").insertBefore(
              reasoningEl,
              el.querySelector(".bubble")
            );
          }
          reasoningEl.querySelector(".reasoning-body").textContent = botMsg.reasoning;
          reasoningEl.open = false;
        }
        bubble.innerHTML = botMsg.content ? window.Markdown.render(botMsg.content) : "";
        const body = el.querySelector(".msg-body");
        const hasCards = !!(botMsg.cards && botMsg.cards.length);
        if ((botMsg.content || botMsg.reasoning || hasCards) && !body.querySelector(".msg-actions")) {
          body.appendChild(buildActions(false, true));
        }
        if (!botMsg.content && !botMsg.reasoning && !hasCards) {
          el.remove();
        }
      }

      persistConvs();
      renderConvList();
      scrollToBottom();
    }
  }

  const TOOL_LABELS = {
    search_poi: "搜索地点",
    search_nearby: "搜索周边",
    geocode: "解析坐标",
    route_plan: "规划路线",
    weather_query: "查询天气",
    static_map: "生成静态地图",
    ip_location: "IP 定位"
  };

  async function agentLoop(ctx) {
    const { messages, botMsg, el, signal, withTools, model, markDirty } = ctx;
    const tools = withTools ? window.Travel.TOOLS : null;
    let round = 0;
    let needSep = false;

    while (true) {
      const res = await streamRequest(messages, {
        signal: signal,
        tools: tools,
        model: model,
        onDelta: (delta, reasoning) => {
          if (delta) {
            if (needSep) {
              botMsg.content += "\n\n";
              needSep = false;
            }
            botMsg.content += delta;
          }
          if (reasoning) botMsg.reasoning += reasoning;
          markDirty();
        }
      });

      if (!res.toolCalls.length) return;

      round++;
      if (round > AGENT_MAX_ROUNDS) {
        botMsg.content += (botMsg.content ? "\n\n" : "") + "（工具调用次数已达上限，先给出目前查到的结果。）";
        markDirty();
        return;
      }

      messages.push({
        role: "assistant",
        content: res.content || "",
        tool_calls: res.toolCalls
      });

      for (const tc of res.toolCalls) {
        const name = (tc.function && tc.function.name) || "";
        let args = {};
        try {
          args = JSON.parse((tc.function && tc.function.arguments) || "{}");
        } catch (e) {
          args = {};
        }
        const tip = showToolRun(el, "正在" + (TOOL_LABELS[name] || name) + "…");
        let result;
        try {
          result = await window.Travel.executeTool(name, args);
          if (name === "ip_location") applyCity(result.cards);
        } catch (err) {
          const msg = (err && err.message) || String(err);
          result = {
            content: "工具执行失败：" + msg,
            cards: [{ type: "error", title: "高德接口调用失败", message: msg }]
          };
        }
        tip.remove();
        addCards(el, botMsg, result.cards);
        messages.push({
          role: "tool",
          tool_call_id: tc.id || "call_" + round,
          content: String(result.content || "").slice(0, 4000)
        });
      }

      needSep = true;
      markDirty();
    }
  }

  function applyCity(cards) {
    const loc = (cards || []).find((c) => c && c.type === "location" && c.city);
    if (!loc) return;
    settings.city = loc.city;
    window.Travel.configure({ city: loc.city });
    persistSettings();
    updateTopbar();
  }

  function showToolRun(el, text) {
    const div = document.createElement("div");
    div.className = "tool-run";
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.textContent = text;
    div.appendChild(dot);
    div.appendChild(label);
    const body = el.querySelector(".msg-body");
    const actions = body.querySelector(".msg-actions");
    body.insertBefore(div, actions || null);
    scrollToBottom();
    return div;
  }

  function addCards(el, botMsg, cards) {
    if (!cards || !cards.length) return;
    botMsg.cards = botMsg.cards || [];
    let box = el.querySelector(".tool-cards");
    if (!box) {
      box = document.createElement("div");
      box.className = "tool-cards";
      const body = el.querySelector(".msg-body");
      const actions = body.querySelector(".msg-actions");
      body.insertBefore(box, actions || null);
    }
    cards.forEach((card) => {
      botMsg.cards.push(card);
      box.appendChild(buildCardEl(card));
    });
    scrollToBottom();
  }

  async function streamRequest(messages, opts) {
    opts = opts || {};
    const onDelta = opts.onDelta || function () {};
    const base = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, "");
    const url = base + "/chat/completions";

    const payload = {
      model: opts.model || settings.model,
      messages: messages,
      stream: !!settings.stream
    };
    /* V4 系列默认开启思考模式，这里按设置显式开关；思考模式下 temperature 会被服务端忽略 */
    const isDeepSeekHost = /deepseek\.com/i.test(base);
    if (isDeepSeekHost) {
      payload.thinking = { type: settings.thinking ? "enabled" : "disabled" };
      if (settings.thinking) payload.reasoning_effort = "high";
    }
    if (!settings.thinking) {
      payload.temperature = Number(settings.temperature);
    }
    if (opts.tools && opts.tools.length) {
      payload.tools = opts.tools;
      payload.tool_choice = "auto";
    }

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + settings.apiKey
        },
        body: JSON.stringify(payload),
        signal: opts.signal
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error(
        "无法连接 API（" + url + "）。可能是网络不可达或浏览器跨域限制，可在设置中改用支持 CORS 的代理地址。"
      );
    }

    if (!res.ok) {
      let detail = "";
      try {
        const data = await res.json();
        detail = (data.error && (data.error.message || data.error.type)) || JSON.stringify(data);
      } catch (e) {
        detail = await res.text().catch(() => "");
      }
      const hint =
        res.status === 401
          ? "API Key 无效或已过期。"
          : res.status === 402
          ? "账户余额不足。"
          : res.status === 429
          ? "请求过于频繁，请稍后再试。"
          : "服务返回 HTTP " + res.status + "。";
      throw new Error(hint + (detail ? " " + String(detail).slice(0, 200) : ""));
    }

    const out = { content: "", reasoning: "", toolCalls: [] };

    const mergeToolCalls = (list) => {
      (list || []).forEach((d) => {
        const i = typeof d.index === "number" ? d.index : out.toolCalls.length;
        if (!out.toolCalls[i]) {
          out.toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
        }
        const slot = out.toolCalls[i];
        if (d.id) slot.id = d.id;
        if (d.type) slot.type = d.type;
        if (d.function) {
          if (d.function.name) slot.function.name += d.function.name;
          if (d.function.arguments) slot.function.arguments += d.function.arguments;
        }
      });
    };

    const handle = (json) => {
      if (json.error) throw new Error(json.error.message || "接口返回错误");
      const choice = (json.choices && json.choices[0]) || {};
      const delta = choice.delta || choice.message || {};
      if (delta.content) {
        out.content += delta.content;
        onDelta(delta.content, "");
      }
      if (delta.reasoning_content) {
        out.reasoning += delta.reasoning_content;
        onDelta("", delta.reasoning_content);
      }
      if (delta.tool_calls) mergeToolCalls(delta.tool_calls);
    };

    if (!settings.stream) {
      const data = await res.json();
      handle(data);
      out.toolCalls = out.toolCalls.filter(Boolean);
      return out;
    }

    if (!res.body || !res.body.getReader) {
      const data = await res.json();
      handle(data);
      out.toolCalls = out.toolCalls.filter(Boolean);
      return out;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.charAt(0) === ":") continue;
        if (line.indexOf("data:") !== 0) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          out.toolCalls = out.toolCalls.filter(Boolean);
          return out;
        }
        try {
          handle(JSON.parse(data));
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    out.toolCalls = out.toolCalls.filter(Boolean);
    return out;
  }

  function stopStream() {
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  function setBusy(v) {
    busy = v;
    ui.stopBtn.hidden = !v;
    ui.sendBtn.hidden = v;
    ui.input.disabled = false;
    updateSendState();
  }

  /* ---------------- 复制 ---------------- */

  function copyText(scope) {
    if (!scope) return;
    const bubble = scope.querySelector(".bubble");
    if (!bubble) return;
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll(".code-copy, .caret").forEach((n) => n.remove());
    writeClipboard(clone.innerText.replace(/\u00a0/g, " "))
      .then(() => showNotice("已复制到剪贴板。", "ok"))
      .catch(() => showNotice("复制失败，请手动选择文本。"));
  }

  function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  /* ---------------- 输入区 ---------------- */

  function resizeInput() {
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 220) + "px";
  }

  function updateCounter() {
    const len = ui.input.value.length;
    ui.counter.textContent = len ? String(len) : "0";
  }

  function updateSendState() {
    ui.sendBtn.disabled = busy || !ui.input.value.trim();
  }

  /* ---------------- 导出 ---------------- */

  function exportChat() {
    const conv = getActiveConv();
    if (!conv || !conv.messages.length) {
      showNotice("当前对话还没有内容。");
      return;
    }
    const lines = ["# " + (conv.title || "DeepSeek 对话"), ""];
    lines.push("> 导出时间：" + new Date().toLocaleString() + " · 模型：" + settings.model, "");
    conv.messages.forEach((m) => {
      lines.push("## " + (m.role === "user" ? "你" : "DeepSeek"), "");
      if (m.reasoning) {
        lines.push("<details><summary>思考过程</summary>", "", m.reasoning, "", "</details>", "");
      }
      lines.push(m.content, "");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (conv.title || settings.model).replace(/[\\/:*?"<>|]/g, "_") + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    showNotice("对话已导出为 Markdown 文件。", "ok");
  }

  /* ---------------- 设置 ---------------- */

  function renderAmapReport(box, res) {
    box.innerHTML = "";
    box.className = "amap-test-result " + (res.ok ? "ok" : "bad");
    const head = document.createElement("b");
    head.textContent = res.ok ? "高德接口可用" : "高德接口不可用，请按提示逐项排查";
    box.appendChild(head);
    const ul = document.createElement("ul");
    res.report.forEach((r) => {
      const li = document.createElement("li");
      li.className = r.ok ? "pass" : "fail";
      li.textContent = (r.ok ? "OK  " : "×  ") + r.name + "：" + r.detail;
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  async function runAmapTest() {
    const box = ui.amapTestResult;
    const btn = ui.testAmap;
    if (!box || !btn) return;

    const key = ui.amapKey.value.trim();
    if (!key) {
      box.hidden = false;
      box.className = "amap-test-result bad";
      box.textContent = "请先填写「高德 Web 服务 Key」。";
      return;
    }

    btn.disabled = true;
    box.hidden = false;
    box.className = "amap-test-result";
    box.textContent = "正在调用高德接口检查…";

    /* 用户可能填完还没保存就直接测试，这里让表单值临时生效 */
    window.Travel.configure({ key: key, city: settings.city });

    try {
      const res = await window.Travel.diagnose();
      renderAmapReport(box, res);
      if (res.ok) {
        settings.city = settings.city || "";
        updateTopbar();
      }
    } catch (err) {
      box.className = "amap-test-result bad";
      box.textContent = "测试失败：" + ((err && err.message) || err);
    } finally {
      btn.disabled = false;
    }
  }

  function openSettings() {
    ui.apiKey.value = settings.apiKey;
    ui.baseUrl.value = settings.baseUrl;
    ui.systemPrompt.value = settings.systemPrompt;
    ui.temperature.value = settings.temperature;
    ui.tempVal.textContent = Number(settings.temperature).toFixed(1);
    ui.thinkingToggle.checked = !!settings.thinking;
    ui.amapKey.value = settings.amapKey;
    ui.settingsModal.hidden = false;
    setTimeout(() => ui.apiKey.focus(), 50);
  }

  function closeSettings() {
    ui.settingsModal.hidden = true;
  }

  function saveSettingsFromForm() {
    settings.apiKey = ui.apiKey.value.trim();
    settings.baseUrl = (ui.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, "");
    settings.systemPrompt = ui.systemPrompt.value;
    settings.temperature = Number(ui.temperature.value);
    settings.thinking = ui.thinkingToggle.checked;
    settings.amapKey = ui.amapKey.value.trim();
    persistSettings();

    window.Travel.configure({ key: settings.amapKey, city: settings.city });

    updateTopbar();
    closeSettings();
    if (settings.agent && !settings.amapKey) {
      showNotice("已保存。开启出行模式还需要填写高德 Web 服务 Key。");
    } else {
      showNotice("设置已保存到本机。", "ok");
    }
  }

  function resetSettingsForm() {
    settings.baseUrl = DEFAULT_SETTINGS.baseUrl;
    settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    settings.temperature = DEFAULT_SETTINGS.temperature;
    persistSettings();
    openSettings();
    updateTopbar();
  }

  /* ---------------- 侧边栏 ---------------- */

  function openSidebar() {
    if (window.innerWidth <= 860) {
      ui.sidebar.classList.add("open");
      ui.scrim.classList.add("show");
    } else {
      ui.sidebar.classList.remove("collapsed");
    }
  }

  function closeSidebar() {
    ui.sidebar.classList.remove("open");
    ui.scrim.classList.remove("show");
  }

  /* ---------------- IP 定位 ---------------- */

  async function locateMe() {
    if (!window.Travel.hasKey()) {
      showNotice("请先在设置中填写高德 Web 服务 Key，才能使用定位与地图能力。");
      openSettings();
      return;
    }
    if (ui.locateBtn.classList.contains("busy")) return;

    const oldText = ui.cityText.textContent;
    ui.locateBtn.classList.add("busy");
    ui.cityText.textContent = "定位中…";
    try {
      await window.Travel.load();
      const loc = await window.Travel.ipLocation();
      settings.city = loc.city;
      window.Travel.configure({ city: loc.city });
      persistSettings();
      updateTopbar();
      showNotice("IP 定位：" + (loc.province || "") + loc.city + "（城市级，可能不精确）", "ok");
    } catch (err) {
      ui.cityText.textContent = oldText;
      showNotice((err && err.message) || "定位失败，请稍后再试。");
      console.error(err);
    } finally {
      ui.locateBtn.classList.remove("busy");
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  ui.input.addEventListener("input", () => {
    resizeInput();
    updateCounter();
    updateSendState();
  });

  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) sendMessage(ui.input.value);
    }
  });

  ui.sendBtn.addEventListener("click", () => sendMessage(ui.input.value));
  ui.stopBtn.addEventListener("click", stopStream);
  $("newChat").addEventListener("click", newChat);
  $("clearAll").addEventListener("click", clearAll);
  $("openSettings").addEventListener("click", openSettings);
  ui.keyChip.addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", closeSettings);
  ui.saveSettings.addEventListener("click", saveSettingsFromForm);
  if (ui.testAmap) ui.testAmap.addEventListener("click", runAmapTest);
  $("resetSettings").addEventListener("click", resetSettingsForm);
  $("exportChat").addEventListener("click", exportChat);
  $("openSidebar").addEventListener("click", openSidebar);
  $("closeSidebar").addEventListener("click", () => {
    if (window.innerWidth <= 860) closeSidebar();
    else ui.sidebar.classList.add("collapsed");
  });
  ui.scrim.addEventListener("click", closeSidebar);

  ui.settingsModal.addEventListener("click", (e) => {
    if (e.target === ui.settingsModal) closeSettings();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!ui.settingsModal.hidden) closeSettings();
      else closeSidebar();
    }
  });

  ui.modelSelect.addEventListener("change", () => {
    settings.model = ui.modelSelect.value;
    persistSettings();
  });

  ui.streamToggle.addEventListener("change", () => {
    settings.stream = ui.streamToggle.checked;
    persistSettings();
  });

  ui.agentToggle.addEventListener("change", () => {
    settings.agent = ui.agentToggle.checked;
    persistSettings();
    if (settings.agent && !window.Travel.hasKey()) {
      showNotice("出行模式需要高德 Web 服务 Key，请先在设置中填写。");
      openSettings();
    }
  });

  ui.locateBtn.addEventListener("click", locateMe);

  ui.temperature.addEventListener("input", () => {
    ui.tempVal.textContent = Number(ui.temperature.value).toFixed(1);
  });

  ui.messages.addEventListener("click", (e) => {
    const btn = e.target.closest(".code-copy");
    if (!btn) return;
    const code = btn.closest(".code-block").querySelector("code");
    writeClipboard(code.innerText).then(() => {
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1500);
    });
  });

  document.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      ui.input.value = btn.querySelector("strong").textContent;
      resizeInput();
      updateCounter();
      updateSendState();
      ui.input.focus();
    });
  });

  ui.chatScroll.addEventListener("scroll", () => {
    const gap = ui.chatScroll.scrollHeight - ui.chatScroll.scrollTop - ui.chatScroll.clientHeight;
    autoScroll = gap < 120;
  });

  /* ---------------- 启动 ---------------- */

  function init() {
    if (!convs.length) {
      const conv = { id: uid(), title: "新的对话", createdAt: Date.now(), messages: [] };
      convs.push(conv);
      activeId = conv.id;
      persistConvs();
    }
    if (!getActiveConv()) activeId = convs[0].id;

    renderConvList();
    updateTopbar();
    renderChat();
    resizeInput();
    updateCounter();
    updateSendState();

    if (!settings.apiKey) {
      setTimeout(() => {
        showNotice("首次使用请点击左下角「设置」填写 DeepSeek API Key；要查地点和路线，再填高德 Key。");
      }, 400);
    } else if (!settings.amapKey) {
      setTimeout(() => {
        showNotice("DeepSeek 已就绪。填写高德 Web 服务 Key 后即可搜索地点、规划路线和查天气。");
      }, 400);
    }

    if (location.protocol === "file:") {
      setTimeout(() => {
        showNotice(
          "当前以 file:// 打开，部分浏览器的跨域请求会被拦截。建议在目录下执行 python3 -m http.server 8000，再用 http://localhost:8000 访问。"
        );
      }, 900);
    }
  }

  init();
})();
