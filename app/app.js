/* Giao VGP – logic giao diện. Dữ liệu: data/data.json (sinh bởi pipeline/04_build_matrix.py) */
(function () {
  'use strict';
  const APP_VERSION = '1.0.0';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  const {VgpMap, prepareBase, decode} = window.VgpMapLib;

  // ---------- Lưu trên máy (localStorage, có thể bị iOS xoá) ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('vgp.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('vgp.' + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem('vgp.' + k); } catch (e) {} },
  };

  let D = null, IDX = {}, DEPOT = 0;
  const S = {
    mode: LS.get('mode', 'moto'),
    sel: new Set(LS.get('sel', [])),
    presets: LS.get('presets', []),
    settings: LS.get('settings', null),
    route: LS.get('route', null),   // {mode, sel:[ids], order:[ids], cost, exact, ms}
    trip: LS.get('trip', null),     // {mode, order:[ids], done:[ids], started}
    history: LS.get('history', []),
    open: new Set(),
  };
  const maps = {};
  let gpsWatch = null, gpsPos = null, gpsFollow = false;

  // ---------- Định dạng ----------
  const fmtDist = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
  function fmtMin(min) {
    min = Math.round(min);
    if (min < 60) return `${min} phút`;
    return `${Math.floor(min / 60)} giờ ${String(min % 60).padStart(2, '0')}`;
  }
  const travelMin = (m, mode) => m / 1000 / S.settings.speed[mode] * 60;
  const B = id => D.buildings[IDX[id]];
  const dist = (mode, a, b) => D.modes[mode].dist[IDX[a]][IDX[b]];

  function toast(msg, ms = 2200) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
  }
  function sheet(html, mount) {
    $('sheet').innerHTML = html; $('modal').classList.add('on');
    if (mount) mount($('sheet'));
  }
  const closeSheet = () => $('modal').classList.remove('on');
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeSheet(); });
  function confirmSheet(title, msg, okText, onOk, danger) {
    sheet(`<h3>${esc(title)}</h3><p class="mut">${esc(msg)}</p>
      <div class="row" style="gap:8px"><button class="btn grow" id="mNo">Huỷ</button>
      <button class="btn grow ${danger ? '' : 'pri'}" id="mOk" style="${danger ? 'color:var(--bad)' : ''}">${esc(okText)}</button></div>`, el => {
      el.querySelector('#mNo').onclick = closeSheet;
      el.querySelector('#mOk').onclick = () => { closeSheet(); onOk(); };
    });
  }

  // ---------- Bộ giải trong Web Worker ----------
  let worker = null, reqId = 0;
  const pending = new Map();
  try {
    worker = new Worker('solver.worker.js');
    worker.onmessage = e => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); } };
    worker.onerror = () => { worker = null; };
  } catch (e) { worker = null; }
  function solve(mode, start, end, stops) {
    const dm = D.modes[mode].dist, s = IDX[start], t = IDX[end], st = stops.map(i => IDX[i]);
    const done = r => ({order: r.order.map(i => D.buildings[i].id), cost: r.cost, exact: r.exact, ms: r.ms});
    if (!worker) {
      const t0 = Date.now(), r = window.VGPSolver.solve(dm, s, t, st);
      return Promise.resolve(done(Object.assign(r, {ms: Date.now() - t0})));
    }
    return new Promise((res, rej) => {
      const id = ++reqId;
      pending.set(id, {res: r => res(done(r)), rej});
      worker.postMessage({id, dist: dm, start: s, end: t, stops: st});
    });
  }

  // ---------- Điều hướng ----------
  function show(sid) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === sid));
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.s === sid));
    $('app').querySelector('main').scrollTop = 0;
    if (sid === 's-route') renderRoute();
    if (sid === 's-trip') renderTrip();
    if (sid === 's-set') renderSettings();
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.s));

  // ---------- 1. Chọn tòa ----------
  function zonesOf() {
    const z = new Map();
    D.zones.forEach(n => z.set(n, []));
    D.buildings.forEach((b, i) => {
      if (i === DEPOT) return;
      const k = b.zone || 'Khác';
      if (!z.has(k)) z.set(k, []);
      z.get(k).push(b);
    });
    return [...z].filter(([, v]) => v.length);
  }
  function renderPick() {
    const q = norm($('q').value);
    const match = b => !q || norm(b.id).includes(q) || norm(b.name).includes(q) || b.aliases.some(a => norm(a).includes(q));
    let html = '';
    for (const [zone, list] of zonesOf()) {
      const items = list.filter(match);
      if (!items.length) continue;
      const nSel = list.filter(b => S.sel.has(b.id)).length;
      const allOn = items.every(b => S.sel.has(b.id));
      const open = q || S.open.has(zone);
      html += `<div class="zone${open ? '' : ' closed'}" data-z="${esc(zone)}">
        <div class="zone-h"><span class="car">▾</span><span>${esc(zone)}</span><span class="cnt">${nSel}/${list.length}</span>
        <button class="all">${allOn ? 'Bỏ cả khu' : 'Chọn cả khu'}</button></div><div class="items">` +
        items.map(b => `<div class="item${S.sel.has(b.id) ? ' on' : ''}" data-id="${esc(b.id)}"><span class="ck"></span>
          <div class="grow"><div class="id">${esc(b.id)}</div>${b.name && b.name !== 'Tòa ' + b.id ? `<div class="nm">${esc(b.name)}</div>` : ''}</div>
          ${b.type === 'thap_tang' ? '<span class="mut">thấp tầng</span>' : ''}</div>`).join('') + '</div></div>';
    }
    $('zones').innerHTML = html || '<div class="empty">Không tìm thấy tòa nào.</div>';
    $('selCount').textContent = S.sel.size;
    $('bSolve').disabled = !S.sel.size;
    $('bSolve').textContent = S.sel.size ? `Tính lộ trình (${S.sel.size} tòa)` : 'Tính lộ trình';
    renderPresets();
  }
  $('zones').addEventListener('click', e => {
    const z = e.target.closest('.zone'); if (!z) return;
    const zone = z.dataset.z;
    if (e.target.closest('.all')) {
      const q = norm($('q').value);
      const list = zonesOf().find(([n]) => n === zone)[1].filter(b => !q || norm(b.id + b.name + b.aliases.join('')).includes(q));
      const allOn = list.every(b => S.sel.has(b.id));
      list.forEach(b => allOn ? S.sel.delete(b.id) : S.sel.add(b.id));
    } else if (e.target.closest('.item')) {
      const id = e.target.closest('.item').dataset.id;
      S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
    } else if (e.target.closest('.zone-h')) {
      S.open.has(zone) ? S.open.delete(zone) : S.open.add(zone);
    } else return;
    LS.set('sel', [...S.sel]);
    renderPick();
  });
  $('q').addEventListener('input', renderPick);
  $('bClear').onclick = () => { S.sel.clear(); LS.set('sel', []); renderPick(); };

  function renderPresets() {
    $('presets').innerHTML = S.presets.map((p, i) => `<button class="chip" data-p="${i}">★ ${esc(p.name)} (${p.ids.length})</button>`).join('') +
      `<button class="chip" id="pAdd">＋ Lưu nhóm</button>` + (S.presets.length ? `<button class="chip" id="pEdit">Sửa</button>` : '');
  }
  $('presets').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    if (c.dataset.p != null) {
      const p = S.presets[+c.dataset.p];
      S.sel = new Set(p.ids.filter(id => id in IDX && IDX[id] !== DEPOT));
      LS.set('sel', [...S.sel]); renderPick(); toast(`Đã chọn nhóm “${p.name}”`);
    } else if (c.id === 'pAdd') {
      if (!S.sel.size) return toast('Hãy chọn tòa trước khi lưu nhóm');
      sheet(`<h3>Lưu nhóm ${S.sel.size} tòa</h3><input type="text" id="pName" placeholder="Tên nhóm, vd. Sáng thứ 2" maxlength="40">
        <div class="row" style="gap:8px;margin-top:12px"><button class="btn grow" id="mNo">Huỷ</button><button class="btn pri grow" id="mOk">Lưu</button></div>`, el => {
        const inp = el.querySelector('#pName'); setTimeout(() => inp.focus(), 50);
        el.querySelector('#mNo').onclick = closeSheet;
        el.querySelector('#mOk').onclick = () => {
          const name = inp.value.trim() || `Nhóm ${S.presets.length + 1}`;
          S.presets = S.presets.filter(p => p.name !== name).concat([{name, ids: [...S.sel].sort()}]);
          LS.set('presets', S.presets); closeSheet(); renderPresets(); toast('Đã lưu nhóm');
        };
      });
    } else if (c.id === 'pEdit') {
      sheet(`<h3>Nhóm đã lưu</h3>` + S.presets.map((p, i) => `<div class="stop"><div class="grow"><b>${esc(p.name)}</b>
        <div class="mut">${esc(p.ids.join(', '))}</div></div><button class="chip del" data-d="${i}">Xoá</button></div>`).join('') +
        `<button class="btn" id="mNo" style="width:100%;margin-top:10px">Xong</button>`, el => {
        el.querySelector('#mNo').onclick = closeSheet;
        el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
          S.presets.splice(+b.dataset.d, 1); LS.set('presets', S.presets); renderPresets(); closeSheet(); toast('Đã xoá nhóm');
        });
      });
    }
  });

  function setModeButtons() {
    document.querySelectorAll('.seg[id^=mode] button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  }
  $('modePick').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.mode = b.dataset.m; LS.set('mode', S.mode); setModeButtons();
  });

  async function computeRoute(mode, ids) {
    $('bSolve').disabled = true; $('bSolve').textContent = 'Đang tính…';
    try {
      const r = await solve(mode, D.depot, D.depot, ids);
      S.route = {mode, sel: ids, order: r.order, cost: r.cost, exact: r.exact, ms: r.ms};
      LS.set('route', S.route);
    } catch (err) {
      toast('Lỗi khi tính: ' + err.message);
    }
    renderPick();
  }
  $('bSolve').onclick = async () => {
    const ids = [...S.sel].filter(id => id in IDX).sort();
    if (!ids.length) return;
    await computeRoute(S.mode, ids);
    show('s-route');
  };

  // ---------- Tuyến trên bản đồ ----------
  function legsFor(mode, seq) {
    const P = D.modes[mode].path, out = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const enc = P[IDX[seq[i]]][IDX[seq[i + 1]]];
      out.push(enc ? decode(enc) : [[B(seq[i]).lat, B(seq[i]).lon], [B(seq[i + 1]).lat, B(seq[i + 1]).lon]]);
    }
    return out;
  }
  function getMap(key, elId) {
    if (!maps[key]) {
      maps[key] = new VgpMap($(elId));
      const box = $(elId), btns = document.createElement('div');
      btns.className = 'mapbtns';
      btns.innerHTML = `<button title="Xem toàn tuyến" data-a="fit">⤢</button><button title="Vị trí của tôi" data-a="gps">◎</button>`;
      box.appendChild(btns);
      btns.addEventListener('click', e => {
        const a = e.target.closest('button'); if (!a) return;
        if (a.dataset.a === 'fit') { gpsFollow = false; maps[key].fitRoute(); syncGpsButtons(); }
        else toggleGps();
      });
    }
    return maps[key];
  }
  function syncGpsButtons() {
    document.querySelectorAll('.mapbtns [data-a=gps]').forEach(b => b.classList.toggle('on', gpsWatch !== null));
  }
  function toggleGps() {
    if (!('geolocation' in navigator)) return toast('Máy không hỗ trợ định vị');
    if (gpsWatch !== null) {
      if (!gpsFollow && gpsPos) { gpsFollow = true; Object.values(maps).forEach(m => m.centerOn(gpsPos.lat, gpsPos.lon, 1)); return; }
      navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; gpsPos = null; gpsFollow = false;
      Object.values(maps).forEach(m => m.setGps(null)); syncGpsButtons(); return;
    }
    gpsFollow = true;
    gpsWatch = navigator.geolocation.watchPosition(p => {
      gpsPos = {lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy};
      Object.values(maps).forEach(m => { m.setGps(gpsPos); if (gpsFollow) m.centerOn(gpsPos.lat, gpsPos.lon, 1); });
      gpsFollow = false;
    }, err => { toast('Không lấy được vị trí: ' + (err.code === 1 ? 'chưa cho phép định vị' : 'tín hiệu yếu')); }, {enableHighAccuracy: true, maximumAge: 5000});
    syncGpsButtons();
  }

  // ---------- 2. Kết quả ----------
  function renderRoute() {
    const R = S.route;
    $('routeEmpty').style.display = R ? 'none' : 'block';
    $('routeBody').style.display = R ? 'block' : 'none';
    if (!R) return;
    if (R.order.some(id => !(id in IDX))) { S.route = null; LS.del('route'); return renderRoute(); }
    document.querySelectorAll('#modeRoute button').forEach(b => b.classList.toggle('on', b.dataset.m === R.mode));
    const n = R.order.length, seq = [D.depot, ...R.order, D.depot];
    $('rDist').textContent = fmtDist(R.cost);
    $('rTime').textContent = fmtMin(travelMin(R.cost, R.mode) + n * S.settings.stopMin);
    $('rStops').textContent = n;
    let html = `<div class="stop"><span class="num dep">XP</span><div class="grow"><b>${esc(D.depot)}</b> <span class="mut">xuất phát</span></div></div>`;
    for (let i = 1; i < seq.length; i++) {
      const id = seq[i], last = i === seq.length - 1, b = B(id);
      html += `<div class="stop"><span class="num${last ? ' dep' : ''}">${last ? 'XP' : i}</span>
        <div class="grow"><b class="id">${esc(id)}</b> ${last ? '<span class="mut">quay về</span>' : `<span class="mut">${esc(b.zone)}</span>`}</div>
        <span class="leg">+${fmtDist(dist(R.mode, seq[i - 1], id))}</span></div>`;
    }
    $('routeList').innerHTML = html;
    $('routeInfo').textContent = `${R.exact ? 'Lộ trình tối ưu tuyệt đối' : 'Lộ trình tối ưu gần đúng'} · tính trong ${R.ms} ms`;
    const m = getMap('route', 'mapRoute');
    m.setRoute({legs: legsFor(R.mode, seq), stops: seq.slice(0, -1).map((id, i) => ({
      lat: B(id).lat, lon: B(id).lon, id: i ? id : '', label: String(i), kind: i ? 'stop' : 'depot'}))});
    requestAnimationFrame(() => { m.resize(); m.fitRoute(); });
    $('bStart').textContent = S.trip ? 'Bắt đầu giao (thay chuyến đang dở)' : 'Bắt đầu giao';
  }
  $('modeRoute').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !S.route || b.dataset.m === S.route.mode) return;
    S.mode = b.dataset.m; LS.set('mode', S.mode); setModeButtons();
    await computeRoute(S.mode, S.route.sel);
    renderRoute();
  });
  $('bStart').onclick = () => {
    const go = () => {
      S.trip = {mode: S.route.mode, order: S.route.order.slice(), done: [], started: Date.now(), plan: S.route.cost};
      LS.set('trip', S.trip); show('s-trip');
    };
    if (S.trip && S.trip.done.length < S.trip.order.length) confirmSheet('Thay chuyến đang giao?', `Chuyến hiện tại còn ${S.trip.order.length - S.trip.done.length} điểm chưa giao.`, 'Thay', go, true);
    else go();
  };

  // ---------- 3. Đang giao ----------
  function tripState() {
    const T = S.trip, done = new Set(T.done);
    const left = T.order.filter(id => !done.has(id));
    const cur = T.done.length ? T.done[T.done.length - 1] : D.depot;
    return {T, done, left, next: left[0] || null, cur};
  }
  function remainingDist(st) {
    let d = 0, p = st.cur;
    for (const id of st.left) { d += dist(st.T.mode, p, id); p = id; }
    return d + dist(st.T.mode, p, D.depot);
  }
  function renderTrip() {
    $('tripBadge').innerHTML = S.trip ? `<span class="badge">${S.trip.order.length - S.trip.done.length}</span>` : '';
    $('tripEmpty').style.display = S.trip ? 'none' : 'block';
    $('tripBody').style.display = S.trip ? 'block' : 'none';
    if (!S.trip) return;
    const st = tripState(), T = st.T, n = T.order.length, k = T.done.length;
    $('tProg').textContent = `${k}/${n}`;
    $('tBar').style.width = (n ? k / n * 100 : 0) + '%';
    const rem = remainingDist(st);
    $('tLeft').textContent = `còn ${fmtDist(rem)} · ~${fmtMin(travelMin(rem, T.mode) + st.left.length * S.settings.stopMin)}`;
    if (st.next) {
      const b = B(st.next);
      $('tNext').innerHTML = `<div class="lbl">Điểm tiếp theo · ${k + 1}/${n}</div><div class="big">${esc(st.next)}</div>
        <div class="sub">${esc(b.zone)} · cách ${fmtDist(dist(T.mode, st.cur, st.next))} từ ${esc(st.cur)}</div>
        ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}`;
      $('bDone').textContent = '✓ Đã giao ' + st.next;
      $('bDone').className = 'btn ok big';
    } else {
      $('tNext').innerHTML = `<div class="lbl">Đã giao xong ${n} điểm</div><div class="big">Về ${esc(D.depot)}</div>
        <div class="sub">cách ${fmtDist(dist(T.mode, st.cur, D.depot))}</div>`;
      $('bDone').textContent = 'Kết thúc chuyến';
      $('bDone').className = 'btn pri big';
    }
    $('bUndo').disabled = !k;
    $('bReplan').disabled = !st.left.length;
    // danh sách
    const seq = [D.depot, ...T.order, D.depot];
    $('tripList').innerHTML = seq.map((id, i) => {
      const isDep = i === 0 || i === seq.length - 1, isDone = !isDep && st.done.has(id);
      return `<div class="stop${isDone ? ' done' : ''}"><span class="num${isDep ? ' dep' : isDone ? ' done' : ''}">${isDep ? 'XP' : i}</span>
        <div class="grow"><b class="id">${esc(id)}</b>${id === st.next ? ' <span class="mut">← tiếp theo</span>' : ''}</div>
        ${i ? `<span class="leg">+${fmtDist(dist(T.mode, seq[i - 1], id))}</span>` : ''}</div>`;
    }).join('');
    // bản đồ
    const m = getMap('trip', 'mapTrip'), legs = legsFor(T.mode, seq);
    const nextIdx = st.next ? seq.indexOf(st.next, 1) : seq.length - 1;
    m.setRoute({
      legs, legState: legs.map((_, i) => i + 1 < nextIdx ? 'done' : i + 1 === nextIdx ? 'next' : 'todo'),
      stops: seq.slice(0, -1).map((id, i) => ({lat: B(id).lat, lon: B(id).lon, id: i ? id : '', label: String(i),
        kind: i === 0 ? 'depot' : st.done.has(id) ? 'done' : id === st.next ? 'next' : 'stop'})),
    });
    requestAnimationFrame(() => {
      m.resize();
      if (!renderTrip.fitted) { m.fitRoute(); renderTrip.fitted = true; }
    });
  }
  $('bDone').onclick = () => {
    const st = tripState();
    if (!st.next) return endTrip();
    S.trip.done.push(st.next);
    LS.set('trip', S.trip);
    if (navigator.vibrate) navigator.vibrate(30);
    renderTrip();
    const nx = tripState().next;
    if (nx) { const b = B(nx); maps.trip && maps.trip.centerOn(b.lat, b.lon); }
  };
  $('bUndo').onclick = () => { if (S.trip && S.trip.done.length) { const id = S.trip.done.pop(); LS.set('trip', S.trip); renderTrip(); toast('Đã hoàn tác ' + id); } };
  $('bReplan').onclick = () => {
    const st = tripState();
    sheet(`<h3>Tính lại ${st.left.length} điểm còn lại</h3>
      <button class="btn big" id="rGps" style="margin-bottom:8px">📍 Từ vị trí hiện tại</button>
      <button class="btn big" id="rLast" style="margin-bottom:8px">Từ ${esc(st.cur)} (điểm vừa giao)</button>
      <button class="btn" id="mNo" style="width:100%">Huỷ</button>
      <p class="mut">“Từ vị trí hiện tại” lấy tòa gần bạn nhất làm điểm bắt đầu.</p>`, el => {
      el.querySelector('#mNo').onclick = closeSheet;
      el.querySelector('#rLast').onclick = () => { closeSheet(); replanFrom(st.cur); };
      el.querySelector('#rGps').onclick = () => {
        closeSheet();
        if (!('geolocation' in navigator)) return toast('Máy không hỗ trợ định vị');
        toast('Đang lấy vị trí…');
        navigator.geolocation.getCurrentPosition(p => {
          const {latitude: la, longitude: lo} = p.coords, kx = Math.cos(la * Math.PI / 180);
          let best = D.depot, bd = Infinity;
          D.buildings.forEach(b => { const d = Math.hypot((b.lat - la), (b.lon - lo) * kx); if (d < bd) { bd = d; best = b.id; } });
          replanFrom(best);
        }, () => toast('Không lấy được vị trí – thử “Từ điểm vừa giao”'), {enableHighAccuracy: true, timeout: 10000, maximumAge: 10000});
      };
    });
  };
  async function replanFrom(startId) {
    const st = tripState();
    const before = remainingDist(st);
    const r = await solve(st.T.mode, startId, D.depot, st.left.filter(id => id !== startId));
    const order = st.left.includes(startId) ? [startId, ...r.order] : r.order;
    S.trip.order = [...S.trip.done, ...order];
    LS.set('trip', S.trip);
    renderTrip.fitted = false; renderTrip();
    toast(`Đã tính lại từ ${startId}: còn ${fmtDist(remainingDist(tripState()))} (trước: ${fmtDist(before)})`, 3500);
  }
  function endTrip() {
    const T = S.trip, go = () => {
      S.history.unshift({at: Date.now(), mode: T.mode, n: T.order.length, done: T.done.length, plan: T.plan,
        mins: Math.round((Date.now() - T.started) / 60000)});
      S.history = S.history.slice(0, 20); LS.set('history', S.history);
      S.trip = null; LS.del('trip'); renderTrip.fitted = false; renderTrip(); toast('Đã kết thúc chuyến');
    };
    const left = T.order.length - T.done.length;
    if (left) confirmSheet('Kết thúc chuyến?', `Còn ${left} điểm chưa giao.`, 'Kết thúc', go, true); else go();
  }
  $('bEnd').onclick = endTrip;

  // ---------- 4. Cài đặt ----------
  function renderSettings() {
    $('spMoto').value = S.settings.speed.moto;
    $('spWalk').value = S.settings.speed.walk;
    $('stopMin').value = S.settings.stopMin;
    const nT = D.buildings.filter(b => b.type === 'thap_tang').length;
    $('dataInfo').textContent = `Phiên bản dữ liệu ${D.version} · ${D.buildings.length} điểm (${nT} dãy thấp tầng) · xuất phát ${D.depot}`;
    $('appVer').textContent = `Giao VGP ${APP_VERSION}`;
    $('history').innerHTML = S.history.length ? S.history.map(h => `<div class="stop"><div class="grow">${new Date(h.at).toLocaleString('vi-VN', {dateStyle: 'short', timeStyle: 'short'})}
      · ${h.mode === 'moto' ? 'Xe máy' : 'Đi bộ'}</div><span>${h.done}/${h.n} điểm · ${fmtDist(h.plan || 0)} · ${h.mins} phút</span></div>`).join('') : 'Chưa có chuyến nào.';
  }
  function bindNum(id, set) {
    $(id).addEventListener('change', e => {
      const v = parseFloat(String(e.target.value).replace(',', '.'));
      if (!isFinite(v) || v < 0) return renderSettings();
      set(v); LS.set('settings', S.settings); toast('Đã lưu');
    });
  }
  bindNum('spMoto', v => S.settings.speed.moto = Math.max(1, v));
  bindNum('spWalk', v => S.settings.speed.walk = Math.max(0.5, v));
  bindNum('stopMin', v => S.settings.stopMin = v);
  $('bBench').onclick = async () => {
    $('benchOut').textContent = 'Đang tính…';
    const all = D.buildings.map(b => b.id).filter(id => id !== D.depot), out = [];
    for (const m of ['moto', 'walk']) {
      const t0 = performance.now(), r = await solve(m, D.depot, D.depot, all);
      out.push(`${m === 'moto' ? 'Xe máy' : 'Đi bộ'}: ${all.length} điểm, ${fmtDist(r.cost)}, ${Math.round(performance.now() - t0)} ms`);
    }
    $('benchOut').innerHTML = out.map(esc).join('<br>');
  };
  $('bExport').onclick = async () => {
    const blob = new Blob([JSON.stringify({app: 'giao-vgp', presets: S.presets, settings: S.settings}, null, 2)], {type: 'application/json'});
    const name = `giao-vgp-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const f = new File([blob], name, {type: 'application/json'});
      if (navigator.canShare && navigator.canShare({files: [f]})) { await navigator.share({files: [f], title: 'Giao VGP'}); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('bImport').onclick = () => $('fImport').click();
  $('fImport').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t => {
      const o = JSON.parse(t);
      if (!Array.isArray(o.presets)) throw new Error('sai định dạng');
      const names = new Set(o.presets.map(p => p.name));
      S.presets = S.presets.filter(p => !names.has(p.name)).concat(o.presets.filter(p => p.name && Array.isArray(p.ids)));
      if (o.settings && o.settings.speed) S.settings = Object.assign({}, S.settings, o.settings);
      LS.set('presets', S.presets); LS.set('settings', S.settings);
      renderPresets(); renderSettings(); toast(`Đã nhập ${o.presets.length} nhóm`);
    }).catch(err => toast('Không nhập được: ' + err.message));
    e.target.value = '';
  };
  $('bReset').onclick = () => confirmSheet('Xoá dữ liệu lưu?', 'Xoá nhóm đã lưu, chuyến đang giao, lịch sử và cài đặt trên máy này.', 'Xoá', () => {
    ['mode', 'sel', 'presets', 'settings', 'route', 'trip', 'history'].forEach(LS.del); location.reload();
  }, true);

  // ---------- Cập nhật dữ liệu ----------
  async function checkUpdate() {
    if (!navigator.onLine || !('caches' in window)) return;
    try {
      const resp = await fetch('data/data.json?check=' + Date.now(), {cache: 'no-store'});
      if (!resp.ok) return;
      const txt = await resp.text(), v = (txt.match(/"version":"([^"]+)"/) || [])[1];
      if (!v || v === D.version) return;
      const bar = $('update');
      bar.textContent = `Có dữ liệu mới (${v}) – chạm để cập nhật`;
      bar.classList.add('on');
      bar.onclick = async () => {
        const c = await caches.open('vgp-data');
        await c.put(new URL('data/data.json', location.href).href, new Response(txt, {headers: {'Content-Type': 'application/json'}}));
        location.reload();
      };
    } catch (e) { /* không có mạng – bỏ qua */ }
  }

  // ---------- Khởi động ----------
  async function init() {
    try {
      const r = await fetch('data/data.json');
      D = await r.json();
    } catch (e) {
      $('zones').innerHTML = '<div class="empty">Không tải được dữ liệu (data/data.json).<br>Mở app khi có mạng một lần để cài đặt.</div>';
      return;
    }
    D.buildings.forEach((b, i) => IDX[b.id] = i);
    DEPOT = IDX[D.depot];
    prepareBase(D.map);
    S.settings = Object.assign({speed: Object.assign({}, D.defaults.speed_kmh), stopMin: D.defaults.stop_min}, S.settings || {});
    [...S.sel].forEach(id => { if (!(id in IDX) || id === D.depot) S.sel.delete(id); });
    if (S.trip && S.trip.order.some(id => !(id in IDX))) { S.trip = null; LS.del('trip'); toast('Chuyến cũ không khớp dữ liệu mới nên đã bỏ'); }
    $('depotName').textContent = D.depot;
    setModeButtons();
    renderPick();
    renderTrip();
    if (S.trip && S.trip.done.length < S.trip.order.length) show('s-trip');
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    setTimeout(checkUpdate, 1500);
  }
  init();
})();
