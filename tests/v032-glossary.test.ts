import { describe, expect, it } from 'vitest'
import {
  buildGlossary, loadCommonWords, loadEveData, mergeSlangFiles, structureTypeNames,
  type EveData, type EveEntry, type SlangEntry,
} from '../src/glossary'

// 0.3.2 术语表：U1（多个黑话表按方向判断同一个原文）、U4（船名不带「级」）、U5（2 个字的组别、类别名）、U6 准备（建筑类型名）

const eve = (entries: EveEntry[]): EveData => ({ buildNumber: 1, generatedAt: '2026-09-30T00:00:00Z', entries })
const build = (entries: EveEntry[], slang: SlangEntry[] = [], eveOn = true) =>
  buildGlossary({ eve: eveOn, systemStyle: 'en(zh)', overrides: [] }, { eveData: eve(entries), slang, commonWords: new Set() })
const restore = (text: string, tokens: Array<{ token: string; value: string }>) =>
  tokens.reduce((t, { token, value }) => t.replace(token, value), text)
const zh2en = (g: ReturnType<typeof build>['glossary'], text: string) => {
  const r = g.apply(text, 'zh2en')
  return { text: restore(r.text, r.tokens), hints: r.hints, tokens: r.tokens }
}

// ================================================================== U1

describe('U1 多个黑话表：同一个原文按方向判断', () => {
  const file = (path: string, entries: SlangEntry[]) => ({ path, entries, warnings: [] })

  it('只覆盖 logistics 时，共用中文「后勤」的 logi 仍然在', () => {
    const merged = mergeSlangFiles([
      file('glossary.yaml', [
        { en: 'logi', zh: '后勤', mode: 'force', dir: 'en2zh' },
        { en: 'logistics', zh: '后勤', mode: 'hint', dir: 'en2zh' },
      ]),
      file('local-slang.yaml', [{ en: 'logistics', zh: '后勤', mode: 'force', dir: 'en2zh' }]),
    ])
    expect(merged.entries).toEqual([
      { en: 'logi', zh: '后勤', mode: 'force', dir: 'en2zh' },
      { en: 'logistics', zh: '后勤', mode: 'force', dir: 'en2zh' },
    ])
    expect(merged.summary[1].replaced).toBe(1)
    const g = buildGlossary({ eve: false, systemStyle: 'en(zh)', overrides: [] },
      { slang: merged.entries, slangWhere: merged.where, commonWords: new Set() }).glossary
    expect(g.apply('need logi', 'en2zh').tokens.map((t) => t.value)).toEqual(['后勤'])
    expect(g.apply('more logistics', 'en2zh').tokens.map((t) => t.value)).toEqual(['后勤'])
  })

  it('en2zh 比 en（不区分大小写），zh2en 比 zh；方向没有交集时互不影响', () => {
    const merged = mergeSlangFiles([
      file('a.yaml', [
        { en: 'Logi', zh: '后勤', mode: 'hint', dir: 'en2zh' },
        { en: 'jump bridge', zh: '跳桥', mode: 'force', dir: 'zh2en' },
        { en: 'null', zh: '00', mode: 'force', dir: 'en2zh' },
      ]),
      file('b.yaml', [
        { en: 'logi', zh: '奶', mode: 'force', dir: 'en2zh' }, // en 相同 → 覆盖
        { en: 'ansi', zh: '跳桥', mode: 'force', dir: 'zh2en' }, // zh 相同 → 覆盖
        { en: 'null', zh: '零零', mode: 'force', dir: 'zh2en' }, // 方向没有交集 → 不覆盖
      ]),
    ])
    expect(merged.entries.map((e) => `${e.en}=${e.zh}/${e.dir}`)).toEqual([
      'null=00/en2zh', 'logi=奶/en2zh', 'ansi=跳桥/zh2en', 'null=零零/zh2en',
    ])
    expect(merged.summary[1].replaced).toBe(2)
  })

  it('前面的 both 词条只被覆盖一个方向时，保留另一个方向', () => {
    const merged = mergeSlangFiles([
      file('a.yaml', [
        { en: 'logistics', zh: '后勤', mode: 'hint', dir: 'both', zh_aliases: ['后勤船'] },
        { en: 'jump bridge', zh: '跳桥', mode: 'force', dir: 'both' },
      ]),
      file('b.yaml', [
        { en: 'Logistics', zh: '后勤舰', mode: 'force', dir: 'en2zh' }, // 只覆盖英译中
        { en: 'ansi', zh: '跳桥', mode: 'force', dir: 'zh2en' }, // 只覆盖中译英
      ]),
    ])
    expect(merged.entries.map((e) => `${e.en}=${e.zh}/${e.dir}`)).toEqual([
      'logistics=后勤/zh2en', 'jump bridge=跳桥/en2zh', 'Logistics=后勤舰/en2zh', 'ansi=跳桥/zh2en',
    ])
    expect(merged.entries[0].zh_aliases).toEqual(['后勤船'])
    expect(merged.where[0]).toBe('黑话表 a.yaml 第 1 条')
    expect(merged.summary[1].replaced).toBe(2)
  })

  it('后面的 both 覆盖前面同一边相同的单向词条；两个 both 时 en 或 zh 相同就整条覆盖', () => {
    const merged = mergeSlangFiles([
      file('a.yaml', [
        { en: 'logi', zh: '后勤', mode: 'force', dir: 'en2zh' },
        { en: 'logistics', zh: '后勤', mode: 'hint', dir: 'zh2en' },
        { en: 'cyno', zh: '诱导', mode: 'force', dir: 'both' },
      ]),
      file('b.yaml', [
        { en: 'logistics', zh: '后勤', mode: 'force', dir: 'both' },
        { en: 'Cyno', zh: '诱导器', mode: 'force', dir: 'both' },
      ]),
    ])
    expect(merged.entries.map((e) => `${e.en}=${e.zh}/${e.dir}`)).toEqual([
      'logi=后勤/en2zh', 'logistics=后勤/both', 'Cyno=诱导器/both',
    ])
  })
})

// ================================================================== U4、U5

const SHIPS: EveEntry[] = [
  { en: 'Armageddon', zh: '末日沙场级', kind: 'type', cat: 'ship' },
  { en: 'Apocalypse', zh: '灾难级', kind: 'type', cat: 'ship' },
  { en: 'Cerberus', zh: '希尔博拉斯级', kind: 'type', cat: 'ship' },
  { en: 'Cybernetic Subprocessor - Basic', zh: '脑控次处理器—基础级', kind: 'type' },
  { en: 'Hawkling', zh: '鹰级', kind: 'type', cat: 'ship' },
  { en: 'Adrestia', zh: '复仇女神级', kind: 'type', cat: 'ship' },
  { en: 'Nemesis Statue', zh: '复仇女神', kind: 'type' }, // 和去掉「级」的写法重复（编造的）
  { en: 'Structure', zh: '建筑', kind: 'category' },
  { en: 'Miscellaneous', zh: '其他', kind: 'group' },
  { en: 'Frigate', zh: '护卫舰', kind: 'group' },
  { en: 'Veldspar', zh: '凡晶', kind: 'type' },
  { en: 'Jita', zh: '吉他', kind: 'system' },
]

describe('U4 舰船名不带「级」的写法', () => {
  it('3 个字及以上加中译英写法（模式和原词条一样）；2 个字、非舰船、和官方名称重复的不加', () => {
    const { glossary: g } = build(SHIPS)
    expect(zh2en(g, '末日沙场级来了').text).toBe('Armageddon来了')
    expect(zh2en(g, '末日沙场来了').text).toBe('Armageddon来了')
    expect(zh2en(g, '三条希尔博拉斯').text).toBe('三条Cerberus')
    // 2 个字：不加（灾难是普通词）；原来的「灾难级」照常
    expect(zh2en(g, '一场灾难').tokens).toEqual([])
    expect(zh2en(g, '一场灾难').hints).toEqual([])
    expect(zh2en(g, '灾难级').text).toBe('Apocalypse')
    // 不是舰船
    expect(zh2en(g, '脑控次处理器—基础').tokens).toEqual([])
    expect(zh2en(g, '脑控次处理器—基础级').text).toBe('Cybernetic Subprocessor - Basic')
    // 和别的官方名称重复：以那个官方名称为准
    expect(zh2en(g, '复仇女神').text).toBe('Nemesis Statue')
    expect(g.shipAliases).toBe(2)
  })

  it('和黑话表重复时不加，黑话表优先', () => {
    const slang: SlangEntry[] = [{ en: 'Geddon', zh: '末日沙场', mode: 'force', dir: 'zh2en' }]
    const { glossary: g } = build(SHIPS, slang)
    expect(zh2en(g, '末日沙场来了').text).toBe('Geddon来了')
    expect(zh2en(g, '末日沙场级来了').text).toBe('Armageddon来了')
    expect(g.shipAliases).toBe(1)
    // 黑话表的 zh_aliases 也算
    const alias: SlangEntry[] = [{ en: 'Cerb', zh: '三头狗', mode: 'force', dir: 'zh2en', zh_aliases: ['希尔博拉斯'] }]
    const g2 = build(SHIPS, alias).glossary
    expect(zh2en(g2, '希尔博拉斯').text).toBe('Cerb')
    expect(g2.shipAliases).toBe(1)
  })

  it('插件自带的官方表：末日沙场级有去掉「级」的写法，灾难级、脑控次处理器—基础级没有', () => {
    const data = loadEveData()!
    expect(data.entries.find((e) => e.zh === '末日沙场级')?.cat).toBe('ship')
    expect(data.entries.find((e) => e.zh === '脑控次处理器—基础级')?.cat).toBeUndefined()
    const { glossary: g } = buildGlossary({ eve: true, systemStyle: 'en(zh)', overrides: [] },
      { eveData: data, commonWords: loadCommonWords() })
    expect(zh2en(g, '末日沙场来了').text).toBe('Armageddon来了')
    expect(zh2en(g, '一场灾难').tokens).toEqual([])
    expect(zh2en(g, '脑控次处理器—基础').tokens.map((t) => t.value)).not.toContain('Cybernetic Subprocessor - Basic')
    expect(g.shipAliases).toBe(162)
  })
})

describe('U5 2 个字的组别、类别名不生成中译英', () => {
  it('「建筑」「其他」不再出现在中译英的参考里；物品、地名、3 个字的组别不受影响', () => {
    const { glossary: g } = build(SHIPS)
    expect(zh2en(g, '其他建筑都在').hints).toEqual([])
    expect(zh2en(g, '其他建筑都在').tokens).toEqual([])
    expect(zh2en(g, '凡晶在吉他').hints).toEqual(['Veldspar => 凡晶', 'Jita => 吉他'])
    expect(zh2en(g, '三条护卫舰').text).toBe('三条Frigate')
    // 英译中照旧
    expect(g.apply('the Structure is', 'en2zh').tokens.map((t) => t.value)).toEqual(['建筑'])
  })

  it('插件自带的官方表：建筑、其他没有中译英参考', () => {
    const { glossary: g } = buildGlossary({ eve: true, systemStyle: 'en(zh)', overrides: [] },
      { eveData: loadEveData(), commonWords: loadCommonWords() })
    const hints = zh2en(g, '其他建筑都在').hints
    expect(hints.some((h) => h.endsWith('=> 建筑') || h.endsWith('=> 其他'))).toBe(false)
  })
})

// ================================================================== U6 准备

describe('建筑类型名（给 U6 用）', () => {
  it('从官方表取建筑类（SDE 类别 65）的英文名，长的在前', () => {
    const names = structureTypeNames(loadEveData())
    for (const n of ['Astrahus', 'Fortizar', 'Keepstar', 'Raitaru', 'Azbel', 'Sotiyo', 'Athanor', 'Tatara',
      'Ansiblex Jump Bridge', 'Metenox Moon Drill']) expect(names).toContain(n)
    expect(names).not.toContain('Armageddon')
    expect(names).not.toContain('Astrahus Upwell Quantum Core')
    for (let i = 1; i < names.length; i++) expect(names[i - 1].length).toBeGreaterThanOrEqual(names[i].length)
    expect(structureTypeNames(null)).toEqual([])
  })

  it('Glossary.structureTypeNames()：官方表打开时有，关闭时是空列表', () => {
    const entries: EveEntry[] = [
      { en: 'Astrahus', zh: '空堡', kind: 'type', cat: 'structure' },
      { en: 'Fortizar', zh: '铁壁', kind: 'type', cat: 'structure' },
      { en: 'Rifter', zh: '裂谷级', kind: 'type', cat: 'ship' },
    ]
    expect(build(entries).glossary.structureTypeNames()).toEqual(['Astrahus', 'Fortizar'])
    expect(build(entries, [], false).glossary.structureTypeNames()).toEqual([])
  })
})
