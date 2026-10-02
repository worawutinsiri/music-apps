/* Renders a short lo-fi loop with OfflineAudioContext so the player has something to show
   before the user adds music. Output is a 16-bit WAV blob. */
const Demo = (() => {
  const SR = 44100;
  const BPM = 92;
  const BEAT = 60 / BPM;
  const BAR = BEAT * 4;
  const BARS = 12;

  const CHORDS = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]]; // Fmaj7 Em7 Dm7 Cmaj7
  const ROOTS = [41, 40, 38, 36];
  const MELODY = [[72, 76, 79, 81], [71, 74, 76, 79], [69, 72, 74, 77], [67, 71, 72, 76]];

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function rng(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function noiseBuffer(ctx) {
    const buf = ctx.createBuffer(1, SR, SR);
    const d = buf.getChannelData(0);
    const r = rng(42);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    return buf;
  }

  function env(param, t, peak, attack, decay, floor = 0.0001) {
    param.setValueAtTime(floor, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(floor, t + attack + decay);
  }

  function kick(ctx, out, t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
    env(g.gain, t, 0.95, 0.004, 0.42);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.5);
  }

  function snare(ctx, out, noise, t) {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    env(g.gain, t, 0.42, 0.003, 0.2);
    n.connect(bp).connect(g).connect(out);
    n.start(t, 0.2);
    n.stop(t + 0.26);

    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = 190;
    env(og.gain, t, 0.25, 0.002, 0.09);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.12);
  }

  function hat(ctx, out, noise, t, vel) {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7800;
    const g = ctx.createGain();
    env(g.gain, t, 0.16 * vel, 0.002, 0.05);
    n.connect(hp).connect(g).connect(out);
    n.start(t, 0.5);
    n.stop(t + 0.08);
  }

  function bass(ctx, out, midi, t, len) {
    const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = mtof(midi);
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
    g.gain.setValueAtTime(0.5, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(lp).connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  function pad(ctx, out, notes, t, len) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.linearRampToValueAtTime(1600, t + len / 2);
    lp.frequency.linearRampToValueAtTime(900, t + len);
    lp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.35);
    g.gain.setValueAtTime(0.05, t + len - 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + len + 0.3);
    lp.connect(g).connect(out);
    for (const m of notes) {
      for (const [detune, panv] of [[-7, -0.45], [7, 0.45]]) {
        const o = ctx.createOscillator(), p = ctx.createStereoPanner();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = detune;
        p.pan.value = panv;
        o.connect(p).connect(lp);
        o.start(t);
        o.stop(t + len + 0.35);
      }
    }
  }

  function pluck(ctx, out, send, midi, t, panv) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator();
    const g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = 'triangle';
    o2.type = 'sine';
    o.frequency.value = mtof(midi);
    o2.frequency.value = mtof(midi + 12);
    env(g.gain, t, 0.2, 0.006, 0.55);
    p.pan.value = panv;
    o.connect(g);
    o2.connect(g);
    g.connect(p).connect(out);
    p.connect(send);
    for (const osc of [o, o2]) { osc.start(t); osc.stop(t + 0.65); }
  }

  function toWav(buffer) {
    const ch = buffer.numberOfChannels, len = buffer.length;
    const channels = [];
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      channels.push(d);
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const norm = peak > 0 ? 0.89 / peak : 1;
    const bytes = len * ch * 2;
    const view = new DataView(new ArrayBuffer(44 + bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    view.setUint32(4, 36 + bytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, ch, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * ch * 2, true);
    view.setUint16(32, ch * 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i] * norm));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        o += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  async function render() {
    const length = BAR * BARS + 1.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * length), SR);
    const noise = noiseBuffer(ctx);
    const r = rng(7);

    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    master.gain.setValueAtTime(0.9, 0);
    master.gain.setValueAtTime(0.9, BAR * (BARS - 1));
    master.gain.linearRampToValueAtTime(0.0001, length);

    const delay = ctx.createDelay(1);
    delay.delayTime.value = BEAT * 0.75;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(master);

    for (let bar = 0; bar < BARS; bar++) {
      const t0 = bar * BAR;
      const ci = bar % 4;
      pad(ctx, master, CHORDS[ci], t0, BAR);

      if (bar >= 1) {
        for (let s = 0; s < 8; s++) {
          const swing = s % 2 ? BEAT * 0.08 : 0;
          hat(ctx, master, noise, t0 + s * BEAT / 2 + swing, s % 2 ? 0.55 : 1);
        }
      }
      if (bar >= 2) {
        kick(ctx, master, t0);
        kick(ctx, master, t0 + BEAT * 2.5);
        if (bar % 2) kick(ctx, master, t0 + BEAT * 1.75);
        snare(ctx, master, noise, t0 + BEAT);
        snare(ctx, master, noise, t0 + BEAT * 3);

        const root = ROOTS[ci];
        bass(ctx, master, root, t0, BEAT * 0.9);
        bass(ctx, master, root, t0 + BEAT * 1.5, BEAT * 0.45);
        bass(ctx, master, root + 7, t0 + BEAT * 2, BEAT * 0.9);
        bass(ctx, master, root + 12, t0 + BEAT * 3.5, BEAT * 0.4);
      }
      if (bar >= 4 && bar < BARS - 1) {
        const scale = MELODY[ci];
        for (let s = 0; s < 8; s++) {
          if (r() < (s % 2 ? 0.35 : 0.6)) {
            const note = scale[Math.floor(r() * scale.length)];
            pluck(ctx, master, delay, note, t0 + s * BEAT / 2, r() * 0.6 - 0.3);
          }
        }
      }
    }

    const rendered = await ctx.startRendering();
    return toWav(rendered);
  }

  return {
    render,
    meta: { title: 'Sunny Afternoon', artist: 'neumorph · เพลงตัวอย่าง', album: 'Demo' },
  };
})();
