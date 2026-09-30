// 0.3.2 补充清单 U6、U7：建筑通知里的建筑名、dotlan 链接里的军团名，以及 QQ 群友名片里的名字不翻译。
// 翻译用模拟服务器；军团名、建筑名、名片全部是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEveData, structureTypeNames } from '../src/glossary'
import { cardNames, dotlanNames, MemberNames, nameRanges, structureNames } from '../src/translate/names'
import { bridge, Env, PR2_DEFAULTS, QQ_GROUP, qqPayload, setup } from './harness'

class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []
  reply = (text: string) => (/[一-鿿]/.test(text) ? `EN: ${text}` : `译：${text}`)

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        this.chat.push({ json })
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: this.reply(text) } }] }))
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
    const user = this.chat.at(-1)?.json.messages?.at(-1)?.content ?? ''
    return /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
  }
}

const NOTICE = [
  'Structure under attack',
  '',
  'The Astrahus Example Keep in Jita https://evemaps.dotlan.net/system/Jita (The Forge) belonging to Example Corp https://evemaps.dotlan.net/corp/Example_Corp is under attack by Some Alliance https://evemaps.dotlan.net/alliance/Some_Alliance.',
  'shield: 94.7% | armor: 100.0% | hull: 100.0%',
].join('\n')

const TYPES = structureTypeNames(loadEveData())

// ------------------------------------------------------------------ 单元

describe('U6：从翻译输入里找出名字', () => {
  it('官方表里有建筑类型名', () => {
    expect(TYPES).toEqual(expect.arrayContaining(['Astrahus', 'Fortizar', 'Keepstar', 'Ansiblex Jump Bridge']))
  })

  it('dotlan 链接里的军团、联盟名：_ 换成空格，URL 解码；星系链接不算', () => {
    expect(dotlanNames(NOTICE)).toEqual(['Example Corp', 'Some Alliance'])
    expect(dotlanNames('see https://evemaps.dotlan.net/corp/Quiet%20Harbor_Works')).toEqual(['Quiet Harbor Works'])
    expect(dotlanNames('https://evemaps.dotlan.net/system/Jita')).toEqual([])
  })

  it('建筑通知句式里的建筑名；没有名字的普通句子不算', () => {
    expect(structureNames(NOTICE, TYPES)).toEqual(['Example Keep'])
    expect(structureNames('The Ansiblex Jump Bridge Example Gate » Other in Some System is low on fuel', TYPES)).toEqual(['Example Gate » Other'])
    expect(structureNames('The Astrahus in Jita is reinforced', TYPES)).toEqual([])
    expect(structureNames('The Astrahus in Jita is reinforced', [])).toEqual([])
    expect(structureNames('The Rifter Example Keep in Jita', TYPES)).toEqual([])
  })

  it('名字出现的位置：跳过网址，英文名两边不能紧挨字母数字', () => {
    const text = 'Example Corp https://evemaps.dotlan.net/corp/Example Corp and Example Corps'
    expect(nameRanges(text, ['Example Corp']).map(([s, e]) => [s, text.slice(s, e)])).toEqual([[0, 'Example Corp']])
  })
})

describe('U7：群名片分段', () => {
  it('去掉 []、【】 里的简称，按分隔符分段，只收 3 个字及以上、含汉字的段', () => {
    expect(cardNames('[ABC]Some Pilot-小鱼干')).toEqual(['小鱼干'])
    expect(cardNames('军团长-星海漫游者 - 老猫')).toEqual(['军团长', '星海漫游者'])
    expect(cardNames('【XYZ】北风吹过|咖啡/晨星号_ok')).toEqual(['北风吹过', '晨星号'])
    expect(cardNames('[ABC]咖啡')).toEqual([])
  })

  it('和术语表原文相同的段不收', () => {
    expect(cardNames('军团长-星海漫游者', (s) => s === '军团长')).toEqual(['星海漫游者'])
  })

  it('缓存：取的时候不等待；1 小时后在后台刷新；查询失败当作没有名片', async () => {
    let now = 0
    let calls = 0
    let fail = false
    const cache = new MemberNames(async () => {
      calls++
      if (fail) throw new Error('boom')
      return [{ card: '[ABC]Some Pilot-小鱼干' }, { card: '', nickname: '深空旅人' }]
    }, () => now)
    expect(cache.cards('1')).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect(cache.cards('1')).toEqual(['[ABC]Some Pilot-小鱼干', '深空旅人'])
    expect(calls).toBe(1)
    now += 3600 * 1000
    fail = true
    expect(cache.cards('1')).toEqual(['[ABC]Some Pilot-小鱼干', '深空旅人'])
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
    expect(cache.cards('1')).toEqual([])
  })
})

// ------------------------------------------------------------------ 集成

describe('U6、U7 接进翻译', () => {
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

  const on = (patch: any = {}) => ({
    bridges: [bridge({ translate: true })],
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, ...patch.translate },
    filter: { ...PR2_DEFAULTS.filter },
    glossary: { ...PR2_DEFAULTS.glossary, ...patch.glossary },
  })
  const withCard = (card: string) => ({ before: ({ qq }: any) => qq.members.set(`${QQ_GROUP}:20002`, { role: 'member', card, nickname: 'x' }) })

  for (const eve of [true, false]) {
    it(`U6：建筑通知里的建筑名、军团名、联盟名不发给模型，译文里原样（官方表${eve ? '打开' : '关闭'}）`, async () => {
      env = await setup(on({ glossary: { eve } }))
      env.discordMessage({ content: '', embeds: [{ type: 'rich', description: NOTICE }] })
      await env.idle()
      const sent = llm.lastText()
      for (const name of ['Example Keep', 'Example Corp', 'Some Alliance']) expect(sent).not.toContain(name)
      expect(sent).toMatch(/The (?:Astrahus|⟦G\d+⟧) ⟦\d+⟧ in /)
      const out = env.qq.text(QQ_GROUP)[0]
      // 转发的原文不变，译文里名字原样
      expect(out).toContain(NOTICE.split('\n')[2])
      expect(out).toContain('【机翻】 译：Structure under attack')
      expect(out.split('【机翻】')[1]).toMatch(/The \S+ Example Keep in Jita/)
      expect(out.split('【机翻】')[1]).toContain('belonging to Example Corp https://evemaps.dotlan.net/corp/Example_Corp')
    })
  }

  it('U6：军团名里带船名（Eagle）时不被官方表换掉', async () => {
    env = await setup(on({ glossary: { eve: true } }))
    const text = 'The Raitaru Example Works in Jita belonging to Quiet Eagle Works https://evemaps.dotlan.net/corp/Quiet_Eagle_Works is reinforced'
    expect(await env.relay.translation.translate({ platform: 'discord', translatable: text, protect: [] } as any, 'en2zh')).toMatchObject({ ok: true })
    expect(llm.lastText()).not.toContain('Eagle')
    expect(llm.lastText()).not.toContain('Example Works')
  })

  it('U6：The Astrahus in Jita is reinforced 照常翻译', async () => {
    env = await setup(on({ glossary: { eve: false } }))
    const text = 'The Astrahus in Jita is reinforced'
    expect(await env.relay.translation.translate({ platform: 'discord', translatable: text, protect: [] } as any, 'en2zh')).toMatchObject({ ok: true })
    expect(llm.lastText()).toBe(text)
  })

  it('U7：名片 [ABC]Some Pilot-小鱼干 → 「把小鱼干搞大」里的小鱼干不发给模型', async () => {
    env = await setup(on(), withCard('[ABC]Some Pilot-小鱼干'))
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '把小鱼干搞大' } }]))
    await env.idle()
    expect(llm.lastText()).toMatch(/^把⟦\d+⟧搞大$/)
    expect(env.discord.posts()[0].json.content).toBe('把小鱼干搞大\n\n【机翻】 EN: 把小鱼干搞大')
  })

  it('U7：插件刚启动还没有名片时不等待，照常翻译；之后在后台取到', async () => {
    env = await setup(on(), withCard('[ABC]Some Pilot-小鱼干'))
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '把小鱼干搞大' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('把小鱼干搞大')
    expect(env.qq.calls.some((c) => c.action === 'get_group_member_list')).toBe(true)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '小鱼干在吗' } }]))
    await env.idle()
    expect(llm.lastText()).toMatch(/^⟦\d+⟧在吗$/)
  })

  it('U7：2 个字的段不保护；开关关掉时不保护', async () => {
    env = await setup(on(), withCard('[ABC]Pilot-咖啡'))
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '来杯咖啡再走' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('来杯咖啡再走')
    await env.stop()
    env = await setup(on({ translate: { protectMemberNames: false } }), withCard('[ABC]Some Pilot-小鱼干'))
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '把小鱼干搞大' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('把小鱼干搞大')
  })

  it('U7：只管中译英；Discord 来的英文不查成员名片', async () => {
    env = await setup(on(), withCard('[ABC]Some Pilot-小鱼干'))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.calls.some((c) => c.action === 'get_group_member_list')).toBe(false)
  })

  it('U7：成员列表查询失败时照常翻译', async () => {
    env = await setup(on(), withCard('[ABC]Some Pilot-小鱼干'))
    env.qq.faults.set('get_group_member_list', 'fail')
    await env.relay.translation.memberNames!.refresh(QQ_GROUP)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '把小鱼干搞大' } }]))
    await env.idle()
    expect(llm.lastText()).toBe('把小鱼干搞大')
    expect(env.discord.posts()[0].json.content).toBe('把小鱼干搞大\n\n【机翻】 EN: 把小鱼干搞大')
  })
})
