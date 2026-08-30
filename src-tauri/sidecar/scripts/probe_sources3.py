"""probe_sources3.py — 框架建设补充源探测（P0 层内容缺口）"""
import os
from pathlib import Path

# TDSF 2026-08-30: 统一数据目录到 <项目根>/.tdsf-data（与应用 main.py 一致）
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

import requests  # noqa: E402

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
}

CANDIDATES = {
    "man-pages(man7)": "https://man7.org/linux/man-pages/dir_all_manpages.html",
    "archwiki-systemd": "https://wiki.archlinux.org/title/Systemd",
    "mariadb-kb": "https://mariadb.com/kb/en/documentation/",
    "dnf-docs": "https://dnf.readthedocs.io/en/latest/",
    "firewalld": "https://firewalld.org/documentation/",
    "debian-wiki-apt": "https://wiki.debian.org/AptCLI",
}

for name, url in CANDIDATES.items():
    try:
        r = requests.get(url, headers=UA, timeout=8)
        print(f"OK   {r.status_code} {len(r.text):>8}  {name}")
    except Exception as e:
        print(f"FAIL {str(e)[:70]}  {name}")
