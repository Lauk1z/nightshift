'use strict';
// 宣传视频的背景音乐：用 Web Audio 现场合成，不用音频文件，和画面一样每次都一模一样。
// 120 BPM，一小节 2 秒，正好对上 promo.html 的分镜：
//   0–6    夜里：铺底的和弦，几个八音盒一样的音；最后两秒往上扬
//   6–30   天亮：鼓、贝斯和琶音进来（C – G – Am – F）；20 秒起加一段铃声旋律
//   30–44  天黑：鼓停了，只剩时钟的滴答和压暗的琶音，接力还在继续；最后两秒再往上扬
//   44–52  天又亮了：一串亮音，鼓重新进来
//   52–60  结尾：只剩和弦和铃声，跟着画面淡出
// renderMusic() 返回 48 kHz 立体声的 AudioBuffer，export 时编成 AAC 放进 MP4。
(function () {
  const SR = 48000;
  const DURATION = 60;
  const BEAT = 0.5;
  const BAR = 2;
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // 和弦：pad 是铺底的四个音，arp 是琶音用的四个音，bass 是根音（MIDI 音高）
  const CHORDS = {
    Am9: { pad: [57, 60, 67, 71], arp: [69, 72, 76, 79], bass: 45 },
    Fmaj7: { pad: [53, 57, 60, 64], arp: [69, 72, 76, 77], bass: 41 },
    C: { pad: [55, 60, 64, 74], arp: [72, 76, 79, 84], bass: 36 },
    G: { pad: [55, 59, 62, 69], arp: [71, 74, 79, 83], bass: 43 },
    Am: { pad: [57, 60, 64, 71], arp: [72, 76, 81, 84], bass: 45 },
    F: { pad: [57, 60, 65, 67], arp: [72, 77, 81, 84], bass: 41 },
    Gsus: { pad: [55, 60, 62, 67], arp: [72, 74, 79, 84], bass: 43 },
  };
  // 每小节一个和弦，一共 30 小节
  const BARS = ['Am9', 'Am9', 'Fmaj7', 'C', 'G', 'Am', 'F', 'C', 'G', 'F', 'C', 'G', 'Am', 'F', 'Gsus', 'Am', 'F', 'C', 'G', 'Am', 'F', 'G', 'C', 'G', 'Am', 'F', 'C', 'F', 'C', 'C'];
  // 每小节属于哪一段
  const section = (bar) => (bar < 3 ? 'intro' : bar < 10 ? 'dayA' : bar < 15 ? 'dayB' : bar < 22 ? 'night' : bar < 26 ? 'dayC' : 'outro');

  // 铃声旋律：[小节, 第几拍, 音高, 几拍]
  const HOOK = [
    [0, 0, 76, 1],
    [0, 1, 79, 1],
    [0, 2, 84, 2],
    [1, 0, 83, 1],
    [1, 1, 86, 1],
    [1, 2, 79, 2],
    [2, 0, 84, 1],
    [2, 1, 83, 1],
    [2, 2, 81, 2],
    [3, 0, 81, 1],
    [3, 1, 79, 1],
    [3, 2, 77, 1],
    [3, 3, 76, 1],
  ];
  const BELLS = [
    ...HOOK.map(([b, beat, n, len]) => [10 + b, beat, n, len]),
    [14, 0, 74, 2],
    [14, 2, 79, 2],
    ...HOOK.map(([b, beat, n, len]) => [22 + b, beat, n, len]),
    [26, 0, 76, 2],
    [26, 2, 79, 2],
    [27, 0, 81, 2],
    [27, 2, 84, 2],
    [28, 0, 79, 2],
    [28, 2, 76, 2],
    [29, 0, 72, 4],
    [29, 0, 84, 4],
  ];
  // 开头夜里的几个音（光标在闪）
  const MUSIC_BOX = [
    [0, 1, 76],
    [0, 3, 81],
    [1, 1, 79],
    [1, 2.5, 76],
    [1, 3, 84],
    [2, 1, 81],
    [2, 2, 77],
  ];

  // 固定种子的随机数，噪声每次都一样
  function rng(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function renderMusic() {
    const ctx = new OfflineAudioContext(2, SR * DURATION, SR);
    const rand = rng(7);

    // 白噪声（鼓、镲、上扬的声音都用它）
    const noise = ctx.createBuffer(1, SR * 3, SR);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = rand() * 2 - 1;

    // 混响：衰减的噪声当作冲激响应
    const ir = ctx.createBuffer(2, Math.round(SR * 2.6), SR);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const t = i / SR;
        d[i] = (rand() * 2 - 1) * Math.exp(-t / 0.65) * Math.min(1, t / 0.012);
      }
    }

    // ---------- 总线 ----------
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9;
    comp.knee.value = 8;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.008;
    comp.release.value = 0.25;
    const master = ctx.createGain();
    // 开头从无声里起来，结尾跟着画面暗下去
    master.gain.setValueAtTime(0.0001, 0);
    master.gain.exponentialRampToValueAtTime(1, 1.2);
    master.gain.setValueAtTime(1, 57);
    master.gain.linearRampToValueAtTime(0, 59.9);
    comp.connect(master).connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = ir;
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.32;
    reverb.connect(reverbOut).connect(comp);

    // 一条乐器总线：滤波 → 音量 → 混音，另外送一部分到混响
    function bus(gain, cutoff, send) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      filter.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = gain;
      filter.connect(g).connect(comp);
      if (send) {
        const s = ctx.createGain();
        s.gain.value = send;
        g.connect(s).connect(reverb);
      }
      return { input: filter, filter, gain: g };
    }
    const padBus = bus(1, 900, 0.5);
    const arpBus = bus(1, 1500, 0.35);
    const bassBus = bus(1, 360, 0);
    const bellBus = bus(1, 9000, 0.7);
    const drumBus = bus(1, 16000, 0.12);

    // 琶音的回声（附点八分音符）
    const delay = ctx.createDelay(1);
    delay.delayTime.value = BEAT * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = 'lowpass';
    delayTone.frequency.value = 2600;
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.28;
    arpBus.gain.connect(delay);
    delay.connect(delayTone).connect(fb).connect(delay);
    delayTone.connect(delayOut).connect(comp);

    // 各段的音色：白天亮、夜里暗
    const LOOK = {
      intro: { pad: 900, arp: 1800, bass: 300 },
      dayA: { pad: 2400, arp: 4200, bass: 520 },
      dayB: { pad: 3000, arp: 5200, bass: 560 },
      night: { pad: 750, arp: 1300, bass: 320 },
      dayC: { pad: 3000, arp: 5200, bass: 560 },
      outro: { pad: 1800, arp: 3000, bass: 400 },
    };
    for (let bar = 0; bar < BARS.length; bar++) {
      if (bar && section(bar) === section(bar - 1)) continue;
      const t = bar * BAR;
      const look = LOOK[section(bar)];
      for (const [b, key] of [
        [padBus, 'pad'],
        [arpBus, 'arp'],
        [bassBus, 'bass'],
      ]) {
        b.filter.frequency.setTargetAtTime(look[key], Math.max(0, t - 0.25), 0.35);
      }
    }

    // ---------- 乐器 ----------
    function env(g, t, peak, attack, decay, hold = 0, release = decay) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
      g.gain.setTargetAtTime(0, t + attack + hold, release / 4);
    }

    // 铺底的和弦：每个音两个稍微跑调的锯齿波，左右各一个
    function pad(t, len, notes, level) {
      for (const n of notes) {
        for (const [detune, pan] of [
          [-7, -0.7],
          [7, 0.7],
        ]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = hz(n);
          o.detune.value = detune;
          const g = ctx.createGain();
          const p = ctx.createStereoPanner();
          p.pan.value = pan;
          env(g, t, level, 0.45, 0.9, len - 0.2);
          o.connect(g).connect(p).connect(padBus.input);
          o.start(t);
          o.stop(t + len + 2);
        }
      }
    }

    // 拨弦一样的琶音
    let side = 1;
    function pluck(t, n, level, out = arpBus.input) {
      side = -side;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz(n);
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = hz(n + 12);
      const g = ctx.createGain();
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      const p = ctx.createStereoPanner();
      p.pan.value = side * 0.35;
      env(g, t, level, 0.004, 0.28);
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(p).connect(out);
      o.start(t);
      o2.start(t);
      o.stop(t + 0.6);
      o2.stop(t + 0.6);
    }

    function bass(t, len, n, level) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(n);
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = hz(n);
      const g = ctx.createGain();
      env(g, t, level, 0.006, 0.12, Math.max(0, len - 0.1));
      o.connect(g);
      sub.connect(g);
      g.connect(bassBus.input);
      o.start(t);
      sub.start(t);
      o.stop(t + len + 0.5);
      sub.stop(t + len + 0.5);
    }

    // 铃声：调频合成
    function bell(t, len, n, level) {
      const car = ctx.createOscillator();
      car.frequency.value = hz(n);
      const mod = ctx.createOscillator();
      mod.frequency.value = hz(n) * 3.5;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(hz(n) * 2.2, t);
      depth.gain.setTargetAtTime(0, t, 0.25);
      mod.connect(depth).connect(car.frequency);
      const g = ctx.createGain();
      env(g, t, level, 0.003, 1.6, 0, Math.max(1.6, len * BEAT * 1.4));
      car.connect(g).connect(bellBus.input);
      car.start(t);
      mod.start(t);
      car.stop(t + 6);
      mod.stop(t + 6);
    }

    function noiseHit(t, len, level, type, freq, q, out = drumBus.input, pan = 0) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      env(g, t, level, 0.002, len);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      s.connect(f).connect(g).connect(p).connect(out);
      s.start(t, rand() * 2);
      s.stop(t + len * 3 + 0.1);
    }

    function kick(t, level) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.13);
      const g = ctx.createGain();
      env(g, t, level, 0.002, 0.34);
      o.connect(g).connect(drumBus.input);
      o.start(t);
      o.stop(t + 0.8);
    }
    const clap = (t) => {
      for (const d of [0, 0.011, 0.023]) noiseHit(t + d, d < 0.02 ? 0.02 : 0.16, 0.26, 'bandpass', 1500, 0.9, drumBus.input, 0.08);
    };
    const hat = (t, level, open) => noiseHit(t, open ? 0.22 : 0.06, level, 'highpass', 7000, 0.7, drumBus.input, 0.22);
    // 夜里的时钟：滴、答
    const tick = (t, tock) => noiseHit(t, 0.018, 0.16, 'bandpass', tock ? 2300 : 3200, 7, drumBus.input, tock ? -0.15 : 0.15);
    const crash = (t) => noiseHit(t, 1.6, 0.13, 'highpass', 4200, 0.6, drumBus.input);

    // 往上扬：带通的噪声从低到高扫上去
    function riser(t0, t1, level) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 2.2;
      f.frequency.setValueAtTime(380, t0);
      f.frequency.exponentialRampToValueAtTime(6500, t1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(level, t1 - 0.02);
      g.gain.linearRampToValueAtTime(0, t1 + 0.03);
      s.connect(f).connect(g).connect(padBus.gain);
      s.start(t0);
      s.stop(t1 + 0.1);
    }

    // ---------- 按小节排 ----------
    for (let bar = 0; bar < BARS.length; bar++) {
      const t = bar * BAR;
      const ch = CHORDS[BARS[bar]];
      const sec = section(bar);
      const day = sec === 'dayA' || sec === 'dayB' || sec === 'dayC';

      pad(t, BAR, ch.pad, sec === 'night' ? 0.03 : sec === 'intro' ? 0.034 : 0.032);

      if (day) {
        // 白天：dayA 八分音符，后面十六分音符
        const steps = sec === 'dayA' ? 8 : 16;
        const order = steps === 8 ? [0, 1, 2, 3, 2, 1, 2, 3] : [0, 1, 2, 3, 1, 2, 3, 2, 0, 1, 2, 3, 1, 2, 3, 2];
        const accent = steps === 8 ? 0.17 : 0.13;
        for (let i = 0; i < steps; i++) pluck(t + (i * BAR) / steps, ch.arp[order[i]], i % (steps / 4) === 0 ? accent : accent * 0.7);
        for (let i = 0; i < 8; i++) bass(t + i * (BEAT / 2), BEAT / 2 - 0.06, ch.bass, i % 2 ? 0.075 : 0.11);
        for (let b = 0; b < 4; b++) {
          const tb = t + b * BEAT;
          if (b % 2 === 0) kick(tb, 0.36);
          else clap(tb);
          hat(tb + BEAT / 2, 0.1, sec !== 'dayA' && b === 3);
          if (sec !== 'dayA') hat(tb, 0.045);
        }
      } else if (sec === 'night') {
        // 夜里：鼓停了，只剩时钟和压暗的琶音（接力还在继续）
        const order = [0, 1, 2, 3, 2, 1, 2, 3];
        for (let i = 0; i < 8; i++) pluck(t + i * (BEAT / 2), ch.arp[order[i]] - 12, i % 2 ? 0.06 : 0.08);
        bass(t, BAR - 0.1, ch.bass, 0.06);
        kick(t, 0.14);
        for (let b = 0; b < 4; b++) tick(t + b * BEAT, b % 2 === 1);
      } else if (sec === 'outro') {
        if (bar < 28) bass(t, BAR - 0.1, ch.bass, 0.07);
      }
    }

    // 开头八音盒
    for (const [bar, beat, n] of MUSIC_BOX) pluck(bar * BAR + beat * BEAT, n, 0.15, bellBus.input);
    // 旋律
    for (const [bar, beat, n, len] of BELLS) bell(bar * BAR + beat * BEAT, len, n, 0.12);
    // 天亮之前往上扬，天亮那一下
    riser(4, 6, 0.22);
    crash(6);
    riser(42, 44, 0.22);
    crash(44);
    // 「早上好，做好了」：一串亮音
    [72, 76, 79, 84, 88].forEach((n, i) => bell(44 + i * (BEAT / 4), 2, n, 0.08));
    // 天黑那一下
    crash(30);

    const buf = await ctx.startRendering();
    // 响度：整体放大 4 dB，鼓点上的尖峰用限幅器压到 -1 dBFS 以下
    const CEIL = 0.89;
    const chs = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
    let peak = 0;
    for (const d of chs) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak) limit(chs, (CEIL / peak) * 1.6, CEIL);
    return buf;
  }

  // 限幅：need 是每个采样不超过 ceil 需要的增益。先往后看 4 毫秒取最小值（来得及提前压下去），
  // 再在 4 毫秒里取平均（压下去的过程是平滑的），松开时大约 120 毫秒回到原来的音量
  function limit(chs, pre, ceil) {
    const n = chs[0].length;
    const L = Math.round(0.004 * SR);
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (const d of chs) p = Math.max(p, Math.abs(d[i] * pre));
      need[i] = p > ceil ? ceil / p : 1;
    }
    // 窗口 [i, i + L] 里的最小值：单调队列，从后往前扫
    const ahead = new Float32Array(n);
    const q = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = n - 1; i >= 0; i--) {
      while (tail > head && need[q[tail - 1]] >= need[i]) tail--;
      q[tail++] = i;
      while (q[head] > i + L) head++;
      ahead[i] = need[q[head]];
    }
    // [i - L + 1, i] 的平均：到了尖峰那一刻，增益一定已经压够了
    const rel = 1 - Math.exp(-1 / (0.12 * SR));
    let sum = 0;
    let cur = 1;
    for (let i = 0; i < n; i++) {
      sum += ahead[i];
      if (i >= L) sum -= ahead[i - L];
      cur = Math.min(sum / Math.min(i + 1, L), cur + (1 - cur) * rel);
      const k = cur * pre;
      for (const d of chs) d[i] *= k;
    }
  }

  // 只要背景音乐：16 位 PCM 的 WAV
  async function musicWav() {
    const buf = await renderMusic();
    const ch = buf.numberOfChannels;
    const n = buf.length;
    const out = new Uint8Array(44 + n * ch * 2);
    const v = new DataView(out.buffer);
    const str = (o, s) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * ch * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, ch, true);
    v.setUint32(24, buf.sampleRate, true);
    v.setUint32(28, buf.sampleRate * ch * 2, true);
    v.setUint16(32, ch * 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * ch * 2, true);
    const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
    for (let i = 0, o = 44; i < n; i++) {
      for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(data[c][i] * 32767))), true);
    }
    return out;
  }

  window.renderMusic = renderMusic;
  window.musicWav = musicWav;
})();
