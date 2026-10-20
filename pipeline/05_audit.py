#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Giai đoạn 5 – Kiểm tra chéo danh mục điểm giao với dữ liệu OSM và nguồn công khai.

Chỉ dùng thư viện chuẩn Python 3.

Cách chạy (từ thư mục gốc dự án):
    python3 pipeline/05_audit.py

Kiểm tra:
    1. Mỗi sảnh phải nằm sát khối nhà cùng mã (≤ ROAD_OWN_MAX m) và không gần khối của tòa khác hơn khối của chính nó.
    2. Khối nhà lớn không tên, chưa thuộc mã nào (nghi tòa còn thiếu), trừ các khối đã biết là không phải tòa ở.
    3. Số tòa mỗi phân khu khớp số liệu công khai (EXPECTED_COUNTS).
Có lỗi thì thoát mã 1 (build_all.sh dừng lại). Báo cáo ghi ở raw/audit_report.txt.
"""

import importlib.util
import math
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(ROOT, "raw", "audit_report.txt")

_spec = importlib.util.spec_from_file_location("s2", os.path.join(ROOT, "pipeline", "02_build_buildings.py"))
s2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(s2)

OWN_MAX = 30.0          # m – sảnh xa khối nhà của chính nó hơn mức này là nghi ghim sai
OTHER_MARGIN = 5.0      # m – gần khối của tòa khác hơn khối của mình bao nhiêu thì báo lỗi
UNNAMED_MIN_AREA = 900  # m² – khối không tên đủ lớn để nghi là một tòa

# Số tòa theo các trang giới thiệu dự án (vinhome.com.vn, grandpark-vinhomes.com, batdongsan.com.vn)
EXPECTED_COUNTS = {"The Rainbow": 17, "The Origami": 21, "Glory Heights": 5}

# Khối OSM không tên đã xem và biết không phải tòa ở
KNOWN_NON_TOWER = {1502828961: "khối hình chữ nhật gần S10.02, nhiều khả năng là khối thương mại"}


def dist_to_ring(p, ring):
    return s2.ring_closest(p, ring)[1]


def main():
    els = s2.load_osm()
    bnd = next(e for e in els if e["type"] == "way" and e.get("tags", {}).get("name") == "Vinhomes Grand Park"
               and e.get("tags", {}).get("landuse") == "residential")
    bnd_xy = s2.outer_ring_xy(bnd)
    areas_xy = []
    for e in els:
        t = e.get("tags", {})
        if e["type"] != "node" and t.get("landuse") == "residential" and t.get("name") and e is not bnd:
            r = s2.outer_ring_xy(e)
            if r:
                areas_xy.append((t["name"], r))

    polys, unmatched = {}, []
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node" or "building" not in t:
            continue
        r = s2.outer_ring_xy(e)
        if not r:
            continue
        c = s2.centroid_xy(r)
        if not (s2.inside(c, bnd_xy) or s2.ring_closest(c, bnd_xy)[1] <= s2.BOUNDARY_MARGIN):
            continue
        bid = s2.building_id(t, areas_xy, c) or s2.MANUAL_IDS.get(e["id"])
        if bid:
            polys.setdefault(bid, []).append(r)
        elif not s1_label(t) and t.get("building") in ("yes", "apartments", "residential"):   # bỏ qua trường học, siêu thị…
            unmatched.append((e["id"], s2.area(r), c))

    rows = s2.read_csv(s2.CSV_PATH)
    errs, warns, info = [], [], []

    for r in rows:
        p = s2.xy((float(r["lobby_lat"]), float(r["lobby_lon"])))
        own = polys.get(r["id"])
        if not own:
            info.append(f"{r['id']}: OSM chưa có khối nhà cùng mã, chỉ có điểm – không đối chiếu được")
            continue
        d_own = min(dist_to_ring(p, g) for g in own)
        if d_own > OWN_MAX:
            errs.append(f"{r['id']}: sảnh cách khối nhà của chính nó {d_own:.0f} m (tối đa {OWN_MAX:.0f} m)")
        best = min(((min(dist_to_ring(p, g) for g in gs), i) for i, gs in polys.items() if i != r["id"]),
                   default=(1e18, ""))
        if best[0] + OTHER_MARGIN < d_own:
            errs.append(f"{r['id']}: sảnh gần khối của {best[1]} ({best[0]:.0f} m) hơn khối của chính nó ({d_own:.0f} m)")

    for wid, a, c in sorted(unmatched, key=lambda x: -x[1]):
        if a < UNNAMED_MIN_AREA:
            continue
        la, lo = s2.ll(c)
        if wid in KNOWN_NON_TOWER:
            info.append(f"way {wid} ({a:.0f} m²): bỏ qua – {KNOWN_NON_TOWER[wid]}")
        else:
            warns.append(f"way {wid} ({a:.0f} m²) tại {la:.5f},{lo:.5f}: khối lớn không tên, chưa thuộc mã nào – có thể là tòa còn thiếu")

    count = {}
    for r in rows:
        if r["type"] == "cao_tang":
            count[r["zone"]] = count.get(r["zone"], 0) + 1
    for zone, n in EXPECTED_COUNTS.items():
        if count.get(zone, 0) != n:
            errs.append(f"{zone}: danh mục có {count.get(zone, 0)} tòa, nguồn công khai ghi {n}")

    L = [f"KIỂM TRA CHÉO DANH MỤC – {datetime.now():%Y-%m-%d %H:%M}", "",
         f"Số điểm: {len(rows)} · khối nhà OSM theo mã: {sum(len(v) for v in polys.values())}", ""]
    L += [f"LỖI   {m}" for m in errs] + [f"CẢNH BÁO {m}" for m in warns] + [f"GHI CHÚ {m}" for m in info]
    L += ["", "KẾT QUẢ: " + ("ĐẠT" if not errs else f"CHƯA ĐẠT ({len(errs)} lỗi)")]
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print("\n".join(L))
    sys.exit(1 if errs else 0)


def s1_label(tags):
    return s2.s1.element_label(tags)


if __name__ == "__main__":
    main()
