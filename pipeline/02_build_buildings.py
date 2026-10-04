#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Giai đoạn 2 – Danh mục điểm giao và vị trí sảnh nháp.

Chỉ dùng thư viện chuẩn Python 3.

Cách chạy (từ thư mục gốc dự án):
    python3 pipeline/02_build_buildings.py          # tạo/cập nhật data/buildings.csv + tools/editor_context.js
    python3 pipeline/02_build_buildings.py --check  # kiểm tra nghiệm thu data/buildings.csv

Quy tắc giữ dữ liệu đã chỉnh tay khi chạy lại:
    - Dòng verified=1, dòng lobby_src=thu_cong và dòng type=thap_tang được giữ nguyên.
    - Các dòng còn lại được tạo lại từ OSM.
"""

import argparse
import csv
import importlib.util
import json
import math
import os
import re
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw", "vgp_osm.json")
CSV_PATH = os.path.join(ROOT, "data", "buildings.csv")
REPORT = os.path.join(ROOT, "data", "buildings_report.txt")
CTX_JS = os.path.join(ROOT, "tools", "editor_context.js")

# Dùng lại các hàm phân tích của Giai đoạn 1
_spec = importlib.util.spec_from_file_location("s1", os.path.join(ROOT, "pipeline", "01_fetch_osm.py"))
s1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(s1)

DEPOT_ID = "S3.03"
COLUMNS = ["id", "name", "zone", "type", "lobby_lat", "lobby_lon", "aliases", "note",
           "is_depot", "lobby_src", "verified"]
SRC_VALUES = ("osm_sanh", "osm_diem", "uoc_luong", "thu_cong")
TYPE_VALUES = ("cao_tang", "thap_tang")

KNOWN_PREFIX = {"S", "BE", "BS", "GH", "OS"}
HINT_EDGE_MAX = 10.0      # m – điểm "Tòa X" cách mép tòa tối đa để coi là sảnh
HINT_SANH_MAX = 30.0      # m – điểm ghi rõ "Sảnh"
HINT_SHOW_MAX = 60.0      # m – điểm gợi ý hiển thị trong công cụ
BOUNDARY_MARGIN = 100.0   # m – nới ranh VGP
ROAD_WARN = 50.0          # m – cảnh báo sảnh xa đường


def zone_by_id(i):
    m = re.match(r"([A-Z]+)(\d+)?", i)
    pre, blk = m.group(1), int(m.group(2) or 0)
    if pre == "S":
        return "The Rainbow" if blk <= 5 else "The Origami"
    return {"BE": "The Beverly", "BS": "The Beverly Solari", "GH": "Glory Heights",
            "OS": "The Oasis", "MCP": "Masteri Centre Point", "LUM": "Lumière Boulevard"}.get(pre, "")


# ---------------------------------------------------------------------------
# Hình học (chiếu phẳng cục bộ, đơn vị mét)
# ---------------------------------------------------------------------------

LAT0, LON0 = 10.84, 106.84
KX = math.cos(math.radians(LAT0)) * 111320.0
KY = 110540.0


def xy(p):
    return ((p[1] - LON0) * KX, (p[0] - LAT0) * KY)


def ll(q):
    return (q[1] / KY + LAT0, q[0] / KX + LON0)


def seg_closest(p, a, b):
    """Điểm gần p nhất trên đoạn ab (toạ độ phẳng), trả (điểm, khoảng cách)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    q = (a[0] + t * dx, a[1] + t * dy)
    return q, math.hypot(p[0] - q[0], p[1] - q[1])


def ring_closest(p, ring):
    best = (None, 1e18)
    for i in range(len(ring) - 1):
        q, d = seg_closest(p, ring[i], ring[i + 1])
        if d < best[1]:
            best = (q, d)
    return best


def inside(p, ring):
    c = False
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1:
            c = not c
    return c


def area(ring):
    return abs(sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
                   for i in range(len(ring) - 1))) / 2


def centroid_xy(ring):
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def sample_ring(ring, step=2.0):
    out = []
    for i in range(len(ring) - 1):
        a, b = ring[i], ring[i + 1]
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        for k in range(n):
            t = k / n
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return out


# ---------------------------------------------------------------------------
# Đọc OSM
# ---------------------------------------------------------------------------

def load_osm():
    if not os.path.exists(RAW):
        sys.exit("Chưa có raw/vgp_osm.json – chạy pipeline/01_fetch_osm.py trước.")
    with open(RAW, encoding="utf-8") as f:
        return json.load(f)["elements"]


def outer_ring_xy(el):
    rings = s1.geom_of(el)
    if not rings or len(rings[0]) < 4:
        return None
    r = max(rings, key=lambda rr: len(rr))
    r = [xy(p) for p in r]
    if r[0] != r[-1]:
        r.append(r[0])
    return r


def building_id(tags, areas_xy, c_xy):
    """Suy ra mã chuẩn của một tòa từ tag; None nếu không nhận ra."""
    name = s1.element_label(tags)
    m = re.search(r"Masteri.*Tower\s*([A-Z])\b", name, re.I)
    if m:
        return "MCP-" + m.group(1).upper()
    m = re.search(r"Lumi.*Tower\s*([A-Z])\b", name, re.I)
    if m:
        return "LUM-" + m.group(1).upper()
    m = re.match(r"^\s*Tower\s*([A-Z])\s*$", name, re.I)
    if m and c_xy:  # "Tower B" trơn – xác định dự án theo vùng chứa nó
        for zname, ring in areas_xy:
            if inside(c_xy, ring):
                if re.search("Masteri", zname, re.I):
                    return "MCP-" + m.group(1).upper()
                if re.search("Lumi", zname, re.I):
                    return "LUM-" + m.group(1).upper()
    for c in s1.element_codes(tags):
        if re.match(r"[A-Z]+", c).group(0) in KNOWN_PREFIX:
            return c
    return None


def display_name(i):
    if i.startswith("MCP-"):
        return "Masteri Centre Point – Tower " + i[4:]
    if i.startswith("LUM-"):
        return "Lumière Boulevard – Tower " + i[4:]
    return "Tòa " + i


def auto_aliases(i):
    out = []
    m = re.match(r"([A-Z]+)(\d+)\.(\d+)$", i)
    if m:
        out += [f"{m.group(1)}{m.group(2)}{m.group(3)}", f"{m.group(1)}{m.group(2)}-{m.group(3)}"]
    if i.startswith("MCP-"):
        out += ["Masteri " + i[4:], "MCP " + i[4:]]
    if i.startswith("LUM-"):
        out += ["Lumiere " + i[4:], "Lumière " + i[4:]]
    return ";".join(out)


# Loại điểm gợi ý: sanh (ghi rõ sảnh) > toa (điểm đặt tên "Tòa X") > dia_chi (địa chỉ người dùng nhập)
# > poi (cửa hàng ở khối đế – không phải sảnh) > ham_xe (lối xuống hầm)
HINT_ORDER = ["sanh", "toa", "dia_chi", "poi", "ham_xe"]


def hint_kind(tags, nm):
    if re.search(r"h[ầa]m xe", nm, re.I) or tags.get("amenity") == "parking":
        return "ham_xe"
    if re.search(r"s[ảa]nh", nm, re.I):
        return "sanh"
    if any(k in tags for k in ("shop", "amenity", "office", "craft", "tourism")) or \
            re.search(r"mart|gs25|circle k|bank|acb|cafe|coffee|bread", nm, re.I):
        return "poi"
    if "," in nm or re.search(r"đ[ịi]a ch[ỉi]", nm, re.I):
        return "dia_chi"
    if re.search(r"\btower\s*[A-Z]\b", nm, re.I) or \
            re.match(r"^\s*(t[òo]a|to[àa])(\s*nh[àa])?\s+[a-z]{1,3}\s?\d", nm, re.I) or \
            re.match(r"^\s*[A-Za-z]{1,3}\s?\d{1,2}([.\-]?\d{2})?\s*$", nm):
        return "toa"
    return "dia_chi"


# ---------------------------------------------------------------------------
# Dựng danh mục
# ---------------------------------------------------------------------------

def build(els):
    # Ranh giới VGP
    bnd = next((e for e in els if e["type"] == "way" and e.get("tags", {}).get("name") == "Vinhomes Grand Park"
                and e.get("tags", {}).get("landuse") == "residential"), None)
    if not bnd:
        sys.exit("Không tìm thấy ranh giới 'Vinhomes Grand Park' trong dữ liệu OSM.")
    bnd_xy = outer_ring_xy(bnd)

    def in_vgp(p):
        return inside(p, bnd_xy) or ring_closest(p, bnd_xy)[1] <= BOUNDARY_MARGIN

    # Vùng dự án có tên (để gán phân khu và nhận "Tower B" trơn)
    areas_xy = []
    for e in els:
        t = e.get("tags", {})
        if e["type"] != "node" and t.get("landuse") == "residential" and t.get("name") \
                and e is not bnd:
            r = outer_ring_xy(e)
            if r:
                areas_xy.append((t["name"], r))

    # Đường xe máy (để ước lượng sảnh)
    road_segs = []
    roads_ctx = []
    for e in els:
        t = e.get("tags", {})
        hw = t.get("highway")
        if e["type"] != "way" or not hw:
            continue
        g = [xy(p) for p in s1.geom_of(e)[0]]
        if not g or not any(in_vgp(p) for p in g[:: max(1, len(g) // 5)] + [g[-1]]):
            continue
        cls = s1.road_class(hw)
        roads_ctx.append({"c": cls, "g": [[round(a, 6), round(b, 6)] for a, b in s1.geom_of(e)[0]]})
        if cls == "moto" and t.get("service") != "parking_aisle" \
                and t.get("access") not in ("no", "private"):
            for i in range(len(g) - 1):
                road_segs.append((g[i], g[i + 1]))

    def nearest_road(p):
        best = 1e18
        for a, b in road_segs:
            if min(a[0], b[0]) - best > p[0] or max(a[0], b[0]) + best < p[0]:
                continue
            best = min(best, seg_closest(p, a, b)[1])
        return best

    # Tòa nhà có khối
    groups = {}          # id -> list of (area, ring, el)
    unknown = []         # khối có tên nhưng không nhận ra mã
    foot_ctx = []        # khối nhà cho công cụ
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node" or not ("building" in t or "building:part" in t):
            continue
        r = outer_ring_xy(e)
        if not r:
            continue
        c = centroid_xy(r)
        if not in_vgp(c):
            continue
        bid = building_id(t, areas_xy, c)
        foot_ctx.append({"id": bid or "", "nm": s1.element_label(t),
                         "g": [[round(a, 6), round(b, 6)] for a, b in (ll(q) for q in r)]})
        if bid:
            groups.setdefault(bid, []).append((area(r), r, e))
        elif s1.element_label(t):
            unknown.append(s1.element_label(t))

    # Tòa chỉ có điểm (vd. Masteri Tower C, Lumière Tower B/C)
    node_only = {}
    for e in els:
        if e["type"] != "node":
            continue
        t = e.get("tags", {})
        p = xy((e["lat"], e["lon"]))
        if not in_vgp(p):
            continue
        bid = building_id(t, areas_xy, p)
        if bid and bid not in groups and (bid.startswith(("MCP-", "LUM-")) or "building" in t):
            node_only.setdefault(bid, (e["lat"], e["lon"]))

    # Điểm gợi ý: mọi node mang mã tòa
    hint_nodes = []
    for e in els:
        if e["type"] != "node":
            continue
        t = e.get("tags", {})
        nm = t.get("name", "")
        codes = set(s1.element_codes(t))
        bid = building_id(t, areas_xy, xy((e["lat"], e["lon"])))
        if bid:
            codes.add(bid)
        if codes:
            hint_nodes.append((e, codes, nm))

    rows, ctx_hints = [], {}
    stats = {k: 0 for k in SRC_VALUES}
    warns = []
    for bid in sorted(set(groups) | set(node_only), key=_id_key):
        notes = []
        hints = []
        if bid in groups:
            g = sorted(groups[bid], key=lambda x: -x[0])
            ring = g[0][1]
            if len(g) > 1:
                notes.append(f"OSM có {len(g)} khối trùng mã, lấy khối lớn nhất")
            for e, codes, nm in hint_nodes:
                if bid not in codes:
                    continue
                p = xy((e["lat"], e["lon"]))
                q, d = ring_closest(p, ring)
                if d > HINT_SHOW_MAX:
                    continue
                kind = hint_kind(e["tags"], nm)
                is_ham = kind == "ham_xe"
                hints.append({"kind": kind, "d": round(d, 1), "nm": nm, "node": e["id"],
                              "raw": [e["lat"], e["lon"]], "snap": [round(v, 7) for v in ll(q)]})
                if is_ham:
                    notes.append(f"Lối hầm xe gần: {nm}")
            hints.sort(key=lambda h: (HINT_ORDER.index(h["kind"]), h["d"]))
            pick = next((h for h in hints if h["kind"] == "sanh" and h["d"] <= HINT_SANH_MAX), None)
            src = "osm_sanh" if pick else None
            if not pick:
                pick = next((h for h in hints if h["kind"] == "toa" and h["d"] <= HINT_EDGE_MAX), None)
                src = "osm_diem" if pick else None
            if pick:
                lobby = tuple(pick["snap"])
            else:
                # Điểm trên mép tòa gần đường xe máy nhất
                best = (None, 1e18)
                for p in sample_ring(ring):
                    d = nearest_road(p)
                    if d < best[1]:
                        best = (p, d)
                lobby = tuple(round(v, 7) for v in ll(best[0]))
                src = "uoc_luong"
        else:
            lobby = node_only[bid]
            src = "osm_diem"
            notes.append("OSM chỉ có điểm, chưa có khối nhà")
        dr = nearest_road(xy(lobby))
        if dr > ROAD_WARN:
            warns.append(f"{bid}: sảnh nháp cách đường xe máy {dr:.0f} m")
        stats[src] += 1
        ctx_hints[bid] = hints
        rows.append({
            "id": bid, "name": display_name(bid), "zone": zone_by_id(bid), "type": "cao_tang",
            "lobby_lat": f"{lobby[0]:.7f}", "lobby_lon": f"{lobby[1]:.7f}",
            "aliases": auto_aliases(bid), "note": "; ".join(dict.fromkeys(notes)),
            "is_depot": "1" if bid == DEPOT_ID else "0", "lobby_src": src, "verified": "0",
        })

    ctx = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "boundary": [[round(a, 6), round(b, 6)] for a, b in (ll(q) for q in bnd_xy)],
        "footprints": foot_ctx, "roads": roads_ctx, "hints": ctx_hints,
    }
    return rows, ctx, stats, warns, sorted(set(unknown)), bnd_xy


def _id_key(i):
    m = re.match(r"([A-Z]+)-?(\d+)?(?:\.(\d+))?(?:-?([A-Z]))?", i)
    if not m:
        return (i, 0, 0, "")
    return (m.group(1), int(m.group(2) or 0), int(m.group(3) or 0), m.group(4) or "")


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [{k: (r.get(k) or "").strip() for k in COLUMNS} for r in csv.DictReader(f)]


def write_csv(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in COLUMNS})


def keep_row(r):
    return r["verified"] == "1" or r["lobby_src"] == "thu_cong" or r["type"] == "thap_tang"


# ---------------------------------------------------------------------------
# Kiểm tra nghiệm thu
# ---------------------------------------------------------------------------

def check(rows, bnd_xy):
    errs, ok = [], []
    ids = [r["id"] for r in rows]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        errs.append("Trùng id: " + ", ".join(dup))
    if any(not i for i in ids):
        errs.append("Có dòng thiếu id")
    dep = [r["id"] for r in rows if r["is_depot"] == "1"]
    if dep != [DEPOT_ID]:
        errs.append(f"Phải có đúng 1 depot là {DEPOT_ID}, hiện có: {dep or 'không có'}")
    for r in rows:
        try:
            p = xy((float(r["lobby_lat"]), float(r["lobby_lon"])))
        except ValueError:
            errs.append(f"{r['id']}: toạ độ sảnh không hợp lệ")
            continue
        if not inside(p, bnd_xy) and ring_closest(p, bnd_xy)[1] > BOUNDARY_MARGIN:
            errs.append(f"{r['id']}: sảnh nằm ngoài ranh VGP")
        if r["type"] not in TYPE_VALUES:
            errs.append(f"{r['id']}: type phải là {'/'.join(TYPE_VALUES)}")
        if r["lobby_src"] not in SRC_VALUES:
            errs.append(f"{r['id']}: lobby_src không hợp lệ ({r['lobby_src']!r})")
    unv = [r["id"] for r in rows if r["verified"] != "1"]
    if unv:
        errs.append(f"Chưa kiểm tra {len(unv)}/{len(rows)} điểm: " + ", ".join(unv[:40])
                    + (" …" if len(unv) > 40 else ""))
    else:
        ok.append(f"Đã kiểm tra đủ {len(rows)} điểm")
    return errs, ok


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Giai đoạn 2 – danh mục điểm giao và sảnh nháp")
    ap.add_argument("--check", action="store_true", help="chỉ kiểm tra nghiệm thu data/buildings.csv")
    a = ap.parse_args()

    els = load_osm()
    draft, ctx, stats, warns, unknown, bnd_xy = build(els)

    if a.check:
        rows = read_csv(CSV_PATH)
        if not rows:
            sys.exit("Chưa có data/buildings.csv")
        errs, ok = check(rows, bnd_xy)
        for s in ok:
            print("OK  ", s)
        for s in errs:
            print("LỖI ", s)
        print("\nKẾT QUẢ: " + ("ĐẠT" if not errs else f"CHƯA ĐẠT ({len(errs)} lỗi)"))
        sys.exit(1 if errs else 0)

    old = read_csv(CSV_PATH)
    kept = {r["id"]: r for r in old if keep_row(r)}
    rows = [kept.get(r["id"], r) for r in draft]
    draft_ids = {r["id"] for r in draft}
    rows += [r for i, r in kept.items() if i not in draft_ids]   # điểm thêm tay (thấp tầng…)
    rows.sort(key=lambda r: (r["type"] != "cao_tang", r["zone"] == "", r["zone"], _id_key(r["id"])))
    write_csv(CSV_PATH, rows)

    ctx["draft"] = rows
    os.makedirs(os.path.dirname(CTX_JS), exist_ok=True)
    with open(CTX_JS, "w", encoding="utf-8") as f:
        f.write("// Tự sinh bởi pipeline/02_build_buildings.py – không sửa tay\n")
        f.write("window.VGP_CTX = " + json.dumps(ctx, ensure_ascii=False, separators=(",", ":")) + ";\n")

    # Báo cáo
    L = [f"DANH MỤC ĐIỂM GIAO – {datetime.now():%Y-%m-%d %H:%M}", ""]
    L.append(f"Tổng số điểm trong buildings.csv: {len(rows)} "
             f"(cao tầng {sum(r['type'] == 'cao_tang' for r in rows)}, "
             f"thấp tầng {sum(r['type'] == 'thap_tang' for r in rows)})")
    L.append(f"Giữ nguyên từ lần trước (đã kiểm tra / chỉnh tay): {len(kept)}")
    L.append("")
    L.append("Nguồn sảnh nháp của các tòa từ OSM:")
    lbl = {"osm_sanh": "điểm OSM ghi rõ 'Sảnh'", "osm_diem": "điểm 'Tòa X' sát mép tòa / tòa chỉ có điểm",
           "uoc_luong": "ước lượng (mép tòa gần đường)", "thu_cong": "thủ công"}
    for k in SRC_VALUES:
        ids = [r["id"] for r in draft if r["lobby_src"] == k]
        if ids:
            L.append(f"  - {lbl[k]}: {len(ids)} → " + ", ".join(ids))
    L.append("")
    L.append("Theo phân khu:")
    zc = {}
    for r in rows:
        zc[r["zone"] or "(chưa có)"] = zc.get(r["zone"] or "(chưa có)", 0) + 1
    for z, c in sorted(zc.items()):
        L.append(f"  - {z}: {c}")
    L.append("")
    L.append(f"Cảnh báo sảnh xa đường > {ROAD_WARN:.0f} m: {len(warns)}")
    L += ["  - " + w for w in warns]
    L.append("")
    L.append(f"Khối nhà có tên nhưng không nhận ra mã (không đưa vào danh mục): {len(unknown)}")
    L += ["  - " + u for u in unknown]
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")

    print("\n".join(L[:12]))
    print(f"\nĐã lưu {os.path.relpath(CSV_PATH, ROOT)}, {os.path.relpath(REPORT, ROOT)}, "
          f"{os.path.relpath(CTX_JS, ROOT)}")
    print("Tiếp theo: mở tools/lobby_editor.html bằng trình duyệt.")


if __name__ == "__main__":
    main()
