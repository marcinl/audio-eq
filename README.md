# Pair EQ — browser graphic equalizer between audio device pairs

A real-time graphic EQ that sits between one **audio input device** and one
**audio output device**, entirely in the browser. Each browser tab is one
independent input→output pair with its own filter bank, analyzer and settings
(use **“+ New pair (tab)”** to spawn another controller).

## Run it

```bash
cd audio-eq
python3 -m http.server 8517
# open http://localhost:8517 in Chrome or Edge
```

No build step, no dependencies — plain ES modules.

**Browser support:** Chrome / Edge 110+ recommended. Output-device selection
uses `AudioContext.setSinkId()`, which Firefox and Safari do not implement; on
those browsers only the system default output works. `getUserMedia` requires a
secure context (`localhost` counts).

⚠️ Choosing a microphone as input and speakers as output in the same room will
feed back. Use headphones, or a loopback/interface pair.

## Visualisation library comparison

| Option | What it is | Real-time device input | Custom band bars + peak-hold | Filter-curve overlay | Verdict |
|---|---|---|---|---|---|
| [wavesurfer.js](https://wavesurfer.xyz/) | Waveform display/player for **recorded/loaded** audio; plugins for spectrogram | Weak — built around a media element / pre-loaded buffer, not live monitoring | No — visualises waveforms, not per-band levels | No | Wrong tool: playback-file oriented, not a live analyzer |
| [audioMotion-analyzer](https://github.com/hvianna/audioMotion-analyzer) | Polished real-time spectrum analyzer built on `AnalyserNode` (octave bands, LED/bar modes, its own peak-hold) | Yes | Partially — it picks its *own* band layout (1/n-octave); cannot force bars to align with *our* N user-configurable filter bands (esp. linear progression), and its peak-hold decay is not the “reset every 3 s” rule required here | No | Great for a generic spectrum, but its band binning and peak logic can’t be made to match the filter bank |
| Raw [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) + [Canvas 2D](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API) (chosen) | `AnalyserNode` FFT → custom binning → custom Canvas renderer | Yes | Yes — bars are drawn from the exact same band-edge table the filter bank uses; peak-hold implements exactly the 3-second replace rule | Yes — the analytical biquad cascade response is drawn on a second dB scale | **Chosen.** ~200 lines, zero deps, pixel-level control |
| Others (p5.sound, three.js/WebGL visualisers, Chart.js) | General graphics / charting on top of the same `AnalyserNode` data | Yes (via Web Audio anyway) | Same custom work still needed | Same | They only replace the drawing layer; the hard part (binning, peak rule, curve) is ours either way. WebGL only pays off above ~thousands of draw ops/frame; at ≤31 bars/second Canvas 2D is trivially fast |

**Conclusion:** every library ultimately reads the same `AnalyserNode` FFT.
Our two hard requirements — bars that align 1:1 with a *user-configurable*
filter bank (log or linear progression) and the specific 3-second peak-replace
rule — are exactly the parts no library provides, so a small custom Canvas
renderer ([js/analyzer-view.js](js/analyzer-view.js)) is less code than bending
a library. audioMotion-analyzer is the closest fit and worth a look if you
later want a free-running high-FPS spectrum *alongside* the band bars.

## Features

- N-band filter bank (5–31 bands), **cascaded RBJ peaking biquads**
- Per band: **Frequency knob** (log, 20 Hz–Nyquist), **Gain slider** (±24 dB), **Q knob** (0.1–16)
- **Zero-latency minimum phase** (native biquads) or **linear phase** (FIR via
  `ConvolverNode`, designed to the identical magnitude response) — switchable live
- Dynamic EQ graph: one rectangular bar per band (post-EQ level), refreshed
  every 1 s by default; **peak-hold line** per band that is replaced by a new
  maximum after 3 s if not exceeded; combined EQ curve overlay (±24 dB scale)
- Settings panel: refresh rate · analysis window (FFT size) with start/stop
  analysis · band count · linear/logarithmic progression · input device ·
  output device · sample rate (44.1/48/96 kHz) · precision (16-bit PCM,
  24-bit PCM, 32-bit float) · FIR length
- Device capability verification: if the chosen device cannot deliver the
  requested precision or sample rate, opening fails with a descriptive error
- Built-in **test signals** in the input-device list — a tone sweep that steps
  through every band centre and a pink-noise generator — for verifying the
  filter bank and analyzer without a microphone (no permission needed)

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module layout, audio graph, data flow
- [docs/FILTER-DESIGN.md](docs/FILTER-DESIGN.md) — filter-bank math, biquad and FIR design, phase-mode trade-offs

## Honest limitations (browser platform)

- **Bit depth is advisory.** Inside the Web Audio graph *all* processing is
  32-bit float regardless of capture depth. The 16/24-bit PCM options constrain
  the *capture* side via `MediaTrackConstraints.sampleSize` and are verified
  against `track.getSettings()/getCapabilities()`; if the device/browser
  reports a lower depth, opening errors out as specified. Browsers that don’t
  report `sampleSize` (e.g. Firefox) are flagged as “capture depth not
  reported” in the status bar. Output depth is chosen by the OS driver and is
  not controllable from JavaScript.
- Round-trip latency = device/driver latency + (linear-phase mode) FIR group
  delay of `taps / 2 / fs` (42.7 ms at 4096 taps / 48 kHz). Minimum-phase mode
  adds no algorithmic delay.
- `ConvolverNode` FIR rebuilds (on band edits in linear-phase mode) are
  debounced 200 ms; a brief transient can occur at the swap.
