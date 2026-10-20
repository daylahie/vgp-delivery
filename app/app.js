/* Giao VGP – giao diện. Dữ liệu: data/data.json (sinh bởi pipeline/04_build_matrix.py) */
(function () {
  'use strict';
  const APP_VERSION = '1.4.1';
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
  // Cổng ra vào hầm xe (dùng chung giữa các tòa). Tắt "tự chọn" thì chỉ dùng điểm xuất phát mặc định.
  const gateList = () => S.settings.autoGate && D.gates ? D.gates : [D.depot];
  const gateText = (a, b) => a === b ? `Ra và về ${a}` : `Ra ${a} · về ${b}`;
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
  function sheet(html, mount) { $('toast').classList.remove('on'); $('sheet').innerHTML = html; $('modal').classList.add('on'); if (mount) mount($('sheet')); }
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
    worker.onmessage = e => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.res(Object.assign(e.data.result, {ms: e.data.ms})) : p.rej(new Error(e.data.error));
    };
    worker.onerror = () => { worker = null; };
  } catch (e) { worker = null; }
  function runSolver(op, a) {
    if (!worker) {
      const t0 = Date.now(), S = window.VGPSolver;
      const r = op === 'gates' ? S.solveGates(a.dist, a.gates, a.stops) : S.solveRoute(a.dist, a.start, a.end, a.stops);
      return Promise.resolve(Object.assign(r, {ms: Date.now() - t0}));
    }
    return new Promise((res, rej) => {
      const id = ++reqId;
      pending.set(id, {res, rej});
      worker.postMessage(Object.assign({id, op}, a));
    });
  }
  const ixs = ids => ids.map(i => IDX[i]), idOf = i => D.buildings[i].id;
  // Một cặp cổng cố định. Điểm giao trùng cổng vẫn nằm trong thứ tự (giao ngay tại cổng).
  async function solve(mode, start, end, stops) {
    const r = await runSolver('route', {dist: D.modes[mode].dist, start: IDX[start], end: IDX[end], stops: ixs(stops)});
    return {order: r.order.map(idOf), cost: r.cost, exact: r.exact, ms: r.ms};
  }
  // Các tòa dùng chung hầm: thử mọi cặp (cổng đi, cổng về), chọn cặp tiện nhất.
  async function solveGates(mode, stops) {
    const r = await runSolver('gates', {dist: D.modes[mode].dist, gates: ixs(gateList()), stops: ixs(stops)});
    const out = a => ({start: idOf(a.start), end: idOf(a.end), cost: a.cost, exact: a.exact, order: a.order.map(idOf)});
    return {alts: r.alts.map(out), pick: out(r.pick), ms: r.ms};
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
  // GPS chỉ chạy khi đang giao hoặc khi bản đồ toàn màn hình đang bám theo; hết cần thì tắt ngay để đỡ tốn pin.
  // Chấm xanh hiện trên mọi bản đồ: có hướng khi đang di chuyển, xám khi mất tín hiệu.
  // Bản đồ toàn màn hình tự bám theo khi đang giao; kéo hoặc chụm bản đồ bằng tay thì thoát chế độ bám theo.
  // Khi đang giao: khoảng cách còn lại tính theo đường đi thật, phần đã đi của chặng tô xám,
  // lệch tuyến thì gợi ý tính lại, tới gần sảnh thì nút "Đã giao xong" sáng lên.
  const OFF_ROUTE_M = 40, NEAR_M = 25, STALE_MS = 15000;
  let gpsWatch = null, gpsPos = null, gpsAnchor = null, follow = false, staleTimer = null, wakeLock = null;
  let tripRd = null, live = null, nearKey = null;   // dữ liệu tuyến chuyến đang giao; tình trạng so với tuyến
  const offWatch = new VgpTrack.OffRoute(OFF_ROUTE_M, 10000);
  const allMaps = () => Object.values(mini).concat(full ? [full] : []);
  const fullOpen = () => $('full').classList.contains('on');
  const needGps = () => !!S.trip || (follow && fullOpen());
  const syncGps = () => needGps() ? startGps() : stopGps();

  function startGps() {
    if (gpsWatch !== null || !('geolocation' in navigator)) return;
    gpsWatch = navigator.geolocation.watchPosition(onFix, err => {
      // Mất tín hiệu tạm thời (giữa các tòa cao, trong hầm) thì cứ chờ, máy sẽ tự cập nhật lại.
      if (err.code !== 1) return;
      stopGps();
      toast('Chưa cho phép định vị. Vào Cài đặt của máy → trình duyệt → Vị trí để bật.', 4000);
    }, {enableHighAccuracy: true, maximumAge: 2000});
    staleTimer = setInterval(() => { if (gpsPos) allMaps().forEach(m => m.setGpsStale(Date.now() - gpsPos.t > STALE_MS)); }, 5000);
  }
  function stopGps() {
    if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
    clearInterval(staleTimer);
    gpsWatch = staleTimer = null; gpsPos = gpsAnchor = null; follow = false; live = null; offWatch.reset();
    $('fullLocate').classList.remove('follow');
    allMaps().forEach(m => m.setGps(null));
    refreshTripUi();
  }
  function onFix(p) {
    const c = p.coords, now = Date.now(), here = [c.latitude, c.longitude];
    // Bỏ qua lần định vị kém hẳn ngay sau một lần tốt hơn (GPS thỉnh thoảng nhảy khi ở giữa các tòa cao)
    if (gpsPos && c.accuracy > 60 && c.accuracy > gpsPos.acc && now - gpsPos.t < 10000) return;
    // Hướng: lấy của máy khi đang chạy; không có thì suy ra từ quãng đã đi; đứng yên quá 8 giây thì bỏ hướng
    let heading = gpsPos ? gpsPos.heading : null, moved = gpsPos ? gpsPos.moved : now;
    if (c.heading != null && !isNaN(c.heading) && c.speed != null && c.speed > 0.8) { heading = c.heading; moved = now; gpsAnchor = here; }
    else if (!gpsAnchor) gpsAnchor = here;
    else if (VgpTrack.distance(gpsAnchor, here) >= 6) { heading = VgpTrack.bearing(gpsAnchor, here); moved = now; gpsAnchor = here; }
    else if (now - moved > 8000) heading = null;
    const first = !gpsPos;
    gpsPos = {lat: c.latitude, lon: c.longitude, acc: c.accuracy, heading, moved, t: now};
    allMaps().forEach(m => m.setGps(gpsPos));
    if (follow && full && fullOpen()) full.centerOn(gpsPos.lat, gpsPos.lon, 1.2, !first);
    updateLive(first);
  }
  function setFollow(on) {
    follow = on;
    $('fullLocate').classList.toggle('follow', on);
    if (on) {
      if (gpsPos && full) full.centerOn(gpsPos.lat, gpsPos.lon, 1.2, true);
      else toast('Đang tìm vị trí…');
    }
    syncGps(); updateWake();
  }
  $('fullLocate').onclick = () => setFollow(!follow);

  // Giữ sáng màn hình khi xem bản đồ lúc đang giao (máy không hỗ trợ thì bỏ qua)
  async function updateWake() {
    const want = fullOpen() && !!S.trip;
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWake(); });

  // So vị trí với chặng đang đi
  function updateLive(first) {
    live = null;
    if (S.trip && gpsPos && tripRd) {
      const st = tripState(), k = tripRd.legState.indexOf('next'), here = [gpsPos.lat, gpsPos.lon];
      const target = B(st.next || S.trip.end), toTarget = VgpTrack.distance(here, [target.lat, target.lon]);
      const pr = k >= 0 && tripRd.legs[k].length > 1 ? VgpTrack.project(tripRd.legs[k], here) : null;
      const onRoute = !!pr && pr.dist <= OFF_ROUTE_M;
      live = {
        proj: onRoute ? pr : null,
        remain: onRoute ? Math.max(0, pr.total - pr.along) : toTarget,   // trên tuyến: theo đường thật; ngoài tuyến: đường chim bay
        toTarget, near: toTarget <= NEAR_M,
        off: offWatch.update(pr ? pr.dist : 0, gpsPos.t) && toTarget > 60,   // xa tuyến liên tục, và chưa tới nơi
      };
    } else offWatch.reset();
    refreshTripUi(first);
  }
  // Phần đã đi của chặng đang đi tô xám
  function progressData() {
    if (!tripRd || !live || !live.proj) return tripRd;
    const k = tripRd.legState.indexOf('next'), sp = VgpTrack.split(tripRd.legs[k], live.proj);
    const legs = tripRd.legs.slice(), state = tripRd.legState.slice();
    legs.splice(k, 1, sp.done, sp.rest); state.splice(k, 1, 'done', 'next');
    return Object.assign({}, tripRd, {legs, legState: state});
  }
  function refreshTripUi(first) {
    if (!S.trip || !tripRd) { renderNextPill(); return; }
    const st = tripState(), pd = progressData();
    if ($('tDist')) $('tDist').textContent = fmtDist(live ? live.remain : (st.next ? dist(S.trip.mode, st.cur, st.next) : dist(S.trip.mode, st.cur, S.trip.end)));
    $('bOff').style.display = live && live.off ? 'block' : 'none';
    const key = (st.next || 'end') + ':' + S.trip.done.length, near = !!(live && live.near);
    $('bDone').classList.toggle('near', near);
    if (near && nearKey !== key) { nearKey = key; if (navigator.vibrate) navigator.vibrate(60); }
    else if (!near && live && live.toTarget > NEAR_M * 2.5) nearKey = null;
    fullData = pd;
    if (mini.trip) { mini.trip.setRoute(pd); if (first) mini.trip.fitRoute(true); else mini.trip.keepGpsInView(); }
    if (full && fullOpen()) full.setRoute(pd);
    renderNextPill();
  }

  // Ô nhỏ "Tiếp theo" ở bản đồ toàn màn hình (chỉ khi đang giao)
  function renderNextPill() {
    const pill = $('fullNext'), id = fullData && fullData.nextId;
    if (!id || !fullOpen()) { pill.classList.remove('on'); return; }
    if (live && live.off) {
      pill.innerHTML = '<span class="lbl">Lệch tuyến</span><b>Tính lại</b>'; pill.dataset.off = '1';
    } else {
      pill.dataset.off = '';
      const d = live ? live.remain : fullData.nextLeg;
      pill.innerHTML = `<span class="lbl">Tiếp theo</span><b>${esc(id)}</b>${d != null ? `<span class="d">${fmtDist(d)}</span>` : ''}`;
    }
    pill.classList.add('on');
  }
  $('fullNext').onclick = () => {
    if ($('fullNext').dataset.off) return replanFromGps();
    const id = fullData && fullData.nextId; if (!id || !full) return;
    setFollow(false); full.centerOn(B(id).lat, B(id).lon, 1.2, true);
  };
  function routeData(mode, seq, nextId, doneSet) {
    const P = D.modes[mode].path, legs = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const enc = P[IDX[seq[i]]][IDX[seq[i + 1]]];
      legs.push(enc ? decode(enc) : [[B(seq[i]).lat, B(seq[i]).lon], [B(seq[i + 1]).lat, B(seq[i + 1]).lon]]);
    }
    const nextIdx = nextId === undefined ? -1 : (nextId ? seq.indexOf(nextId, 1) : seq.length - 1);
    const stops = seq.slice(0, -1).map((id, i) => ({lat: B(id).lat, lon: B(id).lon, id: i ? id : '', label: String(i),
      kind: i === 0 ? 'depot' : doneSet && doneSet.has(id) ? 'done' : id === nextId ? 'next' : 'stop'}));
    const end = seq[seq.length - 1];
    if (end !== seq[0]) stops.push({lat: B(end).lat, lon: B(end).lon, id: '', label: '', kind: 'depot'});   // cổng về khác cổng đi
    return {
      legs,
      legState: nextIdx < 0 ? [] : legs.map((_, i) => i + 1 < nextIdx ? 'done' : i + 1 === nextIdx ? 'next' : 'todo'),
      stops,
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
    if (!full) full = new VgpMap($('full'), {interactive: true, onUserMove: () => { if (follow) setFollow(false); }});
    full.setRoute(data);
    full.setGps(gpsPos);
    history.pushState({full: 1}, '');
    if (S.trip) setFollow(true);   // đang giao: tự bám theo vị trí của mình
    requestAnimationFrame(() => {
      full.resize();
      if (follow && gpsPos) full.centerOn(gpsPos.lat, gpsPos.lon, 1.2); else full.fitRoute();
    });
    updateWake();
    renderNextPill();
  }
  function closeFull() {
    $('full').classList.remove('on'); $('fullNext').classList.remove('on');
    follow = false; $('fullLocate').classList.remove('follow');
    syncGps(); updateWake();
  }
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
    $('selTray').innerHTML = [...S.sel].sort((a, b) => IDX[a] - IDX[b])
      .map(id => `<button class="chip" data-id="${esc(id)}" aria-label="Bỏ chọn ${esc(id)}">${esc(id)}<span class="x">×</span></button>`).join('');
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
  $('selTray').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    S.sel.delete(c.dataset.id); LS.set('sel', [...S.sel]); renderPick();
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
      const r = await solveGates(mode, ids), p = r.pick;
      S.route = {mode, sel: ids, start: p.start, end: p.end, order: p.order, cost: p.cost, exact: p.exact, ms: r.ms, alts: r.alts};
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

  // Vuốt trái một dòng để hiện nút "Bỏ" (chạm vào nút thì bỏ tòa đó)
  const SWIPE_W = 84;
  const swipeRow = (rowHtml, id) => `<div class="swipe"${id ? ` data-id="${esc(id)}"` : ''}>${id ? '<button class="swipe-act">Bỏ</button>' : ''}${rowHtml}</div>`;
  function bindSwipe(root, onRemove) {
    let g = null;
    const closeAll = except => root.querySelectorAll('.swipe.open').forEach(w => { if (w !== except) w.classList.remove('open'); });
    root.addEventListener('pointerdown', e => {
      const w = e.target.closest('.swipe[data-id]');
      if (!w || e.target.closest('.swipe-act')) return;
      closeAll(w);
      g = {w, row: w.querySelector('.stop'), x0: e.clientX, y0: e.clientY, base: w.classList.contains('open') ? -SWIPE_W : 0, drag: false, off: 0, pid: e.pointerId};
    });
    root.addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.pid) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.drag) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
        g.drag = true; g.row.style.transition = 'none'; g.row.setPointerCapture(e.pointerId);
      }
      g.off = Math.max(-SWIPE_W - 24, Math.min(0, g.base + dx));
      g.row.style.transform = `translateX(${g.off}px)`;
    });
    const end = e => {
      if (!g || e.pointerId !== g.pid) return;
      const {w, row, drag, off, base} = g; g = null;
      row.style.transition = ''; row.style.transform = '';
      if (drag) w.classList.toggle('open', off < -SWIPE_W / 2);
      else if (base) w.classList.remove('open');   // chạm vào dòng đang mở thì đóng lại
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('click', e => { const a = e.target.closest('.swipe-act'); if (a) onRemove(a.closest('.swipe').dataset.id); });
  }

  function renderPlan() {
    const R = S.route;
    if (![R.start, R.end, ...R.order].every(id => id in IDX)) { S.route = null; LS.del('route'); return renderGo(); }
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === R.mode));
    const n = R.order.length, seq = [R.start, ...R.order, R.end];
    $('gateRow').style.display = R.alts && R.alts.length > 1 ? 'flex' : 'none';
    $('gateTxt').textContent = gateText(R.start, R.end);
    $('pDist').textContent = fmtDist(R.cost);
    $('pMeta').textContent = `· khoảng ${fmtMin(travelMin(R.cost, R.mode) + n * S.settings.stopMin)} · ${n} tòa`;
    $('planList').innerHTML = seq.map((id, i) => {
      const last = i === seq.length - 1;
      return swipeRow(stopRow(id, i, last, i ? dist(R.mode, seq[i - 1], id) : null), i && !last ? id : null);
    }).join('');
    showMini('plan', 'mapPlan', routeData(R.mode, seq));
  }
  async function removeFromPlan(id) {
    const R = S.route; if (!R || editing) return;
    editing = true;
    S.sel.delete(id); LS.set('sel', [...S.sel]);
    const ids = R.sel.filter(x => x !== id);
    if (ids.length) await computeRoute(R.mode, ids); else { S.route = null; LS.del('route'); }
    editing = false;
    renderGo(); renderPick(); toast(`Đã bỏ ${id}`);
  }
  bindSwipe($('planList'), removeFromPlan);
  $('modeSeg').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !S.route || b.dataset.m === S.route.mode) return;
    S.mode = b.dataset.m; LS.set('mode', S.mode);
    document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
    await computeRoute(S.mode, S.route.sel);
    renderPlan();
  });
  $('bGate').onclick = () => {
    const R = S.route, alts = R.alts.slice().sort((a, b) => a.cost - b.cost);
    sheet(`<h3>Đổi cổng ra vào hầm</h3><p class="mut">Các tòa dùng chung hầm xe nên không tính đoạn đi giữa hai cổng.</p>` +
      alts.map((a, i) => `<button class="opt${a.start === R.start && a.end === R.end ? ' on' : ''}" data-i="${i}">
        <span>${esc(gateText(a.start, a.end))}</span><span class="mut">${i === 0 ? 'ngắn nhất · ' : ''}${fmtDist(a.cost)}</span></button>`).join('') +
      '<button class="btn ghost" id="mNo" style="margin-top:6px">Đóng</button>', el => {
      el.querySelector('#mNo').onclick = closeSheet;
      el.querySelectorAll('.opt').forEach(b => b.onclick = () => {
        const a = alts[+b.dataset.i];
        Object.assign(S.route, {start: a.start, end: a.end, order: a.order, cost: a.cost, exact: a.exact});
        LS.set('route', S.route); closeSheet(); renderPlan();
      });
    });
  };
  $('bStart').onclick = () => {
    S.trip = {mode: S.route.mode, order: S.route.order.slice(), done: [], started: Date.now(), plan: S.route.cost,
      start: S.route.start, end: S.route.end};
    LS.set('trip', S.trip); renderGo(); document.querySelector('main').scrollTop = 0;
    syncGps();
  };

  function tripState() {
    const T = S.trip, done = new Set(T.done), left = T.order.filter(id => !done.has(id));
    return {T, done, left, next: left[0] || null, cur: T.done.length ? T.done[T.done.length - 1] : T.start};
  }
  function remaining(st) {
    let d = 0, p = st.cur;
    for (const id of st.left) { d += dist(st.T.mode, p, id); p = id; }
    return d + dist(st.T.mode, p, st.T.end);
  }
  function renderTrip() {
    const st = tripState(), T = st.T, n = T.order.length, k = T.done.length;
    $('tProg').textContent = `${k}/${n}`;
    $('tBar').style.width = (n ? k / n * 100 : 0) + '%';
    if (st.next) {
      const b = B(st.next);
      $('tNext').innerHTML = `<div class="lbl">Tòa tiếp theo</div><div class="big">${esc(st.next)}</div>
        <div class="sub">${esc(b.zone)} · <span id="tDist">${fmtDist(dist(T.mode, st.cur, st.next))}</span></div>
        ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}`;
      $('bDone').textContent = 'Đã giao xong';
    } else {
      $('tNext').innerHTML = `<div class="lbl">Đã giao hết ${n} tòa</div><div class="big">Về ${esc(T.end)}</div>
        <div class="sub"><span id="tDist">${fmtDist(dist(T.mode, st.cur, T.end))}</span></div>`;
      $('bDone').textContent = 'Kết thúc chuyến';
    }
    $('bUndo').style.display = k ? '' : 'none';
    $('bReplan').style.display = st.left.length > 1 ? '' : 'none';
    const seq = [T.start, ...T.order, T.end];
    $('tripList').innerHTML = seq.map((id, i) => {
      const last = i === seq.length - 1, isDone = i > 0 && !last && st.done.has(id);
      const cls = isDone ? 'done' : (id === st.next && i > 0 && !last) || (!st.next && last) ? 'cur' : '';
      return swipeRow(stopRow(id, i, last, i ? dist(T.mode, seq[i - 1], id) : null, cls), i && !last && !isDone ? id : null);
    }).join('');
    const sk = (T.skipped || []).filter(id => id in IDX);
    $('skipSec').style.display = $('skipList').style.display = sk.length ? '' : 'none';
    $('skipList').innerHTML = sk.map(id => `<div class="stop"><span class="num">–</span><div><div class="id">${esc(id)}</div><div class="z">${esc(B(id).zone)}</div></div>
      <button class="link" data-add="${esc(id)}" style="margin-left:auto">Thêm lại</button></div>`).join('');
    const rd = routeData(T.mode, seq, st.next, st.done);
    rd.nextId = st.next; rd.nextLeg = st.next ? dist(T.mode, st.cur, st.next) : null;
    const li = rd.legState.indexOf('next');
    rd.focus = li >= 0 ? rd.legs[li] : null;   // bản đồ nhỏ chỉ hiện chặng đang đi
    tripRd = rd;
    showMini('trip', 'mapTrip', rd);
    updateLive(true);
  }
  // Bỏ hoặc thêm tòa khi đang giao. Tòa đang giao giữ nguyên ở đầu; các tòa còn lại sắp lại cho ngắn nhất rồi về cổng.
  let editing = false;
  async function editTrip({remove = [], add = []}) {
    if (editing || !S.trip) return;
    editing = true;
    try {
      const st = tripState(), T = st.T, before = remaining(st);
      const skipped = (T.skipped || []).filter(id => !add.includes(id));
      remove.forEach(id => { if (!skipped.includes(id)) skipped.push(id); });
      const left = st.left.filter(id => !remove.includes(id)).concat(add.filter(id => !st.left.includes(id) && !T.done.includes(id)));
      const keep = left.includes(st.next) ? st.next : null;
      const r = keep ? await solve(T.mode, keep, T.end, left.filter(id => id !== keep)) : await solve(T.mode, st.cur, T.end, left);
      T.order = [...T.done, ...(keep ? [keep] : []), ...r.order]; T.skipped = skipped;
      LS.set('trip', T); offWatch.reset(); renderGo();
      const after = remaining(tripState());
      toast((remove.length ? `Đã bỏ ${remove.join(', ')}` : `Đã thêm ${add.join(', ')}`) +
        (after < before - 5 ? ` · ngắn hơn ${fmtDist(before - after)}` : ` · còn ${fmtDist(after)}`));
    } catch (err) { toast('Không tính được: ' + err.message); }
    editing = false;
  }
  bindSwipe($('tripList'), id => editTrip({remove: [id]}));
  $('skipList').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) editTrip({add: [b.dataset.add]}); });
  $('bAdd').onclick = () => {
    const have = new Set(S.trip.order), pick = new Set();
    const cand = D.buildings.filter(b => b.id !== D.depot && !have.has(b.id));
    sheet(`<h3>Thêm tòa vào chuyến</h3>
      <input type="search" id="aQ" placeholder="Tìm tòa, vd. S3.03" autocomplete="off" autocorrect="off" autocapitalize="characters" style="margin-bottom:10px">
      <div class="pickl" id="aList"></div>
      <button class="btn" id="mOk" disabled>Thêm</button><button class="btn ghost" id="mNo">Đóng</button>`, el => {
      const list = el.querySelector('#aList'), ok = el.querySelector('#mOk'), q = el.querySelector('#aQ');
      const draw = () => {
        list.innerHTML = cand.filter(matchQ(norm(q.value))).map(b => `<div class="item${pick.has(b.id) ? ' on' : ''}" data-id="${esc(b.id)}"><span class="ck"></span>
          <div><div class="id">${esc(b.id)}</div><div class="nm">${esc(b.zone)}</div></div></div>`).join('') || '<div class="mut small" style="padding:14px 4px">Không có tòa phù hợp</div>';
        ok.disabled = !pick.size; ok.textContent = pick.size ? `Thêm ${pick.size} tòa` : 'Thêm';
      };
      q.addEventListener('input', draw);
      list.addEventListener('click', e => {
        const it = e.target.closest('.item'); if (!it) return;
        pick.has(it.dataset.id) ? pick.delete(it.dataset.id) : pick.add(it.dataset.id); draw();
      });
      el.querySelector('#mNo').onclick = closeSheet;
      ok.onclick = () => { closeSheet(); editTrip({add: [...pick]}); };
      draw();
    });
  };
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
      el.querySelector('#rGps').onclick = () => { closeSheet(); replanFromGps(); };
    });
  };
  // Tính lại từ tòa gần chỗ đang đứng nhất
  function replanFromGps() {
    if (!('geolocation' in navigator)) return toast('Máy không hỗ trợ định vị');
    const go = (la, lo) => {
      const kx = Math.cos(la * Math.PI / 180);
      let best = D.depot, bd = Infinity;
      D.buildings.forEach(b => { const d = Math.hypot(b.lat - la, (b.lon - lo) * kx); if (d < bd) { bd = d; best = b.id; } });
      replanFrom(best);
    };
    if (gpsPos && Date.now() - gpsPos.t < 30000) return go(gpsPos.lat, gpsPos.lon);
    toast('Đang tìm vị trí…');
    navigator.geolocation.getCurrentPosition(p => go(p.coords.latitude, p.coords.longitude),
      () => toast('Không lấy được vị trí. Hãy cho phép định vị trong Cài đặt của máy.', 3500),
      {enableHighAccuracy: true, timeout: 10000, maximumAge: 10000});
  }
  $('bOff').onclick = replanFromGps;
  async function replanFrom(startId) {
    const st = tripState(), before = remaining(st);
    const r = await solve(st.T.mode, startId, st.T.end, st.left);
    S.trip.order = [...S.trip.done, ...r.order];
    LS.set('trip', S.trip); offWatch.reset(); renderGo();
    const after = remaining(tripState());
    toast(after < before - 5 ? `Đã sắp xếp lại · ngắn hơn ${fmtDist(before - after)}` : 'Đã sắp xếp lại đường đi');
  }
  function finishTrip() {
    const T = S.trip;
    S.history.unshift({at: Date.now(), mode: T.mode, n: T.order.length, done: T.done.length, plan: T.plan,
      mins: Math.round((Date.now() - T.started) / 60000)});
    S.history = S.history.slice(0, 20); LS.set('history', S.history);
    S.trip = null; LS.del('trip');
    tripRd = live = null; nearKey = null; $('bDone').classList.remove('near'); $('bOff').style.display = 'none';
    syncGps(); updateWake();
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
    $('gateSet').style.display = D.gates && D.gates.length > 1 ? '' : 'none';
    $('gateOnly').textContent = 'Chỉ ' + D.depot;
    $('gateSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.g === '1') === S.settings.autoGate));
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
  $('gateSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.settings.autoGate = b.dataset.g === '1'; LS.set('settings', S.settings); renderSettings();
    toast('Áp dụng từ lần tính lộ trình sau');
  });
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
    S.settings = Object.assign({speed: Object.assign({}, D.defaults.speed_kmh), stopMin: D.defaults.stop_min, autoGate: true}, S.settings || {});
    [...S.sel].forEach(id => { if (!(id in IDX) || id === D.depot) S.sel.delete(id); });
    for (const o of [S.route, S.trip]) if (o) { o.start = o.start || D.depot; o.end = o.end || D.depot; }   // lộ trình lưu từ bản cũ
    if (S.trip && ![S.trip.start, S.trip.end, ...S.trip.order].every(id => id in IDX)) { S.trip = null; LS.del('trip'); }
    if (S.trip && S.trip.skipped) S.trip.skipped = S.trip.skipped.filter(id => id in IDX);
    renderPick();
    $('tripDot').classList.toggle('on', !!S.trip);
    if (S.trip) { $('tripDot').textContent = S.trip.order.length - S.trip.done.length || '✓'; show('s-go'); syncGps(); }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
    setTimeout(checkUpdate, 1500);
  }
  init();
})();
