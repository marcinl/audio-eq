// Canvas renderer for the dynamic EQ graph.
//
//  - one rectangular bar per filter band showing the current post-EQ level
//  - a peak-hold line on top of each bar; if the signal stays below the held
//    maximum, the hold is replaced by a fresh maximum after PEAK_HOLD_MS (3 s)
//  - combined EQ magnitude curve overlaid on a ±24 dB right-hand scale

import { bandEdges } from './filterbank.js';
import { cascadeMagnitudeDb } from './fir-designer.js';

const PEAK_HOLD_MS = 3000;
const MIN_DB = -90;
const MAX_DB = 0;
const CURVE_RANGE_DB = 24;

export class AnalyzerView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.bands = [];
    this.progression = 'log';
    this.sampleRate = 48000;
    this.levels = null;
    this.peaks = []; // {value, since}
    this._resize();
    new ResizeObserver(() => {
      this._resize();
      this.draw();
    }).observe(canvas.parentElement);
  }

  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(300, r.width) * dpr;
    this.canvas.height = 280 * dpr;
    this.canvas.style.height = '280px';
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = Math.max(300, r.width);
    this.h = 280;
  }

  configure(bands, progression, sampleRate) {
    this.bands = bands.map((b) => ({ ...b }));
    this.progression = progression;
    this.sampleRate = sampleRate;
    if (this.peaks.length !== bands.length) {
      this.peaks = bands.map(() => ({ value: MIN_DB, since: 0 }));
      this.levels = null;
    }
    this.draw();
  }

  update(levels) {
    const now = performance.now();
    this.levels = levels;
    for (let i = 0; i < levels.length; i++) {
      const p = this.peaks[i];
      if (levels[i] >= p.value) {
        p.value = levels[i];
        p.since = now;
      } else if (now - p.since >= PEAK_HOLD_MS) {
        // held max expired without being exceeded — reset to current level
        p.value = levels[i];
        p.since = now;
      }
    }
    this.draw();
  }

  resetPeaks() {
    for (const p of this.peaks) {
      p.value = MIN_DB;
      p.since = 0;
    }
  }

  // frequency -> x pixel (log or linear axis to match the progression)
  _x(f) {
    const pad = 44;
    const wid = this.w - pad - 44;
    const lo = 20;
    const hi = this.sampleRate / 2;
    let t;
    if (this.progression === 'linear') t = (f - lo) / (hi - lo);
    else t = Math.log(f / lo) / Math.log(hi / lo);
    return pad + Math.min(1, Math.max(0, t)) * wid;
  }

  _yLevel(db) {
    const t = (Math.min(MAX_DB, Math.max(MIN_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB);
    return this.h - 24 - t * (this.h - 48);
  }

  _yCurve(db) {
    const t = (Math.min(CURVE_RANGE_DB, Math.max(-CURVE_RANGE_DB, db)) + CURVE_RANGE_DB) / (2 * CURVE_RANGE_DB);
    return this.h - 24 - t * (this.h - 48);
  }

  draw() {
    const g = this.ctx2d;
    const css = getComputedStyle(document.documentElement);
    const col = (name, fb) => css.getPropertyValue(name).trim() || fb;
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = col('--graph-bg', '#10141c');
    g.fillRect(0, 0, this.w, this.h);
    if (!this.bands.length) return;

    // dB grid (left scale, signal level)
    g.font = '10px system-ui';
    g.textAlign = 'right';
    for (let db = MIN_DB; db <= MAX_DB; db += 15) {
      const y = this._yLevel(db);
      g.strokeStyle = col('--grid', '#252b38');
      g.beginPath();
      g.moveTo(44, y);
      g.lineTo(this.w - 44, y);
      g.stroke();
      g.fillStyle = col('--muted', '#6b7488');
      g.fillText(`${db}`, 40, y + 3);
    }
    // right scale for the EQ curve
    g.textAlign = 'left';
    for (let db = -CURVE_RANGE_DB; db <= CURVE_RANGE_DB; db += 12) {
      g.fillStyle = col('--accent2-dim', '#7a5f2a');
      g.fillText(`${db > 0 ? '+' : ''}${db}`, this.w - 38, this._yCurve(db) + 3);
    }

    const edges = bandEdges(this.bands.map((b) => b.freq), this.progression, this.sampleRate);

    // per-band bars + peak-hold lines
    for (let i = 0; i < this.bands.length; i++) {
      const x0 = this._x(edges[i]) + 1;
      const x1 = this._x(edges[i + 1]) - 1;
      const level = this.levels ? this.levels[i] : MIN_DB;
      const y = this._yLevel(level);
      g.fillStyle = col('--bar', '#2f7dd1');
      g.fillRect(x0, y, Math.max(1, x1 - x0), this.h - 24 - y);

      const p = this.peaks[i];
      if (p && p.value > MIN_DB) {
        g.strokeStyle = col('--peak', '#ff5d5d');
        g.lineWidth = 2;
        g.beginPath();
        const py = this._yLevel(p.value);
        g.moveTo(x0, py);
        g.lineTo(x1, py);
        g.stroke();
        g.lineWidth = 1;
      }
      // centre-frequency label
      const f = this.bands[i].freq;
      g.fillStyle = col('--muted', '#6b7488');
      g.textAlign = 'center';
      g.fillText(f >= 1000 ? (f / 1000).toFixed(1) + 'k' : f.toFixed(0),
        (x0 + x1) / 2, this.h - 10);
    }

    // combined EQ curve overlay
    const pts = 240;
    const freqs = [];
    for (let i = 0; i <= pts; i++) {
      const t = i / pts;
      const lo = 20;
      const hi = this.sampleRate / 2;
      freqs.push(this.progression === 'linear'
        ? lo + t * (hi - lo)
        : lo * Math.pow(hi / lo, t));
    }
    const curve = cascadeMagnitudeDb(this.bands, this.sampleRate, freqs);
    g.strokeStyle = col('--accent2', '#e8b64c');
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i <= pts; i++) {
      const x = this._x(freqs[i]);
      const y = this._yCurve(curve[i]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.lineWidth = 1;
  }
}
