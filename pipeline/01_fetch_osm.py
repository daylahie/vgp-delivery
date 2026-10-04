#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Giai đoạn 1 – Tải và kiểm tra dữ liệu OpenStreetMap cho Vinhomes Grand Park.

Chỉ dùng thư viện chuẩn của Python 3 (không cần pip install).

Cách chạy (từ thư mục gốc dự án):
    python3 pipeline/01_fetch_osm.py
    python3 pipeline/01_fetch_osm.py --bbox 10.828,106.820,10.860,106.860
    python3 pipeline/01_fetch_osm.py --from-file      # dựng lại báo cáo/preview từ raw/vgp_osm.json, không tải lại

Đầu ra:
    raw/vgp_osm.json    – dữ liệu thô từ Overpass
    raw/vgp_report.txt  – thống kê
    raw/preview.html    – bản đồ xem nhanh (cần mạng để tải nền bản đồ OSM và Leaflet)
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime

# ---------------------------------------------------------------------------
# Cấu hình
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "raw")

# Khung bao mặc định (nam, tây, bắc, đông) – cần xác nhận lại trên preview
DEFAULT_BBOX = (10.828, 106.820, 10.860, 106.860)

# Các máy chủ Overpass, thử lần lượt nếu máy trước lỗi
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

DEPOT_ID = "S3.03"

# Phân loại đường theo đặc tả Giai đoạn 3
MOTO_TYPES = {
    "primary", "secondary", "tertiary", "residential", "unclassified",
    "living_street", "service",
    "primary_link", "secondary_link", "tertiary_link",
    # trunk không có trong đặc tả nhưng xe máy đi được – đánh dấu riêng để người dùng quyết
}
WALK_ONLY_TYPES = {"footway", "path", "pedestrian", "steps", "cycleway"}

NAME_KEYS = ["name", "ref", "addr:housename", "addr:housenumber",
             "name:vi", "name:en", "alt_name", "short_name", "loc_name"]

# Mã tòa kiểu S3.03, S303, S3-03, GH1, BS15... -> tiền tố chữ + số khối + (số tòa)
CODE_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{1,3})\s?(\d{1,2})(?:[.\-_ ]?(\d{2}))?(?![0-9])")


# ---------------------------------------------------------------------------
# Tải dữ liệu
# ---------------------------------------------------------------------------

def build_query(bbox):
    s, w, n, e = bbox
    b = f"({s},{w},{n},{e})"
    return f"""
[out:json][timeout:180];
(
  way["highway"]{b};
  way["building"]{b};
  relation["building"]{b};
  way["building:part"]{b};
  node["building"]{b};
  node["entrance"]{b};
  way["landuse"="residential"]{b};
  relation["landuse"="residential"]{b};
  way["place"]["name"]{b};
  relation["place"]["name"]{b};
  nwr["name"~"Vinhomes|Grand Park|Rainbow|Origami|Beverly|Glory|Masteri|Lumi",i]{b};
  node["addr:housename"]{b};
  node["name"~"^ *(Tòa|Toa|Block)? *[A-Za-z]{{1,3}} ?[0-9]",i]{b};
);
out body geom;
""".strip()


def _post_urllib(url, data, timeout):
    req = urllib.request.Request(
        url, data=data,
        headers={"User-Agent": "vgp-delivery-personal/0.1 (offline route planner)",
                 "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _post_curl(url, data, timeout):
    # Dự phòng cho Python trên macOS bị lỗi chứng chỉ SSL
    if not shutil.which("curl"):
        raise RuntimeError("không có curl")
    out = subprocess.run(
        ["curl", "-sS", "--fail", "-m", str(timeout), "-A", "vgp-delivery-personal/0.1",
         "--data-binary", "@-", url],
        input=data, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode("utf-8", "replace").strip())
    return out.stdout


def fetch_overpass(query, timeout=240):
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    errors = []
    for url in OVERPASS_ENDPOINTS:
        for method in (_post_urllib, _post_curl):
            try:
                print(f"  → {url} ({'urllib' if method is _post_urllib else 'curl'})…", flush=True)
                t0 = time.time()
                body = method(url, data, timeout)
                js = json.loads(body)
                if "elements" not in js:
                    raise RuntimeError("phản hồi không có 'elements'")
                if js.get("remark"):
                    print(f"    Ghi chú từ Overpass: {js['remark']}")
                print(f"    OK – {len(js['elements'])} phần tử, {len(body)/1e6:.1f} MB, {time.time()-t0:.0f}s")
                return js
            except Exception as ex:  # thử phương án kế tiếp
                msg = f"{url} [{method.__name__}]: {ex}"
                print(f"    Lỗi: {ex}")
                errors.append(msg)
                # Lỗi SSL của urllib -> thử curl; lỗi khác cũng thử curl cho chắc
        time.sleep(2)
    raise SystemExit("Không tải được từ Overpass:\n  " + "\n  ".join(errors))


# ---------------------------------------------------------------------------
# Phân tích
# ---------------------------------------------------------------------------

def normalize_code(text):
    """Trả về danh sách mã tòa chuẩn hóa tìm thấy trong chuỗi, vd 'S303' -> 'S3.03'."""
    out = []
    for m in CODE_RE.finditer(text or ""):
        pre, blk, num = m.group(1).upper(), m.group(2), m.group(3)
        out.append(f"{pre}{int(blk)}.{num}" if num else f"{pre}{int(blk)}")
    return out


def element_label(tags):
    for k in NAME_KEYS:
        if tags.get(k):
            return tags[k]
    return ""


def element_codes(tags):
    codes = []
    for k in NAME_KEYS:
        if k == "addr:housenumber":
            continue  # số nhà thường không phải mã tòa; vẫn hiển thị ở danh sách tên
        for c in normalize_code(tags.get(k, "")):
            if c not in codes:
                codes.append(c)
    return codes


def geom_of(el):
    """Trả về danh sách các vòng/đường [(lat, lon), ...]."""
    if el["type"] == "node":
        return [[(el["lat"], el["lon"])]]
    if el["type"] == "way":
        g = el.get("geometry") or []
        return [[(p["lat"], p["lon"]) for p in g if p]]
    if el["type"] == "relation":
        rings = []
        for m in el.get("members", []):
            if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry"):
                rings.append([(p["lat"], p["lon"]) for p in m["geometry"] if p])
        return rings
    return []


def centroid(rings):
    pts = [p for r in rings for p in r]
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def is_oneway(tags):
    ow = tags.get("oneway", "").lower()
    if ow in ("yes", "true", "1", "-1", "reversible"):
        return True
    if ow in ("no", "false", "0"):
        return False
    return tags.get("junction") in ("roundabout", "circular") or tags.get("highway") == "motorway"


def road_class(hw):
    if hw in MOTO_TYPES:
        return "moto"
    if hw in WALK_ONLY_TYPES:
        return "walk"
    return "other"


def analyze(osm, bbox):
    els = osm["elements"]
    roads, buildings, entrances, areas, others = [], [], [], [], []
    for el in els:
        t = el.get("tags", {})
        if el["type"] == "way" and "highway" in t:
            roads.append(el)
        elif "building" in t or "building:part" in t:
            buildings.append(el)
        elif el["type"] == "node" and "entrance" in t:
            entrances.append(el)
        elif t.get("landuse") == "residential" or "place" in t:
            areas.append(el)
        else:
            others.append(el)
    return {"roads": roads, "buildings": buildings, "entrances": entrances,
            "areas": areas, "others": others, "bbox": bbox, "meta": osm.get("osm3s", {})}


# ---------------------------------------------------------------------------
# Báo cáo
# ---------------------------------------------------------------------------

def write_report(A, path):
    L = []
    p = L.append
    s, w, n, e = A["bbox"]
    p("BÁO CÁO DỮ LIỆU OSM – VINHOMES GRAND PARK")
    p(f"Tạo lúc: {datetime.now():%Y-%m-%d %H:%M}")
    p(f"Khung bao: lat {s}–{n}, lon {w}–{e}")
    if A["meta"].get("timestamp_osm_base"):
        p(f"Dữ liệu OSM tính đến: {A['meta']['timestamp_osm_base']}")
    p("")

    # --- Đường
    roads = A["roads"]
    by_type = Counter(r["tags"]["highway"] for r in roads)
    ow = [r for r in roads if is_oneway(r["tags"])]
    acc = [r for r in roads if r["tags"].get("access") in ("no", "private")
           or r["tags"].get("motorcycle") in ("no", "private")
           or r["tags"].get("motor_vehicle") in ("no", "private")]
    p("=" * 60)
    p(f"1. ĐƯỜNG: {len(roads)} đoạn (way)")
    p("=" * 60)
    p(f"{'Loại highway':<22}{'Số đoạn':>8}{'Dài (km)':>10}  Nhóm")
    lens = defaultdict(float)
    for r in roads:
        g = geom_of(r)[0]
        lens[r["tags"]["highway"]] += sum(_dist(g[i], g[i + 1]) for i in range(len(g) - 1))
    grp = {"moto": "xe máy + đi bộ", "walk": "chỉ đi bộ", "other": "KHÁC – cần xem"}
    for hw, c in by_type.most_common():
        p(f"{hw:<22}{c:>8}{lens[hw]/1000:>10.2f}  {grp[road_class(hw)]}")
    p("")
    p(f"Đường một chiều (oneway / bùng binh): {len(ow)} đoạn")
    for hw, c in Counter(r["tags"]["highway"] for r in ow).most_common():
        p(f"   - {hw}: {c}")
    p(f"Đoạn bị cấm (access/motorcycle/motor_vehicle = no/private): {len(acc)}")
    for r in acc[:30]:
        t = r["tags"]
        p(f"   - way {r['id']}: {t.get('highway')} {t.get('name','')} "
          f"access={t.get('access','-')} motorcycle={t.get('motorcycle','-')}")
    named_roads = sorted({r["tags"]["name"] for r in roads if r["tags"].get("name")})
    p(f"Tên đường có trong dữ liệu ({len(named_roads)}): " + ", ".join(named_roads[:80]))
    p("")

    # --- Tòa nhà
    B = A["buildings"]
    named, unnamed = [], []
    for b in B:
        (named if element_label(b.get("tags", {})) else unnamed).append(b)
    btype = Counter(b["tags"].get("building", "building:part") for b in B)
    p("=" * 60)
    p(f"2. TÒA NHÀ: {len(B)} đối tượng – có tên/mã: {len(named)}, không tên: {len(unnamed)}")
    p("=" * 60)
    p("Theo loại building: " + ", ".join(f"{k}={v}" for k, v in btype.most_common()))
    p(f"Theo kiểu OSM: " + ", ".join(f"{k}={v}" for k, v in Counter(b['type'] for b in B).most_common()))
    lv = [b for b in B if b["tags"].get("building:levels")]
    p(f"Có số tầng (building:levels): {len(lv)}")
    tall = [b for b in B if _to_int(b["tags"].get("building:levels")) >= 10]
    p(f"Tòa cao ≥10 tầng: {len(tall)} (trong đó không tên: "
      f"{sum(1 for b in tall if not element_label(b['tags']))})")
    p("")

    # Gom theo mã chuẩn hóa
    code_map = defaultdict(list)
    no_code = []
    for b in named:
        cs = element_codes(b["tags"])
        if cs:
            for c in cs:
                code_map[c].append(b)
        else:
            no_code.append(b)
    p(f"Mã tòa nhận diện được: {len(code_map)}")
    by_prefix = defaultdict(list)
    for c in code_map:
        by_prefix[re.match(r"[A-Z]+", c).group(0)].append(c)
    for pre in sorted(by_prefix):
        codes = sorted(by_prefix[pre], key=_code_key)
        p(f"   [{pre}] ({len(codes)}): " + ", ".join(codes))
    dup = {c: v for c, v in code_map.items() if len(v) > 1}
    if dup:
        p(f"Mã xuất hiện ở nhiều đối tượng (có thể là building:part hoặc trùng): "
          + ", ".join(f"{c}×{len(v)}" for c, v in sorted(dup.items())))
    p("")
    p(f"Tên không khớp mẫu mã tòa ({len(no_code)}):")
    for b in sorted(no_code, key=lambda x: element_label(x["tags"]))[:150]:
        p(f"   - {b['type']} {b['id']}: {element_label(b['tags'])!r}"
          f"  (building={b['tags'].get('building', '-')})")
    p("")

    # --- Depot
    p("=" * 60)
    p(f"3. ĐIỂM XUẤT PHÁT {DEPOT_ID}")
    p("=" * 60)
    hits = code_map.get(DEPOT_ID, [])
    # tìm thêm trong mọi phần tử (node POI, khu vực…)
    for el in A["others"] + A["areas"] + A["entrances"]:
        if DEPOT_ID in element_codes(el.get("tags", {})):
            hits.append(el)
    if hits:
        p(f"TÌM THẤY {DEPOT_ID}: {len(hits)} đối tượng")
        for el in hits:
            c = centroid(geom_of(el))
            p(f"   - {el['type']} {el['id']} tại {c[0]:.6f},{c[1]:.6f} tags={el.get('tags')}")
    else:
        p(f"KHÔNG tìm thấy {DEPOT_ID} trong dữ liệu OSM → sẽ phải ghim tay ở Giai đoạn 2.")
    p("")

    # --- Lối vào
    E = A["entrances"]
    p("=" * 60)
    p(f"4. LỐI VÀO (entrance): {len(E)} node")
    p("=" * 60)
    p("Theo loại: " + ", ".join(f"{k}={v}" for k, v in Counter(x['tags']['entrance'] for x in E).most_common()))
    p("")

    # --- Khu vực
    p("=" * 60)
    p(f"5. KHU VỰC / PHÂN KHU có tên: {len(A['areas'])}")
    p("=" * 60)
    for a in sorted(A["areas"], key=lambda x: x["tags"].get("name", "")):
        t = a["tags"]
        p(f"   - {a['type']} {a['id']}: {t.get('name','(không tên)')!r} "
          f"landuse={t.get('landuse','-')} place={t.get('place','-')}")
    vg = [el for el in A["areas"] + A["others"] + A["buildings"]
          if re.search(r"Vinhomes|Grand Park", el.get("tags", {}).get("name", ""), re.I)]
    p(f"Đối tượng mang tên Vinhomes/Grand Park: {len(vg)}")
    for el in vg[:30]:
        p(f"   - {el['type']} {el['id']}: {el['tags'].get('name')!r}")
    p("")
    p(f"Phần tử khác (POI có tên, v.v.): {len(A['others'])}")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    return "\n".join(L)


def _to_int(v):
    try:
        return int(float(str(v).split(";")[0]))
    except Exception:
        return 0


def _code_key(c):
    m = re.match(r"([A-Z]+)(\d+)(?:\.(\d+))?", c)
    return (m.group(1), int(m.group(2)), int(m.group(3) or 0))


def _dist(a, b):
    # khoảng cách xấp xỉ (m) – đủ cho thống kê
    import math
    R = 6371000
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    x = (lo2 - lo1) * math.cos((la1 + la2) / 2)
    y = la2 - la1
    return R * math.hypot(x, y)


# ---------------------------------------------------------------------------
# Preview HTML
# ---------------------------------------------------------------------------

def _r(v):
    return round(v, 6)


def write_preview(A, path):
    feats = {"roads": [], "buildings": [], "entrances": [], "areas": []}
    for r in A["roads"]:
        t = r["tags"]
        feats["roads"].append({
            "id": r["id"], "c": road_class(t["highway"]), "hw": t["highway"],
            "ow": is_oneway(t), "nm": t.get("name", ""),
            "acc": t.get("access", ""), "g": [[_r(a), _r(b)] for a, b in geom_of(r)[0]]})
    for b in A["buildings"]:
        t = b.get("tags", {})
        rings = geom_of(b)
        c = centroid(rings)
        if not c:
            continue
        codes = element_codes(t)
        feats["buildings"].append({
            "id": f"{b['type'][0]}{b['id']}", "nm": element_label(t), "codes": codes,
            "lv": t.get("building:levels", ""), "bt": t.get("building", "part"),
            "depot": DEPOT_ID in codes,
            "c": [_r(c[0]), _r(c[1])],
            "g": [[[_r(a), _r(o)] for a, o in ring] for ring in rings] if b["type"] != "node" else None})
    for e in A["entrances"]:
        feats["entrances"].append({"id": e["id"], "t": e["tags"].get("entrance"),
                                   "c": [_r(e["lat"]), _r(e["lon"])]})
    for a in A["areas"]:
        rings = geom_of(a)
        if rings and len(rings[0]) > 2:
            feats["areas"].append({"id": a["id"], "nm": a["tags"].get("name", ""),
                                   "g": [[[_r(x), _r(y)] for x, y in ring] for ring in rings]})
    stats = {
        "roads": len(A["roads"]), "buildings": len(A["buildings"]),
        "named": sum(1 for b in feats["buildings"] if b["nm"]),
        "entrances": len(A["entrances"]),
        "depot": any(b["depot"] for b in feats["buildings"]),
    }
    html = PREVIEW_TEMPLATE.replace("__DATA__", json.dumps(feats, ensure_ascii=False, separators=(",", ":"))) \
        .replace("__BBOX__", json.dumps(list(A["bbox"]))) \
        .replace("__STATS__", json.dumps(stats)) \
        .replace("__DEPOT__", DEPOT_ID)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


PREVIEW_TEMPLATE = r"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VGP – Xem trước dữ liệu OSM</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
 html,body{margin:0;height:100%;font:14px -apple-system,system-ui,sans-serif}
 #map{position:absolute;inset:0}
 .panel{position:absolute;z-index:1000;top:10px;right:10px;background:#fff;padding:10px 12px;
   border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:290px;max-height:90vh;overflow:auto}
 .panel h3{margin:0 0 6px;font-size:15px}
 .panel label{display:block;margin:3px 0;cursor:pointer}
 .sw{display:inline-block;width:14px;height:10px;margin-right:6px;vertical-align:middle;border:1px solid #0003}
 .stat{color:#444;font-size:12px;margin:6px 0}
 input[type=search]{width:100%;box-sizing:border-box;padding:5px;margin:6px 0}
 .lbl{background:none;border:none;box-shadow:none;font-weight:600;font-size:11px;color:#222;
   text-shadow:0 0 3px #fff,0 0 3px #fff}
 .lbl:before{display:none}
 .bad{color:#c00;font-weight:600}.ok{color:#080;font-weight:600}
</style></head><body>
<div id="map"></div>
<div class="panel">
 <h3>Dữ liệu OSM – VGP</h3>
 <div class="stat" id="stat"></div>
 <input type="search" id="q" placeholder="Tìm mã tòa, vd S3.03">
 <b>Tòa nhà</b>
 <label><input type="checkbox" id="l_named" checked><span class="sw" style="background:#2b7de9"></span>Có tên/mã</label>
 <label><input type="checkbox" id="l_unnamed" checked><span class="sw" style="background:#f39c12"></span>Không tên</label>
 <label><input type="checkbox" id="l_depot" checked><span class="sw" style="background:#e3007d"></span>Depot __DEPOT__</label>
 <label><input type="checkbox" id="l_labels" checked>Hiện nhãn mã tòa</label>
 <b>Đường</b>
 <label><input type="checkbox" id="l_moto" checked><span class="sw" style="background:#d62728"></span>Xe máy + đi bộ</label>
 <label><input type="checkbox" id="l_walk" checked><span class="sw" style="background:#2ca02c"></span>Chỉ đi bộ</label>
 <label><input type="checkbox" id="l_other" checked><span class="sw" style="background:#9467bd"></span>Loại khác (cần xem)</label>
 <label><input type="checkbox" id="l_ow" checked>Đánh dấu một chiều (nét đứt)</label>
 <b>Khác</b>
 <label><input type="checkbox" id="l_ent" checked><span class="sw" style="background:#000;border-radius:50%"></span>Lối vào (entrance)</label>
 <label><input type="checkbox" id="l_area" checked><span class="sw" style="background:#ffeb3b55"></span>Khu/phân khu có tên</label>
 <label><input type="checkbox" id="l_bbox" checked>Khung bao tải dữ liệu</label>
 <label><input type="checkbox" id="l_base" checked>Nền bản đồ (đổi ở góc dưới trái)</label>
</div>
<script>
const D=__DATA__, BBOX=__BBOX__, S=__STATS__;
document.getElementById('stat').innerHTML=
 `${S.roads} đoạn đường · ${S.buildings} tòa (${S.named} có tên) · ${S.entrances} lối vào<br>`+
 `Depot __DEPOT__: `+(S.depot?'<span class="ok">tìm thấy</span>':'<span class="bad">không có trong OSM</span>');
const map=L.map('map',{preferCanvas:true}).fitBounds([[BBOX[0],BBOX[1]],[BBOX[2],BBOX[3]]]);
// Nền bản đồ Esri: không cần API key, mở được từ file cục bộ
// (tile.openstreetmap.org chặn 403 vì thiếu Referer; CARTO đòi API key)
const ESRI='https://server.arcgisonline.com/ArcGIS/rest/services/';
const BASES={
 'Bản đồ (Esri)':L.tileLayer(ESRI+'World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  {maxZoom:20,maxNativeZoom:19,opacity:.6,attribution:'© Esri, OpenStreetMap'}),
 'Vệ tinh (Esri)':L.tileLayer(ESRI+'World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {maxZoom:20,maxNativeZoom:19,opacity:.8,attribution:'© Esri, Maxar'})};
let base=BASES['Bản đồ (Esri)'].addTo(map);
L.control.layers(BASES,null,{position:'bottomleft'}).addTo(map);
map.on('baselayerchange',e=>base=e.layer);
const G={}; for(const k of ['named','unnamed','depot','labels','moto','walk','other','ent','area','bbox'])G[k]=L.layerGroup();
G.ow=L.layerGroup();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
D.areas.forEach(a=>L.polygon(a.g,{color:'#b8a100',weight:1,fillColor:'#ffeb3b',fillOpacity:.12})
 .bindTooltip(esc(a.nm||'(không tên)')).addTo(G.area));
const col={moto:'#d62728',walk:'#2ca02c',other:'#9467bd'}, wt={moto:3,walk:2,other:2};
D.roads.forEach(r=>{
 const l=L.polyline(r.g,{color:col[r.c],weight:wt[r.c],opacity:.85});
 l.bindPopup(`<b>${esc(r.hw)}</b> ${esc(r.nm)}<br>way ${r.id}${r.ow?'<br>MỘT CHIỀU':''}${r.acc?'<br>access='+esc(r.acc):''}`);
 l.addTo(G[r.c]);
 if(r.ow)L.polyline(r.g,{color:'#000',weight:1,dashArray:'4 4',interactive:false}).addTo(G.ow);
});
const idx=[];
D.buildings.forEach(b=>{
 const grp=b.depot?'depot':(b.nm?'named':'unnamed');
 const c=b.depot?'#e3007d':(b.nm?'#2b7de9':'#f39c12');
 const pop=`<b>${esc(b.nm||'(không tên)')}</b><br>${b.codes.length?'Mã: '+esc(b.codes.join(', '))+'<br>':''}`+
  `building=${esc(b.bt)}${b.lv?'<br>tầng: '+esc(b.lv):''}<br>${b.id}<br>${b.c[0]}, ${b.c[1]}`;
 const lay=b.g?L.polygon(b.g,{color:c,weight:1,fillColor:c,fillOpacity:.45}):L.circleMarker(b.c,{radius:5,color:c,fillOpacity:.8});
 lay.bindPopup(pop).addTo(G[grp]);
 if(b.nm)L.tooltip({permanent:true,direction:'center',className:'lbl'}).setLatLng(b.c)
  .setContent(esc(b.codes[0]||b.nm)).addTo(G.labels);
 idx.push([(b.nm+' '+b.codes.join(' ')).toUpperCase(),lay,b]);
});
D.entrances.forEach(e=>L.circleMarker(e.c,{radius:3,color:'#000',fillColor:'#000',fillOpacity:1})
 .bindPopup('entrance='+esc(e.t)+'<br>node '+e.id).addTo(G.ent));
L.rectangle([[BBOX[0],BBOX[1]],[BBOX[2],BBOX[3]]],{color:'#555',weight:1,dashArray:'6 4',fill:false,interactive:false}).addTo(G.bbox);
const ids={named:'l_named',unnamed:'l_unnamed',depot:'l_depot',labels:'l_labels',moto:'l_moto',walk:'l_walk',
 other:'l_other',ow:'l_ow',ent:'l_ent',area:'l_area',bbox:'l_bbox'};
for(const [k,id] of Object.entries(ids)){const cb=document.getElementById(id);
 const f=()=>cb.checked?G[k].addTo(map):map.removeLayer(G[k]);cb.onchange=f;f();}
const cbB=document.getElementById('l_base');cbB.onchange=()=>cbB.checked?base.addTo(map):map.removeLayer(base);
// Ẩn nhãn khi thu nhỏ để đỡ rối
map.on('zoomend',()=>{if(!document.getElementById('l_labels').checked)return;
 map.getZoom()>=16?G.labels.addTo(map):map.removeLayer(G.labels);});
map.fire('zoomend');
document.getElementById('q').onkeydown=e=>{if(e.key!=='Enter')return;
 const q=e.target.value.trim().toUpperCase().replace(/[\s\-_]/g,'');if(!q)return;
 const hit=idx.find(([t])=>t.replace(/[\s\-_.]/g,'').includes(q.replace(/\./g,'')));
 if(!hit){alert('Không tìm thấy '+e.target.value);return;}
 map.setView(hit[2].c,18);hit[1].openPopup(hit[2].c);};
</script></body></html>
"""


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Giai đoạn 1 – tải & kiểm tra dữ liệu OSM VGP")
    ap.add_argument("--bbox", help="nam,tây,bắc,đông (mặc định %s)" % ",".join(map(str, DEFAULT_BBOX)))
    ap.add_argument("--from-file", action="store_true", help="không tải lại, dùng raw/vgp_osm.json có sẵn")
    a = ap.parse_args()
    bbox = tuple(float(x) for x in a.bbox.split(",")) if a.bbox else DEFAULT_BBOX
    if len(bbox) != 4 or not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        raise SystemExit("bbox phải dạng nam,tây,bắc,đông")

    os.makedirs(RAW_DIR, exist_ok=True)
    raw_path = os.path.join(RAW_DIR, "vgp_osm.json")

    if a.from_file:
        with open(raw_path, encoding="utf-8") as f:
            osm = json.load(f)
        bbox = tuple(osm.get("_bbox", bbox))
        print(f"Đọc {raw_path}: {len(osm['elements'])} phần tử")
    else:
        print(f"Tải dữ liệu OSM trong khung {bbox}…")
        osm = fetch_overpass(build_query(bbox))
        osm["_bbox"] = list(bbox)
        osm["_fetched_at"] = datetime.now().isoformat(timespec="seconds")
        with open(raw_path, "w", encoding="utf-8") as f:
            json.dump(osm, f, ensure_ascii=False)
        print(f"Đã lưu {raw_path}")

    A = analyze(osm, bbox)
    rep = os.path.join(RAW_DIR, "vgp_report.txt")
    txt = write_report(A, rep)
    prev = os.path.join(RAW_DIR, "preview.html")
    write_preview(A, prev)
    print(f"Đã lưu {rep}\nĐã lưu {prev}\n")
    # In phần tóm tắt đầu báo cáo
    print("\n".join(txt.splitlines()[:6]))
    print(next((l for l in txt.splitlines() if l.startswith("2. TÒA NHÀ")), ""))
    print(next((l for l in txt.splitlines() if "S3.03" in l and ("TÌM THẤY" in l or "KHÔNG" in l)), ""))


if __name__ == "__main__":
    main()
