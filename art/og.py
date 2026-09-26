#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
分享圖(1200x630)產生器。issue #18(orchestrator 裁決)。

用 Pillow 畫,不用 ComfyUI:這個系列的樣子是「作業簿、原子筆、老師的紅筆」,
跟遊戲本身的畫面(public/shared/paper.js、public/dogfight/app.js)同一支筆。

固定種子、固定參數:同一份程式跑兩次,兩張圖的位元組要一模一樣(sha256 相同)。
不下載任何字型或素材;字型只用本機的 kaiu.ttf(標楷體)。

只用 palette 這七個顏色(加它們往 sheet/白 混出來的淺色格線):
  desk / sheet / rule / pencil / blue / black / red —— 抄自計畫的 Look 一節。
"""

import hashlib
import math
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "art")
FONT_PATH = "C:/Windows/Fonts/kaiu.ttf"

W, H = 1200, 630

# ───────────────────────────── palette(計畫的 Look 一節) ─────────────────────────────
DESK = (0xE3, 0xE7, 0xDA)
SHEET = (0xF8, 0xF9, 0xF3)
RULE = (0xA9, 0xCD, 0xB9)
PENCIL = (0x3A, 0x3F, 0x46)
BLUE = (0x23, 0x40, 0xA8)
BLACK = (0x1D, 0x1F, 0x24)
RED = (0xCF, 0x3A, 0x35)


def mix(c1, c2, t):
    """c1 和 c2 的線性混色,t=0 是 c1,t=1 是 c2。只用來調淺格線,不算多一個顏色。"""
    return tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


RULE_LIGHT = mix(SHEET, RULE, 0.55)  # 格線疊在 sheet 上要淡一點,不然比遊戲裡搶眼
RULE_ON_DESK = mix(DESK, RULE, 0.7)
FIELD_TXT = mix(PENCIL, SHEET, 0.15)  # 個人欄位字比標題淡一點


# ───────────────────────────── 決定性的抖動(跟 paper.js 的 hash1 同一條公式) ─────────────────────────────
def hash1(n):
    x = math.sin(n * 127.1 + 311.7) * 43758.5453
    return x - math.floor(x)


def jitter(seed, k, amp):
    return (hash1((seed + k) * 7.3) - 0.5) * 2 * amp


def sketch_line(draw, p1, p2, seed, color, width, amp=1.6):
    """一條抖動的線(手繪感):兩點之間加一個抖動過的中點,近似 canvas 的 quadraticCurveTo。"""
    x1, y1 = p1
    x2, y2 = p2
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    pts = [
        (x1 + jitter(seed, 0, amp), y1 + jitter(seed, 1, amp)),
        (mx + jitter(seed, 2, amp * 1.5), my + jitter(seed, 3, amp * 1.5)),
        (x2 + jitter(seed, 4, amp), y2 + jitter(seed, 5, amp)),
    ]
    draw.line(pts, fill=color, width=width, joint="curve")
    r = width / 2
    for p in (pts[0], pts[-1]):
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)


def irregular_rect(draw, x0, y0, x1, y1, fill, outline, seed, width=4, jitter_amp=3):
    """手畫的不規則框:四個角先抖一下,再用一條粗線描邊。沒有陰影、沒有漸層。"""
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    jc = []
    for i, (x, y) in enumerate(corners):
        jc.append((x + jitter(seed, i * 2, jitter_amp), y + jitter(seed, i * 2 + 1, jitter_amp)))
    if fill is not None:
        draw.polygon(jc, fill=fill)
    ring = jc + [jc[0]]
    draw.line(ring, fill=outline, width=width, joint="curve")
    r = width / 2
    for p in jc:
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=outline)


def h_grid(draw, x0, y0, x1, y1, step, color):
    """格線:只畫水平線(跟 paper.js 的 sheet() 一樣,不畫垂直線)。"""
    y = y0 + step
    while y < y1:
        draw.line([(x0, y), (x1, y)], fill=color, width=1)
        y += step


def dashed_line(draw, x0, y, x1, color, width, dash=10, gap=9):
    x = x0
    while x < x1:
        xe = min(x + dash, x1)
        draw.line([(x, y), (xe, y)], fill=color, width=width)
        x = xe + gap


# ───────────────────────────── 飛機:抄 public/dogfight/app.js 的預設飛機(drawPlane 的 else 分支) ─────────────────────────────
# 座標跟 app.js 一字不差:機頭在 (22,0),機尾在 (-18,0),兩對機翼加尾翼小鰭。
PLANE_SEGS = [
    (-18, 0, 22, 0),
    (-2, -21, 8, 0),
    (8, 0, -2, 21),
    (-2, -21, -6, 0),
    (-6, 0, -2, 21),
    (-18, -9, -13, 0),
    (-13, 0, -18, 9),
]


def draw_plane(draw, cx, cy, angle_deg, scale, color, seed, width=6):
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)

    def tf(x, y):
        xr = x * ca - y * sa
        yr = x * sa + y * ca
        return (cx + xr * scale, cy + yr * scale)

    for i, (x1, y1, x2, y2) in enumerate(PLANE_SEGS):
        sketch_line(draw, tf(x1, y1), tf(x2, y2), seed + i, color, width, amp=scale * 0.09)


def scribble(draw, x, y, r, seed, color, width=4):
    """亂塗掉一個東西(抄 paper.js 的 scribble:一圈亂線,標記被打掉的飛機)。"""
    for k in range(9):
        p0x = x + (hash1(seed + k * 3) - 0.5) * r * 2
        p0y = y + (hash1(seed + k * 3 + 1) - 0.5) * r * 2
        p1x = x + (hash1(seed + k * 3 + 2) - 0.5) * r * 2
        p1y = y + (hash1(seed + k * 3 + 3) - 0.5) * r * 2
        sketch_line(draw, (p0x, p0y), (p1x, p1y), seed + k, color, width, amp=2)


# ───────────────────────────── 字 ─────────────────────────────
def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def text_centered(draw, cx, y, txt, f, fill, spacing=0):
    if spacing:
        # letter-spacing:一個字一個字疊上去,不用 anchor,才能自己控制字距。
        widths = [draw.textbbox((0, 0), ch, font=f)[2] for ch in txt]
        total = sum(widths) + spacing * (len(txt) - 1)
        x = cx - total / 2
        for ch, w in zip(txt, widths):
            draw.text((x, y), ch, font=f, fill=fill)
            x += w + spacing
        return total
    bbox = draw.textbbox((0, 0), txt, font=f)
    w = bbox[2] - bbox[0]
    draw.text((cx - w / 2 - bbox[0], y), txt, font=f, fill=fill)
    return w


def text_height(draw, txt, f):
    bbox = draw.textbbox((0, 0), txt, font=f)
    return bbox[3] - bbox[1]


# ───────────────────────────── 封面:og-bored-games ─────────────────────────────
def make_cover():
    img = Image.new("RGB", (W, H), DESK)
    d = ImageDraw.Draw(img)
    h_grid(d, 0, 0, W, H, 32, RULE_ON_DESK)

    # 作業簿封面(照 index.html + style.css 的 .cover:sheet 底、pencil 邊、手畫的不規則框)。
    bx0, by0, bx1, by1 = 250, 80, 950, 575
    irregular_rect(d, bx0, by0, bx1, by1, SHEET, PENCIL, seed=1, width=5, jitter_amp=4)

    cx = (bx0 + bx1) / 2

    # 標籤框(.label,照 html 結構:h1 標題 + p.fields 都在這個框裡面)。
    lx0, ly0, lx1, ly1 = bx0 + 40, by0 + 28, bx1 - 40, by0 + 288
    irregular_rect(d, lx0, ly0, lx1, ly1, SHEET, PENCIL, seed=2, width=4, jitter_amp=3)

    f_en = font(44)
    f_cn = font(88)
    f_field = font(28)
    y = ly0 + 20
    text_centered(d, cx, y, "Bored Games", f_en, PENCIL, spacing=4)
    y += text_height(d, "Bored Games", f_en) + 20
    text_centered(d, cx, y, "無聊遊戲簿", f_cn, PENCIL, spacing=10)
    y += text_height(d, "無聊遊戲簿", f_cn) + 26
    text_centered(d, cx, y, "＿年＿班\u3000姓名＿＿＿＿", f_field, FIELD_TXT, spacing=2)

    # 目錄(.toc,在標籤框外面):第一條,紙上空戰,旁邊配一架小飛機當插圖(順便滿足
    # 「至少一架飛機在中間 630×630」的要求——封面本來沒有飛機,這裡加一架呼應第一條)。
    f_h2 = font(28)
    f_toc = font(36)
    ty = ly1 + 32
    text_centered(d, cx, ty, "目錄 CONTENTS", f_h2, mix(PENCIL, SHEET, 0.2), spacing=6)
    ty += text_height(d, "目錄 CONTENTS", f_h2) + 30

    toc_txt = "一、紙上空戰"
    draw_plane_toc_row(d, cx, ty, toc_txt, f_toc)

    return img


def draw_plane_toc_row(d, cx, y, txt, f):
    bbox = d.textbbox((0, 0), txt, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    gap = 44
    plane_scale = 1.7
    plane_w = 44 * plane_scale  # 機頭到機尾的跨距(-18..22 共 40 個單位)大概的寬度
    total = tw + gap + plane_w
    x0 = cx - total / 2
    d.text((x0 - bbox[0], y), txt, font=f, fill=PENCIL)
    pcx = x0 + tw + gap + plane_w / 2
    pcy = y + th / 2
    draw_plane(d, pcx, pcy, -20, plane_scale, BLUE, seed=40)  # 稍微上揚,像隨手畫在旁邊的塗鴉
    return total


# ───────────────────────────── 紙上空戰:og-dogfight ─────────────────────────────
def make_dogfight():
    img = Image.new("RGB", (W, H), SHEET)
    d = ImageDraw.Draw(img)
    h_grid(d, 0, 0, W, H, 30, RULE_LIGHT)

    fold_y = H / 2
    dashed_line(d, 0, fold_y, W, PENCIL, 2)

    # 三架藍筆飛機(下方,座位 0),機頭朝上;三架黑筆飛機(上方,座位 1),機頭朝下。
    xs = [230, 600, 970]
    blue_y = 500
    black_y = 130
    scale = 2.6

    for i, x in enumerate(xs):
        draw_plane(d, x, black_y, 90, scale, BLACK, seed=10 + i * 7)
    for i, x in enumerate(xs):
        draw_plane(d, x, blue_y, -90, scale, BLUE, seed=60 + i * 7)

    # 中間那架藍筆打中中間那架黑筆:一條藍筆線從藍飛機機頭出去,穿過摺線,
    # 打在黑飛機上;那架黑飛機被紅筆打叉。
    shot_from = (xs[1], blue_y - 22 * scale)
    shot_to = (xs[1], black_y + 22 * scale)
    for seg in range(3):
        t0 = seg / 3
        t1 = (seg + 1) / 3
        p0 = (shot_from[0] + (shot_to[0] - shot_from[0]) * t0, shot_from[1] + (shot_to[1] - shot_from[1]) * t0)
        p1 = (shot_from[0] + (shot_to[0] - shot_from[0]) * t1, shot_from[1] + (shot_to[1] - shot_from[1]) * t1)
        sketch_line(d, p0, p1, seed=90 + seg, color=BLUE, width=4, amp=2.4)

    scribble(d, xs[1], black_y, 30, seed=120, color=RED, width=5)

    # 標題橫幅,壓在摺線正中間:中文標題和飛機都落在正中間的 630×630 方塊裡。
    band_w, band_h = 620, 168
    bx0, by0 = W / 2 - band_w / 2, fold_y - band_h / 2
    bx1, by1 = bx0 + band_w, by0 + band_h
    irregular_rect(d, bx0, by0, bx1, by1, SHEET, PENCIL, seed=3, width=5, jitter_amp=4)

    f_en = font(42)
    f_cn = font(78)
    cx = W / 2
    y = by0 + 16
    text_centered(d, cx, y, "Paper Dogfight", f_en, PENCIL, spacing=3)
    y += text_height(d, "Paper Dogfight", f_en) + 18
    text_centered(d, cx, y, "紙上空戰", f_cn, PENCIL, spacing=12)

    return img


# ───────────────────────────── 存檔:png,調色盤壓到夠小的檔案 ─────────────────────────────
def save_png(img, path, max_bytes):
    # 這張圖本來就是少數幾個顏色的手繪平塗,調色盤壓到 128 色仍然看不出差別,
    # 檔案可以壓到 300 KB 以內、而且是完全決定性的(同樣的輸入永遠得到同樣的位元組)。
    for colors in (256, 192, 128, 96, 64):
        q = img.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
        q.save(path, format="PNG", optimize=True)
        if os.path.getsize(path) <= max_bytes:
            return
    # 保底:就算壓到 64 色還是太大,存最後一次的結果(不太可能發生,留著讓證偽測得到)。


def sha256_of(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    max_bytes = 300 * 1000

    cover = make_cover()
    assert cover.size == (W, H)
    cover_path = os.path.join(OUT_DIR, "og-bored-games.png")
    save_png(cover, cover_path, max_bytes)

    dogfight = make_dogfight()
    assert dogfight.size == (W, H)
    dogfight_path = os.path.join(OUT_DIR, "og-dogfight.png")
    save_png(dogfight, dogfight_path, max_bytes)

    for p in (cover_path, dogfight_path):
        size = os.path.getsize(p)
        print(f"{p}: {size} bytes, sha256={sha256_of(p)}")


if __name__ == "__main__":
    main()
