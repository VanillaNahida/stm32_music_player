#include "stm32f10x.h"
#include "Delay.h"
#include "OLED.h"
#include "Key.h"
#include "Music.h"
#include "config.h"

/* 引入乐谱（config.h 的 MUSIC_SCORE_INCLUDE 指定具体曲目） */
#include MUSIC_SCORE_INCLUDE

/* ============================================================
 * 多和弦音乐盒
 *
 * 开机自动播放 config.h 指定的乐谱（TIM3 PWM 驱动无源蜂鸣器，
 * 软件混音实现旋律 + 伴奏多和弦效果）。
 *   KEY1：播放/暂停/重播切换
 *   KEY2：重新播放
 *   OLED 第 1 行：曲名，第 2 行：进度与状态
 * ============================================================ */

/* 系统时间（SysTick 1ms 中断累加） */
volatile uint32_t system_ticks = 0;

void SysTick_Init(void)
{
    if (SysTick_Config(72000))   /* 72MHz / 1000 = 72000，每 1ms 中断 */
    {
        while (1);
    }
}

uint32_t GetSystemTime(void)
{
    return system_ticks;
}

/* 非阻塞延时，返回 1 表示到期 */
uint8_t DelayNonBlocking(uint32_t *timer, uint32_t delay_time)
{
    if (GetSystemTime() - *timer >= delay_time)
    {
        *timer = GetSystemTime();
        return 1;
    }
    return 0;
}

/* 当前乐曲（乐谱数组 g_score 由乐谱头文件提供） */
static const MusicScore g_music = {
    SCORE_NOTE_COUNT,
    SCORE_TOTAL_TIME_MS,
    SCORE_TICK_US,
    g_score
};

/* 刷新 OLED 第二行：Time mm:ss + 状态 */
static void ShowProgress(uint32_t ms, char *state)
{
    uint32_t minutes = ms / 60000u;
    uint32_t seconds = (ms % 60000u) / 1000u;

    OLED_ShowString(2, 1, "Time ");
    OLED_ShowNum(2, 6, minutes, 2);
    OLED_ShowChar(2, 8, ':');
    OLED_ShowNum(2, 9, seconds, 2);
    OLED_ShowString(2, 12, state);
}

/* 第 1 行标题区："Now: " 占第 1~5 列，曲名窗口从第 6 列起（像素 40），宽 11 列（88 像素） */
#define TITLE_WIN_COL   6u
#define TITLE_WIN_W     11u
#define TITLE_X0        ((TITLE_WIN_COL - 1u) * 8u)   /* 窗口左边界像素 40 */
#define TITLE_PIX_W     (TITLE_WIN_W * 8u)            /* 窗口宽度像素 88 */

/* 字符串长度（曲名滚动判断用） */
static uint8_t Title_StrLen(const char *s)
{
    uint8_t n = 0u;
    while (s[n] != '\0') n++;
    return n;
}

/* 第 1 行显示曲名：pix 为窗口内像素偏移，帧缓冲渲染一次刷入（无闪烁） */
static void Title_Show(uint16_t pix)
{
    OLED_ShowWinPix(1, (uint8_t)TITLE_X0, (uint8_t)TITLE_PIX_W, pix, SCORE_NAME);
}

int main(void)
{
    uint32_t t_refresh;
    uint32_t t_title;
    uint32_t t_pause;              /* 滚动停顿计时 */
    uint8_t  title_len;
    uint8_t  title_scroll;
    uint8_t  title_phase = 0u;     /* 0=滚动中 1=末尾停顿 2=开头停顿 */
    int16_t  pix_max;
    uint16_t title_pix = 0u;

    SysTick_Init();
    OLED_Init();
    Key_Init();
    Music_Init();

    OLED_Clear();
    OLED_ShowString(1, 1, "Now: ");

    /* 曲名是否过长（需要滚动） */
    title_len    = Title_StrLen(SCORE_NAME);
    title_scroll = (title_len > TITLE_WIN_W) ? 1u : 0u;
    pix_max      = (int16_t)((int16_t)title_len * 8 - (int16_t)TITLE_PIX_W);
    Title_Show(0u);

    Music_Play(&g_music);

    t_refresh = GetSystemTime();
    t_title   = GetSystemTime();
    t_pause   = GetSystemTime();

    while (1)
    {
        uint8_t key = Key_GetNum();

        /* KEY1：播放/暂停/结束重播 */
        if (key == 1)
        {
            if (Music_IsPlaying())
            {
                Music_Pause();
            }
            else if (Music_IsFinished())
            {
                Music_Play(&g_music);
            }
            else
            {
                Music_Resume();
            }
        }
        /* KEY2：重新播放 */
        else if (key == 2)
        {
            Music_Play(&g_music);
        }

        /* 曲名过长时滚动状态机：每 30ms 步进 1 像素；
         * 滚到末尾停顿 2s → 跳回开头停顿 2s → 继续滚动，以此循环 */
        if (title_scroll && DelayNonBlocking(&t_title, 30))
        {
            switch (title_phase)
            {
            case 0u:                                  /* 滚动中 */
                title_pix += 1u;
                if (title_pix > (uint16_t)pix_max)
                {
                    title_pix = (uint16_t)pix_max;    /* 停在末尾画面 */
                    title_phase = 1u;
                    t_pause = GetSystemTime();
                }
                Title_Show(title_pix);
                break;
            case 1u:                                  /* 末尾停顿 2s 后跳回开头 */
                if (GetSystemTime() - t_pause >= 2000u)
                {
                    title_pix = 0u;
                    Title_Show(title_pix);
                    title_phase = 2u;
                    t_pause = GetSystemTime();
                }
                break;
            case 2u:                                  /* 开头停顿 2s 后继续滚动 */
                if (GetSystemTime() - t_pause >= 2000u)
                {
                    title_phase = 0u;
                }
                break;
            }
        }

        /* 每 200ms 刷新一次进度显示 */
        if (DelayNonBlocking(&t_refresh, 200))
        {
            if (Music_IsFinished())
            {
                ShowProgress(SCORE_TOTAL_TIME_MS, "DONE");
            }
            else if (Music_IsPlaying())
            {
                ShowProgress(Music_GetPlayMs(), "PLAY");
            }
            else
            {
                ShowProgress(Music_GetPlayMs(), "PAUS");
            }
        }
    }
}
