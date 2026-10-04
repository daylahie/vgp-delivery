/*
 * Bản đồ vector tự vẽ bằng Canvas (không cần ảnh nền, chạy offline).
 * Lớp nền: ranh giới khu, đường, khối nhà, nhãn mã tòa.
 * Lớp lộ trình: tuyến theo thứ tự, mũi tên chiều đi, ghim đánh số, điểm xuất phát, vị trí GPS.
 * Cử chỉ: kéo 1 ngón, chụm 2 ngón, chạm đúp để phóng to, cuộn chuột trên máy tính.
 */
(function () {
  'use strict';

  // Giải mã polyline (độ chính xác 1e-5)
  function decode(str) {
    const out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lat / 1e5, lon / 1e5]);
    }
    return out;
  }

  // Phép chiếu phẳng cục bộ (mét)
  let LAT0 = 10.84, LON0 = 106.84, KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KY = 110540;
  function setOrigin(lat, lon) { LAT0 = lat; LON0 = lon; KX = Math.cos(lat * Math.PI / 180) * 111320; }
  const P = (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const PL = pts => pts.map(p => P(p[0], p[1]));

  let BASE = null;
  function prepareBase(map) {
    const [s, w, n, e] = map.bounds;
    setOrigin((s + n) / 2, (w + e) / 2);
    const blds = map.buildings.map(b => {
      const g = PL(decode(b.g));
      let cx = 0, cy = 0;
      g.forEach(p => { cx += p[0]; cy += p[1]; });
      return {id: b.id, g, c: [cx / g.length, cy / g.length]};
    });
    BASE = {
      bounds: [P(s, w), P(n, e)],
      boundary: PL(decode(map.boundary)),
      roads: map.roads.map(r => ({c: r.c, k: r.k, g: PL(decode(r.g))})),
      buildings: blds,
    };
    return BASE;
  }

  function css() {
    const st = getComputedStyle(document.documentElement), v = n => st.getPropertyValue(n).trim();
    return {
      bg: v('--map-bg'), road: v('--map-road'), edge: v('--map-road-edge'), major: v('--map-major'), walk: v('--map-walk'),
      bld: v('--map-bld'), bldEdge: v('--map-bld-edge'), lbl: v('--map-lbl'), bnd: v('--map-bnd'),
      route: v('--route'), done: v('--route-done'), depot: v('--depot'), card: v('--card'), fg: v('--fg'),
      pinText: v('--acc-fg'),
    };
  }

  class VgpMap {
    constructor(el, opts = {}) {
      this.el = el;
      this.interactive = opts.interactive !== false;   // bản đồ thu nhỏ: chỉ chạm để mở toàn màn hình
      this.onTap = opts.onTap || null;
      this.onUserMove = opts.onUserMove || null;   // người dùng tự kéo/chụm bản đồ
      this.cv = document.createElement('canvas');
      el.prepend(this.cv);
      this.ctx = this.cv.getContext('2d');
      this.cx = 0; this.cy = 0; this.s = 0.3;   // tâm (m) và tỉ lệ (px/m)
      this.route = null; this.gps = null; this.pointers = new Map(); this.lastTap = 0;
      this.colors = css();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(el);
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.colors = css(); this.draw(); });
      if (this.interactive) this.bindGestures();
      else this.cv.addEventListener('click', () => this.onTap && this.onTap());
      this.resize();
      this.fitBase();
    }

    resize() {
      const r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (!r.width || !r.height) return;
      this.w = r.width; this.h = r.height;
      this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.fitted) { this.fitted = true; this.fitTo(this.pendingFit || BASE.bounds); }
      this.draw();
    }

    toScreen(p) { return [this.w / 2 + (p[0] - this.cx) * this.s, this.h / 2 - (p[1] - this.cy) * this.s]; }
    toWorld(x, y) { return [this.cx + (x - this.w / 2) / this.s, this.cy - (y - this.h / 2) / this.s]; }

    fitTo(b, pad = 36) {
      if (!this.w) { this.pendingFit = b; return; }
      const [[x0, y0], [x1, y1]] = b;
      this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
      this.s = Math.min((this.w - pad * 2) / Math.max(x1 - x0, 40), (this.h - pad * 2) / Math.max(y1 - y0, 40));
      this.s = Math.max(0.05, Math.min(this.s, 4));
      this.draw();
    }
    fitBase() { this.fitTo(BASE.bounds, 10); }
    fitRoute() {
      if (!this.route) return this.fitBase();
      const pts = this.route.legs.flat().concat(this.route.stops.map(s => s.p));
      if (!pts.length) return this.fitBase();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
      this.fitTo([[x0, y0], [x1, y1]], 40);
    }
    centerOn(lat, lon, minScale) {
      const [x, y] = P(lat, lon);
      this.cx = x; this.cy = y;
      if (minScale) this.s = Math.max(this.s, minScale);
      this.draw();
    }

    /** route = {legs:[[[lat,lon],...]...], legState:['done'|'next'|'todo'], stops:[{lat,lon,label,kind}]} */
    setRoute(r) {
      this.route = r ? {
        legs: r.legs.map(PL), legState: r.legState || [],
        stops: r.stops.map(s => Object.assign({}, s, {p: P(s.lat, s.lon)})),
      } : null;
      this.draw();
    }
    setGps(g) { this.gps = g ? Object.assign({}, g, {p: P(g.lat, g.lon)}) : null; this.draw(); }

    draw() {
      if (this.raf || !this.w) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
    }

    path(pts, close) {
      const c = this.ctx;
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = this.toScreen(pts[i]);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      if (close) c.closePath();
    }

    render() {
      const c = this.ctx, C = this.colors, s = this.s;
      c.fillStyle = C.bg; c.fillRect(0, 0, this.w, this.h);
      c.lineJoin = 'round'; c.lineCap = 'round';
      // ranh giới
      this.path(BASE.boundary, true);
      c.strokeStyle = C.bnd; c.lineWidth = 2; c.setLineDash([8, 6]); c.stroke(); c.setLineDash([]);
      // khối nhà
      c.fillStyle = C.bld; c.strokeStyle = C.bldEdge; c.lineWidth = 1;
      for (const b of BASE.buildings) { this.path(b.g, true); c.fill(); if (s > 0.5) c.stroke(); }
      // đường: viền rồi lòng đường
      const wid = r => r.c === 'w' ? Math.max(1, 2 * s) : Math.max(r.k ? 2.5 : 1.5, (r.k ? 14 : 8) * s);
      for (const r of BASE.roads) {
        if (r.c === 'w') continue;
        this.path(r.g); c.strokeStyle = C.edge; c.lineWidth = wid(r) + 2; c.stroke();
      }
      for (const r of BASE.roads) {
        this.path(r.g);
        if (r.c === 'w') { c.strokeStyle = C.walk; c.lineWidth = wid(r); c.setLineDash([4, 4]); c.stroke(); c.setLineDash([]); }
        else { c.strokeStyle = r.k ? C.major : C.road; c.lineWidth = wid(r); c.stroke(); }
      }
      // nhãn mã tòa
      if (s > 0.45) {
        c.font = `600 ${s > 1.2 ? 13 : 11}px -apple-system,system-ui,sans-serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = C.lbl;
        // tòa đã có ghim trên tuyến thì không in nhãn nền nữa (tránh trùng chữ)
        const pinned = new Set(this.route ? this.route.stops.map(st => st.id).filter(Boolean) : []);
        for (const b of BASE.buildings) if (b.id && !pinned.has(b.id)) { const [x, y] = this.toScreen(b.c); c.fillText(b.id, x, y); }
      }
      // lộ trình
      if (this.route) this.renderRoute();
      // GPS
      if (this.gps) {
        const [x, y] = this.toScreen(this.gps.p), r = Math.max(8, (this.gps.acc || 0) * s);
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = '#0a84ff22'; c.fill();
        c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2); c.fillStyle = '#0a84ff'; c.fill();
        c.lineWidth = 3; c.strokeStyle = '#fff'; c.stroke();
      }
    }

    renderRoute() {
      const c = this.ctx, C = this.colors, R = this.route;
      // tuyến: đã đi (xám) → còn lại (xanh) → chặng kế tiếp (đậm)
      const order = ['done', 'todo', 'next'];
      for (const st of order) {
        R.legs.forEach((leg, i) => {
          const ls = R.legState[i] || 'todo';
          if (ls !== st || leg.length < 2) return;
          this.path(leg);
          c.strokeStyle = C.card; c.lineWidth = st === 'next' ? 10 : 8; c.globalAlpha = .9; c.stroke(); c.globalAlpha = 1;
          this.path(leg);
          c.strokeStyle = st === 'done' ? C.done : C.route; c.lineWidth = st === 'next' ? 7 : 5;
          if (st === 'todo' && R.legState.length) c.globalAlpha = .55;
          c.stroke(); c.globalAlpha = 1;
          if (st !== 'done') this.arrows(leg, st === 'next' ? 70 : 110);
        });
      }
      // ghim
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const stops = R.stops.slice().sort((a, b) => (a.kind === 'next') - (b.kind === 'next'));
      for (const st of stops) {
        const [x, y] = this.toScreen(st.p);
        if (st.kind === 'depot') {
          // điểm xuất phát: tròn đậm có hình ngôi nhà
          c.fillStyle = C.depot; c.strokeStyle = C.card; c.lineWidth = 3;
          c.beginPath(); c.arc(x, y, 15, 0, Math.PI * 2); c.fill(); c.stroke();
          c.fillStyle = C.card; c.beginPath();
          c.moveTo(x, y - 7); c.lineTo(x + 7, y - 1); c.lineTo(x + 5, y - 1); c.lineTo(x + 5, y + 6);
          c.lineTo(x - 5, y + 6); c.lineTo(x - 5, y - 1); c.lineTo(x - 7, y - 1); c.closePath(); c.fill();
          continue;
        }
        const big = st.kind === 'next', r = big ? 17 : 13;
        if (big) { c.beginPath(); c.arc(x, y, r + 8, 0, Math.PI * 2); c.globalAlpha = .25; c.fillStyle = C.route; c.fill(); c.globalAlpha = 1; }
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
        c.fillStyle = st.kind === 'done' ? C.done : C.route; c.fill();
        c.lineWidth = 3; c.strokeStyle = C.card; c.stroke();
        c.fillStyle = C.pinText; c.font = `800 ${big ? 15 : 12}px -apple-system,system-ui,sans-serif`;
        c.fillText(st.label, x, y + .5);
        if (this.s > 0.35 && st.id) {
          c.font = '700 12px -apple-system,system-ui,sans-serif'; c.lineWidth = 4; c.strokeStyle = C.card;
          c.strokeText(st.id, x, y - r - 9); c.fillStyle = C.fg; c.fillText(st.id, x, y - r - 9);
        }
      }
    }

    arrows(leg, every) {
      const c = this.ctx, pts = leg.map(p => this.toScreen(p));
      let acc = every / 2;
      c.fillStyle = this.colors.card;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], d = Math.hypot(x1 - x0, y1 - y0);
        let t = acc;
        while (t < d) {
          const x = x0 + (x1 - x0) * t / d, y = y0 + (y1 - y0) * t / d, a = Math.atan2(y1 - y0, x1 - x0);
          c.save(); c.translate(x, y); c.rotate(a);
          c.beginPath(); c.moveTo(4, 0); c.lineTo(-3, -3.5); c.lineTo(-1.5, 0); c.lineTo(-3, 3.5); c.closePath(); c.fill();
          c.restore();
          t += every;
        }
        acc = t - d;
      }
    }

    zoomAt(x, y, f) {
      const [wx, wy] = this.toWorld(x, y);
      this.s = Math.max(0.05, Math.min(this.s * f, 8));
      this.cx = wx - (x - this.w / 2) / this.s;
      this.cy = wy + (y - this.h / 2) / this.s;
      this.draw();
    }

    bindGestures() {
      const el = this.cv;
      const pos = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      el.addEventListener('pointerdown', e => {
        el.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, pos(e));
        this.moved = false;
        if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinch = {d: Math.hypot(a[0] - b[0], a[1] - b[1])}; }
      });
      el.addEventListener('pointermove', e => {
        if (!this.pointers.has(e.pointerId)) return;
        const prev = this.pointers.get(e.pointerId), cur = pos(e);
        this.pointers.set(e.pointerId, cur);
        if (this.pointers.size === 1) {
          if (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) > 0) { this.moved = true; this.onUserMove && this.onUserMove(); }
          this.cx -= (cur[0] - prev[0]) / this.s; this.cy += (cur[1] - prev[1]) / this.s; this.draw();
        } else if (this.pointers.size === 2 && this.pinch) {
          this.moved = true; this.onUserMove && this.onUserMove();
          const [a, b] = [...this.pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          // dịch theo trung điểm rồi phóng
          const pm = this.pinch.m;
          if (pm) { this.cx -= (mx - pm[0]) / this.s; this.cy += (my - pm[1]) / this.s; }
          this.zoomAt(mx, my, d / this.pinch.d);
          this.pinch = {d, m: [mx, my]};
        }
      });
      const up = e => {
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
        if (!this.moved && e.type === 'pointerup') {
          const now = Date.now(), p = pos(e);
          if (now - this.lastTap < 320) { this.zoomAt(p[0], p[1], 2); this.lastTap = 0; }
          else this.lastTap = now;
        }
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', e => { e.preventDefault(); this.onUserMove && this.onUserMove(); const p = pos(e); this.zoomAt(p[0], p[1], Math.exp(-e.deltaY / 300)); }, {passive: false});
    }
  }

  window.VgpMapLib = {VgpMap, prepareBase, decode};
})();
