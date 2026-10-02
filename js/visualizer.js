/* Spectrum → animated shapes. Bands groups FFT bins (in dB) into log-spaced bars with
   attack/release smoothing and falling peak caps; the draw* helpers paint them. */
const Viz = (() => {
  const TAU = Math.PI * 2;

  class Bands {
    constructor(count, fMin = 40, fMax = 16000) {
      this.count = count;
      this.fMin = fMin;
      this.fMax = fMax;
      this.values = new Float32Array(count);
      this.peaks = new Float32Array(count);
      this.hold = new Float32Array(count);
      this.fall = new Float32Array(count);
      this.key = '';
    }

    build(binCount, sampleRate) {
      const key = binCount + '@' + sampleRate;
      if (key === this.key) return;
      this.key = key;
      const n = this.count;
      const hzPerBin = sampleRate / 2 / binCount;
      const ratio = this.fMax / this.fMin;
      this.lo = new Uint16Array(n);
      this.hi = new Uint16Array(n);
      this.tilt = new Float32Array(n);
      this.center = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f0 = this.fMin * ratio ** (i / n);
        const f1 = this.fMin * ratio ** ((i + 1) / n);
        const lo = Math.max(1, Math.round(f0 / hzPerBin));
        this.lo[i] = lo;
        this.hi[i] = Math.min(binCount, Math.max(lo + 1, Math.round(f1 / hzPerBin)));
        this.center[i] = Math.sqrt(f0 * f1);
        // music energy falls off with frequency; tilt so highs still move without flattening the bass
        const oct = Math.log2(this.center[i] / 1000);
        this.tilt[i] = oct > 0 ? 3 * oct : 1.5 * oct;
      }
    }

    /* freq: Float32Array of dB values (or null for silence); dt in seconds */
    update(freq, dt, { floor = -80, ceil = -24, smoothing = 0.6 } = {}) {
      const n = this.count, span = ceil - floor;
      const attack = 1 - Math.exp(-dt / 0.025);
      const release = 1 - Math.exp(-dt / (0.06 + smoothing * 0.32));
      for (let i = 0; i < n; i++) {
        let target = 0;
        if (freq) {
          let m = -Infinity;
          for (let k = this.lo[i]; k < this.hi[i]; k++) if (freq[k] > m) m = freq[k];
          target = (m + this.tilt[i] - floor) / span;
          target = target > 0 ? Math.min(1, target) ** 1.4 : 0;
        }
        const v = this.values[i];
        this.values[i] = v + (target - v) * (target > v ? attack : release);

        const cur = this.values[i];
        if (cur >= this.peaks[i]) {
          this.peaks[i] = cur;
          this.hold[i] = 0.35;
          this.fall[i] = 0;
        } else if (this.hold[i] > 0) {
          this.hold[i] -= dt;
        } else {
          this.fall[i] += 2.4 * dt;
          this.peaks[i] = Math.max(cur, this.peaks[i] - this.fall[i] * dt);
        }
      }
    }

    energy(from, to) {
      let s = 0;
      for (let i = from; i < to; i++) s += this.values[i];
      return s / (to - from);
    }

    get idle() {
      for (let i = 0; i < this.count; i++) if (this.values[i] > 0.003 || this.peaks[i] > 0.003) return false;
      return true;
    }
  }

  /* ---------- helpers ---------- */
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function alpha(hex, a) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /* Sizes a canvas to its CSS box × devicePixelRatio; returns its CSS size */
  function fit(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  /* ---------- panel: bars / mirror / wave ---------- */
  function drawPanel(canvas, bands, c, mode) {
    const s = fit(canvas);
    if (!s) return;
    const { g, w, h } = s;
    g.clearRect(0, 0, w, h);
    if (mode === 'wave') return drawWave(g, w, h, bands, c);

    const n = bands.count;
    const step = w / n;
    const bw = Math.max(2, step * 0.56);
    const pad = 2;
    const full = h - pad * 2;
    const mirror = mode === 'mirror';

    g.fillStyle = c.slot;
    for (let i = 0; i < n; i++) {
      roundRect(g, i * step + (step - bw) / 2, pad, bw, full, bw / 2);
      g.fill();
    }

    const grad = g.createLinearGradient(0, pad, 0, h - pad);
    if (mirror) {
      grad.addColorStop(0, c.a2);
      grad.addColorStop(0.5, c.a1);
      grad.addColorStop(1, c.a2);
    } else {
      grad.addColorStop(0, c.a2);
      grad.addColorStop(1, c.a1);
    }
    g.save();
    g.fillStyle = grad;
    g.shadowColor = c.glow;
    g.shadowBlur = 8;
    for (let i = 0; i < n; i++) {
      const bh = bw + bands.values[i] * (full - bw);
      const x = i * step + (step - bw) / 2;
      const y = mirror ? (h - bh) / 2 : h - pad - bh;
      roundRect(g, x, y, bw, bh, bw / 2);
      g.fill();
    }
    g.restore();

    // falling peak caps
    g.fillStyle = c.a2;
    const cap = Math.max(2, bw * 0.34);
    for (let i = 0; i < n; i++) {
      const p = bands.peaks[i];
      if (p < 0.04) continue;
      const ph = bw + p * (full - bw);
      const x = i * step + (step - bw) / 2;
      if (mirror) {
        roundRect(g, x, (h - ph) / 2 - cap - 2, bw, cap, cap / 2); g.fill();
        roundRect(g, x, (h + ph) / 2 + 2, bw, cap, cap / 2); g.fill();
      } else {
        const y = Math.max(0, h - pad - ph - cap - 2);
        roundRect(g, x, y, bw, cap, cap / 2); g.fill();
      }
    }
  }

  function wavePath(g, pts) {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    g.lineTo(last[0], last[1]);
  }

  function drawWave(g, w, h, bands, c) {
    const n = bands.count;
    const top = 10, bottom = h - 3;
    const pts = [[0, bottom - bands.values[0] * (bottom - top) * 0.7]];
    let peakIdx = 1;
    for (let i = 0; i < n; i++) {
      pts.push([((i + 0.5) / n) * w, bottom - bands.values[i] * (bottom - top)]);
      if (pts[i + 1][1] < pts[peakIdx][1]) peakIdx = i + 1;
    }
    pts.push([w, bottom - bands.values[n - 1] * (bottom - top) * 0.7]);

    const fill = g.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, alpha(c.a1, 0.85));
    fill.addColorStop(1, alpha(c.a1, 0.05));
    g.beginPath();
    wavePath(g, pts);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.closePath();
    g.fillStyle = fill;
    g.fill();

    g.save();
    g.beginPath();
    wavePath(g, pts);
    g.strokeStyle = c.a2;
    g.lineWidth = 2;
    g.shadowColor = c.glow;
    g.shadowBlur = 8;
    g.stroke();
    g.restore();

    // a soft "knob" riding the highest point, like the reference
    const [px, py] = pts[peakIdx];
    if (bottom - py > 6) {
      g.save();
      g.shadowColor = c.glow;
      g.shadowBlur = 10;
      g.fillStyle = c.knob;
      g.beginPath();
      g.arc(px, py, 5, 0, TAU);
      g.fill();
      g.restore();
    }
  }

  /* ---------- radial spokes around the orb ---------- */
  function drawRadial(canvas, bands, c, pulse) {
    const s = fit(canvas);
    if (!s) return;
    const { g, w } = s;
    g.clearRect(0, 0, w, w);
    const cx = w / 2;
    const n = bands.count, total = n * 2;
    const r0 = w * (0.27 + 0.025 * pulse);
    const maxLen = w * 0.18;
    const grad = g.createRadialGradient(cx, cx, r0, cx, cx, r0 + maxLen);
    grad.addColorStop(0, c.a1);
    grad.addColorStop(1, c.a2);
    g.strokeStyle = grad;
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, w * 0.016);
    for (let k = 0; k < total; k++) {
      const i = k < n ? k : total - 1 - k; // mirror left/right
      const v = bands.values[i];
      const a = -Math.PI / 2 + ((k + 0.5) / total) * TAU;
      const len = 1 + v * maxLen;
      const cos = Math.cos(a), sin = Math.sin(a);
      g.globalAlpha = 0.28 + 0.72 * v;
      g.beginPath();
      g.moveTo(cx + cos * r0, cx + sin * r0);
      g.lineTo(cx + cos * (r0 + len), cx + sin * (r0 + len));
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /* ---------- EQ response curve + live spectrum ---------- */
  function drawEq(canvas, { freqs, curve, dots, bands, enabled }, c) {
    const s = fit(canvas);
    if (!s) return;
    const { g, w, h } = s;
    g.clearRect(0, 0, w, h);
    const fMin = 20, fMax = 20000;
    const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
    const mid = h / 2;
    const yOf = (db) => mid - (db / 12) * (mid - 10);

    // grid
    g.lineWidth = 1;
    g.strokeStyle = c.line;
    g.fillStyle = c.muted;
    g.font = '9px ' + c.font;
    for (const db of [-12, -6, 6, 12]) {
      g.beginPath(); g.moveTo(0, yOf(db)); g.lineTo(w, yOf(db)); g.stroke();
    }
    for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
      const x = xOf(f);
      g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke();
      g.fillText(label, x + 4, h - 6);
    }
    g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
    g.setLineDash([]);

    // live spectrum
    if (bands && !bands.idle) {
      const pts = [];
      for (let i = 0; i < bands.count; i++) pts.push([xOf(bands.center[i]), h - bands.values[i] * (h - 8)]);
      g.beginPath();
      g.moveTo(pts[0][0], h);
      for (const [x, y] of pts) g.lineTo(x, y);
      g.lineTo(pts[pts.length - 1][0], h);
      g.closePath();
      g.fillStyle = alpha(c.a1, 0.22);
      g.fill();
    }

    // response curve
    g.globalAlpha = enabled ? 1 : 0.35;
    const area = g.createLinearGradient(0, 0, 0, h);
    area.addColorStop(0, alpha(c.a1, 0.3));
    area.addColorStop(0.5, alpha(c.a1, 0.05));
    area.addColorStop(1, alpha(c.a1, 0.3));
    g.beginPath();
    g.moveTo(0, mid);
    for (let i = 0; i < freqs.length; i++) g.lineTo(xOf(freqs[i]), yOf(curve[i]));
    g.lineTo(w, mid);
    g.closePath();
    g.fillStyle = area;
    g.fill();

    g.save();
    g.beginPath();
    for (let i = 0; i < freqs.length; i++) {
      const x = xOf(freqs[i]), y = yOf(curve[i]);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = c.a2;
    g.lineWidth = 2.4;
    g.lineJoin = 'round';
    g.shadowColor = c.glow;
    g.shadowBlur = 8;
    g.stroke();
    g.restore();

    g.fillStyle = c.knob;
    g.strokeStyle = c.a2;
    g.lineWidth = 2;
    for (const [f, db] of dots) {
      g.beginPath();
      g.arc(xOf(f), yOf(db), 3.5, 0, TAU);
      g.fill();
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  return { Bands, drawPanel, drawRadial, drawEq, fit };
})();
