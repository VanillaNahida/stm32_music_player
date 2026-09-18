#ifndef __MUSIC_H
#define __MUSIC_H

#include "stm32f10x.h"

/* 波形选择（供 config.h 使用，见 MUSIC_WAVEFORM） */
#define WAVE_SINE       0
#define WAVE_TRIANGLE   1
#define WAVE_SQUARE     2
#define WAVE_SAWTOOTH   3

/* 单个音符：8 字节（ARM 对齐后为 8），由 AudioLab 导出器生成 */
typedef struct {
    uint16_t time;      /* 起始时刻，单位：tick */
    uint16_t duration;  /* 时长，单位：tick */
    uint8_t  midi;      /* MIDI 音号 0-127 */
    uint8_t  velocity;  /* 力度 1-127 */
    uint8_t  track;     /* 音轨号：0=旋律 1=伴奏 ... */
} ScoreNote;

/* 一首乐曲（乐谱数组放在 Flash） */
typedef struct {
    uint32_t        note_count;
    uint32_t        total_time_ms;
    uint32_t        tick_us;        /* 时间单位（微秒/tick），由乐谱头文件给出 */
    const ScoreNote *notes;
} MusicScore;

/* 初始化合成引擎（TIM3 PWM 采样混音，PA6） */
void Music_Init(void);

/* 开始/重新播放一首乐曲 */
void Music_Play(const MusicScore *score);

/* 暂停（冻结输出与计时） */
void Music_Pause(void);

/* 从暂停处继续 */
void Music_Resume(void);

/* 停止并静音 */
void Music_Stop(void);

/* 当前播放进度（毫秒） */
uint32_t Music_GetPlayMs(void);

/* 是否正在播放 */
uint8_t Music_IsPlaying(void);

/* 是否已自然播放完毕 */
uint8_t Music_IsFinished(void);

/* 采样混音中断（由 TIM3_IRQHandler 调用） */
void Music_ISR(void);

#endif
