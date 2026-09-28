import { describe, it, expect } from 'vitest'
import { formatTimestamp, isValidTimeZone } from '../src/discord/timestamp'

// 清单 §7.3 的例子：2026-09-25 13:30:15 UTC，时区 Asia/Shanghai，现在 = 2026-09-25 11:30:00 UTC
const N = Date.UTC(2026, 8, 25, 13, 30, 15) / 1000
const NOW = Date.UTC(2026, 8, 25, 11, 30, 0)
const TZ = 'Asia/Shanghai'
const f = (style: string | undefined, n = N, now = NOW, tz = TZ) => formatTimestamp(n, style, tz, now)

describe('formatTimestamp', () => {
  it('测试进程的本机时区不是 UTC+8', () => {
    expect(new Date(NOW).getTimezoneOffset()).not.toBe(-480)
  })

  it.each([
    ['t', '21:30'],
    ['T', '21:30:15'],
    ['d', '2026-09-25'],
    ['D', '2026年9月25日'],
    ['f', '2026年9月25日 21:30'],
    ['F', '2026年9月25日 星期五 21:30'],
    ['s', '2026-09-25 21:30'],
    ['S', '2026-09-25 21:30:15'],
    ['R', '2026年9月25日 21:30（约2小时后）'],
  ])('样式 %s', (style, expected) => {
    expect(f(style)).toBe(expected)
  })

  it('不带样式 = f', () => {
    expect(f(undefined)).toBe('2026年9月25日 21:30')
  })

  it('d/s/S 的月和日补零，时间跨日按配置的时区', () => {
    const n = Date.UTC(2026, 0, 4, 16, 5, 9) / 1000 // 上海 1 月 5 日 00:05:09
    expect(f('d', n)).toBe('2026-01-05')
    expect(f('S', n)).toBe('2026-01-05 00:05:09')
    expect(f('D', n)).toBe('2026年1月5日')
    expect(f('t', n)).toBe('00:05')
  })

  it('换一个时区结果不同', () => {
    expect(f('f', N, NOW, 'UTC')).toBe('2026年9月25日 13:30')
  })

  it('R：过去的时间', () => {
    expect(f('R', N, NOW + 5 * 3600_000)).toBe('2026年9月25日 21:30（约3小时前）')
    expect(f('R', N, N * 1000 + 3 * 86400_000)).toBe('2026年9月25日 21:30（约3天前）')
  })

  it('R：取整规则', () => {
    const t = N * 1000
    expect(f('R', N, t - 20_000)).toMatch(/（刚刚）$/)
    expect(f('R', N, t + 29_000)).toMatch(/（刚刚）$/)
    expect(f('R', N, t - 90_000)).toMatch(/（约2分钟后）$/)
    expect(f('R', N, t + 59 * 60_000)).toMatch(/（约59分钟前）$/)
    expect(f('R', N, t - 59.6 * 60_000)).toMatch(/（约1小时后）$/)
    expect(f('R', N, t - 23.4 * 3600_000)).toMatch(/（约23小时后）$/)
    expect(f('R', N, t - 23.6 * 3600_000)).toMatch(/（约1天后）$/)
    expect(f('R', N, t - 10 * 86400_000)).toMatch(/（约10天后）$/)
  })

  it('非法数字、超出范围、未知样式 → null', () => {
    expect(f('f', NaN)).toBeNull()
    expect(f('f', 1.5)).toBeNull()
    expect(f('f', -1)).toBeNull()
    expect(f('f', 1e13)).toBeNull()
    expect(f('f', Infinity)).toBeNull()
    expect(f('x')).toBeNull()
  })
})

describe('isValidTimeZone', () => {
  it('返回规范名或 null', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(isValidTimeZone('asia/shanghai')).toBe('Asia/Shanghai')
    expect(isValidTimeZone('UTC')).toBe('UTC')
    expect(isValidTimeZone('Mars/Olympus')).toBeNull()
    expect(isValidTimeZone('')).toBeNull()
  })
})
