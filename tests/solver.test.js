// Kiểm thử bộ giải: node tests/solver.test.js
// 1) Held–Karp và heuristic trùng tối ưu vét cạn với n ≤ 9 (ma trận bất đối xứng ngẫu nhiên)
// 2) Tính xác định: 20 lần chạy cùng đầu vào cho kết quả giống hệt
// 3) Hiệu năng trên dữ liệu thật (app/data/data.json) – toàn khu
'use strict';
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'app', 'solver.js'));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'LỖI  ') + msg); if (!cond) fails++; };

function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
function randMatrix(n, seed, asym = true) {
  const r = rng(seed), P = Array.from({length: n}, () => [r() * 1000, r() * 1000]);
  return P.map((a, i) => P.map((b, j) => i === j ? 0 :
    Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * (asym ? 1 + r() * 0.8 : 1))));
}
function brute(D, start, end, stops) {
  let best = Infinity;
  const perm = (arr, l) => {
    if (l === arr.length) { best = Math.min(best, S.pathCost(D, start, end, arr)); return; }
    for (let i = l; i < arr.length; i++) { [arr[l], arr[i]] = [arr[i], arr[l]]; perm(arr, l + 1); [arr[l], arr[i]] = [arr[i], arr[l]]; }
  };
  perm(stops.slice(), 0);
  return best;
}

// 1) So với vét cạn
let hkOk = 0, heOk = 0, total = 0;
for (let t = 0; t < 60; t++) {
  const n = 3 + (t % 8);                    // 3..10 nút -> 2..9 điểm giao
  const D = randMatrix(n, 100 + t, t % 3 !== 0);
  const start = 0, end = t % 4 === 0 ? n - 1 : 0;
  const stops = [...Array(n).keys()].filter(x => x !== start && x !== end);
  if (stops.length > 9) continue;
  const opt = brute(D, start, end, stops);
  total++;
  if (Math.abs(S.solve(D, start, end, stops).cost - opt) < 1e-6) hkOk++;
  if (Math.abs(S.pathCost(D, start, end, S.heuristic(D, start, end, stops, {})) - opt) < 1e-6) heOk++;
}
ok(hkOk === total, `Held–Karp trùng tối ưu vét cạn: ${hkOk}/${total}`);
ok(heOk === total, `Heuristic trùng tối ưu vét cạn (n ≤ 9): ${heOk}/${total}`);

// 2) Xác định
const D40 = randMatrix(41, 7);
const st40 = [...Array(40).keys()].map(x => x + 1);
const ref = JSON.stringify(S.solve(D40, 0, 0, st40).order);
let same = 0;
for (let i = 0; i < 20; i++) {
  const shuffled = st40.slice().sort(() => (i % 2 ? 1 : -1)); // thứ tự đầu vào khác nhau
  if (JSON.stringify(S.solve(D40, 0, 0, shuffled).order) === ref) same++;
}
ok(same === 20, `Xác định: 20/20 lần cho cùng kết quả (${same}/20)`);

// Held–Karp và heuristic không thua nhau ở n = 12
const D13 = randMatrix(13, 99);
const hk = S.solve(D13, 0, 0, [...Array(12).keys()].map(x => x + 1));
const he = S.pathCost(D13, 0, 0, S.heuristic(D13, 0, 0, [...Array(12).keys()].map(x => x + 1), {}));
ok(he >= hk.cost - 1e-6, `Heuristic không tốt hơn tối ưu ở n=12 (${he} ≥ ${hk.cost})`);
console.log(`     Heuristic lệch tối ưu ở n=12: ${((he / hk.cost - 1) * 100).toFixed(2)}%`);

// 3) Dữ liệu thật
const dataPath = path.join(__dirname, '..', 'app', 'data', 'data.json');
if (fs.existsSync(dataPath)) {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const dep = data.buildings.findIndex(b => b.id === data.depot);
  const all = data.buildings.map((_, i) => i).filter(i => i !== dep);
  for (const m of ['moto', 'walk']) {
    const D = data.modes[m].dist;
    let t0 = Date.now();
    const r = S.solve(D, dep, dep, all);
    const ms = Date.now() - t0;
    ok(r.order.length === all.length && new Set(r.order).size === all.length, `[${m}] toàn khu ${all.length} điểm: đủ điểm, không trùng`);
    console.log(`     [${m}] tổng ${(r.cost / 1000).toFixed(2)} km, ${ms} ms trên máy này`);
    const r2 = S.solve(D, dep, dep, all.slice().reverse());
    ok(JSON.stringify(r.order) === JSON.stringify(r2.order), `[${m}] toàn khu: xác định`);
    // 10 điểm: so với vét cạn không khả thi (10!), so Held–Karp với heuristic
    const ten = all.filter((_, i) => i % 7 === 0).slice(0, 10);
    const a = S.solve(D, dep, dep, ten).cost, b = S.pathCost(D, dep, dep, S.heuristic(D, dep, dep, ten, {}));
    ok(Math.abs(a - b) < 1e-6, `[${m}] 10 điểm thật: heuristic = tối ưu (${a} m)`);
    t0 = Date.now();
    const p30 = all.filter((_, i) => i % 2 === 0).slice(0, 30);
    S.solve(D, dep, dep, p30);
    console.log(`     [${m}] 30 điểm: ${Date.now() - t0} ms`);
  }
} else {
  console.log('(Bỏ qua test dữ liệu thật – chưa có app/data/data.json)');
}

console.log(fails ? `\nCÓ ${fails} LỖI` : '\nTẤT CẢ ĐẠT');
process.exit(fails ? 1 : 0);
