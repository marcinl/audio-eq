# Filter-bank design

## Structure: cascaded peaking biquads

The EQ is a **series (cascade) of N second-order peaking sections** — the
requested structure, and the right one for a *corrective* graphic/parametric
EQ:

- With all gains at 0 dB the cascade is exactly unity (each section degenerates
  to a pass-through) — no inter-band ripple, unlike parallel band-pass banks
  which never sum perfectly flat.
- Sections are independent: each band’s Frequency/Gain/Q maps 1:1 onto one
  biquad, so “complete user control per band” is literal.
- Cost is trivial: N biquads = 5N MACs/sample (≈ 0.015 % of one core for
  31 bands at 48 kHz), executed natively by `BiquadFilterNode`.

Alternatives considered and rejected: **parallel filter bank** (ripple in the
summed response, phase cancellation between bands), **FFT
overlap-add EQ** (block latency even in “minimum-phase” use, spectral leakage
management), **state-variable chains** (no advantage here since Web Audio’s
biquads already give sample-accurate parameter smoothing).

## Band sections: RBJ peaking EQ

Each section is the Audio-EQ-Cookbook (R. Bristow-Johnson) peaking filter —
which is also precisely what `BiquadFilterNode{type:'peaking'}` implements, so
the analytical model in `fir-designer.js` matches the running filters exactly.

With `A = 10^(G_dB/40)`, `ω₀ = 2π f₀/fs`, `α = sin ω₀ / (2Q)`:

```
b0 = 1 + αA        a0 = 1 + α/A
b1 = −2 cos ω₀     a1 = −2 cos ω₀
b2 = 1 − αA        a2 = 1 − α/A     (all normalised by a0)
```

Properties: gain `G` dB at `f₀`, unity at DC and Nyquist, symmetric boost/cut
(a +6 dB and −6 dB section at the same f₀/Q cancel exactly). `Q` here is the
classic bandwidth Q: bandwidth between half-gain points ≈ `f₀/Q`.

Parameter ranges: f₀ ∈ [20 Hz, Nyquist−100], gain ∈ [−24, +24] dB,
Q ∈ [0.1, 16]. Band *centres* are clamped to `min(20 kHz, 0.42·fs)` because
the bilinear transform warps peaking bandwidth badly near Nyquist.

## Band layout (progressions)

For N bands at sample rate fs (`filterbank.js`):

- **Logarithmic** (default): geometric series
  `fᵢ = 31.25 · (f_max/31.25)^(i/(N−1))` — constant ratio r between centres,
  e.g. 10 bands @48 kHz ≈ the classic 31.5 Hz…20 kHz octave EQ.
  Default `Q = √r / (r−1)` puts adjacent −3-dB-style crossovers at the
  geometric mid-points (10 bands → r ≈ 2.05 → Q ≈ 1.36).
- **Linear**: arithmetic series `fᵢ = 100 + i·Δ` up to f_max — constant Hz
  step, as in the request (100, 500, 900 … style). Default `Qᵢ = fᵢ/Δ`
  (constant *absolute* bandwidth Δ Hz), so low bands are broad in octaves and
  high bands narrow — the natural counterpart of linear spacing.

**Band edges** (used for analyzer binning and bar drawing) are mid-points
between adjacent centres — geometric means for log spacing, arithmetic means
for linear — extrapolated at the extremes and clamped to [20 Hz, Nyquist].

## Phase modes

### Zero-latency minimum phase (default)

The biquad cascade itself. IIR peaking sections are minimum-phase, so this
path adds **0 samples of algorithmic latency** — the right choice for live
monitoring. Phase rotates near each boosted/cut band (that *is* the
minimum-phase response); pure tone timing is preserved within the group-delay
of the sections.

### Linear phase (FIR)

A single FIR whose magnitude matches the cascade and whose phase is exactly
linear (constant group delay, zero phase distortion). Useful when phase
integrity across bands matters (mastering-style correction, multi-path
summation) and latency is acceptable.

**Design method — frequency sampling** (`fir-designer.js`):

1. Evaluate the *analytical* cascade magnitude `|H(e^{jω})| = Π |H_k|` at the
   N_taps uniformly spaced DFT bins (using the same RBJ coefficients the
   biquads run, so the two modes match by construction).
2. Build a zero-phase, conjugate-symmetric spectrum (real, even).
3. IFFT → real impulse response centred on sample 0.
4. Circular shift by N_taps/2 → causal **Type-I linear-phase FIR** (even
   symmetry about the centre tap).
5. Hann window to suppress frequency-sampling ripple between bins.

Implemented with a self-contained radix-2 FFT (`fft.js`); design of a
4096-tap filter takes ~1 ms, so live band edits just debounce (200 ms) and
re-render the `ConvolverNode` buffer.

**Latency**: group delay = `N_taps/2` samples at every frequency:

| FIR length | @48 kHz | @96 kHz |
|---|---|---|
| 1024 | 10.7 ms | 5.3 ms |
| 2048 | 21.3 ms | 10.7 ms |
| 4096 (default) | 42.7 ms | 21.3 ms |
| 8192 | 85.3 ms | 42.7 ms |

**Accuracy trade-off**: FIR frequency resolution is `fs/N_taps` (11.7 Hz at
4096/48 kHz). Narrow (high-Q) boosts at very low centre frequencies need more
taps to be rendered faithfully — hence the FIR-length setting. The UI reports
the resulting latency in the status bar.

`ConvolverNode` runs the FIR with partitioned FFT convolution natively;
`normalize = false` preserves the designed absolute gain.

## Analyzer binning

`getFloatFrequencyData` yields dBFS per FFT bin (Blackman-windowed, per spec).
Per band: convert member bins to linear power, **sum**, convert back to dB —
i.e. total band power. Summing (not averaging) matters: a tone then reads at
its true level in whichever band it falls, independent of band width. Mean
power would divide a tone's energy by the band's bin count, reading ~34 dB low
in the widest high-frequency band (9.8–20 kHz spans ~2400 bins at an
8192-point FFT) — high bands would barely move. The corollary of summing is
physically honest: wide bands integrate more noise power, so broadband noise
reads a few dB higher in high log-spaced bands (pink noise reads ~flat).
Bands narrower than one bin (possible at 1024-point FFT with 31 log bands)
fall back to their nearest single bin. Resolution guidance, measured with the
built-in tone sweep at 48 kHz: the default 8192-point window resolves every
layout up to 20 log bands exactly; at **31 log bands** the lowest bands
(~8 Hz wide around 35–50 Hz) are narrower than the analyser's Blackman
mainlobe (~6 bins ≈ 35 Hz), so a tone at band 2's centre reads mostly in
band 3 — select the **16384-point analysis window** for 31 log bands, which
restores exact per-band attribution. Linear layouts are uncritical (bands are
≥ 663 Hz wide) at any supported FFT size.
