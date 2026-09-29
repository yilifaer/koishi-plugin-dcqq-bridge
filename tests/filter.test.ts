// 过滤：关键词表、审核 key 的选择、OpenAI 审核接口（模拟服务器）。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { KeywordFilter, Moderator, parseKeywordLines, resolveModerationKey } from '../src/filter'

type Reply = { status?: number; body?: any; delayMs?: number }

class FakeModeration {
  server!: http.Server
  base = ''
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders; json: any }> = []
  replies: Reply[] = []

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        this.requests.push({ path: req.url ?? '', headers: req.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') })
        const reply = this.replies.shift() ?? { body: {} }
        const send = () => {
          if (res.destroyed) return
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
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

const result = (flagged: boolean) => ({ id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged, categories: {} }] })

describe('关键词', () => {
  it('一行一个、# 注释、空行', () => {
    expect(parseKeywordLines('# 注释\n  foo  \n\r\nre:\\bass\\b\n   # 也是注释\nBar')).toEqual(['foo', 're:\\bass\\b', 'Bar'])
  })

  it('包含匹配和正则都不区分大小写；写错的正则只跳过那一条', () => {
    const { filter, errors } = KeywordFilter.compile(['Foo', 're:\\bass\\b', 're:([bad', '坏词'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('([bad')
    expect(filter.size).toBe(3)
    expect(filter.matches('some FOOBAR text')).toBe(true)
    expect(filter.matches('what an ASS')).toBe(true)
    expect(filter.matches('first class')).toBe(false)
    expect(filter.matches('这是坏词吗')).toBe(true)
    expect(filter.matches('([bad')).toBe(false)
    expect(filter.matches('')).toBe(false)
  })

  it('空表不命中', () => {
    const { filter, errors } = KeywordFilter.compile(parseKeywordLines('# 只有注释\n'))
    expect(errors).toEqual([])
    expect(filter.size).toBe(0)
    expect(filter.matches('anything')).toBe(false)
  })
})

describe('审核 key', () => {
  it('填了审核 key 就用它', () => {
    expect(resolveModerationKey('https://api.deepseek.com', 'sk-ds', 'https://api.openai.com/v1', 'sk-mod')).toBe('sk-mod')
  })
  it('同一个主机名 → 借用翻译 key', () => {
    expect(resolveModerationKey('https://API.openai.com/v1/', 'sk-oa', 'https://api.openai.com/v1', '')).toBe('sk-oa')
  })
  it('不同主机名 + 没填审核 key → null', () => {
    expect(resolveModerationKey('https://api.deepseek.com', 'sk-ds', 'https://api.openai.com/v1', '')).toBeNull()
    expect(resolveModerationKey('https://api.deepseek.com', 'sk-ds', 'https://api.openai.com/v1', '   ')).toBeNull()
    expect(resolveModerationKey('not a url', 'sk-ds', 'https://api.openai.com/v1', '')).toBeNull()
    expect(resolveModerationKey('https://api.openai.com/v1', '', 'https://api.openai.com/v1', '')).toBeNull()
  })
})

describe('审核接口', () => {
  const server = new FakeModeration()
  let app: Context
  let key: string | null

  beforeAll(async () => {
    await server.start()
    app = new Context()
    app.plugin(HTTP as any)
    await app.start()
  })
  afterAll(async () => {
    await app.stop()
    await server.stop()
  })
  beforeEach(() => {
    server.requests = []
    server.replies = []
    key = 'sk-mod'
  })

  const moderator = () => new Moderator(app.http, () => ({ baseURL: server.base + '/v1/', apiKey: key }))

  it('flagged true / false', async () => {
    server.replies.push({ body: result(true) }, { body: result(false) })
    expect(await moderator().check('bad text')).toEqual({ ok: true, flagged: true })
    expect(await moderator().check('good text')).toEqual({ ok: true, flagged: false })
    expect(server.requests[0].path).toBe('/v1/moderations')
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-mod')
    expect(server.requests[0].json).toEqual({ model: 'omni-moderation-latest', input: 'bad text' })
  })

  it('出错、结果无效 → ok:false', async () => {
    server.replies.push({ status: 500, body: { error: {} } }, { status: 401 }, { body: { results: [] } })
    expect(await moderator().check('x')).toEqual({ ok: false, reason: '审核 HTTP 500' })
    expect(await moderator().check('x')).toEqual({ ok: false, reason: '审核 HTTP 401' })
    expect(await moderator().check('x')).toEqual({ ok: false, reason: '审核结果无效' })
  })

  it('超时（3 秒）→ ok:false', async () => {
    server.replies.push({ delayMs: 4000, body: result(false) })
    expect(await moderator().check('x')).toEqual({ ok: false, reason: '审核超时' })
  })

  it('没有 key → 不发任何请求', async () => {
    key = null
    expect(await moderator().check('x')).toEqual({ ok: false, reason: '审核未配置密钥' })
    // 非 OpenAI 的翻译接口 + 没填审核 key
    key = resolveModerationKey('https://api.deepseek.com', 'sk-ds', server.base, '')
    expect(await moderator().check('x')).toEqual({ ok: false, reason: '审核未配置密钥' })
    expect(server.requests).toHaveLength(0)
  })
})
