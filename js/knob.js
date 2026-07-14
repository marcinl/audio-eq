// Small rotary knob control. Drag vertically (or use the mouse wheel) to
// change the value; double-click resets to the initial value.

export class Knob {
  constructor(container, { label, min, max, value, log = false, format, onChange }) {
    this.min = min;
    this.max = max;
    this.log = log;
    this.format = format || ((v) => v.toFixed(1));
    this.onChange = onChange;
    this.initial = value;
    this.value = value;

    this.el = document.createElement('div');
    this.el.className = 'knob';
    this.el.innerHTML = `
      <div class="knob-dial" tabindex="0" role="slider"
           aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}">
        <div class="knob-ind"></div>
      </div>
      <div class="knob-val"></div>
      <div class="knob-label">${label}</div>`;
    container.appendChild(this.el);
    this.dial = this.el.querySelector('.knob-dial');
    this.valEl = this.el.querySelector('.knob-val');

    this._bindEvents();
    this._render();
  }

  _toNorm(v) {
    if (this.log) return Math.log(v / this.min) / Math.log(this.max / this.min);
    return (v - this.min) / (this.max - this.min);
  }

  _fromNorm(t) {
    t = Math.min(1, Math.max(0, t));
    if (this.log) return this.min * Math.pow(this.max / this.min, t);
    return this.min + t * (this.max - this.min);
  }

  setValue(v, fire = false) {
    this.value = Math.min(this.max, Math.max(this.min, v));
    this._render();
    if (fire && this.onChange) this.onChange(this.value);
  }

  _render() {
    const deg = -135 + this._toNorm(this.value) * 270;
    this.dial.querySelector('.knob-ind').style.transform = `rotate(${deg}deg)`;
    this.dial.setAttribute('aria-valuenow', this.value);
    this.valEl.textContent = this.format(this.value);
  }

  _bindEvents() {
    let startY = 0;
    let startNorm = 0;
    const move = (e) => {
      const dy = startY - e.clientY;
      this.setValue(this._fromNorm(startNorm + dy / 150), true);
    };
    const up = (e) => {
      this.dial.releasePointerCapture(e.pointerId);
      this.dial.removeEventListener('pointermove', move);
      this.dial.removeEventListener('pointerup', up);
    };
    this.dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startNorm = this._toNorm(this.value);
      this.dial.setPointerCapture(e.pointerId);
      this.dial.addEventListener('pointermove', move);
      this.dial.addEventListener('pointerup', up);
    });
    this.dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.02 : -0.02;
      this.setValue(this._fromNorm(this._toNorm(this.value) + step), true);
    }, { passive: false });
    this.dial.addEventListener('dblclick', () => this.setValue(this.initial, true));
  }
}

export function formatHz(v) {
  return v >= 1000 ? (v / 1000).toFixed(2) + ' kHz' : v.toFixed(0) + ' Hz';
}
