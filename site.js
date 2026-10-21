(() => {
  'use strict';

  const nav = document.querySelector('.site-nav');
  const links = [...nav.querySelectorAll('a[href^="#"]')].filter(link => link.hash !== '#hero');
  const sections = links.map(link => document.querySelector(link.hash));

  function updateNavigation() {
    const threshold = nav.getBoundingClientRect().height + 48;
    let current = -1;
    sections.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= threshold) current = index;
    });
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
      current = sections.length - 1;
    }
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  function resizeNavigation() {
    document.documentElement.style.setProperty('--nav-height', `${nav.getBoundingClientRect().height}px`);
    updateNavigation();
  }

  let scrollPending = false;
  window.addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      updateNavigation();
      scrollPending = false;
    });
  }, { passive: true });
  window.addEventListener('resize', resizeNavigation);
  if ('ResizeObserver' in window) new ResizeObserver(resizeNavigation).observe(nav);
  resizeNavigation();
  document.fonts.ready.then(resizeNavigation);

  const display = document.querySelector('.signal-display');
  const toggle = display.querySelector('.motion-toggle');
  const carrierPath = display.querySelector('.signal-carrier');
  const responsePath = display.querySelector('.signal-response');
  const waterfall = display.querySelector('.waterfall-canvas');
  const waterfallFallback = display.querySelector('.waterfall-static');
  const waterfallContext = waterfall.getContext('2d');
  const sampleReadout = display.querySelector('[data-sample]');
  const gainReadout = display.querySelector('[data-gain]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sampleRate = 30;
  const sampleInterval = 1000 / sampleRate;
  const historyLength = 240;
  const carrier = [];
  const response = [];
  // A short analysis window follows spikes. The waterfall retains 12.8 seconds
  // at ten rows per second, with distinct contours and narrow spectral crests.
  const analysisLength = 96;
  const fftSize = 1024;
  const frequencyBins = fftSize / 2;
  const visibleRows = 128;
  const waterfallRows = visibleRows + 1;
  const waterfallHop = 3;
  const waterfallInterval = waterfallHop * sampleInterval;
  const fftReal = new Float64Array(fftSize);
  const fftImaginary = new Float64Array(fftSize);
  const spectrum = new Float64Array(frequencyBins);
  const crestRadius = Math.round(fftSize / analysisLength);
  const waterfallPalette = [
    [37, 35, 33], [48, 39, 29], [65, 44, 26], [87, 52, 24],
    [113, 64, 24], [143, 80, 25], [176, 103, 29], [213, 134, 38],
    [244, 169, 58],
  ];
  let previousCrests = [];
  const reverseBits = new Uint16Array(fftSize);
  const windowWeights = Float64Array.from({ length: analysisLength }, (_, index) =>
    .5 - .5 * Math.cos(2 * Math.PI * index / (analysisLength - 1)));
  const windowSum = windowWeights.reduce((sum, value) => sum + value, 0);
  const historyCanvas = document.createElement('canvas');
  historyCanvas.width = frequencyBins;
  historyCanvas.height = waterfallRows;
  const historyContext = historyCanvas.getContext('2d');
  const waterfallPixels = historyContext ? historyContext.createImageData(frequencyBins, waterfallRows) : null;
  for (let index = 0; index < fftSize; index += 1) {
    let value = index;
    let reversed = 0;
    for (let bit = 0; bit < Math.log2(fftSize); bit += 1) {
      reversed = reversed * 2 + (value & 1);
      value >>= 1;
    }
    reverseBits[index] = reversed;
  }
  let userPaused = false;
  let visible = false;
  let running = false;
  let frameId = null;
  let previousTime = null;
  let sampleRemainder = 0;
  let readoutTime = 0;
  let waterfallTime = 0;
  let waterfallDirty = true;
  let sampleCount = 0;
  let gain = .58;
  let targetGain = .58;
  let noise = 0;
  let nextBurst = .3;
  let burst = { center: 0, width: .04, amplitude: 0 };

  const clamp = value => Math.max(-.95, Math.min(.95, value));

  function appendSample() {
    const time = sampleCount / sampleRate;
    gain += (targetGain - gain) * .035;
    // Correlated noise and occasional bipolar bursts vary over time, not per frame.
    noise = noise * .65 + (Math.random() * 2 - 1) * .35;
    if (time >= nextBurst) {
      burst = {
        center: time + .06,
        width: .025 + Math.random() * .045,
        amplitude: (.95 + Math.random() * .85) * (Math.random() < .25 ? -1 : 1),
      };
      nextBurst = time + .65 + Math.random() * 1.1;
    }
    const pulse = burst.amplitude * (
      Math.exp(-Math.pow((time - burst.center) / burst.width, 2)) -
      .4 * Math.exp(-Math.pow((time - burst.center - burst.width * 1.8) / burst.width, 2))
    );
    const wave = Math.sin(time * Math.PI * 1.3) * .3 + Math.sin(time * Math.PI * 3.7) * .08;
    const delayed = carrier[Math.max(0, carrier.length - 5)] || 0;
    const nextCarrier = clamp((wave + noise * .2 + pulse) * gain);
    const nextResponse = clamp(delayed * .72 + Math.sin(time * Math.PI * .84) * .075 + noise * .07);
    carrier.push(nextCarrier);
    response.push(nextResponse);
    if (carrier.length > historyLength) {
      carrier.shift();
      response.shift();
    }
    sampleCount += 1;
  }

  function drawTraces() {
    for (const [values, path, baseline] of [[carrier, carrierPath, 80], [response, responsePath, 180]]) {
      path.setAttribute('d', values.map((value, index) => {
        const x = 24 + index / (historyLength - 1) * 472;
        return `${index ? 'L' : 'M'}${x.toFixed(1)} ${(baseline - value * 52).toFixed(1)}`;
      }).join(' '));
    }
  }

  function recordWaterfallRow() {
    if (!waterfallPixels || !waterfallContext) return;
    const samples = carrier.slice(-analysisLength);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    fftReal.fill(0);
    fftImaginary.fill(0);
    for (let index = 0; index < samples.length; index += 1) {
      fftReal[reverseBits[index]] = (samples[index] - mean) * windowWeights[index];
    }
    for (let size = 2; size <= fftSize; size *= 2) {
      const half = size / 2;
      const cosine = Math.cos(-2 * Math.PI / size);
      const sine = Math.sin(-2 * Math.PI / size);
      for (let start = 0; start < fftSize; start += size) {
        let rotationReal = 1;
        let rotationImaginary = 0;
        for (let index = 0; index < half; index += 1) {
          const left = start + index;
          const right = left + half;
          const real = rotationReal * fftReal[right] - rotationImaginary * fftImaginary[right];
          const imaginary = rotationReal * fftImaginary[right] + rotationImaginary * fftReal[right];
          fftReal[right] = fftReal[left] - real;
          fftImaginary[right] = fftImaginary[left] - imaginary;
          fftReal[left] += real;
          fftImaginary[left] += imaginary;
          const nextReal = rotationReal * cosine - rotationImaginary * sine;
          rotationImaginary = rotationReal * sine + rotationImaginary * cosine;
          rotationReal = nextReal;
        }
      }
    }
    const pixels = waterfallPixels.data;
    const rowBytes = frequencyBins * 4;
    pixels.copyWithin(rowBytes, 0, pixels.length - rowBytes);
    for (let bin = 0; bin < frequencyBins; bin += 1) {
      const magnitude = 2 * Math.hypot(fftReal[bin], fftImaginary[bin]) / windowSum;
      spectrum[bin] = 20 * Math.log10(magnitude + .00001);
      // Fixed 3 dB color steps give each band a clear edge and suppress the
      // noise floor. Levels stay comparable as new observations scroll past.
      const level = Math.max(0, Math.min(waterfallPalette.length - 1,
        Math.floor((spectrum[bin] + 40) / 3)));
      pixels.set(waterfallPalette[level], bin * 4);
      pixels[bin * 4 + 3] = 255;
    }
    // Mark only resolved local peaks, rather than amplifying every small ripple.
    // These narrow crests make frequency paths legible within the filled bands.
    const crests = [];
    for (let bin = crestRadius; bin < frequencyBins - crestRadius; bin += 1) {
      const peak = spectrum[bin];
      if (peak < -30 || peak <= spectrum[bin - 1] || peak < spectrum[bin + 1]) continue;
      const shoulder = Math.max(spectrum[bin - crestRadius], spectrum[bin + crestRadius]);
      if (peak - shoulder < 1.5) continue;
      crests.push(bin);
    }
    for (const bin of crests) {
      const peak = spectrum[bin];
      const previous = previousCrests.reduce((nearest, candidate) =>
        Math.abs(candidate - bin) < Math.abs(nearest - bin) ? candidate : nearest, Infinity);
      const closestCurrent = crests.reduce((nearest, candidate) =>
        Math.abs(candidate - previous) < Math.abs(nearest - previous) ? candidate : nearest, Infinity);
      // Join only mutual nearest peaks within one resolved frequency band. This
      // keeps a moving crest continuous without joining unrelated neighbors.
      const connected = closestCurrent === bin && Math.abs(previous - bin) <= crestRadius;
      const start = Math.min(bin, connected ? previous : bin) - 1;
      const end = Math.max(bin, connected ? previous : bin) + 1;
      const crest = peak > -22 ? [255, 226, 168] : [239, 173, 77];
      for (let column = start; column <= end; column += 1) pixels.set(crest, column * 4);
    }
    previousCrests = crests;
    waterfallDirty = true;
  }

  function paintWaterfall() {
    if (!waterfallContext || !waterfallPixels || !historyContext) return;
    if (waterfallDirty) {
      historyContext.putImageData(waterfallPixels, 0, 0);
      waterfallDirty = false;
    }
    const progress = Math.min(1, waterfallTime / waterfallInterval);
    const rowHeight = waterfall.height / visibleRows;
    // Keep both the contours and their scroll positions on physical pixels.
    waterfallContext.imageSmoothingEnabled = false;
    waterfallContext.clearRect(0, 0, waterfall.width, waterfall.height);
    waterfallContext.drawImage(historyCanvas, 0, Math.round((progress - 1) * rowHeight),
      waterfall.width, waterfallRows * rowHeight);
  }

  function resizeWaterfall() {
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    waterfall.width = Math.max(1, Math.round(waterfall.clientWidth * ratio));
    waterfall.height = Math.max(1, Math.round(waterfall.clientHeight * ratio));
    paintWaterfall();
  }

  function updateReadouts() {
    const current = Math.round(targetGain * 100);
    let next = 44 + Math.floor(Math.random() * 31);
    if (next === current) next = 44 + (next - 44 + 1) % 31;
    targetGain = next / 100;
    sampleReadout.textContent = String(sampleCount % 10000).padStart(4, '0');
    gainReadout.textContent = targetGain.toFixed(2);
  }

  function animate(time) {
    frameId = null;
    if (!running) return;
    const delta = previousTime === null ? 0 : Math.min(time - previousTime, 80);
    previousTime = time;
    sampleRemainder += delta;
    readoutTime += delta;
    waterfallTime += delta;
    let sampled = false;
    while (sampleRemainder >= sampleInterval) {
      appendSample();
      sampleRemainder -= sampleInterval;
      if (sampleCount % waterfallHop === 0) {
        recordWaterfallRow();
        waterfallTime = sampleRemainder;
      }
      sampled = true;
    }
    if (sampled) drawTraces();
    paintWaterfall();
    if (readoutTime >= 1500) {
      updateReadouts();
      readoutTime %= 1500;
    }
    frameId = requestAnimationFrame(animate);
  }

  function synchronizeMotion() {
    running = !userPaused && !reducedMotion.matches && visible && !document.hidden;
    display.dataset.running = String(running);
    toggle.disabled = reducedMotion.matches;
    toggle.textContent = reducedMotion.matches ? 'Motion reduced' : userPaused ? 'Resume motion' : 'Pause motion';
    toggle.setAttribute('aria-pressed', String(userPaused || reducedMotion.matches));
    if (running && frameId === null) frameId = requestAnimationFrame(animate);
    if (!running) {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      previousTime = null;
    }
  }

  // Keep the authored SVG as a useful static fallback when JavaScript is disabled.
  for (let index = 0; index < analysisLength + waterfallRows * waterfallHop; index += 1) {
    appendSample();
    if (carrier.length >= analysisLength && sampleCount % waterfallHop === 0) recordWaterfallRow();
  }
  drawTraces();
  sampleReadout.textContent = String(sampleCount).padStart(4, '0');
  if (waterfallContext && historyContext) {
    waterfall.hidden = false;
    waterfallFallback.setAttribute('hidden', '');
    resizeWaterfall();
    if ('ResizeObserver' in window) new ResizeObserver(resizeWaterfall).observe(waterfall);
    window.addEventListener('resize', resizeWaterfall);
  }

  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    userPaused = !userPaused;
    synchronizeMotion();
  });
  reducedMotion.addEventListener('change', synchronizeMotion);
  document.addEventListener('visibilitychange', synchronizeMotion);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      synchronizeMotion();
    }, { threshold: 0 }).observe(display);
  }
  // Without an observer the illustration stays static and its controls stay hidden.
  else toggle.hidden = true;
  synchronizeMotion();
})();
