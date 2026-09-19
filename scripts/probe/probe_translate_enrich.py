#!/usr/bin/env python3
"""真机行为门禁：翻译卡片未命中时的「AI 补全」链路（P6）通不通。

要测的三件事，jsdom 一条都测不到：
  1. keyring 取 key → AI SDK → WebView2 网络（CORS/证书）真的能拿到一条释义；
  2. 释义落进本地增量词库，同一个词第二次查直接本地命中，不再重复花额度；
  3. 失败原因分得开：no-key/error = 链路坏了（FAIL），no-answer = 模型自认
     没把握（按提示词要求它不许编，属正常，换下一个候选词继续试）。
候选词由"离线链自己说未命中"决定，不靠人猜；跑完把增量词库原样还回去。
会真的产生模型调用（最多 MAX_TRIES 次）。

前置：dev 实例起着，且已配好至少一个模型 key：
    npx tauri dev --config src-tauri/tauri.dev.conf.json
    src-tauri/sidecar/.venv/Scripts/python.exe scripts/probe/probe_translate_enrich.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cdp  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 离线词库/ECDICT 大概率没收录、又确实属于终端语境的候选；实际用哪个由页面自己判
CANDIDATES = ["batctl", "iperf3", "systemd-run", "zramctl", "terragrunt", "kubeseal", "dotenvx"]
MAX_TRIES = 3
# vite dev 的模块缓存按 URL 记，查询串固定会拿到改动前的旧副本，所以每次跑换个新串
RUN = f"enrich-probe-{int(time.time())}"

# ?v=__RUN__ 拿的是只读副本：translateApi 是纯函数、enrichmentStore 落在
# localStorage，副本测出来就是真值。内存单例（suggest-engine）绝不能这么测，
# 那种要靠 __TDSF_DBG__，见 probe_prediction_crosswindow.py。
PICK_JS = """
  (async (words) => {
    const api = await import('/src/modules/translate/translateApi.ts?v=__RUN__');
    const store = await import('/src/modules/translate/enrichmentStore.ts?v=__RUN__');
    return JSON.stringify({
      snapshot: store.listEnrichments(),
      missing: words.filter((w) => api.translateText(w).entries.length === 0),
    });
  })
"""

ENRICH_JS = """
  (async ({ words, maxTries }) => {
    const api = await import('/src/modules/translate/translateApi.ts?v=__RUN__');
    const c = await import('/src/modules/translate/enrichClient.ts?v=__RUN__');
    const store = await import('/src/modules/translate/enrichmentStore.ts?v=__RUN__');
    c.resetEnrichQuota();
    const attempts = [];
    for (const word of words.slice(0, maxTries)) {
      const t0 = Date.now();
      const res = await c.enrichTerm(word);
      const lookup = api.translateText(word).entries.map((e) => e.word + '=' + e.zh);
      attempts.push({ word, ms: Date.now() - t0, ok: res.ok,
                      reason: res.ok ? null : res.reason,
                      zh: res.ok ? res.entries[0].zh : null,
                      example: res.ok ? res.entries[0].example || null : null,
                      stored: store.listEnrichments().length, secondLookup: lookup });
      if (res.ok) break;
    }
    return JSON.stringify(attempts);
  })
"""

RESTORE_JS = """
  (async (entries) => {
    const store = await import('/src/modules/translate/enrichmentStore.ts?v=__RUN__');
    store.clearEnrichments();
    entries.forEach((e) => store.putEnrichment({ word: e.word, zh: e.zh, example: e.example }));
    return String(store.listEnrichments().length);
  })
"""


def js(tpl: str) -> str:
    """把模板里的 __RUN__ 换成这次运行的唯一串，再包成可执行表达式。"""
    return "(" + tpl.replace("__RUN__", RUN).strip() + ")"


def main() -> int:
    page = cdp.connect([x for x in cdp.probe_port() if "settings.html" not in x["url"]][0])
    if not page.evaluate("!!window.__TDSF_DBG__"):
        print("连的不是 dev 实例，停止")
        page.close()
        return 1

    picked = json.loads(
        page.evaluate(
            f"{js(PICK_JS)}({json.dumps(CANDIDATES, ensure_ascii=False)})", True
        )
    )
    snapshot, missing = picked["snapshot"], picked["missing"]
    if not missing:
        print("候选词离线链全都能命中，测不到兜底：往 CANDIDATES 里再加几个生僻词")
        page.close()
        return 1
    print(f"离线未命中的候选：{missing}（增量词库原有 {len(snapshot)} 条，跑完原样还回去）")

    t0 = time.time()
    attempts = json.loads(
        page.evaluate(
            f"{js(ENRICH_JS)}({json.dumps({'words': missing, 'maxTries': MAX_TRIES})})", True
        )
    )
    print(f"  共 {round(time.time() - t0, 1)}s")
    for a in attempts:
        print("  ·", json.dumps(a, ensure_ascii=False))

    restored = page.evaluate(
        f"{js(RESTORE_JS)}({json.dumps(snapshot, ensure_ascii=False)})", True
    )
    print(f"增量词库已恢复为探针进来前的 {restored} 条")
    page.close()

    hit = [a for a in attempts if a["ok"]]
    if not hit:
        reasons = {a["reason"] for a in attempts}
        if reasons & {"no-key", "error"}:
            print(f"FAIL：链路不通（{sorted(reasons)}）—— 检查模型 Key / 网络 / 供应商")
        else:
            print(f"FAIL：{len(attempts)} 个候选模型都没给出释义（{sorted(reasons)}）")
        return 1
    a = hit[0]
    ok = a["stored"] == len(snapshot) + 1 and any(
        a["word"].lower() in s.lower() for s in a["secondLookup"]
    )
    print(f"PASS：{a['word']} → {a['zh']}（{a['ms']}ms，二次查走本地增量词库）" if ok
          else f"FAIL：拿到了释义但没落进增量词库/二次查没命中：{json.dumps(a, ensure_ascii=False)}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
