// PR A：A3 媒体大小上限、A4 @全体 查询超时。所有 ID 都是编造的，只连本机。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { download } from '../src/media'
import { AtAllGate } from '../src/atall'
import type { AtAllConfig } from '../src/config'
import type { Media, Msg } from '../src/types'

// ------------------------------------------------------------------ A3

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1020, 1)])

interface Hit { path: string; written: number; closedAt?: number }

let server: http.Server
let base = ''
let app: Context
const hits: Hit[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const hit: Hit = { path: req.url!, written: 0 }
    hits.push(hit)
    res.on('close', () => { hit.closedAt = Date.now() })
    // 慢慢写：每 20ms 写 64 KiB，直到连接关闭或写满 total 字节
    const slow = (total: number, withLength: boolean, status = 200, type = 'image/png') => {
      res.writeHead(status, withLength ? { 'content-type': type, 'content-length': String(total) } : { 'content-type': type })
      const chunk = Buffer.alloc(64 * 1024, 7)
      const timer = setInterval(() => {
        if (res.destroyed || hit.written >= total) {
          clearInterval(timer)
          if (!res.destroyed) res.end()
          return
        }
        res.write(chunk)
        hit.written += chunk.length
      }, 20)
      res.on('close', () => clearInterval(timer))
    }
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      res.end(PNG)
    } else if (req.url === '/huge-length') {
      slow(512 * 1024 * 1024, true)
    } else if (req.url === '/huge-chunked') {
      slow(512 * 1024 * 1024, false)
    } else if (req.url === '/slow-small') {
      slow(10 * 64 * 1024, false)
    } else if (req.url === '/error-page') {
      // 404 带一个 4 MB 的错误页（慢慢写，全部读完要 1 秒多）
      slow(4 * 1024 * 1024, false, 404, 'text/html')
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  app = new Context()
  app.plugin(HTTP as any)
  await app.start()
})

afterAll(async () => {
  await app?.stop()
  server?.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})

function media(path: string, extra: Partial<Media> = {}): Media {
  return { kind: 'image', urls: [base + path], name: '', placeholder: '[图片]', ...extra }
}

async function waitClosed(hit: Hit | undefined, ms = 2000) {
  const start = Date.now()
  while (hit && !hit.closedAt && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10))
  return hit?.closedAt
}

describe('A3 download 大小上限', () => {
  it('已知大小超上限：不发请求', async () => {
    const before = hits.length
    const file = await download(app, media('/ok.png', { size: 20 * 1024 * 1024 }), { maxBytes: 10 * 1024 * 1024 })
    expect(file).toBeNull()
    expect(hits.length).toBe(before)
  })

  it('Content-Length 超上限：立即中止，不读 body', async () => {
    const start = Date.now()
    const file = await download(app, media('/huge-length'), { maxBytes: 1024 * 1024 })
    const elapsed = Date.now() - start
    expect(file).toBeNull()
    expect(elapsed).toBeLessThan(1000)
    const hit = hits.find((h) => h.path === '/huge-length')
    expect(await waitClosed(hit)).toBeTruthy()
    expect(hit!.written).toBeLessThan(1024 * 1024)
  })

  it('没有 Content-Length 的分块 body：累计超上限就中止', async () => {
    const start = Date.now()
    const file = await download(app, media('/huge-chunked'), { maxBytes: 256 * 1024 })
    expect(file).toBeNull()
    expect(Date.now() - start).toBeLessThan(2000)
    const hit = hits.find((h) => h.path === '/huge-chunked')
    expect(await waitClosed(hit)).toBeTruthy()
    expect(hit!.written).toBeLessThan(2 * 1024 * 1024)
  })

  it('服务器回复 404 带很大的错误页：不读错误页，马上返回 null', async () => {
    const start = Date.now()
    const file = await download(app, media('/error-page'), { maxBytes: 10 * 1024 * 1024 })
    expect(file).toBeNull()
    expect(Date.now() - start).toBeLessThan(1000)
    const hit = hits.find((h) => h.path === '/error-page')
    expect(await waitClosed(hit)).toBeTruthy()
    expect(hit!.written).toBeLessThan(1024 * 1024)
  })

  it('正常图片：内容、mime、文件名不变', async () => {
    const file = await download(app, media('/ok.png', { size: PNG.length, name: 'shot' }), { maxBytes: 10 * 1024 * 1024 })
    expect(file).not.toBeNull()
    expect(Buffer.from(file!.data).equals(PNG)).toBe(true)
    expect(file!.mime).toBe('image/png')
    expect(file!.name).toBe('shot.png')
  })

  it('不设上限时照常下载分块 body', async () => {
    const file = await download(app, media('/slow-small'))
    expect(file?.data.byteLength).toBe(10 * 64 * 1024)
  })

  it('signal 中止：返回 null', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const start = Date.now()
    const file = await download(app, media('/huge-chunked'), { signal: controller.signal })
    expect(file).toBeNull()
    expect(Date.now() - start).toBeLessThan(1500)
  })

  it('已经中止的 signal：不发请求', async () => {
    const before = hits.length
    const controller = new AbortController()
    controller.abort()
    expect(await download(app, media('/ok.png'), { signal: controller.signal })).toBeNull()
    expect(hits.length).toBe(before)
  })
})

// ------------------------------------------------------------------ A4

const GROUP = '100000001'
const SELF = '200000002'

function fakeStore() {
  const map = new Map<string, unknown>()
  return {
    map,
    async hasSource() { return false },
    async get(key: string) { return map.get(key) },
    async set(key: string, value: unknown) { map.set(key, value) },
    async delete(key: string) { map.delete(key) },
  }
}

const config: AtAllConfig = { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10 }

function msg(): Msg {
  return {
    platform: 'discord', channelId: '300000003', messageId: '400000004', authorId: '500000005', author: 'someone',
    body: 'hi', blocks: [], media: [], mentionEveryone: true, silent: false, timestamp: Date.now(), backfill: false, checkText: 'hi',
  } as Msg
}

const never = () => new Promise<never>(() => {})
const REMAIN = { can_at_all: true, remain_at_all_count_for_group: 5, remain_at_all_count_for_uin: 5 }

function bot(over: { member?: () => Promise<any>; remain?: () => Promise<any> } = {}) {
  return {
    selfId: SELF,
    getGuildMember: over.member ?? (async () => ({ roles: ['admin'] })),
    internal: { getGroupAtAllRemain: over.remain ?? (async () => REMAIN) },
  }
}

function gate(store = fakeStore(), options = { queryTimeout: 80, decideTimeout: 200 }) {
  return new AtAllGate(store as any, () => config, () => '2026-01-01', Date.now, options)
}

describe('A4 @全体 查询超时', () => {
  it('正常路径不变：通过并能提交', async () => {
    const store = fakeStore()
    const d = await gate(store).decide(bot(), GROUP, msg())
    expect(d.ok).toBe(true)
    if (d.ok) await d.commit()
    expect(store.map.get(`atall:${GROUP}:2026-01-01`)).toBe(1)
  })

  it('getGroupAtAllRemain 永远不返回：按单个查询超时判查询失败', async () => {
    const start = Date.now()
    const d = await gate().decide(bot({ remain: never }), GROUP, msg())
    expect(d).toEqual({ ok: false, reason: '查询失败' })
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('getGuildMember 很慢：查询失败', async () => {
    const start = Date.now()
    const slow = () => new Promise((r) => setTimeout(() => r({ roles: ['admin'] }), 500))
    const g = gate()
    const d = await g.decide(bot({ member: slow }), GROUP, msg())
    expect(d).toEqual({ ok: false, reason: '查询失败' })
    expect(Date.now() - start).toBeLessThan(200)
    // 晚到的结果不写角色缓存
    await new Promise((r) => setTimeout(r, 550))
    expect((g as any).roleCache.has(GROUP)).toBe(false)
  })

  it('每个查询都没超时但总时间超限：查询失败，晚到结果不提交', async () => {
    const store = fakeStore()
    const step = <T>(v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), 60))
    const g = gate(store, { queryTimeout: 80, decideTimeout: 100 })
    const start = Date.now()
    const d = await g.decide(bot({ member: step({ roles: ['owner'] }), remain: step(REMAIN) }), GROUP, msg())
    expect(d).toEqual({ ok: false, reason: '查询失败' })
    expect(Date.now() - start).toBeLessThan(160)
    await new Promise((r) => setTimeout(r, 150))
    expect(store.map.size).toBe(0)
    expect(g.remain.has(GROUP)).toBe(false)
  })

  it('默认超时为 8 秒 / 15 秒', () => {
    const g = new AtAllGate(fakeStore() as any, () => config, () => '2026-01-01')
    expect((g as any).queryTimeout).toBe(8000)
    expect((g as any).decideTimeout).toBe(15000)
  })

  it('isAdmin 超时抛出', async () => {
    await expect(gate().isAdmin(bot({ member: never }), GROUP, true)).rejects.toThrow()
  })
})
