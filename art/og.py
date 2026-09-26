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


def torn_edge(x0, x1, y, seed, n=26, amp=10):
    """一條撕過的紙邊:在 y 附近抖動,n 段。"""
    pts = []
    for i in range(n + 1):
        t = i / n
        x = x0 + (x1 - x0) * t
        yy = y + (hash1(seed + i * 1.37) - 0.5) * 2 * amp
        pts.append((x, yy))
    return pts


def torn_sheet(draw, x0, y0, x1, y1, fill, outline, seed=200, amp=11):
    """撕下來的一張紙:上下兩邊撕過(抖動的鋸齒),左右兩邊是紙本來的邊(直的)。
    沒有陰影、沒有漸層——只有一條描邊線。"""
    top = torn_edge(x0, x1, y0, seed, amp=amp)
    bottom = torn_edge(x0, x1, y1, seed + 500, amp=amp)
    poly = top + list(reversed(bottom))
    draw.polygon(poly, fill=fill)
    draw.line(top, fill=outline, width=2, joint="curve")
    draw.line(list(reversed(bottom)), fill=outline, width=2, joint="curve")
    draw.line([top[0], bottom[0]], fill=outline, width=2)
    draw.line([top[-1], bottom[-1]], fill=outline, width=2)
    return top, bottom


# ───────────────────────────── 紙上空戰:og-dogfight ─────────────────────────────
def make_dogfight():
    """構圖照 #18 orchestrator 第二次退回時直接給的座標(1200×630 畫布):
    摺線 y≈315;標題框在下半正中(x 330–870、y 420–590);開火的藍筆飛機從左下
    (200,470,原位置現在是空的)斜線打到上半正中偏右一架黑筆飛機(≈580,190,
    淡掉 + 藍色塗掉),線的盡頭(≈780,100)是那架藍筆飛機的新位置;另外兩架黑筆
    (300,150)(980,170)和兩架藍筆(130,545)(1030,520)完好,不碰標題框。"""
    img = Image.new("RGB", (W, H), DESK)
    d = ImageDraw.Draw(img)
    h_grid(d, 0, 0, W, H, 32, RULE_ON_DESK)

    # 桌面上撕下來的一張紙(#18 orchestrator 更正:整張圖不能都是紙,要看得到桌面
    # 跟撕過的紙邊)。紙的範圍留夠邊界,格線、摺線、飛機都畫在紙的裡面。
    px0, py0, px1, py1 = 55, 32, 1145, 610
    torn_sheet(d, px0, py0, px1, py1, SHEET, PENCIL, seed=200, amp=11)

    gx0, gx1 = px0 + 10, px1 - 10
    h_grid(d, gx0, py0 + 18, gx1, py1 - 14, 28, RULE_LIGHT)

    fold_y = 315
    dashed_line(d, gx0, fold_y, gx1, PENCIL, 2)

    scale = 4.0  # 開火 / 被打中 / 新位置這三架,≥ 1.5x(#18 orchestrator 的更正)
    deco_scale = 3.2  # 另外四架完好的裝飾用飛機

    # 完好的兩架黑筆(上半)、兩架藍筆(下半),都不碰標題框。
    draw_plane(d, 300, 150, 90, deco_scale, BLACK, seed=10)
    draw_plane(d, 980, 170, 90, deco_scale, BLACK, seed=17)
    draw_plane(d, 130, 545, -90, deco_scale, BLUE, seed=60)
    draw_plane(d, 1030, 520, -90, deco_scale, BLUE, seed=67)

    # 開火的藍筆飛機從左下出發(原位置現在是空的,只留線的起點),斜線往右上,
    # 從標題框上方經過(不能碰到框),打中上半正中偏右那架黑筆飛機,線的盡頭是
    # 開火那架飛機的新位置(rules.5:線的盡頭就是那架飛機的新位置)。
    shot_from = (200, 470)
    hit_pt = (577, 230)  # 被打中那架黑筆飛機,精準落在線上(orchestrator 給的是「大約」580,190)
    shot_to = (780, 100)

    for p0, p1 in ((shot_from, hit_pt), (hit_pt, shot_to)):
        n = 3
        for seg in range(n):
            t0, t1 = seg / n, (seg + 1) / n
            a = (p0[0] + (p1[0] - p0[0]) * t0, p0[1] + (p1[1] - p0[1]) * t0)
            b = (p0[0] + (p1[0] - p0[0]) * t1, p0[1] + (p1[1] - p0[1]) * t1)
            sketch_line(d, a, b, seed=90 + seg, color=BLUE, width=4, amp=2.2)

    # 被打中的那架黑筆飛機:照遊戲畫法(app.js 405–426)——整架淡成三成(alpha .3),
    # 再用開火那一方的筆色(這裡是藍)塗掉,不是紅叉(紅色在遊戲裡是老師的評語,不是打中的畫法)。
    dead_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dead_img)
    draw_plane(dd, hit_pt[0], hit_pt[1], 90, scale, BLACK, seed=20)
    dead_img.putalpha(dead_img.getchannel("A").point(lambda a: round(a * 0.3)))
    img.paste(dead_img, (0, 0), dead_img)
    d = ImageDraw.Draw(img)
    scribble(d, hit_pt[0], hit_pt[1], scale * 20, seed=120, color=BLUE, width=5)

    # 開火那架藍筆飛機:畫在線的盡頭(新位置),穿過敵機之後。
    draw_plane(d, shot_to[0], shot_to[1], -90, scale, BLUE, seed=140)

    # 標題框:下半正中央,中文標題落在正中間的 630×630 方塊裡(H 已經是 630,
    # x 落在 [285,915] 就一定在裁成正方形之後還看得到)。
    bx0, by0, bx1, by1 = 330, 420, 870, 590
    irregular_rect(d, bx0, by0, bx1, by1, SHEET, PENCIL, seed=3, width=5, jitter_amp=4)

    f_en = font(42)
    f_cn = font(80)
    cx = (bx0 + bx1) / 2
    y = by0 + 14
    text_centered(d, cx, y, "Paper Dogfight", f_en, PENCIL, spacing=3)
    y += text_height(d, "Paper Dogfight", f_en) + 16
    text_centered(d, cx, y, "紙上空戰", f_cn, PENCIL, spacing=12)

    # 一點紅:角落一個老師評語式的等第章(.df-grade 的樣子),裝飾用,不代表「打中」——
    # 放在桌面右下角,不擋任何東西。
    gx, gy, gr = 1170, 600, 22
    d.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], outline=RED, width=4)
    f_grade = font(26)
    bbox = d.textbbox((0, 0), "優", font=f_grade)
    d.text((gx - (bbox[2] - bbox[0]) / 2 - bbox[0], gy - (bbox[3] - bbox[1]) / 2 - bbox[1]), "優", font=f_grade, fill=RED)

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
