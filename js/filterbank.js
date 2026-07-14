// Filter-bank layout: band centre frequencies, default Q values, and band
// edges used both for analyzer binning and for drawing the per-band bars.

export const FMIN = 31.25; // Hz, lowest band centre for log progression
export const FMIN_LINEAR = 100; // Hz, lowest band centre for linear progression

// Highest usable centre frequency. Peaking biquads become unreliable close to
// Nyquist (the RBJ bilinear-transform design warps the bandwidth), so clamp
// centres to 0.42 * fs (~20.16 kHz at 48 kHz).
export function fmax(sampleRate) {
  return Math.min(20000, 0.42 * sampleRate);
}

// Centre frequencies for n bands with 'log' or 'linear' progression.
export function centerFrequencies(n, progression, sampleRate) {
  const hi = fmax(sampleRate);
  const freqs = [];
  if (n === 1) return [1000];
  if (progression === 'linear') {
    const lo = FMIN_LINEAR;
    for (let i = 0; i < n; i++) freqs.push(lo + (i * (hi - lo)) / (n - 1));
  } else {
    const lo = FMIN;
    const ratio = Math.pow(hi / lo, 1 / (n - 1));
    for (let i = 0; i < n; i++) freqs.push(lo * Math.pow(ratio, i));
  }
  return freqs.map((f) => Math.round(f * 100) / 100);
}

// Default Q so adjacent bands cross near their edges.
// Log spacing (ratio r between centres): Q = sqrt(r) / (r - 1).
// Linear spacing (step d): Q_i = f_i / d (constant absolute bandwidth).
export function defaultQs(freqs, progression) {
  const n = freqs.length;
  if (n < 2) return [1.0];
  if (progression === 'linear') {
    const d = freqs[1] - freqs[0];
    return freqs.map((f) => Math.max(0.3, Math.min(16, f / d)));
  }
  const r = freqs[1] / freqs[0];
  const q = Math.sqrt(r) / (r - 1);
  return freqs.map(() => Math.max(0.3, Math.min(16, q)));
}

// Band edges for analyzer binning / bar drawing: midpoints between adjacent
// centres (geometric for log, arithmetic for linear), extrapolated at the ends
// and clamped to [20 Hz, Nyquist].
export function bandEdges(freqs, progression, sampleRate) {
  const n = freqs.length;
  const nyq = sampleRate / 2;
  const mid = (a, b) => (progression === 'linear' ? (a + b) / 2 : Math.sqrt(a * b));
  const edges = new Array(n + 1);
  for (let i = 1; i < n; i++) edges[i] = mid(freqs[i - 1], freqs[i]);
  if (n > 1) {
    edges[0] = progression === 'linear'
      ? freqs[0] - (edges[1] - freqs[0])
      : (freqs[0] * freqs[0]) / edges[1];
    edges[n] = progression === 'linear'
      ? freqs[n - 1] + (freqs[n - 1] - edges[n - 1])
      : (freqs[n - 1] * freqs[n - 1]) / edges[n - 1];
  } else {
    edges[0] = freqs[0] / Math.SQRT2;
    edges[1] = freqs[0] * Math.SQRT2;
  }
  edges[0] = Math.max(20, edges[0]);
  edges[n] = Math.min(nyq, edges[n]);
  return edges;
}

// Fresh band parameter set (flat gains) for the given layout.
export function makeBands(n, progression, sampleRate) {
  const freqs = centerFrequencies(n, progression, sampleRate);
  const qs = defaultQs(freqs, progression);
  return freqs.map((f, i) => ({ freq: f, gain: 0, q: Math.round(qs[i] * 100) / 100 }));
}
