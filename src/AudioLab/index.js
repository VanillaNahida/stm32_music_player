(function () {
  'use strict';

  /* ============================================================
     全局常量
     ============================================================ */
  const ATTACK       = 0.006;   // 起音
  const SUSTAIN_GAIN = 0.55;    // 延音电平
  const SHORT_BURST  = 0.15;    // 无衰减无延音短音长度
  const QUICK_REL    = 0.02;    // 快速切断
  const PEAK         = 0.25;    // 单音峰值

  /* ============================================================
     音高数据 —— 高八度在上，低八度在下
     ============================================================ */
  const NATURAL = [
    { name: 'C', semi: 0 },
    { name: 'D', semi: 2 },
    { name: 'E', semi: 4 },
    { name: 'F', semi: 5 },
    { name: 'G', semi: 7 },
    { name: 'A', semi: 9 },
    { name: 'B', semi: 11 }
  ];

  const OCTAVES = [
    { label: '高八度', mini: '高', midi: 72, keys: ['Q','W','E','R','T','Y','U'],
      color: '#fbbf24', soft: 'rgba(251,191,36,.26)' },
    { label: '八度',   mini: '中', midi: 60, keys: ['A','S','D','F','G','H','J'],
      color: '#a78bfa', soft: 'rgba(167,139,250,.26)' },
    { label: '低八度', mini: '低', midi: 48, keys: ['Z','X','C','V','B','N','M'],
      color: '#4dd0e1', soft: 'rgba(77,208,225,.26)' }
  ];

  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const midiToName = m => {
    const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return N[m % 12] + (Math.floor(m / 12) - 1);
  };

  /* ============================================================
     DOM 引用
     ============================================================ */
  const keyboardEl    = document.getElementById('keyboard');
  const decayToggle   = document.getElementById('decayToggle');
  const decayField    = document.getElementById('decayField');
  const decayRange    = document.getElementById('decayRange');
  const decayVal      = document.getElementById('decayVal');
  const sustainToggle = document.getElementById('sustainToggle');
  const waveSelect    = document.getElementById('waveSelect');
  const envHint       = document.getElementById('envHint');
  const canvas        = document.getElementById('scope');
  const cctx          = canvas.getContext('2d');

  const midiFileInput  = document.getElementById('midiFile');
  const playPauseBtn   = document.getElementById('playPauseBtn');
  const midiInfo       = document.getElementById('midiInfo');
  const midiNameEl     = document.getElementById('midiName');
  const progressBar    = document.getElementById('progressBar');
  const progressFill   = document.getElementById('progressFill');
  const progressThumb  = document.getElementById('progressThumb');
  const timeDisplay    = document.getElementById('timeDisplay');
  const renderFormat   = document.getElementById('renderFormat');
  const renderBtn      = document.getElementById('renderBtn');
  const renderProgress = document.getElementById('renderProgress');
  const renderFill     = document.getElementById('renderFill');
  const renderLabel    = document.getElementById('renderLabel');
  const libraryBtn     = document.getElementById('libraryBtn');
  const libraryModal   = document.getElementById('libraryModal');
  const libraryList    = document.getElementById('libraryList');
  const libraryCancel  = document.getElementById('libraryCancel');
  const libraryConfirm = document.getElementById('libraryConfirm');
  let librarySelected  = null;

  /* ============================================================
     键盘构建
     ============================================================ */
  const btnById  = new Map();
  const freqById = new Map();
  const keyMap   = new Map();

  OCTAVES.forEach((oct, oi) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.setProperty('--c', oct.color);
    row.style.setProperty('--c-soft', oct.soft);

    const lab = document.createElement('div');
    lab.className = 'row-label';
    lab.innerHTML = '<span class="full">' + oct.label + '</span>' +
                    '<span class="mini">' + oct.mini + '</span>';
    row.appendChild(lab);

    NATURAL.forEach((n, ni) => {
      const midi = oct.midi + n.semi;
      const freq = midiToFreq(midi);
      const id   = 'o' + oi + '_' + n.name;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'key';
      btn.dataset.id = id;
      btn.title = midiToName(midi) + ' · ' + freq.toFixed(2) + ' Hz';
      btn.innerHTML =
        '<span class="note">' + n.name + '<sub>' + (Math.floor(midi / 12) - 1) + '</sub></span>' +
        '<span class="hk">' + oct.keys[ni] + '</span>';

      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (btn.setPointerCapture && e.pointerId !== undefined) {
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        }
        startKeyNote(id);
      });
      btn.addEventListener('pointerup',     function () { stopKeyNote(id); });
      btn.addEventListener('pointercancel', function () { stopKeyNote(id); });
      btn.addEventListener('contextmenu',   function (e) { e.preventDefault(); });

      row.appendChild(btn);
      btnById.set(id, btn);
      freqById.set(id, freq);
      keyMap.set(oct.keys[ni].toLowerCase(), id);
    });

    keyboardEl.appendChild(row);
  });

  /* ============================================================
     音频引擎
     ============================================================ */
  let audioCtx = null;
  let master   = null;
  let analyser = null;
  let scopeBuf = null;

  const activeKeys      = new Map();   // 手动演奏：id -> { osc, gain, selfEnding }
  const midiOscillators = new Map();   // MIDI 播放：osc -> { osc, gain }

  function ensureAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();

    master = audioCtx.createGain();
    master.gain.value = 0.9;

    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 14;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    scopeBuf = new Uint8Array(analyser.fftSize);

    master.connect(comp);
    comp.connect(analyser);
    analyser.connect(audioCtx.destination);
  }

  /* ============================================================
     手动键盘演奏逻辑
     ============================================================ */
  function getKeyReleaseTime(fast) {
    if (fast) return QUICK_REL;
    if (decayToggle.checked) {
      return Math.max(0.05, parseFloat(decayRange.value));
    }
    return 0.05;
  }

  function releaseKeyNote(id, fast) {
    const note = activeKeys.get(id);
    if (!note) return;
    activeKeys.delete(id);

    const t   = audioCtx.currentTime;
    const g   = note.gain.gain;
    const dur = getKeyReleaseTime(fast);

    try {
      if (typeof g.cancelAndHoldAtTime === 'function') {
        g.cancelAndHoldAtTime(t);
      } else {
        const cur = Math.max(g.value, 0.0001);
        g.cancelScheduledValues(t);
        g.setValueAtTime(cur, t);
      }
      g.exponentialRampToValueAtTime(0.0001, t + dur);
    } catch (_) {}

    try { note.osc.stop(t + dur + 0.05); } catch (_) {}
  }

  function startKeyNote(id) {
    ensureAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    if (activeKeys.has(id)) {
      const ex = activeKeys.get(id);
      if (ex.selfEnding) {
        releaseKeyNote(id, true);
      } else {
        return;
      }
    }

    const btn     = btnById.get(id);
    const freq    = freqById.get(id);
    const decayOn = decayToggle.checked;
    const susOn   = sustainToggle.checked;
    const t       = audioCtx.currentTime;
    const sustainLevel = susOn ? PEAK * SUSTAIN_GAIN : 0.0001;

    const osc = audioCtx.createOscillator();
    osc.type = waveSelect.value;
    osc.frequency.setValueAtTime(freq, t);

    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(master);

    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(PEAK, t + ATTACK);

    let selfEnding = false;
    let endTime    = null;

    if (decayOn) {
      const dur = Math.max(0.05, parseFloat(decayRange.value));
      gainNode.gain.exponentialRampToValueAtTime(sustainLevel, t + ATTACK + dur);
      if (!susOn) {
        selfEnding = true;
        endTime    = t + ATTACK + dur + 0.06;
      }
    } else {
      if (!susOn) {
        gainNode.gain.exponentialRampToValueAtTime(0.0001, t + ATTACK + SHORT_BURST);
        selfEnding = true;
        endTime    = t + ATTACK + SHORT_BURST + 0.06;
      }
    }

    osc.start(t);
    if (endTime !== null) osc.stop(endTime);

    activeKeys.set(id, { osc: osc, gain: gainNode, selfEnding: selfEnding });
    if (btn) btn.classList.add('active');

    osc.onended = function () {
      const cur = activeKeys.get(id);
      if (cur && cur.osc === osc) {
        activeKeys.delete(id);
        if (btn) btn.classList.remove('active');
      }
    };
  }

  function stopKeyNote(id) {
    const btn = btnById.get(id);
    if (btn) btn.classList.remove('active');

    const note = activeKeys.get(id);
    if (!note) return;
    if (note.selfEnding) return;

    releaseKeyNote(id, false);
  }

  /* ============================================================
     电脑键盘映射
     ============================================================ */
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const id = keyMap.get(e.key.toLowerCase());
    if (!id) return;
    e.preventDefault();
    if (e.repeat) return;
    startKeyNote(id);
  });

  document.addEventListener('keyup', function (e) {
    const id = keyMap.get(e.key.toLowerCase());
    if (!id) return;
    stopKeyNote(id);
  });

  window.addEventListener('blur', function () {
    Array.from(activeKeys.keys()).forEach(stopKeyNote);
  });

  /* ============================================================
     包络参数读取
     ============================================================ */
  function readEnvelopeParams() {
    return {
      decayOn: decayToggle.checked,
      susOn:   sustainToggle.checked,
      decayT:  Math.max(0.05, parseFloat(decayRange.value)),
      wave:    waveSelect.value
    };
  }

  /* ============================================================
     MIDI 播放引擎 —— 滚动调度
     ============================================================ */
  let parsedNotes   = [];      // 按时间排序
  let totalDuration = 0;       // MIDI 总时长（秒）
  let currentMidiName = '';    // 当前 MIDI 文件名（用于转录导出命名）
  let currentTrackCount = 0;   // 当前 MIDI 轨道总数
  let playhead      = 0;       // 当前播放位置（秒）
  let playing       = false;
  let startCtxTime  = 0;       // 播放开始时的 audioCtx.currentTime
  let startMidiTime = 0;       // 播放开始时的 MIDI 时间
  let scheduleTimer = null;

  const LOOKAHEAD       = 0.4; // 提前调度多少秒
  const SCHEDULE_TICK   = 80;  // 调度器间隔（毫秒）
  let nextNoteIndex     = 0;

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  /* 按当前包络参数把一个音符调度到任意 AudioContext（实时或离线渲染共用） */
  function createScheduledNote(ctx, dest, freq, velocity, t0, noteEndTime, env) {
    const peak = Math.max(0.02, Math.min(1, velocity)) * PEAK;

    const osc = ctx.createOscillator();
    osc.type = env.wave;
    osc.frequency.setValueAtTime(freq, t0);

    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(dest);

    // 起音
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + ATTACK);

    let releaseLevel = peak;

    if (env.decayOn) {
      const sustainLevel = env.susOn ? peak * SUSTAIN_GAIN : 0.0001;
      const fullDecayEnd = t0 + ATTACK + env.decayT;

      if (fullDecayEnd < noteEndTime) {
        // 衰减在音符结束前完成 → 之后保持延音电平
        gain.gain.exponentialRampToValueAtTime(sustainLevel, fullDecayEnd);
        if (fullDecayEnd < noteEndTime - 0.005) {
          gain.gain.setValueAtTime(sustainLevel, fullDecayEnd);
        }
        releaseLevel = sustainLevel;
      } else {
        // 音符比衰减时间短 → 在音符结束前只衰减一部分
        gain.gain.exponentialRampToValueAtTime(sustainLevel, noteEndTime);
        releaseLevel = sustainLevel;
      }
    }
    // 无衰减 → 起音后默认保持峰值

    // 必须先 start 再 stop（Web Audio 不允许对未启动的节点调用 stop）
    osc.start(t0);

    // 音符结束的释放
    if (env.decayOn) {
      gain.gain.setValueAtTime(releaseLevel, noteEndTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEndTime + env.decayT);
      osc.stop(noteEndTime + env.decayT + 0.05);
    } else {
      gain.gain.setValueAtTime(releaseLevel, noteEndTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEndTime + 0.05);
      osc.stop(noteEndTime + 0.1);
    }

    return { osc: osc, gain: gain };
  }

  /* 给单个 MIDI 音符调度包络和振荡器（实时播放） */
  function scheduleMidiNote(note, ctxStartTime, skipSeconds) {
    skipSeconds = skipSeconds || 0;
    const remainingDur = note.duration - skipSeconds;
    if (remainingDur <= 0.008) return;

    const t0 = Math.max(ctxStartTime, audioCtx.currentTime);
    const env = readEnvelopeParams();

    const s = createScheduledNote(audioCtx, master, note.freq, note.velocity, t0, t0 + remainingDur, env);

    midiOscillators.set(s.osc, { osc: s.osc, gain: s.gain });

    s.osc.onended = function () {
      midiOscillators.delete(s.osc);
    };
  }

  /* 滚动调度器 —— 每次只调度未来 LOOKAHEAD 秒内的音符 */
  function schedulerTick() {
    if (!playing) return;

    const elapsed = audioCtx.currentTime - startCtxTime;
    const currentMidiTime = startMidiTime + elapsed;
    const horizon = currentMidiTime + LOOKAHEAD;

    while (nextNoteIndex < parsedNotes.length) {
      const note = parsedNotes[nextNoteIndex];
      if (note.time >= horizon) break;

      // 如果这个音符完全在播放头之前，跳过
      if (note.time + note.duration <= currentMidiTime) {
        nextNoteIndex++;
        continue;
      }

      let ctxStart, skip;
      if (note.time < currentMidiTime) {
        // 已经进入这个音符的中间（通常发生在恢复播放时）
        ctxStart = audioCtx.currentTime;
        skip = currentMidiTime - note.time;
      } else {
        ctxStart = startCtxTime + (note.time - startMidiTime);
        skip = 0;
      }

      scheduleMidiNote(note, ctxStart, skip);
      nextNoteIndex++;
    }
  }

  /* 找到播放头之后的第一个音符索引 */
  function findNoteIndexAt(time) {
    let lo = 0, hi = parsedNotes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (parsedNotes[mid].time + parsedNotes[mid].duration <= time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /* 停止所有 MIDI 振荡器（带极短淡出） */
  function stopAllMidiOscillators(fade) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const list = Array.from(midiOscillators.values());
    midiOscillators.clear();

    list.forEach(function (entry) {
      try {
        const g = entry.gain.gain;
        if (typeof g.cancelAndHoldAtTime === 'function') {
          g.cancelAndHoldAtTime(t);
        } else {
          g.cancelScheduledValues(t);
        }
        const cur = Math.max(g.value, 0.0001);
        g.setValueAtTime(cur, t);
        g.exponentialRampToValueAtTime(0.0001, t + fade);
        entry.osc.stop(t + fade + 0.05);
      } catch (_) {
        try { entry.osc.stop(); } catch (_) {}
      }
    });
  }

  function playMidi() {
    if (playing) return;
    if (!parsedNotes.length) return;

    ensureAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // 如果已经播到结尾，从头开始
    if (playhead >= totalDuration - 0.01) playhead = 0;

    playing = true;
    startCtxTime = audioCtx.currentTime + 0.05;
    startMidiTime = playhead;
    nextNoteIndex = findNoteIndexAt(playhead);

    // 立即先调度一批，避免开头延迟
    schedulerTick();

    scheduleTimer = setInterval(schedulerTick, SCHEDULE_TICK);

    playPauseBtn.textContent = '⏸ 暂停';
  }

  function pauseMidi() {
    if (!playing) return;
    playing = false;

    const elapsed = audioCtx.currentTime - startCtxTime;
    playhead = Math.min(startMidiTime + Math.max(0, elapsed), totalDuration);

    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
    }
    stopAllMidiOscillators(0.04);

    playPauseBtn.textContent = '▶ 播放';
  }

  playPauseBtn.addEventListener('click', function () {
    if (playing) pauseMidi();
    else playMidi();
  });

  /* ============================================================
     转录导出 —— 离线渲染成 WAV / MP3
     ============================================================ */
  /* 按当前合成器设置把 parsedNotes 分段渲染到 AudioBuffer（onProgress: 0~1） */
  function renderMidiToAudioBuffer(env, onProgress) {
    const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
    const CHUNK = 10;                                            // 每段 10 秒，降低单次渲染耗时并更新进度
    const TAIL = env.decayOn ? env.decayT + 0.5 : 0.6;           // 尾部重叠长度（覆盖音符释放尾巴）
    const total = Math.ceil(totalDuration) + 2;
    const totalFrames = Math.floor(sampleRate * total);

    // 输出缓冲（所有分片用 += 叠加：尾部与下一段头部重叠处是两个不同音符集的混音）
    let out;
    try {
      out = new AudioBuffer({ numberOfChannels: 2, length: totalFrames, sampleRate: sampleRate });
    } catch (e) {
      const tmp = new OfflineAudioContext(2, 1, sampleRate);
      out = tmp.createBuffer(2, totalFrames, sampleRate);
    }
    const outL = out.getChannelData(0);
    const outR = out.getChannelData(1);

    function buildChain(ctx) {
      const masterG = ctx.createGain();
      masterG.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -8;
      comp.knee.value = 14;
      comp.ratio.value = 12;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      masterG.connect(comp);
      comp.connect(ctx.destination);
      return masterG;
    }

    function renderChunk(start) {
      const end = Math.min(start + CHUNK, total);
      const winEnd = Math.min(end + TAIL, total);
      const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * (winEnd - start)), sampleRate);
      const masterG = buildChain(ctx);

      // 每个音符只归属于包含其起音的那一段
      for (let i = 0; i < parsedNotes.length; i++) {
        const note = parsedNotes[i];
        if (note.time >= end) break;
        if (note.time < start) continue;
        createScheduledNote(ctx, masterG, note.freq, note.velocity, note.time - start, note.time - start + note.duration, env);
      }

      return ctx.startRendering().then(function (buf) {
        const s0 = Math.floor(start * sampleRate);
        const nFull = Math.floor((winEnd - start) * sampleRate);
        const srcL = buf.getChannelData(0);
        const srcR = buf.getChannelData(1);
        for (let f = 0; f < nFull; f++) {
          outL[s0 + f] += srcL[f];
          outR[s0 + f] += srcR[f];
        }
        return end;
      });
    }

    // 串行渲染各分片，每片完成后回调进度
    let start = 0;
    function next() {
      if (start >= total) return Promise.resolve(out);
      return renderChunk(start).then(function (newStart) {
        start = newStart;
        if (onProgress) onProgress(Math.min(1, start / total));
        return next();
      });
    }
    return next();
  }

  function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const frames = buffer.length;
    const blockAlign = numCh * 2;
    const dataSize = frames * blockAlign;

    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);

    function writeStr(off, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                    // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);                   // 16 bit
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }

    return new Blob([ab], { type: 'audio/wav' });
  }

  function floatTo16(v) {
    v = Math.max(-1, Math.min(1, v));
    return v < 0 ? v * 0x8000 : v * 0x7FFF;
  }

  function audioBufferToMp3(buffer) {
    const sampleRate = buffer.sampleRate;
    const chL = buffer.getChannelData(0);
    const chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chL;

    const encoder = new lamejs.Mp3Encoder(2, sampleRate, 128); // 立体声 128kbps
    const blockSize = 1152;
    const left = new Int16Array(blockSize);
    const right = new Int16Array(blockSize);
    const parts = [];
    const frames = buffer.length;

    for (let i = 0; i < frames; i += blockSize) {
      const n = Math.min(blockSize, frames - i);
      for (let j = 0; j < n; j++) {
        left[j] = floatTo16(chL[i + j]);
        right[j] = floatTo16(chR[i + j]);
      }
      if (n < blockSize) {
        left.fill(0, n);
        right.fill(0, n);
      }
      const mp3buf = encoder.encodeBuffer(left, right);
      if (mp3buf.length > 0) parts.push(new Uint8Array(mp3buf));
    }

    const end = encoder.flush();
    if (end.length > 0) parts.push(new Uint8Array(end));

    return new Blob(parts, { type: 'audio/mpeg' });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  renderBtn.addEventListener('click', async function () {
    if (!parsedNotes.length || renderBtn.classList.contains('working')) return;

    const fmt = renderFormat.value;

    // C 数组导出：无需渲染音频，直接把音符转成 .h 头文件
    if (fmt === 'c') {
      try {
        const base = (currentMidiName || 'midi').replace(/\.[^.]+$/, '');
        const text = exportC.generateCHeader(base, parsedNotes, currentTrackCount);
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), base + '.h');
        midiInfo.classList.remove('err');
        midiInfo.textContent = 'C 数组已导出，共 ' + parsedNotes.length + ' 个音符';
      } catch (err) {
        console.error(err);
        midiInfo.classList.add('err');
        midiInfo.textContent = '导出 C 数组失败：' + (err && err.message ? err.message : '未知错误');
      }
      return;
    }

    renderBtn.disabled = true;
    renderBtn.classList.add('working');
    midiInfo.classList.remove('err');
    midiInfo.textContent = '转录中…（' + fmt.toUpperCase() + '）';
    renderProgress.hidden = false;
    renderFill.style.width = '0%';
    renderLabel.textContent = '转录 0%';

    try {
      const env = readEnvelopeParams();
      const buf = await renderMidiToAudioBuffer(env, function (p) {
        renderFill.style.width = (p * 100).toFixed(1) + '%';
        renderLabel.textContent = '转录 ' + Math.round(p * 100) + '%';
      });
      const blob = fmt === 'mp3' ? audioBufferToMp3(buf) : audioBufferToWav(buf);

      const base = (currentMidiName || 'midi').replace(/\.[^.]+$/, '');
      downloadBlob(blob, base + '-' + env.wave + '.' + fmt);

      midiInfo.textContent = '转录完成，已开始下载';
    } catch (err) {
      console.error(err);
      midiInfo.classList.add('err');
      midiInfo.textContent = '转录失败：' + (err && err.message ? err.message : '未知错误');
    } finally {
      renderBtn.classList.remove('working');
      renderBtn.disabled = parsedNotes.length === 0;
      renderProgress.hidden = true;
      renderFill.style.width = '0%';
    }
  });

  /* MP3 编码库缺失时禁用 MP3 选项 */
  if (typeof lamejs === 'undefined') {
    const opt = renderFormat.querySelector('option[value="mp3"]');
    if (opt) opt.disabled = true;
  }

  /* C 数组导出器缺失时禁用该选项 */
  if (typeof exportC === 'undefined') {
    const opt = renderFormat.querySelector('option[value="c"]');
    if (opt) opt.disabled = true;
  }

  /* ============================================================
     MIDI 文件加载
     ============================================================ */
  /* 从 ArrayBuffer 载入 MIDI（本地文件与示例曲库共用） */
  async function loadMidiFromBytes(buf, fname) {
    currentMidiName = fname;
    midiNameEl.textContent = fname;
    midiNameEl.hidden = false;

    if (typeof Midi === 'undefined') {
      midiInfo.textContent = 'MIDI 库未加载，请检查网络';
      midiInfo.classList.add('err');
      return;
    }

    // 停止当前播放
    if (playing) pauseMidi();
    stopAllMidiOscillators(0.02);
    playhead = 0;

    midiInfo.classList.remove('err');
    midiInfo.textContent = '解析中…';

    try {
      const midi = new Midi(buf);
      currentTrackCount = midi.tracks.length;

      const collected = [];
      midi.tracks.forEach(function (track, ti) {
        track.notes.forEach(function (n) {
          if (n.duration <= 0.01) return;
          collected.push({
            midi: n.midi,
            freq: 440 * Math.pow(2, (n.midi - 69) / 12),
            time: n.time,
            duration: n.duration,
            velocity: n.velocity,
            track: ti
          });
        });
      });

      collected.sort(function (a, b) { return a.time - b.time; });

      parsedNotes = collected;
      totalDuration = parsedNotes.length
        ? parsedNotes[parsedNotes.length - 1].time + parsedNotes[parsedNotes.length - 1].duration
        : 0;

      // 更新 UI
      playPauseBtn.disabled = parsedNotes.length === 0;
      renderBtn.disabled = parsedNotes.length === 0;
      progressFill.style.width = '0%';
      progressThumb.style.left = '0%';
      timeDisplay.textContent = '0:00 / ' + formatTime(totalDuration);
      playPauseBtn.textContent = '▶ 播放';

      const trackCount = midi.tracks.length;
      const noteCount  = parsedNotes.length;
      midiInfo.textContent = trackCount + ' 轨 · ' + noteCount + ' 音符 · ' + formatTime(totalDuration);
    } catch (err) {
      console.error(err);
      parsedNotes = [];
      totalDuration = 0;
      playPauseBtn.disabled = true;
      renderBtn.disabled = true;
      playPauseBtn.textContent = '▶ 播放';
      midiInfo.classList.add('err');
      midiInfo.textContent = '解析失败：' + (err && err.message ? err.message : '未知错误');
    }
  }

  midiFileInput.addEventListener('change', async function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    // 手机端文件选择器可能不按扩展名过滤，这里自行校验
    const fname = file.name || '';
    if (!/\.(mid|midi)$/i.test(fname)) {
      midiInfo.classList.add('err');
      midiInfo.textContent = '请选择 .mid / .midi 文件';
      e.target.value = '';
      return;
    }

    try {
      const buf = await file.arrayBuffer();
      await loadMidiFromBytes(buf, fname);
    } catch (err) {
      console.error(err);
      parsedNotes = [];
      totalDuration = 0;
      playPauseBtn.disabled = true;
      renderBtn.disabled = true;
      playPauseBtn.textContent = '▶ 播放';
      midiInfo.classList.add('err');
      midiInfo.textContent = '读取文件失败：' + (err && err.message ? err.message : '未知错误');
    }
  });

  /* ============================================================
     示例曲库
     ============================================================ */
  function openLibraryModal() {
    libraryModal.hidden = false;
  }
  function closeLibraryModal() {
    libraryModal.hidden = true;
  }

  function setLibraryState(text) {
    libraryList.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'modal-state';
    d.textContent = text;
    libraryList.appendChild(d);
  }

  function renderLibraryList(list) {
    libraryList.innerHTML = '';
    librarySelected = null;
    libraryConfirm.disabled = true;

    if (!list.length) {
      setLibraryState('示例目录为空');
      return;
    }

    list.forEach(function (item, i) {
      const div = document.createElement('div');
      div.className = 'lib-item';

      const img = document.createElement('img');
      img.src = 'assets/music.svg';
      img.alt = '';
      img.draggable = false;

      const span = document.createElement('span');
      span.className = 'lib-name';
      span.textContent = item.name;

      div.appendChild(img);
      div.appendChild(span);
      div.addEventListener('click', function () {
        Array.prototype.forEach.call(libraryList.children, function (child, j) {
          child.classList.toggle('selected', j === i);
        });
        librarySelected = item.name;
        libraryConfirm.disabled = false;
      });
      libraryList.appendChild(div);
    });
  }

  libraryBtn.addEventListener('click', async function () {
    openLibraryModal();
    setLibraryState('加载中…');
    try {
      const res = await fetch('api/midi_list.php');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      renderLibraryList(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      console.error(err);
      setLibraryState('无法获取示例列表：' + (err && err.message ? err.message : '未知错误'));
    }
  });

  libraryCancel.addEventListener('click', closeLibraryModal);

  libraryModal.addEventListener('click', function (e) {
    if (e.target === libraryModal) closeLibraryModal();
  });

  libraryConfirm.addEventListener('click', async function () {
    if (!librarySelected) return;
    closeLibraryModal();
    try {
      const res = await fetch('example/' + encodeURIComponent(librarySelected));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      await loadMidiFromBytes(buf, librarySelected);
    } catch (err) {
      console.error(err);
      midiInfo.classList.add('err');
      midiInfo.textContent = '加载示例失败：' + (err && err.message ? err.message : '未知错误');
    }
  });

  /* ============================================================
     进度显示与结束检测
     ============================================================ */
  let lastEndCheck = 0;
  function updateProgress() {
    requestAnimationFrame(updateProgress);

    if (!totalDuration) return;

    if (playing) {
      const elapsed = audioCtx.currentTime - startCtxTime;
      const current = Math.min(startMidiTime + Math.max(0, elapsed), totalDuration);

      const pct = ((current / totalDuration) * 100).toFixed(2) + '%';
      progressFill.style.width = pct;
      progressThumb.style.left = pct;
      timeDisplay.textContent = formatTime(current) + ' / ' + formatTime(totalDuration);

      // 结束检测
      if (startMidiTime + elapsed >= totalDuration + 0.4) {
        // 给释放尾巴一点时间
        if (scheduleTimer) {
          clearInterval(scheduleTimer);
          scheduleTimer = null;
        }
        playing = false;
        playhead = 0;
        playPauseBtn.textContent = '▶ 播放';
        // 不再立刻切掉，让尾巴自然收尾
      }
    } else {
      const pct = ((playhead / totalDuration) * 100).toFixed(2) + '%';
      progressFill.style.width = pct;
      progressThumb.style.left = pct;
      timeDisplay.textContent = formatTime(playhead) + ' / ' + formatTime(totalDuration);
    }
  }
  requestAnimationFrame(updateProgress);

  /* ============================================================
     播放进度条拖动（点击 / 拖拽 seek）
     ============================================================ */
  let seeking = false;
  let wasPlaying = false;

  function seekToTime(t) {
    playhead = Math.max(0, Math.min(t, totalDuration));
    nextNoteIndex = findNoteIndexAt(playhead);
    const pct = ((playhead / totalDuration) * 100).toFixed(2) + '%';
    progressFill.style.width = pct;
    progressThumb.style.left = pct;
    timeDisplay.textContent = formatTime(playhead) + ' / ' + formatTime(totalDuration);
  }

  function seekFromEvent(e) {
    const rect = progressBar.getBoundingClientRect();
    const clientX = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekToTime(ratio * totalDuration);
  }

  progressBar.addEventListener('pointerdown', function (e) {
    if (!totalDuration) return;
    e.preventDefault();
    seeking = true;
    wasPlaying = playing;
    progressBar.classList.add('dragging');
    if (playing) {
      // 播放中开始拖动：先暂停调度，松手后从新位置恢复
      playing = false;
      if (scheduleTimer) {
        clearInterval(scheduleTimer);
        scheduleTimer = null;
      }
      stopAllMidiOscillators(0.02);
      playPauseBtn.textContent = '▶ 播放';
    }
    seekFromEvent(e);
    progressBar.setPointerCapture(e.pointerId);
  });

  progressBar.addEventListener('pointermove', function (e) {
    if (seeking) seekFromEvent(e);
  });

  function endSeek() {
    if (!seeking) return;
    seeking = false;
    progressBar.classList.remove('dragging');
    if (wasPlaying && playhead < totalDuration - 0.01) playMidi();
  }

  progressBar.addEventListener('pointerup', endSeek);
  progressBar.addEventListener('pointercancel', endSeek);

  /* ============================================================
     控件联动 + 包络提示
     ============================================================ */
  function syncDecayUI() {
    const on = decayToggle.checked;
    decayField.classList.toggle('off', !on);
    decayRange.disabled = !on;
  }

  function updateHint() {
    const d = decayToggle.checked;
    const s = sustainToggle.checked;
    let text;
    if (d && s) {
      text = '指数衰减到 55% 后保持，音符结束时按衰减时间自然消音 —— 类似钢琴';
    } else if (d && !s) {
      text = '指数衰减到接近零，音符越长衰减越彻底 —— 拨弦 / 钟声';
    } else if (!d && s) {
      text = '起音后满音量持续，音符结束时短促淡出 —— 持续音 / 管风琴';
    } else {
      text = '起音后短暂一声即止 —— 短促的“哔”';
    }
    envHint.innerHTML = '当前包络：<b>' + text + '</b>';
  }

  decayToggle.addEventListener('change', function () { syncDecayUI(); updateHint(); });
  sustainToggle.addEventListener('change', updateHint);

  decayRange.addEventListener('input', function () {
    decayVal.textContent = parseFloat(decayRange.value).toFixed(2) + 's';
  });
  decayVal.textContent = parseFloat(decayRange.value).toFixed(2) + 's';

  syncDecayUI();
  updateHint();

  /* ============================================================
     示波器
     ============================================================ */
  function resizeCanvas() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width  * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  window.addEventListener('resize', resizeCanvas);

  function drawScope() {
    requestAnimationFrame(drawScope);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    cctx.clearRect(0, 0, w, h);

    cctx.strokeStyle = 'rgba(255,255,255,.08)';
    cctx.lineWidth = 1;
    cctx.beginPath();
    cctx.moveTo(0, h / 2);
    cctx.lineTo(w, h / 2);
    cctx.stroke();

    if (!analyser || !scopeBuf) return;

    analyser.getByteTimeDomainData(scopeBuf);

    const n = scopeBuf.length;
    cctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 + ((scopeBuf[i] - 128) / 128) * (h / 2 - 8);
      if (i === 0) cctx.moveTo(x, y);
      else         cctx.lineTo(x, y);
    }
    cctx.strokeStyle = '#5eead4';
    cctx.lineWidth = 1.5;
    cctx.lineJoin = 'round';
    cctx.shadowColor = 'rgba(94,234,212,.7)';
    cctx.shadowBlur = 10;
    cctx.stroke();
    cctx.shadowBlur = 0;
  }

  resizeCanvas();
  requestAnimationFrame(drawScope);

})();