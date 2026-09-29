import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import yazl from 'yazl'

const run = promisify(execFile)
const root = resolve(__dirname, '..')
const script = join(root, 'scripts/build-eve-glossary.mjs')

type Entry = { en: string; zh: string; kind: string }
const nm = (en: string, zh?: string) => ({ name: zh === undefined ? { en } : { en, zh, de: `${en} (de)` } })
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

const files: Record<string, object[]> = {
  '_sde.jsonl': [{ _key: 'sde', buildNumber: 1234567, releaseDate: '2026-01-01T00:00:00Z' }],
  'categories.jsonl': [
    { _key: 6, published: true, ...nm('Ship', '舰船') },
    { _key: 7, published: true, ...nm('Module', '装备') },
    { _key: 9, published: true, ...nm('Blueprint', '蓝图') },
    { _key: 16, published: true, ...nm('Skill', '技能') },
    { _key: 30, published: true, ...nm('Apparel', '服饰') },
    { _key: 63, published: true, ...nm('Special Edition Assets', '特别版用品') },
    { _key: 91, published: true, ...nm('SKINs', '涂装') },
    { _key: 2118, published: true, ...nm('Personalization', '个性化定制') },
    { _key: 2, published: true, ...nm('Celestial', '天体') }, // 收录类别，但不在物品类别列表里
    { _key: 3, published: false, ...nm('Station', '空间站') }, // 未发布
    { _key: 5, published: true, ...nm('Same', 'Same') }, // 中英相同
  ],
  'groups.jsonl': [
    { _key: 25, categoryID: 6, published: true, ...nm('  Frigate ', ' 护卫舰 ') }, // 修剪空白
    { _key: 26, categoryID: 7, published: true, ...nm('Shield Booster', '护盾回充增量器') },
    { _key: 27, categoryID: 6, published: false, ...nm('Hidden Group', '隐藏组') },
    { _key: 105, categoryID: 9, published: true, ...nm('Frigate Blueprint', '护卫舰蓝图') },
    { _key: 1950, categoryID: 91, published: true, ...nm('Rifter SKINs', '裂谷级涂装') },
    { _key: 4000, categoryID: 2118, published: true, ...nm('Ship Emblems', '舰船徽章') },
    { _key: 10, categoryID: 2, published: true, ...nm('Sun', '恒星') },
    { _key: 11, categoryID: 6, published: true, ...nm('Shuttle') }, // 缺中文
  ],
  'types.jsonl': [
    { _key: 587, groupID: 25, marketGroupID: 64, published: true, ...nm('Rifter', '裂谷级') },
    { _key: 588, groupID: 25, published: true, ...nm('Reaper', '收割者级') }, // 没有 marketGroupID
    { _key: 589, groupID: 25, marketGroupID: 64, published: false, ...nm('Unpublished Ship', '未发布舰船') },
    { _key: 590, groupID: 26, marketGroupID: 1, published: true, ...nm('Small Shield Booster I', '小型护盾回充增量器 I') },
    { _key: 591, groupID: 26, marketGroupID: 1, published: true, ...nm('ECM', 'ECM') }, // 中英相同
    { _key: 691, groupID: 105, marketGroupID: 2, published: true, ...nm('Rifter Blueprint', '裂谷级蓝图') },
    { _key: 692, groupID: 1950, marketGroupID: 3, published: true, ...nm('Rifter Red SKIN', '裂谷级红色涂装') },
    { _key: 693, groupID: 4000, marketGroupID: 4, published: true, ...nm('Emblem', '徽章') },
    { _key: 694, groupID: 10, marketGroupID: 5, published: true, ...nm('Sun G5 (Yellow)', '恒星 G5（黄色）') },
    { _key: 695, groupID: 999, marketGroupID: 5, published: true, ...nm('Orphan', '孤儿') }, // 未知组别
    { _key: 587, groupID: 25, marketGroupID: 64, published: true, ...nm('Rifter', '裂谷级') }, // 完全重复
  ],
  'mapRegions.jsonl': [
    { _key: 10000002, ...nm('The Forge', '伏尔戈') },
    { _key: 10000060, ...nm('Delve', '绝地之域') },
    { _key: 11000001, ...nm('A-R00001', 'A-R00001') },
    { _key: 11000002, ...nm('Wormhole Region', '虫洞星域') },
    { _key: 12000001, ...nm('ADR01', '深渊01') },
  ],
  'mapConstellations.jsonl': [
    { _key: 20000020, regionID: 10000002, ...nm('Kimotoro', '木本') },
    { _key: 20000700, regionID: 10000060, ...nm('1P-VL2', '1P-VL2 星座') }, // 代号
    { _key: 21000001, regionID: 11000001, ...nm('A-C00311', 'A-C00311 中文') },
    { _key: 21000002, regionID: 11000001, ...nm('WH Constellation', '虫洞星座') },
    { _key: 20000999, regionID: 11000002, ...nm('Odd Constellation', '奇怪星座') }, // 按 regionID 排除
  ],
  'mapSolarSystems.jsonl': [
    { _key: 30000142, regionID: 10000002, constellationID: 20000020, ...nm('Jita', '吉他') },
    { _key: 30000144, regionID: 10000002, constellationID: 20000020, ...nm('Perimeter', '皮尔米特') },
    { _key: 30004759, regionID: 10000060, constellationID: 20000700, ...nm('1DQ1-A', '1DQ1-A 错误中文') },
    { _key: 30004760, regionID: 10000060, constellationID: 20000700, ...nm('T5ZI-S', 'T5ZI-S') },
    { _key: 31000005, regionID: 11000001, constellationID: 21000001, ...nm('J123456', 'J123456 中文') },
    { _key: 31000006, regionID: 11000002, constellationID: 21000002, ...nm('Thera', '席拉') }, // 虫洞里的有名星系
    { _key: 30000999, regionID: 10000002, constellationID: 20000020, ...nm('Samename', 'Samename') },
  ],
}

let dir: string
let zipPath: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eve-glossary-test-'))
  zipPath = join(dir, 'sde.zip')
  const zip = new yazl.ZipFile()
  for (const [name, rows] of Object.entries(files)) zip.addBuffer(Buffer.from(jsonl(rows)), name)
  zip.addBuffer(Buffer.from('{"_key":1}\n'), 'unrelated.jsonl')
  zip.end()
  await new Promise<void>((ok, fail) => {
    const out = createWriteStream(zipPath)
    out.on('close', () => ok())
    out.on('error', fail)
    zip.outputStream.pipe(out)
  })
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('scripts/build-eve-glossary.mjs', () => {
  it('applies every include/exclude rule to a synthetic SDE zip', async () => {
    const outPath = join(dir, 'nested', 'out.json')
    const { stdout } = await run(process.execPath, [script, '--zip', zipPath, '--out', outPath], { cwd: root })
    expect(stdout).toContain('2118\tPersonalization')

    const text = readFileSync(outPath, 'utf8')
    const data = JSON.parse(text) as { buildNumber: number; generatedAt: string; entries: Entry[] }
    expect(data.buildNumber).toBe(1234567)
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false)
    // 紧凑格式：每条一行，没有缩进
    expect(text.split('\n').length).toBe(data.entries.length + 3)
    expect(text).not.toMatch(/\n\s+\{/)

    expect(data.entries).toEqual([
      { en: 'Rifter', zh: '裂谷级', kind: 'type' },
      { en: 'Small Shield Booster I', zh: '小型护盾回充增量器 I', kind: 'type' },
      { en: 'Frigate', zh: '护卫舰', kind: 'group' },
      { en: 'Shield Booster', zh: '护盾回充增量器', kind: 'group' },
      { en: 'Sun', zh: '恒星', kind: 'group' },
      { en: 'Celestial', zh: '天体', kind: 'category' },
      { en: 'Module', zh: '装备', kind: 'category' },
      { en: 'Ship', zh: '舰船', kind: 'category' },
      { en: 'Jita', zh: '吉他', kind: 'system' },
      { en: 'Perimeter', zh: '皮尔米特', kind: 'system' },
      { en: 'Delve', zh: '绝地之域', kind: 'region' },
      { en: 'The Forge', zh: '伏尔戈', kind: 'region' },
      { en: 'Kimotoro', zh: '木本', kind: 'constellation' },
    ])
  })

  it('fails with a clear error when the zip lacks a required file', async () => {
    const bad = join(dir, 'bad.zip')
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(jsonl(files['_sde.jsonl'])), '_sde.jsonl')
    zip.end()
    await new Promise<void>((ok, fail) => {
      const out = createWriteStream(bad)
      out.on('close', () => ok())
      out.on('error', fail)
      zip.outputStream.pipe(out)
    })
    await expect(run(process.execPath, [script, '--zip', bad, '--out', join(dir, 'bad.json')], { cwd: root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('categories.jsonl') })
    expect(existsSync(join(dir, 'bad.json'))).toBe(false)
  })
})

describe('data/eve-glossary.json', () => {
  const file = join(root, 'data/eve-glossary.json')

  it('exists, parses and contains known official names', () => {
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf8')) as { buildNumber: number; generatedAt: string; entries: Entry[] }
    expect(Number.isInteger(data.buildNumber)).toBe(true)
    expect(data.buildNumber).toBeGreaterThan(0)
    expect(data.entries.length).toBeGreaterThan(10000)
    const has = (en: string, zh: string, kind: string) =>
      data.entries.some((e) => e.en === en && e.zh === zh && e.kind === kind)
    expect(has('Rifter', '裂谷级', 'type')).toBe(true)
    expect(has('Jita', '吉他', 'system')).toBe(true)
    expect(has('The Forge', '伏尔戈', 'region')).toBe(true)
    expect(has('Frigate', '护卫舰', 'group')).toBe(true)
  })

  it('excludes code-named and wormhole systems, SKINs and blueprints', () => {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { entries: Entry[] }
    const kinds = new Set(['type', 'group', 'category', 'system', 'region', 'constellation'])
    for (const e of data.entries) {
      expect(kinds.has(e.kind)).toBe(true)
      expect(e.en).toBe(e.en.trim())
      expect(e.zh).toBe(e.zh.trim())
      expect(e.en).not.toBe(e.zh)
    }
    const en = new Set(data.entries.map((e) => e.en))
    expect(en.has('1DQ1-A')).toBe(false)
    expect(data.entries.some((e) => /^[A-Z0-9]{1,5}-[A-Z0-9]{1,5}$/.test(e.en))).toBe(false)
    expect(data.entries.some((e) => /^J\d{6}$/.test(e.en))).toBe(false)
    expect(data.entries.some((e) => e.kind === 'type' && / (Blueprint|SKIN)$/.test(e.en))).toBe(false)
    expect(en.has('Blueprint')).toBe(false)
    expect(en.has('SKINs')).toBe(false)
  })
})
