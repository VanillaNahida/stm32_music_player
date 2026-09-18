#include "stm32f10x.h"                  // Device header

/* main.c 定义的 1ms 系统时间（SysTick 中断累加），供按键消抖使用 */
extern volatile uint32_t system_ticks;

/**
  * 函    数：按键初始化
  * 参    数：无
  * 返 回 值：无
  */
void Key_Init(void)
{
	/*开启时钟*/
	RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);		//开启GPIOB的时钟
	
	/*GPIO初始化*/
	GPIO_InitTypeDef GPIO_InitStructure;
	GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
	GPIO_InitStructure.GPIO_Pin = GPIO_Pin_1 | GPIO_Pin_11;
		GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
	GPIO_Init(GPIOB, &GPIO_InitStructure);						//将PB1和PB11引脚初始化为上拉输入
}

/**
  * 函    数：按键获取键码
  * 参    数：无
  * 返 回 值：按下按键的键码值，范围：0~2，返回0代表没有按键按下
  * 注意事项：非阻塞状态机。检测到按下沿后消抖 10ms 确认，触发一次后
  *           等待松手才允许下次触发；期间函数立即返回，不卡主循环，
  *           因此不影响 OLED 刷新等其他任务
  */
uint8_t Key_GetNum(void)
{
	static uint8_t  st1 = 0u, st11 = 0u;		//按键状态：0=待机 1=消抖中 2=已触发待松手
	static uint32_t db1 = 0u, db11 = 0u;		//消抖起始时间戳
	uint8_t KeyNum = 0u;

	/* KEY1 (PB1) */
	switch (st1)
	{
	case 0u:									//待机：检测到低电平则进入消抖
		if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_1) == 0u)
		{
			db1 = system_ticks;
			st1 = 1u;
		}
		break;
	case 1u:									//消抖中：10ms 后再次确认
		if (system_ticks - db1 >= 10u)
		{
			if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_1) == 0u)
			{
				KeyNum = 1u;					//确认按下，触发一次
				st1 = 2u;
			}
			else
			{
				st1 = 0u;						//抖动，取消
			}
		}
		break;
	case 2u:									//已触发：等待松手后复位
		if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_1) == 1u)
		{
			st1 = 0u;
		}
		break;
	}

	/* KEY2 (PB11) */
	switch (st11)
	{
	case 0u:
		if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_11) == 0u)
		{
			db11 = system_ticks;
			st11 = 1u;
		}
		break;
	case 1u:
		if (system_ticks - db11 >= 10u)
		{
			if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_11) == 0u)
			{
				KeyNum = 2u;
				st11 = 2u;
			}
			else
			{
				st11 = 0u;
			}
		}
		break;
	case 2u:
		if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_11) == 1u)
		{
			st11 = 0u;
		}
		break;
	}

	return KeyNum;
}
