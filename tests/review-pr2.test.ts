// PR 2 代码审查发现的问题的回归测试。
import { describe, expect, it } from 'vitest'
import { normalizeSettings } from '../src/bridges'
import { protect } from '../src/translate/protect'

describe('PR 2 审查修正', () => {
  it('名字里带 ⟦⟧ 或网址时，整段名字一起被保护', () => {
    const r = protect('@⟦VIP⟧ Alice Smith please come', ['@⟦VIP⟧ Alice Smith'])
    expect(r.text).toBe('⟦0⟧ please come')
    expect(r.tokens[0].value).toBe('@⟦VIP⟧ Alice Smith')
    const u = protect('@card https://x.example/a please', ['@card https://x.example/a'])
    expect(u.text).toBe('⟦0⟧ please')
  })

  it('看不见的字符组成的标注仍然回退成【机翻】', () => {
    for (const label of ['‎', '­⁡', '͏', ' ㅤ ']) {
      expect(normalizeSettings({ translate: { label } as any }).translate.label).toBe('【机翻】')
    }
  })
})
