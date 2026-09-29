// 翻译核心：占位符保护、跳过规则、翻译请求（模拟的 OpenAI 兼容服务器，不调用外部 API）。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { protect, restore, stripTokens, tokensIntact } from '../src/translate/protect'
import { isCommand, skipReason } from '../src/translate/skip'
import { Translator, type TranslatorConfig } from '../src/translate/client'

// ------------------------------------------------------------------ 模拟服务器

type Reply = { status?: number; body?: any; delayMs?: number; headers?: Record<string, string> }

class FakeLLM {
  server!: http.Server
  base = ''
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders; json: any }> = []
  replies: Reply[] = []

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let json: any = null
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        this.requests.push({ path: req.url ?? '', headers: req.headers, json })
        const reply = this.replies.shift() ?? { body: completion('') }
        const send = () => {
          if (res.destroyed) return
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
          res.end(JSON.stringify(reply.body ?? {}))
        }
        if (reply.delayMs) setTimeout(send, reply.delayMs)
        else send()
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function completion(content: string, usage = { prompt_tokens: 11, completion_tokens: 7 }) {
  return { choices: [{ index: 0, message: { role: 'assistant', content } }], usage }
}

const llm = new FakeLLM()
let app: Context
let config: TranslatorConfig

beforeAll(async () => {
  await llm.start()
  app = new Context()
  app.plugin(HTTP as any)
  await app.start()
})

afterAll(async () => {
  await app.stop()
  await llm.stop()
})

beforeEach(() => {
  llm.requests = []
  llm.replies = []
  config = { baseURL: llm.base + '/v1/', apiKey: 'sk-test-key', model: 'test-model', timeoutMs: 2000, maxPerHour: 0 }
})

function translator(now?: () => number) {
  return new Translator(app.http, () => config, now)
}

function input(text: string, direction: 'en2zh' | 'zh2en' = 'zh2en', extra: Partial<{ hints: string[]; tokens: string[] }> = {}) {
  return { text, direction, hints: extra.hints ?? [], tokens: extra.tokens ?? [], sourceForChecks: stripTokens(text) }
}

// ------------------------------------------------------------------ protect

describe('占位符保护', () => {
  it('同样的内容出现两次 → 两个编号，还原后和原文一样', () => {
    const src = '@甲 看这里 @甲 再看 1DQ1-A'
    const r = protect(src, ['@甲'])
    expect(r.text).toBe('⟦0⟧ 看这里 ⟦1⟧ 再看 ⟦2⟧')
    expect(r.tokens).toEqual([
      { token: '⟦0⟧', value: '@甲' },
      { token: '⟦1⟧', value: '@甲' },
      { token: '⟦2⟧', value: '1DQ1-A' },
    ])
    expect(restore(r.text, r.tokens)).toBe(src)
  })

  it('网址、提及、时间、代号星系、虫洞、ISK', () => {
    const time = '2026-09-30 20:00 (UTC+8)'
    const src = `form up ${time} in 1DQ1-A, then J1226-0 and J123456 @Fleet Boss see https://example.com/a?b=1. pay 1.5b or 300m or 20 K`
    const r = protect(src, ['@Fleet Boss', time, '@Fleet'])
    const values = r.tokens.map((t) => t.value)
    expect(values).toEqual([time, '1DQ1-A', 'J1226-0', 'J123456', '@Fleet Boss', 'https://example.com/a?b=1', '1.5b', '300m', '20 K'])
    expect(r.text).toBe('form up ⟦0⟧ in ⟦1⟧, then ⟦2⟧ and ⟦3⟧ ⟦4⟧ see ⟦5⟧. pay ⟦6⟧ or ⟦7⟧ or ⟦8⟧')
    expect(restore(r.text, r.tokens)).toBe(src)
    expect(stripTokens(r.text)).toBe('form up  in , then  and   see . pay  or  or')
  })

  it('原文里本来就有的 ⟦⟧ 也被保护', () => {
    const r = protect('look ⟦0⟧ and ⟦', [])
    expect(r.tokens.map((t) => t.value)).toEqual(['⟦0⟧', '⟦'])
    expect(restore(r.text, r.tokens)).toBe('look ⟦0⟧ and ⟦')
  })

  it('tokensIntact：缺少、重复、未知、残缺都算不对', () => {
    const tokens = [{ token: '⟦0⟧' }, { token: '⟦1⟧' }, { token: '⟦G0⟧' }]
    expect(tokensIntact('a ⟦1⟧ b ⟦0⟧ ⟦G0⟧', tokens)).toBe(true)
    expect(tokensIntact('a ⟦1⟧ b ⟦G0⟧', tokens)).toBe(false)
    expect(tokensIntact('a ⟦0⟧ ⟦1⟧ ⟦1⟧ ⟦G0⟧', tokens)).toBe(false)
    expect(tokensIntact('a ⟦0⟧ ⟦1⟧ ⟦G0⟧ ⟦2⟧', tokens)).toBe(false)
    expect(tokensIntact('a ⟦0⟧ ⟦1⟧ ⟦G0⟧ ⟦', tokens)).toBe(false)
  })
})

// ------------------------------------------------------------------ skip

describe('跳过规则', () => {
  const t = (text: string, spans: string[], dir: 'en2zh' | 'zh2en') => skipReason(stripTokens(protect(text, spans).text), dir)

  it('CTA ⟦时间⟧ Jita 要翻译', () => {
    const time = '2026-09-30 20:00'
    const p = protect(`CTA ${time} Jita`, [time])
    expect(p.text).toBe('CTA ⟦0⟧ Jita')
    expect(skipReason(stripTokens(p.text), 'en2zh')).toBeNull()
  })

  it('gg [表情] 和 @名字 ok 跳过', () => {
    expect(t('gg [微笑]', ['[微笑]'], 'en2zh')).not.toBeNull()
    expect(t('@张三 ok', ['@张三'], 'en2zh')).not.toBeNull()
    expect(skipReason(stripTokens('gg ⟦0⟧'), 'en2zh')).toBe('太短')
    expect(skipReason(stripTokens('⟦0⟧ ok'), 'en2zh')).toBe('太短')
  })

  it('没有文字、已经是目标语言', () => {
    expect(skipReason('123 !!', 'en2zh')).toBe('没有文字')
    expect(skipReason('今晚集合 at home', 'en2zh')).toBe('已是中文')
    expect(skipReason('fleet is up now', 'en2zh')).toBeNull()
    expect(skipReason('ok 好 go', 'zh2en')).toBe('不是中文')
    expect(t('[微笑] hello there', ['[微笑]'], 'zh2en')).toBe('不是中文')
    expect(skipReason('有人吗', 'zh2en')).toBeNull()
  })

  it('命令：前缀、不带前缀、只在配置时去掉 /、禁用的别名', () => {
    // 模拟 ctx.$commander.resolve（不带 session，禁用的别名也返回命令）
    const commands = new Map<string, any>([['jita', { name: 'price' }], ['吉他', { name: 'price', disabled: true }], ['trans', { name: 'trans' }]])
    const resolve = (w: string) => commands.get(w)
    expect(isCommand('jita plex', [], resolve)).toBe(true)
    expect(isCommand('吉他 皮尔斯', [''], resolve)).toBe(true)
    expect(isCommand('.jita plex', ['.'], resolve)).toBe(true)
    expect(isCommand('/jita plex', ['.'], resolve)).toBe(false)
    expect(isCommand('/jita plex', ['/', '.'], resolve)).toBe(true)
    expect(isCommand('..jita', ['.'], resolve)).toBe(false)
    expect(isCommand('  trans hello', ['#'], resolve)).toBe(true)
    expect(isCommand('hello jita', [], resolve)).toBe(false)
    expect(isCommand('.', ['.'], resolve)).toBe(false)
  })
})

// ------------------------------------------------------------------ client

describe('翻译请求', () => {
  it('请求体只有 model 和 messages，带 Authorization、术语参考和 <text>，去掉包裹的 <text>', async () => {
    llm.replies.push({ body: completion('<text>大家好 ⟦0⟧</text>') })
    const tr = translator()
    const r = await tr.translate(input('hello everyone ⟦0⟧', 'en2zh', { hints: ['Jita => 吉他', 'Amarr => 艾玛'], tokens: ['⟦0⟧'] }))
    expect(r).toEqual({ ok: true, text: '大家好 ⟦0⟧', promptTokens: 11, completionTokens: 7 })
    expect(llm.requests).toHaveLength(1)
    const req = llm.requests[0]
    expect(req.path).toBe('/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer sk-test-key')
    expect(Object.keys(req.json).sort()).toEqual(['messages', 'model'])
    expect(req.json.model).toBe('test-model')
    expect(req.json.messages).toHaveLength(2)
    expect(req.json.messages[0].role).toBe('system')
    expect(req.json.messages[1]).toEqual({ role: 'user', content: '术语参考：\nJita => 吉他\nAmarr => 艾玛\n\n<text>hello everyone ⟦0⟧</text>' })
  })

  it('服务器收到的只有传入的文字', async () => {
    llm.replies.push({ body: completion('see you at the gate') })
    const text = '门口见，⟦0⟧ 带上船'
    const r = await translator().translate(input(text, 'zh2en', { tokens: ['⟦0⟧'] }))
    expect(r.ok).toBe(false) // 译文丢了占位符
    const req = llm.requests[0]
    expect(req.json.messages[1].content).toBe(`<text>${text}</text>`)
    // system 提示词固定，不含任何名字或 ID
    const again = translator()
    llm.replies.push({ body: completion('x') })
    await again.translate(input('另一句话内容', 'zh2en'))
    expect(llm.requests[1].json.messages[0].content).toBe(req.json.messages[0].content)
  })

  it('4xx（内容风险、数据检查失败）→ 失败，不重试', async () => {
    const tr = translator()
    llm.replies.push({ status: 400, body: { error: { message: 'Content Exists Risk', type: 'invalid_request_error' } } })
    expect(await tr.translate(input('今晚一起去打架吗'))).toEqual({ ok: false, reason: 'HTTP 400' })
    llm.replies.push({ status: 400, body: { error: { code: 'data_inspection_failed', message: 'Input data may contain inappropriate content.' } } })
    expect(await tr.translate(input('今晚一起去打架吗'))).toEqual({ ok: false, reason: 'HTTP 400' })
    expect(llm.requests).toHaveLength(2)
    expect(tr.stats().failures).toEqual({ 'HTTP 400': 2 })
  })

  it('429 然后 200（在超时内）→ 重试一次成功', async () => {
    llm.replies.push({ status: 429, body: { error: { message: 'rate limited' } } }, { body: completion('anyone here?') })
    const tr = translator()
    const r = await tr.translate(input('有人吗'))
    expect(r).toMatchObject({ ok: true, text: 'anyone here?' })
    expect(llm.requests).toHaveLength(2)
    expect(tr.stats().requests).toBe(1)
  })

  it('503 两次 → 只重试一次', async () => {
    llm.replies.push({ status: 503 }, { status: 503 }, { status: 503 })
    const r = await translator().translate(input('有人吗'))
    expect(r).toEqual({ ok: false, reason: 'HTTP 503' })
    expect(llm.requests).toHaveLength(2)
  })

  it('超时 → 超时', async () => {
    config.timeoutMs = 200
    llm.replies.push({ delayMs: 1000, body: completion('late') })
    const started = Date.now()
    const r = await translator().translate(input('有人吗'))
    expect(r).toEqual({ ok: false, reason: '超时' })
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('空结果', async () => {
    llm.replies.push({ body: completion('  <text></text> ') })
    expect(await translator().translate(input('有人吗'))).toEqual({ ok: false, reason: '空结果' })
    llm.replies.push({ body: { choices: [] } })
    expect(await translator().translate(input('有人吗'))).toEqual({ ok: false, reason: '空结果' })
  })

  it('占位符不符：缺少、重复、多出', async () => {
    const tr = translator()
    const src = input('⟦0⟧ 到 ⟦1⟧ 集合', 'zh2en', { tokens: ['⟦0⟧', '⟦1⟧'] })
    for (const out of ['⟦0⟧ gather', '⟦0⟧ gather at ⟦1⟧ ⟦1⟧', '⟦0⟧ gather at ⟦1⟧ ⟦2⟧', '⟦0⟧ gather at ⟦ 1⟧']) {
      llm.replies.push({ body: completion(out) })
      expect(await tr.translate(src)).toEqual({ ok: false, reason: '占位符不符' })
    }
    llm.replies.push({ body: completion('Gather at ⟦1⟧, ⟦0⟧') })
    expect(await tr.translate(src)).toMatchObject({ ok: true, text: 'Gather at ⟦1⟧, ⟦0⟧' })
  })

  it('长度异常；「有人吗」这种短句不检查长度', async () => {
    const tr = translator()
    llm.replies.push({ body: completion('Hi') })
    expect(await tr.translate(input('今天晚上八点在老地方集合大家都来'))).toEqual({ ok: false, reason: '长度异常' })
    llm.replies.push({ body: completion('Is anyone here? I am asking because I would like to know whether there are any people around right now') })
    expect(await tr.translate(input('有人吗'))).toMatchObject({ ok: true })
    const en = 'we are forming up for the next operation right now'
    llm.replies.push({ body: completion('我们'.repeat(60)) })
    expect(await tr.translate(input(en, 'en2zh'))).toEqual({ ok: false, reason: '长度异常' })
    llm.replies.push({ body: completion('我们现在正在为下一次行动集合') })
    expect(await tr.translate(input(en, 'en2zh'))).toMatchObject({ ok: true })
  })

  it('拒绝翻译：普通的「I can\'t」「Sorry」不算；原文里有的也不算', async () => {
    const tr = translator()
    llm.replies.push({ body: completion("I can't make it tonight") })
    expect(await tr.translate(input('我今晚来不了'))).toEqual({ ok: true, text: "I can't make it tonight", promptTokens: 11, completionTokens: 7 })
    llm.replies.push({ body: completion('Sorry, lagging') })
    expect(await tr.translate(input('抱歉，卡了'))).toMatchObject({ ok: true, text: 'Sorry, lagging' })
    llm.replies.push({ body: completion('As an AI language model, I cannot translate this.') })
    expect(await tr.translate(input('帮我翻译一下这个'))).toEqual({ ok: false, reason: '拒绝翻译' })
    llm.replies.push({ body: completion('抱歉，这段内容无法翻译。') })
    expect(await tr.translate(input('this is some text here', 'en2zh'))).toEqual({ ok: false, reason: '拒绝翻译' })
    llm.replies.push({ body: completion('He said "as an AI" jokingly') })
    expect(await tr.translate(input('他开玩笑说 As an AI', 'zh2en'))).toMatchObject({ ok: true })
    llm.replies.push({ body: completion('He has an aim') })
    expect(await tr.translate(input('他有个目标'))).toMatchObject({ ok: true })
  })

  it('maxPerHour：滚动一小时', async () => {
    config.maxPerHour = 2
    let clock = 1_000_000
    const tr = translator(() => clock)
    llm.replies.push({ body: completion('one') }, { body: completion('two') }, { body: completion('three') })
    expect((await tr.translate(input('第一句话'))).ok).toBe(true)
    clock += 30 * 60_000
    expect((await tr.translate(input('第二句话'))).ok).toBe(true)
    expect(await tr.translate(input('第三句话'))).toEqual({ ok: false, reason: '超过每小时上限' })
    expect(llm.requests).toHaveLength(2)
    clock += 30 * 60_000 + 1
    expect(await tr.translate(input('第三句话'))).toMatchObject({ ok: true, text: 'three' })
  })

  it('计数：请求数、失败原因、token 用量', async () => {
    const tr = translator()
    llm.replies.push(
      { body: completion('hello', { prompt_tokens: 100, completion_tokens: 20 }) },
      { body: completion('', { prompt_tokens: 50, completion_tokens: 0 }) },
      { status: 401, body: { error: { message: 'bad key' } } },
    )
    await tr.translate(input('你好呀'))
    await tr.translate(input('你好呀'))
    await tr.translate(input('你好呀'))
    expect(tr.stats()).toEqual({ requests: 3, failures: { '空结果': 1, 'HTTP 401': 1 }, promptTokens: 150, completionTokens: 20 })
  })
})
