# STM32 多和弦蜂鸣器音乐盒 (STM32 Music Player)

<!-- <div align="center">
  <img width="2056" height="1156" alt="STM32多和弦蜂鸣器音乐盒_封面" src="https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=STM32%20microcontroller%20development%20board%20with%20piezo%20buzzer%20and%20small%20OLED%20screen%20on%20a%20workbench%2C%20electronic%20music%20project%2C%20macro%20photography%2C%20soft%20studio%20lighting%2C%20dark%20blue%20and%20teal%20tones&image_size=landscape_16_9" />
</div> -->

<div align="center">

  [![GitHub stars](https://img.shields.io/github/stars/VanillaNahida/stm32_music_player?style=flat-square)](https://github.com/VanillaNahida/stm32_music_player/stargazers)
  [![GitHub forks](https://img.shields.io/github/forks/VanillaNahida/stm32_music_player?style=flat-square)](https://github.com/VanillaNahida/stm32_music_player/network)
  [![GitHub issues](https://img.shields.io/github/issues/VanillaNahida/stm32_music_player?style=flat-square)](https://github.com/VanillaNahida/stm32_music_player/issues)
  [![Platform](https://img.shields.io/badge/Platform-STM32F103C8T6-brightgreen.svg?style=flat-square)]()
  [![Author](https://img.shields.io/badge/%E4%BD%9C%E8%80%85-VanillaNahida-green)](https://github.com/VanillaNahida)

</div>

基于 STM32F103C8T6 的蜂鸣器音乐播放器。将 MIDI 的旋律与伴奏音轨合成多和弦方波（或可选波形），通过单路 PWM 输出驱动无源蜂鸣器，配合自定义包络还原桌面合成器 AudioLab 的音色。附带 MIDI 转 C 数组导出工具，换歌只需一次导出 + 一行配置。

# 功能说明

## 音乐播放

- **多和弦播放**：8 复音软件混音，旋律 + 伴奏音轨同时发声，单 PWM 通道实现多和弦效果
- **波形可选**：方波 / 正弦 / 三角 / 锯齿，`config.h` 一键切换
- **包络还原 AudioLab**：6ms 指数起音、可调指数衰减、可调延音电平，音符结束线性释放
- **按轨控制**：每轨可独立开关、独立音量，通过导出音符中的轨道号区分旋律与伴奏

## 交互与显示

- **OLED 显示**：第 1 行曲名（超长自动像素级平滑滚动，末尾停顿 2s 循环），第 2 行播放进度与状态
- **按键控制**：KEY1 播放 / 暂停 / 重播切换，KEY2 重新播放（非阻塞扫描，不干扰刷新）

# 技术栈

- **MCU**：STM32F103C8T6（ARM Cortex-M3，72MHz）
- **开发环境**：Keil MDK V5 + ARMCC V5.06
- **合成引擎**：相位累加器振荡器 + Q16.16 定点包络 + 32kHz 采样中断 + 8 复音混音，PWM-DAC 软件输出
- **外设驱动**：TIM3 PWM（PA6）、SysTick、I2C OLED、GPIO 按键
- **配套工具**：AudioLab（HTML + PHP + 原生 JS），基于 tonejs-midi 解析，`export_c.js` 导出 C 数组乐谱

# 硬件接线

| STM32 引脚 | 连接 | 说明 |
|-----------|------|------|
| PA6 | 无源蜂鸣器正极 | TIM3 CH1 PWM 输出；建议经三极管放大或串接电感，声音更响 |
| PB8 / PB9 | OLED SCL / SDA | I2C 接口（0x78 地址） |
| PB1 | KEY1 | 播放 / 暂停 / 重播 |
| PB11 | KEY2 | 重新播放 |

注意：必须使用**无源蜂鸣器**（无振荡源），有源蜂鸣器无法播放旋律。

# 编译烧录指南

## 环境要求

- Keil MDK V5（ARMCC V5.06）
- ST-Link 调试器
- STM32F103C8T6 最小系统板 + 无源蜂鸣器 + 0.96 寸 I2C OLED

## 安装步骤

1. 克隆仓库并用 Keil 打开 `Project.uvprojx`

```bash
git clone https://github.com/VanillaNahida/stm32_music_player.git
```

2. 确认工程配置的包含路径包含 `User/`、`User/music/`、`Hardware/`、`System/`

3. 在 `User/config.h` 中选择曲目：

```c
#define MUSIC_SCORE_INCLUDE     "re_aoharu.h"   /* 换成 User/music/ 下的任意乐谱 */
```

4. 配置 ST-Link（Options for Target → Debug → ST-Link Debugger → Settings 确认能识别芯片）

5. 点击 Download 烧录，复位后自动开始播放

## 换歌流程

1. 启动 AudioLab（PHP 服务指向 `AudioLab/` 目录），加载目标 MIDI 文件
2. 选择导出格式 **C 数组 (.h)**，导出乐谱头文件
3. 将生成的 `.h` 放入 `User/music/`
4. 修改 `config.h` 的 `MUSIC_SCORE_INCLUDE` 指向新文件，重新编译

## 配置说明（User/config.h）

| 配置宏 | 说明 | 示例值 |
|--------|------|--------|
| `MUSIC_SAMPLE_RATE` | 采样率（Hz），同时是 PWM 载波频率 | `32000` |
| `MUSIC_MAX_POLYPHONY` | 最大同时发声数（复音数） | `8` |
| `MUSIC_MASTER_VOLUME_Q8` | 主音量（Q8 定点，256=100%） | `255` |
| `MUSIC_WAVEFORM` | 波形：方波 / 正弦 / 三角 / 锯齿 | `WAVE_SQUARE` |
| `MUSIC_ATTACK_MS` | 起音时长（毫秒） | `6` |
| `MUSIC_DECAY_TIME_MS` | 指数衰减时间（毫秒） | `600` |
| `MUSIC_SUSTAIN_ENABLE` | 延音开关：1 保持电平，0 衰减到底 | `1` |
| `MUSIC_SUSTAIN_GAIN_Q8` | 延音电平（Q8 定点，如 `220`≈86%） | `220` |
| `MUSIC_TRACK_ENABLE` | 各音轨播放开关 | `{1, 1}` |
| `MUSIC_TRACK_VOLUME_Q8` | 各音轨音量 | `{256, 256}` |

说明：`u` 为无符号整型常量后缀，仅修饰类型不改变数值；Q8 定点值换算为实际倍数 = 数值 / 256。

# 项目结构

```
stm32_music_player/
├── Project.uvprojx          # Keil 工程文件
├── User/
│   ├── main.c               # 主程序：播放控制、OLED 曲名滚动与进度显示
│   ├── config.h             # 全局配置（波形 / 包络 / 音轨 / 曲目）
│   ├── stm32f10x_it.c       # TIM3 采样中断入口
│   └── music/               # 乐谱（MIDI 导出的 C 数组）
│       ├── re_aoharu.h
│       ├── china_x.h
│       ├── ballade_pour_adeline.h
│       ├── constant_moderato.h
│       └── roujin_to_umi.h
├── Hardware/
│   ├── Music.c / Music.h    # 多和弦合成引擎（振荡器 + 包络 + 混音）
│   ├── OLED.c / OLED.h      # OLED 驱动（含像素级窗口滚动）
│   ├── Key.c / Key.h        # 非阻塞按键状态机
│   └── LED.c / LED.h        # LED 指示
├── System/
│   └── Delay.c / Delay.h    # 延时
├── AudioLab/
│   ├── index.html / index.js / index.css   # MIDI 浏览器工具
│   ├── export_c.js          # MIDI 音符 → C 数组乐谱导出器
│   └── api/                 # PHP 后端（MIDI 文件列表等）
└── .gitignore
```

# 免责声明

本项目仅供学习交流和研究目的，禁止用于商业用途。工程依赖的部分 MIDI 资源版权归原作者所有。

# Bug 反馈

如果在使用过程中遇到任何问题，请通过以下方式反馈：

- [GitHub Issues](https://github.com/VanillaNahida/stm32_music_player/issues)
