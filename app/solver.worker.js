// Web Worker: chạy bộ giải ngoài luồng giao diện để app không bị đơ
// op: 'gates' (thử các cặp cổng) | 'route' (một cặp start/end cố định)
importScripts('solver.js');

self.onmessage = e => {
  const {id, op, dist, start, end, stops, gates, opts} = e.data;
  try {
    const t0 = Date.now(), S = self.VGPSolver;
    const result = op === 'gates' ? S.solveGates(dist, gates, stops, opts) : S.solveRoute(dist, start, end, stops, opts);
    self.postMessage({id, ok: true, result, ms: Date.now() - t0});
  } catch (err) {
    self.postMessage({id, ok: false, error: String(err && err.message || err)});
  }
};
