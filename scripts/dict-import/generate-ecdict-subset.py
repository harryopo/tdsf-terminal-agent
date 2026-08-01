"""
dict-import/generate-ecdict-subset.py — 从 ECDICT 生成翻译词库子集
====================================================================

数据源（MIT 许可，来源声明见产物文件头）：
- ecdict.csv（65.9MB，约 80 万条英中，含 COCA 词频 frq / 柯林斯星级 /
  考试 tag / 变形 exchange）
- lemma.en.txt（2.3MB，84,487 个 lemma 组：form → 原形）

生成产物（瘦身格式，体积可控）：
1. src/modules/translate/dict/ecdict-common.json
   高频常用词（frq ≤ 20000 ∪ bnc ≤ 20000 ∪ 考试 tag）∪ 计算机标记词
   （translation 含 [计]/[网] 等）——约 6-8 万条，字段 {zh, pos?, tag?}
2. src/modules/translate/dict/lemma-reverse.json
   form → lemma 反向表（gave→give, teeth→tooth）——约 8 万组

运行：python scripts/dict-import/generate-ecdict-subset.py
产物提交仓库（数据 ~4-6MB），原始 CSV 不提交。
"""
from __future__ import annotations

import csv
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_CSV = os.path.join(HERE, "ecdict.csv")
SRC_LEMMA = os.path.join(HERE, "lemma.en.txt")
OUT_DIR = os.path.join(HERE, "..", "..", "src", "modules", "translate", "dict")

# 计算机领域标记（translation 中的 [xx] 标签）
CS_TAGS = {"计", "网", "数", "信", "软", "硬", "程", "操", "网", "库", "编", "存"}

FRQ_LIMIT = 20000
BNC_LIMIT = 20000
EXAM_TAGS = {"cet4", "cet6", "ky", "toefl", "ielts", "gre"}


def parse_ecdict() -> dict[str, dict]:
    """解析 ecdict.csv → {word: {zh, pos, tag}}（过滤后）"""
    out: dict[str, dict] = {}
    with open(SRC_CSV, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get("word") or "").strip().lower()
            if not word or not re.fullmatch(r"[a-z][a-z0-9 .'-]*", word):
                continue
            translation = row.get("translation") or ""
            # 只取中文释义（去掉音标/英文部分）
            zh = extract_zh(translation)
            if not zh:
                continue
            pos = (row.get("pos") or "").strip()
            tags = set((row.get("tag") or "").split("/"))
            try:
                frq = int(row.get("frq") or 0)
            except ValueError:
                frq = 0
            try:
                bnc = int(row.get("bnc") or 0)
            except ValueError:
                bnc = 0

            is_cs = any(f"[{t}]" in translation for t in CS_TAGS)
            is_frequent = (0 < frq <= FRQ_LIMIT) or (0 < bnc <= BNC_LIMIT)
            is_exam = bool(tags & EXAM_TAGS)
            if not (is_cs or is_frequent or is_exam):
                continue

            entry: dict = {"zh": zh}
            if pos:
                entry["pos"] = pos
            if is_cs:
                entry["tag"] = "cs"
            elif is_frequent or is_exam:
                entry["tag"] = "common"
            out[word] = entry
    return out


def extract_zh(translation: str) -> str:
    """从 ECDICT translation 字段提取中文释义（去掉音标/网络释义）"""
    # 去行内标签 [计]/[网] 等（保留内容）
    text = re.sub(r"\[[^\]]+\]", "", translation)
    # 取第一个分号前的主释义（避免过长）
    parts = [p.strip() for p in text.split(";") if p.strip()]
    if not parts:
        return ""
    # 主释义过滤：纯英文/音标/无意义
    first = parts[0]
    if not re.search(r"[\u4e00-\u9fff]", first):
        return ""
    return first[:80]


def parse_lemma() -> dict[str, str]:
    """解析 lemma.en.txt → {form: lemma}（反向表）"""
    out: dict[str, str] = {}
    with open(SRC_LEMMA, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(";"):
                continue
            # 格式: lemma/词频 -> form1, form2, ...
            if "->" not in line:
                continue
            head, _, forms = line.partition("->")
            lemma = head.split("/")[0].strip().lower()
            if not lemma:
                continue
            for form in forms.split(","):
                f = form.strip().lower()
                if f and f != lemma:
                    out.setdefault(f, lemma)
    return out


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    print("parsing ecdict.csv ...")
    entries = parse_ecdict()
    print(f"  entries: {len(entries)}")

    print("parsing lemma.en.txt ...")
    lemma = parse_lemma()
    print(f"  lemma groups: {len(lemma)}")

    header = {
        "_source": "ECDICT (skywind3000, MIT) + lemma.en.txt",
        "_generated": "2026-08-01",
        "_filter": "cs tag [计] etc + COCA/BNC <= 20000 + exam tags",
        "_url": "https://github.com/skywind3000/ECDICT",
    }

    with open(os.path.join(OUT_DIR, "ecdict-common.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, **header, "entries": entries}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT_DIR, "lemma-reverse.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, **header, "entries": lemma}, f, ensure_ascii=False, separators=(",", ":"))

    print("done:", os.path.join(OUT_DIR, "ecdict-common.json"),
          os.path.join(OUT_DIR, "lemma-reverse.json"))


if __name__ == "__main__":
    main()
