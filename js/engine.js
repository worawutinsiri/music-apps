/* Audio engine: <audio> element → preamp → 10-band EQ → analyser → volume → speakers.
   The AudioContext is created lazily on the first user gesture (autoplay policy). */
const Engine = (() => {
  const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const el = new Audio();
  el.preload = 'auto';

  let ctx = null, preamp, analyser, volumeNode, filters = [];
  let freqBuf = null, timeBuf = null;
  let gains = BANDS.map(() => 0);
  let eqOn = true;
  let volume = 0.85;
  let pauseTimer = 0;

  // A detached context mirrors the filters so the EQ curve can be drawn before playback starts
  let curveFilters = null;

  const volumeGain = (v) => v * v; // perceptual curve

  function makeFilter(context, freq, i) {
    const f = context.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = freq;
    f.Q.value = 1.1;
    f.gain.value = 0;
    return f;
  }

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'playback' });
    const source = ctx.createMediaElementSource(el);
    preamp = ctx.createGain();
    filters = BANDS.map((f, i) => makeFilter(ctx, f, i));
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    volumeNode = ctx.createGain();

    let node = source.connect(preamp);
    for (const f of filters) node = node.connect(f);
    node.connect(analyser).connect(volumeNode).connect(ctx.destination);

    freqBuf = new Float32Array(analyser.frequencyBinCount);
    timeBuf = new Float32Array(analyser.fftSize);
    applyEq();
    volumeNode.gain.value = el.paused ? 0 : volumeGain(volume);
    return ctx;
  }

  function effectiveGains() {
    return eqOn ? gains : gains.map(() => 0);
  }

  function applyEq() {
    const g = effectiveGains();
    const headroom = Math.max(0, ...g) * 0.6; // avoid clipping when boosting
    if (!ctx) return;
    const t = ctx.currentTime;
    filters.forEach((f, i) => f.gain.setTargetAtTime(g[i], t, 0.03));
    preamp.gain.setTargetAtTime(Math.pow(10, -headroom / 20), t, 0.03);
  }

  function ramp(target, seconds) {
    if (!ctx) return;
    const g = volumeNode.gain, t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + seconds);
  }

  function play() {
    init();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    clearTimeout(pauseTimer);
    ramp(volumeGain(volume), 0.2);
    return el.play();
  }

  function pause() {
    if (!ctx || el.paused) { el.pause(); return; }
    ramp(0, 0.12);
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => el.pause(), 130);
  }

  function load(url) {
    clearTimeout(pauseTimer);
    el.src = url;
  }

  function unload() {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  function seek(t) {
    if (!isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration - 0.05, t));
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (ctx && !el.paused) ramp(volumeGain(volume), 0.05);
  }

  function setGains(list) { gains = list.slice(); applyEq(); }
  function setBand(i, db) { gains[i] = db; applyEq(); }
  function setEqEnabled(on) { eqOn = on; applyEq(); }

  /* Combined EQ response (dB) at the given frequencies for a set of band gains */
  function response(freqs, list = gains) {
    if (!curveFilters) {
      const off = new OfflineAudioContext(1, 1, 44100);
      curveFilters = BANDS.map((f, i) => makeFilter(off, f, i));
    }
    curveFilters.forEach((f, i) => { f.gain.value = list[i]; });
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    const total = new Float32Array(freqs.length);
    for (const f of curveFilters) {
      f.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < total.length; i++) total[i] += 20 * Math.log10(mag[i] || 1e-6);
    }
    return total;
  }

  function frequencyData() {
    if (!analyser) return null;
    analyser.getFloatFrequencyData(freqBuf);
    return freqBuf;
  }

  /* RMS level of the current window in dBFS */
  function levelDb() {
    if (!analyser) return -Infinity;
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    return 20 * Math.log10(Math.sqrt(sum / timeBuf.length) || 1e-9);
  }

  function resumeIfNeeded() {
    if (ctx && ctx.state !== 'running' && !el.paused) ctx.resume().catch(() => {});
  }

  return {
    BANDS, el, init, play, pause, load, unload, seek,
    setVolume, setGains, setBand, setEqEnabled, response,
    frequencyData, levelDb, resumeIfNeeded,
    get ready() { return !!ctx; },
    get sampleRate() { return ctx ? ctx.sampleRate : 44100; },
    get binCount() { return analyser ? analyser.frequencyBinCount : 4096; },
    get volume() { return volume; },
  };
})();
