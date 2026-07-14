// AudioEngine — owns the WebAudio graph for one input->output device pair.
//
//   MediaStreamSource -> inputGain -> [ biquad cascade | linear-phase FIR ]
//                     -> analyser -> outputGain -> ctx.destination (setSinkId)
//
// Minimum-phase path: one BiquadFilterNode ("peaking") per band, in series.
// Linear-phase path: single ConvolverNode holding an FIR designed to the same
// magnitude response (see fir-designer.js). Both paths exist; setPhaseMode()
// just re-patches inputGain to one of them.

import { designLinearPhaseFIR } from './fir-designer.js';
import { bandEdges } from './filterbank.js';

const FIR_REDESIGN_DEBOUNCE_MS = 200;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.inputGain = null;
    this.outputGain = null;
    this.analyser = null;
    this.biquads = [];
    this.convolver = null;
    this.bands = [];
    this.phaseMode = 'minimum';
    this.firTaps = 4096;
    this.deviceInfo = null; // {inputLabel, sampleRate, sampleSize, channelCount}
    this._freqData = null;
    this._firTimer = null;
  }

  get isOpen() {
    return !!this.ctx;
  }

  // Latency added by the EQ itself (excludes device/driver latency).
  get eqLatencyMs() {
    if (!this.ctx) return 0;
    return this.phaseMode === 'linear' ? (this.firTaps / 2 / this.ctx.sampleRate) * 1000 : 0;
  }

  async open({ inputId, outputId, sampleRate, precision, bands, phaseMode, firTaps, fftSize }) {
    this.close();
    this.phaseMode = phaseMode;
    this.firTaps = firTaps;
    this.bands = bands.map((b) => ({ ...b }));

    // Built-in test sources ('__tone__', '__noise__') bypass capture entirely
    // so the EQ + analyzer path can be exercised without a microphone.
    const isTest = inputId === '__tone__' || inputId === '__noise__';
    let settings = {};
    let track = null;

    if (!isTest) {
    // --- capture the input device -------------------------------------------
    const constraints = {
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        sampleRate: { ideal: sampleRate },
        sampleSize: precision === '32f' ? undefined : { ideal: precision === '24' ? 24 : 16 },
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      throw new Error(`Cannot open input device: ${e.name === 'OverconstrainedError'
        ? `constraint "${e.constraint}" not supported by the device`
        : e.message || e.name}`);
    }

    track = this.stream.getAudioTracks()[0];
    settings = track.getSettings();
    const caps = track.getCapabilities ? track.getCapabilities() : {};

    // --- verify precision (per spec: error if the device cannot support it) --
    if (precision !== '32f') {
      const want = precision === '24' ? 24 : 16;
      const got = settings.sampleSize;
      const capMax = caps.sampleSize ? caps.sampleSize.max : undefined;
      if ((typeof got === 'number' && got < want) ||
          (typeof capMax === 'number' && capMax < want)) {
        this._releaseStream();
        throw new Error(
          `Device "${track.label || 'input'}" cannot capture ${want}-bit PCM ` +
          `(device reports ${got ?? capMax}-bit).`);
      }
    }
    // Note: inside the WebAudio graph all processing is 32-bit float regardless
    // of the capture depth, so '32f' only requires float support in the graph
    // (always true) — no capture-depth constraint is imposed.

    // --- verify sample rate ---------------------------------------------------
    if (typeof settings.sampleRate === 'number' && settings.sampleRate !== sampleRate) {
      this._releaseStream();
      throw new Error(
        `Device "${track.label || 'input'}" opened at ${settings.sampleRate} Hz, ` +
        `cannot honour requested ${sampleRate} Hz.`);
    }
    } // end !isTest

    // --- audio context at the requested rate ---------------------------------
    try {
      this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    } catch (e) {
      this._releaseStream();
      throw new Error(`This system cannot open an audio context at ${sampleRate} Hz: ${e.message}`);
    }
    if (this.ctx.sampleRate !== sampleRate) {
      const got = this.ctx.sampleRate;
      this.close();
      throw new Error(`Audio output runs at ${got} Hz; requested ${sampleRate} Hz is not supported.`);
    }

    // --- route to the selected output device ---------------------------------
    if (outputId) {
      if (typeof this.ctx.setSinkId !== 'function') {
        this.close();
        throw new Error('Selecting an output device requires AudioContext.setSinkId ' +
          '(Chrome/Edge 110+). This browser only supports the default output.');
      }
      try {
        await this.ctx.setSinkId(outputId);
      } catch (e) {
        this.close();
        throw new Error(`Cannot open output device: ${e.message || e.name}`);
      }
    }

    // --- build the graph ------------------------------------------------------
    this.inputGain = this.ctx.createGain();
    this.outputGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.5;
    this._freqData = new Float32Array(this.analyser.frequencyBinCount);

    this.convolver = this.ctx.createConvolver();
    this.convolver.normalize = false;

    if (isTest) {
      this._buildTestSource(inputId);
    } else {
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.source.connect(this.inputGain);
    }
    this.analyser.connect(this.outputGain);
    this.outputGain.connect(this.ctx.destination);

    this._buildBiquads();
    this._rebuildFIR();
    this._patchPhasePath();

    this.deviceInfo = {
      inputLabel: isTest
        ? (inputId === '__tone__' ? 'Test tone generator' : 'Pink noise generator')
        : track.label,
      sampleRate: this.ctx.sampleRate,
      sampleSize: isTest ? 32 : settings.sampleSize ?? null,
      channelCount: isTest ? 1 : settings.channelCount ?? null,
    };
    await this.ctx.resume();
  }

  close() {
    if (this._firTimer) clearTimeout(this._firTimer);
    this._firTimer = null;
    this._releaseStream();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.source = this.inputGain = this.outputGain = this.analyser = this.convolver = null;
    this.biquads = [];
    this.deviceInfo = null;
  }

  _releaseStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this._testNodes) {
      for (const n of this._testNodes) { try { n.stop(); } catch {} }
      this._testNodes = null;
      this._testOsc = null;
    }
  }

  // ---- built-in test signals ----------------------------------------------

  _buildTestSource(kind) {
    if (kind === '__tone__') {
      const osc = this.ctx.createOscillator();
      osc.frequency.value = 1000;
      const g = this.ctx.createGain();
      g.gain.value = 0.1; // -20 dBFS
      osc.connect(g);
      g.connect(this.inputGain);
      osc.start();
      this._testNodes = [osc];
      this._testOsc = osc;
    } else {
      // Pink noise (Paul Kellet filter), 4 s looped buffer.
      const len = this.ctx.sampleRate * 4;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.055;
        b6 = w * 0.115926;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.inputGain);
      src.start();
      this._testNodes = [src];
    }
  }

  setTestToneFreq(f) {
    if (this._testOsc) {
      this._testOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.01);
    }
  }

  // ---- filter bank ------------------------------------------------------------

  _buildBiquads() {
    for (const b of this.biquads) b.disconnect();
    this.biquads = this.bands.map((band) => {
      const bq = this.ctx.createBiquadFilter();
      bq.type = 'peaking';
      bq.frequency.value = band.freq;
      bq.gain.value = band.gain;
      bq.Q.value = band.q;
      return bq;
    });
    for (let i = 0; i < this.biquads.length - 1; i++) {
      this.biquads[i].connect(this.biquads[i + 1]);
    }
    if (this.biquads.length) {
      this.biquads[this.biquads.length - 1].connect(this.analyser);
    }
  }

  _rebuildFIR() {
    if (!this.ctx) return;
    const ir = designLinearPhaseFIR(this.bands, this.ctx.sampleRate, this.firTaps);
    const buf = this.ctx.createBuffer(1, ir.length, this.ctx.sampleRate);
    buf.copyToChannel(ir, 0);
    this.convolver.buffer = buf;
  }

  _scheduleFIRRebuild() {
    if (this.phaseMode !== 'linear') return;
    if (this._firTimer) clearTimeout(this._firTimer);
    this._firTimer = setTimeout(() => this._rebuildFIR(), FIR_REDESIGN_DEBOUNCE_MS);
  }

  _patchPhasePath() {
    this.inputGain.disconnect();
    this.convolver.disconnect();
    if (this.biquads.length) this.biquads[this.biquads.length - 1].disconnect();

    if (this.phaseMode === 'linear') {
      this.inputGain.connect(this.convolver);
      this.convolver.connect(this.analyser);
    } else if (this.biquads.length) {
      this.inputGain.connect(this.biquads[0]);
      this.biquads[this.biquads.length - 1].connect(this.analyser);
    } else {
      this.inputGain.connect(this.analyser);
    }
  }

  setPhaseMode(mode) {
    this.phaseMode = mode;
    if (!this.ctx) return;
    if (mode === 'linear') this._rebuildFIR();
    this._patchPhasePath();
  }

  setBands(bands) {
    this.bands = bands.map((b) => ({ ...b }));
    if (!this.ctx) return;
    this._buildBiquads();
    this._patchPhasePath();
    if (this.phaseMode === 'linear') this._rebuildFIR();
  }

  updateBand(i, band) {
    this.bands[i] = { ...band };
    if (!this.ctx) return;
    const bq = this.biquads[i];
    if (bq) {
      const t = this.ctx.currentTime;
      bq.frequency.setTargetAtTime(band.freq, t, 0.02);
      bq.gain.setTargetAtTime(band.gain, t, 0.02);
      bq.Q.setTargetAtTime(band.q, t, 0.02);
    }
    this._scheduleFIRRebuild();
  }

  setFftSize(n) {
    if (!this.analyser) return;
    this.analyser.fftSize = n;
    this._freqData = new Float32Array(this.analyser.frequencyBinCount);
  }

  // ---- analysis -----------------------------------------------------------------

  // Average post-EQ signal level (dBFS) inside each band, binned by band edges.
  getBandLevels(progression) {
    if (!this.analyser) return null;
    const n = this.bands.length;
    const edges = bandEdges(this.bands.map((b) => b.freq), progression, this.ctx.sampleRate);
    this.analyser.getFloatFrequencyData(this._freqData);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const levels = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = Math.max(0, Math.round(edges[i] / binHz));
      let hi = Math.min(this._freqData.length - 1, Math.round(edges[i + 1] / binHz) - 1);
      if (hi < lo) hi = lo;
      // Total band power (sum, not mean): a tone reads at its true level in
      // any band regardless of how many bins the band spans. Mean power
      // diluted tones in the wide high-frequency bands (a 9.8–20 kHz band
      // spans ~2400 bins at 8192-pt FFT → tones read ~34 dB low there).
      let sum = 0;
      for (let k = lo; k <= hi; k++) {
        sum += Math.pow(10, this._freqData[k] / 10);
      }
      levels[i] = sum > 0 ? 10 * Math.log10(sum) : -120;
    }
    return levels;
  }
}
