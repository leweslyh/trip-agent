/* ============================================================
 * 交互式地图：Leaflet + 高德瓦片
 * - 瓦片与 restapi 坐标同为 GCJ-02，可直接对齐，无需转换
 * - Leaflet 走 CDN（jsdelivr → unpkg），失败自动降级为静态图
 * ============================================================ */
(function (global) {
  'use strict';

  const LEAF_JS = [
    'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  ];
  const LEAF_CSS = [
    'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  ];
  // 高德路网瓦片（含中文注记），无需 Key
  const TILE = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
  const DEFAULT_VIEW = [30.2741, 120.1551];

  const S = {
    loading: false,
    ready: false,
    failed: false,
    map: null,
    group: null,
    meLayer: null,
    me: null,
    last: null,
    probe: null,
    pickCb: null,
    onFallback: null,
    onReady: null,
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function addCss(href) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('leaflet load failed'));
      document.head.appendChild(s);
    });
  }

  async function load() {
    if (S.loading || S.ready || S.failed) return;
    S.loading = true;
    LEAF_CSS.forEach(addCss);
    for (const url of LEAF_JS) {
      try {
        await loadScript(url);
        S.ready = true;
        S.loading = false;
        initMap();
        if (S.last) render(S.last);
        if (S.me) drawMe();
        if (S.onReady) S.onReady();
        return;
      } catch (_) { /* 换下一个源 */ }
    }
    S.failed = true;
    S.loading = false;
    if (S.onFallback && S.last) S.onFallback(S.last);
  }

  /* ---------- 地图实例 ---------- */
  function initMap() {
    const el = document.getElementById('gmap');
    if (!el || !global.L || S.map) return S.map;
    const map = global.L.map(el, {
      zoomControl: false,
      attributionControl: false,
      minZoom: 3,
      maxZoom: 18,
      zoomSnap: 0.5,
      worldCopyJump: true,
    });
    S.map = map;
    global.L.tileLayer(TILE, { subdomains: '1234', minZoom: 3, maxZoom: 18 }).addTo(map);
    global.L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.setView(DEFAULT_VIEW, 12);
    S.group = global.L.layerGroup().addTo(map);
    S.meLayer = global.L.layerGroup().addTo(map);
    map.on('click', (e) => pickPoint(e.latlng.lng, e.latlng.lat));
    return map;
  }

  function pinIcon(label, kind) {
    const cls = kind && kind !== 'poi' ? ` ${kind}` : '';
    return global.L.divIcon({
      className: 'gpin-wrap',
      html: `<div class="gpin${cls}"><span>${esc(String(label == null ? '·' : label).slice(0, 2))}</span></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14],
    });
  }

  function popupBox(title, desc) {
    const box = document.createElement('div');
    box.className = 'gpop';
    box.innerHTML = `<b>${esc(title)}</b>` + (desc ? `<div class="gpop-addr">${esc(desc)}</div>` : '');
    return box;
  }

  /* ---------- 渲染业务数据 ---------- */
  function render(m) {
    const L = global.L;
    if (!S.ready || !L) return false;
    const map = S.map || initMap();
    if (!map) return false;

    S.group.clearLayers();
    clearProbe();
    const bounds = [];

    (m.markers || []).forEach((mk) => {
      if (mk == null || mk.lat == null) return;
      // 与我位置几乎重合的「我」标注交给 meLayer 统一绘制，避免重复叠点
      if (mk.kind === 'me' && S.me &&
        Math.abs(mk.lat - S.me.lat) < 3e-4 && Math.abs(mk.lng - S.me.lng) < 3e-4) return;
      const ll = [mk.lat, mk.lng];
      const marker = L.marker(ll, { icon: pinIcon(mk.label, mk.kind), riseOnHover: true });
      if (mk.title || mk.desc) marker.bindPopup(popupBox(mk.title || mk.label, mk.desc), { closeButton: false, maxWidth: 220 });
      marker.addTo(S.group);
      bounds.push(ll);
    });

    const path = (m.path || []).filter((p) => p && p.length === 2);
    if (path.length > 2) {
      const pts = path.map((p) => [p[1], p[0]]);
      L.polyline(pts, { color: '#ffffff', weight: 10, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(S.group);
      L.polyline(pts, { color: '#2563eb', weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(S.group);
      pts.forEach((p) => bounds.push(p));
    }

    if (bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [26, 26], maxZoom: 16 });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], m.zoom || 15);
    } else if (m.center) {
      map.setView([m.center.lat, m.center.lng], m.zoom || 13);
    }

    setTimeout(() => map.invalidateSize(), 80);
    return true;
  }

  /* ---------- 我的位置 ---------- */
  function drawMe() {
    const L = global.L;
    if (!S.ready || !L || !S.me) return;
    const map = S.map || initMap();
    if (!map) return;
    S.meLayer.clearLayers();
    const ll = [S.me.lat, S.me.lng];
    if (S.me.accuracy) {
      L.circle(ll, {
        radius: S.me.accuracy, color: '#2563eb', weight: 1,
        fillColor: '#2563eb', fillOpacity: 0.08,
      }).addTo(S.meLayer);
    }
    L.marker(ll, { icon: pinIcon('我', 'me'), zIndexOffset: 500 })
      .bindPopup(popupBox('我的位置', S.me.address || S.me.city || ''), { closeButton: false, maxWidth: 220 })
      .addTo(S.meLayer);
  }

  /* ---------- 点击地图取点 ---------- */
  function pickPoint(lng, lat) {
    const L = global.L;
    const map = S.map;
    if (!L || !map) return;
    const p = { lng: +lng.toFixed(6), lat: +lat.toFixed(6) };
    if (!S.probe) {
      S.probe = L.marker([p.lat, p.lng], { icon: pinIcon('选', 'probe'), zIndexOffset: 400 }).addTo(map);
    } else {
      S.probe.setLatLng([p.lat, p.lng]);
    }
    const box = document.createElement('div');
    box.className = 'gpop';
    box.innerHTML = `<b>${p.lng}, ${p.lat}</b><div class="gpop-addr">正在解析地址…</div>` +
      '<button class="gpop-act" type="button">搜这附近</button>';
    const addrEl = box.querySelector('.gpop-addr');
    box.querySelector('.gpop-act').addEventListener('click', () => {
      if (S.pickCb) S.pickCb(p, addrEl.textContent.replace('正在解析地址…', '') || `${p.lng},${p.lat}`);
    });
    S.probe.bindPopup(box, { closeButton: false, maxWidth: 240, offset: [0, -12] }).openPopup();

    if (global.AMapAPI && global.AMapAPI.regeo) {
      global.AMapAPI.regeo(`${p.lng},${p.lat}`)
        .then((r) => { addrEl.textContent = r.address || `${p.lng},${p.lat}`; })
        .catch(() => { addrEl.textContent = `${p.lng},${p.lat}`; });
    }
  }

  function clearProbe() {
    if (S.probe && S.map) S.map.removeLayer(S.probe);
    S.probe = null;
  }

  /* ---------- 对外接口 ---------- */
  const MapView = {
    get ready() { return S.ready; },
    get failed() { return S.failed; },

    /* 渲染一份地图数据；返回 false 表示已确定无法用交互地图 */
    show(m) {
      if (!m) return true;
      if (S.failed) { if (S.onFallback) S.onFallback(m); return false; }
      S.last = m;
      if (!S.ready) { load(); return true; }
      return render(m);
    },

    setMe(me) {
      if (!me || me.lng == null || me.lat == null) return;
      S.me = { lng: +me.lng, lat: +me.lat, accuracy: me.accuracy, address: me.address, city: me.city };
      drawMe();
    },

    focusMe() {
      if (!S.ready || !S.me) return false;
      (S.map || initMap()).setView([S.me.lat, S.me.lng], 15);
      return true;
    },

    invalidate() {
      if (S.map) setTimeout(() => S.map.invalidateSize(), 120);
    },

    reset() {
      if (S.group) S.group.clearLayers();
      clearProbe();
      S.last = null;
      if (S.map) S.map.setView(DEFAULT_VIEW, 12);
    },

    onPick(cb) { S.pickCb = cb; },
    onFallback(cb) { S.onFallback = cb; },
    onReady(cb) { S.onReady = cb; },
  };

  global.MapView = MapView;
})(window);
