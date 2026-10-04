/* Giao VGP – giao diện. Dữ liệu: data/data.json (sinh bởi pipeline/04_build_matrix.py) */
(function () {
  'use strict';
  const APP_VERSION = '1.1.1';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  const {VgpMap, prepareBase, decode} = window.VgpMapLib;
  const HOME_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z"/></svg>';

  // ---------- Lưu trên máy ----------
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
    route: LS.get('route', null),   // {mode, sel, order, cost, exact, ms}
    trip: LS.get('trip', null),     // {mode, order, done, started, plan}
    history: LS.get('history', []),
    open: new Set(),
  };

  // ---------- Định dạng ----------
  const fmtDist = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  function fmtMin(min) {
    min = Math.max(1, Math.round(min));
    if (min < 60) return `${min} phút`;
    const m = min % 60;
    return `${Math.floor(min / 60)} giờ${m ? ' ' + m + ' phút' : ''}`;
  }
  const travelMin = (m, mode) => m / 1000 / S.settings.speed[mode] * 60;
  const B = id => D.buildings[IDX[id]];
  const dist = (mode, a, b) => D.modes[mode].dist[IDX[a]][IDX[b]];

  function toast(msg, ms = 2400) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
  }
  function sheet(html, mount) { $('sheet').innerHTML = html; $('modal').classList.add('on'); if (mount) mount($('sheet')); }
  const closeSheet = () => $('modal').classList.remove('on');
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeSheet(); });
  function ask(title, msg, okText, onOk) {
    sheet(`<h3>${esc(title)}</h3><p class="mut">${esc(msg)}</p>
      <button class="btn" id="mOk">${esc(okText)}</button><button class="btn ghost" id="mNo">Thôi</button>`, el => {
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
    const out = r => ({order: r.order.map(i => D.buildings[i].id), cost: r.cost, exact: r.exact, ms: r.ms});
    if (!worker) {
      const t0 = Date.now(), r = window.VGPSolver.solve(dm, s, t, st);
      return Promise.resolve(out(Object.assign(r, {ms: Date.now() - t0})));
    }
    return new Promise((res, rej) => {
      const id = ++reqId;
      pending.set(id, {res: r => res(out(r)), rej});
      worker.postMessage({id, dist: dm, start: s, end: t, stops: st});
    });
  }

  // ---------- Điều hướng ----------
  function show(sid) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === sid));
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.s === sid));
    document.querySelector('main').scrollTop = 0;
    if (sid === 's-go') renderGo();
    if (sid === 's-set') renderSettings();
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.s));

  // ---------- Bản đồ ----------
  const mini = {};
  let full = null, fullData = null;

  // ---------- Vị trí trực tiếp (GPS) ----------
  // Tự bật khi bắt đầu giao; chấm xanh hiện trên mọi bản đồ. Nút định vị ở bản đồ toàn màn hình để đưa về chỗ mình.
  let gpsWatch = null, gpsPos = null, gpsCenterNext = false;
  const allMaps = () => Object.values(mini).concat(full ? [full] : []);
  function startGps(center) {
    if (center) gpsCenterNext = true;
    if (gpsWatch !== null || !('geolocation' in navigator)) { if (center && gpsPos) centerOnMe(); return; }
    gpsWatch = navigator.geolocation.watchPosition(p => {
      gpsPos = {lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy};
      allMaps().forEach(m => m.setGps(gpsPos));
      if (gpsCenterNext) centerOnMe();
      $('fullLocate').classList.add('on');
    }, err => {
      gpsWatch = null; $('fullLocate').classList.remove('on');
      if (err.code === 1) toast('Chưa cho phép định vị. Vào Cài đặt iPhone → Safari → Vị trí để bật.', 4000);
    }, {enableHighAccuracy: true, maximumAge: 3000});
  }
  function stopGps() {
    if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null; gpsPos = null; $('fullLocate').classList.remove('on');
    allMaps().forEach(m => m.setGps(null));
  }
  function centerOnMe() {
    gpsCenterNext = false;
    if (full && $('full').classList.contains('on')) full.centerOn(gpsPos.lat, gpsPos.lon, 1.2);
  }
  $('fullLocate').onclick = () => startGps(true);
  function routeData(mode, seq, nextId, doneSet) {
    const P = D.modes[mode].path, legs = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const enc = P[IDX[seq[i]]][IDX[seq[i + 1]]];
      legs.push(enc ? decode(enc) : [[B(seq[i]).lat, B(seq[i]).lon], [B(seq[i + 1]).lat, B(seq[i + 1]).lon]]);
    }
    const nextIdx = nextId === undefined ? -1 : (nextId ? seq.indexOf(nextId, 1) : seq.length - 1);
    return {
      legs,
      legState: nextIdx < 0 ? [] : legs.map((_, i) => i + 1 < nextIdx ? 'done' : i + 1 === nextIdx ? 'next' : 'todo'),
      stops: seq.slice(0, -1).map((id, i) => ({lat: B(id).lat, lon: B(id).lon, id: i ? id : '', label: String(i),
        kind: i === 0 ? 'depot' : doneSet && doneSet.has(id) ? 'done' : id === nextId ? 'next' : 'stop'})),
    };
  }
  function showMini(key, elId, data) {
    if (!mini[key]) {
      const el = $(elId);
      mini[key] = new VgpMap(el, {interactive: false, onTap: () => openFull(fullData)});
      el.insertAdjacentHTML('beforeend', '<div class="hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg></div>');
    }
    fullData = data;
    const m = mini[key];
    m.setRoute(data);
    m.setGps(gpsPos);
    requestAnimationFrame(() => { m.resize(); m.fitRoute(); });
  }
  function openFull(data) {
    if (!data) return;
    $('full').classList.add('on');
    if (!full) full = new VgpMap($('full'), {interactive: true});
    full.setRoute(data);
    full.setGps(gpsPos);
    requestAnimationFrame(() => { full.resize(); full.fitRoute(); });
    history.pushState({full: 1}, '');
  }
  function closeFull() { $('full').classList.remove('on'); }
  $('fullClose').onclick = () => { closeFull(); if (history.state && history.state.full) history.back(); };
  window.addEventListener('popstate', closeFull);

  // ---------- Chọn tòa ----------
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
  const matchQ = q => b => !q || norm(b.id).includes(q) || norm(b.name).includes(q) || b.aliases.some(a => norm(a).includes(q));
  function renderPick() {
    const q = norm($('q').value);
    let html = '';
    for (const [zone, list] of zonesOf()) {
      const items = list.filter(matchQ(q));
      if (!items.length) continue;
      const nSel = list.filter(b => S.sel.has(b.id)).length;
      const allOn = items.every(b => S.sel.has(b.id));
      const open = q || S.open.has(zone);
      html += `<div class="zone${open ? '' : ' closed'}" data-z="${esc(zone)}">
        <div class="zone-h"><span class="car"></span>${esc(zone)}<span class="cnt${nSel ? ' has' : ''}">${nSel ? nSel + ' / ' : ''}${list.length}</span></div>
        <div class="items">` +
        items.map(b => `<div class="item${S.sel.has(b.id) ? ' on' : ''}" data-id="${esc(b.id)}"><span class="ck"></span>
          <div><div class="id">${esc(b.id)}</div>${b.name && b.name !== 'Tòa ' + b.id ? `<div class="nm">${esc(b.name)}</div>` : ''}</div></div>`).join('') +
        `<button class="all">${allOn ? 'Bỏ chọn cả khu' : 'Chọn cả khu'}</button></div></div>`;
    }
    $('zones').innerHTML = html || '<div class="empty"><b>Không tìm thấy</b>Thử gõ mã khác, vd. S3.03</div>';
    const n = S.sel.size;
    $('selInfo').textContent = n ? `Đã chọn ${n} tòa` : 'Chưa chọn tòa nào';
    $('bClear').style.visibility = n ? 'visible' : 'hidden';
    $('bSolve').disabled = !n;
    $('bSolve').textContent = n ? `Tính lộ trình · ${n} tòa` : 'Tính lộ trình';
    renderPresets();
  }
  $('zones').addEventListener('click', e => {
    const z = e.target.closest('.zone'); if (!z) return;
    const zone = z.dataset.z;
    if (e.target.closest('.all')) {
      const list = zonesOf().find(([n]) => n === zone)[1].filter(matchQ(norm($('q').value)));
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
    const chips = S.presets.map((p, i) => `<button class="chip" data-p="${i}">${esc(p.name)}</button>`);
    if (S.sel.size) chips.push('<button class="chip" id="pAdd" style="color:var(--acc)">+ Lưu nhóm này</button>');
    $('presets').innerHTML = chips.join('');
    $('presets').style.display = chips.length ? 'flex' : 'none';
  }
  $('presets').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    if (c.dataset.p != null) {
      const p = S.presets[+c.dataset.p];
      S.sel = new Set(p.ids.filter(id => id in IDX && IDX[id] !== DEPOT));
      LS.set('sel', [...S.sel]); renderPick(); toast(`Đã chọn nhóm “${p.name}”`);
    } else if (c.id === 'pAdd') {
      sheet(`<h3>Lưu nhóm ${S.sel.size} tòa</h3><p class="mut">Lần sau chỉ cần chạm một lần để chọn lại.</p>
        <input type="text" id="pName" placeholder="Tên nhóm, vd. Ca sáng" maxlength="30" style="margin-bottom:14px">
        <button class="btn" id="mOk">Lưu</button><button class="btn ghost" id="mNo">Thôi</button>`, el => {
        const inp = el.querySelector('#pName');
        el.querySelector('#mNo').onclick = closeSheet;
        el.querySelector('#mOk').onclick = () => {
          const name = inp.value.trim() || `Nhóm ${S.presets.length + 1}`;
          S.presets = S.presets.filter(p => p.name !== name).concat([{name, ids: [...S.sel].sort()}]);
          LS.set('presets', S.presets); closeSheet(); renderPresets(); toast('Đã lưu nhóm');
        };
      });
    }
  });

  async function computeRoute(mode, ids) {
    try {
      const r = await solve(mode, D.depot, D.depot, ids);
      S.route = {mode, sel: ids, order: r.order, cost: r.cost, exact: r.exact, ms: r.ms};
      LS.set('route', S.route);
    } catch (err) { toast('Không tính được: ' + err.message); }
  }
  $('bSolve').onclick = () => {
    const ids = [...S.sel].filter(id => id in IDX).sort();
    if (!ids.length) return;
    const go = async () => {
      if (S.trip) finishTrip();
      $('bSolve').disabled = true; $('bSolve').textContent = 'Đang tính…';
      await computeRoute(S.mode, ids);
      renderPick(); show('s-go');
    };
    if (S.trip && S.trip.done.length < S.trip.order.length) ask('Đang có chuyến giao dở', 'Tính lộ trình mới sẽ kết thúc chuyến hiện tại.', 'Tính lộ trình mới', go);
    else go();
  };

  // ---------- Giao hàng ----------
  function renderGo() {
    const hasTrip = !!S.trip, hasPlan = !hasTrip && !!S.route;
    $('goEmpty').style.display = hasTrip || hasPlan ? 'none' : 'block';
    $('plan').style.display = hasPlan ? 'block' : 'none';
    $('trip').style.display = hasTrip ? 'block' : 'none';
    $('tripDot').classList.toggle('on', hasTrip);
    if (hasTrip) $('tripDot').textContent = S.trip.order.length - S.trip.done.length || '✓';
    if (hasPlan) renderPlan();
    if (hasTrip) renderTrip();
  }

  function stopRow(id, i, last, leg, cls) {
    const b = B(id);
    const num = (i === 0 || last) ? `<span class="num home">${HOME_ICON}</span>` : `<span class="num${cls === 'done' ? ' done' : ''}">${i}</span>`;
    const sub = i === 0 ? 'Xuất phát' : last ? 'Quay về' : esc(b.zone);
    return `<div class="stop ${cls || ''}">${num}<div><div class="id">${esc(id)}</div><div class="z">${sub}</div></div>
      ${leg != null ? `<span class="leg">${fmtDist(leg)}</span>` : ''}</div>`;
  }

  function renderPlan() {
    const R = S.route;
    if (R.order.some(id => !(id in IDX))) { S.route = null; LS.del('route'); return renderGo(); }
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === R.mode));
    const n = R.order.length, seq = [D.depot, ...R.order, D.depot];
    $('pDist').textContent = fmtDist(R.cost);
    $('pMeta').textContent = `· khoảng ${fmtMin(travelMin(R.cost, R.mode) + n * S.settings.stopMin)} · ${n} tòa`;
    $('planList').innerHTML = seq.map((id, i) => stopRow(id, i, i === seq.length - 1, i ? dist(R.mode, seq[i - 1], id) : null)).join('');
    showMini('plan', 'mapPlan', routeData(R.mode, seq));
  }
  $('modeSeg').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !S.route || b.dataset.m === S.route.mode) return;
    S.mode = b.dataset.m; LS.set('mode', S.mode);
    document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
    await computeRoute(S.mode, S.route.sel);
    renderPlan();
  });
  $('bStart').onclick = () => {
    S.trip = {mode: S.route.mode, order: S.route.order.slice(), done: [], started: Date.now(), plan: S.route.cost};
    LS.set('trip', S.trip); renderGo(); document.querySelector('main').scrollTop = 0;
    startGps(false);
  };

  function tripState() {
    const T = S.trip, done = new Set(T.done), left = T.order.filter(id => !done.has(id));
    return {T, done, left, next: left[0] || null, cur: T.done.length ? T.done[T.done.length - 1] : D.depot};
  }
  function remaining(st) {
    let d = 0, p = st.cur;
    for (const id of st.left) { d += dist(st.T.mode, p, id); p = id; }
    return d + dist(st.T.mode, p, D.depot);
  }
  function renderTrip() {
    const st = tripState(), T = st.T, n = T.order.length, k = T.done.length;
    $('tProg').textContent = `${k}/${n}`;
    $('tBar').style.width = (n ? k / n * 100 : 0) + '%';
    if (st.next) {
      const b = B(st.next);
      $('tNext').innerHTML = `<div class="lbl">Tòa tiếp theo</div><div class="big">${esc(st.next)}</div>
        <div class="sub">${esc(b.zone)} · ${fmtDist(dist(T.mode, st.cur, st.next))}</div>
        ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}`;
      $('bDone').textContent = 'Đã giao xong';
    } else {
      $('tNext').innerHTML = `<div class="lbl">Đã giao hết ${n} tòa</div><div class="big">Về ${esc(D.depot)}</div>
        <div class="sub">${fmtDist(dist(T.mode, st.cur, D.depot))}</div>`;
      $('bDone').textContent = 'Kết thúc chuyến';
    }
    $('bUndo').style.display = k ? '' : 'none';
    $('bReplan').style.display = st.left.length > 1 ? '' : 'none';
    const seq = [D.depot, ...T.order, D.depot];
    $('tripList').innerHTML = seq.map((id, i) => {
      const last = i === seq.length - 1, isDone = i > 0 && !last && st.done.has(id);
      const cls = isDone ? 'done' : (id === st.next && i > 0 && !last) || (!st.next && last) ? 'cur' : '';
      return stopRow(id, i, last, i ? dist(T.mode, seq[i - 1], id) : null, cls);
    }).join('');
    showMini('trip', 'mapTrip', routeData(T.mode, seq, st.next, st.done));
  }
  $('bDone').onclick = () => {
    const st = tripState();
    if (!st.next) return endTrip();
    S.trip.done.push(st.next); LS.set('trip', S.trip);
    if (navigator.vibrate) navigator.vibrate(30);
    renderGo();
  };
  $('bUndo').onclick = () => {
    if (!S.trip || !S.trip.done.length) return;
    const id = S.trip.done.pop(); LS.set('trip', S.trip); renderGo(); toast(`Đã trả lại ${id}`);
  };
  $('bReplan').onclick = () => {
    const st = tripState();
    sheet(`<h3>Tính lại đường</h3><p class="mut">Sắp xếp lại ${st.left.length} tòa còn lại cho ngắn nhất.</p>
      <button class="btn" id="rGps">Từ chỗ tôi đang đứng</button>
      <button class="btn ghost" id="rLast">Từ ${esc(st.cur)}</button>
      <button class="btn ghost" id="mNo">Thôi</button>`, el => {
      el.querySelector('#mNo').onclick = closeSheet;
      el.querySelector('#rLast').onclick = () => { closeSheet(); replanFrom(st.cur); };
      el.querySelector('#rGps').onclick = () => {
        closeSheet();
        if (!('geolocation' in navigator)) return toast('Máy không hỗ trợ định vị');
        toast('Đang tìm vị trí…');
        navigator.geolocation.getCurrentPosition(p => {
          const {latitude: la, longitude: lo} = p.coords, kx = Math.cos(la * Math.PI / 180);
          let best = D.depot, bd = Infinity;
          D.buildings.forEach(b => { const d = Math.hypot(b.lat - la, (b.lon - lo) * kx); if (d < bd) { bd = d; best = b.id; } });
          replanFrom(best);
        }, () => toast('Không lấy được vị trí. Hãy cho phép định vị trong Cài đặt iPhone.', 3500),
        {enableHighAccuracy: true, timeout: 10000, maximumAge: 10000});
      };
    });
  };
  async function replanFrom(startId) {
    const st = tripState(), before = remaining(st);
    const r = await solve(st.T.mode, startId, D.depot, st.left.filter(id => id !== startId));
    S.trip.order = [...S.trip.done, ...(st.left.includes(startId) ? [startId] : []), ...r.order];
    LS.set('trip', S.trip); renderGo();
    const after = remaining(tripState());
    toast(after < before - 5 ? `Đã sắp xếp lại · ngắn hơn ${fmtDist(before - after)}` : 'Đã sắp xếp lại đường đi');
  }
  function finishTrip() {
    const T = S.trip;
    S.history.unshift({at: Date.now(), mode: T.mode, n: T.order.length, done: T.done.length, plan: T.plan,
      mins: Math.round((Date.now() - T.started) / 60000)});
    S.history = S.history.slice(0, 20); LS.set('history', S.history);
    S.trip = null; LS.del('trip');
    stopGps();
  }
  function endTrip() {
    const left = S.trip.order.length - S.trip.done.length;
    const go = () => { finishTrip(); renderGo(); toast('Đã kết thúc chuyến'); };
    if (left) ask('Kết thúc chuyến?', `Còn ${left} tòa chưa giao.`, 'Kết thúc', go); else go();
  }
  $('bEnd').onclick = endTrip;

  // ---------- Cài đặt ----------
  function renderSettings() {
    $('spMoto').value = S.settings.speed.moto;
    $('spWalk').value = S.settings.speed.walk;
    $('stopMin').value = S.settings.stopMin;
    $('presetList').innerHTML = S.presets.length ? S.presets.map((p, i) => `<div class="stop"><div style="flex:1;min-width:0">
      <div class="id">${esc(p.name)}</div><div class="z" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.ids.join(', '))}</div></div>
      <button class="link" data-d="${i}" style="color:var(--bad)">Xoá</button></div>`).join('')
      : '<div class="mut small" style="padding:14px 0">Chưa có. Chọn tòa rồi bấm “Lưu nhóm này”.</div>';
    const nT = D.buildings.filter(b => b.type === 'thap_tang').length;
    $('dataInfo').textContent = `Dữ liệu ${D.version} · ${D.buildings.length} điểm${nT ? ` (${nT} dãy thấp tầng)` : ''} · App ${APP_VERSION}`;
    $('history').innerHTML = S.history.length ? S.history.slice(0, 8).map(h => `<div style="padding:4px 0">
      ${new Date(h.at).toLocaleDateString('vi-VN', {day: '2-digit', month: '2-digit'})} · ${h.mode === 'moto' ? 'Xe máy' : 'Đi bộ'} ·
      ${h.done}/${h.n} tòa · ${fmtDist(h.plan || 0)} · ${fmtMin(h.mins)}</div>`).join('') : 'Chưa có.';
  }
  $('presetList').addEventListener('click', e => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    const p = S.presets[+b.dataset.d];
    ask(`Xoá nhóm “${p.name}”?`, `${p.ids.length} tòa trong nhóm sẽ không bị ảnh hưởng.`, 'Xoá', () => {
      S.presets.splice(+b.dataset.d, 1); LS.set('presets', S.presets); renderSettings(); renderPresets();
    });
  });
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
    $('benchOut').textContent = 'Đang đo…';
    const all = D.buildings.map(b => b.id).filter(id => id !== D.depot), out = [];
    for (const m of ['moto', 'walk']) {
      const t0 = performance.now(); await solve(m, D.depot, D.depot, all);
      out.push(`${m === 'moto' ? 'Xe máy' : 'Đi bộ'}: ${all.length} tòa trong ${(Math.round(performance.now() - t0) / 1000).toFixed(1).replace('.', ',')} giây`);
    }
    $('benchOut').innerHTML = out.map(esc).join('<br>') + '<br><br>';
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
      if (!Array.isArray(o.presets)) throw new Error('file không đúng');
      const names = new Set(o.presets.map(p => p.name));
      S.presets = S.presets.filter(p => !names.has(p.name)).concat(o.presets.filter(p => p.name && Array.isArray(p.ids)));
      if (o.settings && o.settings.speed) S.settings = Object.assign({}, S.settings, o.settings);
      LS.set('presets', S.presets); LS.set('settings', S.settings);
      renderPresets(); renderSettings(); toast(`Đã khôi phục ${o.presets.length} nhóm`);
    }).catch(err => toast('Không khôi phục được: ' + err.message));
    e.target.value = '';
  };
  $('bReset').onclick = () => ask('Xoá dữ liệu trên máy?', 'Xoá nhóm đã lưu, chuyến đang giao, lịch sử và cài đặt.', 'Xoá hết', () => {
    ['mode', 'sel', 'presets', 'settings', 'route', 'trip', 'history'].forEach(LS.del); location.reload();
  });

  // ---------- Cập nhật dữ liệu ----------
  async function checkUpdate() {
    if (!navigator.onLine || !('caches' in window)) return;
    try {
      const resp = await fetch('data/data.json?check=' + Date.now(), {cache: 'no-store'});
      if (!resp.ok) return;
      const txt = await resp.text(), v = (txt.match(/"version":"([^"]+)"/) || [])[1];
      if (!v || v === D.version) return;
      const bar = $('update');
      bar.textContent = 'Có bản đồ mới · chạm để cập nhật';
      bar.classList.add('on');
      bar.onclick = async () => {
        const c = await caches.open('vgp-data');
        await c.put(new URL('data/data.json', location.href).href, new Response(txt, {headers: {'Content-Type': 'application/json'}}));
        location.reload();
      };
    } catch (e) { /* không có mạng */ }
  }

  // ---------- Khởi động ----------
  async function init() {
    try { D = await (await fetch('data/data.json')).json(); }
    catch (e) { $('zones').innerHTML = '<div class="empty"><b>Chưa tải được dữ liệu</b>Mở app khi có mạng một lần để cài đặt.</div>'; return; }
    D.buildings.forEach((b, i) => IDX[b.id] = i);
    DEPOT = IDX[D.depot];
    prepareBase(D.map);
    S.settings = Object.assign({speed: Object.assign({}, D.defaults.speed_kmh), stopMin: D.defaults.stop_min}, S.settings || {});
    [...S.sel].forEach(id => { if (!(id in IDX) || id === D.depot) S.sel.delete(id); });
    if (S.trip && S.trip.order.some(id => !(id in IDX))) { S.trip = null; LS.del('trip'); }
    renderPick();
    $('tripDot').classList.toggle('on', !!S.trip);
    if (S.trip) { $('tripDot').textContent = S.trip.order.length - S.trip.done.length || '✓'; show('s-go'); startGps(false); }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
    setTimeout(checkUpdate, 1500);
  }
  init();
})();
