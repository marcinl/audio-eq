import { AudioEngine } from './audio-engine.js';
import { AnalyzerView } from './analyzer-view.js';
import { Knob, formatHz } from './knob.js';
import { makeBands } from './filterbank.js';

const $ = (id) => document.getElementById(id);

const state = {
  refreshMs: 1000,
  fftSize: 8192,
  numBands: 10,
  progression: 'log',
  sampleRate: 48000,
  precision: '24',
  phaseMode: 'minimum',
  firTaps: 4096,
  inputId: '',
  outputId: '',
  bands: [],
  analysing: false,
};

const engine = new AudioEngine();
const view = new AnalyzerView($('graph'));
let analysisTimer = null;
let knobRefs = []; // per band: {freqKnob, qKnob, gainSlider, gainVal}

// ---------- status ----------

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = isError ? 'status error' : 'status';
}

// ---------- devices ----------

async function refreshDevices(requestPermission = false) {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    // Without mic permission browsers return blank labels/deviceIds; grab a
    // one-shot stream so the lists are populated with real names.
    const unlabeled = devices.some((d) => d.kind.startsWith('audio') && !d.label);
    if (requestPermission && unlabeled) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of s.getTracks()) t.stop();
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch (e) {
        setStatus('Microphone permission denied — device names stay hidden until granted. ' +
          'System default and test signals still work.', true);
      }
    }
    fillDeviceSelect($('inputDevice'), devices.filter((d) => d.kind === 'audioinput'), state.inputId, true);
    fillDeviceSelect($('outputDevice'), devices.filter((d) => d.kind === 'audiooutput'), state.outputId, false);
  } catch (e) {
    setStatus(`Device enumeration failed: ${e.message}`, true);
  }
}

function fillDeviceSelect(sel, devices, current, isInput) {
  sel.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };
  add('', 'System default');
  if (isInput) {
    add('__tone__', 'Test: tone sweep across bands');
    add('__noise__', 'Test: pink noise');
  }
  for (const d of devices) {
    if (!d.deviceId) continue; // permission-less placeholder entry
    add(d.deviceId, d.label || `${d.kind} (${d.deviceId.slice(0, 8)}…)`);
  }
  sel.value = current;
  if (sel.value !== current) sel.value = '';
}

// ---------- band strips ----------

function rebuildBandStrips() {
  const host = $('bands');
  host.innerHTML = '';
  knobRefs = [];
  state.bands.forEach((band, i) => {
    const strip = document.createElement('div');
    strip.className = 'band';
    strip.innerHTML = `<div class="band-title">Band ${i + 1}</div>`;
    host.appendChild(strip);

    const freqKnob = new Knob(strip, {
      label: 'Freq', min: 20, max: state.sampleRate / 2 - 100, value: band.freq,
      log: true, format: formatHz,
      onChange: (v) => onBandChange(i, { freq: v }),
    });

    const gainWrap = document.createElement('div');
    gainWrap.className = 'gain-wrap';
    gainWrap.innerHTML = `
      <div class="gain-val">0.0 dB</div>
      <input type="range" class="gain-slider" min="-24" max="24" step="0.1"
             value="${band.gain}" orient="vertical" aria-label="Band ${i + 1} gain">
      <div class="knob-label">Gain</div>`;
    strip.appendChild(gainWrap);
    const slider = gainWrap.querySelector('input');
    const gainVal = gainWrap.querySelector('.gain-val');
    gainVal.textContent = `${band.gain.toFixed(1)} dB`;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      gainVal.textContent = `${v.toFixed(1)} dB`;
      onBandChange(i, { gain: v });
    });
    // Chrome's vertical sliders react to hover-wheel natively, which lets a
    // page scroll silently change gains. Take over the wheel with an explicit
    // 0.5 dB step instead (matches the knobs' wheel behaviour).
    slider.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = Math.min(24, Math.max(-24, parseFloat(slider.value) + (e.deltaY < 0 ? 0.5 : -0.5)));
      slider.value = v;
      gainVal.textContent = `${v.toFixed(1)} dB`;
      onBandChange(i, { gain: v });
    }, { passive: false });
    slider.addEventListener('dblclick', () => {
      slider.value = 0;
      gainVal.textContent = '0.0 dB';
      onBandChange(i, { gain: 0 });
    });

    const qKnob = new Knob(strip, {
      label: 'Q', min: 0.1, max: 16, value: band.q, log: true,
      format: (v) => v.toFixed(2),
      onChange: (v) => onBandChange(i, { q: v }),
    });

    knobRefs.push({ freqKnob, qKnob, slider, gainVal });
  });
}

function onBandChange(i, patch) {
  Object.assign(state.bands[i], patch);
  engine.updateBand(i, state.bands[i]);
  view.configure(state.bands, state.progression, state.sampleRate);
}

function regenerateBands() {
  state.bands = makeBands(state.numBands, state.progression, state.sampleRate);
  rebuildBandStrips();
  view.configure(state.bands, state.progression, state.sampleRate);
  if (engine.isOpen) engine.setBands(state.bands);
}

// ---------- analysis loop ----------

function startAnalysis() {
  stopAnalysis();
  state.analysing = true;
  $('btnAnalysisStart').disabled = true;
  $('btnAnalysisStop').disabled = false;
  analysisTimer = setInterval(() => {
    if (!engine.isOpen) return;
    const levels = engine.getBandLevels(state.progression);
    if (levels) view.update(levels);
  }, state.refreshMs);
}

function stopAnalysis() {
  if (analysisTimer) clearInterval(analysisTimer);
  analysisTimer = null;
  state.analysing = false;
  $('btnAnalysisStart').disabled = false;
  $('btnAnalysisStop').disabled = true;
}

// ---------- test-tone sweep ----------

let sweepTimer = null;
let sweepIdx = 0;

function startSweepIfTest() {
  stopSweep();
  if (state.inputId !== '__tone__') return;
  sweepIdx = 0;
  const step = () => {
    const i = sweepIdx % state.bands.length;
    const f = state.bands[i].freq;
    engine.setTestToneFreq(f);
    setStatus(`Test tone sweep: ${f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : f.toFixed(0) + ' Hz'}` +
      ` (band ${i + 1}/${state.bands.length})`);
    sweepIdx++;
  };
  step();
  sweepTimer = setInterval(step, Math.max(2000, state.refreshMs * 2));
}

function stopSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

// ---------- start / stop ----------

async function start() {
  $('btnStart').disabled = true;
  setStatus('Opening devices…');
  try {
    await engine.open({
      inputId: state.inputId,
      outputId: state.outputId,
      sampleRate: state.sampleRate,
      precision: state.precision,
      bands: state.bands,
      phaseMode: state.phaseMode,
      firTaps: state.firTaps,
      fftSize: state.fftSize,
    });
    const d = engine.deviceInfo;
    setStatus(
      `Running — ${d.inputLabel || 'input'} @ ${d.sampleRate} Hz` +
      (d.sampleSize ? `, ${d.sampleSize}-bit capture` : ', capture depth not reported') +
      ` · EQ latency ${engine.eqLatencyMs.toFixed(1)} ms (${state.phaseMode} phase)`);
    $('btnStop').disabled = false;
    view.resetPeaks();
    refreshDevices(); // labels become available after permission
    startAnalysis();
    startSweepIfTest();
  } catch (e) {
    setStatus(e.message, true);
    $('btnStart').disabled = false;
  }
}

function stop() {
  stopSweep();
  stopAnalysis();
  engine.close();
  $('btnStart').disabled = false;
  $('btnStop').disabled = true;
  setStatus('Stopped.');
}

// ---------- settings wiring ----------

function wire() {
  $('btnStart').addEventListener('click', start);
  $('btnStop').addEventListener('click', stop);
  $('btnNewPair').addEventListener('click', () => window.open(location.href, '_blank'));
  $('btnSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('open'));
  $('btnRefreshDevices').addEventListener('click', () => refreshDevices(true));

  $('phaseMode').addEventListener('change', (e) => {
    state.phaseMode = e.target.value;
    engine.setPhaseMode(state.phaseMode);
    if (engine.isOpen) {
      setStatus(`Phase mode: ${state.phaseMode} · EQ latency ${engine.eqLatencyMs.toFixed(1)} ms`);
    }
  });

  $('refreshRate').addEventListener('change', (e) => {
    state.refreshMs = Math.round(parseFloat(e.target.value) * 1000);
    if (state.analysing) startAnalysis();
  });

  $('fftSize').addEventListener('change', (e) => {
    state.fftSize = parseInt(e.target.value, 10);
    engine.setFftSize(state.fftSize);
  });

  $('btnAnalysisStart').addEventListener('click', startAnalysis);
  $('btnAnalysisStop').addEventListener('click', stopAnalysis);

  $('numBands').addEventListener('change', (e) => {
    state.numBands = parseInt(e.target.value, 10);
    regenerateBands();
  });
  $('progression').addEventListener('change', (e) => {
    state.progression = e.target.value;
    regenerateBands();
  });

  $('inputDevice').addEventListener('change', (e) => {
    state.inputId = e.target.value;
    noteReopen();
  });
  $('outputDevice').addEventListener('change', (e) => {
    state.outputId = e.target.value;
    noteReopen();
  });
  $('sampleRate').addEventListener('change', (e) => {
    state.sampleRate = parseInt(e.target.value, 10);
    regenerateBands();
    noteReopen();
  });
  $('precision').addEventListener('change', (e) => {
    state.precision = e.target.value;
    noteReopen();
  });
  $('firTaps').addEventListener('change', (e) => {
    state.firTaps = parseInt(e.target.value, 10);
    noteReopen();
  });

  document.addEventListener('click', (e) => {
    const panel = $('settingsPanel');
    if (panel.classList.contains('open') &&
        !panel.contains(e.target) && e.target !== $('btnSettings')) {
      panel.classList.remove('open');
    }
  });
}

function noteReopen() {
  if (engine.isOpen) setStatus('Device settings changed — press Stop then Start to apply.', false);
}

// ---------- boot ----------

if (!navigator.mediaDevices || !window.AudioContext) {
  setStatus('This browser does not support the required Web Audio / Media Capture APIs.', true);
} else {
  wire();
  regenerateBands();
  refreshDevices(true); // ask permission up-front so device names populate
  navigator.mediaDevices.addEventListener?.('devicechange', () => refreshDevices());
  stopAnalysis();
  $('btnStop').disabled = true;
  setStatus('Ready. Choose devices in Settings, then press Start.');
  window.__eq = { engine, view, state }; // debug/testing handle
}
