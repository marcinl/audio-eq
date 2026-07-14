// Filter math shared by both phase modes.
//
// Minimum-phase mode uses native BiquadFilterNode ("peaking"), which implements
// the RBJ Audio-EQ-Cookbook peaking filter. The functions below reproduce that
// exact magnitude response analytically so that:
//   1. the linear-phase FIR is designed to the SAME target curve, and
//   2. the UI can overlay the combined EQ curve on the analyzer graph.
//
// Linear-phase design method: frequency sampling.
//   - evaluate the cascade magnitude |H(f)| at N uniformly spaced bins
//   - build a zero-phase, conjugate-symmetric spectrum
//   - IFFT -> real, even impulse response centred on sample 0
//   - circular shift by N/2 -> causal linear-phase FIR (latency N/2 samples)
//   - Hann window to suppress frequency-sampling ripple

import { ifft } from './fft.js';

// RBJ cookbook peaking-EQ coefficients, normalised so a0 = 1.
export function peakingCoeffs(fs, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cw = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cw) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

// |H(e^jw)| of one biquad at digital frequency w (rad/sample).
export function biquadMagnitudeAt(c, w) {
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = c.b1 * s1 + c.b2 * s2;
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = c.a1 * s1 + c.a2 * s2;
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

// Combined cascade magnitude (linear, not dB) at each frequency in `freqs` (Hz).
export function cascadeMagnitude(bands, fs, freqs) {
  const coeffs = bands.map((b) => peakingCoeffs(fs, b.freq, b.gain, b.q));
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / fs;
    let m = 1;
    for (const c of coeffs) m *= biquadMagnitudeAt(c, w);
    return m;
  });
}

// Same, in dB — used by the graph overlay.
export function cascadeMagnitudeDb(bands, fs, freqs) {
  return cascadeMagnitude(bands, fs, freqs).map((m) => 20 * Math.log10(Math.max(m, 1e-9)));
}

// Design a linear-phase FIR matching the cascade magnitude response.
// Returns Float32Array of `numTaps` samples (numTaps must be a power of 2).
// Group delay is numTaps/2 samples at every frequency.
export function designLinearPhaseFIR(bands, fs, numTaps) {
  const n = numTaps;
  const half = n / 2;
  const coeffs = bands.map((b) => peakingCoeffs(fs, b.freq, b.gain, b.q));

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Sample desired magnitude at bins 0..N/2, mirror for conjugate symmetry.
  for (let k = 0; k <= half; k++) {
    const w = (2 * Math.PI * k) / n; // rad/sample
    let m = 1;
    for (const c of coeffs) m *= biquadMagnitudeAt(c, w);
    re[k] = m;
    if (k > 0 && k < half) re[n - k] = m;
  }

  ifft(re, im); // zero-phase impulse, centred on index 0 (wrapping)

  // Circular shift by N/2 to make it causal, then apply a periodic Hann
  // window. The periodic form (denominator N, not N-1) is symmetric about
  // N/2 — the same axis the shifted impulse is symmetric about — preserving
  // exact Type-I linear phase, and it zeroes the unpaired tap 0.
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = (i + half) % n;
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    h[i] = re[src] * win;
  }
  return h;
}
