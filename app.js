(function (global) {
  'use strict';

  var history = [];
  var busy = false;
  var traces = {};

  function $(id) { return document.getElementById(id); }

  function applyTheme() {
    var theme = Config.get('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    var use = document.querySelector('#themeBtn use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  }

  function setStatus(state, text) {
    var chip = $('statusChip');
    chip.className = 'status-chip' + (state ? ' ' + state : '');
    $('statusText').textContent = text;
  }

  function checkStatus() {
    setStatus('', '检测中');
    Amap.test().then(function (r) {
      setStatus(r.ok ? 'ok' : 'err', r.ok ? '地图已连接' : '地图异常');
    }).catch(function () {
      setStatus('err', '地图不可用');
    });
  }

  function autoResize() {
    var input = $('userInput');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }

  function sendMessage(text) {
    var value = String(text === undefined ? $('userInput').value : text).trim();
    if (!value || busy) return;

    if (!Config.get('deepseekKey') && !Config.get('siliconflowKey')) {
      UI.toast('请先在设置中配置大模型密钥', true);
      openSettings();
      return;
    }
    if (!Config.amapKeys().length) {
      UI.toast('请先在设置中配置高德地图密钥', true);
      openSettings();
      return;
    }

    busy = true;
    traces = {};
    $('userInput').value = '';
    autoResize();
    $('sendBtn').disabled = true;
    $('welcome').style.display = 'none';

    UI.addUserMessage(value);
    var stack = UI.addMessage('assistant');
    var thinking = UI.addThinking(stack, '正在理解你的出行需求…');

    Agent.run(value, history, function (ev) {
      switch (ev.type) {
        case 'engine-try':
          UI.setThinkingText(thinking, '正在连接 ' + ev.name + '…');
          break;
        case 'engine-fail':
          UI.setThinkingText(thinking, ev.name + ' 连接失败，正在切换备用引擎…');
          break;
        case 'engine-ok':
          UI.setThinkingText(thinking, '已连接 ' + ev.name + '，正在分析…');
          break;
        case 'tool-start':
          UI.setThinkingText(thinking, '正在执行：' + ev.label);
          traces[ev.id] = UI.addTrace(stack, ev);
          break;
        case 'tool-end':
          UI.setThinkingText(thinking, ev.result.ok ? '正在整理 ' + ev.label + ' 的结果…' : ev.label + ' 调用失败');
          UI.updateTrace(traces[ev.id], ev.result);
          UI.addCard(stack, ev.result);
          delete traces[ev.id];
          break;
      }
    }).then(function (res) {
      UI.removeNode(thinking);
      UI.addAssistantText(stack, res.text);
      history.push({ role: 'user', content: value });
      history.push({ role: 'assistant', content: res.text });
      if (history.length > 24) history = history.slice(-24);
    }).catch(function (err) {
      UI.removeNode(thinking);
      UI.addAssistantText(stack, '抱歉，这次请求没有成功：' + (err && err.message ? err.message : String(err)) +
        '\n\n请检查设置中的密钥是否正确，或稍后再试。');
    }).finally(function () {
      busy = false;
      $('sendBtn').disabled = false;
      UI.scrollBottom();
      $('userInput').focus();
    });
  }

  function fillSettings() {
    $('deepseekKey').value = Config.get('deepseekKey') || '';
    $('siliconflowKey').value = Config.get('siliconflowKey') || '';
    $('amapKey1').value = Config.get('amapKey1') || '';
    $('amapKey2').value = Config.get('amapKey2') || '';
    $('defaultCity').value = Config.get('defaultCity') || '';
    $('testResult').textContent = '';
    $('testResult').className = 'test-result';
  }

  function openSettings() {
    fillSettings();
    $('settingsModal').hidden = false;
  }

  function closeSettings() {
    $('settingsModal').hidden = true;
  }

  function saveSettings() {
    Config.update({
      deepseekKey: $('deepseekKey').value.trim(),
      siliconflowKey: $('siliconflowKey').value.trim(),
      amapKey1: $('amapKey1').value.trim(),
      amapKey2: $('amapKey2').value.trim(),
      defaultCity: $('defaultCity').value.trim() || Config.defaults.defaultCity
    });
    Config.save();
    closeSettings();
    checkStatus();
    UI.toast('设置已保存到本地浏览器');
  }

  function setTestResult(text, state) {
    var node = $('testResult');
    node.textContent = text;
    node.className = 'test-result' + (state ? ' ' + state : '');
  }

  function bindEvents() {
    $('sendBtn').addEventListener('click', function () { sendMessage(); });

    $('userInput').addEventListener('input', autoResize);
    $('userInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-query]'), function (node) {
      node.addEventListener('click', function () { sendMessage(node.getAttribute('data-query')); });
    });

    $('settingsBtn').addEventListener('click', openSettings);
    $('closeSettings').addEventListener('click', closeSettings);
    $('cancelSettings').addEventListener('click', closeSettings);
    $('saveSettings').addEventListener('click', saveSettings);
    $('settingsModal').addEventListener('click', function (e) {
      if (e.target === $('settingsModal')) closeSettings();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('settingsModal').hidden) closeSettings();
    });

    Array.prototype.forEach.call(document.querySelectorAll('.eye-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var input = $(btn.getAttribute('data-target'));
        var visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        btn.querySelector('use').setAttribute('href', visible ? '#i-eye' : '#i-eyeoff');
      });
    });

    $('themeBtn').addEventListener('click', function () {
      var next = Config.get('theme') === 'dark' ? 'light' : 'dark';
      Config.set('theme', next);
      Config.save();
      applyTheme();
    });

    $('resetBtn').addEventListener('click', function () {
      if (busy) return;
      history = [];
      traces = {};
      UI.clearMessages();
      $('welcome').style.display = '';
      UI.toast('已开启新对话');
    });

    $('testAmap').addEventListener('click', function () {
      setTestResult('正在测试…');
      Amap.test().then(function (r) {
        setTestResult(r.ok ? '高德接口正常' : '高德接口异常', r.ok ? 'ok' : 'err');
      }).catch(function (e) {
        setTestResult('失败：' + e.message, 'err');
      });
    });

    $('testLLM').addEventListener('click', function () {
      setTestResult('正在测试…');
      Agent.testLLM().then(function (r) {
        setTestResult(r.message, 'ok');
      }).catch(function (e) {
        setTestResult('失败：' + e.message, 'err');
      });
    });

    $('clearKeys').addEventListener('click', function () {
      if (!global.confirm('确定要清除本机保存的所有 API 密钥吗？')) return;
      Config.clearKeys();
      fillSettings();
      UI.toast('本地密钥已清除');
    });
  }

  function init() {
    UI.init();
    applyTheme();
    bindEvents();
    autoResize();
    checkStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
