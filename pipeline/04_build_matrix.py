#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Giai đoạn 4 – Ma trận khoảng cách, hình dạng tuyến và lớp nền bản đồ cho app.

Chỉ dùng thư viện chuẩn Python 3.

Cách chạy (từ thư mục gốc dự án):
    python3 pipeline/04_build_matrix.py

Đầu vào:  data/graph_moto.json, data/graph_walk.json, data/buildings.csv, raw/vgp_osm.json
Đầu ra:   app/data/data.json, raw/matrix_report.txt
"""

import hashlib
import heapq
import importlib.util
import json
import math
import os
import random
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "data", "data.json")
REPORT = os.path.join(ROOT, "raw", "matrix_report.txt")
MODES = ("moto", "walk")
DEFAULTS = {"speed_kmh": {"moto": 20, "walk": 4.5}, "stop_min": 3}
SIMPLIFY_M = 2.0       # sai số giản lược tuyến (m)
MAP_SIMPLIFY_M = 1.5   # sai số giản lược lớp nền (m)
SIZE_LIMIT_MB = 8.0


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "pipeline", fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


s2 = _load("s2", "02_build_buildings.py")
s1 = s2.s1
xy, ll = s2.xy, s2.ll


# ---------------------------------------------------------------------------
# Tiện ích
# ---------------------------------------------------------------------------

def simplify(pts, tol):
    """Douglas–Peucker trên toạ độ (lat, lon), sai số tol mét."""
    if len(pts) < 3:
        return list(pts)
    P = [xy(p) for p in pts]
    keep = [False] * len(P)
    keep[0] = keep[-1] = True
    stack = [(0, len(P) - 1)]
    while stack:
        a, b = stack.pop()
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            d = s2.seg_closest(P[i], P[a], P[b])[1]
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def encode(pts, prec=1e5):
    """Mã hoá polyline (thuật toán Google, độ chính xác 1e-5 ≈ 1,1 m)."""
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        a, b = int(round(lat * prec)), int(round(lon * prec))
        for v in (a - plat, b - plon):
            v = ~(v << 1) if v < 0 else (v << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = a, b
    return "".join(out)


def dijkstra(adj, src, n):
    INF = float("inf")
    dist = [INF] * n
    prev = [-1] * n
    dist[src] = 0.0
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w in adj[u]:
            nd = d + w
            # phá hoà theo chỉ số nút để kết quả xác định
            if nd < dist[v] - 1e-9 or (abs(nd - dist[v]) <= 1e-9 and u < prev[v]):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return dist, prev


def meters(a, b):
    p, q = xy(a), xy(b)
    return math.hypot(p[0] - q[0], p[1] - q[1])


# ---------------------------------------------------------------------------

def build_mode(mode, ids):
    path = os.path.join(ROOT, "data", f"graph_{mode}.json")
    if not os.path.exists(path):
        sys.exit(f"Chưa có data/graph_{mode}.json – chạy pipeline/03_build_graph.py trước.")
    with open(path, encoding="utf-8") as f:
        G = json.load(f)
    n = len(G["nodes"])
    adj = [[] for _ in range(n)]
    for u, v, w in G["edges"]:
        adj[u].append((v, w))
    for a in adj:
        a.sort()
    missing = [i for i in ids if i not in G["lobbies"]]
    if missing:
        sys.exit(f"[{mode}] Thiếu sảnh trong đồ thị: {missing} – chạy lại 03_build_graph.py")
    idx = [G["lobbies"][i] for i in ids]
    D, PATHS, unreach = [], [], []
    for a, src in enumerate(idx):
        dist, prev = dijkstra(adj, src, n)
        drow, prow = [], []
        for b, dst in enumerate(idx):
            if a == b:
                drow.append(0)
                prow.append("")
                continue
            if dist[dst] == float("inf"):
                unreach.append((ids[a], ids[b]))
                drow.append(-1)
                prow.append("")
                continue
            seq, v = [], dst
            while v != -1:
                seq.append(G["nodes"][v])
                v = prev[v]
            seq.reverse()
            drow.append(int(round(dist[dst])))
            prow.append(encode(simplify([tuple(p) for p in seq], SIMPLIFY_M)))
        D.append(drow)
        PATHS.append(prow)
    return {"dist": D, "path": PATHS}, unreach


def build_map(els, rows):
    """Lớp nền vector: ranh giới, đường, khối nhà (đã giản lược, mã hoá)."""
    bnd = next(e for e in els if e["type"] == "way" and e.get("tags", {}).get("name") == "Vinhomes Grand Park"
               and e.get("tags", {}).get("landuse") == "residential")
    bnd_xy = s2.outer_ring_xy(bnd)

    def near(p, m):
        q = xy(p)
        return s2.inside(q, bnd_xy) or s2.ring_closest(q, bnd_xy)[1] <= m

    roads = []
    for e in els:
        t = e.get("tags", {})
        hw = t.get("highway")
        if e["type"] != "way" or not hw or not e.get("geometry") or hw in ("construction", "proposed"):
            continue
        g = [(p["lat"], p["lon"]) for p in e["geometry"]]
        if not any(near(p, 400) for p in g):
            continue
        cls = "m" if hw in s1.MOTO_TYPES or hw in ("trunk", "trunk_link", "motorway") else \
              ("w" if hw in s1.WALK_ONLY_TYPES else "o")
        major = hw in ("primary", "secondary", "tertiary", "trunk", "motorway",
                       "primary_link", "secondary_link", "tertiary_link")
        roads.append({"c": cls, "k": 1 if major else 0, "g": encode(simplify(g, MAP_SIMPLIFY_M))})
    known = {r["id"] for r in rows}
    blds = []
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node" or not ("building" in t or "building:part" in t):
            continue
        r = s2.outer_ring_xy(e)
        if not r:
            continue
        c = s2.centroid_xy(r)
        if not near(ll(c), 200):
            continue
        bid = s2.building_id(t, [], c)
        ring = [ll(q) for q in r]
        blds.append({"id": bid if bid in known else "", "g": encode(simplify(ring, MAP_SIMPLIFY_M))})
    # khối trùng mã: chỉ giữ nhãn ở khối lớn nhất
    seen = set()
    for b in sorted(blds, key=lambda b: -len(b["g"])):
        if b["id"] in seen:
            b["id"] = ""
        elif b["id"]:
            seen.add(b["id"])
    bring = [ll(q) for q in bnd_xy]
    lats = [p[0] for p in bring]
    lons = [p[1] for p in bring]
    return {"bounds": [min(lats), min(lons), max(lats), max(lons)],
            "boundary": encode(simplify(bring, MAP_SIMPLIFY_M)), "roads": roads, "buildings": blds}


def main():
    rows = s2.read_csv(os.path.join(ROOT, "data", "buildings.csv"))
    if not rows:
        sys.exit("Chưa có data/buildings.csv")
    rows.sort(key=lambda r: s2._id_key(r["id"]))
    ids = [r["id"] for r in rows]
    depot = next(r["id"] for r in rows if r["is_depot"] == "1")
    print(f"{len(ids)} điểm giao, điểm xuất phát {depot}")

    modes, unreach = {}, {}
    for m in MODES:
        print(f"  Tính ma trận {m}…", flush=True)
        modes[m], unreach[m] = build_mode(m, ids)

    print("  Dựng lớp nền bản đồ…", flush=True)
    mp = build_map(s2.load_osm(), rows)

    zones = []
    for r in rows:
        if r["zone"] and r["zone"] not in zones:
            zones.append(r["zone"])
    zones.sort()
    buildings = [{
        "id": r["id"], "name": r["name"] or r["id"], "zone": r["zone"], "type": r["type"],
        "lat": float(r["lobby_lat"]), "lon": float(r["lobby_lon"]),
        "aliases": [a.strip() for a in r["aliases"].split(";") if a.strip()], "note": r["note"],
    } for r in rows]

    h = hashlib.sha1(json.dumps([ids, {m: modes[m]["dist"] for m in MODES}]).encode()).hexdigest()[:6]
    data = {
        "version": f"{datetime.now():%Y.%m.%d}-{h}", "generated": datetime.now().isoformat(timespec="seconds"),
        "depot": depot, "buildings": buildings, "zones": zones, "defaults": DEFAULTS,
        "modes": modes, "map": mp,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    txt = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(txt)
    size = len(txt.encode()) / 1e6

    # Báo cáo
    L = [f"BÁO CÁO MA TRẬN KHOẢNG CÁCH – {datetime.now():%Y-%m-%d %H:%M}", ""]
    L.append(f"Phiên bản dữ liệu: {data['version']}")
    L.append(f"Số điểm: {len(ids)} · kích thước app/data/data.json: {size:.2f} MB (giới hạn {SIZE_LIMIT_MB:.0f} MB)")
    for m in MODES:
        L.append(f"[{m}] cặp không tới được: {len(unreach[m])}" + (" – " + ", ".join(f"{a}→{b}" for a, b in unreach[m][:10]) if unreach[m] else ""))
    L.append("")
    L.append("KIỂM TRA NGẪU NHIÊN 10 CẶP (đối chiếu thực tế)")
    L.append(f"{'Từ':<8}{'Đến':<8}{'Thẳng':>8}{'Xe máy':>9}{'Về (xm)':>9}{'Đi bộ':>8}  Hệ số xe máy")
    rnd = random.Random(42)
    idx = {i: k for k, i in enumerate(ids)}
    pairs = [(depot, rnd.choice([i for i in ids if i != depot]))]
    while len(pairs) < 10:
        a, b = rnd.sample(ids, 2)
        if (a, b) not in pairs:
            pairs.append((a, b))
    pos = {r["id"]: (float(r["lobby_lat"]), float(r["lobby_lon"])) for r in rows}
    for a, b in pairs:
        i, j = idx[a], idx[b]
        st = meters(pos[a], pos[b])
        dm, dr, dw = modes["moto"]["dist"][i][j], modes["moto"]["dist"][j][i], modes["walk"]["dist"][i][j]
        L.append(f"{a:<8}{b:<8}{st:>8.0f}{dm:>9}{dr:>9}{dw:>8}  {dm / st if st else 0:.2f}")
    L.append("")
    L.append("10 CẶP XE MÁY CHÊNH LỆCH ĐI/VỀ NHIỀU NHẤT (do đường một chiều)")
    D = modes["moto"]["dist"]
    asym = sorted(((abs(D[i][j] - D[j][i]), ids[i], ids[j], D[i][j], D[j][i])
                   for i in range(len(ids)) for j in range(i + 1, len(ids))), reverse=True)[:10]
    for d, a, b, x, y in asym:
        L.append(f"  {a} → {b}: {x} m · {b} → {a}: {y} m (chênh {d} m)")
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print("\n".join(L))
    print("\nĐã lưu app/data/data.json và raw/matrix_report.txt")
    if size > SIZE_LIMIT_MB:
        print(f"CẢNH BÁO: data.json {size:.1f} MB vượt giới hạn {SIZE_LIMIT_MB} MB")


if __name__ == "__main__":
    main()
