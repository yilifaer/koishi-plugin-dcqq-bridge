// 0.4.1 补充清单 V1、V2、V4、V5、V6、V7、V8、V12：翻译、审核、群友名字这一侧。
// 翻译和审核用模拟服务器；名字、ID、群号全部是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from 'koishi'
import { normalizeSettings } from '../src/bridges'
import { Moderator } from '../src/filter'
import { Translator } from '../src/translate/client'
import { cardNames, ignoreSet, isTradeAd } from '../src/translate/names'
import { restore, stripTokens } from '../src/translate/protect'
import { skipReason } from '../src/translate/skip'
import { baseConfig, bridge, Env, OWNER_QQ, PR2_DEFAULTS, QQ_GROUP, qqPayload, setup } from './harness'

// 模拟 OpenAI 兼容服务器：翻译（可以排好每一次的回复）和审核（可以指定类别和分数）
class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []
  moderations: any[] = []
  /** 排好的译文：每次请求先用这里的，用完了才用 translate。 */
  queue: string[] = []
  translate: (text: string) => string = (text) => (/[一-鿿]/.test(text) ? `EN: ${text}` : `译：${text}`)
  /** 审核回复里的 results[0]。 */
  moderation: any = { flagged: false, categories: {}, category_scores: {} }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const reply = (body: unknown) => {
          if (res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.url?.endsWith('/moderations')) {
          this.moderations.push(json)
          return reply({ results: [this.moderation] })
        }
        this.chat.push(json)
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        const out = this.queue.length ? this.queue.shift()! : this.translate(text)
        reply({ choices: [{ message: { role: 'assistant', content: out } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  lastText() {
    const user = this.chat.at(-1)?.messages?.at(-1)?.content ?? ''
    return /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
  }
}

/** 收集 Koishi 日志；level 是日志级别上限（3 = debug，2 = info 及以上）。 */
function captureLogs(level = 3) {
  const records: Array<{ name: string; type: string; content: string }> = []
  const target = { levels: { base: level }, record: (r: any) => records.push({ name: r.name, type: r.type, content: r.content }) }
  Logger.targets.push(target as any)
  return {
    ours: () => records.filter((r) => r.name === 'dcqq-bridge'),
    missing: () => records.filter((r) => r.name === 'dcqq-bridge' && r.content.includes('没附译文')),
    stop: () => {
      const i = Logger.targets.indexOf(target as any)
      if (i >= 0) Logger.targets.splice(i, 1)
    },
  }
}

let env: Env | undefined
let llm: FakeLLM

beforeEach(async () => {
  llm = new FakeLLM()
  await llm.start()
})

afterEach(async () => {
  await env?.stop()
  env = undefined
  await llm.stop()
})

/** 打开翻译的桥；translate、filter、glossary 可以覆盖。 */
function on(patch: any = {}) {
  return {
    bridges: [bridge({ translate: true })],
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, ...patch.translate },
    filter: { ...PR2_DEFAULTS.filter, ...patch.filter },
    glossary: { ...PR2_DEFAULTS.glossary, ...patch.glossary },
  }
}

const outcome = (text: string, direction: 'en2zh' | 'zh2en' = 'en2zh') =>
  env!.relay.translation.translate({ translatable: text, protect: [] } as any, direction)

// ------------------------------------------------------------------ V1

describe('V1：被保护的内容放回时，和旁边的英文字母、数字之间补空格', () => {
  const r = (text: string, value: string) => restore(text, [{ token: '⟦0⟧', value }])

  it('tomorrow⟦0⟧（R-A）→ tomorrow R-A；at⟦0⟧（20:00）→ at 20:00；(⟦0⟧) 不变', () => {
    expect(r('tomorrow⟦0⟧', 'R-A')).toBe('tomorrow R-A')
    expect(r('at⟦0⟧', '20:00')).toBe('at 20:00')
    expect(r('(⟦0⟧)', 'R-A')).toBe('(R-A)')
  })

  it('右边紧挨着字母、数字也补；复数词尾 s/es 不补；汉字、标点旁边不补', () => {
    expect(r('⟦0⟧tomorrow', 'R-A')).toBe('R-A tomorrow')
    expect(r('x⟦0⟧y', '20:00')).toBe('x 20:00 y')
    expect(r('⟦0⟧s', 'R-A')).toBe('R-As')
    expect(r('⟦0⟧es.', 'R-A')).toBe('R-Aes.')
    expect(r('⟦0⟧est', 'R-A')).toBe('R-A est')
    expect(r('八点⟦0⟧集合', 'R-A')).toBe('八点R-A集合')
    expect(r('at ⟦0⟧, ok', 'R-A')).toBe('at R-A, ok')
  })

  it('放回的内容不是字母或数字开头（提及、符号）时不补；两个占位符紧挨着时保持原样', () => {
    expect(r('hi⟦0⟧', '@Pilot')).toBe('hi@Pilot')
    expect(restore('⟦0⟧⟦1⟧', [{ token: '⟦0⟧', value: 'R-A' }, { token: '⟦1⟧', value: '20:00' }])).toBe('R-A20:00')
  })

  it('网址仍按 U8 处理', () => {
    expect(restore('看⟦0⟧后面', [{ token: '⟦0⟧', value: 'https://example.com/a', url: true }])).toBe('看 https://example.com/a 后面')
    expect(restore('⟦0⟧tomorrow', [{ token: '⟦0⟧', value: 'https://example.com/a', url: true }])).toBe('https://example.com/a tomorrow')
    expect(restore('see (⟦0⟧).', [{ token: '⟦0⟧', value: 'https://example.com/a', url: true }])).toBe('see (https://example.com/a).')
  })

  it('接进转发：QQ「明天晚上八点R-A集合，带好后勤」，模型把占位符贴在 tomorrow 后面 → 译文里是 tomorrow R-A', async () => {
    env = await setup(on())
    llm.queue.push('Gather at 8 PM tomorrow⟦0⟧, bring logistics')
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '明天晚上八点R-A集合，带好后勤' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('明天晚上八点⟦0⟧集合，带好后勤')
    expect(env.discord.posts()[0].json.content).toBe('明天晚上八点R-A集合，带好后勤\n\n【机翻】 Gather at 8 PM tomorrow R-A, bring logistics')
  })
})

// ------------------------------------------------------------------ V2

describe('V2：名片里的交易广告和普通词不当作名字', () => {
  it('含「收」「售」「求购」「卖」或者以「出」开头的段是交易广告', () => {
    for (const ad of ['收天使', '60M收旗舰', '出售辟邪', '出门就有架打', '求购旗舰', '卖旗舰']) expect(isTradeAd(ad)).toBe(true)
    for (const name of ['小鱼干', '深空旅人', '星海漫游者']) expect(isTradeAd(name)).toBe(false)
  })

  it('名片 某某-收天使、某某-60M收旗舰、某某-出售辟邪 不产生名字；别的段照常', () => {
    expect(cardNames('某某-收天使')).toEqual([])
    expect(cardNames('某某-60M收旗舰')).toEqual([])
    expect(cardNames('某某-出售辟邪')).toEqual([])
    // 昵称那一段不受影响，只有广告那一段不收
    expect(cardNames('星海漫游者-收天使')).toEqual(['星海漫游者'])
    expect(cardNames('[ABC]深空旅人-60M收旗舰')).toEqual(['深空旅人'])
  })

  it('memberNameIgnore 里的词永远不当作名字（整段相同、不区分大小写）；别的段照常', () => {
    const ignore = ignoreSet(['飞行员', ' 北极星 ', ''])
    expect(cardNames('飞行员', undefined, ignore)).toEqual([])
    expect(cardNames('北极星-小鱼干', undefined, ignore)).toEqual(['小鱼干'])
    // 整段相同才算：「新飞行员」是另一个名字
    expect(cardNames('新飞行员', undefined, ignore)).toEqual(['新飞行员'])
    expect(cardNames('飞行员', undefined, new Set())).toEqual(['飞行员'])
  })

  it('配置：memberNameIgnore 默认空，去空白、去掉空项和重复项', () => {
    expect(normalizeSettings(baseConfig()).translate.memberNameIgnore).toEqual([])
    const s = normalizeSettings(baseConfig({ translate: { ...PR2_DEFAULTS.translate, memberNameIgnore: ' 飞行员 ;;北极星;;;; 飞行员' } }))
    expect(s.translate.memberNameIgnore).toEqual(['飞行员', '北极星'])
  })

  const withCards = (cards: string[]) => ({
    before: ({ qq }: any) => cards.forEach((card, i) => qq.members.set(`${QQ_GROUP}:2010${i}`, { role: 'member', card, nickname: 'x' })),
  })

  it('接进翻译：名片 某某某-收天使 → 「收天使」照常发给模型，不被当成名字保护', async () => {
    env = await setup(on(), withCards(['[ABC]某某某-收天使']))
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '有人收天使吗' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('有人收天使吗')
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '某某某今晚在线吗' } }]))
    await env.idle()
    // 昵称那一段仍然保护
    expect(llm.lastText()).toMatch(/^⟦\d+⟧今晚在线吗$/)
  })

  it('接进翻译：memberNameIgnore 里的词不保护，不写时保护', async () => {
    env = await setup(on({ translate: { memberNameIgnore: '飞行员;;北极星' } }), withCards(['飞行员', '北极星', '深空旅人']))
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '新飞行员和深空旅人来了' } }]))
    await env.idle()
    // 「飞行员」不当作名字；「深空旅人」仍保护
    expect(llm.lastText()).toBe('新飞行员和⟦0⟧来了')
    await env.stop()
    env = await setup(on(), withCards(['飞行员', '北极星', '深空旅人']))
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '新飞行员和深空旅人来了' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('新⟦0⟧和⟦1⟧来了')
  })

  it('bridge.status -a 显示每个 QQ 群缓存了多少个名字、上次刷新的时间；不带 -a 的私聊不显示', async () => {
    env = await setup(on({ translate: { memberNameIgnore: '机器人' } }), withCards(['[ABC]某某某-收天使', '飞行员']))
    // 群里原有 机器人（机器人自己）、群名片小明；加上 某某某、飞行员。机器人在 ignore 里、收天使是广告 → 群名片小明、某某某、飞行员 3 个
    let status = (await env.command(OWNER_QQ, 'bridge.status -a')).join('\n')
    expect(status).toContain('群友名字：还没取到')
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    status = (await env.command(OWNER_QQ, 'bridge.status -a')).join('\n')
    expect(status).toMatch(/群友名字：缓存 3 个，上次刷新 \S+ \S+ \(UTC\+8\)/)
    expect((await env.command(OWNER_QQ, 'bridge.status')).join('\n')).not.toContain('群友名字')
    // 查询失败：写明，名字当作没有
    env.qq.faults.set('get_group_member_list', 'fail')
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    status = (await env.command(OWNER_QQ, 'bridge.status -a')).join('\n')
    expect(status).toMatch(/群友名字：⚠ 最近一次查询失败.*上次成功刷新 \S+ \S+ \(UTC\+8\)/)
  })

  it('关掉 protectMemberNames 或这座桥没有 QQ → Discord 方向时，status 不显示', async () => {
    env = await setup(on({ translate: { protectMemberNames: false } }))
    expect((await env.command(OWNER_QQ, 'bridge.status -a')).join('\n')).not.toContain('群友名字')
    await env.stop()
    env = await setup({ ...on(), bridges: [bridge({ translate: true, direction: 'd2q' })] })
    expect((await env.command(OWNER_QQ, 'bridge.status -a')).join('\n')).not.toContain('群友名字')
  })
})

// ------------------------------------------------------------------ V4

describe('V4：审核可以忽略某些类别', () => {
  const moderator = (rules: { ignore?: string[]; minScore?: Record<string, number> }, result: any) =>
    new Moderator({ post: async () => ({ results: [result] }) }, () => ({ baseURL: 'https://moderation.example.com/v1', apiKey: 'sk-mod', ...rules }))
  const result = (flagged: boolean, marked: Record<string, number>, extra: Record<string, number> = {}) => ({
    flagged,
    categories: Object.fromEntries(Object.keys({ ...marked, ...extra }).map((c) => [c, c in marked])),
    category_scores: { ...extra, ...marked },
  })

  it('只有 violence 被标记、并且忽略 violence → 不算审核未通过；带 violence/graphic 的也一样（前缀匹配）', async () => {
    expect(await moderator({ ignore: ['violence'] }, result(true, { violence: 0.31 })).check('x')).toEqual({ ok: true, flagged: false })
    expect(await moderator({ ignore: ['violence'] }, result(true, { violence: 0.4, 'violence/graphic': 0.2 })).check('x')).toEqual({ ok: true, flagged: false })
  })

  it('只有 illicit/violent 被标记、忽略列表写的是 illicit → 不算', async () => {
    expect(await moderator({ ignore: ['illicit'] }, result(true, { 'illicit/violent': 0.5, illicit: 0.6 })).check('x')).toEqual({ ok: true, flagged: false })
  })

  it('同时有 harassment 被标记 → 算，并带上类别和分数', async () => {
    const r = await moderator({ ignore: ['violence', 'illicit'] }, result(true, { violence: 0.31, harassment: 0.55 })).check('x')
    expect(r).toEqual({ ok: true, flagged: true, hits: [{ category: 'harassment', score: 0.55 }] })
  })

  it('harassment 分数 0.4、minScore 写了 harassment=0.5 → 不算；0.6 → 算；没写的类别还看 categories', async () => {
    const rules = { minScore: { harassment: 0.5 } }
    expect(await moderator(rules, result(true, { harassment: 0.4 })).check('x')).toEqual({ ok: true, flagged: false })
    expect(await moderator(rules, result(true, { harassment: 0.6 })).check('x')).toMatchObject({ ok: true, flagged: true })
    expect(await moderator(rules, result(true, { harassment: 0.4, sexual: 0.3 })).check('x')).toMatchObject({ ok: true, flagged: true, hits: [{ category: 'sexual' }] })
    // 分数门槛只对完全相同的类别生效
    expect(await moderator(rules, result(true, { 'harassment/threatening': 0.4 })).check('x')).toMatchObject({ ok: true, flagged: true })
  })

  it('什么都没配时和原来一样看总的 flagged；配了但结果里没有类别信息时也按 flagged 算', async () => {
    expect(await moderator({}, result(true, { violence: 0.31 })).check('x')).toMatchObject({ ok: true, flagged: true })
    expect(await moderator({}, result(false, {})).check('x')).toEqual({ ok: true, flagged: false })
    expect(await moderator({ ignore: ['violence'] }, { flagged: true }).check('x')).toEqual({ ok: true, flagged: true })
  })

  it('配置：moderationIgnore 小写、去空项；moderationMinScore 写错的项只忽略那一项并提示', () => {
    const defaults = normalizeSettings(baseConfig()).filter
    expect(defaults.moderationIgnore).toEqual([])
    expect(defaults.moderationMinScore).toEqual({})
    const s = normalizeSettings(baseConfig({
      filter: { ...PR2_DEFAULTS.filter, moderationIgnore: ' Violence ;;illicit;;;;violence', moderationMinScore: 'Harassment=0.5;;坏了;;sexual=abc;;hate=2;;x=;;self-harm=0' },
    }))
    expect(s.filter.moderationIgnore).toEqual(['violence', 'illicit'])
    expect(s.filter.moderationMinScore).toEqual({ harassment: 0.5, 'self-harm': 0 })
    expect(s.problems.filter((p) => p.includes('最低分数'))).toHaveLength(4)
  })

  describe('接进翻译', () => {
    const run = async (filter: any, moderation: any, text = 'Fleet forms in Jita tonight') => {
      env = await setup(on({ filter: { moderation: true, moderationBaseURL: llm.base, ...filter } }))
      llm.moderation = moderation
      const payload = env.discordMessage({ content: text })
      await env.idle()
      return { out: env.qq.text(QQ_GROUP)[0], id: payload.id as string }
    }
    const marked = (flagged: boolean, scores: Record<string, number>, on: string[]) => ({
      flagged,
      categories: Object.fromEntries(Object.keys(scores).map((c) => [c, on.includes(c)])),
      category_scores: scores,
    })

    it('只有 violence 被标记、忽略 violence → 照常附译文（老代码整条不附）', async () => {
      const { out } = await run({ moderationIgnore: 'violence' }, marked(true, { violence: 0.31, harassment: 0.01 }, ['violence']))
      expect(out).toContain('【机翻】 译：Fleet forms in Jita tonight')
      expect(llm.moderations).toHaveLength(1)
    })

    it('只有 illicit/violent 被标记、忽略列表写的是 illicit → 照常附译文', async () => {
      const { out } = await run({ moderationIgnore: 'violence;;illicit' }, marked(true, { 'illicit/violent': 0.5, illicit: 0.6 }, ['illicit/violent', 'illicit']))
      expect(out).toContain('【机翻】')
    })

    it('同时有 harassment 被标记 → 不附；日志写消息 ID、方向、类别和分数，不写原文', async () => {
      const logs = captureLogs()
      try {
        const { out, id } = await run({ moderationIgnore: 'violence' }, marked(true, { violence: 0.31, harassment: 0.55 }, ['violence', 'harassment']))
        expect(out).not.toContain('【机翻】')
        const lines = logs.missing().map((r) => r.content)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain(id)
        expect(lines[0]).toContain('d2q')
        expect(lines[0]).toContain('审核未通过')
        expect(lines[0]).toContain('harassment 0.55')
        expect(lines[0]).not.toContain('violence')
        expect(lines[0]).not.toContain('Fleet forms')
      } finally {
        logs.stop()
      }
    })

    it('harassment 分数 0.4、moderationMinScore 写了 harassment=0.5 → 照常附译文；0.6 → 不附', async () => {
      const { out } = await run({ moderationMinScore: 'harassment=0.5' }, marked(true, { harassment: 0.4 }, ['harassment']))
      expect(out).toContain('【机翻】')
      await env!.stop()
      const second = await run({ moderationMinScore: 'harassment=0.5' }, marked(true, { harassment: 0.6 }, ['harassment']))
      expect(second.out).not.toContain('【机翻】')
    })

    it('什么都不配时和原来一样：任何类别被标记都不附', async () => {
      const { out } = await run({}, marked(true, { violence: 0.31 }, ['violence']))
      expect(out).not.toContain('【机翻】')
    })
  })
})

// ------------------------------------------------------------------ V5

describe('V5：审核可以只管一个方向', () => {
  const flagged = { flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.9 } }

  it('配置：默认 both；写错时按 both 并提示', () => {
    expect(normalizeSettings(baseConfig()).filter.moderationDirections).toBe('both')
    for (const value of ['en2zh', 'zh2en', 'both'] as const) {
      expect(normalizeSettings(baseConfig({ filter: { ...PR2_DEFAULTS.filter, moderationDirections: value } })).filter.moderationDirections).toBe(value)
    }
    const bad = normalizeSettings(baseConfig({ filter: { ...PR2_DEFAULTS.filter, moderationDirections: 'zh' as any } }))
    expect(bad.filter.moderationDirections).toBe('both')
    expect(bad.problems.some((p) => p.includes('审核方向'))).toBe(true)
  })

  it('设成 en2zh：中译英的译文不送审、照常附；英译中的照常送审', async () => {
    env = await setup(on({ filter: { moderation: true, moderationBaseURL: llm.base, moderationDirections: 'en2zh' } }))
    llm.moderation = flagged
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '今晚八点集合出发' } }]))
    await env.idle()
    expect(llm.moderations).toHaveLength(0)
    expect(env.discord.posts()[0].json.content).toContain('【机翻】 EN: 今晚八点集合出发')
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.moderations).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
  })

  it('设成 zh2en：英译中的译文不送审', async () => {
    env = await setup(on({ filter: { moderation: true, moderationBaseURL: llm.base, moderationDirections: 'zh2en' } }))
    llm.moderation = flagged
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.moderations).toHaveLength(0)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】')
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '今晚八点集合出发' } }]))
    await env.idle()
    expect(llm.moderations).toHaveLength(1)
    expect(env.discord.posts()[0].json.content).not.toContain('【机翻】')
  })

  it('不审核的方向不算「审核未配置密钥」；审核的方向没有密钥时才不附', async () => {
    // 审核地址和翻译地址不同、又没填审核密钥 → 没有可用的 key
    env = await setup(on({ filter: { moderation: true, moderationBaseURL: 'https://moderation.example.com/v1', moderationDirections: 'en2zh' } }))
    expect(env.relay.translation.problems).toContain('审核未配置密钥，英译中的译文全部不附')
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '今晚八点集合出发' } }]))
    await env.idle()
    expect(env.discord.posts()[0].json.content).toContain('【机翻】 EN: 今晚八点集合出发')
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
    expect(env.relay.translation.outcomes.get('审核未配置密钥')).toBe(1)
    expect(llm.chat).toHaveLength(1)
  })

  it('both 时没有密钥，两个方向都不附，提示和原来一样', async () => {
    env = await setup(on({ filter: { moderation: true, moderationBaseURL: 'https://moderation.example.com/v1' } }))
    expect(env.relay.translation.problems).toContain('审核未配置密钥，译文全部不附')
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '今晚八点集合出发' } }]))
    await env.idle()
    expect(env.discord.posts()[0].json.content).not.toContain('【机翻】')
    expect(llm.chat).toHaveLength(0)
  })
})

// ------------------------------------------------------------------ V6

describe('V6：只有一个术语的短消息先换术语再判断太短', () => {
  const overrides = [{ en: 'Mexallon', zh: '类银超金属', mode: 'force', dir: 'both' }]

  it('「Mexallon 6200000?」→ 本地生成「类银超金属 6200000?」，不请求服务商', async () => {
    env = await setup(on({ glossary: { overrides } }) as any)
    expect(await outcome('Mexallon 6200000?')).toEqual({ ok: true, text: '类银超金属 6200000?' })
    expect(llm.chat).toHaveLength(0)
    env.discordMessage({ content: 'Mexallon 6200000?' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 类银超金属 6200000?')
    expect(llm.chat).toHaveLength(0)
  })

  it('「嗯」「ok」仍然是太短；术语之外没有文字、换完也没有变化时按「只有术语」跳过', async () => {
    env = await setup(on({ glossary: { overrides: [...overrides, { en: 'o7', zh: 'o7', mode: 'keep', dir: 'both' }] } }) as any)
    expect(await outcome('嗯', 'zh2en')).toMatchObject({ ok: false, reason: '太短' })
    expect(await outcome('ok')).toMatchObject({ ok: false, reason: '太短' })
    expect(await outcome('o7')).toMatchObject({ ok: false, reason: '只有术语' })
    expect(await outcome('6200000?')).toMatchObject({ ok: false, reason: '没有文字' })
    expect(llm.chat).toHaveLength(0)
  })

  it('换完术语还有别的文字时，照原来的顺序，请求服务商', async () => {
    env = await setup(on({ glossary: { overrides } }) as any)
    expect(await outcome('Mexallon x')).toMatchObject({ ok: true })
    expect(llm.chat).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ V7

describe('V7：数字加单位算一个词', () => {
  it('「2个」「18年」「60出」「9000dph」不再是太短', () => {
    expect(skipReason('2个', 'zh2en')).toBeNull()
    expect(skipReason('18年', 'zh2en')).toBeNull()
    expect(skipReason('60出', 'zh2en')).toBeNull()
    expect(skipReason('9000dph', 'en2zh')).toBeNull()
    expect(skipReason(stripTokens('x10'), 'en2zh')).toBeNull()
  })

  it('纯数字、单个字照旧跳过；数字和字之间有空格不算紧挨着', () => {
    expect(skipReason('6', 'en2zh')).toBe('没有文字')
    expect(skipReason('10', 'zh2en')).toBe('没有文字')
    expect(skipReason('嗯', 'zh2en')).toBe('太短')
    expect(skipReason('好', 'zh2en')).toBe('太短')
    expect(skipReason('ok', 'en2zh')).toBe('太短')
    expect(skipReason('5 个', 'zh2en')).toBe('太短')
  })

  it('中译英的「是不是中文」：数字紧挨着汉字也算，其他照旧', () => {
    expect(skipReason('ok 好', 'zh2en')).toBe('不是中文')
    expect(skipReason('有人吗', 'zh2en')).toBeNull()
    expect(skipReason('9000dph', 'zh2en')).toBe('不是中文')
  })

  it('接进转发：QQ 的「2个」「18年」、Discord 的「9000dph」会翻译；「6」不翻译', async () => {
    env = await setup(on())
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '2个' } }]))
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '18年' } }]))
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '6' } }]))
    await env.idle()
    const posts = env.discord.posts().map((p) => p.json.content)
    expect(posts).toEqual(['2个\n\n【机翻】 EN: 2个', '18年\n\n【机翻】 EN: 18年', '6'])
    env.discordMessage({ content: '9000dph' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：9000dph')
  })
})

// ------------------------------------------------------------------ V8

describe('V8：按消息在 debug 日志里记没附译文的原因', () => {
  const flagged = { flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.55 } }

  async function sendThree() {
    env = await setup(on({ filter: { moderation: true, moderationBaseURL: llm.base } }))
    env.app.command('jita <item:text>').action(() => 'price')
    llm.moderation = flagged
    const ids = {
      moderation: env.discordMessage({ content: 'Fleet forms in Jita tonight' }).id as string,
      short: env.discordMessage({ content: 'ok' }).id as string,
      command: env.discordMessage({ content: 'jita plex' }).id as string,
    }
    await env.idle()
    return ids
  }

  it('审核未通过、太短、命令各一条：桥序号、方向、消息 ID、原因；不含原文', async () => {
    const logs = captureLogs(3)
    try {
      const ids = await sendThree()
      const lines = logs.missing().map((r) => r.content)
      expect(lines).toHaveLength(3)
      expect(lines.find((l) => l.includes(ids.moderation))).toBe(`没附译文 [第 1 个桥 d2q 消息 ${ids.moderation}]：审核未通过（harassment 0.55）`)
      expect(lines.find((l) => l.includes(ids.short))).toBe(`没附译文 [第 1 个桥 d2q 消息 ${ids.short}]：太短`)
      expect(lines.find((l) => l.includes(ids.command))).toBe(`没附译文 [第 1 个桥 d2q 消息 ${ids.command}]：命令`)
      for (const line of lines) for (const text of ['Fleet forms', 'tonight', 'plex']) expect(line).not.toContain(text)
      // 都是 debug 级别
      expect(logs.ours().filter((r) => r.content.includes('没附译文')).every((r) => r.type === 'debug')).toBe(true)
    } finally {
      logs.stop()
    }
  })

  it('QQ → Discord 的方向写 q2d；附上了译文的消息不写', async () => {
    const logs = captureLogs(3)
    try {
      env = await setup(on())
      const ok = env.discordMessage({ content: 'Fleet forms in Jita tonight' }).id
      await env.qqMessage(qqPayload([{ type: 'text', data: { text: '好' } }], { message_id: 777001 }))
      await env.idle()
      const lines = logs.missing().map((r) => r.content)
      expect(lines).toEqual(['没附译文 [第 1 个桥 q2d 消息 777001]：太短'])
      expect(lines.join()).not.toContain(ok)
    } finally {
      logs.stop()
    }
  })

  it('info 级别以上不写', async () => {
    const logs = captureLogs(2)
    try {
      await sendThree()
      expect(logs.missing()).toEqual([])
    } finally {
      logs.stop()
    }
  })
})

// ------------------------------------------------------------------ V12

describe('V12：占位符不符时重试一次', () => {
  // 用 Translator 直接测请求；服务器是 FakeLLM
  const translator = async (config: Partial<ConstructorParameters<typeof Translator>[1] extends () => infer C ? C : never> = {}) => {
    env = await setup(on())
    const cfg = { baseURL: llm.base, apiKey: 'sk-test', model: 'test-model', timeoutMs: 2000, maxPerHour: 0, ...config }
    return new Translator(env.app.http, () => cfg as any)
  }
  const input = (text: string) => ({ text, direction: 'zh2en' as const, hints: [], tokens: ['⟦0⟧', '⟦1⟧'], sourceForChecks: stripTokens(text) })
  const SOURCE = '⟦0⟧ 到 ⟦1⟧ 集合'

  it('第一次缺占位符、第二次正确 → 用第二次的译文；第二次的用户消息最前面有提醒；两次都算请求和用量，不算失败', async () => {
    const tr = await translator()
    llm.queue.push('gather', '⟦0⟧ gather at ⟦1⟧')
    expect(await tr.translate(input(SOURCE))).toMatchObject({ ok: true, text: '⟦0⟧ gather at ⟦1⟧' })
    expect(llm.chat).toHaveLength(2)
    const [first, second] = llm.chat.map((c) => c.messages.at(-1).content)
    expect(first).toBe(`<text>${SOURCE}</text>`)
    expect(second).toBe(`上次的译文漏掉或改动了占位符，这次务必原样保留每个 ⟦…⟧。\n\n<text>${SOURCE}</text>`)
    expect(tr.stats()).toMatchObject({ requests: 2, promptTokens: 10, completionTokens: 6, failures: {} })
  })

  it('两次都错 → 失败，原因是「占位符不符」，只重试一次', async () => {
    const tr = await translator()
    llm.queue.push('gather', '⟦0⟧ gather ⟦1⟧ ⟦1⟧', '⟦0⟧ gather at ⟦1⟧')
    expect(await tr.translate(input(SOURCE))).toEqual({ ok: false, reason: '占位符不符' })
    expect(llm.chat).toHaveLength(2)
    expect(tr.stats()).toMatchObject({ requests: 2, failures: { 占位符不符: 1 } })
  })

  it('重试占每小时名额：maxPerHour = 2 时，一次带重试的翻译就用完了', async () => {
    const tr = await translator({ maxPerHour: 2 })
    llm.queue.push('gather', '⟦0⟧ gather at ⟦1⟧')
    expect(await tr.translate(input(SOURCE))).toMatchObject({ ok: true })
    expect(await tr.translate(input(SOURCE))).toEqual({ ok: false, reason: '超过每小时上限' })
    expect(llm.chat).toHaveLength(2)
  })

  it('名额只剩一次时不重试，原因仍是「占位符不符」', async () => {
    const tr = await translator({ maxPerHour: 1 })
    llm.queue.push('gather')
    expect(await tr.translate(input(SOURCE))).toEqual({ ok: false, reason: '占位符不符' })
    expect(llm.chat).toHaveLength(1)
    expect(tr.stats()).toMatchObject({ requests: 1, failures: { 占位符不符: 1 } })
  })

  it('其他失败不重试（空结果、长度异常）', async () => {
    const tr = await translator()
    llm.queue.push('')
    expect(await tr.translate(input(SOURCE))).toEqual({ ok: false, reason: '空结果' })
    expect(llm.chat).toHaveLength(1)
  })

  it('接进转发：第一次丢了占位符、第二次正确 → 附第二次的译文；两次都错 → 不附', async () => {
    env = await setup(on())
    llm.queue.push('今晚集合', '今晚在 ⟦0⟧ 集合')
    env.discordMessage({ content: 'Gather at 1DQ1-A tonight please' })
    await env.idle()
    expect(llm.chat).toHaveLength(2)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 今晚在 1DQ1-A 集合')
    expect(env.relay.translation.translator.stats()).toMatchObject({ requests: 2, failures: {} })
    llm.queue.push('今晚集合', '还是没有')
    env.discordMessage({ content: 'Gather at 1DQ1-A again please' })
    await env.idle()
    expect(llm.chat).toHaveLength(4)
    expect(env.qq.text(QQ_GROUP)[1]).not.toContain('【机翻】')
    expect(env.relay.translation.translator.stats().failures).toEqual({ 占位符不符: 1 })
    expect(env.relay.translation.outcomes.get('占位符不符')).toBe(1)
  })
})
