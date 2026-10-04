#!/bin/sh
# Dựng lại dữ liệu app sau khi sửa data/buildings.csv hoặc data/overrides.json
# Cách chạy (từ thư mục gốc dự án):  sh pipeline/build_all.sh
set -e
cd "$(dirname "$0")/.."
python3 pipeline/02_build_buildings.py --check
python3 pipeline/03_build_graph.py
python3 pipeline/04_build_matrix.py
if command -v node >/dev/null 2>&1; then node tests/solver.test.js; fi
echo
echo "Xong. Đưa lên GitHub để iPhone nhận dữ liệu mới:"
echo "  git add -A && git commit -m 'Cập nhật dữ liệu' && git push"
