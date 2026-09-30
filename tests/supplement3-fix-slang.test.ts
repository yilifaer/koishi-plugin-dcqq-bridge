// 0.3.1 补充：T5（-k 常用词提醒）、T6（纠错去掉多打的尖括号）、T8（多个黑话表文件）。
// 所有 ID、名字、词条、文件名都是编造的。

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIX_USAGE, fixArgText, parseFixText, stripWrapper } from '../src/fixes'
import { mergeSlangFiles, splitSlangPaths } from '../src/glossary'
import { Env, OWNER_QQ, PR2_DEFAULTS, qqPayload, setup, sleep } from './harness'

let env: Env | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function ownerSays(e: Env, t: string): Promise<string[]> {
  const before = e.qq.sent.length
  await e.qqMessage(qqPayload([{ type: 'text', data: { text: t } }], { user_id: +OWNER_QQ, sender: { user_id: +OWNER_QQ, nickname: '所有者', card: '所有者', role: 'owner' } }))
  await sleep(200)
  await e.idle()
  return e.qq.sent.slice(before).map((s) => s.text)
}

const rows = (e: Env) => e.app.database.get('dcqqbridge_glossary', {})

// ================================================================== T5

describe('T5 纠错 -k 常用词', () => {
  it('英译中原样保留常用词：照样加上，提醒普通句子里的这个词也不会被翻译', async () => {
    env = await setup()
    const replies = await ownerSays(env, '纠错 -k fleet')
    expect(replies[0]).toContain('已添加：fleet（原样保留，英译中）')
    expect(replies[0]).toContain('⚠ fleet 是常用词，原样保留后普通句子里的 fleet 也不会被翻译')
    expect(await rows(env)).toHaveLength(1)
  })

  it('不是常用词、或中译英：不提醒', async () => {
    env = await setup()
    expect((await ownerSays(env, '纠错 -k Quiet Lantern'))[0]).not.toContain('常用词')
    expect((await ownerSays(env, '纠错 -k 老板'))[0]).not.toContain('常用词')
  })
})

// ================================================================== T6

describe('T6 纠错去掉多打的尖括号', () => {
  it('原文、译法被一对 <…>、〈…〉、《…》 整个包住时去掉', () => {
    expect(parseFixText('<afk cloaker> = <墩子>')).toEqual({ kind: 'add', mode: 'force', src: 'afk cloaker', dst: '墩子', dir: 'en2zh' })
    expect(parseFixText('〈全员集结〉 = 《CTA》')).toMatchObject({ kind: 'add', src: '全员集结', dst: 'CTA', dir: 'zh2en' })
    expect(parseFixText('-h <cyno> = 诱导')).toMatchObject({ kind: 'add', mode: 'hint', src: 'cyno', dst: '诱导' })
    expect(parseFixText('-k <Quiet Lantern>')).toMatchObject({ kind: 'add', mode: 'keep', src: 'Quiet Lantern', dst: 'Quiet Lantern' })
    expect(parseFixText('删除 <afk cloaker>')).toEqual({ kind: 'delete', src: 'afk cloaker' })
    // 只去掉整个包住的一对
    expect(stripWrapper('<a> b <c>')).toBe('<a> b <c>')
    expect(stripWrapper('a <b>')).toBe('a <b>')
    expect(stripWrapper(' 《墩子》 ')).toBe('墩子')
  })

  it('会解析标签的平台（沙盒）：<afk cloaker> 到命令这里已经是元素，写回尖括号再解析', () => {
    expect(fixArgText('删除 <afk cloaker>')).toBe('删除 <afk cloaker>')
    expect(parseFixText(fixArgText('删除 <afk cloaker>'))).toEqual({ kind: 'delete', src: 'afk cloaker' })
    expect(parseFixText(fixArgText('<afk cloaker> = <墩子>'))).toMatchObject({ kind: 'add', src: 'afk cloaker', dst: '墩子' })
    // 转义过的尖括号、普通的消息元素照旧
    expect(fixArgText('删除 &lt;afk cloaker&gt;')).toBe('删除 <afk cloaker>')
    expect(fixArgText('<at id="20001"/>standing fleet = 值守舰队')).toBe('standing fleet = 值守舰队')
    expect(fixArgText('<b>fleet</b> = 舰队')).toBe('fleet = 舰队')
  })

  it('QQ 群里：带尖括号加进去的词条能匹配，也能带尖括号删掉', async () => {
    env = await setup()
    expect(await ownerSays(env, '纠错 <afk cloaker> = <墩子>')).toEqual(['已添加：afk cloaker → 墩子（强制替换，英译中）'])
    expect(env.relay.translation.glossary!.apply('watch the afk cloaker', 'en2zh').tokens.map((t) => t.value)).toEqual(['墩子'])
    expect(await ownerSays(env, '纠错 删除 <afk cloaker>')).toEqual(['已删除：afk cloaker → 墩子（强制替换，英译中）'])
    expect(await rows(env)).toHaveLength(0)
  })

  it('用法说明里不再用尖括号，并带一行例子', async () => {
    expect(FIX_USAGE).not.toMatch(/[<>]/)
    expect(FIX_USAGE).toContain('纠错 原文 = 译法')
    expect(FIX_USAGE).toContain('例如：纠错 standing fleet = 值守舰队')
  })
})

// ================================================================== T8

describe('T8 多个黑话表文件', () => {
  it('路径用 ;; 分隔；后面文件里同一个原文（en 不区分大小写，或 zh）覆盖前面的', () => {
    expect(splitSlangPaths(' a.yaml ;; b.yaml;;')).toEqual(['a.yaml', 'b.yaml'])
    expect(splitSlangPaths('only.yaml')).toEqual(['only.yaml'])
    expect(splitSlangPaths('')).toEqual([])
    const merged = mergeSlangFiles([
      { path: 'x/glossary.yaml', entries: [
        { en: 'Stratop', zh: '战略行动', mode: 'force', dir: 'both' },
        { en: 'logi', zh: '后勤', mode: 'hint', dir: 'en2zh' },
        { en: 'bubble', zh: '泡泡', mode: 'force', dir: 'both' },
      ], warnings: [] },
      { path: 'y/local-slang.yaml', entries: [
        { en: 'stratop', zh: '大行动', mode: 'force', dir: 'both' },
        { en: 'bubbles', zh: '泡泡', mode: 'hint', dir: 'both' },
      ], warnings: [] },
    ])
    expect(merged.entries.map((e) => `${e.en}=${e.zh}`)).toEqual(['logi=后勤', 'stratop=大行动', 'bubbles=泡泡'])
    expect(merged.where).toEqual(['黑话表 glossary.yaml 第 2 条', '黑话表 local-slang.yaml 第 1 条', '黑话表 local-slang.yaml 第 2 条'])
    expect(merged.summary).toEqual([
      { path: 'x/glossary.yaml', name: 'glossary.yaml', count: 3, replaced: 0 },
      { path: 'y/local-slang.yaml', name: 'local-slang.yaml', count: 2, replaced: 2 },
    ])
  })

  it('只有一个文件：和以前一样（同一个文件里的重复不合并，警告位置写「黑话表第 N 条」）', () => {
    const entries = [
      { en: 'cta', zh: '全员集结', mode: 'force' as const, dir: 'both' as const },
      { en: 'CTA', zh: '集结', mode: 'force' as const, dir: 'both' as const },
    ]
    const merged = mergeSlangFiles([{ path: 'glossary.yaml', entries, warnings: [] }])
    expect(merged.entries).toEqual(entries)
    expect(merged.where).toEqual(['黑话表第 1 条', '黑话表第 2 条'])
  })

  it('两个文件有同一个原文：以后一个为准；bridge.reload 按文件列出条数', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-slang-multi-'))
    await writeFile(join(dir, 'glossary.yaml'), [
      '- { en: "stratop", zh: "战略行动", mode: force, dir: both }',
      '- { en: "logi", zh: "后勤", mode: force, dir: en2zh }',
      '- { en: "tackle", zh: "拦截", mode: force, dir: en2zh }',
    ].join('\n'), 'utf8')
    await writeFile(join(dir, 'local-slang.yaml'), '- { en: "Stratop", zh: "大行动", mode: force, dir: both }\n', 'utf8')
    env = await setup({ glossary: { ...PR2_DEFAULTS.glossary, slangFile: `${join(dir, 'glossary.yaml')};;${join(dir, 'local-slang.yaml')}` } })
    const g = env.relay.translation.glossary!
    expect(g.apply('stratop tonight', 'en2zh').tokens.map((t) => t.value)).toEqual(['大行动'])
    expect(g.apply('明天大行动', 'zh2en').tokens.map((t) => t.value)).toEqual(['Stratop'])
    expect(g.apply('明天战略行动', 'zh2en').tokens).toEqual([])
    expect(g.apply('need logi', 'en2zh').tokens.map((t) => t.value)).toEqual(['后勤'])
    const reply = (await env.command(OWNER_QQ, 'bridge.reload')).join('\n')
    expect(reply).toContain('黑话表：glossary.yaml 3 条，local-slang.yaml 1 条（覆盖前面文件里的 1 条）')
  })

  it('其中一个文件缺失或写错：只提示这个文件，其他文件照常生效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-slang-multi-'))
    await writeFile(join(dir, 'glossary.yaml'), '- { en: "stratop", zh: "战略行动", mode: force, dir: both }\n', 'utf8')
    await writeFile(join(dir, 'broken.yaml'), '- en: "CTA\n  zh: [broken', 'utf8')
    const missing = join(dir, 'local-slang.yaml')
    env = await setup({ glossary: { ...PR2_DEFAULTS.glossary, slangFile: `${missing};;${join(dir, 'glossary.yaml')};;${join(dir, 'broken.yaml')}` } })
    expect(env.relay.translation.glossary!.apply('stratop tonight', 'en2zh').tokens.map((t) => t.value)).toEqual(['战略行动'])
    const problems = env.relay.translation.problems
    expect(problems).toContain(`黑话表文件读不到：${missing}（ENOENT）`)
    expect(problems.some((p) => p.startsWith(`黑话表 ${join(dir, 'broken.yaml')}：`) && p.includes('这个文件当作空的'))).toBe(true)
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('local-slang.yaml（ENOENT）')
    const reply = (await env.command(OWNER_QQ, 'bridge.reload')).join('\n')
    expect(reply).toContain('黑话表：local-slang.yaml 读不到，glossary.yaml 1 条，broken.yaml 0 条')
  })

  it('只填一个路径：提示和以前完全一样', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-slang-one-'))
    await writeFile(join(dir, 'glossary.yaml'), '- en: "CTA\n  zh: [broken', 'utf8')
    env = await setup({ glossary: { ...PR2_DEFAULTS.glossary, slangFile: join(dir, 'glossary.yaml') } })
    expect(env.relay.translation.problems.some((p) => p.startsWith('黑话表：黑话表 YAML 解析失败，当作没有黑话表'))).toBe(true)
  })
})
