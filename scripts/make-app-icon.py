# -*- coding: utf-8 -*-
"""
应用图标生成脚本（Tauri 源图 1024x1024）
用法：python scripts/make-app-icon.py
输出：src-tauri/icons/source-icon.png（之后用 `pnpm tauri icon src-tauri/icons/source-icon.png` 生成全套尺寸）

设计说明（基于上游 terax 图标魔改，2026-08-28 用户拍板）：
- 保留 ">_" 终端提示符骨架，主题绿 #34D399（从原 512 图取样，Tailwind emerald-400）
- 箭头 ">" 缩小：高度占画布 ~49%（原 ~75%）
- 光标 "_" 加大：150/1024 ≈ 15% 见方（原 ~9%），底边与箭头底对齐（终端基线）
- 背景换成中灰 #4A4A4A（原近黑 #14161B），圆角比例 200/1024 ≈ 19.5% 与原图一致
- 4 倍超采样绘制后 LANCZOS 缩小，保证边缘锐利（解决"清晰度不够"）
"""
from PIL import Image, ImageDraw

# ---------- 可调参数（单位：1024 逻辑坐标，实际绘制时乘 S） ----------
BG_GRAY = (74, 74, 74, 255)        # 背景：中灰 #4A4A4A
GREEN = (52, 211, 153, 255)        # 主题绿 #34D399（与原图标一致）
RADIUS = 280                       # 圆角半径（1024 坐标，v2 调大更圆润：200 -> 280）
CANVAS = 1024                      # 输出尺寸
SS = 4                             # 超采样倍数（4x = 4096 实际绘制）

# 箭头 ">"：6 点多边形（外缘 3 点 + 平切端 + 内缘，横向厚度 t）
CHEVRON = dict(x_left=330, y_top=270, y_bot=770, x_tip=650, y_mid=520, t=115)
# 光标 "_"：圆角方块（v2 加圆角），底边与箭头底对齐
CURSOR = dict(x=720, y=620, size=150, radius=42)


def build(size: int) -> Image.Image:
    """按给定逻辑尺寸绘制图标（内部按 SS 倍超采样再缩小，保证抗锯齿）。"""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s / CANVAS  # 逻辑坐标 -> 实际像素缩放系数

    # 1) 灰色圆角方形背景（圆角外透明）
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=round(RADIUS * k), fill=BG_GRAY)

    # 2) 箭头 ">"：外缘 (左上 -> 尖端 -> 左下)；内缘 = 外缘整体左移 t（平行线），
    #    端头水平平切向左延伸，形成厚度均匀的粗箭头
    c = {key: round(val * k) for key, val in CHEVRON.items()}
    chevron_pts = [
        (c["x_left"], c["y_top"]),                # 外缘左上（顶端平切右角）
        (c["x_tip"], c["y_mid"]),                 # 外缘尖端
        (c["x_left"], c["y_bot"]),                # 外缘左下（底端平切右角）
        (c["x_left"] - c["t"], c["y_bot"]),       # 底端平切左角
        (c["x_tip"] - c["t"], c["y_mid"]),        # 内缘尖端（平行线交点）
        (c["x_left"] - c["t"], c["y_top"]),       # 顶端平切左角
    ]
    d.polygon(chevron_pts, fill=GREEN)

    # 3) 光标 "_"：加大后的圆角方块，底边与箭头底对齐
    cu = {key: round(val * k) for key, val in CURSOR.items()}
    d.rounded_rectangle(
        [cu["x"], cu["y"], cu["x"] + cu["size"], cu["y"] + cu["size"]],
        radius=cu["radius"],
        fill=GREEN,
    )

    # 4) 高质量下采样回目标尺寸（超采样抗锯齿的核心步骤）
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os

    out = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src-tauri", "icons", "source-icon.png",
    )
    build(CANVAS).save(out)
    print(f"OK -> {out} ({CANVAS}x{CANVAS})")
