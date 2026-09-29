import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildGlossary, loadCommonWords, loadEveData, parseSlangYaml,
  type EveData, type EveEntry, type GlossaryOptions, type SlangEntry,
} from '../src/glossary'

// 术语表（清单 §12.3、§18.1 PR 2）。词条是测试用的小表，中文译名不一定是官方译名。

const common = new Set(['catch', 'cache', 'stain', 'the', 'fleet'])
const eve = (entries: EveEntry[]): EveData => ({ buildNumber: 1, generatedAt: '2026-09-29T00:00:00Z', entries })
const opts = (patch: Partial<GlossaryOptions> = {}): GlossaryOptions => ({ eve: true, systemStyle: 'en(zh)', overrides: [], ...patch })
const build = (entries: EveEntry[], slang: SlangEntry[] = [], patch: Partial<GlossaryOptions> = {}) =>
  buildGlossary(opts(patch), { eveData: eve(entries), slang, commonWords: common })
const restore = (text: string, tokens: Array<{ token: string; value: string }>) =>
  tokens.reduce((t, { token, value }) => t.replace(token, value), text)

const OFFICIAL: EveEntry[] = [
  { en: 'Rifter', zh: '裂谷级', kind: 'type' },
  { en: 'Moa', zh: '恐鸟级', kind: 'type' },
  { en: 'Warp Disruptor', zh: '跃迁扰断器', kind: 'type' },
  { en: 'Warp Disruptor II', zh: '跃迁扰断器 II', kind: 'type' },
  { en: 'Veldspar', zh: '凡晶', kind: 'type' },
  { en: 'Hawkling', zh: '鹰级', kind: 'type' },
  { en: 'Rattlesnake', zh: '响尾蛇级', kind: 'type' },
  { en: 'Sidewinder', zh: '响尾蛇级', kind: 'type' },
  { en: 'Jita', zh: '吉他', kind: 'system' },
  { en: 'Catch', zh: '卡奇', kind: 'region' },
  { en: 'Kimotoro', zh: '木本', kind: 'constellation' },
  { en: '1DQ1-A', zh: '错误的名字', kind: 'system' },
  { en: 'J123456', zh: '虫洞', kind: 'system' },
]

describe('官方名称表', () => {
  const { glossary, warnings } = build(OFFICIAL)

  it('没有警告，代号星系和虫洞星系不进术语表', () => {
    expect(warnings).toEqual([])
    for (const text of ['staging 1DQ1-A now', 'into J123456 now']) {
      expect(glossary.apply(text, 'en2zh')).toEqual({ text, tokens: [], hints: [] })
    }
    expect(glossary.apply('去错误的名字', 'zh2en').hints).toEqual([])
    expect(glossary.size).toBe(OFFICIAL.length - 2)
  })

  it('`Moa`（3 个字母以内）只在大小写完全一致时匹配，且只作 hint', () => {
    expect(glossary.apply('bring a Moa', 'en2zh')).toEqual({ text: 'bring a Moa', tokens: [], hints: ['Moa => 恐鸟级'] })
    expect(glossary.apply('bring a moa', 'en2zh').hints).toEqual([])
    expect(glossary.apply('bring a MOA', 'en2zh').hints).toEqual([])
    expect(glossary.apply('two Moas', 'en2zh').hints).toEqual(['Moa => 恐鸟级'])
  })

  it('force 换成占位符，值是目标语言的标准写法；大小写不敏感；复数 s', () => {
    const r = glossary.apply('need two rifters and a RIFTER', 'en2zh')
    expect(r.text).toBe('need two ⟦G0⟧ and a ⟦G1⟧')
    expect(r.tokens).toEqual([{ token: '⟦G0⟧', value: '裂谷级' }, { token: '⟦G1⟧', value: '裂谷级' }])
    expect(glossary.apply('Rifterss', 'en2zh').tokens).toEqual([])
    expect(glossary.apply('Rifterish', 'en2zh').tokens).toEqual([])
    expect(glossary.apply('xRifter', 'en2zh').tokens).toEqual([])
  })

  it('最长优先、互不重叠', () => {
    const r = glossary.apply('fit a Warp Disruptor II and a Warp Disruptor', 'en2zh')
    expect(r.tokens.map((t) => t.value)).toEqual(['跃迁扰断器 II', '跃迁扰断器'])
  })

  it('常用词：`catch the fleet` 不变，`staging in Catch` 匹配（hint）；句首的 Catch 不匹配', () => {
    expect(glossary.apply('catch the fleet', 'en2zh')).toEqual({ text: 'catch the fleet', tokens: [], hints: [] })
    expect(glossary.apply('Catch the fleet', 'en2zh').hints).toEqual([])
    expect(glossary.apply('ok. Catch the fleet', 'en2zh').hints).toEqual([])
    expect(glossary.apply('staging in Catch', 'en2zh')).toEqual({ text: 'staging in Catch', tokens: [], hints: ['Catch => 卡奇'] })
    expect(glossary.apply('staging in CATCH', 'en2zh').hints).toEqual(['Catch => 卡奇'])
  })

  it('「吉他」中译英只作 hint；少于 3 个字、不以「级」结尾的中文只作 hint', () => {
    expect(glossary.apply('今晚去吉他买东西', 'zh2en')).toEqual({ text: '今晚去吉他买东西', tokens: [], hints: ['Jita => 吉他'] })
    expect(glossary.apply('挖凡晶', 'zh2en')).toEqual({ text: '挖凡晶', tokens: [], hints: ['Veldspar => 凡晶'] })
    expect(glossary.apply('开鹰级', 'zh2en').tokens).toEqual([{ token: '⟦G0⟧', value: 'Hawkling' }])
    expect(glossary.apply('开裂谷级', 'zh2en').tokens).toEqual([{ token: '⟦G0⟧', value: 'Rifter' }])
  })

  it('一个中文对应两个英文 → 不用于中译英，英译中照常', () => {
    expect(glossary.apply('来一艘响尾蛇级', 'zh2en')).toEqual({ text: '来一艘响尾蛇级', tokens: [], hints: [] })
    expect(glossary.apply('Rattlesnake and Sidewinder', 'en2zh').tokens.map((t) => t.value)).toEqual(['响尾蛇级', '响尾蛇级'])
  })

  it('星系按 systemStyle 输出：`Jita(吉他)` / `Jita` / `吉他`', () => {
    const value = (systemStyle: GlossaryOptions['systemStyle']) =>
      build(OFFICIAL, [], { systemStyle }).glossary.apply('meet in Jita', 'en2zh').tokens[0]?.value
    expect(value('en(zh)')).toBe('Jita(吉他)')
    expect(value('en')).toBe('Jita')
    expect(value('zh')).toBe('吉他')
    const r = glossary.apply('Kimotoro and Jita', 'en2zh')
    expect(restore(r.text, r.tokens)).toBe('Kimotoro(木本) and Jita(吉他)')
  })

  it('eve 关闭时不加载官方名称表', () => {
    const { glossary: off } = build(OFFICIAL, [], { eve: false })
    expect(off.size).toBe(0)
    expect(off.apply('Rifter in Jita', 'en2zh').tokens).toEqual([])
  })

  it('输入里已有的占位符 ⟦0⟧ 原样不动，不在里面或跨过它匹配', () => {
    const { glossary: g } = build(OFFICIAL, [], { overrides: [{ en: '10', zh: '十个', mode: 'force', dir: 'both' }] })
    const r = g.apply('⟦0⟧Rifter ⟦10⟧ 10 ⟦1⟧', 'en2zh')
    expect(r.text).toBe('⟦0⟧⟦G0⟧ ⟦10⟧ ⟦G1⟧ ⟦1⟧')
    expect(r.tokens).toEqual([{ token: '⟦G0⟧', value: '裂谷级' }, { token: '⟦G1⟧', value: '十个' }])
  })
})

describe('黑话表和 overrides', () => {
  const slang: SlangEntry[] = [
    { en: 'FC', zh: '指挥', mode: 'force', dir: 'both', en_aliases: ['fleet commander'], zh_aliases: ['舰队指挥'] },
    { en: 'stratop', zh: '战略行动', mode: 'force', dir: 'both', en_aliases: ['strat op'], zh_aliases: ['战略集结'] },
    { en: 'CTA', zh: 'CTA', mode: 'keep', dir: 'both', en_aliases: ['call to arms'], zh_aliases: ['全员集结'] },
    { en: 'x up', zh: '打X', mode: 'force', dir: 'both', en_aliases: ['X up', 'xup'] },
    { en: 'form up', zh: '集结', mode: 'hint', dir: 'en2zh' },
    { en: 'burn home', zh: '回家', mode: 'force', dir: 'en2zh' },
  ]
  const { glossary, warnings } = build(OFFICIAL, slang)

  it('没有警告', () => expect(warnings).toEqual([]))

  it('`FC` 只匹配大写（也允许复数）', () => {
    expect(glossary.apply('ask the fc', 'en2zh').tokens).toEqual([])
    expect(glossary.apply('ask the Fc', 'en2zh').tokens).toEqual([])
    expect(glossary.apply('ask the FC', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '指挥' }])
    expect(glossary.apply('two FCs', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '指挥' }])
    expect(glossary.apply('FCS', 'en2zh').tokens).toEqual([])
  })

  it('别名只用于来源侧，输出一律是标准写法', () => {
    expect(glossary.apply('strat op tonight', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '战略行动' }])
    expect(glossary.apply('Fleet Commander says hi', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '指挥' }])
    expect(glossary.apply('今晚战略集结', 'zh2en').tokens).toEqual([{ token: '⟦G0⟧', value: 'stratop' }])
    expect(glossary.apply('找舰队指挥', 'zh2en').tokens).toEqual([{ token: '⟦G0⟧', value: 'FC' }])
  })

  it('`x up` / `X up`（字母不超过 3 个，大小写一致；X up 靠别名）', () => {
    expect(glossary.apply('x up for fleet', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '打X' }])
    expect(glossary.apply('X up for fleet', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '打X' }])
    expect(glossary.apply('X UP for fleet', 'en2zh').tokens).toEqual([])
    const { glossary: noAlias } = build([], [{ en: 'x up', zh: '打X', mode: 'force', dir: 'both' }])
    expect(noAlias.apply('X up', 'en2zh').tokens).toEqual([])
    expect(noAlias.apply('pls x up', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '打X' }])
  })

  it('keep 还原成原文写法', () => {
    const r = glossary.apply('Call To Arms now, CTA!', 'en2zh')
    expect(r.text).toBe('⟦G0⟧ now, ⟦G1⟧!')
    expect(r.tokens).toEqual([{ token: '⟦G0⟧', value: 'Call To Arms' }, { token: '⟦G1⟧', value: 'CTA' }])
    const z = glossary.apply('明天全员集结', 'zh2en')
    expect(restore(z.text, z.tokens)).toBe('明天全员集结')
  })

  it('force 输出标准写法；hint 不替换；dir 限定方向', () => {
    const r = glossary.apply('form up, then burn home', 'en2zh')
    expect(r.text).toBe('form up, then ⟦G0⟧')
    expect(r.tokens).toEqual([{ token: '⟦G0⟧', value: '回家' }])
    expect(r.hints).toEqual(['form up => 集结'])
    expect(glossary.apply('大家回家', 'zh2en').tokens).toEqual([])
  })

  it('优先级：overrides → 黑话表 → 官方物品 → 组别', () => {
    const entries: EveEntry[] = [
      { en: 'Sabre', zh: '军刀级', kind: 'type' },
      { en: 'Sabre', zh: '军刀组', kind: 'group' },
      { en: 'Rifter', zh: '裂谷级', kind: 'type' },
    ]
    const s: SlangEntry[] = [{ en: 'Rifter', zh: '黑话裂谷', mode: 'force', dir: 'both' }]
    const o = [{ en: 'Rifter', zh: '覆盖裂谷', mode: 'force' as const, dir: 'both' as const }]
    expect(build(entries).glossary.apply('Rifter', 'en2zh').tokens[0].value).toBe('裂谷级')
    expect(build(entries, s).glossary.apply('Rifter', 'en2zh').tokens[0].value).toBe('黑话裂谷')
    expect(build(entries, s, { overrides: o }).glossary.apply('Rifter', 'en2zh').tokens[0].value).toBe('覆盖裂谷')
    expect(build(entries).glossary.apply('Sabre', 'en2zh').tokens[0].value).toBe('军刀级')
  })

  it('黑话表的词条保持声明的 mode（常用词不降级），只受大小写规则限制', () => {
    const { glossary: g } = build([], [{ en: 'catch', zh: '抓住', mode: 'force', dir: 'en2zh' }])
    expect(g.apply('Catch him', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '抓住' }])
  })

  it('hint 去重、最多 30 行、按出现顺序', () => {
    const many: SlangEntry[] = Array.from({ length: 40 }, (_, i) => ({ en: `word${i}x`, zh: `词${i}`, mode: 'hint', dir: 'both' }))
    const { glossary: g } = build([], many)
    const text = many.map((e) => e.en).join(' ') + ' word0x word1x'
    const r = g.apply(text, 'en2zh')
    expect(r.hints.length).toBe(30)
    expect(new Set(r.hints).size).toBe(30)
    expect(r.hints[0]).toBe('word0x => 词0')
    expect(r.hints[29]).toBe('word29x => 词29')
    expect(g.apply('word3x word3x word3X', 'en2zh').hints).toEqual(['word3x => 词3'])
  })

  it('version：内容相同则相同，词条改变则改变', () => {
    const again = build(OFFICIAL, slang).glossary
    expect(again.version).toBe(glossary.version)
    expect(glossary.version).toMatch(/^[0-9a-f]{40}$/)
    const changed = build(OFFICIAL, [...slang.slice(0, -1), { ...slang[slang.length - 1], zh: '回城' }]).glossary
    expect(changed.version).not.toBe(glossary.version)
    expect(build(OFFICIAL, slang, { systemStyle: 'zh' }).glossary.version).not.toBe(glossary.version)
    expect(build(OFFICIAL.slice(1), slang).glossary.version).not.toBe(glossary.version)
  })
})

describe('parseSlangYaml 和校验', () => {
  it('YAML 写错 → 警告、不抛异常，术语表照常工作', () => {
    let parsed!: ReturnType<typeof parseSlangYaml>
    expect(() => { parsed = parseSlangYaml('- en: "FC\n  zh: [指挥\n  mode: : force') }).not.toThrow()
    expect(parsed.entries).toEqual([])
    expect(parsed.warnings.length).toBe(1)
    expect(parsed.warnings[0]).toContain('YAML')
    const { glossary, warnings } = build(OFFICIAL, parsed.entries)
    expect(warnings).toEqual([])
    expect(glossary.apply('Rifter', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '裂谷级' }])
  })

  it('最外层不是列表 → 警告；空文件 → 没有警告', () => {
    expect(parseSlangYaml('en: FC').warnings.length).toBe(1)
    expect(parseSlangYaml('').warnings).toEqual([])
    expect(parseSlangYaml('# 只有注释\n').entries).toEqual([])
  })

  it('无效的 mode / dir、缺少 en / zh → 跳过这条并警告，其余照常', () => {
    const { entries, warnings } = parseSlangYaml([
      '- { en: good one, zh: 好的, mode: force, dir: both, category: x, note: y, confidence: 0.5 }',
      '- { en: bad mode, zh: 坏, mode: replace, dir: both }',
      '- { en: bad dir, zh: 坏, mode: force, dir: d2q }',
      '- { en: no zh, mode: force, dir: both }',
      '- just a string',
    ].join('\n'))
    expect(entries).toEqual([{ en: 'good one', zh: '好的', mode: 'force', dir: 'both' }])
    expect(warnings.length).toBe(4)
    expect(warnings.join('\n')).toMatch(/mode 无效[\s\S]*dir 无效[\s\S]*缺少 en 或 zh/)
  })

  it('overrides 里无效的 mode / dir 也跳过并警告', () => {
    const { glossary, warnings } = build([], [], {
      overrides: [
        { en: 'bad', zh: '坏的', mode: 'nope' as never, dir: 'both' },
        { en: 'worse', zh: '更坏', mode: 'force', dir: 'sideways' as never },
        { en: 'fine', zh: '好的', mode: 'force', dir: 'both' },
      ],
    })
    expect(warnings.length).toBe(2)
    expect(glossary.size).toBe(1)
  })

  it('1 个字的别名被丢弃并警告；1 个字的词条被跳过', () => {
    const { entries, warnings: parseWarnings } = parseSlangYaml([
      '- en: stratop',
      '  zh: 战略行动',
      '  mode: force',
      '  dir: both',
      '  en_aliases: ["s", "strat op"]',
      '  zh_aliases: ["战", "战略集结"]',
      '- { en: x, zh: 叉, mode: force, dir: both }',
    ].join('\n'))
    expect(parseWarnings).toEqual([])
    const { glossary, warnings } = build([], entries)
    expect(warnings.length).toBe(3)
    expect(warnings.some((w) => w.includes('「s」'))).toBe(true)
    expect(warnings.some((w) => w.includes('「战」'))).toBe(true)
    expect(glossary.apply('战 s x 叉', 'zh2en').tokens).toEqual([])
    expect(glossary.apply('战 s x 叉', 'en2zh').tokens).toEqual([])
    expect(glossary.apply('战略集结', 'zh2en').tokens).toEqual([{ token: '⟦G0⟧', value: 'stratop' }])
  })

  it('示例文件 data/eve-slang.example.yaml 没有警告', () => {
    const text = readFileSync(resolve(__dirname, '../data/eve-slang.example.yaml'), 'utf8')
    const { entries, warnings } = parseSlangYaml(text)
    expect(warnings).toEqual([])
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(entries.length).toBeLessThanOrEqual(5)
    expect(new Set(entries.map((e) => e.mode))).toEqual(new Set(['keep', 'force', 'hint']))
    expect(build([], entries).warnings).toEqual([])
  })

  it.skipIf(!process.env.SLANG_FILE)('本地检查：SLANG_FILE 指向的黑话表没有任何警告', () => {
    const { entries, warnings } = parseSlangYaml(readFileSync(process.env.SLANG_FILE!, 'utf8'))
    expect(warnings).toEqual([])
    expect(entries.length).toBeGreaterThan(0)
    const built = buildGlossary(opts(), { eveData: loadEveData(), slang: entries, commonWords: loadCommonWords() })
    expect(built.warnings).toEqual([])
  })
})

describe('数据文件', () => {
  it('loadCommonWords：读到 SCOWL 词表，忽略 # 注释行', () => {
    const words = loadCommonWords()
    expect(words.size).toBeGreaterThan(30000)
    for (const w of ['catch', 'cache', 'stain', 'fade', 'branch', 'domain', 'delve']) expect(words.has(w)).toBe(true)
    expect([...words].some((w) => w.startsWith('#'))).toBe(false)
    expect(words.has('jita')).toBe(false)
  })

  it('loadEveData：没有文件或格式不对时为 null，否则是 { buildNumber, entries }', () => {
    const data = loadEveData()
    if (data) {
      expect(typeof data.buildNumber).toBe('number')
      expect(Array.isArray(data.entries)).toBe(true)
    } else {
      expect(data).toBeNull()
    }
  })
})

describe('性能', () => {
  it('1.3 万条官方词条，300 字的文字 apply 1000 次在 1 秒内', () => {
    const syllables = ['ka', 'ro', 'mi', 'ven', 'tor', 'ash', 'el', 'dun', 'qua', 'zi', 'por', 'lex']
    const zhChars = '裂谷鹰级恐鸟响尾蛇军刀凡晶吉他卡奇木本跃迁扰断器重型导弹发射中小大型护盾装甲'
    const entries: EveEntry[] = []
    for (let i = 0; i < 13000; i++) {
      const a = syllables[i % 12], b = syllables[Math.floor(i / 12) % 12], c = syllables[Math.floor(i / 144) % 12]
      const words = i % 3 === 0 ? `${a}${b} ${c}${a} ${i % 7 ? 'II' : 'I'}` : `${a}${b}${c}${i}`
      const zh = zhChars[i % zhChars.length] + zhChars[(i * 7) % zhChars.length] + zhChars[(i * 13) % zhChars.length] + i
      entries.push({ en: words[0].toUpperCase() + words.slice(1), zh, kind: i % 10 === 0 ? 'system' : 'type' })
    }
    const t0 = performance.now()
    const { glossary } = buildGlossary(opts(), { eveData: eve(entries), slang: [], commonWords: loadCommonWords() })
    const buildMs = performance.now() - t0
    const en = ('Karo miven II and Rifter fleet form up in Jita, bring ' + entries[5].en + ' plus the ⟦0⟧ tackle. ').repeat(5).slice(0, 300)
    const zh = ('今晚在吉他集合，带上' + entries[7].zh + '和裂谷级，⟦0⟧ 记得打X，重型导弹发射器也行。').repeat(10).slice(0, 300)
    const t1 = performance.now()
    let n = 0
    for (let i = 0; i < 500; i++) {
      n += glossary.apply(en, 'en2zh').tokens.length
      n += glossary.apply(zh, 'zh2en').tokens.length
    }
    const applyMs = performance.now() - t1
    console.log(`glossary perf: build ${buildMs.toFixed(0)} ms for ${glossary.size} entries; 1000 applies (300 chars) ${applyMs.toFixed(0)} ms`)
    expect(n).toBeGreaterThan(0)
    expect(applyMs).toBeLessThan(1000)
  })
})
