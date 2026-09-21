#ifndef __CONFIG_H
#define __CONFIG_H

#include "Music.h"

/* ============================================================
 * 音乐盒配置（对照 AudioLab 合成器）
 * 修改后重新编译即可生效
 * ============================================================ */

/* ---- 引擎 ---- */
#define MUSIC_SAMPLE_RATE       32000u   /* 采样率（Hz），同时是 PWM 载波频率 */
#define MUSIC_MAX_POLYPHONY     10u       /* 最大同时发声数（复音数） */
#define MUSIC_MASTER_VOLUME_Q8  256u     /* 主音量：0~256，256=100%（越大越响） */

/* ---- 波形：WAVE_SINE / WAVE_TRIANGLE / WAVE_SQUARE / WAVE_SAWTOOTH ---- */
#define MUSIC_WAVEFORM          WAVE_SQUARE

/* ---- 音符时长：1=遵循 MIDI 原时长（乐谱 duration），0=所有音符统一固定时长 ---- */
#define MUSIC_DURATION_FROM_MIDI    0u       /* 1=MIDI，0=固定时长 */
#define MUSIC_NOTE_DURATION_MS      300u     /* 固定时长（毫秒），FROM_MIDI=0 时生效 */

/* ---- 包络（对应 AudioLab：起音 6ms / 衰减 / 延音 0.55 电平） ----
 * 数值换算规则：
 *   1) 时间类（_MS）：单位是毫秒，数值即真实时间。
 *       600 = 600ms = 0.6s。
 *   2) 开关类（_ENABLE）：1 = 开，0 = 关。
 *   3) Q8 定点类（_Q8）：实际倍数 = 数值 / 256。
 *       例如 220 → 220/256 ≈ 0.86，表示峰值的 86%。
 *       对照 AudioLab 的 0.55 → 0.55×256 ≈ 140。
 *   4) 末尾的 u 是 C 语言整型常量后缀，= unsigned（无符号），
 *      只改变常量的类型，不改变数值大小：6u 就是整数 6。
 *      （同类后缀：L = long、UL = unsigned long、LL = long long）
 */
#define MUSIC_ATTACK_MS         6u       /* 起音时长：6ms（0.006s） */
#define MUSIC_DECAY_ENABLE      1u       /* 衰减开关：1 开，0 关 */
#define MUSIC_DECAY_TIME_MS     1500u     /* 衰减时间：600ms（0.6s），0.1~10s 可选 */
#define MUSIC_SUSTAIN_ENABLE    1u       /* 延音开关：1 开（衰减后保持电平），0 关（衰减到底） */
#define MUSIC_SUSTAIN_GAIN_Q8   255u     /* 延音电平（Q8）：220/256≈0.86，即峰值的 86% */

/* ---- 音轨控制：按导出音符的 track 字段（0=旋律 1=伴奏 ...） ---- */
#define MUSIC_TRACK_ENABLE      {1, 1}       /* 每轨是否播放 */
#define MUSIC_TRACK_VOLUME_Q8   {220, 256}   /* 每轨音量：256=100% */

/* ---- 曲目：main.c 通过该宏引入乐谱头文件 ---- */
#define MUSIC_SCORE_INCLUDE     "music/Theme208.h"

#endif
