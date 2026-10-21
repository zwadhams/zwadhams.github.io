const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'site.js'), 'utf8');

function createHarness({ seed = 1, reduced = false, observer = true, canvasSupported = true } = {}) {
  const frames = new Map();
  const handlers = {};
  let now = 0;
  let nextId = 0;
  let intersection;
  const element = () => ({
    attributes: {}, children: [], textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, handler) { this[name] = handler; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  });
  const toggle = element();
  const carrier = element();
  const response = element();
  const createCanvas = () => {
    const canvas = { ...element(), clientWidth: 472, clientHeight: 128 };
    const context = {
      pixels: null, offset: 0,
      createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData(image) { this.pixels = image.data.slice(); this.imageWidth = image.width; this.imageHeight = image.height; },
      clearRect() {},
      drawImage(source, x, y) {
        this.pixels = source.context.pixels;
        this.offset = y;
        this.imageWidth = source.context.imageWidth;
        this.imageHeight = source.context.imageHeight;
      },
    };
    canvas.context = context;
    canvas.getContext = () => canvasSupported ? context : null;
    return canvas;
  };
  const waterfall = createCanvas();
  const fallback = element();
  const sample = { textContent: '0240' };
  const gain = { textContent: '0.58' };
  const display = {
    dataset: {},
    querySelector(selector) {
      return { '.motion-toggle': toggle, '.signal-carrier': carrier, '.signal-response': response,
        '.waterfall-canvas': waterfall, '.waterfall-static': fallback,
        '[data-sample]': sample, '[data-gain]': gain }[selector];
    },
  };
  const nav = { querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 90 }) };
  const media = { matches: reduced, addEventListener(name, handler) { this[name] = handler; } };
  const document = {
    hidden: false,
    documentElement: { scrollHeight: 5000, style: { setProperty() {} } },
    fonts: { ready: Promise.resolve() },
    querySelector(selector) { return { '.site-nav': nav, '.signal-display': display }[selector]; },
    createElementNS: element,
    createElement: createCanvas,
    addEventListener(name, handler) { handlers[name] = handler; },
  };
  const window = { scrollY: 0, innerHeight: 900, devicePixelRatio: 2, addEventListener() {}, matchMedia: () => media };
  class IntersectionObserver {
    constructor(handler) { intersection = handler; }
    observe() { intersection([{ isIntersecting: true }]); }
  }
  if (observer) window.IntersectionObserver = IntersectionObserver;
  const seededMath = Object.create(Math);
  seededMath.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  vm.runInNewContext(source, { document, window, IntersectionObserver, Math: seededMath,
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  return {
    display, toggle, carrier, response, waterfall, fallback, sample, gain, frames,
    advance(milliseconds) {
      const end = now + milliseconds;
      while (now < end) {
        now = Math.min(now + 16, end);
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback(now));
      }
    },
    setHidden(value) { document.hidden = value; handlers.visibilitychange(); },
    setVisible(value) { intersection([{ isIntersecting: value }]); },
    setReduced(value) { media.matches = value; media.change(); },
  };
}

function snapshot(harness) {
  return JSON.stringify([harness.carrier.attributes.d, harness.response.attributes.d,
    harness.waterfall.context.pixels, harness.waterfall.context.offset,
    harness.sample.textContent, harness.gain.textContent]);
}

test('generated signals vary between sessions, contain spikes, and fit their tracks', () => {
  const first = createHarness({ seed: 1 });
  const second = createHarness({ seed: 2 });
  assert.notEqual(first.carrier.attributes.d, second.carrier.attributes.d);
  for (const [trace, baseline] of [[first.carrier, 80], [first.response, 180]]) {
    const points = [...trace.attributes.d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)];
    assert.equal(points.length, 240);
    for (const [, x, y] of points) {
      assert(Number(x) >= 24 && Number(x) <= 496);
      assert(Math.abs(Number(y) - baseline) <= 49.5);
    }
  }
  assert([...first.carrier.attributes.d.matchAll(/[ML][\d.]+ ([\d.]+)/g)]
    .some(([, y]) => Math.abs(Number(y) - 80) > 25), 'Includes a distinct spike');
});

test('waterfall preserves detailed spectral history and uses the device pixel ratio', () => {
  const h = createHarness();
  const context = h.waterfall.context;
  assert.equal(h.waterfall.width, 944);
  assert.equal(h.waterfall.height, 256);
  assert.equal(context.imageWidth, 512);
  assert.equal(context.imageHeight, 129);
  assert.equal(h.fallback.attributes.hidden, '');
  const before = context.pixels.slice();
  const red = Array.from(before).filter((_, index) => index % 4 === 0);
  assert(new Set(red).size >= 8 && new Set(red).size <= 11,
    'Uses distinct energy contours with crisp boundaries');
  assert(Math.max(...red) - Math.min(...red) > 150, 'Strong spectral ridges remain visible');
  for (let index = 3; index < before.length; index += 4) assert.equal(before[index], 255);
  h.advance(125);
  const rowLength = context.imageWidth * 4;
  assert.deepEqual(context.pixels.slice(rowLength, rowLength * 2), before.slice(0, rowLength),
    'A new observation moves the preceding observation down one row');
  assert.notDeepEqual(context.pixels.slice(0, rowLength), before.slice(0, rowLength));
});

test('traces scroll and both readouts change at the intended cadence', () => {
  const h = createHarness();
  const first = h.carrier.attributes.d;
  const initialSample = h.sample.textContent;
  h.advance(1000);
  assert.notEqual(h.carrier.attributes.d, first);
  assert.equal(h.sample.textContent, initialSample);
  assert.equal(h.gain.textContent, '0.58');
  h.advance(600);
  assert.notEqual(h.sample.textContent, initialSample);
  assert.notEqual(h.gain.textContent, '0.58');
  for (let update = 0; update < 20; update += 1) {
    const previous = [h.sample.textContent, h.gain.textContent];
    h.advance(1500);
    assert.notEqual(h.sample.textContent, previous[0]);
    assert.notEqual(h.gain.textContent, previous[1]);
  }
});

test('pause freezes every display element and resume does not jump forward', () => {
  const h = createHarness();
  h.advance(1750);
  h.toggle.click();
  const paused = snapshot(h);
  assert.equal(h.display.dataset.running, 'false');
  assert.equal(h.frames.size, 0);
  h.advance(30000);
  assert.equal(snapshot(h), paused);
  h.toggle.click();
  h.advance(16);
  assert.equal(snapshot(h), paused);
  h.advance(100);
  assert.notEqual(snapshot(h), paused);
});

test('offscreen, hidden tabs, and reduced motion stop all animation work', () => {
  const h = createHarness();
  h.advance(1000);
  for (const setStopped of [value => h.setVisible(!value), value => h.setHidden(value), value => h.setReduced(value)]) {
    setStopped(true);
    const stopped = snapshot(h);
    assert.equal(h.frames.size, 0);
    assert.equal(h.display.dataset.running, 'false');
    h.advance(5000);
    assert.equal(snapshot(h), stopped);
    setStopped(false);
    assert.equal(h.display.dataset.running, 'true');
    assert.equal(h.frames.size, 1);
    h.advance(100);
  }
});

test('reduced motion at startup and missing observer support leave a static display', () => {
  const reduced = createHarness({ reduced: true });
  assert.equal(reduced.frames.size, 0);
  assert.equal(reduced.toggle.disabled, true);
  assert(reduced.carrier.attributes.d.length > 100);
  const fallback = createHarness({ observer: false });
  assert.equal(fallback.frames.size, 0);
  assert.equal(fallback.toggle.hidden, true);
});

test('without a canvas context the SVG fallback stays and the traces still work', () => {
  const h = createHarness({ canvasSupported: false });
  assert.equal(h.fallback.attributes.hidden, undefined);
  const initial = h.carrier.attributes.d;
  h.advance(1700);
  assert.notEqual(h.carrier.attributes.d, initial);
  assert.equal(h.display.dataset.running, 'true');
});
