#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Giai đoạn 3 – Dựng mạng đường (xe máy / đi bộ), gắn sảnh, kiểm tra liên thông.

Chỉ dùng thư viện chuẩn Python 3.

Cách chạy (từ thư mục gốc dự án):
    python3 pipeline/03_build_graph.py

Đầu vào:  raw/vgp_osm.json, data/buildings.csv, data/overrides.json (tự tạo mẫu nếu chưa có)
Đầu ra:   data/graph_moto.json, data/graph_walk.json, raw/graph_report.txt, raw/graph_preview.html
"""

import csv
import importlib.util
import json
import math
import os
import re
import sys
from collections import Counter, deque
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw", "vgp_osm.json")
BUILDINGS = os.path.join(ROOT, "data", "buildings.csv")
OVERRIDES = os.path.join(ROOT, "data", "overrides.json")
OUT_GRAPH = {m: os.path.join(ROOT, "data", f"graph_{m}.json") for m in ("moto", "walk")}
REPORT = os.path.join(ROOT, "raw", "graph_report.txt")
PREVIEW = os.path.join(ROOT, "raw", "graph_preview.html")


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "pipeline", fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


s2 = _load("s2", "02_build_buildings.py")   # dùng lại hình học + đọc CSV
s1 = s2.s1
xy, ll, seg_closest, inside, ring_closest = s2.xy, s2.ll, s2.seg_closest, s2.inside, s2.ring_closest

CLIP_MARGIN = 300.0      # m – lấy đường ra ngoài ranh VGP
SNAP_WARN = 50.0         # m – cảnh báo sảnh xa đường
OVR_TOL = 15.0           # m – sai số tìm đoạn khi chặn/nối theo toạ độ
NODE_MERGE = 8.0         # m – đầu lối tắt cách nút sẵn có dưới mức này thì dùng luôn nút đó
MODES = ("moto", "walk")
MODE_VI = {"moto": "Xe máy", "walk": "Đi bộ"}

NEVER = {"motorway", "motorway_link", "construction", "proposed", "abandoned", "raceway", "bus_guideway"}
MOTO_HW = set(s1.MOTO_TYPES) | {"trunk", "trunk_link"}
WALK_HW = MOTO_HW | set(s1.WALK_ONLY_TYPES)
NO_VALUES = ("no", "private")

OVERRIDES_TEMPLATE = {
    "_huong_dan": [
        "File hiệu chỉnh mạng đường. Cách dễ nhất: mở raw/graph_preview.html, bấm vào đường để chặn/đổi chiều,",
        "hoặc vẽ lối tắt, rồi bấm 'Tải overrides.json' và chép đè file này.",
        "allow_ways: danh sách mã way OSM cho phép đi bất kể tag (private, đang thi công...).",
        "oneway_overrides: {\"mã way\": \"yes\" | \"-1\" | \"no\"} – yes = một chiều theo hướng vẽ, -1 = ngược lại, no = hai chiều.",
        "block_edges: [{\"at\": [lat, lon], \"mode\": \"moto|walk|both\", \"note\": \"...\"}] chặn đoạn gần điểm,",
        "             hoặc {\"way\": mã, \"mode\": ...} chặn cả đường.",
        "add_edges: [{\"coords\": [[lat, lon], ...], \"mode\": \"moto|walk|both\", \"oneway\": false, \"note\": \"...\"}]",
    ],
    "allow_ways": [],
    "oneway_overrides": {},
    "block_edges": [],
    "add_edges": [],
}


# ---------------------------------------------------------------------------
# Mạng đường dạng danh sách đoạn (dùng chung cho 2 chế độ)
# ---------------------------------------------------------------------------

class Net:
    def __init__(self):
        self.ll = {}          # nút -> (lat, lon)
        self.xy = {}          # nút -> (x, y) mét
        self.segs = []        # dict: u, v, way, hw, name, fwd, bwd (xe máy), walk, tag (base/add/conn_*), alive
        self.n_virtual = 0

    def node(self, nid, latlon):
        if nid not in self.ll:
            self.ll[nid] = latlon
            self.xy[nid] = xy(latlon)
        return nid

    def new_node(self, latlon):
        self.n_virtual += 1
        return self.node(f"v{self.n_virtual}", latlon)

    def add(self, u, v, **a):
        s = dict(u=u, v=v, way=None, hw="", name="", fwd=False, bwd=False, walk=False,
                 tag="base", alive=True, blocked="")
        s.update(a)
        self.segs.append(s)
        return s

    def length(self, s):
        a, b = self.xy[s["u"]], self.xy[s["v"]]
        return math.hypot(b[0] - a[0], b[1] - a[1])

    def usable(self, s, mode):
        if not s["alive"]:
            return False
        return (s["fwd"] or s["bwd"]) if mode == "moto" else s["walk"]

    def nearest(self, p, pred, maxd=1e18):
        """Đoạn gần điểm p (x,y) nhất thoả pred; trả (seg, điểm chiếu, khoảng cách)."""
        best = (None, None, maxd)
        for s in self.segs:
            if not s["alive"] or not pred(s):
                continue
            a, b = self.xy[s["u"]], self.xy[s["v"]]
            d0 = best[2]
            if min(a[0], b[0]) - d0 > p[0] or max(a[0], b[0]) + d0 < p[0] or \
                    min(a[1], b[1]) - d0 > p[1] or max(a[1], b[1]) + d0 < p[1]:
                continue
            q, d = seg_closest(p, a, b)
            if d < best[2]:
                best = (s, q, d)
        return best

    def split(self, s, q):
        """Chèn nút tại điểm q trên đoạn s; trả về nút (dùng đầu mút nếu q quá gần)."""
        a, b = self.xy[s["u"]], self.xy[s["v"]]
        if math.hypot(q[0] - a[0], q[1] - a[1]) < 1.0:
            return s["u"]
        if math.hypot(q[0] - b[0], q[1] - b[1]) < 1.0:
            return s["v"]
        n = self.new_node(ll(q))
        s["alive"] = False
        base = {k: v for k, v in s.items() if k not in ("u", "v", "alive")}
        self.add(s["u"], n, **base)
        self.add(n, s["v"], **base)
        return n


# ---------------------------------------------------------------------------
# Phân loại đường
# ---------------------------------------------------------------------------

def classify(t, allowed):
    """Trả (moto_ok, walk_ok, lý do bị loại)."""
    hw = t.get("highway", "")
    if allowed:
        return hw not in s1.WALK_ONLY_TYPES or hw == "cycleway", True, ""
    if hw in NEVER:
        return False, False, f"highway={hw}"
    if t.get("area") == "yes":
        return False, False, "area=yes"
    acc = t.get("access", "")
    moto = hw in MOTO_HW and t.get("service") != "parking_aisle"
    walk = hw in WALK_HW
    why = []
    if hw not in WALK_HW:
        why.append(f"highway={hw}")
    if t.get("service") == "parking_aisle":
        why.append("lối trong bãi xe")
    if acc in NO_VALUES:
        moto = moto and t.get("motorcycle") in ("yes", "permissive", "destination")
        walk = walk and t.get("foot") in ("yes", "permissive", "designated", "destination")
        why.append(f"access={acc}")
    for k in ("motorcycle", "motor_vehicle", "vehicle"):
        if t.get(k) in NO_VALUES:
            moto = False
            why.append(f"{k}={t[k]}")
    if t.get("foot") in NO_VALUES:
        walk = False
        why.append(f"foot={t['foot']}")
    return moto, walk, ", ".join(why)


def oneway_dir(t, ovr):
    """1 = theo hướng vẽ, -1 = ngược, 0 = hai chiều."""
    v = (ovr if ovr is not None else t.get("oneway", "")).lower()
    if v in ("yes", "true", "1"):
        return 1
    if v == "-1" or v == "reverse":
        return -1
    if v in ("no", "false", "0"):
        return 0
    if t.get("junction") in ("roundabout", "circular"):
        return 1
    return 0


# ---------------------------------------------------------------------------
# Dựng
# ---------------------------------------------------------------------------

def load_overrides():
    if not os.path.exists(OVERRIDES):
        with open(OVERRIDES, "w", encoding="utf-8") as f:
            json.dump(OVERRIDES_TEMPLATE, f, ensure_ascii=False, indent=2)
        print("Đã tạo mẫu data/overrides.json")
    with open(OVERRIDES, encoding="utf-8") as f:
        o = json.load(f)
    for k, v in OVERRIDES_TEMPLATE.items():
        if k not in o:
            o[k] = json.loads(json.dumps(v))
    return o


def mode_set(m):
    m = (m or "both").lower()
    if m not in ("moto", "walk", "both"):
        raise ValueError(f"mode không hợp lệ: {m!r}")
    return ("moto", "walk") if m == "both" else (m,)


def build(els, rows, ovr, log):
    bnd = next(e for e in els if e["type"] == "way" and e.get("tags", {}).get("name") == "Vinhomes Grand Park"
               and e.get("tags", {}).get("landuse") == "residential")
    bnd_xy = s2.outer_ring_xy(bnd)

    def in_clip(latlon):
        p = xy(latlon)
        return inside(p, bnd_xy) or ring_closest(p, bnd_xy)[1] <= CLIP_MARGIN

    allow = {int(w) for w in ovr.get("allow_ways", [])}
    ow_ovr = {int(k): str(v) for k, v in ovr.get("oneway_overrides", {}).items()}
    net = Net()
    excluded = []   # đường bị loại (để hiển thị)
    used_ways = set()
    for e in els:
        t = e.get("tags", {})
        if e["type"] != "way" or "highway" not in t or not e.get("geometry"):
            continue
        g = [(p["lat"], p["lon"]) for p in e["geometry"]]
        if not any(in_clip(p) for p in g):
            continue
        moto, walk, why = classify(t, e["id"] in allow)
        if not moto and not walk:
            excluded.append({"way": e["id"], "hw": t.get("highway"), "nm": t.get("name", ""), "why": why,
                             "g": [[round(a, 6), round(b, 6)] for a, b in g]})
            continue
        d = oneway_dir(t, ow_ovr.get(e["id"])) if moto else 0
        ids = e["nodes"]
        for i in range(len(ids) - 1):
            u = net.node(ids[i], g[i])
            v = net.node(ids[i + 1], g[i + 1])
            if u == v:
                continue
            net.add(u, v, way=e["id"], hw=t["highway"], name=t.get("name", ""),
                    fwd=moto and d >= 0, bwd=moto and d <= 0, walk=walk,
                    oneway=d != 0 and moto)
        used_ways.add(e["id"])

    # --- add_edges
    for k, ae in enumerate(ovr.get("add_edges", [])):
        try:
            modes = mode_set(ae.get("mode"))
            coords = [tuple(map(float, c)) for c in ae["coords"]]
            assert len(coords) >= 2
        except Exception as ex:
            log.append(f"LỖI add_edges[{k}]: dữ liệu không hợp lệ ({ex})")
            continue
        nodes = []
        for j, c in enumerate(coords):
            p = xy(c)
            if j in (0, len(coords) - 1):
                # đầu mút: nối vào mạng sẵn có
                nid = min(((n, math.hypot(q[0] - p[0], q[1] - p[1])) for n, q in net.xy.items()
                           if not str(n).startswith("L:")), key=lambda x: x[1], default=(None, 1e18))
                if nid[1] <= NODE_MERGE:
                    nodes.append(nid[0])
                    continue
                s, q, d = net.nearest(p, lambda s: s["tag"] in ("base", "add"), OVR_TOL)
                if s:
                    nodes.append(net.split(s, q))
                    continue
                log.append(f"CẢNH BÁO add_edges[{k}] ({ae.get('note', '')}): đầu mút {j} không chạm đường nào trong {OVR_TOL:.0f} m")
            nodes.append(net.new_node(c))
        one = bool(ae.get("oneway"))
        for j in range(len(nodes) - 1):
            net.add(nodes[j], nodes[j + 1], way=None, hw="lối thêm tay", name=ae.get("note", ""),
                    fwd="moto" in modes, bwd="moto" in modes and not one, walk="walk" in modes,
                    tag="add", oneway=one and "moto" in modes, ovr_index=k)

    # --- block_edges
    for k, be in enumerate(ovr.get("block_edges", [])):
        try:
            modes = mode_set(be.get("mode"))
        except Exception as ex:
            log.append(f"LỖI block_edges[{k}]: {ex}")
            continue
        targets = []
        if "way" in be:
            targets = [s for s in net.segs if s["alive"] and s["way"] == int(be["way"])]
        elif "at" in be:
            s, q, d = net.nearest(xy(tuple(map(float, be["at"]))),
                                  lambda s: s["tag"] in ("base", "add"), OVR_TOL)
            targets = [s] if s else []
        if not targets:
            log.append(f"CẢNH BÁO block_edges[{k}] ({be.get('note', '')}): không tìm thấy đoạn đường để chặn")
        for s in targets:
            if "moto" in modes:
                s["fwd"] = s["bwd"] = False
            if "walk" in modes:
                s["walk"] = False
            s["blocked"] = "+".join(modes)
            s["ovr_block"] = k

    # --- Gắn sảnh
    lob = {}
    for r in rows:
        try:
            latlon = (float(r["lobby_lat"]), float(r["lobby_lon"]))
        except ValueError:
            log.append(f"LỖI {r['id']}: toạ độ sảnh không hợp lệ")
            continue
        L = net.node("L:" + r["id"], latlon)
        info = {"id": r["id"], "ll": latlon, "depot": r["is_depot"] == "1", "snap": {}}
        for m in MODES:
            s, q, d = net.nearest(xy(latlon), lambda s, m=m: net.usable(s, m) and s["tag"] in ("base", "add"))
            if not s:
                info["snap"][m] = None
                continue
            n = net.split(s, q)
            a = dict(fwd=True, bwd=True, walk=False) if m == "moto" else dict(fwd=False, bwd=False, walk=True)
            net.add(L, n, hw="nối sảnh", tag="conn_" + m, **a)
            info["snap"][m] = {"node": n, "d": round(d, 1), "ll": [round(v, 7) for v in net.ll[n]]}
            if m == "walk":
                # Người đi bộ cũng ra được đường xe: nối thêm vào đường xe gần nhất,
                # tránh trường hợp lối bộ gần nhất là nhánh cụt phải đi vòng xa
                s2_, q2, d2 = net.nearest(xy(latlon), lambda s: s["walk"] and (s["fwd"] or s["bwd"])
                                          and s["alive"] and s["tag"] in ("base", "add"))
                if s2_ and s2_ is not s:
                    n2 = net.split(s2_, q2)
                    if n2 != n:
                        net.add(L, n2, hw="nối sảnh", tag="conn_walk", **a)
        lob[r["id"]] = info
    return net, lob, excluded, bnd_xy


# ---------------------------------------------------------------------------
# Đồ thị theo chế độ + liên thông
# ---------------------------------------------------------------------------

def directed_edges(net, mode):
    out = []
    for s in net.segs:
        if not s["alive"]:
            continue
        if s["tag"].startswith("conn_") and s["tag"] != "conn_" + mode:
            continue
        w = net.length(s)
        if mode == "moto":
            if s["fwd"]:
                out.append((s["u"], s["v"], w))
            if s["bwd"]:
                out.append((s["v"], s["u"], w))
        elif s["walk"]:
            out.append((s["u"], s["v"], w))
            out.append((s["v"], s["u"], w))
    return out


def reach(edges, start, reverse=False):
    adj = {}
    for u, v, _ in edges:
        if reverse:
            u, v = v, u
        adj.setdefault(u, []).append(v)
    seen = {start}
    dq = deque([start])
    while dq:
        u = dq.popleft()
        for v in adj.get(u, ()):
            if v not in seen:
                seen.add(v)
                dq.append(v)
    return seen


def export_graph(net, lob, edges, mode, depot):
    used = sorted({u for u, v, _ in edges} | {v for u, v, _ in edges}, key=str)
    idx = {n: i for i, n in enumerate(used)}
    return {
        "mode": mode, "generated": datetime.now().isoformat(timespec="seconds"), "depot": depot,
        "nodes": [[round(net.ll[n][0], 7), round(net.ll[n][1], 7)] for n in used],
        "edges": [[idx[u], idx[v], round(w, 1)] for u, v, w in edges],
        "lobbies": {i: idx["L:" + i] for i in lob if "L:" + i in idx},
    }


# ---------------------------------------------------------------------------

def main():
    els = s2.load_osm()
    rows = s2.read_csv(BUILDINGS)
    if not rows:
        sys.exit("Chưa có data/buildings.csv – làm Giai đoạn 2 trước.")
    depot = next((r["id"] for r in rows if r["is_depot"] == "1"), None)
    if not depot:
        sys.exit("buildings.csv không có điểm xuất phát (is_depot=1).")
    ovr = load_overrides()
    log = []
    net, lob, excluded, bnd_xy = build(els, rows, ovr, log)

    res = {}
    for m in MODES:
        E = directed_edges(net, m)
        start = "L:" + depot
        fw, bw = reach(E, start), reach(E, start, reverse=True)
        bad = []
        for i, info in lob.items():
            L = "L:" + i
            if info["snap"][m] is None:
                bad.append((i, "không có đường nào để gắn"))
            elif L not in fw and L not in bw:
                bad.append((i, f"không tới được từ {depot} và không về được {depot}"))
            elif L not in fw:
                bad.append((i, f"không tới được từ {depot}"))
            elif L not in bw:
                bad.append((i, f"không về được {depot}"))
        res[m] = {"edges": E, "bad": bad, "fw": fw, "bw": bw}
        with open(OUT_GRAPH[m], "w", encoding="utf-8") as f:
            json.dump(export_graph(net, lob, E, m, depot), f, ensure_ascii=False, separators=(",", ":"))

    write_report(net, lob, res, excluded, ovr, log, depot)
    write_preview(net, lob, res, excluded, ovr, depot)

    print(open(REPORT, encoding="utf-8").read().split("\n\nCHI TIẾT")[0])
    print(f"\nĐã lưu data/graph_moto.json, data/graph_walk.json, raw/graph_report.txt, raw/graph_preview.html")
    ok = all(not res[m]["bad"] for m in MODES)
    print("\nKẾT QUẢ: " + ("ĐẠT – không còn sảnh bị cô lập" if ok else "CHƯA ĐẠT – xem danh sách sảnh bị cô lập"))
    sys.exit(0 if ok else 1)


def write_report(net, lob, res, excluded, ovr, log, depot):
    L = [f"BÁO CÁO MẠNG ĐƯỜNG – {datetime.now():%Y-%m-%d %H:%M}", ""]
    alive = [s for s in net.segs if s["alive"] and s["tag"] in ("base", "add")]
    km = lambda ss: sum(net.length(s) for s in ss) / 1000
    m2 = [s for s in alive if s["fwd"] and s["bwd"]]
    m1 = [s for s in alive if s["fwd"] != s["bwd"]]
    wk = [s for s in alive if s["walk"]]
    L.append(f"Đường xe máy: {km(m2) + km(m1):.1f} km (một chiều {km(m1):.1f} km) · Đường đi bộ: {km(wk):.1f} km")
    L.append(f"Hiệu chỉnh tay: allow_ways={len(ovr['allow_ways'])}, oneway_overrides={len(ovr['oneway_overrides'])}, "
             f"block_edges={len(ovr['block_edges'])}, add_edges={len(ovr['add_edges'])}")
    L.append("")
    for m in MODES:
        E, bad = res[m]["edges"], res[m]["bad"]
        L.append(f"[{MODE_VI[m]}] {len(E)} cạnh có hướng · sảnh liên thông: {len(lob) - len(bad)}/{len(lob)}"
                 + (f" · CÔ LẬP {len(bad)}" if bad else " · sạch"))
        for i, why in bad:
            L.append(f"    - {i}: {why}")
    L.append("")
    far = [(i, m, info["snap"][m]["d"]) for i, info in lob.items() for m in MODES
           if info["snap"][m] and info["snap"][m]["d"] > SNAP_WARN]
    L.append(f"Sảnh cách đường > {SNAP_WARN:.0f} m: {len(far)}")
    for i, m, d in far:
        L.append(f"    - {i} ({MODE_VI[m]}): {d} m")
    if log:
        L.append("")
        L.append("Ghi chú khi áp dụng overrides.json:")
        L += ["    - " + x for x in log]
    L.append("")
    L.append("CHI TIẾT KHOẢNG CÁCH GẮN SẢNH (m)")
    L.append(f"{'Mã':<10}{'Xe máy':>8}{'Đi bộ':>8}")
    for i, info in lob.items():
        f = lambda m: f"{info['snap'][m]['d']:.1f}" if info["snap"][m] else "—"
        L.append(f"{i:<10}{f('moto'):>8}{f('walk'):>8}")
    L.append("")
    L.append(f"Đường bị loại khỏi mạng (trong phạm vi): {len(excluded)}")
    for k, c in Counter(x["why"] or x["hw"] for x in excluded).most_common():
        L.append(f"    - {k}: {c}")
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def write_preview(net, lob, res, excluded, ovr, depot):
    # Gom các đoạn liên tiếp cùng way + cùng trạng thái thành một đường
    def state(s):
        if s["blocked"] and not (s["fwd"] or s["bwd"] or s["walk"]):
            return "blocked"
        if s["fwd"] and s["bwd"]:
            st = "m2"
        elif s["fwd"] or s["bwd"]:
            st = "m1"
        elif s["walk"]:
            st = "walk"
        else:
            st = "blocked"
        return st

    runs = []
    cur = None
    for s in net.segs:
        if not s["alive"] or s["tag"].startswith("conn_"):
            continue
        st = state(s)
        a, b = (s["u"], s["v"]) if not (st == "m1" and s["bwd"]) else (s["v"], s["u"])
        key = (s["way"], st, s["tag"], s.get("ovr_index"), s.get("ovr_block"), s["blocked"], s["walk"])
        if cur and cur["key"] == key and cur["last"] == a:
            cur["g"].append(net.ll[b])
            cur["last"] = b
        else:
            cur = {"key": key, "last": b, "g": [net.ll[a], net.ll[b]], "st": st, "way": s["way"],
                   "hw": s["hw"], "nm": s["name"], "tag": s["tag"], "walk": s["walk"],
                   "blk": s["blocked"], "ow": bool(s.get("oneway")), "oi": s.get("ovr_index"),
                   "ob": s.get("ovr_block"), "rev": st == "m1" and s["bwd"]}
            runs.append(cur)
    roads = [{"st": r["st"], "way": r["way"], "hw": r["hw"], "nm": r["nm"], "tag": r["tag"], "wk": r["walk"],
              "blk": r["blk"], "ow": r["ow"], "oi": r["oi"], "ob": r["ob"], "rev": r["rev"], "g": [[round(a, 6), round(b, 6)] for a, b in r["g"]]} for r in runs]
    lobbies = []
    for i, info in lob.items():
        lobbies.append({
            "id": i, "ll": [round(v, 7) for v in info["ll"]], "depot": info["depot"],
            "snap": {m: (info["snap"][m]["ll"] if info["snap"][m] else None) for m in MODES},
            "d": {m: (info["snap"][m]["d"] if info["snap"][m] else None) for m in MODES},
            "bad": {m: next((w for j, w in res[m]["bad"] if j == i), "") for m in MODES},
        })
    data = {"roads": roads, "excluded": excluded, "lobbies": lobbies, "depot": depot,
            "overrides": ovr, "stats": {m: len(res[m]["bad"]) for m in MODES}}
    tpl_path = os.path.join(ROOT, "pipeline", "graph_preview_template.html")
    with open(tpl_path, encoding="utf-8") as f:
        html = f.read()
    with open(PREVIEW, "w", encoding="utf-8") as f:
        f.write(html.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False, separators=(",", ":"))))


if __name__ == "__main__":
    main()
