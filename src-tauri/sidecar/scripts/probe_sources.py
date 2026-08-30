"""probe_sources.py — 爬虫源连通性探测（一次性运维脚本）"""
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
    "Accept-Language": "en-US,en;q=0.9",
}

CANDIDATES = {
    "systemd-man-arch": "https://man.archlinux.org/systemctl.1",
    "systemd-freedesktop": "https://www.freedesktop.org/software/systemd/man/latest/systemctl.1.html",
    "selinux-debian": "https://wiki.debian.org/SELinux",
    "selinux-gentoo": "https://wiki.gentoo.org/wiki/SELinux",
    "ssh-openbsd-ssh": "https://man.openbsd.org/ssh",
    "ssh-openssh-com": "https://www.openssh.com/manual.html",
    "bash-gnu": "https://www.gnu.org/software/bash/manual/",
    "bash-hr": "https://www.gnu.org/software/bash/manual/bash.html",
}

for name, url in CANDIDATES.items():
    try:
        r = requests.get(url, headers=UA, timeout=8)
        size = len(r.text)
        print(f"OK   {r.status_code} {size:>8}  {name}  {url}")
    except Exception as e:
        msg = str(e)[:80]
        print(f"FAIL {msg}  {name}")
