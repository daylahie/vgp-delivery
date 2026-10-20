/*
 * Theo dõi vị trí so với tuyến đang đi (các phép tính thuần, không đụng giao diện).
 * Dùng được trong trình duyệt và Node (cho test).
 *  - project: chiếu một điểm lên đường gấp khúc -> khoảng cách tới đường, đã đi bao xa, còn bao xa
 *  - split: tách đường thành phần đã đi và phần còn lại tại điểm chiếu
 *  - OffRoute: báo lệch tuyến khi xa đường quá ngưỡng liên tục một lúc (tránh báo nhầm vì GPS nhảy)
 *  - bearing / distance: hướng và khoảng cách giữa hai điểm [vĩ độ, kinh độ]
 */
(function (root) {
  'use strict';

  const KY = 110540;
  const kxAt = lat => Math.cos(lat * Math.PI / 180) * 111320;

  /** Khoảng cách (m) giữa hai điểm [lat, lon]. */
  function distance(a, b) {
    const kx = kxAt((a[0] + b[0]) / 2);
    return Math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * kx);
  }

  /** Hướng từ a tới b, độ theo chiều kim đồng hồ từ hướng bắc (0–360). */
  function bearing(a, b) {
    const kx = kxAt((a[0] + b[0]) / 2);
    const deg = Math.atan2((b[1] - a[1]) * kx, (b[0] - a[0]) * KY) * 180 / Math.PI;
    return (deg + 360) % 360;
  }

  /**
   * Chiếu điểm p lên đường gấp khúc path ([[lat, lon], ...]).
   * @returns {{dist:number, along:number, total:number, seg:number, t:number, pt:number[]}}
   *   dist: khoảng cách từ p tới đường (m); along: đã đi dọc đường (m); total: độ dài cả đường (m);
   *   seg, t: đoạn gần nhất và vị trí trong đoạn (0–1); pt: điểm chiếu [lat, lon].
   */
  function project(path, p) {
    const kx = kxAt(p[0]);
    const xy = q => [(q[1] - p[1]) * kx, (q[0] - p[0]) * KY];   // p là gốc toạ độ
    let total = 0, best = {dist: Infinity, along: 0, seg: 0, t: 0};
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, ay] = xy(path[i]), [bx, by] = xy(path[i + 1]);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len))) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.dist) best = {dist: d, along: total + t * len, seg: i, t};
      total += len;
    }
    if (path.length < 2) return {dist: path.length ? distance(path[0], p) : Infinity, along: 0, total: 0, seg: 0, t: 0, pt: path[0] || p};
    const a = path[best.seg], b = path[best.seg + 1];
    return Object.assign(best, {total, pt: [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]});
  }

  /** Tách đường tại điểm chiếu: done = từ đầu tới điểm chiếu, rest = từ điểm chiếu tới cuối. */
  function split(path, proj) {
    return {
      done: path.slice(0, proj.seg + 1).concat([proj.pt]),
      rest: [proj.pt].concat(path.slice(proj.seg + 1)),
    };
  }

  /** Lệch tuyến = cách đường hơn maxDist mét liên tục ít nhất holdMs mili giây. */
  class OffRoute {
    constructor(maxDist = 40, holdMs = 10000) { this.maxDist = maxDist; this.holdMs = holdMs; this.since = null; }
    /** Gọi mỗi lần có vị trí mới; trả về true nếu đang lệch tuyến. */
    update(dist, now) {
      if (!(dist > this.maxDist)) { this.since = null; return false; }
      if (this.since === null) this.since = now;
      return now - this.since >= this.holdMs;
    }
    reset() { this.since = null; }
  }

  const api = {distance, bearing, project, split, OffRoute};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VgpTrack = api;
})(typeof self !== 'undefined' ? self : this);
