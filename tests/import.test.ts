import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { bridgesToYaml, convertOldConfig, findOldConfigs, formatReport } from '../src/import'

// 编造的数据：频道 ID、群号、名字都是假的
const D1 = '100000000000000001'
const D2 = '100000000000000002'
const D3 = '100000000000000003'
const D4 = '100000000000000004'
const Q1 = '20000001'
const Q2 = '20000002'
const Q3 = '20000003'
const Q4 = '20000004'

const old = {
  constants: {
    // 双向：两个 full
    dcAlpha: { type: 'full', name: 'Discord-Alpha', platform: 'discord', channelId: D1, selfId: '9001' },
    qqAlpha: { type: 'full', name: 'QQ-Alpha', platform: 'onebot', channelId: Q1, selfId: '9002', blockingWords: ['广告', 'foo(', 'a;;b', 'SPAM'] },
    // 一对多：source 没写 selfId（默认 *）
    dcNews: { type: 'source', name: 'Discord News', platform: 'discord', channelId: D2 },
    qqNewsA: { type: 'target', platform: 'onebot', channelId: Q2, selfId: '9002', hidePrefix: true },
    qqNewsB: { type: 'target', platform: 'onebot', channelId: Q3, selfId: '9002' },
    qqOff: { type: 'target', platform: 'onebot', channelId: Q4, selfId: '9002', disabled: true },
    // full 停用：当来源照样有效
    dcGamma: { type: 'full', name: 'Discord', platform: 'discord', channelId: D3, selfId: '9001', disabled: true, simulateOriginal: true },
    qqGamma: { type: 'full', name: 'QQ-Gamma', platform: 'onebot', channelId: Q4, selfId: '9002' },
    dcStar: { type: 'full', platform: 'discord', channelId: '*', selfId: '9001' },
    qqStarSelf: { type: 'target', platform: 'onebot', channelId: Q1, selfId: '*' },
    dcTargetType: { type: 'target', platform: 'discord', channelId: D4, selfId: '9001' },
    qqQuote: { type: 'full', name: 'QQ-Quote', platform: 'onebot', channelId: '20000009', selfId: '9002', onlyQuote: true },
    qqOther: { type: 'target', platform: 'onebot', channelId: '20000010', selfId: '9002' },
    qqPrivate: { type: 'target', platform: 'onebot', channelId: 'private:30000001', selfId: '9002' },
    dcBot: { type: 'target', platform: 'discord', channelId: D4, selfId: '9001' },
  },
  rules: [
    { source: 'dcAlpha', targets: ['qqAlpha'] },
    { source: 'qqAlpha', targets: ['dcAlpha'] },
    { source: 'dcNews', targets: ['qqNewsA', 'qqNewsB', 'qqOff'] },
    { source: 'nobody', targets: ['qqAlpha'] },
    { source: 'dcAlpha', targets: ['ghost'] },
    { source: 'dcNews' },
    { source: 'dcGamma', targets: ['qqGamma'] },
    { source: 'dcStar', targets: ['qqGamma'] },
    { source: 'dcAlpha', targets: ['qqStarSelf'] },
    { source: 'dcTargetType', targets: ['qqGamma'] },
    { source: 'dcAlpha', targets: ['qqQuote'] },
    { source: 'qqQuote', targets: ['dcAlpha'] },
    { source: 'qqGamma', targets: ['qqOther'] },
    { source: 'dcAlpha', targets: ['qqPrivate'] },
    { source: 'qqGamma', targets: ['dcBot'] },
  ],
  delay: { discord: 500 },
}

const r = convertOldConfig(old)
const find = (d: string, q: string) => r.bridges.find(b => b.discord === d && b.qq === q)
const reasonOf = (what: string) => r.skipped.filter(s => s.what.includes(what)).map(s => s.reason).join(' | ')

describe('convertOldConfig', () => {
  it('merges both directions into one both row with QQ-side blockingWords', () => {
    expect(find(D1, Q1)).toEqual({
      label: 'Alpha', discord: D1, qq: Q1, direction: 'both', enabled: true, atAll: false, translate: false, blockWords: '广告;;SPAM',
    })
  })

  it('one source to several targets makes several bridges', () => {
    expect(find(D2, Q2)).toMatchObject({ label: 'News', direction: 'd2q' })
    expect(find(D2, Q3)).toMatchObject({ label: 'News', direction: 'd2q' })
  })

  it('skips a disabled target but a disabled full still works as source', () => {
    expect(find(D2, Q4)).toBeUndefined()
    expect(reasonOf('dcNews → qqOff')).toContain('停用')
    expect(find(D3, Q4)).toMatchObject({ direction: 'd2q', label: 'Gamma' }) // name 是 Discord → 用 QQ 名
  })

  it('reports missing constants and empty targets', () => {
    expect(reasonOf('规则 #4')).toContain('「nobody」不存在')
    expect(reasonOf('dcAlpha → ghost')).toContain('「ghost」不存在')
    expect(reasonOf('规则 #6')).toBe('目标为空')
  })

  it('skips *, target selfId *, target-type source, onlyQuote, same platform, private chat', () => {
    expect(reasonOf('规则 #8')).toContain('channelId 是 *')
    expect(reasonOf('qqStarSelf')).toContain('selfId 是 *')
    expect(reasonOf('规则 #10')).toContain('类型是 target')
    expect(reasonOf('dcAlpha → qqQuote')).toContain('onlyQuote')
    expect(reasonOf('规则 #12')).toContain('onlyQuote')
    expect(reasonOf('qqGamma → qqOther')).toContain('两边都是 onebot')
    expect(reasonOf('qqPrivate')).toContain('不是纯数字')
    expect(r.bridges.some(b => b.qq === '20000009' || b.qq === '20000010')).toBe(false)
  })

  it('q2d-only bridge falls back to QQ name, then constant key', () => {
    expect(find(D4, Q4)).toMatchObject({ direction: 'q2d', label: 'Gamma' })
    const k = convertOldConfig({
      constants: {
        dcK: { type: 'full', platform: 'discord', channelId: D1, selfId: '1' },
        qqK: { type: 'full', platform: 'onebot', channelId: Q1, selfId: '2' },
      },
      rules: [{ source: 'dcK', targets: ['qqK'] }],
    })
    expect(k.bridges[0].label).toBe('dcK')
  })

  it('reports invalid regex and ;; entries once', () => {
    expect(r.skipped.filter(s => s.what.includes('foo('))).toHaveLength(1)
    expect(reasonOf('foo(')).toContain('旧插件遇到它也会出错')
    expect(reasonOf('a;;b')).toContain(';;')
  })

  it('writes notes about behavior changes', () => {
    const all = r.notes.join('\n')
    expect(all).toContain('不区分大小写')
    expect(all).toContain('「qqNewsA」')
    expect(all).toContain('「dcAlpha」') // simulateOriginal:false 的 Discord 目标
    expect(all).not.toContain('「dcGamma」')
    expect(all).toContain('delay')
  })

  it('tolerates garbage input', () => {
    expect(convertOldConfig(null)).toMatchObject({ bridges: [], skipped: [] })
    expect(convertOldConfig({ constants: { x: { platform: 'discord' } }, rules: [{ source: 'x', targets: ['x'] }] }).skipped[0].reason).toContain('type')
  })
})

describe('findOldConfigs', () => {
  const loader = {
    plugins: {
      'adapter-discord:abc': { token: 'x' },
      '@myrtus/forward:one': { constants: {}, rules: [] },
      '~@myrtus/koishi-plugin-forward:two': null,
      'group:g1': {
        $label: '转发',
        $collapsed: true,
        '@myrtus/forward:three': { $if: 'true', rules: [] },
        '@myrtus/forwarder:x': {},
      },
      '~group:g2': {
        'group:inner': { '@myrtus/forward:four': {} },
      },
    },
  }

  it('finds entries with disabled / $if / group handling', () => {
    const f = findOldConfigs(loader)
    expect(f.map(x => [x.path, x.disabled, x.hasIf])).toEqual([
      ['plugins/@myrtus/forward:one', false, false],
      ['plugins/~@myrtus/koishi-plugin-forward:two', true, false],
      ['plugins/group:g1/@myrtus/forward:three', false, true],
      ['plugins/~group:g2/group:inner/@myrtus/forward:four', true, false],
    ])
    expect(f[1].config).toEqual({})
  })

  it('returns [] without plugins', () => {
    expect(findOldConfigs({})).toEqual([])
    expect(findOldConfigs(undefined)).toEqual([])
  })
})

describe('output', () => {
  it('yaml quotes all IDs and round-trips', () => {
    const text = bridgesToYaml(r.bridges)
    expect(text.startsWith('bridges:\n')).toBe(true)
    expect(text).toContain(`discord: '${D1}'`)
    expect(text).toContain(`qq: '${Q1}'`)
    const back = yaml.load(text) as any
    expect(back.bridges).toEqual(r.bridges)
  })

  it('report shows counts, skips and disabled state', () => {
    const text = formatReport([{ path: 'plugins/~x', disabled: true, hasIf: true, result: r }])
    expect(text).toContain('旧插件目前是停用状态')
    expect(text).toContain('$if')
    expect(text).toContain(`生成了 ${r.bridges.length} 个桥：双向 1 个，Discord → QQ 3 个，QQ → Discord 1 个`)
    expect(text).toContain('目标为空')
  })
})
