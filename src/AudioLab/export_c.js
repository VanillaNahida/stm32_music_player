/* ============================================================
 * AudioLab MIDI C 数组导出器
 *
 * 纯函数模块，浏览器（window.exportC）与 Node（module.exports）共用。
 * 把 MIDI 音符列表转换成 STM32 乐谱头文件（ScoreNote 数组）。
 * ============================================================ */
(function (global, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.exportC = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var TICK_US_DEFAULT = 5000;   /* 时间单位：5ms */
  var TICK_US_MAX     = 10000;  /* 总时长超限时降级为 10ms */
  var TICK_LIMIT      = 65534;  /* uint16 最大 tick */

  /* 把秒换算成 tick（tickUs 微秒） */
  function toTick(sec, tickUs) {
    return Math.max(0, Math.round((sec * 1e6) / tickUs));
  }

  /**
   * 生成 C 头文件文本
   * @param {string} songName   曲名（文件名）
   * @param {Array}  notes      [{midi, time(秒), duration(秒), velocity, track}]
   * @param {number} trackCount MIDI 轨道总数
   * @returns {string} .h 文件内容
   */
  function generateCHeader(songName, notes, trackCount) {
    var totalMs = 0;
    for (var i = 0; i < notes.length; i++) {
      var endMs = (notes[i].time + notes[i].duration) * 1000;
      if (endMs > totalMs) totalMs = endMs;
    }

    /* 时间单位自适应：默认 5ms，超过 uint16 上限改用 10ms */
    var tickUs = TICK_US_DEFAULT;
    if (toTick(totalMs / 1000, tickUs) > TICK_LIMIT) tickUs = TICK_US_MAX;

    /* 曲名生成合法的 C 标识符片段（宏防护用） */
    var safeName = String(songName || 'score').replace(/\.[^.]+$/, '');
    var ident = safeName.replace(/[^A-Za-z0-9_]/g, '_');
    if (!ident.length) ident = 'score';
    var guard = '__SCORE_' + ident.toUpperCase() + '_H';

    /* 各轨道音符数统计 */
    var perTrack = [];
    for (var j = 0; j < notes.length; j++) {
      var t = notes[j].track || 0;
      while (perTrack.length <= t) perTrack.push(0);
      perTrack[t]++;
    }
    var trackDesc = [];
    for (var k = 0; k < perTrack.length; k++) {
      trackDesc.push('tr' + k + '=' + perTrack[k]);
    }

    var L = [];
    L.push('/* ============================================================');
    L.push(' * 由 AudioLab MIDI C 数组导出器生成，请勿手工修改');
    L.push(' * 曲名: ' + safeName);
    L.push(' * 音符数: ' + notes.length + '   时长: ' + (totalMs / 1000).toFixed(1) + ' s' +
           '   轨道数: ' + trackCount + '   ' + trackDesc.join(' '));
    L.push(' * 时间单位: ' + tickUs + ' us   (uint16，最大 ' + (TICK_LIMIT * tickUs / 1e6).toFixed(1) + ' s)');
    L.push(' * ============================================================ */');
    L.push('#ifndef ' + guard);
    L.push('#define ' + guard);
    L.push('');
    L.push('#include "Music.h"');
    L.push('');
    L.push('#define SCORE_NAME            "' + safeName.replace(/"/g, "'") + '"');
    L.push('#define SCORE_NOTE_COUNT      ' + notes.length + 'u');
    L.push('#define SCORE_TOTAL_TIME_MS   ' + Math.round(totalMs) + 'u');
    L.push('#define SCORE_TICK_US         ' + tickUs + 'u');
    L.push('');
    L.push('/* { 起始时刻, 时长, MIDI音号, 力度, 音轨号 } 单位：tick */');
    L.push('static const ScoreNote g_score[SCORE_NOTE_COUNT] = {');

    var BUF = [];
    for (var n = 0; n < notes.length; n++) {
      var note = notes[n];
      var timeTick = toTick(note.time, tickUs);
      var durTick = Math.max(1, toTick(note.duration, tickUs));
      var midi = Math.max(0, Math.min(127, Math.round(note.midi)));
      var vel = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      var tr = Math.max(0, Math.min(15, note.track || 0));
      BUF.push('    {' + timeTick + ', ' + durTick + ', ' + midi + ', ' + vel + ', ' + tr + '},');
    }
    L.push(BUF.join('\n'));
    L.push('};');
    L.push('');
    L.push('#endif');

    return L.join('\n') + '\n';
  }

  return {
    generateCHeader: generateCHeader,
    TICK_US_DEFAULT: TICK_US_DEFAULT,
    TICK_US_MAX: TICK_US_MAX
  };
});
