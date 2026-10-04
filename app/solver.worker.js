// Web Worker: chạy bộ giải ngoài luồng giao diện để app không bị đơ
importScripts('solver.js');

self.onmessage = e => {
  const {id, dist, start, end, stops, opts} = e.data;
  try {
    const t0 = Date.now();
    const r = self.VGPSolver.solve(dist, start, end, stops, opts);
    self.postMessage({id, ok: true, ...r, ms: Date.now() - t0});
  } catch (err) {
    self.postMessage({id, ok: false, error: String(err && err.message || err)});
  }
};
