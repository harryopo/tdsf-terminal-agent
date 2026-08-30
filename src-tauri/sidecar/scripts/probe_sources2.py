"""probe_sources2.py — 第二轮探测：bash 替代源 + systemd 入口"""
import requests

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
}

CANDIDATES = {
    "arch-home": "https://man.archlinux.org/",
    "arch-grp": "https://man.archlinux.org/man/systemctl.1.en",
    "ubuntu-bash": "https://manpages.ubuntu.com/manpages/noble/en/man1/bash.1.html",
    "ubuntu-bash-dir": "https://manpages.ubuntu.com/manpages/",
    "debian-bash": "https://manpages.debian.org/bookworm/bash/bash.1.en.html",
}

for name, url in CANDIDATES.items():
    try:
        r = requests.get(url, headers=UA, timeout=8)
        print(f"OK   {r.status_code} {len(r.text):>8}  {name}")
    except Exception as e:
        print(f"FAIL {str(e)[:70]}  {name}")
