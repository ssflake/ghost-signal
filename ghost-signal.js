/*
 * <ghost-signal>: text that can only be read while it moves.
 *
 * Usage: load this file with a script tag, then write:
 *   <ghost-signal
 *     phrases="CAN YOU SEE ME / PLEASE / HELP"
 *     alt="Chart image, unreadable. Static interference. Can you see me. Please. Help."
 *     palette="green">
 *   </ghost-signal>
 *
 * Optional attributes, with defaults:
 *   palette           green | amber | white | red      (green)
 *   letter-speed      speed of the letter dots         (0.5)
 *   background-speed  speed of the background dots     (-0.3)
 *   spacing           distance between dots, 3 to 8    (4)
 *   hold              seconds each phrase stays        (5)
 *   distortion        sideways tears and lunges, 0-3   (1)
 *   swell             swelling lines, 0-3              (1.2)
 *   delay             seconds of plain static before    (0)
 *                     the first phrase emerges; counts
 *                     only while the figure is on screen
 *
 * How it works: there are two fields of random dots with the same density.
 * One is drawn only inside the letters, the other only outside them. Any
 * single frame looks like plain static. The letters appear only because
 * the two fields move at different speeds.
 */


// ---------- 1. Settings ----------

const PALETTES = {
  green: { background: '#020a04', dots: '#3dff7a' },
  amber: { background: '#0a0600', dots: '#ffb21e' },
  white: { background: '#0a0a0f', dots: '#e6e9f2' },
  red:   { background: '#0a0202', dots: '#ff3b30' },
};

// The canvas is drawn at the size it is shown, so dots stay crisp on any screen.
// Spacing, dot sizes, and speeds are in screen pixels.
const HEIGHT_RATIO = 0.275; // height as a share of width
const MIN_HEIGHT = 160;     // narrow screens get a taller box for two lines
const DOT_DENSITY = 0.4;    // share of grid positions that hold a dot
const FPS = 60;

const random = (min, max) => min + Math.random() * (max - min);

// Eases from 0 to 1 with soft ends, so nothing ever jumps.
const smooth = (x) => {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
};

// "CAN YOU SEE ME" -> ["CAN YOU", "SEE ME"]: split at the space closest to the middle.
const splitInTwo = (text) => {
  const middle = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
  }
  return [text.slice(0, best), text.slice(best + 1)];
};


// ---------- 2. The element ----------

class GhostSignal extends HTMLElement {

  connectedCallback() {
    this.readAttributes();
    this.buildPage();
    this.phraseIndex = 0;
    this.resize();
    this.resetSignal();

    // Redraw at the new size whenever the page layout changes.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this);

    // Track whether at least half of the figure is on screen,
    // so the delay only counts down while someone can actually see it.
    this.visible = false;
    this.visibilityObserver = new IntersectionObserver(
      ([entry]) => { this.visible = entry.isIntersecting; },
      { threshold: 0.5 }
    );
    this.visibilityObserver.observe(this);

    // Players who asked their system for less motion start in Gentle mode.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.motion = reduce ? 'gentle' : 'full';
    this.motionSelect.value = this.motion;

    this.running = true;
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  disconnectedCallback() {
    this.running = false;
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
  }

  // Match the canvas to its on-screen size and the display's pixel density.
  resize() {
    const cssWidth = Math.round(this.getBoundingClientRect().width);
    if (!cssWidth || cssWidth === this.cssWidth) return;
    this.cssWidth = cssWidth;

    const cssHeight = Math.max(MIN_HEIGHT, Math.round(cssWidth * HEIGHT_RATIO));
    this.scale = window.devicePixelRatio || 1;
    this.width = Math.round(cssWidth * this.scale);
    this.height = Math.round(cssHeight * this.scale);

    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.height = cssHeight + 'px';

    this.buildDots();
    this.buildMask(this.phrases[this.phraseIndex]);
    this.swells = [];
    this.tears = [];
  }

  readAttributes() {
    const number = (name, fallback) => {
      const value = parseFloat(this.getAttribute(name));
      return Number.isFinite(value) ? value : fallback;
    };

    this.phrases = (this.getAttribute('phrases') || 'HELP')
      .split('/')
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);

    this.palette = PALETTES[this.getAttribute('palette')] || PALETTES.green;

    this.settings = {
      letterSpeed:     number('letter-speed', 0.5),
      backgroundSpeed: number('background-speed', -0.3),
      spacing:         number('spacing', 4),
      hold:            number('hold', 5),
      distortion:      number('distortion', 1),
      swell:           number('swell', 1.2),
      delay:           number('delay', 0),
    };

    // What screen readers announce, like the alt text of an image.
    this.alt = this.getAttribute('alt')
      || 'Static interference. ' + this.phrases.join('. ') + '.';
  }

  // The canvas, plus an options button that stays invisible
  // until someone reaches it with the keyboard or a screen reader.
  buildPage() {
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { display: block; }
        canvas { display: block; width: 100%; height: auto; }
        button, select { font: inherit; }

        .options-toggle {
          position: absolute; width: 1px; height: 1px;
          overflow: hidden; clip-path: inset(50%); white-space: nowrap;
        }
        .options-toggle:focus,
        .options-toggle[aria-expanded="true"] {
          position: static; width: auto; height: auto;
          clip-path: none; margin-top: 8px;
        }

        .options {
          display: grid; gap: 8px; margin-top: 8px; padding: 12px;
          border: 1px solid currentColor;
        }
        .options[hidden] { display: none; }
        .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
      </style>

      <canvas role="img"></canvas>

      <button class="options-toggle" aria-expanded="false">Signal options</button>

      <div class="options" hidden>
        <label>Motion
          <select class="motion">
            <option value="full">Full</option>
            <option value="gentle">Gentle</option>
            <option value="still">Still</option>
          </select>
        </label>
        <label><input type="checkbox" class="boost"> Easier to read</label>
        <label><input type="checkbox" class="speak"> Read aloud</label>
        <label><input type="checkbox" class="manual"> Advance manually</label>
        <div class="buttons">
          <button class="next">Next phrase</button>
          <button class="pause">Pause</button>
          <button class="close">Close options</button>
        </div>
      </div>
    `;

    const find = (selector) => shadow.querySelector(selector);

    this.canvas = find('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.setAttribute('aria-label', this.alt);
    this.canvas.style.background = this.palette.background;
    this.motionSelect = find('.motion');

    const toggle = find('.options-toggle');
    const panel = find('.options');
    const setOpen = (open) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };

    toggle.addEventListener('click', () => setOpen(panel.hidden));
    find('.close').addEventListener('click', () => { setOpen(false); toggle.focus(); });

    this.motionSelect.addEventListener('change', (e) => { this.motion = e.target.value; });
    find('.boost').addEventListener('change', (e) => { this.boost = e.target.checked; });
    find('.manual').addEventListener('change', (e) => { this.manual = e.target.checked; });
    find('.next').addEventListener('click', () => { this.skipRequested = true; });

    find('.speak').addEventListener('change', (e) => {
      this.speak = e.target.checked;
      if (this.speak) this.sayAloud(this.phrases[this.phraseIndex]);
      else if (window.speechSynthesis) speechSynthesis.cancel();
    });

    find('.pause').addEventListener('click', (e) => {
      this.paused = !this.paused;
      e.target.textContent = this.paused ? 'Resume' : 'Pause';
    });
  }

  // Two independent random dot grids: one for the letters, one for the background.
  buildDots() {
    const spacing = this.settings.spacing * this.scale;
    this.cols = Math.floor(this.width / spacing);
    this.rows = Math.floor(this.height / spacing);

    const randomGrid = () =>
      Array.from({ length: this.cols * this.rows }, () => Math.random() < DOT_DENSITY);

    this.letterDots = randomGrid();
    this.backgroundDots = randomGrid();
    this.letterOffset = 0;
    this.backgroundOffset = 0;
  }

  // Switch to another phrase.
  loadPhrase(index) {
    this.phraseIndex = index;
    this.buildMask(this.phrases[index]);
    if (this.speak) this.sayAloud(this.phrases[index]);
  }

  // Write the phrase on a hidden canvas and record which pixels are inside the letters.
  buildMask(text) {
    const w = this.width, h = this.height;
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext('2d');

    // Pick the largest font that fits. If one line would be too small
    // (narrow screens), break the phrase into two lines at the middle space.
    const fontFor = (lines) => {
      sctx.font = 'bold 100px Arial, sans-serif';
      const widest = Math.max(...lines.map((line) => sctx.measureText(line).width));
      const byWidth = 100 * (w * 0.9) / widest;
      const byHeight = h * 0.8 / lines.length;
      return Math.floor(Math.min(byWidth, byHeight));
    };

    let lines = [text];
    let fontSize = fontFor(lines);
    const tooSmall = fontSize < 56 * this.scale;
    if (tooSmall && text.includes(' ')) {
      lines = splitInTwo(text);
      fontSize = fontFor(lines);
    }

    sctx.font = `bold ${fontSize}px Arial, sans-serif`;
    sctx.fillStyle = '#fff';
    sctx.textAlign = 'center';
    sctx.textBaseline = 'middle';
    const lineHeight = fontSize * 1.05;
    const firstLineY = h / 2 - (lines.length - 1) * lineHeight / 2;
    lines.forEach((line, i) => sctx.fillText(line, w / 2, firstLineY + i * lineHeight));

    const pixels = sctx.getImageData(0, 0, w, h).data;
    this.mask = new Uint8Array(w * h);
    for (let i = 0; i < this.mask.length; i++) {
      this.mask[i] = pixels[i * 4 + 3] > 128 ? 1 : 0;   // alpha channel
    }
  }

  sayAloud(text) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const voice = new SpeechSynthesisUtterance(text.toLowerCase());
    voice.rate = 0.75;    // slow
    voice.pitch = 0.6;    // low
    speechSynthesis.speak(voice);
  }

  // The motion setting limits what the effect is allowed to do.
  activeSettings() {
    const s = this.settings;
    if (this.motion === 'gentle') {
      return { ...s, letterSpeed: s.letterSpeed / 2, backgroundSpeed: s.backgroundSpeed / 2,
               distortion: 0, swell: 0 };
    }
    if (this.motion === 'still') {
      return { ...s, letterSpeed: 0, backgroundSpeed: 0, distortion: 0, swell: 0 };
    }
    return s;
  }


  // ---------- 3. The signal cycle ----------
  // waiting (only once, if there is a delay) → rise → on → fade → off → rise → ...
  // "strength" is 1 when the message is clear and 0 when it is lost.

  resetSignal() {
    this.time = 0;
    this.strength = 1;
    this.swells = [];
    this.tears = [];
    this.lunge = 0;
    this.lungeTarget = 0;

    if (this.settings.delay > 0) {
      this.strength = 0;                        // start as plain static
      this.goTo('waiting', this.settings.delay * FPS);
    } else {
      this.goTo('on', this.holdLength());
    }
  }

  holdLength() {
    return this.settings.hold * FPS * random(0.8, 1.2);
  }

  goTo(stage, frames) {
    this.stage = stage;
    this.stageTime = 0;
    this.stageLength = frames;
  }

  updateSignal() {
    // While waiting, the clock only runs when the figure is on screen.
    const clockRuns = this.stage !== 'waiting' || this.visible;
    if (clockRuns) this.stageTime++;
    const progress = this.stageTime / this.stageLength;
    const finished = progress >= 1;

    if (this.stage === 'waiting') {
      this.strength = 0;
      if (finished) this.goTo('rise', random(90, 130));
    }
    else if (this.stage === 'on') {
      this.strength = 1;
      const timeUp = !this.manual && finished;
      if (timeUp || this.skipRequested) {
        this.skipRequested = false;
        this.goTo('fade', random(70, 100));
      }
    }
    else if (this.stage === 'fade') {
      this.strength = 1 - smooth(progress);
      if (finished) {
        this.swells = [];
        this.loadPhrase((this.phraseIndex + 1) % this.phrases.length);
        this.goTo('off', random(40, 90));
      }
    }
    else if (this.stage === 'off') {
      this.strength = 0;
      if (finished) this.goTo('rise', random(90, 130));
    }
    else if (this.stage === 'rise') {
      // Rises halfway, hesitates, then finishes.
      if (progress < 0.4)      this.strength = 0.45 * smooth(progress / 0.4);
      else if (progress < 0.6) this.strength = 0.45;
      else                     this.strength = 0.45 + 0.55 * smooth((progress - 0.6) / 0.4);
      if (finished) this.goTo('on', this.holdLength());
    }

    if (this.stage !== 'on') this.skipRequested = false;
  }


  // ---------- 4. Uncanny effects (all eased, no flashing) ----------

  updateEffects(a) {
    this.time++;
    this.updateSwells(a);
    this.updateTears(a);
    this.updateLunge(a);
  }

  // Swelling lines: start halfway through a phrase, grow unevenly, relax before the switch.
  updateSwells(a) {
    if (a.swell === 0) { this.swells = []; return; }

    const lateInPhrase = this.stage === 'on' && this.stageTime > this.stageLength * 0.5;
    const roomForMore = this.swells.length < 1 + Math.round(a.swell * 1.5);
    if (lateInPhrase && roomForMore && Math.random() < 0.02 * a.swell) {
      const k = this.scale;
      this.swells.push({ center: random(20 * k, this.height - 20 * k), reach: random(4, 14) * k,
                         size: 1, target: 1, wait: 0 });
    }

    for (const swell of this.swells) {
      if (this.stage === 'fade') {
        swell.target = 1;                       // shrink back before the next phrase
      } else if (--swell.wait <= 0) {
        swell.wait = random(20, 60);            // pick a new, uneven target now and then
        const shrink = Math.random() < 0.25;
        swell.target = shrink
          ? Math.max(1, swell.size - random(0.1, 0.3))
          : Math.min(1 + a.swell * 1.6, swell.size + random(0.1, 0.5) * a.swell);
      }
      swell.size += (swell.target - swell.size) * 0.03;   // ease toward it
    }
  }

  // Tears: a horizontal band slides sideways and back.
  updateTears(a) {
    if (a.distortion === 0) { this.tears = []; return; }

    if (this.tears.length < 2 && Math.random() < 0.006 * a.distortion) {
      const k = this.scale;
      const top = random(0, this.height - 40 * k);
      const direction = Math.random() < 0.5 ? -1 : 1;
      this.tears.push({
        top, bottom: top + random(10, 40) * k,
        shift: direction * random(6, 20) * k * Math.min(a.distortion, 2),
        age: 0, life: random(50, 90),
      });
    }
    this.tears.forEach((tear) => tear.age++);
    this.tears = this.tears.filter((tear) => tear.age < tear.life);
  }

  // Lunges: the letters briefly surge, then settle.
  updateLunge(a) {
    if (a.distortion === 0) { this.lunge = 0; this.lungeTarget = 0; return; }

    if (this.stage === 'on' && this.lungeTarget === 0 && Math.random() < 0.003 * a.distortion) {
      this.lungeTarget = random(1.5, 3);
    }
    this.lunge += (this.lungeTarget - this.lunge) * 0.06;
    if (this.lungeTarget > 0 && Math.abs(this.lunge - this.lungeTarget) < 0.1) {
      this.lungeTarget = 0;                     // reached the peak, now relax
    }
  }

  moveDots(a) {
    // Breathing: two slow waves out of step, so the rhythm never quite repeats.
    const breath = this.motion === 'full'
      ? 1 + 0.3 * Math.sin(this.time * 0.031) * Math.sin(this.time * 0.0127)
      : 1;

    // The message lives in the speed difference between the two fields.
    const difference = (a.letterSpeed - a.backgroundSpeed) * this.strength * breath * (1 + this.lunge);
    this.backgroundOffset += a.backgroundSpeed * this.scale;
    this.letterOffset += (a.backgroundSpeed + difference) * this.scale;
  }


  // ---------- 5. Drawing ----------

  draw() {
    const ctx = this.ctx;
    const still = this.motion === 'still';

    ctx.globalAlpha = 1;
    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = this.palette.dots;

    // Without motion, the letters have to stand out by brightness instead.
    const letterAlpha = still ? 0.25 + 0.75 * this.strength : 1;
    const backgroundAlpha = still ? (this.boost ? 0.18 : 0.3) : (this.boost ? 0.6 : 1);
    const letterSize = (this.boost ? 3 : (still ? 2.6 : 2)) * this.scale;

    this.drawField(this.letterDots, this.letterOffset, true, letterAlpha, letterSize);
    this.drawField(this.backgroundDots, this.backgroundOffset, false, backgroundAlpha, 2 * this.scale);
    ctx.globalAlpha = 1;
  }

  // Draw one dot field, only on its own side of the letter mask.
  drawField(dots, offset, insideLetters, alpha, size) {
    const spacing = this.settings.spacing * this.scale;
    const loopHeight = this.rows * spacing;
    this.ctx.globalAlpha = alpha;

    for (let col = 0; col < this.cols; col++) {
      const x = col * spacing + Math.floor(spacing / 2);

      for (let row = 0; row < this.rows; row++) {
        if (!dots[col * this.rows + row]) continue;

        const y = ((row * spacing + offset) % loopHeight + loopHeight) % loopHeight;  // wrap
        const inLetter = this.mask[Math.min(this.height - 1, Math.floor(y)) * this.width + x] === 1;
        if (inLetter !== insideLetters) continue;

        const dot = this.distort(y, size);
        this.ctx.fillRect(x + dot.dx - dot.size / 2, dot.y - dot.size / 2, dot.size, dot.size);
      }
    }
  }

  // Apply tears (sideways shift) and swells (stretched band, bigger dots) to one dot.
  distort(y, size) {
    let dx = 0;
    for (const tear of this.tears) {
      if (y >= tear.top && y < tear.bottom) {
        dx += tear.shift * Math.sin(Math.PI * tear.age / tear.life);
      }
    }
    for (const swell of this.swells) {
      if (Math.abs(y - swell.center) < swell.reach) {
        return {
          dx,
          y: swell.center + (y - swell.center) * swell.size,
          size: Math.min(size * swell.size, (this.settings.spacing + 1.5) * this.scale),
        };
      }
    }
    return { dx, y, size };
  }


  // ---------- 6. Main loop ----------

  tick() {
    if (!this.running) return;
    if (!this.paused) {
      const active = this.activeSettings();
      this.updateSignal();
      this.updateEffects(active);
      this.moveDots(active);
    }
    this.draw();   // keep drawing while paused, so option changes still show
    requestAnimationFrame(this.tick);
  }
}

customElements.define('ghost-signal', GhostSignal);
