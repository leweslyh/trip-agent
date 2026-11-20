/* ==================== 状态与工具函数 ==================== */
const LS_DEEPSEEK = 'travel_deepseek_key';
const LS_AMAP = 'travel_amap_key';

const getDeepseekKey = () => localStorage.getItem(LS_DEEPSEEK) || '';
const getAmapKey = () => localStorage.getItem(LS_AMAP) || '';

const chatEl = document.getElementById('chatInner');
const inputEl = document.getElementById('input');
const btnSend = document.getElementById('btnSend');

let messages = [];       // DeepSeek 会话消息（含工具调用上下文）
let busy = false;
let currentCity = '';    // 最近一次定位到的城市名
let currentAdcode = '';  // 城市编码

const AI_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2h1a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z"/><path d="M8 9h8M8 12h5"/></svg>';
const USER_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';

/* ==================== JSONP 请求（跨域调用高德 Web 服务） ==================== */
function jsonp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const cb = 'amap_cb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    timer = setTimeout(() => { cleanup(); reject(new Error('高德请求超时')); }, timeout);
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('高德网络请求失败')); };
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(script);
  });
}

function qs(obj) {
  return Object.keys(obj)
    .filter(k => obj[k] !== undefined && obj[k] !== '' && obj[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}

/* ==================== 高德工具执行 ==================== */
async function executeAmapTool(name, args) {
  const key = getAmapKey();
  if (!key) return { error: '尚未配置高德 Key，请在设置中填写。' };
  try {
    switch (name) {
      case 'amap_geocode': {
        const r = await jsonp('https://restapi.amap.com/v3/geocode/geo?' + qs({ key, address: args.address, output: 'json' }));
        if (r && r.status === '1' && r.geocodes && r.geocodes.length) {
          const g = r.geocodes[0];
          return { status: '1', location: g.location, formatted_address: g.formatted_address, adcode: g.adcode, city: g.city, province: g.province };
        }
        return r;
      }
      case 'amap_regeo':
        return await jsonp('https://restapi.amap.com/v3/geocode/regeo?' + qs({ key, location: args.location, extensions: 'all', output: 'json' }));
      case 'amap_keyword_search': {
        const r = await jsonp('https://restapi.amap.com/v3/place/text?' + qs({
          key, keywords: args.keywords, city: args.city, citylimit: args.citylimit,
          page: args.page || 1, offset: args.offset || 15, extensions: 'all', output: 'json'
        }));
        return simplifyPoi(r);
      }
      case 'amap_around_search': {
        const r = await jsonp('https://restapi.amap.com/v3/place/around?' + qs({
          key, location: args.location, keywords: args.keywords,
          radius: args.radius || 3000, offset: args.offset || 15, extensions: 'all', output: 'json'
        }));
        return simplifyPoi(r);
      }
      case 'amap_route_plan': {
        const strategy = args.strategy || 'driving';
        let url;
        if (strategy === 'walking') {
          url = 'https://restapi.amap.com/v3/direction/walking?' + qs({ key, origin: args.origin, destination: args.destination, output: 'json' });
        } else if (strategy === 'transit') {
          url = 'https://restapi.amap.com/v3/direction/transit/integrated?' + qs({ key, origin: args.origin, destination: args.destination, city: args.city || currentCity, output: 'json' });
        } else {
          url = 'https://restapi.amap.com/v3/direction/driving?' + qs({ key, origin: args.origin, destination: args.destination, extensions: 'all', output: 'json' });
        }
        return simplifyRoute(await jsonp(url), strategy);
      }
      case 'amap_weather': {
        const r = await jsonp('https://restapi.amap.com/v3/weather/weatherInfo?' + qs({ key, city: args.city || currentAdcode, extensions: 'all', output: 'json' }));
        return simplifyWeather(r);
      }
      case 'amap_ip_location': {
        const r = await jsonp('https://restapi.amap.com/v3/ip?' + qs({ key, ip: args.ip, output: 'json' }));
        if (r && r.status === '1') { currentCity = r.city || r.province || ''; currentAdcode = r.adcode || ''; }
        return r;
      }
      case 'amap_static_map': {
        const markers = args.markers || args.location;
        const url = 'https://restapi.amap.com/v3/staticmap?' + qs({
          key, location: args.location, zoom: args.zoom || 14,
          size: '600*400', scale: 2,
          markers: markers ? 'mid,0xFF4D6A,A:' + markers : undefined
        });
        return { type: 'static_map', url, note: '静态地图已生成，请在回答中直接展示该图片链接' };
      }
      default:
        return { error: '未知工具：' + name };
    }
  } catch (e) {
    return { error: '高德调用出错：' + e.message };
  }
}

function simplifyPoi(r) {
  if (!r || r.status !== '1' || !r.pois) return r;
  return {
    status: '1', count: parseInt(r.count || 0),
    pois: r.pois.slice(0, 15).map(p => ({
      name: p.name, address: p.address, location: p.location, tel: p.tel,
      type: p.type, distance: p.distance, adname: p.adname
    }))
  };
}

function simplifyRoute(r, strategy) {
  if (!r || r.status !== '1') return r;
  const route = r.route;
  const paths = route && (route.paths || route.transits || []);
  const first = paths && paths[0];
  const out = { status: '1', strategy, origin: route.origin, destination: route.destination };
  if (first) {
    out.distance = first.distance;
    out.duration = first.duration;
    out.tolls = first.tolls;
    if (strategy === 'transit') {
      out.cost = first.cost;
      out.steps = (first.segments || []).map(s => {
        const line = s.bus && s.bus.buslines && s.bus.buslines[0];
        return {
          type: s.bus ? '公交' : (s.walking ? '步行' : '换乘'),
          line: line ? line.name : undefined,
          stations: line && line.departure_stop && line.arrival_stop ? line.departure_stop.name + ' → ' + line.arrival_stop.name : undefined,
          distance: s.walking ? s.walking.distance : undefined
        };
      });
    } else {
      out.steps = (first.steps || []).slice(0, 20).map(st => ({ instruction: st.instruction, road: st.road, distance: st.distance }));
    }
  }
  return out;
}

function simplifyWeather(r) {
  if (!r || r.status !== '1') return r;
  return {
    status: '1',
    lives: r.lives || [],
    forecasts: (r.forecasts || []).map(f => ({ city: f.city, adcode: f.adcode, casts: f.casts }))
  };
}

/* ==================== 高德工具定义（供 DeepSeek function calling） ==================== */
function amapFunctionTools() {
  const obj = (name, desc, props, required) => ({
    type: 'function',
    function: { name, description: desc, parameters: { type: 'object', properties: props, required: required || [] } }
  });
  return [
    obj('amap_geocode', '地理编码：将中文地址/地名转换为经纬度（GCJ-02）。后续需要坐标时（周边搜索、路径规划、地图）先用此工具。',
      { address: { type: 'string', description: '地址或地名，如"北京市朝阳区"、"天安门"' } }, ['address']),
    obj('amap_regeo', '逆地理编码：将经纬度转换为地址描述。',
      { location: { type: 'string', description: '经纬度，格式"lng,lat"，如"116.397,39.909"' } }, ['location']),
    obj('amap_keyword_search', '高德POI关键字搜索：按关键词搜索地点（如"咖啡厅"、"酒店"、"故宫"），返回名称、地址、坐标、电话等。',
      {
        keywords: { type: 'string', description: '搜索关键词' },
        city: { type: 'string', description: '城市名或城市编码，如"北京"或"010"，可选' },
        citylimit: { type: 'string', description: '是否限制在城市内，"true"/"false"，可选' },
        page: { type: 'integer', description: '页码，默认1' },
        offset: { type: 'integer', description: '每页条数，默认15，最大25' }
      }, ['keywords']),
    obj('amap_around_search', '高德周边搜索：根据中心点经纬度搜索周边POI（如"附近的餐厅"）。',
      {
        location: { type: 'string', description: '中心点经纬度，格式"lng,lat"，如"116.397428,39.90923"' },
        keywords: { type: 'string', description: '搜索关键词，如"餐厅"、"酒店"' },
        radius: { type: 'integer', description: '搜索半径（米），默认3000' },
        offset: { type: 'integer', description: '每页条数，默认15' }
      }, ['location']),
    obj('amap_route_plan', '高德路径规划：查询两点间驾车/步行/公交路线，返回距离、耗时、步骤。若给的是地名，先用 amap_geocode 转坐标。',
      {
        origin: { type: 'string', description: '起点经纬度"lng,lat"' },
        destination: { type: 'string', description: '终点经纬度"lng,lat"' },
        strategy: { type: 'string', description: '交通方式：driving/walking/transit，默认driving' },
        city: { type: 'string', description: '公交路线时的城市名或编码' }
      }, ['origin', 'destination']),
    obj('amap_weather', '高德天气查询：查询指定城市/区县实时天气和未来3天预报。',
      { city: { type: 'string', description: '城市名称或城市编码（adcode），如"北京"、"110000"' } }, ['city']),
    obj('amap_ip_location', '高德IP定位：根据IP获取所在省市及城市编码。不填IP则定位当前用户。',
      { ip: { type: 'string', description: 'IP地址，可选，不填则使用当前用户IP' } }, []),
    obj('amap_static_map', '生成高德静态地图图片URL，用于在对话中展示地图。',
      {
        location: { type: 'string', description: '地图中心点"lng,lat"' },
        zoom: { type: 'integer', description: '缩放级别3-18，默认14' },
        markers: { type: 'string', description: '标记点"lng,lat"，多个用分号分隔，如"116.397,39.909;116.48,39.91"' }
      }, ['location'])
  ];
}

/* ==================== DeepSeek 调用 ==================== */
function systemPrompt() {
  const today = new Date();
  const dateStr = today.getFullYear() + '年' + (today.getMonth() + 1) + '月' + today.getDate() + '日 ' +
    ['日', '一', '二', '三', '四', '五', '六'][today.getDay()];
  return '你是"出行小助手"，一个基于 DeepSeek 与高德地图的智能出行助手。今天是' + dateStr + '。' +
    (currentCity ? '用户当前所在城市：' + currentCity + '。' : '') +
    '\n你可以调用以下高德工具获取真实数据：amap_geocode(地理编码)、amap_regeo(逆地理编码)、amap_keyword_search(关键字搜索)、amap_around_search(周边搜索)、amap_route_plan(路径规划)、amap_weather(天气)、amap_static_map(静态地图)、amap_ip_location(IP定位)。' +
    '\n你还可以使用内置联网搜索与阅读链接工具获取最新信息。' +
    '\n使用规则：' +
    '\n1. 用户询问地点、路线、天气、位置等需要地理数据时，主动调用对应高德工具获取真实数据。' +
    '\n2. 路径规划或周边搜索时，若用户给的是地名而非坐标，先用 amap_geocode 转换。' +
    '\n3. 展示地图时调用 amap_static_map，并在回答中直接给出该图片URL（会自动渲染成图片）。' +
    '\n4. 涉及实时资讯、攻略、新闻时使用联网搜索。' +
    '\n5. 用中文自然语言组织回答，简洁、友好、实用，不要直接输出原始JSON。' +
    '\n6. 若工具返回 error 或 key 缺失，请友好提示用户配置对应 Key。';
}

async function callDeepSeek(msgs) {
  const key = getDeepseekKey();
  if (!key) throw new Error('NO_KEY');
  const model = document.getElementById('modelSelect').value || 'deepseek-flash';
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: msgs,
      tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }, ...amapFunctionTools()],
      stream: false
    })
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch (e) {}
    throw new Error('DeepSeek API 错误 ' + resp.status + (detail ? '：' + detail.slice(0, 300) : ''));
  }
  const data = await resp.json();
  return data.choices[0].message;
}

/* 工具调用循环 */
async function runAssistant(userText, onStatus) {
  const userMsg = { role: 'user', content: userText };
  const msgs = [{ role: 'system', content: systemPrompt() }, ...messages, userMsg];
  let assistant = null;
  for (let i = 0; i < 8; i++) {
    assistant = await callDeepSeek(msgs);
    // 客户端函数调用（高德工具）
    if (assistant.tool_calls && assistant.tool_calls.length) {
      const pushed = { role: 'assistant', content: assistant.content || '', tool_calls: assistant.tool_calls };
      if (assistant.server_tool_calls) pushed.server_tool_calls = assistant.server_tool_calls;
      if (assistant.annotations) pushed.annotations = assistant.annotations;
      msgs.push(pushed);
      for (const tc of assistant.tool_calls) {
        if (tc.type !== 'function') continue;
        onStatus('正在执行：' + toolLabel(tc.function.name) + '…');
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        const result = await executeAmapTool(tc.function.name, args);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    break;
  }
  // 更新会话历史（剔除每次动态注入的 system 消息）
  messages = msgs.filter(m => m.role !== 'system');
  return assistant;
}

function toolLabel(name) {
  const map = {
    amap_geocode: '地理编码', amap_regeo: '逆地理编码', amap_keyword_search: '关键字搜索',
    amap_around_search: '周边搜索', amap_route_plan: '路径规划', amap_weather: '天气查询',
    amap_static_map: '静态地图', amap_ip_location: 'IP定位'
  };
  return map[name] || name;
}

/* ==================== 渲染 ==================== */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderContent(text) {
  if (!text) return '';
  const urls = [];
  let t = String(text).replace(/(https?:\/\/[^\s<>"'）】]+)/g, (m) => { urls.push(m); return '%%URL' + (urls.length - 1) + '%%'; });
  let html = escapeHtml(t);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/%%URL(\d+)%%/g, (m, i) => {
    const u = urls[+i];
    if (u.includes('restapi.amap.com/v3/staticmap')) return '<img class="map-img" src="' + u + '" alt="地图" loading="lazy">';
    return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
  });
  return html;
}

function citationsHtml(annotations) {
  if (!annotations || !annotations.length) return '';
  const links = annotations
    .filter(a => a.type === 'url_citation' && a.url_citation && a.url_citation.url)
    .map(a => '<a href="' + escapeHtml(a.url_citation.url) + '" target="_blank" rel="noopener">' +
      escapeHtml(a.url_citation.title || a.url_citation.url) + '</a>').join('');
  if (!links) return '';
  return '<div class="citations"><div class="cite-title">📚 参考来源</div>' + links + '</div>';
}

function addMessage(role, contentHtml, annotations) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  wrap.innerHTML = '<div class="avatar">' + (role === 'user' ? USER_AVATAR : AI_AVATAR) + '</div>' +
    '<div class="bubble">' + contentHtml + citationsHtml(annotations) + '</div>';
  chatEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function addStatusMessage() {
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = '<div class="avatar">' + AI_AVATAR + '</div>' +
    '<div class="bubble"><div class="status-line"><span class="dot"></span><span class="status-text">正在思考…</span></div></div>';
  chatEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function scrollBottom() {
  const c = document.getElementById('chat');
  requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

function welcomeMessage() {
  addMessage('ai', renderContent(
    '你好！我是<b>出行小助手</b>，基于 DeepSeek 与高德地图构建。🚀\n\n我可以帮你：\n🔍 关键字搜索地点 · 📍 周边搜索 · 🚗 路径规划\n🌤 天气查询 · 🗺 静态地图 · 🌐 IP定位 · 🔎 联网搜索\n\n请先点击右上角「⚙️ 设置」填写 DeepSeek API Key 和高德 Key，然后输入你的出行需求～'
  ));
}

/* ==================== 发送消息 ==================== */
async function handleSend(text) {
  if (busy) return;
  text = (text || inputEl.value).trim();
  if (!text) return;
  if (!getDeepseekKey()) { openSettings(); addMessage('ai', renderContent('请先在「⚙️ 设置」中填写 <b>DeepSeek API Key</b>，我才能开始工作～')); return; }

  busy = true;
  btnSend.disabled = true;
  inputEl.value = '';
  autoGrow();

  addMessage('user', escapeHtml(text).replace(/\n/g, '<br>'));
  const statusWrap = addStatusMessage();
  const statusText = statusWrap.querySelector('.status-text');

  try {
    const assistant = await runAssistant(text, (s) => { if (statusText) statusText.textContent = s; });
    const content = assistant.content || '';
    const citations = assistant.annotations;
    statusWrap.querySelector('.bubble').innerHTML = (content ? renderContent(content) : '<i>（无文本回复）</i>') + citationsHtml(citations);
  } catch (e) {
    let msg = '出错了：' + e.message;
    if (e.message === 'NO_KEY') msg = '请先在设置中填写 DeepSeek API Key。';
    statusWrap.querySelector('.bubble').innerHTML = renderContent(msg);
  } finally {
    busy = false;
    btnSend.disabled = false;
    scrollBottom();
  }
}

/* ==================== 定位（IP + 天气） ==================== */
async function doLocate() {
  if (!getAmapKey()) { openSettings(); return; }
  const elCity = document.getElementById('locCity');
  const elDetail = document.getElementById('locDetail');
  const elWeather = document.getElementById('locWeather');
  elCity.textContent = '定位中…';
  try {
    const r = await jsonp('https://restapi.amap.com/v3/ip?' + qs({ key: getAmapKey(), output: 'json' }));
    if (r && r.status === '1') {
      currentCity = r.city || r.province || '';
      currentAdcode = r.adcode || '';
      elCity.textContent = (r.province ? r.province : '') + (r.city ? ' ' + r.city : '') + (r.district ? ' ' + r.district : '');
      elDetail.textContent = 'IP定位 · 城市编码 ' + (r.adcode || '未知');
      if (r.adcode) {
        try {
          const w = await jsonp('https://restapi.amap.com/v3/weather/weatherInfo?' + qs({ key: getAmapKey(), city: r.adcode, extensions: 'base', output: 'json' }));
          if (w && w.status === '1' && w.lives && w.lives[0]) {
            const l = w.lives[0];
            elWeather.innerHTML = '🌡 ' + l.weather + ' · ' + l.temperature + '℃　💨 ' + l.winddirection + '风 ' + l.windpower + '级　💧 湿度 ' + l.humidity + '%';
          }
        } catch (e) {}
      }
    } else {
      elCity.textContent = '定位失败';
      elDetail.textContent = (r && r.info) || '请检查高德 Key';
    }
  } catch (e) {
    elCity.textContent = '定位失败';
    elDetail.textContent = e.message;
  }
}

/* ==================== UI 事件 ==================== */
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
}

function openSettings() {
  document.getElementById('inpDeepseekKey').value = getDeepseekKey();
  document.getElementById('inpAmapKey').value = getAmapKey();
  document.getElementById('settingsModal').classList.add('show');
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
}

function bindEvents() {
  btnSend.addEventListener('click', () => handleSend());
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); }
  });

  document.querySelectorAll('.quick-item').forEach(el => {
    el.addEventListener('click', () => { inputEl.value = el.dataset.prompt; autoGrow(); handleSend(); });
  });

  document.getElementById('btnSettings').addEventListener('click', openSettings);
  document.getElementById('btnSettingsMobile').addEventListener('click', openSettings);
  document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
  document.getElementById('btnLocate').addEventListener('click', doLocate);
  document.getElementById('btnLocateMobile').addEventListener('click', doLocate);

  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    localStorage.setItem(LS_DEEPSEEK, document.getElementById('inpDeepseekKey').value.trim());
    localStorage.setItem(LS_AMAP, document.getElementById('inpAmapKey').value.trim());
    closeSettings();
  });

  document.getElementById('btnClear').addEventListener('click', () => {
    messages = [];
    chatEl.innerHTML = '';
    welcomeMessage();
  });

  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
}

/* ==================== 初始化 ==================== */
welcomeMessage();
bindEvents();
autoGrow();
