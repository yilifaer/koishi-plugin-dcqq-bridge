import { describe, expect, it } from 'vitest'
import { Config } from '../src/config'
import { normalizeSettings } from '../src/bridges'

const ROW = { label: '测试', discord: '100000000000000001', qq: '200000001' }

describe('Config schema', () => {
  it('fills defaults from an empty config', () => {
    const c = Config({} as any)
    expect(c.timezone).toBe('Asia/Shanghai')
    expect(c.bridges).toEqual([])
    expect(c.atAll.fallbackText).toBe('【全体通知】')
    expect(c.atAll.maxAgeMinutes).toBe(10)
    expect(c.keepDays).toBe(7)
    expect(c.authority).toBe(4)
    expect(c.maxQueueAgeMinutes).toBe(15)
  })

  it('never throws on wrongly typed values (config errors stay local)', () => {
    const c = Config({ keepDays: 'x', maxQueueAgeMinutes: 'x', atAll: 5, bridges: [{ discord: 123, qq: '1' }, { ...ROW, direction: 'bad', enabled: 'y' }] } as any)
    expect(c.keepDays).toBe(7)
    expect(c.maxQueueAgeMinutes).toBe(15)
    expect(typeof c.atAll).toBe('object') // 缺少的字段由运行时的 normalize 补上
    expect(c.bridges[0]).toMatchObject({ discord: '', qq: '1', direction: 'both', enabled: true })
    expect(normalizeSettings(c).rows[1].invalid).toContain('第 2 行有写错的字段')
  })

  it('keeps each bridge row an object schema so the console table works', () => {
    const bridges = (Config as any).list[1].dict.bridges
    expect(bridges.type).toBe('array')
    expect(bridges.meta.role).toBe('table')
    expect(bridges.inner.type).toBe('object')
    expect(Object.keys(bridges.inner.dict)).toEqual(['label', 'discord', 'qq', 'direction', 'enabled', 'atAll', 'blockWords', 'translate'])
  })

  it('a bad row only invalidates itself (A6)', () => {
    const cases: any[] = [
      'oops',
      { ...ROW, direction: 'D2Q' },
      { ...ROW, direction: 'q2d ' },
      { ...ROW, enabled: 'no' },
      { ...ROW, atAll: 'yes' },
      { ...ROW, translate: 1 },
      ['x'],
    ]
    for (const bad of cases) {
      const good = { label: '好', discord: '100000000000000002', qq: '200000002', direction: 'd2q' }
      const s = normalizeSettings(Config({ bridges: [good, bad] } as any))
      expect(s.rows).toHaveLength(2)
      expect(s.rows[1].invalid).toBe('第 2 行有写错的字段（例如方向、启用写成了别的值），已跳过')
      expect(s.rows[0].invalid).toBe('')
      expect(s.bridges.map((b) => b.index)).toEqual([1])
      expect(s.bridges[0]).toMatchObject({ direction: 'd2q', discord: '100000000000000002' })
    }
  })

  it('valid rows, empty rows and missing config still work', () => {
    const s = normalizeSettings(Config({ bridges: [{ ...ROW, direction: 'q2d', enabled: false }, { ...ROW, qq: '200000003', atAll: true, translate: true }, null] } as any))
    expect(s.rows[0]).toMatchObject({ invalid: '', enabled: false, direction: 'q2d' })
    expect(s.bridges).toHaveLength(1)
    expect(s.bridges[0]).toMatchObject({ index: 2, direction: 'both', atAll: true, translate: true })
    // 空行（控制台里新加、还没填）按普通空行提示
    expect(s.rows[2].invalid).toContain('Discord 频道 ID 为空')
    expect(normalizeSettings(Config({ bridges: 'oops' } as any)).rows).toEqual([])
    expect(normalizeSettings(Config({} as any)).bridges).toEqual([])
    expect(normalizeSettings({}).maxQueueAgeMinutes).toBe(15)
  })

  it('clamps maxQueueAgeMinutes to 0..1440', () => {
    expect(normalizeSettings({ maxQueueAgeMinutes: 0 }).maxQueueAgeMinutes).toBe(0)
    expect(normalizeSettings({ maxQueueAgeMinutes: -5 }).maxQueueAgeMinutes).toBe(0)
    expect(normalizeSettings({ maxQueueAgeMinutes: 99999 }).maxQueueAgeMinutes).toBe(1440)
  })
})
