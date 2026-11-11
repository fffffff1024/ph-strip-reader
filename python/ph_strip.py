#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pH 试纸读数 —— 网页版 app.js 的 Python 移植

算法与手机端完全一致：
    取样 → 各通道中值 → 剔除离群点求均值 → 白平衡校正
    → sRGB 转 CIELAB(D65) → 与色卡逐项算 CIEDE2000 → 取最近的一格

用法：
    python ph_strip.py                          # 打开图形界面
    python ph_strip.py 照片.jpg                  # 命令行分析，默认取画面中间横条
    python ph_strip.py 照片.jpg --rect 0.2,0.45,0.6,0.1
    python ph_strip.py 照片.jpg --chart 色卡.json --chart-index 1
    python ph_strip.py 照片.jpg --json           # 输出 JSON，方便别的程序调用

色卡 JSON 与手机 App 的「导出 JSON」格式完全相同，可以直接通用。

依赖：Pillow、numpy（图形界面额外用到 tkinter，Python 自带）
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from PIL import ImageTk
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    HAS_TK = True
except Exception:            # 没装 tkinter 时仍可用命令行
    HAS_TK = False

try:
    import cv2               # 只有装了 opencv-python 才能用摄像头
    HAS_CV2 = True
except Exception:
    HAS_CV2 = False


# =========================================================
# 颜色科学（与 app.js 一一对应）
# =========================================================

def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def srgb_to_linear(v):
    v = v / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb):
    """sRGB(0-255) → CIELAB (D65)"""
    r, g, b = rgb
    R, G, B = srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)

    X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375
    Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750
    Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041

    Xn, Yn, Zn = 0.95047, 1.0, 1.08883

    def f(t):
        return math.cbrt(t) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(X / Xn), f(Y / Yn), f(Z / Zn)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def delta_e_2000(lab1, lab2):
    """CIEDE2000 色差，与 app.js 的实现逐行对应"""
    L1, a1, b1 = lab1
    L2, a2, b2 = lab2
    kL = kC = kH = 1.0
    rad = math.pi / 180.0

    C1 = math.hypot(a1, b1)
    C2 = math.hypot(a2, b2)
    Cbar = (C1 + C2) / 2
    Cbar7 = Cbar ** 7
    G = 0.5 * (1 - math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)))

    a1p = (1 + G) * a1
    a2p = (1 + G) * a2
    C1p = math.hypot(a1p, b1)
    C2p = math.hypot(a2p, b2)

    h1p = math.degrees(math.atan2(b1, a1p))
    if h1p < 0:
        h1p += 360
    h2p = math.degrees(math.atan2(b2, a2p))
    if h2p < 0:
        h2p += 360

    dLp = L2 - L1
    dCp = C2p - C1p

    if C1p * C2p == 0:
        dhp = 0.0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    elif h2p - h1p > 180:
        dhp = h2p - h1p - 360
    else:
        dhp = h2p - h1p + 360

    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(dhp / 2 * rad)

    Lbarp = (L1 + L2) / 2
    Cbarp = (C1p + C2p) / 2

    if C1p * C2p == 0:
        hbarp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbarp = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        hbarp = (h1p + h2p + 360) / 2
    else:
        hbarp = (h1p + h2p - 360) / 2

    T = (1
         - 0.17 * math.cos((hbarp - 30) * rad)
         + 0.24 * math.cos(2 * hbarp * rad)
         + 0.32 * math.cos((3 * hbarp + 6) * rad)
         - 0.20 * math.cos((4 * hbarp - 63) * rad))

    dTheta = 30 * math.exp(-(((hbarp - 275) / 25) ** 2))
    Cbarp7 = Cbarp ** 7
    RC = 2 * math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7))
    SL = 1 + (0.015 * (Lbarp - 50) ** 2) / math.sqrt(20 + (Lbarp - 50) ** 2)
    SC = 1 + 0.045 * Cbarp
    SH = 1 + 0.015 * Cbarp * T
    RT = -math.sin(2 * dTheta * rad) * RC

    termL = dLp / (kL * SL)
    termC = dCp / (kC * SC)
    termH = dHp / (kH * SH)

    return math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + RT * termC * termH)


def hex_to_rgb(hex_str):
    h = hex_str.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hex(rgb):
    return "#" + "".join(
        f"{int(round(clamp(c, 0, 255))):02x}" for c in rgb
    )


# =========================================================
# 色卡
# =========================================================

DEFAULT_CHART = {
    "id": "universal",
    "name": "广泛试纸 1–14",
    "entries": [
        {"ph": "1", "hex": "#d0021b"},
        {"ph": "2", "hex": "#e8492e"},
        {"ph": "3", "hex": "#f2762e"},
        {"ph": "4", "hex": "#f7a233"},
        {"ph": "5", "hex": "#f7d038"},
        {"ph": "6", "hex": "#dfe63b"},
        {"ph": "7", "hex": "#7fc241"},
        {"ph": "8", "hex": "#3aa76d"},
        {"ph": "9", "hex": "#2f8fa3"},
        {"ph": "10", "hex": "#2f6bb0"},
        {"ph": "11", "hex": "#4a4fb0"},
        {"ph": "12", "hex": "#6f3fa5"},
        {"ph": "13", "hex": "#8f2f8f"},
        {"ph": "14", "hex": "#5e1a5e"},
    ],
}

# ΔE 超过这个值就认为颜色不在这张色卡上，只给近似值
OUT_OF_RANGE = 15.0


def load_charts(path):
    """读取色卡 JSON，兼容手机 App 导出的格式（数组或 {"charts": [...]}）"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("charts", [])
    charts = []
    for c in data:
        if not isinstance(c, dict) or not c.get("name"):
            continue
        entries = [
            e for e in c.get("entries", [])
            if isinstance(e, dict) and e.get("hex") and e.get("ph") not in (None, "")
        ]
        if entries:
            charts.append({"id": c.get("id", ""), "name": c["name"], "entries": entries})
    return charts


# =========================================================
# 取色与匹配
# =========================================================

def robust_color(pixels):
    """pixels: (N,3) 数组。先取各通道中值，再剔除离群点求均值"""
    pixels = np.asarray(pixels, dtype=np.float64)
    if pixels.ndim != 2 or pixels.shape[1] < 3 or len(pixels) == 0:
        return (0.0, 0.0, 0.0)

    med = np.median(pixels, axis=0)
    dist = ((pixels - med) ** 2).sum(axis=1)
    keep = pixels[dist < 2500]          # 距离中值 50 以内
    if len(keep) == 0:
        return tuple(med)
    return tuple(keep.mean(axis=0))


def sample_rect(img, rect):
    """rect 为图片像素坐标 (x0, y0, x1, y1)"""
    x0, y0, x1, y1 = rect
    crop = img.crop((int(x0), int(y0), int(x1), int(y1)))
    arr = np.asarray(crop.convert("RGB")).reshape(-1, 3)
    return robust_color(arr)


def apply_wb(rgb, wb):
    return tuple(clamp(c * g, 0, 255) for c, g in zip(rgb, wb))


def calibrate_white(img, rect, target=245.0):
    """用白纸区域算每个通道的增益"""
    raw = sample_rect(img, rect)
    return tuple(clamp(target / max(c, 1.0), 0.3, 3.0) for c in raw)


def match_chart(lab, chart):
    out = []
    for e in chart["entries"]:
        el = rgb_to_lab(hex_to_rgb(e["hex"]))
        out.append({"ph": e["ph"], "hex": e["hex"], "dE": delta_e_2000(lab, el)})
    out.sort(key=lambda x: x["dE"])
    return out


def analyze(img, rect, chart, wb=(1.0, 1.0, 1.0)):
    """核心分析，返回结果字典"""
    rgb = apply_wb(sample_rect(img, rect), wb)
    hex_str = rgb_to_hex(rgb)
    lab = rgb_to_lab(rgb)
    ranked = match_chart(lab, chart)

    if not ranked:
        return {"ok": False, "reason": "这张色卡还没有颜色", "hex": hex_str}

    best = ranked[0]
    out_of_range = best["dE"] > OUT_OF_RANGE

    return {
        "ok": True,
        "ph": best["ph"],
        "approx": out_of_range,
        "dE": best["dE"],
        "hex": hex_str,
        "chart": chart["name"],
        "candidates": ranked[:3],
    }


def confidence_text(dE):
    if dE < 3:
        return "可信度高"
    if dE < 8:
        return "可信度中"
    return "可信度低"


# =========================================================
# 命令行
# =========================================================

def run_cli(args):
    img = Image.open(args.image).convert("RGB")
    w, h = img.size

    x, y, rw, rh = [float(v) for v in args.rect.split(",")]
    rect = (x * w, y * h, (x + rw) * w, (y + rh) * h)

    charts = [DEFAULT_CHART]
    if args.chart:
        loaded = load_charts(args.chart)
        if not loaded:
            print(f"色卡文件里没有可用色卡：{args.chart}", file=sys.stderr)
            return 2
        charts = loaded

    if args.chart_index < 0 or args.chart_index >= len(charts):
        print(f"色卡序号超出范围，共 {len(charts)} 张", file=sys.stderr)
        return 2
    chart = charts[args.chart_index]

    wb = (1.0, 1.0, 1.0)
    if args.calibrate:
        cx, cy, cw, ch = [float(v) for v in args.calibrate.split(",")]
        wb = calibrate_white(img, (cx * w, cy * h, (cx + cw) * w, (cy + ch) * h))

    result = analyze(img, rect, chart, wb)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if not result.get("ok"):
        print(result.get("reason", "分析失败"))
        return 1

    sign = "≈" if result["approx"] else ""
    print(f"pH        : {sign}{result['ph']}")
    print(f"色差 ΔE   : {result['dE']:.1f}（{confidence_text(result['dE'])}）")
    print(f"取样颜色  : {result['hex']}")
    print(f"使用色卡  : {result['chart']}")
    if result["approx"]:
        print("提示      : 偏差较大，结果仅供参考；建议按自己的比色卡建一套色卡")
    print("候选      : " + "，".join(
        f"pH {c['ph']} (ΔE {c['dE']:.1f})" for c in result["candidates"]
    ))
    return 0


# =========================================================
# 图形界面
# =========================================================

BG = "#0b0f14"
PANEL = "#131a22"
LINE = "#232d38"
TEXT = "#e8eef5"
MUTED = "#7d8b9a"
ACCENT = "#3ea6ff"
OK = "#37d67a"
WARN = "#ffb020"
BAD = "#ff5c5c"
FONT = "Microsoft YaHei"


if HAS_TK:
    class PhApp(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title("pH 试纸读数 · Python 版")
            self.geometry("940x900")
            self.minsize(760, 700)
            self.configure(bg=BG)

            self.img = None
            self.tk_img = None
            self.scale = 1.0
            self.offset = (0, 0)
            self.rect = None            # 图片像素坐标
            self.drag_start = None
            self.charts = [DEFAULT_CHART]
            self.wb = (1.0, 1.0, 1.0)
            self.result = None

            self.cap = None             # cv2.VideoCapture
            self.camera_on = False
            self.cam_job = None
            self.frozen = False

            self._build_ui()
            self.protocol("WM_DELETE_WINDOW", self.on_close)
            self.after(60, self._load_initial)

        # ---------- 界面 ----------
        def _build_ui(self):
            top = tk.Frame(self, bg=BG)
            top.pack(side="top", fill="x", padx=12, pady=(12, 6))

            row1 = tk.Frame(top, bg=BG)
            row1.pack(fill="x")
            row2 = tk.Frame(top, bg=BG)
            row2.pack(fill="x", pady=(6, 0))

            tk.Button(row1, text="打开图片", command=self.open_image,
                      bg=PANEL, fg=TEXT, relief="flat", padx=14, pady=7,
                      activebackground=LINE, font=(FONT, 10)).pack(side="left")

            if HAS_CV2:
                self.cam_btn = tk.Button(
                    row1, text="打开摄像头", command=self.toggle_camera,
                    bg=PANEL, fg=TEXT, relief="flat", padx=12, pady=7,
                    activebackground=LINE, font=(FONT, 10))
                self.cam_btn.pack(side="left", padx=(8, 0))

                self.freeze_btn = tk.Button(
                    row1, text="冻结", command=self.toggle_freeze,
                    bg=PANEL, fg=TEXT, relief="flat", padx=12, pady=7,
                    activebackground=LINE, font=(FONT, 10))
                self.freeze_btn.pack(side="left", padx=(8, 0))

            tk.Button(row1, text="白纸校准", command=self.calibrate,
                      bg=PANEL, fg=TEXT, relief="flat", padx=12, pady=7,
                      activebackground=LINE, font=(FONT, 10)).pack(side="right")

            tk.Label(row2, text="色卡", bg=BG, fg=MUTED,
                     font=(FONT, 10)).pack(side="left")

            self.chart_var = tk.StringVar(value=self.charts[0]["name"])
            self.chart_box = ttk.Combobox(
                row2, textvariable=self.chart_var, state="readonly",
                values=[c["name"] for c in self.charts], width=24
            )
            self.chart_box.pack(side="left", padx=8)
            self.chart_box.bind("<<ComboboxSelected>>", lambda e: self.reanalyze())

            tk.Button(row2, text="载入色卡 JSON", command=self.open_chart_file,
                      bg=PANEL, fg=TEXT, relief="flat", padx=12, pady=7,
                      activebackground=LINE, font=(FONT, 10)).pack(side="left")

            bottom = tk.Frame(self, bg=BG)
            bottom.pack(side="bottom", fill="x", padx=16, pady=(4, 12))

            row = tk.Frame(bottom, bg=BG)
            row.pack(fill="x")

            self.ph_label = tk.Label(row, text="--", bg=BG, fg=TEXT,
                                     font=(FONT, 44, "bold"))
            self.ph_label.pack(side="left")

            self.swatch = tk.Label(row, text="", bg=PANEL, width=3, height=2)
            self.swatch.pack(side="left", padx=(18, 12))

            info = tk.Frame(row, bg=BG)
            info.pack(side="left", anchor="w")
            self.title_label = tk.Label(info, text="未识别", bg=BG, fg=TEXT,
                                        font=(FONT, 12, "bold"), anchor="w")
            self.title_label.pack(anchor="w")
            self.detail_label = tk.Label(info, text="ΔE —", bg=BG, fg=MUTED,
                                         font=(FONT, 10), anchor="w")
            self.detail_label.pack(anchor="w")

            self.hex_label = tk.Label(bottom, text="取样颜色 —", bg=BG, fg=MUTED,
                                      font=(FONT, 10), anchor="w")
            self.hex_label.pack(fill="x", pady=(8, 0))

            self.cand_label = tk.Label(bottom, text="", bg=BG, fg=MUTED,
                                       font=(FONT, 10), anchor="w", justify="left")
            self.cand_label.pack(fill="x", pady=(4, 0))

            self.status_label = tk.Label(
                bottom,
                text="点「打开图片」，然后在图上拖一个框把试纸变色区圈住",
                bg=BG, fg=MUTED, font=(FONT, 9), anchor="w", wraplength=840,
                justify="left"
            )
            self.status_label.pack(fill="x", pady=(8, 0))

            # 画布最后 pack：先让顶部工具栏和底部读数区占好位置，剩下的都给画布
            self.canvas = tk.Canvas(self, bg="#000000", highlightthickness=0)
            self.canvas.pack(side="top", fill="both", expand=True, padx=12, pady=6)
            self.canvas.bind("<Button-1>", self.on_press)
            self.canvas.bind("<B1-Motion>", self.on_drag)
            self.canvas.bind("<ButtonRelease-1>", self.on_release)
            self.canvas.bind("<Configure>", lambda e: self.render_image())

        # ---------- 图片 ----------
        def _load_initial(self):
            pass

        # ---------- 摄像头 ----------
        def toggle_camera(self):
            if self.camera_on:
                self.stop_camera()
            else:
                self.start_camera()

        def start_camera(self):
            if not HAS_CV2:
                messagebox.showwarning("没有 OpenCV", "先安装：pip install opencv-python")
                return
            if self.cap is not None:
                return

            backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else 0
            cap = cv2.VideoCapture(0, backend)
            if not cap.isOpened():
                cap.release()
                messagebox.showerror("打不开摄像头", "检查摄像头是否被其他程序占用")
                return

            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

            self.cap = cap
            self.camera_on = True
            self.frozen = False
            self.wb = (1.0, 1.0, 1.0)
            self.cam_btn.config(text="关闭摄像头")
            self.freeze_btn.config(text="冻结")
            self.status_label.config(text="把试纸变色区放进取样框，读数会自动刷新")

            ok, frame = cap.read()
            if ok:
                h, w = frame.shape[:2]
                self.rect = (w * 0.2, h * 0.45, w * 0.8, h * 0.55)

            self.camera_tick()

        def stop_camera(self):
            if self.cam_job is not None:
                self.after_cancel(self.cam_job)
                self.cam_job = None
            if self.cap is not None:
                self.cap.release()
                self.cap = None
            self.camera_on = False
            self.frozen = False
            if HAS_CV2:
                self.cam_btn.config(text="打开摄像头")
                self.freeze_btn.config(text="冻结")
            self.status_label.config(text="摄像头已关闭")

        def toggle_freeze(self):
            if not self.camera_on:
                return
            self.frozen = not self.frozen
            self.freeze_btn.config(text="继续" if self.frozen else "冻结")

        def camera_tick(self):
            if not self.camera_on or self.cap is None:
                return
            ok, frame = self.cap.read()
            if ok and not self.frozen:
                self.img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                if self.rect is None:
                    h, w = frame.shape[:2]
                    self.rect = (w * 0.2, h * 0.45, w * 0.8, h * 0.55)
                self.render_image()
                self.analyze()
            self.cam_job = self.after(100, self.camera_tick)

        def on_close(self):
            self.stop_camera()
            self.destroy()

        def open_image(self):
            if self.camera_on:
                self.stop_camera()
            path = filedialog.askopenfilename(
                title="选择试纸照片",
                filetypes=[("图片", "*.jpg *.jpeg *.png *.bmp *.webp"), ("所有文件", "*.*")]
            )
            if not path:
                return
            try:
                self.img = Image.open(path).convert("RGB")
            except Exception as e:
                messagebox.showerror("打不开图片", str(e))
                return

            w, h = self.img.size
            # 默认取中间一条，和手机端取景框一致
            self.rect = (w * 0.2, h * 0.45, w * 0.8, h * 0.55)
            self.wb = (1.0, 1.0, 1.0)
            self.render_image()
            self.analyze()
            self.status_label.config(
                text="在图上拖动可以重新框选取样区域；白纸校准请先把框拖到白纸上再点按钮"
            )

        def open_chart_file(self):
            path = filedialog.askopenfilename(
                title="选择色卡 JSON", filetypes=[("JSON", "*.json"), ("所有文件", "*.*")]
            )
            if not path:
                return
            try:
                charts = load_charts(path)
            except Exception as e:
                messagebox.showerror("读取失败", str(e))
                return
            if not charts:
                messagebox.showwarning("没有色卡", "这个文件里没有可用的色卡")
                return
            self.charts = charts
            self.chart_box["values"] = [c["name"] for c in charts]
            self.chart_var.set(charts[0]["name"])
            self.analyze()
            self.status_label.config(text=f"已载入 {len(charts)} 张色卡")

        def render_image(self):
            if self.img is None:
                return
            cw = max(self.canvas.winfo_width(), 10)
            ch = max(self.canvas.winfo_height(), 10)
            iw, ih = self.img.size
            self.scale = min(cw / iw, ch / ih)
            w, h = max(int(iw * self.scale), 1), max(int(ih * self.scale), 1)
            self.offset = ((cw - w) // 2, (ch - h) // 2)

            # 摄像头每 100ms 重绘一次，用双线性插值省 CPU
            resample = Image.BILINEAR if self.camera_on else Image.LANCZOS
            disp = self.img.resize((w, h), resample)
            self.tk_img = ImageTk.PhotoImage(disp)

            self.canvas.delete("all")
            self.canvas.create_image(self.offset[0], self.offset[1],
                                     anchor="nw", image=self.tk_img)
            self.draw_rect()

        def draw_rect(self):
            self.canvas.delete("rect")
            if self.rect is None:
                return
            x0, y0, x1, y1 = self.canvas_coords(self.rect)
            self.canvas.create_rectangle(x0, y0, x1, y1,
                                         outline="#ffffff", width=2, tags="rect")

        def canvas_coords(self, rect):
            ox, oy = self.offset
            s = self.scale
            return (ox + rect[0] * s, oy + rect[1] * s,
                    ox + rect[2] * s, oy + rect[3] * s)

        def to_image(self, cx, cy):
            ox, oy = self.offset
            s = self.scale or 1
            iw, ih = self.img.size
            return (clamp((cx - ox) / s, 0, iw), clamp((cy - oy) / s, 0, ih))

        # ---------- 鼠标 ----------
        def on_press(self, e):
            if self.img is None:
                return
            self.drag_start = self.to_image(e.x, e.y)
            self.rect = (*self.drag_start, *self.drag_start)
            self.draw_rect()

        def on_drag(self, e):
            if self.img is None or self.drag_start is None:
                return
            x, y = self.to_image(e.x, e.y)
            x0, y0 = self.drag_start
            self.rect = (min(x0, x), min(y0, y), max(x0, x), max(y0, y))
            self.draw_rect()

        def on_release(self, e):
            self.drag_start = None
            if self.rect and (self.rect[2] - self.rect[0] >= 4) and (self.rect[3] - self.rect[1] >= 4):
                self.analyze()

        # ---------- 分析 ----------
        def current_chart(self):
            name = self.chart_var.get()
            for c in self.charts:
                if c["name"] == name:
                    return c
            return self.charts[0]

        def analyze(self):
            if self.img is None or self.rect is None:
                return
            self.result = analyze(self.img, self.rect, self.current_chart(), self.wb)
            self.show_result()

        def reanalyze(self):
            self.analyze()

        def calibrate(self):
            if self.img is None or self.rect is None:
                self.status_label.config(text="先打开一张图片并框选白纸")
                return
            self.wb = calibrate_white(self.img, self.rect)
            self.analyze()
            self.status_label.config(text="校准完成，现在把框拖到试纸变色区")

        def show_result(self):
            r = self.result
            if not r:
                return
            if not r.get("ok"):
                self.ph_label.config(text="--", fg=TEXT)
                self.title_label.config(text=r.get("reason", "未识别"))
                self.detail_label.config(text="ΔE —", fg=MUTED)
                self.hex_label.config(text=f"取样颜色 {r.get('hex', '—')}")
                self.cand_label.config(text="")
                return

            dE = r["dE"]
            if r["approx"]:
                self.ph_label.config(text=f"≈{r['ph']}", fg=WARN)
                self.title_label.config(text="仅供参考 · 偏差较大", fg=TEXT)
                self.detail_label.config(
                    text=f"ΔE {dE:.1f} · 建议按自己的比色卡录入", fg=WARN)
            else:
                self.ph_label.config(text=str(r["ph"]), fg=TEXT)
                self.title_label.config(text=f"{r['ph']}（{r['chart']}）", fg=TEXT)
                self.detail_label.config(
                    text=f"ΔE {dE:.1f} · {confidence_text(dE)}",
                    fg=OK if dE < 3 else WARN if dE < 8 else BAD)

            self.swatch.config(bg=r["hex"])
            self.hex_label.config(text=f"取样颜色 {r['hex']}")
            self.cand_label.config(text="候选：" + "，".join(
                f"pH {c['ph']}（ΔE {c['dE']:.1f}）" for c in r["candidates"]
            ))


# =========================================================
# 入口
# =========================================================

def main():
    parser = argparse.ArgumentParser(
        description="pH 试纸读数（app.js 的 Python 版）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="不带参数运行会打开图形界面。"
    )
    parser.add_argument("image", nargs="?", help="试纸照片路径")
    parser.add_argument("--rect", default="0.2,0.45,0.6,0.1",
                        help="取样框，按图片宽高的比例：x,y,宽,高（默认 0.2,0.45,0.6,0.1）")
    parser.add_argument("--chart", help="色卡 JSON 文件（手机 App 导出的即可）")
    parser.add_argument("--chart-index", type=int, default=0, help="用文件里的第几张色卡，从 0 开始")
    parser.add_argument("--calibrate", help="白纸区域，比例：x,y,宽,高")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    if args.image:
        return run_cli(args)

    if not HAS_TK:
        parser.print_help()
        print("\n没有图形界面可用（缺少 tkinter），请用：python ph_strip.py 照片.jpg", file=sys.stderr)
        return 1

    app = PhApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
