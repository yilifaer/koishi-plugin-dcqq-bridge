import { describe, expect, it } from 'vitest'
import { Config } from '../src/config'

describe('Config schema', () => {
  it('fills defaults from an empty config', () => {
    const c = Config({} as any)
    expect(c.timezone).toBe('Asia/Shanghai')
    expect(c.bridges).toEqual([])
    expect(c.atAll.fallbackText).toBe('【全体通知】')
    expect(c.atAll.maxAgeMinutes).toBe(10)
    expect(c.keepDays).toBe(7)
    expect(c.authority).toBe(4)
  })

  it('never throws on wrongly typed values (config errors stay local)', () => {
    const c = Config({ keepDays: 'x', atAll: 5, bridges: [{ discord: 123, qq: '1', direction: 'bad', enabled: 'y' }] } as any)
    expect(c.keepDays).toBe(7)
    expect(typeof c.atAll).toBe('object') // 缺少的字段由运行时的 normalize 补上
    expect(c.bridges[0]).toMatchObject({ discord: '', qq: '1', direction: 'both', enabled: true })
  })
})
