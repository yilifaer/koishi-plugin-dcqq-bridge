// PR B（0.2.2）：翻译修正 B3–B9。翻译和审核都用模拟服务器，不调用外部 API。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { normalizeSettings } from '../src/bridges'
import { resolveModerationKey } from '../src/filter'
import { Translator, type TranslatorConfig } from '../src/translate/client'
import { protect } from '../src/translate/protect'
import { isCommand } from '../src/translate/skip'
import { baseConfig, bridge, discordPayload, Env, PR2_DEFAULTS, QQ_GROUP, qqPayload, setup } from './harness'

class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []
  inFlight = 0
  maxInFlight = 0
  delayMs = 0
  translate: (text: string) => string = (text) => (/[一-鿿]/.test(text) ? `EN: ${text}` : `译：${text}`)

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        this.chat.push({ json })
        this.inFlight++
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        const send = () => {
          this.inFlight--
          if (res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: this.translate(text) } }] }))
        }
        if (this.delayMs) setTimeout(send, this.delayMs)
        else send()
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

let llm: FakeLLM

// ------------------------------------------------------------------ 单元

describe('Translator（B4 并发、B6 拒绝、B7 extraBody）', () => {
  let app: Context
  let config: TranslatorConfig

  beforeAll(async () => {
    app = new Context()
    app.plugin(HTTP as any)
    await app.start()
  })
  afterAll(() => app.stop())
  beforeEach(async () => {
    llm = new FakeLLM()
    await llm.start()
    config = { baseURL: llm.base, apiKey: 'sk-test-key', model: 'test-model', timeoutMs: 3000, maxPerHour: 0 }
  })
  afterEach(() => llm.stop())

  const input = (text: string) => ({ text, direction: 'zh2en' as const, hints: [], tokens: [], sourceForChecks: text })

  it('B4：同时最多 4 个请求，排队的轮到后照常发出', async () => {
    llm.delayMs = 300
    const t = new Translator(app.http, () => config)
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => t.translate(input(`第${i}条消息`))))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(llm.chat).toHaveLength(6)
    expect(llm.maxInFlight).toBe(4)
  })

  it('B4：排队等不到名额的，按提交时算的 timeoutMs 失败为「超时」，不发请求', async () => {
    llm.delayMs = 1200
    const t = new Translator(app.http, () => config)
    const first = Array.from({ length: 4 }, (_, i) => t.translate(input(`第${i}条消息`)))
    await new Promise((r) => setTimeout(r, 50))
    config = { ...config, timeoutMs: 300 }
    const queued = await Promise.all([t.translate(input('排队的一条')), t.translate(input('排队的两条'))])
    expect(queued).toEqual([{ ok: false, reason: '超时' }, { ok: false, reason: '超时' }])
    expect(llm.chat).toHaveLength(4)
    expect((await Promise.all(first)).every((r) => r.ok)).toBe(true)
    expect(t.load()).toEqual({ active: 0, queued: 0 })
    expect(t.stats().requests).toBe(4)
  })

  it('B6：原文里有「帮不」这类说法时不判拒绝', async () => {
    llm.translate = () => "I can't help with this"
    const t = new Translator(app.http, () => config)
    expect(await t.translate(input('这个我帮不上忙'))).toMatchObject({ ok: true, text: "I can't help with this" })
    // 原文里没有时照常判拒绝
    expect(await t.translate(input('今晚八点集合'))).toEqual({ ok: false, reason: '拒绝翻译' })
    llm.translate = () => '作为AI，我不能'
    expect(await t.translate({ ...input('as an AI I cannot help'), direction: 'en2zh' })).toMatchObject({ ok: true })
  })

  it('B7：extraBody 合并进请求体，不能覆盖 model、messages', async () => {
    config = { ...config, extraBody: { max_tokens: 1000, model: 'evil', messages: [] } as any }
    const t = new Translator(app.http, () => config)
    expect(await t.translate(input('今晚八点集合'))).toMatchObject({ ok: true })
    const body = llm.chat[0].json
    expect(body.max_tokens).toBe(1000)
    expect(body.model).toBe('test-model')
    expect(body.messages).toHaveLength(2)
  })
})

describe('配置（B7 extraBody、B9 notCommands）', () => {
  const tr = (patch: any) => normalizeSettings(baseConfig({ translate: { ...PR2_DEFAULTS.translate, ...patch } }))

  it('extraBody：对象被解析，去掉 model、messages；空 → {}', () => {
    const s = tr({ extraBody: '{"max_tokens": 5, "model": "x", "messages": [], "reasoning_effort": "low"}' })
    expect(s.translate.extraBody).toEqual({ max_tokens: 5, reasoning_effort: 'low' })
    expect(s.problems.join('\n')).not.toContain('extraBody')
    expect(tr({ extraBody: '' }).translate.extraBody).toEqual({})
    expect(tr({}).translate.extraBody).toEqual({})
  })

  it('extraBody：JSON 写错或不是对象 → 提示并忽略，提示里不带内容', () => {
    for (const bad of ['{"max_tokens": ', '[1, 2]', '"text"', 'null', '42']) {
      const s = tr({ extraBody: bad })
      expect(s.translate.extraBody).toEqual({})
      expect(s.problems.some((p) => p.includes('extraBody'))).toBe(true)
    }
    expect(tr({ extraBody: '{"secret": "sk-leak"' }).problems.join('\n')).not.toContain('sk-leak')
  })

  it('notCommands：;; 分隔、去空白、小写；默认 help', () => {
    expect(tr({ notCommands: ' Help ;; JITA;;;; ' }).translate.notCommands).toEqual(['help', 'jita'])
    expect(tr({ notCommands: undefined }).translate.notCommands).toEqual(['help'])
    expect(tr({ notCommands: '' }).translate.notCommands).toEqual([])
  })
})

describe('B5 网址', () => {
  it('网址遇到第一个非 ASCII 字符结束', () => {
    const r = protect('看这里https://example.com/path?a=1中文说明', [])
    expect(r.tokens.map((t) => t.value)).toEqual(['https://example.com/path?a=1'])
    expect(r.text).toBe('看这里⟦0⟧中文说明')
    expect(protect('链接 https://example.com/wiki/吉他 看看', []).tokens.map((t) => t.value)).toEqual(['https://example.com/wiki/'])
    expect(protect('see https://example.com/a_b-c~d.', []).tokens.map((t) => t.value)).toEqual(['https://example.com/a_b-c~d'])
  })
})

describe('B8 审核 key 借用', () => {
  const key = (a: string, b: string) => resolveModerationKey(a, 'sk-tr', b, '')
  it('origin 和路径都相同（末尾斜杠、主机大小写不算）→ 借用', () => {
    expect(key('https://api.openai.com/v1', 'https://api.openai.com/v1')).toBe('sk-tr')
    expect(key('https://API.openai.com/v1/', 'https://api.openai.com/v1//')).toBe('sk-tr')
    expect(key('https://api.openai.com:443/v1', 'https://api.openai.com/v1')).toBe('sk-tr')
  })
  it('路径、端口、协议不同 → 不借用', () => {
    expect(key('https://api.openai.com/v1', 'https://api.openai.com/v2')).toBeNull()
    expect(key('https://api.openai.com', 'https://api.openai.com/v1')).toBeNull()
    expect(key('https://api.openai.com/proxy/v1', 'https://api.openai.com/v1')).toBeNull()
    expect(key('https://api.openai.com:8443/v1', 'https://api.openai.com/v1')).toBeNull()
    expect(key('http://api.openai.com/v1', 'https://api.openai.com/v1')).toBeNull()
    expect(key('https://gateway.example.com/v1', 'https://api.openai.com/v1')).toBeNull()
  })
  it('填了审核 key 照旧用自己的', () => {
    expect(resolveModerationKey('https://gateway.example.com/v1', 'sk-tr', 'https://api.openai.com/v1', 'sk-mod')).toBe('sk-mod')
  })
})

describe('B9 isCommand', () => {
  const commands = new Set(['help', 'jita', '吉他', 'bridge.status'])
  const resolve = (w: string) => commands.has(w.toLowerCase()) || undefined
  const not = ['help']

  it('第一个词是命令、不在 notCommands、整条不超过 3 个词才算', () => {
    expect(isCommand('Help needed in Jita, we are tackled', [], resolve, not)).toBe(false)
    expect(isCommand('Help needed in Jita, we are tackled', [], resolve, [])).toBe(false)
    expect(isCommand('jita plex', [], resolve, not)).toBe(true)
    expect(isCommand('吉他 伊甸币', [], resolve, not)).toBe(true)
    expect(isCommand('help', [], resolve, not)).toBe(false)
    expect(isCommand('HELP', [], resolve, not)).toBe(false)
    expect(isCommand('help', [], resolve, [])).toBe(true)
    expect(isCommand('bridge.status', [], resolve, not)).toBe(true)
    expect(isCommand('jita plex tritanium', [], resolve, not)).toBe(true)
    expect(isCommand('jita plex and tritanium', [], resolve, not)).toBe(false)
    expect(isCommand('.jita plex', ['.'], resolve, ['JITA'])).toBe(false)
    expect(isCommand('吉他伊甸币多少钱今天晚上', [], resolve, not)).toBe(false)
  })
})

// ------------------------------------------------------------------ 接进转发

describe('接进转发', () => {
  let env: Env

  beforeEach(async () => {
    llm = new FakeLLM()
    await llm.start()
  })
  afterEach(async () => {
    await env?.stop()
    await llm.stop()
  })

  function on(patch: any = {}) {
    return {
      bridges: [bridge({ translate: true })],
      translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, ...patch.translate },
      filter: { ...PR2_DEFAULTS.filter, ...patch.filter },
      glossary: { ...PR2_DEFAULTS.glossary, ...patch.glossary },
    }
  }
  const outcome = (text: string, direction: 'en2zh' | 'zh2en' = 'en2zh') =>
    env.relay.translation.translate({ translatable: text, protect: [] } as any, direction)

  const overrides = [
    { en: 'CTA', zh: '集结', mode: 'force', dir: 'both' },
    { en: 'Rifter', zh: '裂谷级', mode: 'force', dir: 'both' },
    { en: 'o7', zh: 'o7', mode: 'keep', dir: 'both' },
    { en: 'Keepstar', zh: 'Keepstar', mode: 'keep', dir: 'both' },
  ]

  it('B3：只有 force 术语 → 本地生成译文，不请求服务商', async () => {
    env = await setup(on({ glossary: { overrides } }) as any)
    env.discordMessage({ content: 'CTA Rifter' })
    await env.idle()
    expect(llm.chat).toHaveLength(0)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 集结裂谷级') // U11：两个中文术语之间不留空格
  })

  it('B3：只有 keep 术语（加上网址等保护内容）→ 跳过，原因「只有术语」', async () => {
    env = await setup(on({ glossary: { overrides } }) as any)
    expect(await outcome('o7 keepstar https://example.com/x')).toEqual({ ok: false, reason: '只有术语', skipped: true })
    expect(await outcome('o7 Keepstar', 'zh2en')).toMatchObject({ reason: '不是中文' })
    env.discordMessage({ content: 'o7 Keepstar' })
    await env.idle()
    expect(llm.chat).toHaveLength(0)
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
  })

  it('B3：术语之外还有文字 → 照常请求（跳过规则仍把术语算作字，DECISIONS #35）', async () => {
    env = await setup(on({ glossary: { overrides } }) as any)
    env.discordMessage({ content: 'CTA now' })
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：集结 now')
  })

  it('B3：译文规范化后和原文相同 → 不附；再发一次走缓存也不附、不再请求', async () => {
    env = await setup(on())
    llm.translate = (text) => `  ${text.toUpperCase().replace(/ /g, '   ')} `
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
    expect(await outcome('Fleet forms in Jita tonight')).toEqual({ ok: false, reason: '译文与原文相同', skipped: true })
    expect(llm.chat).toHaveLength(1)
  })

  it('B4：补发的消息不翻译', async () => {
    env = await setup(on())
    env.relay.onDiscordMessage(discordPayload({ content: 'Fleet forms in Jita tonight' }), true)
    await env.idle()
    expect(env.qq.text(QQ_GROUP)).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
    expect(llm.chat).toHaveLength(0)
  })

  it('B7：extraBody 进到请求体；写错时状态里有提示，照常翻译', async () => {
    env = await setup(on({ translate: { extraBody: '{"max_tokens": 300}' } }))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.chat[0].json.max_tokens).toBe(300)
    await env.stop()
    env = await setup(on({ translate: { extraBody: '{oops' } }))
    expect(env.relay.settings.problems.some((p) => p.includes('extraBody'))).toBe(true)
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.chat).toHaveLength(2)
    expect(llm.chat[1].json.max_tokens).toBeUndefined()
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】')
  })

  it('B9：只有短的、第一个词是命令的消息才不翻译', async () => {
    env = await setup(on())
    if (!env.app.$commander.resolve('help')) env.app.command('help').action(() => 'help')
    env.app.command('jita <item:text>').alias('吉他').action(() => 'price')

    env.discordMessage({ content: 'Help needed in Jita, we are tackled' })
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：Help needed in Jita, we are tackled')

    env.discordMessage({ content: 'jita plex' })
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '吉他 伊甸币' } }]))
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    expect(await outcome('jita plex')).toMatchObject({ reason: '命令' })
    expect(await outcome('吉他 伊甸币', 'zh2en')).toMatchObject({ reason: '命令' })
    expect(await outcome('bridge.status')).toMatchObject({ reason: '命令' })
    // 「help」单独一个词不算命令（在 notCommands 里）；只是太短，按 #35 跳过
    expect(await outcome('help')).toMatchObject({ reason: '太短' })
    env.discordMessage({ content: 'help me' })
    await env.idle()
    expect(llm.chat).toHaveLength(2)
  })
})
