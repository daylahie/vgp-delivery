/*
 * Bộ giải lộ trình (TSP có điểm đầu/cuối cố định, ma trận có thể bất đối xứng).
 * - ≤ 12 điểm giao: Held–Karp (tối ưu tuyệt đối).
 * - > 12 điểm: Nearest Neighbor + Or-opt + 2-opt (bản an toàn cho ma trận bất đối xứng)
 *   + lặp cục bộ có nhiễu (ILS) với seed cố định.
 * Kết quả xác định: cùng đầu vào luôn cùng đầu ra (không dùng thời gian/Math.random).
 * Dùng được trong Web Worker, trình duyệt và Node (cho test).
 */
(function (root) {
  'use strict';

  const EXACT_MAX = 12;

  // PRNG xác định
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pathCost(D, start, end, order) {
    let c = 0, p = start;
    for (const x of order) { c += D[p][x]; p = x; }
    return c + D[p][end];
  }

  // So sánh hai lời giải: chi phí nhỏ hơn thắng, bằng thì thứ tự từ điển nhỏ hơn
  function better(c1, o1, c2, o2) {
    if (c1 < c2 - 1e-9) return true;
    if (c1 > c2 + 1e-9) return false;
    for (let i = 0; i < o1.length; i++) if (o1[i] !== o2[i]) return o1[i] < o2[i];
    return false;
  }

  // ---------- Held–Karp ----------
  function heldKarp(D, start, end, stops) {
    const k = stops.length, N = 1 << k, INF = Infinity;
    const dp = new Float64Array(N * k).fill(INF);
    const par = new Int8Array(N * k).fill(-1);
    for (let j = 0; j < k; j++) dp[(1 << j) * k + j] = D[start][stops[j]];
    for (let mask = 1; mask < N; mask++) {
      for (let j = 0; j < k; j++) {
        if (!(mask & (1 << j))) continue;
        const cur = dp[mask * k + j];
        if (cur === INF) continue;
        const sj = stops[j];
        for (let n = 0; n < k; n++) {
          if (mask & (1 << n)) continue;
          const nm = mask | (1 << n), idx = nm * k + n, v = cur + D[sj][stops[n]];
          // phá hoà: giữ đỉnh trước có chỉ số nhỏ hơn (j tăng dần nên dùng < là đủ)
          if (v < dp[idx] - 1e-9) { dp[idx] = v; par[idx] = j; }
        }
      }
    }
    const full = N - 1;
    let best = INF, last = -1;
    for (let j = 0; j < k; j++) {
      const v = dp[full * k + j] + D[stops[j]][end];
      if (v < best - 1e-9) { best = v; last = j; }
    }
    const order = [];
    let mask = full, j = last;
    while (j !== -1) { order.push(stops[j]); const p = par[mask * k + j]; mask ^= (1 << j); j = p; }
    order.reverse();
    return order;
  }

  // ---------- Heuristic ----------
  function nearestNeighbor(D, start, stops) {
    const left = stops.slice(), order = [];
    let cur = start;
    while (left.length) {
      let bi = 0;
      for (let i = 1; i < left.length; i++) {
        const a = D[cur][left[i]], b = D[cur][left[bi]];
        if (a < b - 1e-9 || (Math.abs(a - b) <= 1e-9 && left[i] < left[bi])) bi = i;
      }
      cur = left[bi]; order.push(cur); left.splice(bi, 1);
    }
    return order;
  }

  // seq = [start, ...order, end]; trả về true nếu có cải thiện (first improvement)
  function twoOpt(D, seq) {
    const n = seq.length;
    // tiền tố chi phí chiều xuôi và chiều ngược của từng cạnh
    const fw = new Float64Array(n), bw = new Float64Array(n);
    for (let i = 1; i < n; i++) { fw[i] = fw[i - 1] + D[seq[i - 1]][seq[i]]; bw[i] = bw[i - 1] + D[seq[i]][seq[i - 1]]; }
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        // đảo đoạn seq[i..j]
        const a = seq[i - 1], b = seq[j + 1];
        const old = D[a][seq[i]] + (fw[j] - fw[i]) + D[seq[j]][b];
        const nw = D[a][seq[j]] + (bw[j] - bw[i]) + D[seq[i]][b];
        if (nw < old - 1e-9) {
          for (let x = i, y = j; x < y; x++, y--) { const t = seq[x]; seq[x] = seq[y]; seq[y] = t; }
          return true;
        }
      }
    }
    return false;
  }

  function orOpt(D, seq) {
    const n = seq.length;
    for (let len = 1; len <= 3; len++) {
      for (let i = 1; i + len - 1 < n - 1; i++) {
        const s0 = seq[i], s1 = seq[i + len - 1], p = seq[i - 1], q = seq[i + len];
        const remove = D[p][s0] + D[s1][q] - D[p][q];
        for (let j = 0; j < n - 1; j++) {
          if (j >= i - 1 && j <= i + len - 1) continue; // chèn giữa seq[j] và seq[j+1]
          const a = seq[j], b = seq[j + 1];
          const add = D[a][s0] + D[s1][b] - D[a][b];
          if (add - remove < -1e-9) {
            const seg = seq.splice(i, len);
            const pos = j < i ? j + 1 : j + 1 - len;
            seq.splice(pos, 0, ...seg);
            return true;
          }
        }
      }
    }
    return false;
  }

  function localSearch(D, seq) {
    let guard = 0;
    while (guard++ < 10000) {
      if (orOpt(D, seq)) continue;
      if (twoOpt(D, seq)) continue;
      break;
    }
  }

  function doubleBridge(order, rnd) {
    const n = order.length;
    if (n < 8) {
      const o = order.slice(), i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
      const t = o[i]; o[i] = o[j]; o[j] = t; return o;
    }
    const cuts = [];
    while (cuts.length < 3) { const c = 1 + Math.floor(rnd() * (n - 1)); if (!cuts.includes(c)) cuts.push(c); }
    cuts.sort((a, b) => a - b);
    const [a, b, c] = cuts;
    return order.slice(0, a).concat(order.slice(c), order.slice(b, c), order.slice(a, b));
  }

  function heuristic(D, start, end, stops, opts) {
    const restarts = opts.restarts ?? 4;
    const iters = opts.iters ?? Math.min(400, 40 + stops.length * 4);
    let bestO = null, bestC = Infinity;
    for (let r = 0; r < restarts; r++) {
      const rnd = mulberry32(1000 + r * 7919);
      let init;
      if (r === 0) init = nearestNeighbor(D, start, stops);
      else { init = stops.slice(); for (let i = init.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [init[i], init[j]] = [init[j], init[i]]; } }
      let seq = [start, ...init, end];
      localSearch(D, seq);
      let curO = seq.slice(1, -1), curC = pathCost(D, start, end, curO);
      for (let it = 0; it < iters; it++) {
        const s2 = [start, ...doubleBridge(curO, rnd), end];
        localSearch(D, s2);
        const o2 = s2.slice(1, -1), c2 = pathCost(D, start, end, o2);
        if (better(c2, o2, curC, curO)) { curO = o2; curC = c2; }
      }
      if (bestO === null || better(curC, curO, bestC, bestO)) { bestO = curO; bestC = curC; }
    }
    return bestO;
  }

  /**
   * Giải lộ trình.
   * @param {number[][]} D  ma trận khoảng cách (mét), D[i][j] có thể khác D[j][i]
   * @param {number} start  chỉ số điểm bắt đầu
   * @param {number} end    chỉ số điểm kết thúc (vòng kín: end = start)
   * @param {number[]} stops chỉ số các điểm giao (không gồm start/end)
   * @returns {{order:number[], cost:number, exact:boolean}}
   */
  function solve(D, start, end, stops, opts) {
    opts = opts || {};
    const S = [...new Set(stops)].filter(x => x !== start && x !== end).sort((a, b) => a - b);
    let order;
    const exact = S.length <= (opts.exactMax ?? EXACT_MAX);
    if (S.length === 0) order = [];
    else if (exact) order = heldKarp(D, start, end, S);
    else order = heuristic(D, start, end, S, opts);
    return {order, cost: pathCost(D, start, end, order), exact};
  }

  const api = {solve, pathCost, heldKarp, heuristic, EXACT_MAX};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VGPSolver = api;
})(typeof self !== 'undefined' ? self : this);
