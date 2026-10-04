# VGP Delivery Route

App cá nhân tính lộ trình giao hàng ngắn nhất trong Vinhomes Grand Park (PWA, chạy offline trên iPhone).

## Giai đoạn 1 – Tải dữ liệu OSM

Yêu cầu: Python 3 trên Mac (không cần cài thêm thư viện).

```bash
cd "~/Documents/VGP Delivery Route"
python3 pipeline/01_fetch_osm.py
```

Tùy chọn:

- `--bbox nam,tây,bắc,đông` – đổi khung bao (mặc định `10.828,106.820,10.860,106.860`).
- `--from-file` – dựng lại báo cáo và preview từ `raw/vgp_osm.json` đã tải, không gọi Overpass.

Đầu ra trong `raw/`:

- `vgp_osm.json` – dữ liệu thô.
- `vgp_report.txt` – thống kê đường, tòa nhà, mã tòa, S3.03, lối vào, phân khu.
- `preview.html` – mở bằng Safari/Chrome (cần mạng để tải nền bản đồ). Có ô tìm mã tòa, bật/tắt từng lớp, bấm vào đối tượng để xem tag.

Nếu Python báo lỗi chứng chỉ SSL, script tự chuyển sang dùng `curl`.

## Giai đoạn 2 – Danh mục điểm giao và sảnh

```bash
python3 pipeline/02_build_buildings.py          # tạo/cập nhật data/buildings.csv + tools/editor_context.js
python3 pipeline/02_build_buildings.py --check  # kiểm tra nghiệm thu
```

1. Mở `tools/lobby_editor.html` bằng Safari/Chrome (bản nháp tự nạp).
2. Kéo ghim sảnh, bấm điểm gợi ý, "✓ Đã kiểm tra & sang điểm kế". Thêm dãy thấp tầng bằng "+ Thêm điểm".
3. "Xuất CSV" → chép đè file tải về vào `data/buildings.csv`.

Chạy lại script không làm mất dòng đã kiểm tra, dòng chỉnh tay và dòng thấp tầng.

## Giai đoạn 3 – Mạng đường

```bash
python3 pipeline/03_build_graph.py
```

- Đầu ra: `data/graph_moto.json`, `data/graph_walk.json`, `raw/graph_report.txt`, `raw/graph_preview.html`.
- Hiệu chỉnh trong `raw/graph_preview.html` (bấm đường để chặn/đổi chiều/cho phép, "Vẽ lối tắt") → "Tải overrides.json" → chép đè `data/overrides.json` → chạy lại script.

## Giai đoạn 4–5 – Ma trận khoảng cách và bộ giải

```bash
sh pipeline/build_all.sh      # chạy lại 02 --check, 03, 04 và test bộ giải
```

- `app/data/data.json`: danh sách tòa, ma trận 2 chế độ, hình dạng tuyến, lớp nền bản đồ (~0,6 MB).
- `raw/matrix_report.txt`: 10 cặp ngẫu nhiên để đối chiếu thực tế + các cặp chênh lệch đi/về.
- `app/solver.js`: ≤ 12 điểm dùng Held–Karp (tối ưu tuyệt đối); nhiều hơn dùng NN + Or-opt + 2-opt + ILS, kết quả xác định.
- Test: `node tests/solver.test.js` (cần Node).

## Giai đoạn 6–7 – App (PWA)

Thư mục `app/` là toàn bộ app. Thử trên Mac:

```bash
cd app && python3 -m http.server 8000     # mở http://localhost:8000
```

## Giai đoạn 8 – Đưa lên iPhone (GitHub Pages)

Lần đầu:

1. Tạo repo mới trên github.com (vd. `vgp-delivery`, để Public; Private cần gói trả phí mới dùng được Pages).
2. Trên Mac, trong thư mục dự án:
   ```bash
   git init -b main
   git add -A && git commit -m "Giao VGP"
   git remote add origin https://github.com/<tài-khoản>/vgp-delivery.git
   git push -u origin main
   ```
3. Trên GitHub: Settings → Pages → Source: **GitHub Actions**. Chờ tab Actions chạy xong (~1 phút).
4. Link app: `https://<tài-khoản>.github.io/vgp-delivery/`
5. iPhone: mở link bằng **Safari** → nút Chia sẻ → **Thêm vào MH chính**. Mở app từ màn hình chính một lần khi có mạng; sau đó chạy offline.

Cập nhật dữ liệu (sửa sảnh, chặn đường…): sửa `data/buildings.csv` / `data/overrides.json` → `sh pipeline/build_all.sh` → `git add -A && git commit -m "Cập nhật" && git push`. Lần mở app kế tiếp có mạng sẽ hiện thanh "Có dữ liệu mới – chạm để cập nhật".

Sửa giao diện (app.js, index.html…): tăng `VER` trong `app/sw.js` trước khi push để iPhone tải bản mới.
