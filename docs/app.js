'use strict';

/* =========================================================
 * pH 试纸读数
 * 原理：取景框内取样 → 中值滤波求主色 → 白平衡校正
 *       → 转 CIELAB → 与色卡逐项算 ΔE2000 → 取最近的一格
 * ========================================================= */

const $ = (id) => document.getElementById(id);

/* 取样框的真实位置由屏幕几何换算得到，见 reticleSourceRect() */

/* ---------- 存储键 ---------- */
const LS_CHARTS = 'phstrip.charts.v1';
const LS_ACTIVE = 'phstrip.active.v1';
const LS_WB = 'phstrip.wb.v1';
const LS_RECORDS = 'phstrip.records.v1';
const LS_SEEDED = 'phstrip.seeded.v1';
const LS_RECT = 'phstrip.rect.v1';

/* ΔE 超过这个值，说明取到的颜色根本不在这张色卡上，不要硬报一个 pH */
const OUT_OF_RANGE = 15;

/* =========================================================
 * 颜色科学
 * ========================================================= */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function srgbToLinear(v) {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB(0-255) → CIELAB (D65) */
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 色差 */
function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const kL = 1, kC = 1, kH = 1;
  const rad = Math.PI / 180;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  let h1p = Math.atan2(b1, a1p) / rad;
  if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) / rad;
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;

  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * rad)
    + 0.24 * Math.cos(2 * hbarp * rad)
    + 0.32 * Math.cos((3 * hbarp + 6) * rad)
    - 0.20 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  const termL = dLp / (kL * SL);
  const termC = dCp / (kC * SC);
  const termH = dHp / (kH * SH);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + RT * termC * termH);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r, g, b) {
  const t = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + t(r) + t(g) + t(b);
}

/* =========================================================
 * 色卡数据
 * ========================================================= */
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 首次启动写入的内置色卡；之后存在本地，每条颜色和 pH 都能改 */
const DEFAULT_CHART = {
  id: 'universal',
  name: '广泛试纸 1–14',
  entries: [
      { ph: '1', hex: '#d0021b' },
      { ph: '2', hex: '#e8492e' },
      { ph: '3', hex: '#f2762e' },
      { ph: '4', hex: '#f7a233' },
      { ph: '5', hex: '#f7d038' },
      { ph: '6', hex: '#dfe63b' },
      { ph: '7', hex: '#7fc241' },
      { ph: '8', hex: '#3aa76d' },
      { ph: '9', hex: '#2f8fa3' },
      { ph: '10', hex: '#2f6bb0' },
      { ph: '11', hex: '#4a4fb0' },
      { ph: '12', hex: '#6f3fa5' },
      { ph: '13', hex: '#8f2f8f' },
      { ph: '14', hex: '#5e1a5e' },
  ],
};

/* =========================================================
 * 状态
 * ========================================================= */
const video = $('video');
const photo = $('photo');
const snap = document.createElement('canvas');
const snapCtx = snap.getContext('2d', { willReadFrequently: true });

let charts = [];              // 所有色卡，包括内置那张
let activeId = 'universal';
let wb = { r: 1, g: 1, b: 1 };
let frozen = false;
let mode = 'camera';           // camera | image
let lastTick = 0;
let records = [];              // 测量记录
let lastReading = null;        // 当前这一帧的读数，点「记录」时存下来
let reticle = { x: 0.20, y: 0.45, w: 0.60, h: 0.10 };   // 取样框，相对取景区的比例
let dragState = null;          // 拖动取样框时的临时状态
let pickingFor = null;         // { chartId, index } 正在用摄像头替换哪个色块

/* ---------- 持久化 ---------- */
function loadState() {
  try {
    charts = JSON.parse(localStorage.getItem(LS_CHARTS) || '[]');
  } catch (e) {
    charts = [];
  }
  if (!Array.isArray(charts)) charts = [];

  // 旧版本只存了自定义色卡，升级后补一次内置色卡
  if (!localStorage.getItem(LS_SEEDED)) {
    if (!charts.some((c) => c.id === 'universal')) {
      charts.unshift(clone(DEFAULT_CHART));
    }
    localStorage.setItem(LS_SEEDED, '1');
    saveCharts();
  }
  if (!charts.length) charts.push(clone(DEFAULT_CHART));

  activeId = localStorage.getItem(LS_ACTIVE) || charts[0].id;
  if (!charts.some((c) => c.id === activeId)) activeId = charts[0].id;

  try {
    wb = JSON.parse(localStorage.getItem(LS_WB) || '{"r":1,"g":1,"b":1}');
  } catch (e) {
    wb = { r: 1, g: 1, b: 1 };
  }
  try {
    records = JSON.parse(localStorage.getItem(LS_RECORDS) || '[]');
  } catch (e) {
    records = [];
  }
  try {
    const r = JSON.parse(localStorage.getItem(LS_RECT) || 'null');
    if (r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number')) {
      reticle = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  } catch (e) { /* 用默认框 */ }
}

function saveRecords() {
  localStorage.setItem(LS_RECORDS, JSON.stringify(records));
}

function saveCharts() {
  localStorage.setItem(LS_CHARTS, JSON.stringify(charts));
}

function activeChart() {
  return charts.find((c) => c.id === activeId) || charts[0];
}

/* =========================================================
 * 取色
 * ========================================================= */

/** 从 data 里求稳健主色：先中值，再剔除离群点求均值 */
function robustColor(data) {
  const rs = [], gs = [], bs = [];
  // 每 2 个像素取一个点，降低计算量
  for (let i = 0; i < data.length; i += 8) {
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  }
  const med = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  const mr = med(rs), mg = med(gs), mb = med(bs);

  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < data.length; i += 8) {
    const dr = data[i] - mr;
    const dg = data[i + 1] - mg;
    const db = data[i + 2] - mb;
    if (dr * dr + dg * dg + db * db < 2500) {   // 距离中值 50 以内
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      n++;
    }
  }
  if (!n) return [mr, mg, mb];
  return [sr / n, sg / n, sb / n];
}

/** 当前帧的来源（摄像头或图片） */
function frameSource() {
  if (mode === 'image' && photo.src && photo.naturalWidth) {
    return { src: photo, w: photo.naturalWidth, h: photo.naturalHeight, el: photo };
  }
  if (video.videoWidth) {
    return { src: video, w: video.videoWidth, h: video.videoHeight, el: video };
  }
  return null;
}

/**
 * 把屏幕上画着的取样框，换算成视频/图片原始像素坐标。
 * 因为 object-fit: cover 会把画面裁掉一部分，直接按比例算会取错位置。
 */
function reticleSourceRect() {
  const f = frameSource();
  if (!f) return null;
  const box = document.querySelector('.reticle-box');
  if (!box) return null;

  const vRect = f.el.getBoundingClientRect();
  const bRect = box.getBoundingClientRect();
  if (!vRect.width || !vRect.height) return null;

  const scale = Math.max(vRect.width / f.w, vRect.height / f.h);
  const offX = (vRect.width - f.w * scale) / 2;
  const offY = (vRect.height - f.h * scale) / 2;

  const sx = (bRect.left - vRect.left - offX) / scale;
  const sy = (bRect.top - vRect.top - offY) / scale;
  const sw = bRect.width / scale;
  const sh = bRect.height / scale;

  return {
    sx: clamp(Math.round(sx), 0, Math.max(0, f.w - 2)),
    sy: clamp(Math.round(sy), 0, Math.max(0, f.h - 2)),
    sw: clamp(Math.round(sw), 2, f.w),
    sh: clamp(Math.round(sh), 2, f.h),
    src: f.src,
  };
}

/** 在原始像素矩形内取样，返回原始 RGB（未做白平衡） */
function sampleAt(src, sx, sy, sw, sh) {
  snap.width = sw;
  snap.height = sh;
  snapCtx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return robustColor(snapCtx.getImageData(0, 0, sw, sh).data);
}

/** 取当前取样框内的颜色（已做白平衡） */
function sampleReticle() {
  const r = reticleSourceRect();
  if (!r) return null;
  const raw = sampleAt(r.src, r.sx, r.sy, r.sw, r.sh);
  return [raw[0] * wb.r, raw[1] * wb.g, raw[2] * wb.b];
}

/* =========================================================
 * 匹配
 * ========================================================= */
function matchAgainst(lab, chart) {
  return chart.entries
    .filter((e) => e.ph !== '' && e.ph !== null && !isNaN(parseFloat(e.ph)))
    .map((e) => {
      const [r, g, b] = hexToRgb(e.hex);
      return { ph: e.ph, hex: e.hex, dE: deltaE2000(lab, rgbToLab(r, g, b)) };
    })
    .sort((a, b) => a.dE - b.dE);
}

function confidenceOf(dE) {
  if (dE < 3) return { text: '可信度高', cls: 'ok' };
  if (dE < 8) return { text: '可信度中', cls: 'warn' };
  return { text: '可信度低', cls: 'bad' };
}

/* =========================================================
 * 渲染
 * ========================================================= */
function render() {
  const rgb = sampleReticle();
  if (!rgb) return;

  const [r, g, b] = rgb.map((v) => clamp(v, 0, 255));
  const hex = rgbToHex(r, g, b);
  const lab = rgbToLab(r, g, b);
  const chart = activeChart();
  const ranked = matchAgainst(lab, chart);
  const best = ranked[0];

  if (!best) {
    $('phNum').textContent = '--';
    $('matchLabel').textContent = '这张色卡还没有颜色';
    $('deltaE').textContent = 'ΔE —';
    return;
  }

  // 偏差过大时给近似值，但要明确标出来，别让人当成准确读数
  const outOfRange = best.dE > OUT_OF_RANGE;

  $('phNum').textContent = outOfRange ? `≈${best.ph}` : best.ph;
  $('phNum').classList.toggle('approx', outOfRange);

  $('matchSwatch').style.background = best.hex;
  $('matchSwatch').style.opacity = outOfRange ? '0.45' : '1';

  $('matchLabel').textContent = outOfRange
    ? '仅供参考 · 偏差较大'
    : `${best.ph}（${chart.name}）`;

  const conf = confidenceOf(best.dE);
  const dE = $('deltaE');
  dE.textContent = outOfRange
    ? `ΔE ${best.dE.toFixed(1)} · 建议按自己的比色卡录入`
    : `ΔE ${best.dE.toFixed(1)} · ${conf.text}`;
  dE.style.color = outOfRange
    ? 'var(--warn)'
    : conf.cls === 'ok' ? 'var(--ok)' : conf.cls === 'warn' ? 'var(--warn)' : 'var(--bad)';

  $('measured').textContent = outOfRange
    ? `取样颜色 ${hex} · 和色卡差得较多`
    : `取样颜色 ${hex}`;
  $('measured').style.color = outOfRange ? 'var(--muted)' : hex;

  lastReading = {
    ph: best.ph,
    dE: best.dE,
    hex,
    chart: chart.name,
    ok: !outOfRange,
  };

  // 前 3 候选
  const box = $('candidates');
  box.innerHTML = '';
  ranked.slice(0, 3).forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cand';
    el.innerHTML = `<i style="background:${c.hex}"></i>pH ${c.ph}<span class="muted">ΔE ${c.dE.toFixed(1)}</span>`;
    box.appendChild(el);
  });
}

/* =========================================================
 * 摄像头 / 图片
 * ========================================================= */
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    video.srcObject = stream;
    await video.play();
    mode = 'camera';
    setStatus('对准试纸，读数会自动刷新');
  } catch (err) {
    // 电脑没有摄像头时，退回用图片测试
    mode = 'image';
    setStatus('摄像头不可用，点这里选择一张试纸照片测试');
    $('status').style.cursor = 'pointer';
    $('status').onclick = () => $('filePick').click();
    console.warn('摄像头启动失败：', err);
  }
}

function setStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.onclick = null;
  el.style.cursor = 'default';
}

$('filePick').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  photo.src = URL.createObjectURL(file);
  photo.onload = () => {
    mode = 'image';
    video.classList.add('hidden');
    photo.classList.remove('hidden');
    updateGalleryButton();
    setStatus('相册图片：取景框内的区域会被取色');
    frozen = false;
    render();
  };
});

/* ---------- 相册 / 摄像头切换 ---------- */
function updateGalleryButton() {
  $('btnGallery').textContent = mode === 'image' ? '用摄像头' : '相册';
}

function backToCamera() {
  photo.src = '';
  photo.classList.add('hidden');
  video.classList.remove('hidden');
  mode = 'camera';
  updateGalleryButton();
  initCamera();
}

$('btnGallery').addEventListener('click', () => {
  if (mode === 'image') backToCamera();
  else $('filePick').click();
});

/* =========================================================
 * 主循环
 * ========================================================= */
function loop(ts) {
  requestAnimationFrame(loop);
  if (frozen) return;
  // 录入色卡时画布自己在刷新，主循环让出 CPU
  if (!$('editor').classList.contains('hidden')) return;
  if (ts - lastTick < 120) return;      // 约 8 帧/秒，省电
  lastTick = ts;
  if (!frameSource()) return;
  render();
}

/* =========================================================
 * 交互
 * ========================================================= */

/* 冻结 */
$('btnFreeze').addEventListener('click', () => {
  frozen = !frozen;
  $('btnFreeze').textContent = frozen ? '继续' : '冻结';
  if (frozen) render();
});

/* ---------- 取样框：拖动移动、拖四角缩放 ---------- */
function applyReticle() {
  const box = document.querySelector('.reticle-box');
  if (!box) return;
  box.style.left = (reticle.x * 100) + '%';
  box.style.top = (reticle.y * 100) + '%';
  box.style.width = (reticle.w * 100) + '%';
  box.style.height = (reticle.h * 100) + '%';
}

function saveReticle() {
  localStorage.setItem(LS_RECT, JSON.stringify(reticle));
}

(function setupReticleDrag() {
  const box = document.querySelector('.reticle-box');
  const stage = document.querySelector('.stage-wrap');
  if (!box || !stage) return;

  box.addEventListener('pointerdown', (e) => {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dragState = {
      mode: e.target.dataset.handle || 'move',
      startX: e.clientX,
      startY: e.clientY,
      rect: { ...reticle },
      W: r.width,
      H: r.height,
    };
    try { box.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    e.preventDefault();
  });

  box.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const MIN = 0.04;
    const dx = (e.clientX - dragState.startX) / dragState.W;
    const dy = (e.clientY - dragState.startY) / dragState.H;
    const r = dragState.rect;
    const m = dragState.mode;

    if (m === 'move') {
      reticle = {
        x: clamp(r.x + dx, 0, 1 - r.w),
        y: clamp(r.y + dy, 0, 1 - r.h),
        w: r.w,
        h: r.h,
      };
    } else {
      let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
      if (m.includes('l')) x0 = clamp(r.x + dx, 0, x1 - MIN);
      if (m.includes('r')) x1 = clamp(r.x + r.w + dx, x0 + MIN, 1);
      if (m.includes('t')) y0 = clamp(r.y + dy, 0, y1 - MIN);
      if (m.includes('b')) y1 = clamp(r.y + r.h + dy, y0 + MIN, 1);
      reticle = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    applyReticle();
  });

  const endDrag = () => {
    if (!dragState) return;
    dragState = null;
    saveReticle();
    render();
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);
})();

/* 白纸校准 */
$('btnCal').addEventListener('click', () => {
  const r = reticleSourceRect();
  if (!r) { setStatus('还没有画面'); return; }
  const raw = sampleAt(r.src, r.sx, r.sy, r.sw, r.sh);
  const target = 245;
  wb = {
    r: clamp(target / Math.max(raw[0], 1), 0.3, 3),
    g: clamp(target / Math.max(raw[1], 1), 0.3, 3),
    b: clamp(target / Math.max(raw[2], 1), 0.3, 3),
  };
  localStorage.setItem(LS_WB, JSON.stringify(wb));
  setStatus('校准完成，现在把试纸放进取景框');
  render();
});

/* ---------- 色卡管理 ---------- */
$('btnChart').addEventListener('click', () => {
  renderManage();
  $('sheet').classList.remove('hidden');
});
$('sheetClose').addEventListener('click', () => $('sheet').classList.add('hidden'));

$('chartSelect').addEventListener('change', (e) => {
  activeId = e.target.value;
  localStorage.setItem(LS_ACTIVE, activeId);
  $('chartName').textContent = activeChart().name;
  renderManage();
  render();
});

function renderManage() {
  const sel = $('chartSelect');
  sel.innerHTML = '';
  charts.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name}（${c.entries.length} 色）`;
    if (c.id === activeId) o.selected = true;
    sel.appendChild(o);
  });

  const box = $('entryManage');
  box.innerHTML = '';
  const chart = activeChart();

  if (!chart.entries.length) {
    box.innerHTML = '<div class="history-empty">这张色卡还没有色块</div>';
  }

  chart.entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'm-entry';
    row.innerHTML =
      `<span class="swatch small" style="background:${entry.hex}"></span>
       <span class="m-hex">${entry.hex}</span>
       <input class="m-ph" type="text" inputmode="decimal" value="${entry.ph}">
       <span class="m-unit">pH</span>
       <button class="m-recolor">重拍</button>
       <button class="m-del">×</button>`;

    const input = row.querySelector('.m-ph');
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v) { input.value = entry.ph; return; }
      chart.entries[i].ph = v;
      saveCharts();
      render();
    });

    // 用当前摄像头画面替换这个色块的颜色
    row.querySelector('.m-recolor').addEventListener('click', () => {
      pickingFor = { chartId: chart.id, index: i };
      $('sheet').classList.add('hidden');
      $('pickBar').classList.remove('hidden');
      setStatus('把取样框对准要替换的色块，再点「确定」');
    });

    row.querySelector('.m-del').addEventListener('click', () => {
      chart.entries.splice(i, 1);
      saveCharts();
      renderManage();
      render();
    });

    box.appendChild(row);
  });

  // 直接在这里新增一个空白色块：先填 pH，再用「重拍」取颜色
  const addBtn = document.createElement('button');
  addBtn.className = 'm-add';
  addBtn.textContent = '＋ 添加一个色块';
  addBtn.addEventListener('click', () => {
    chart.entries.push({ ph: '', hex: '#9aa3ad' });
    saveCharts();
    renderManage();
    render();
    const inputs = document.querySelectorAll('#entryManage .m-ph');
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  });
  box.appendChild(addBtn);
}

/* 新建色卡 / 给当前色卡添加色块 */
$('btnNewChart').addEventListener('click', () => openEditor('new'));
$('btnAddSwatch').addEventListener('click', () => openEditor('append'));

/* ---------- 用摄像头替换某个色块的颜色 ---------- */
$('pickCancel').addEventListener('click', () => {
  pickingFor = null;
  $('pickBar').classList.add('hidden');
  renderManage();
  $('sheet').classList.remove('hidden');
});

$('pickConfirm').addEventListener('click', () => {
  if (!pickingFor) return;
  const chart = charts.find((c) => c.id === pickingFor.chartId);
  const entry = chart && chart.entries[pickingFor.index];
  if (!entry) {
    pickingFor = null;
    $('pickBar').classList.add('hidden');
    return;
  }

  const rgb = sampleReticle();
  if (!rgb) { setStatus('还没有画面，无法取色'); return; }

  const [r, g, b] = rgb.map((v) => clamp(v, 0, 255));
  entry.hex = rgbToHex(r, g, b);
  saveCharts();

  pickingFor = null;
  $('pickBar').classList.add('hidden');
  renderManage();
  $('sheet').classList.remove('hidden');
  render();
  setStatus(`已把 pH ${entry.ph} 的色块改成 ${entry.hex}`);
});

/* 删除当前色卡 */
$('btnDelChart').addEventListener('click', () => {
  if (charts.length <= 1) { alert('至少要保留一张色卡'); return; }
  const name = activeChart().name;
  if (!confirm(`删除色卡「${name}」？删掉后无法恢复`)) return;
  charts = charts.filter((c) => c.id !== activeId);
  activeId = charts[0].id;
  localStorage.setItem(LS_ACTIVE, activeId);
  saveCharts();
  $('chartName').textContent = activeChart().name;
  renderManage();
  render();
});

/* 导出 / 导入 JSON */
$('btnExport').addEventListener('click', async () => {
  const ok = await copyText(JSON.stringify(charts, null, 2));
  setStatus(ok ? '色卡 JSON 已复制到剪贴板' : '复制失败');
});

$('btnImport').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.charts;
    if (!Array.isArray(list)) throw new Error('不是色卡文件');

    let n = 0;
    list.forEach((c) => {
      if (!c || !c.name || !Array.isArray(c.entries)) return;
      const entries = c.entries.filter(
        (x) => x && x.hex && x.ph !== undefined && x.ph !== ''
      );
      if (!entries.length) return;
      charts.push({ id: 'import-' + Date.now() + '-' + n, name: c.name, entries });
      n++;
    });
    if (!n) throw new Error('文件里没有可用的色卡');

    saveCharts();
    renderManage();
    alert(`已导入 ${n} 张色卡`);
  } catch (err) {
    alert('导入失败：' + err.message);
  }
  e.target.value = '';
});

/* ---------- 色块录入 ---------- */
let editorEntries = [];
let pendingPick = null;
let editorMode = 'new';        // new = 新建色卡，append = 给当前色卡加色块
let editorLive = false;        // 编辑时摄像头是否保持实时
let editorTimer = null;
let editorImage = null;        // 编辑器里用的相册图片
let editorReady = false;       // 画布上是否有可点的画面

/** 让录入画布跟随摄像头刷新，这样不用先对好再点按钮 */
function startEditorLive() {
  if (mode !== 'camera') return;
  stopEditorLive();
  editorLive = true;

  editorTimer = setInterval(() => {
    const f = frameSource();
    const c = $('editorCanvas');
    if (!f || !c) return;
    if (c.width !== f.w || c.height !== f.h) {
      c.width = f.w;
      c.height = f.h;
    }
    c.getContext('2d').drawImage(f.src, 0, 0, f.w, f.h);
  }, 120);
}

function stopEditorLive() {
  editorLive = false;
  if (editorTimer) clearInterval(editorTimer);
  editorTimer = null;
}

$('btnAddChart').addEventListener('click', () => openEditor('new'));
$('editorCancel').addEventListener('click', () => {
  stopEditorLive();
  $('editor').classList.add('hidden');
  $('sheet').classList.remove('hidden');
});

function openEditor(mode) {
  editorMode = mode === 'append' ? 'append' : 'new';

  stopEditorLive();
  editorImage = null;
  editorReady = false;

  const c = $('editorCanvas');
  const f = frameSource();

  if (f) {
    c.width = f.w;
    c.height = f.h;
    c.getContext('2d').drawImage(f.src, 0, 0, f.w, f.h);
    editorReady = true;
  } else {
    // 没有任何画面时也能打开，先提示去相册选图
    c.width = 600;
    c.height = 400;
    const g = c.getContext('2d');
    g.fillStyle = '#1a222c';
    g.fillRect(0, 0, 600, 400);
    g.fillStyle = '#7d8b9a';
    g.font = '20px "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    g.fillText('点「从相册选图」选择一张比色卡照片', 300, 200);
  }

  $('editorCamera').classList.toggle('hidden', mode !== 'camera');

  editorEntries = [];
  pendingPick = null;
  $('newChartName').value = '';
  $('entryList').innerHTML = '';
  $('pickForm').classList.add('hidden');

  $('editorTitle').textContent = editorMode === 'new'
    ? '新建色卡'
    : `添加色块到「${activeChart().name}」`;
  $('nameField').classList.toggle('hidden', editorMode !== 'new');

  $('sheet').classList.add('hidden');
  $('editor').classList.remove('hidden');

  // 摄像头模式下让录入画布持续刷新，不用先对好再点按钮
  startEditorLive();
}

/* ---------- 编辑器里从相册选图 ---------- */
$('editorGallery').addEventListener('click', () => $('editorFilePick').click());

$('editorFilePick').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const img = new Image();
  img.onload = () => {
    stopEditorLive();
    editorImage = img;
    editorReady = true;

    const c = $('editorCanvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);

    $('editorCamera').classList.toggle('hidden', mode !== 'camera');
    setStatus('已载入相册图片，点色块取色');
  };
  img.onerror = () => setStatus('这张图片打不开，换一张试试');
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});

$('editorCamera').addEventListener('click', () => {
  const f = frameSource();
  if (!f || mode !== 'camera') { setStatus('当前没有摄像头画面'); return; }

  editorImage = null;
  editorReady = true;

  const c = $('editorCanvas');
  c.width = f.w;
  c.height = f.h;
  c.getContext('2d').drawImage(f.src, 0, 0, f.w, f.h);

  startEditorLive();
});

$('editorCanvas').addEventListener('click', (ev) => {
  if (!editorReady) { setStatus('先点「从相册选图」选一张照片'); return; }

  const c = $('editorCanvas');
  const rect = c.getBoundingClientRect();
  const x = Math.round(((ev.clientX - rect.left) / rect.width) * c.width);
  const y = Math.round(((ev.clientY - rect.top) / rect.height) * c.height);

  // 以点击点为中心取 15×15 的块
  const s = 15;
  const sx = clamp(x - (s >> 1), 0, c.width - s);
  const sy = clamp(y - (s >> 1), 0, c.height - s);
  const data = c.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, s, s).data;
  const [r, g, b] = robustColor(data);

  pendingPick = rgbToHex(r, g, b);
  $('pickSwatch').style.background = pendingPick;
  $('pickHex').textContent = pendingPick;
  $('pickPh').value = '';
  $('pickForm').classList.remove('hidden');
  $('pickPh').focus();
});

$('pickOk').addEventListener('click', () => {
  if (!pendingPick) return;
  const ph = $('pickPh').value.trim();
  if (!ph) { $('pickPh').focus(); return; }
  editorEntries.push({ ph, hex: pendingPick });
  pendingPick = null;
  $('pickForm').classList.add('hidden');
  renderEntries();
});

function renderEntries() {
  const box = $('entryList');
  box.innerHTML = '';
  editorEntries.forEach((e, i) => {
    const el = document.createElement('div');
    el.className = 'entry';
    el.innerHTML = `<i style="background:${e.hex}"></i>pH ${e.ph}<button>×</button>`;
    el.querySelector('button').onclick = () => {
      editorEntries.splice(i, 1);
      renderEntries();
    };
    box.appendChild(el);
  });
}

$('editorSave').addEventListener('click', () => {
  if (!editorEntries.length) { alert('还没有点选任何色块'); return; }

  const sorted = editorEntries
    .slice()
    .sort((a, b) => parseFloat(a.ph) - parseFloat(b.ph));

  if (editorMode === 'new') {
    const name = $('newChartName').value.trim();
    if (!name) { alert('请先填色卡名称'); return; }
    if (sorted.length < 2) { alert('至少录入 2 个色块'); return; }

    const chart = { id: 'custom-' + Date.now(), name, entries: sorted };
    charts.push(chart);
    activeId = chart.id;
  } else {
    const chart = activeChart();
    chart.entries = chart.entries
      .concat(sorted)
      .sort((a, b) => parseFloat(a.ph) - parseFloat(b.ph));
  }

  saveCharts();
  localStorage.setItem(LS_ACTIVE, activeId);
  $('chartName').textContent = activeChart().name;

  stopEditorLive();
  $('editor').classList.add('hidden');
  renderManage();
  $('sheet').classList.remove('hidden');
  render();
});

/* =========================================================
 * 记录与历史
 * ========================================================= */
function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

$('btnSave').addEventListener('click', () => {
  if (!lastReading) { setStatus('还没有读数，先把试纸放进取景框'); return; }
  records.unshift({ ...lastReading, t: Date.now() });
  if (records.length > 500) records.length = 500;
  saveRecords();
  setStatus(lastReading.ok
    ? `已记录 pH ${lastReading.ph}`
    : `已记录 ≈pH ${lastReading.ph}（仅供参考）`);
});

$('btnNotice').addEventListener('click', () => $('notice').classList.remove('hidden'));
$('noticeClose').addEventListener('click', () => $('notice').classList.add('hidden'));

$('btnHistory').addEventListener('click', () => {
  renderHistory();
  $('history').classList.remove('hidden');
});
$('historyClose').addEventListener('click', () => $('history').classList.add('hidden'));

$('historyClear').addEventListener('click', () => {
  if (!records.length) return;
  if (!confirm('清空所有记录？清空后无法恢复')) return;
  records = [];
  saveRecords();
  renderHistory();
});

$('historyExport').addEventListener('click', async () => {
  if (!records.length) { alert('还没有记录'); return; }
  const ok = await copyText(toCsv());
  setStatus(ok ? 'CSV 已复制到剪贴板，可以粘贴到微信或表格里' : '复制失败，请长按下方文本手动复制');
});

function toCsv() {
  const head = '时间,pH,色差ΔE,取样颜色,色卡,状态';
  const rows = records.map((r) => [
    formatTime(r.t),
    r.ok ? r.ph : '≈' + r.ph,
    r.dE.toFixed(1),
    r.hex,
    r.chart,
    r.ok ? '正常' : '超出范围',
  ].join(','));
  return [head, ...rows].join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // 老 WebView 不支持剪贴板 API 时退回选中复制
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

function renderHistory() {
  const box = $('historyList');
  box.innerHTML = '';
  if (!records.length) {
    box.innerHTML = '<div class="history-empty">还没有记录。对准试纸后点「记录」保存。</div>';
    return;
  }
  records.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'record';
    el.innerHTML =
      `<i style="background:${r.hex}"></i>
       <div class="r-main">
         <div class="r-ph">${r.ok ? 'pH ' + r.ph : '≈' + r.ph + ' · 仅供参考'}</div>
         <div class="r-meta">${formatTime(r.t)} · ΔE ${r.dE.toFixed(1)} · ${r.chart}</div>
       </div>
       <button>删除</button>`;
    el.querySelector('button').onclick = () => {
      records.splice(i, 1);
      saveRecords();
      renderHistory();
    };
    box.appendChild(el);
  });
}

/* =========================================================
 * 启动
 * ========================================================= */
loadState();
applyReticle();
$('chartName').textContent = activeChart().name;
updateGalleryButton();
initCamera();
requestAnimationFrame(loop);
