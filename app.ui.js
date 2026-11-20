/* 出行小助手 - UI 渲染、设置界面与交互 */

function setStatus(text, type = 'loading') {
  const bar = document.getElementById('statusBar');
  const t = document.getElementById('statusText');
  bar.className = 'status' + (type === 'online' ? ' online' : type === 'error' ? ' error' : '');
  t.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scrollToBottom() {
  const c = document.getElementById('messages');
  c.scrollTop = c.scrollHeight;
}

function addMessage(role, text) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const avatar = role === 'user' ? '🧑' : '🤖';
  div.innerHTML = `<div class="avatar">${avatar}</div><div class="bubble">${escapeHtml(text)}</div>`;
  container.appendChild(div);
  scrollToBottom();
  return div;
}

function addAssistantNote(text) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<div class="avatar">🤖</div><div class="bubble" style="color:#8a90a0;font-size:12px;">⚙️ ${escapeHtml(text)}</div>`;
  container.appendChild(div);
  scrollToBottom();
}

function addTyping() {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'typingIndicator';
  div.innerHTML = `<div class="avatar">🤖</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
  container.appendChild(div);
  scrollToBottom();
}

function removeTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

// ---------------- 结果面板 ----------------
function showResult(title, html) {
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultBody').innerHTML = html;
  document.getElementById('resultCard').classList.add('show');
  document.getElementById('resultPlaceholder').style.display = 'none';
}

function hideResult() {
  document.getElementById('resultCard').classList.remove('show');
  document.getElementById('resultPlaceholder').style.display = '';
}

function renderResult(title, html) { showResult(title, html); }

function renderPOIs(title, imgUrl, pois, total) {
  const items = pois.map((p, i) => {
    const dist = p.distance ? `<span class="poi-tag">${p.distance}m</span>` : '';
    const type = p.type ? ' · ' + escapeHtml(p.type.split(';')[0]) : '';
    return `<div class="poi-item"><div class="poi-idx">${i + 1}</div><div class="poi-info"><div class="poi-name">${escapeHtml(p.name)}</div><div class="poi-addr">${escapeHtml(p.address || '')}${type}</div></div>${dist}</div>`;
  }).join('');
  const more = total > pois.length ? `<p style="font-size:12px;color:#9ca3af;margin-top:10px;">共 ${total} 个结果，仅展示前 ${pois.length} 个</p>` : '';
  showResult(title, `<div class="map-preview"><img src="${imgUrl}" alt="地图预览" onclick="zoomImage(this.src)"></div><div class="poi-list">${items}</div>${more}`);
}

function zoomImage(src) {
  document.getElementById('imgModalImg').src = src;
  document.getElementById('imgModal').classList.add('show');
}

// ---------------- 设置界面 ----------------
function openSettings() {
  const cfg = getConfig();
  document.getElementById('cfgAmapKey').value = cfg.amapKey;
  document.getElementById('cfgDeepseekKey').value = cfg.deepseekKey;
  setSettingsMsg('', '');
  document.getElementById('settingsModal').classList.add('show');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
}

function setSettingsMsg(text, type = '') {
  const el = document.getElementById('settingsMsg');
  el.textContent = text;
  el.className = 'settings-msg ' + type;
}

function handleSaveSettings() {
  const amapKey = document.getElementById('cfgAmapKey').value.trim();
  const deepseekKey = document.getElementById('cfgDeepseekKey').value.trim();
  if (!amapKey) { setSettingsMsg('请填写高德 Web 服务 Key', 'err'); return; }
  if (!deepseekKey) { setSettingsMsg('请填写 DeepSeek API Key', 'err'); return; }
  saveConfig({ amapKey, deepseekKey });
  setSettingsMsg('✅ 已保存', 'ok');
  setTimeout(() => { closeSettings(); location.reload(); }, 800);
}

async function handleTestKeys() {
  const amapKey = document.getElementById('cfgAmapKey').value.trim();
  const deepseekKey = document.getElementById('cfgDeepseekKey').value.trim();
  setSettingsMsg('正在测试…', '');
  const results = [];
  // 测试高德
  if (amapKey) {
    try {
      const r = await fetch(`https://restapi.amap.com/v3/ip?key=${amapKey}`);
      const d = await r.json();
      results.push(String(d.status) === '1' ? '✅ 高德 Key 有效' : '❌ 高德 Key 无效：' + (d.info || d.infocode));
    } catch (e) { results.push('❌ 高德测试失败：' + e.message); }
  } else { results.push('⚠️ 未填写高德 Key'); }
  // 测试 DeepSeek
  if (deepseekKey) {
    try {
      const cfg = getConfig();
      const r = await fetch(cfg.deepseekUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deepseekKey },
        body: JSON.stringify({ model: cfg.deepseekModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
      });
      results.push(r.ok ? '✅ DeepSeek Key 有效' : '❌ DeepSeek Key 无效 (' + r.status + ')');
    } catch (e) { results.push('❌ DeepSeek 测试失败：' + e.message); }
  } else { results.push('⚠️ 未填写 DeepSeek Key'); }
  setSettingsMsg(results.join('　'), '');
}

// ---------------- 发送 ----------------
async function handleSend() {
  const input = document.getElementById('userInput');
  const text = input.value.trim();
  if (!text) return;
  const cfg = getConfig();
  if (!cfg.amapKey || !cfg.deepseekKey) {
    addMessage('assistant', '请先在右上角「⚙️ 设置」中填写高德 Web 服务 Key 和 DeepSeek Key。');
    openSettings();
    return;
  }
  input.value = '';
  input.style.height = 'auto';
  addMessage('user', text);
  conversation.push({ role: 'user', content: text });
  const btn = document.getElementById('btnSend');
  btn.disabled = true;
  addTyping();
  try {
    const reply = await runAgent(text);
    removeTyping();
    addMessage('assistant', reply);
    conversation.push({ role: 'assistant', content: reply });
  } catch (e) {
    removeTyping();
    console.error(e);
    addMessage('assistant', '出错啦：' + e.message);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  document.getElementById('btnSend').addEventListener('click', handleSend);
  document.getElementById('userInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  document.getElementById('userInput').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('userInput').value = chip.dataset.cmd;
      handleSend();
    });
  });

  document.getElementById('btnClearChat').addEventListener('click', () => {
    document.getElementById('messages').innerHTML = '';
    conversation = [];
    addMessage('assistant', '对话已清空，请描述你的出行需求～');
  });

  document.getElementById('btnCloseResult').addEventListener('click', hideResult);

  // 设置弹窗
  document.getElementById('btnOpenSettings').addEventListener('click', openSettings);
  document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
  document.getElementById('settingsMask').addEventListener('click', closeSettings);
  document.getElementById('btnSaveSettings').addEventListener('click', handleSaveSettings);
  document.getElementById('btnTestKeys').addEventListener('click', handleTestKeys);

  // 图片弹窗
  document.getElementById('btnCloseImg').addEventListener('click', () => document.getElementById('imgModal').classList.remove('show'));
  document.getElementById('imgMask').addEventListener('click', () => document.getElementById('imgModal').classList.remove('show'));
  document.getElementById('btnDownloadMap').addEventListener('click', () => {
    const src = document.getElementById('imgModalImg').src;
    const a = document.createElement('a');
    a.href = src;
    a.download = 'static-map-' + Date.now() + '.png';
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
  });
}

// ---------------- 启动 ----------------
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  if (isConfigured()) {
    setStatus('已就绪', 'online');
    addMessage('assistant', '你好，我是出行小助手智能体 🤖\n我可以帮你：关键字搜索、周边搜索、路径规划、天气查询、静态地图展示、IP定位。\n直接告诉我你的需求吧，例如"帮我找北京的咖啡店"。');
  } else {
    setStatus('请先填写密钥', 'error');
    addMessage('assistant', '欢迎使用出行小助手智能体 🤖\n首次使用请点击右上角「⚙️ 设置」，填写高德 Web 服务 Key 和 DeepSeek Key 即可开始。');
    openSettings();
  }
});
