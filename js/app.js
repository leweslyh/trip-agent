/**
 * app.js —— 启动与交互绑定
 */
(function (global) {
  'use strict';

  var busy = false;

  /** 只有「Web 服务」Key：不加载交互地图，全部走 REST（IP 定位 / 天气 / 搜索 / 静态图） */
  function markWebMode() {
    var ph = document.getElementById('mapPlaceholder');
    if (!ph) return;
    ph.hidden = false;
    ph.classList.add('web');
    var ring = document.getElementById('phRing');
    if (ring) ring.style.display = 'none';
    var h = document.getElementById('phTitle');
    var p = document.getElementById('phDesc');
    var btn = document.getElementById('btnPlaceholderSettings');
    if (h) h.textContent = 'Web 服务 Key 模式';
    if (p) {
      p.innerHTML = 'IP 定位、天气、地理编码、POI 搜索、静态地图已可用（可点右下角「IP 定位」）<br />' +
        '若需要可拖拽缩放的交互地图，请补充「Web 端（JS API）」Key 与安全密钥';
    }
    if (btn) btn.textContent = '补充 JS API Key';
  }

  function amapInit() {
    var cfg = Store.get();
    if (!cfg.amapJsKey) {
      if (cfg.amapWebKey) markWebMode();
      return Promise.resolve(false);
    }
    return AMapKit.init(cfg).then(function () {
      UI.els.mapPlaceholder.hidden = true;
      UI.updatePills();
      // 静默做一次 IP 定位：校验 Key 是否可用，顺便定位到当前城市并打点
      AMapKit.locateIP().catch(function (err) {
        var msg = (err && err.message) || '';
        if (/SCODE/i.test(msg)) {
          UI.toast('高德提示：该 Key 需要「安全密钥 securityJsCode」，请在 API 设置中补填', 'err');
        } else if (/PLAT_NOMATCH/i.test(msg)) {
          UI.toast('该 Key 是「Web 服务」类型：地图需另建「Web 端(JS API)」Key', 'err');
        } else if (/USERKEY|INVALID/i.test(msg)) {
          UI.toast('高德 Key 校验失败：' + msg, 'err');
        } else {
          UI.toast(msg || 'IP 定位失败', 'err');
        }
      });
      return true;
    }).catch(function (err) {
      UI.updatePills();
      markWebMode();
      var msg = (err && err.message) || '地图初始化失败';
      UI.toast(msg + '（已切换为 Web 服务模式，IP 定位等仍可用）', 'err');
      console.error('[AMap]', err);
      AMapKit.locateIP().catch(function () { /* 静默：失败可手动重试 */ });
      return false;
    });
  }

  function sendMessage(raw) {
    var text = String(raw || '').trim();
    if (!text || busy) return;

    var cfg = Store.get();
    if (!cfg.deepseekKey) {
      UI.addErrorMessage('还没有配置 DeepSeek API Key。请点击右上角「API 设置」填入后重试。');
      UI.openSettings();
      return;
    }

    if (!cfg.amapJsKey && !cfg.amapWebKey) {
      UI.addUserMessage(text);
      UI.addErrorMessage('还没有配置高德 Key。请在右上角「API 设置」填写「Web 服务」Key（推荐）或「Web 端（JS API）」Key。');
      UI.openSettings();
      return;
    }

    busy = true;
    UI.setBusy(true);
    UI.addUserMessage(text);

    var pending = UI.addStatusChip('正在理解你的问题…');
    var pendingRemoved = false;
    function removePending() {
      if (!pendingRemoved && pending && pending.parentNode) {
        pendingRemoved = true;
        pending.remove();
      }
    }

    var run = AMapKit.isReady() ? Promise.resolve() : amapInit();

    run.then(function () {
      var answer = Agent.send(text, {
        onStatus: function (label) {
          var nameEl = pending && pending.querySelector('.t-name');
          if (nameEl) nameEl.textContent = label;
        },
        onToolStart: function (info) {
          removePending();
          UI.addTrace(info);
        },
        onToolEnd: function (info) {
          UI.updateTrace(info);
        }
      });
      return answer;
    }).then(function (answer) {
      removePending();
      return UI.addAgentMessage(answer, { typewriter: true });
    }).catch(function (err) {
      removePending();
      UI.addErrorMessage((err && err.message) || '出错了，请稍后重试');
      if (err && /API Key|401|未配置/.test(err.message || '')) UI.openSettings();
    }).then(function () {
      busy = false;
      UI.setBusy(false);
      UI.updatePills();
    });
  }

  function bindChat() {
    var input = UI.els.input;
    var composer = UI.els.composer;

    composer.addEventListener('submit', function (e) {
      e.preventDefault();
      sendMessage(input.value);
      input.value = '';
      input.style.height = 'auto';
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        composer.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    Array.prototype.forEach.call(document.querySelectorAll('.suggest'), function (btn) {
      btn.addEventListener('click', function () {
        var prompt = btn.getAttribute('data-prompt') || '';
        input.value = prompt;
        composer.dispatchEvent(new Event('submit', { cancelable: true }));
      });
    });

    UI.els.btnClear.addEventListener('click', function () {
      Agent.reset();
      UI.clearChat();
      UI.toast('会话已清空', 'ok');
    });
  }

  function bindSettings() {
    UI.els.btnSettings.addEventListener('click', UI.openSettings);
    var phBtn = document.getElementById('btnPlaceholderSettings');
    if (phBtn) phBtn.addEventListener('click', UI.openSettings);

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (el) {
      el.addEventListener('click', UI.closeSettings);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !UI.els.settingsModal.hidden) UI.closeSettings();
    });

    UI.els.btnSaveKeys.addEventListener('click', function () {
      var next = UI.collectSettings();
      if (!next.deepseekKey) {
        UI.toast('请先填写 DeepSeek API Key', 'err');
        UI.els.inDeepseekKey.focus();
        return;
      }
      var prevKey = Store.get().amapJsKey;
      Store.save(next);
      UI.closeSettings();
      UI.updatePills();
      UI.toast('配置已保存', 'ok');
      if (prevKey && prevKey !== next.amapJsKey && AMapKit.isReady()) {
        UI.toast('地图 Key 已修改，刷新页面后生效');
        return;
      }
      amapInit().then(function (ok) {
        if (ok) UI.toast('高德地图已加载，开始对话吧', 'ok');
      });
    });

    UI.els.btnResetKeys.addEventListener('click', function () {
      Store.reset();
      UI.collectSettings(); // 无需处理
      UI.els.inDeepseekKey.value = '';
      UI.els.inDeepseekBase.value = 'https://api.deepseek.com';
      UI.els.inDeepseekModel.value = 'deepseek-chat';
      UI.els.inAmapJsKey.value = '';
      UI.els.inAmapSecurity.value = '';
      UI.els.inAmapWebKey.value = '';
      UI.updatePills();
      UI.toast('已清空本地配置');
    });
  }

  function bindMapTools() {
    UI.els.rcClose.addEventListener('click', UI.closeRoute);
    UI.els.scClose.addEventListener('click', function () { UI.els.staticCard.hidden = true; });

    function locateByIp() {
      UI.toast('正在通过 IP 定位…');
      return AMapKit.locateIP({ force: true }).then(function (ip) {
        var text = ip.province && ip.province !== ip.city ? ip.province + ' ' + ip.city : ip.city;
        UI.toast('IP 定位：' + text, 'ok');
      }).catch(function (err) {
        UI.toast((err && err.message) || 'IP 定位失败', 'err');
      });
    }

    document.querySelectorAll('.map-toolbar button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-action');
        if (action === 'locate') {
          locateByIp();
          return;
        }
        if (action === 'static') {
          // 有交互地图 → 用当前视野；否则用 IP 定位结果生成静态图
          var task = AMapKit.isReady()
            ? Promise.resolve(null)
            : AMapKit.locateIP().then(function (ip) {
              return {
                lnglat: ip.center,
                zoom: 10,
                name: (ip.city || '当前位置') + '（IP 定位）'
              };
            });

          task.then(function (loc) {
            var lnglat, zoom, name;
            if (loc) {
              lnglat = loc.lnglat;
              zoom = loc.zoom;
              name = loc.name;
            } else {
              var center = AMapKit.getMap().getCenter();
              lnglat = [center.lng, center.lat];
              zoom = Math.min(Math.round(AMapKit.getMap().getZoom()), 17);
              name = '当前地图视野';
            }
            if (!lnglat) throw new Error('无法确定位置，请先做一次 IP 定位');
            var url = AMapKit.staticMapUrl({ lnglat: lnglat, zoom: zoom, size: '500*320' });
            UI.renderStatic(url, { name: name, lnglat: lnglat }, zoom);
            UI.toast('静态地图已生成', 'ok');
          }).catch(function (err) {
            UI.toast((err && err.message) || '静态地图生成失败', 'err');
          });
          return;
        }
        if (action === 'weather') {
          var city = AMapKit.getCity();
          var task = city ? Promise.resolve(city) : AMapKit.locateIP().then(function (r) { return r.city; });
          task.then(function (c) {
            return AMapKit.getWeather(c);
          }).then(function (w) {
            UI.renderWeather(w);
            UI.toast((w.live.city || '') + ' ' + w.live.weather + ' ' + w.live.temperature + '℃', 'ok');
          }).catch(function (err) { UI.toast(err.message, 'err'); });
          return;
        }
        if (action === 'clear') {
          AMapKit.clearOverlays();
          UI.closeRoute();
          UI.els.staticCard.hidden = true;
          UI.els.weatherCard.hidden = true;
          UI.toast('图层已清除');
        }
      });
    });
  }

  function boot() {
    UI.init();
    UI.updatePills();
    bindChat();
    bindSettings();
    bindMapTools();

    var cfg = Store.get();
    if (cfg.amapJsKey) {
      amapInit();
    } else if (cfg.amapWebKey) {
      AMapKit.state.webMode = true;
      markWebMode();
      UI.updatePills();
      // 自动做一次 IP 定位，用静态地图把当前位置显示出来
      AMapKit.locateIP().catch(function () { /* 静默失败，用户可手动重试 */ });
    }
    if (!cfg.deepseekKey) {
      setTimeout(function () {
        UI.openSettings();
        UI.toast('首次使用，请先配置 API Key');
      }, 600);
    }
    global.addEventListener('resize', function () { UI.scrollBottom(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
