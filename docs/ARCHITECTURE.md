# Architecture

## Overview

One browser tab = one **EQ controller** for one input→output device pair.
Tabs are fully independent (each owns its `AudioContext`, capture stream and
UI state); “+ New pair (tab)” simply opens the app again. This gives pair
isolation for free — a crash, glitch or device change in one pair cannot
affect another — at the cost of no cross-pair master view (see *Future work*).

```
┌────────────────────────── Browser tab (one pair) ──────────────────────────┐
│                                                                            │
│  main.js ── UI state, settings panel, band strips, analysis timer          │
│     │                                                                      │
│     ├── knob.js          rotary knob widget (freq, Q)                      │
│     ├── analyzer-view.js Canvas renderer (bars, peak-hold, EQ curve)       │
│     ├── filterbank.js    band layout math (centres, default Q, edges)      │
│     └── audio-engine.js  WebAudio graph + device lifecycle                 │
│            └── fir-designer.js  RBJ coefficients, cascade response,        │
│                   └── fft.js    linear-phase FIR design (radix-2 FFT)      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Audio graph

```
getUserMedia(inputId, sampleRate, sampleSize)
        │
MediaStreamAudioSourceNode
        │
    GainNode (inputGain)
        │
        ├── minimum-phase path:  BiquadFilter(peaking)₁ → … → BiquadFilterₙ ─┐
        │                                                                   ├─→ AnalyserNode
        └── linear-phase path:   ConvolverNode (linear-phase FIR) ──────────┘        │
                                                                              GainNode (outputGain)
                                                                                     │
                                                                        AudioContext.destination
                                                                        (routed via setSinkId(outputId))
```

- Both paths always exist; switching **Phase mode** only re-patches
  `inputGain` → (cascade | convolver) → analyser, so the switch is instant.
- The `AnalyserNode` sits **post-EQ**, so the bars show the equalized signal
  actually being sent to the output device.
- All graph-internal samples are 32-bit float (Web Audio spec).

## Device handling & precision policy

`audio-engine.js#open()` performs, in order:

1. `getUserMedia` with `deviceId {exact}`, `sampleRate {ideal}`,
   `sampleSize {ideal 16|24}` (omitted for 32-float), and echo-cancel /
   noise-suppress / AGC disabled (this is a measurement/monitor path).
2. **Precision verification** — reads `track.getSettings().sampleSize` and
   `getCapabilities().sampleSize.max`; if either reports less than requested,
   the stream is released and `open()` throws
   `Device "X" cannot capture 24-bit PCM (device reports 16-bit)`.
   32-bit float needs no capture check (the graph is float32 by spec).
3. **Sample-rate verification** — track settings and then
   `new AudioContext({sampleRate})`; a mismatch on either side throws.
4. **Output routing** — `AudioContext.setSinkId(outputId)`; absence of the API
   (non-Chromium) or rejection throws a descriptive error.

Errors surface verbatim in the status bar; the engine is left fully closed
(no orphaned tracks or contexts).

## Data flow: analysis loop

```
setInterval(refreshMs, default 1000)
  → analyser.getFloatFrequencyData()          (dBFS per FFT bin)
  → engine.getBandLevels(): average bin power inside each band’s
    [edgeᵢ, edgeᵢ₊₁) range → dB per band       (edges from filterbank.bandEdges)
  → view.update(levels):
       peak-hold rule per band:
         level ≥ held max → new max, timestamp now
         else if now − timestamp ≥ 3000 ms → held max replaced by current level
  → canvas redraw (bars, peak lines, EQ-curve overlay)
```

The loop is owned by the UI (not the engine) so **Start/Stop analysis** in the
settings panel freezes/resumes drawing without touching audio. The **analysis
window** setting maps to `AnalyserNode.fftSize` (1024–16384) and can change
live; at 48 kHz / 8192 the bin width is ~5.9 Hz, enough to resolve the lowest
31.25 Hz band.

The graph x-axis follows the band progression (log axis for logarithmic
spacing, linear axis for linear spacing) so bars always have sensible widths.
Bar y-scale is −90…0 dBFS (left); the EQ-curve overlay uses its own ±24 dB
scale (right, amber).

## Settings model

| Setting | Applies | Mechanism |
|---|---|---|
| Refresh rate | live | restart of the analysis interval |
| FFT size | live | `analyser.fftSize` |
| Band count / progression | live | regenerate bands → rebuild biquads (+ FIR redesign if linear mode) |
| Phase mode | live | graph re-patch (+ FIR design) |
| Per-band freq/gain/Q | live | `AudioParam.setTargetAtTime` (biquads); debounced FIR redesign (linear mode) |
| Input/output device, sample rate, precision, FIR length | on next Start | require reopening the capture stream / context |

## Why no AudioWorklet?

Native `BiquadFilterNode` and `ConvolverNode` run in the compiled render
thread — faster and more robust than a hand-written JS/WASM worklet, with
sample-accurate parameter automation for free. A worklet becomes worthwhile
only for structures Web Audio lacks (e.g. per-band dynamic/compressive EQ or
true partitioned-convolution control); the module boundary (`audio-engine.js`)
is where it would slot in.

## Future work

- `SharedWorker`/`BroadcastChannel` registry to list all open pairs and build
  a master overview tab.
- Preset save/load (`localStorage` or JSON export).
- Pre/post analyser toggle (second `AnalyserNode` before the filter path).
