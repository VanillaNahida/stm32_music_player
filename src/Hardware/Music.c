#include "Music.h"
#include "config.h"
#include <math.h>

/* ============================================================
 * 软件混音合成引擎
 *
 * TIM3 以采样率触发更新中断（PWM 载波 = 采样率），每个采样
 * 周期把若干活跃音符（Voice）的波形混音后写入比较寄存器，
 * 由 PA6 PWM 输出驱动无源蜂鸣器，实现多和弦播放。
 *
 * 包络模型还原 AudioLab：起音 6ms 指数上升 → 可选指数衰减到
 * 延音电平(0.55) 或接近零 → 音符结束线性淡出。
 * ============================================================ */

/* ---- 引擎常量 ---- */
#define TIM3_CLK            72000000u            /* TIM3 计数时钟（72MHz） */
#define ARR_VALUE           (TIM3_CLK / MUSIC_SAMPLE_RATE - 1u)
#define PEAK_Q16            16384u               /* 0.25 * 2^16（AudioLab 单音峰值） */
#define INIT_G              7u                   /* 0.0001 * 2^16，包络地板 */
#define PEAK_REF_Q16        14745u               /* 0.9*0.25 * 2^16（主音量 0.9 下的峰值参考） */

/* ---- 包络状态 ---- */
#define ENV_OFF       0
#define ENV_ATTACK    1
#define ENV_DECAY     2
#define ENV_SUSTAIN   3
#define ENV_RELEASE   4

#define DECAY_ON      (MUSIC_DECAY_ENABLE != 0)
#define SUS_ON        (MUSIC_SUSTAIN_ENABLE != 0)

/* ---- 音轨配置（config.h） ---- */
static const uint8_t  g_track_en[]  = MUSIC_TRACK_ENABLE;
static const uint16_t g_track_vol[] = MUSIC_TRACK_VOLUME_Q8;
#define TRACK_NUM   (sizeof(g_track_en) / sizeof(g_track_en[0]))

/* ---- Voice（活动音符） ---- */
typedef struct {
    uint8_t  active;
    uint8_t  env;
    uint32_t phase;          /* 相位累加器（32bit） */
    uint32_t phase_inc;
    int32_t  gain;           /* Q16.16 当前增益 */
    int32_t  peak;           /* Q16.16 峰值 */
    uint32_t sus_target;     /* Q16.16 延音目标电平 */
    uint32_t attack_end;     /* 攻击段结束采样点 */
    uint32_t end_sample;     /* 音符时长结束采样点（进入释放） */
    uint32_t rel_step;       /* 释放段线性步进 */
    uint32_t rel_ns;         /* 释放段时长（采样数） */
} Voice;

static Voice g_voices[MUSIC_MAX_POLYPHONY];

/* ---- 查找表与包络参数 ---- */
static uint32_t g_phase_inc[128];   /* MIDI 音号 -> 相位增量 */
#if MUSIC_WAVEFORM == WAVE_SINE
static int8_t   g_sine_lut[256];    /* 正弦表 */
#endif

static uint32_t g_attack_ns;        /* 攻击时长（采样数） */
static uint32_t g_decay_ns;         /* 衰减时长（采样数） */
static uint32_t g_release_ns;       /* 释放时长（采样数） */
static uint32_t g_k_attack;         /* 攻击指数系数（Q16.16） */
static uint32_t g_k_decay;          /* 衰减指数系数（Q16.16） */

/* ---- 播放状态 ---- */
static const MusicScore *g_cur       = 0;
static uint32_t g_note_idx           = 0;
static uint32_t g_spp_tick           = 0;   /* 每个 tick 的采样数（由乐谱 tick_us 计算） */
static volatile uint32_t g_sample_cnt = 0;
static volatile uint8_t  g_playing   = 0;
static volatile uint8_t  g_finished  = 0;

/* 由起止电平与时长计算指数系数（初始化时调用，允许浮点） */
static uint32_t EnvK(double from, double to, uint32_t ns)
{
    if (ns == 0u) return 0u;
    return (uint32_t)(exp(log(to / from) / (double)ns) * 65536.0);
}

/* 计算音符峰值增益（Q16.16）：MASTER * 轨音量 * velocity/127 * 0.25 */
static int32_t PeakGain(uint8_t velocity, uint8_t track)
{
    uint64_t num = (uint64_t)MUSIC_MASTER_VOLUME_Q8 * g_track_vol[track]
                   * velocity * PEAK_Q16;
    return (int32_t)(num / (256u * 256u * 127u));
}

/* 启动一个音符（在中断内调用） */
static void NoteOn(const ScoreNote *n)
{
    if (n->track >= TRACK_NUM) return;
    if (!g_track_en[n->track]) return;

    /* 分配 voice：优先空闲，否则窃取结束时间最早的 */
    Voice *v = 0;
    uint32_t oldest = 0xFFFFFFFFu;
    uint32_t i;
    for (i = 0u; i < MUSIC_MAX_POLYPHONY; i++) {
        if (!g_voices[i].active) { v = &g_voices[i]; break; }
        if (g_voices[i].end_sample < oldest) {
            oldest = g_voices[i].end_sample;
            v = &g_voices[i];
        }
    }
    if (v == 0) return;

    v->active       = 1;
    v->env          = ENV_ATTACK;
    v->phase        = 0u;
    v->phase_inc    = g_phase_inc[n->midi];
    v->peak         = PeakGain(n->velocity, n->track);
    v->gain         = (int32_t)INIT_G;
    v->sus_target   = SUS_ON ? ((uint32_t)v->peak * MUSIC_SUSTAIN_GAIN_Q8) >> 8u : INIT_G;
    v->attack_end   = g_sample_cnt + g_attack_ns;
    v->end_sample   = g_sample_cnt + (uint32_t)n->duration * g_spp_tick;
    v->rel_ns       = g_release_ns;
    v->rel_step     = 0u;
}

/* 取一个 voice 的波形采样（返回 Q16.16 贡献值） */
static int32_t WaveSample(const Voice *v)
{
#if MUSIC_WAVEFORM == WAVE_SINE
    /* int8 表 × 512 ≈ 2^16，故 (gain*lut)>>7 为 Q16.16 */
    return ((int32_t)v->gain * g_sine_lut[v->phase >> 24]) >> 7;
#elif MUSIC_WAVEFORM == WAVE_TRIANGLE
    {
        uint32_t u = v->phase >> 16;      /* 0..65535 */
        int32_t  tri;
        if (u < 32768u) tri = (int32_t)(u << 2) - 65536;
        else            tri = (int32_t)((65535u - u) << 2) - 65536;
        return (v->gain * tri) >> 16;
    }
#elif MUSIC_WAVEFORM == WAVE_SQUARE
    return (v->phase & 0x80000000u) ? -v->gain : v->gain;
#else /* WAVE_SAWTOOTH */
    {
        int32_t saw = (int32_t)((v->phase >> 15) & 0x1FFFFu) - 65536;
        return (v->gain * saw) >> 16;
    }
#endif
}

/* ============================================================
 * 采样中断：调度 + 包络 + 混音 + PWM 输出
 * ============================================================ */
void Music_ISR(void)
{
    uint32_t i;
    int32_t  acc = 0;

    /* 防御：未装入乐谱时（Music_Play 之前）不做任何调度 */
    if (g_cur == 0) return;

    /* 1. 调度：按时间序激活到时的音符（乐谱已按 time 排序） */
    if (g_note_idx < g_cur->note_count) {
        const ScoreNote *n = &g_cur->notes[g_note_idx];
        while (g_sample_cnt >= (uint32_t)n->time * g_spp_tick) {
            NoteOn(n);
            g_note_idx++;
            if (g_note_idx >= g_cur->note_count) break;
            n = &g_cur->notes[g_note_idx];
        }
    }

    /* 2. 渲染所有活跃 voice */
    for (i = 0u; i < MUSIC_MAX_POLYPHONY; i++) {
        Voice *v = &g_voices[i];
        if (!v->active) continue;

        /* 音符时长结束 → 进入释放段 */
        if (g_sample_cnt >= v->end_sample && v->env != ENV_RELEASE) {
            v->env = ENV_RELEASE;
            v->rel_step = (uint32_t)v->gain / v->rel_ns;
            if (v->rel_step < 1u) v->rel_step = 1u;
        }

        switch (v->env) {
        case ENV_ATTACK:
        {
            uint32_t g  = (uint32_t)v->gain;
            uint32_t ng = (g * g_k_attack) >> 16;
            /* 防止整数截断：起步阶段增量 <1 会被 >>16 吞掉导致起音卡死，保证至少 +1 */
            if (ng <= g) ng = g + 1u;
            v->gain = (ng > (uint32_t)v->peak) ? (int32_t)v->peak : (int32_t)ng;
            if (g_sample_cnt >= v->attack_end) {
                v->env = DECAY_ON ? ENV_DECAY : ENV_SUSTAIN;
            }
            break;
        }
        case ENV_DECAY:
            v->gain = (int32_t)(((uint32_t)v->gain * g_k_decay) >> 16);
            if ((uint32_t)v->gain <= v->sus_target) {
                if (SUS_ON) { v->gain = (int32_t)v->sus_target; v->env = ENV_SUSTAIN; }
                else        { v->active = 0; v->env = ENV_OFF; continue; }  /* 衰减到底，自结束 */
            }
            break;
        case ENV_SUSTAIN:
            break;
        case ENV_RELEASE:
            if ((uint32_t)v->gain <= v->rel_step) { v->active = 0; v->env = ENV_OFF; continue; }
            v->gain -= (int32_t)v->rel_step;
            break;
        default:
            break;
        }

        v->phase += v->phase_inc;
        acc += WaveSample(v);
    }

    /* 3. 混合样本写入 PWM（Q16.16 → 占空比，钳位到 [0, ARR]） */
    {
        int32_t ccr = (int32_t)(ARR_VALUE >> 1) + ((acc * (int32_t)ARR_VALUE) >> 17);
        if (ccr < 0) ccr = 0;
        else if (ccr > (int32_t)ARR_VALUE) ccr = (int32_t)ARR_VALUE;
        TIM_SetCompare1(TIM3, (uint32_t)ccr);
    }

    /* 4. 自然结束检测：音符播完且所有 voice 释放完毕 */
    if (g_note_idx >= g_cur->note_count) {
        uint8_t any = 0;
        for (i = 0u; i < MUSIC_MAX_POLYPHONY; i++) {
            if (g_voices[i].active) { any = 1; break; }
        }
        if (!any) {
            g_finished = 1;
            g_playing  = 0;
            TIM_Cmd(TIM3, DISABLE);
        }
    }

    g_sample_cnt++;
}

/* ============================================================
 * 对外接口
 * ============================================================ */
void Music_Init(void)
{
    uint32_t i;

    /* MIDI 音号 -> 相位增量表 */
    for (i = 0u; i < 128u; i++) {
        double freq = 440.0 * pow(2.0, ((double)i - 69.0) / 12.0);
        g_phase_inc[i] = (uint32_t)(freq * 4294967296.0 / (double)MUSIC_SAMPLE_RATE);
    }

    /* 正弦表 */
#if MUSIC_WAVEFORM == WAVE_SINE
    for (i = 0u; i < 256u; i++) {
        double s = sin(6.283185307179586 * (double)i / 256.0);
        g_sine_lut[i] = (int8_t)floor(s * 127.0 + 0.5);
    }
#endif

    /* 包络常量 */
    g_attack_ns  = (MUSIC_SAMPLE_RATE / 1000u) * MUSIC_ATTACK_MS;
    g_decay_ns   = (MUSIC_SAMPLE_RATE / 1000u) * MUSIC_DECAY_TIME_MS;
    g_release_ns = DECAY_ON ? g_decay_ns : (MUSIC_SAMPLE_RATE / 1000u) * 50u;
    if (g_attack_ns == 0u) g_attack_ns = 1u;
    if (g_decay_ns  == 0u) g_decay_ns  = 1u;
    g_k_attack = EnvK((double)INIT_G, (double)PEAK_REF_Q16, g_attack_ns);
    g_k_decay  = SUS_ON ? EnvK((double)PEAK_REF_Q16, (double)PEAK_REF_Q16 * 0.55, g_decay_ns)
                        : EnvK((double)PEAK_REF_Q16, (double)INIT_G, g_decay_ns);

    /* TIM3：PWM 载波（采样率），PA6 输出，低电平有效 */
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    {
        GPIO_InitTypeDef g;
        g.GPIO_Pin  = GPIO_Pin_6;
        g.GPIO_Mode = GPIO_Mode_AF_PP;
        g.GPIO_Speed = GPIO_Speed_50MHz;
        GPIO_Init(GPIOA, &g);
    }

    {
        TIM_TimeBaseInitTypeDef tb;
        tb.TIM_Period       = ARR_VALUE;
        tb.TIM_Prescaler    = 0;
        tb.TIM_ClockDivision = TIM_CKD_DIV1;
        tb.TIM_CounterMode  = TIM_CounterMode_Up;
        TIM_TimeBaseInit(TIM3, &tb);
    }

    {
        TIM_OCInitTypeDef oc;
        oc.TIM_OCMode      = TIM_OCMode_PWM1;
        oc.TIM_OutputState = TIM_OutputState_Enable;
        oc.TIM_OCPolarity  = TIM_OCPolarity_Low;
        oc.TIM_Pulse       = ARR_VALUE / 2;
        TIM_OC1Init(TIM3, &oc);
        TIM_OC1PreloadConfig(TIM3, TIM_OCPreload_Enable);
    }
    TIM_ARRPreloadConfig(TIM3, ENABLE);

    {
        NVIC_InitTypeDef nvic;
        nvic.NVIC_IRQChannel                   = TIM3_IRQn;
        nvic.NVIC_IRQChannelPreemptionPriority = 1;
        nvic.NVIC_IRQChannelSubPriority        = 0;
        nvic.NVIC_IRQChannelCmd                = ENABLE;
        NVIC_Init(&nvic);
    }

    /* 清除 TIM_TimeBaseInit 装载 PSC/ARR 时产生的更新标志，
       避免 UIE 使能瞬间挂起中断提前进入（此时尚未 Music_Play） */
    TIM_ClearFlag(TIM3, TIM_FLAG_Update);
    TIM_ITConfig(TIM3, TIM_IT_Update, ENABLE);

    /* 初始静音：比较值居中（50% 占空比，直流无声音） */
    TIM_SetCompare1(TIM3, ARR_VALUE / 2);
}

void Music_Play(const MusicScore *score)
{
    uint32_t i;
    g_cur        = score;
    g_note_idx   = 0u;
    g_sample_cnt = 0u;
    g_finished   = 0u;
    /* 按乐谱时间单位换算每个 tick 的采样数（长曲自动 10ms 也能正确播放） */
    g_spp_tick   = (MUSIC_SAMPLE_RATE / 1000u) * (score->tick_us / 1000u);
    if (g_spp_tick == 0u) g_spp_tick = 1u;
    for (i = 0u; i < MUSIC_MAX_POLYPHONY; i++) {
        g_voices[i].active = 0;
        g_voices[i].env    = ENV_OFF;
    }
    TIM_SetCompare1(TIM3, ARR_VALUE / 2);
    g_playing = 1;
    TIM_Cmd(TIM3, ENABLE);
}

void Music_Pause(void)
{
    if (!g_playing) return;
    TIM_Cmd(TIM3, DISABLE);
    g_playing = 0;
}

void Music_Resume(void)
{
    if (g_playing || g_finished) return;
    g_playing = 1;
    TIM_Cmd(TIM3, ENABLE);
}

void Music_Stop(void)
{
    uint32_t i;
    TIM_Cmd(TIM3, DISABLE);
    for (i = 0u; i < MUSIC_MAX_POLYPHONY; i++) {
        g_voices[i].active = 0;
        g_voices[i].env    = ENV_OFF;
    }
    TIM_SetCompare1(TIM3, ARR_VALUE / 2);
    g_playing  = 0;
    g_finished = 1;
}

uint32_t Music_GetPlayMs(void)
{
    return (uint32_t)((uint64_t)g_sample_cnt * 1000u / MUSIC_SAMPLE_RATE);
}

uint8_t Music_IsPlaying(void)
{
    return g_playing;
}

uint8_t Music_IsFinished(void)
{
    return g_finished;
}
