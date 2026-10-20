// Kiểm thử theo dõi vị trí: node tests/track.test.js
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', 'app', 'track.js'));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'LỖI  ') + msg); if (!cond) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Đường chữ L ở vĩ độ ~10.84: 200 m đi đông rồi 100 m đi bắc
const LAT = 10.84, LON = 106.84, KX = Math.cos(LAT * Math.PI / 180) * 111320, KY = 110540;
const at = (east, north) => [LAT + north / KY, LON + east / KX];
const L = [at(0, 0), at(200, 0), at(200, 100)];

ok(near(T.distance(at(0, 0), at(30, 40)), 50, 0.5), 'distance: tam giác 30-40-50');
ok(near(T.bearing(at(0, 0), at(0, 50)), 0, 0.5) && near(T.bearing(at(0, 0), at(50, 0)), 90, 0.5)
  && near(T.bearing(at(0, 0), at(0, -50)), 180, 0.5) && near(T.bearing(at(0, 0), at(-50, 0)), 270, 0.5), 'bearing: bắc 0, đông 90, nam 180, tây 270');

let pr = T.project(L, at(50, 10));
ok(near(pr.total, 300, 0.5), 'project: tổng chiều dài 300 m');
ok(near(pr.dist, 10, 0.2) && near(pr.along, 50, 0.5) && pr.seg === 0, 'project: điểm cách đường 10 m, đã đi 50 m ở đoạn đầu');
pr = T.project(L, at(210, 60));
ok(near(pr.dist, 10, 0.2) && near(pr.along, 260, 0.5) && pr.seg === 1, 'project: ở đoạn thứ hai, đã đi 260 m');
pr = T.project(L, at(-30, 0));
ok(near(pr.along, 0, 0.5) && near(pr.dist, 30, 0.2), 'project: trước điểm đầu thì kẹp về 0 m');
pr = T.project(L, at(200, 400));
ok(near(pr.along, 300, 0.5) && near(pr.dist, 300, 0.5), 'project: quá điểm cuối thì kẹp về cuối đường');

// đi dọc đường: along tăng dần, dist luôn ≈ 0
let prev = -1, mono = true;
for (let s = 0; s <= 300; s += 15) {
  const p = s <= 200 ? at(s, 0) : at(200, s - 200), r = T.project(L, p);
  if (r.along < prev - 0.01 || r.dist > 0.2) mono = false;
  prev = r.along;
}
ok(mono, 'project: đi dọc đường thì along tăng đều và dist ≈ 0');

// split: hai nửa cộng lại đúng tổng chiều dài, nối đúng tại điểm chiếu
const pj = T.project(L, at(120, 5)), sp = T.split(L, pj);
const len = pts => pts.slice(1).reduce((s, q, i) => s + T.distance(pts[i], q), 0);
ok(near(len(sp.done) + len(sp.rest), 300, 0.5) && near(len(sp.done), 120, 0.5), 'split: phần đã đi 120 m, tổng 300 m');
ok(sp.done[sp.done.length - 1] === sp.rest[0], 'split: hai nửa chung điểm chiếu');
ok(T.split(L, T.project(L, at(200, 50))).rest.length === 2, 'split: ở đoạn cuối chỉ còn điểm chiếu và điểm cuối');

// đường suy biến
ok(T.project([at(5, 5)], at(0, 0)).total === 0 && near(T.project([at(5, 5)], at(0, 0)).dist, Math.hypot(5, 5), 0.2), 'project: đường chỉ một điểm không gây lỗi');
ok(near(T.project([at(0, 0), at(0, 0)], at(3, 4)).dist, 5, 0.1), 'project: đường dài 0 m không chia cho 0');

// OffRoute: phải xa liên tục đủ lâu; quay lại gần đường thì xoá
const w = new T.OffRoute(40, 10000);
ok(!w.update(60, 0) && !w.update(60, 9000), 'OffRoute: xa 9 giây chưa báo');
ok(w.update(60, 10000), 'OffRoute: xa đủ 10 giây thì báo');
ok(!w.update(10, 11000) && !w.update(60, 12000) && !w.update(60, 21000), 'OffRoute: về gần đường thì đếm lại từ đầu');
ok(w.update(60, 22000), 'OffRoute: lại xa đủ 10 giây thì báo lại');
ok(!new T.OffRoute().update(NaN, 0), 'OffRoute: khoảng cách không hợp lệ không báo');

console.log(fails ? `\nCÓ ${fails} LỖI` : '\nTẤT CẢ ĐẠT');
process.exit(fails ? 1 : 0);
