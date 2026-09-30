// 0.3.1 补充清单 F1–F6：下载监听器、dispose 后的 lastseen、@全体 查询和队首时限、频道查询缓存、写错的桥、413 不截原文。
// 所有 ID、名字都是编造的；只连本机。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { getEventListeners } from 'node:events'
import { Context, Universal } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { afterEach, describe, expect, it } from 'vitest'
import { AtAllGate } from '../src/atall'
import { INVALID_ROW_KEY } from '../src/config'
import type { Config } from '../src/config'
import { DiscordSender, dropAll } from '../src/discord/api'
import { download } from '../src/media'
import { Relay } from '../src/relay'
import type { Msg } from '../src/types'
import {
  baseConfig, bridge, DC_CHANNEL, DC_CHANNEL2, DC_GUILD, discordId, Env, OWNER_QQ, QQ_GROUP, qqPayload, setup, sleep,
} from './harness'

let env: Env | undefined
let server: MediaServer | undefined
afterEach(async () => {
  await env?.stop()
  env = undefined
  await server?.close()
  server = undefined
})

interface MediaServer { base: string; close(): Promise<void> }

/** 本机的图片服务器；onRequest 在返回之前调用。 */
async function startMedia(options: { delayMs?: number; size?: number; onRequest?: () => void } = {}): Promise<MediaServer> {
  const s = http.createServer(async (req, res) => {
    options.onRequest?.()
    if (options.delayMs) await sleep(options.delayMs)
    res.setHeader('Content-Type', 'image/png')
    res.end(Buffer.alloc(options.size ?? 64, 7))
  })
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    close: () => {
      s.closeAllConnections?.()
      return new Promise<void>((resolve) => s.close(() => resolve()))
    },
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error('等待超时')
}

// ================================================================== F1

describe('F1 下载不在父 signal 上留下监听器', () => {
  it('同一个父 signal 下载 30 次：监听器数量不增长；父 signal 中止时进行中的下载也停', async () => {
    server = await startMedia()
    const app = new Context()
    app.plugin(HTTP as any)
    await app.start()
    try {
      const parent = new AbortController()
      const before = getEventListeners(parent.signal, 'abort').length
      for (let i = 0; i < 30; i++) {
        const file = await download(app, { kind: 'image', urls: [`${server.base}/a.png`], name: '', placeholder: '[图片]' }, { signal: parent.signal })
        expect(file?.data.byteLength).toBe(64)
      }
      // 失败的下载（404 之外的地址不可达）同样不留
      await download(app, { kind: 'image', urls: ['http://127.0.0.1:1/x.png'], name: '', placeholder: '[图片]' }, { signal: parent.signal })
      expect(getEventListeners(parent.signal, 'abort').length).toBe(before)

      // 中止仍然有效
      await server.close()
      server = await startMedia({ delayMs: 2000 })
      const started = Date.now()
      const pending = download(app, { kind: 'image', urls: [`${server.base}/slow.png`], name: '', placeholder: '[图片]' }, { signal: parent.signal })
      await sleep(100)
      expect(getEventListeners(parent.signal, 'abort').length).toBe(before + 1)
      parent.abort()
      expect(await pending).toBeNull()
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      await app.stop()
    }
  })
})

// ================================================================== F2

describe('F2 已经 dispose 的实例不再写 lastseen', () => {
  /** 装一个新的 Relay（不等 start 完成）。 */
  async function install(e: Env, config: Config) {
    let relay: Relay | undefined
    e.app.plugin({
      name: 'dcqq-bridge-f2',
      inject: ['database', 'http'],
      apply(ctx: Context) {
        relay = new Relay(ctx, config, { timers: false, now: () => e.clock.now })
        relay.install()
      },
    })
    for (let i = 0; i < 100 && !relay; i++) await sleep(10)
    if (!relay) throw new Error('新的 Relay 没有装上')
    const starting = relay.start()
    return { relay, starting }
  }

  it('两次很快的重载，第二次取消了一个桥：旧实例的重置循环不会把这个桥的 lastseen 写回去', async () => {
    env = await setup({ bridges: [bridge(), bridge({ discord: DC_CHANNEL2, qq: '555000222' })] })
    const e = env
    await e.relay.dispose()
    await e.relay.store.set(`lastseen:${DC_CHANNEL}`, '960000000000000001')
    e.dcBot.status = Universal.Status.ONLINE
    // 旧实例启动时查频道最新消息很慢
    e.discord.fault('GET', new RegExp(`^/channels/${DC_CHANNEL}$`), {
      status: 200, delayMs: 400, body: { id: DC_CHANNEL, guild_id: DC_GUILD, name: '测试频道', last_message_id: '960000000000000900' },
    })
    const first = await install(e, baseConfig({ bridges: [bridge(), bridge({ discord: DC_CHANNEL2, qq: '555000222' })] }))
    await waitFor(() => e.discord.requests.some((r) => r.method === 'GET' && r.path === `/channels/${DC_CHANNEL}`))
    // 第二次保存：取消第一个桥
    await first.relay.dispose()
    e.dcBot.status = Universal.Status.ONLINE
    const second = await install(e, baseConfig({ bridges: [bridge({ discord: DC_CHANNEL2, qq: '555000222' })] }))
    await second.starting
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBeUndefined()
    await first.starting
    await sleep(200)
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBeUndefined()
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL2}`)).toBeTruthy()
  })

  it('dispose 之后 flushLastseen 不再写；dispose 自己的最后一次照常写', async () => {
    env = await setup()
    const e = env
    const id = discordId()
    e.discordMessage({ id, content: 'x' })
    await e.idle()
    const relay: any = e.relay
    relay.disposed = true
    await e.relay.flushLastseen()
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBeUndefined()
    await e.relay.dispose()
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBe(id)
  })

  it('只有 q2d 桥的频道：收到消息也不写 lastseen', async () => {
    env = await setup({ bridges: [bridge({ direction: 'q2d' })] })
    env.discordMessage({ content: 'x' })
    await sleep(100)
    await env.relay.flushLastseen()
    expect(await env.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBeUndefined()
  })
})

// ================================================================== F3

describe('F3 @全体 查询和队首时限挂钩', () => {
  function msg(): Msg {
    return {
      platform: 'discord', channelId: '300000003', messageId: '400000004', authorId: '500000005', author: 'someone',
      body: 'hi', blocks: [], media: [], mentionEveryone: true, silent: false, timestamp: Date.now(), backfill: false, checkText: 'hi',
    } as Msg
  }
  const store: any = { get: async () => undefined, set: async () => {}, delete: async () => {}, hasSource: async () => false }
  const config = { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10 }
  const never = () => new Promise<never>(() => {})
  const bot = { selfId: '10000', getGuildMember: async () => ({ roles: ['admin'] }), internal: { getGroupAtAllRemain: never } }

  it('decide：最多到 deadline 前 10 秒；已经不够 10 秒时马上按查询失败', async () => {
    const gate = new AtAllGate(store, () => config, () => '2026-01-01', Date.now, { queryTimeout: 60000, decideTimeout: 15000 })
    let start = Date.now()
    expect(await gate.decide(bot, '555000111', msg(), Date.now() + 10300)).toEqual({ ok: false, reason: '查询失败' })
    const took = Date.now() - start
    expect(took).toBeGreaterThanOrEqual(250)
    expect(took).toBeLessThan(1000)
    start = Date.now()
    expect(await gate.decide(bot, '555000111', msg(), Date.now() + 9000)).toEqual({ ok: false, reason: '查询失败' })
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('getGroupAtAllRemain 永远不返回：到整体超时就改发带 fallbackText 的文字', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    ;(env.qqBot.internal as any).getGroupAtAllRemain = never
    // 缩短整体超时（正式是 15 秒），单个查询不超时
    Object.assign(env.relay.gate as any, { decideTimeout: 300, queryTimeout: 60000 })
    const start = Date.now()
    env.discordMessage({ content: '@everyone 集合', mention_everyone: true })
    await waitFor(() => env!.qq.sent.length > 0)
    expect(Date.now() - start).toBeLessThan(1500)
    expect(env.qq.text()[0]).toContain('【全体通知】')
    expect(env.qq.text()[0]).not.toContain('<@全体>')
  })

  it('准备阶段已经用掉 50 秒：查询卡住也在时限之前放弃，fallbackText 文字照常发出', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    const e = env
    ;(e.qqBot.internal as any).getGroupAtAllRemain = never
    // 整体超时保持正式的 15 秒；只剩 60 - 49.6 - 10 = 0.4 秒可以查
    Object.assign(e.relay.gate as any, { queryTimeout: 60000 })
    server = await startMedia({ delayMs: 100, onRequest: () => void (e.clock.now += 49600) })
    const start = Date.now()
    e.discordMessage({
      content: '@everyone 集合', mention_everyone: true,
      attachments: [{ id: discordId(), filename: 'a.png', content_type: 'image/png', size: 64, url: `${server.base}/a.png` }],
    })
    await waitFor(() => e.qq.text().some((t) => t.includes('【全体通知】')), 5000)
    expect(Date.now() - start).toBeLessThan(3000)
    expect(e.qq.text().join()).not.toContain('<@全体>')
  })
})

// ================================================================== F4

describe('F4 频道信息查不到时缓存 60 秒', () => {
  it('提到看不到的频道：60 秒内只查一次，过了 60 秒再查', async () => {
    env = await setup({ bridges: [bridge({ direction: 'd2q' })] })
    const hidden = '920000000000000099'
    const gets = () => env!.discord.requests.filter((r) => r.method === 'GET' && r.path === `/channels/${hidden}`).length
    env.discordMessage({ content: `去 <#${hidden}>` })
    await env.idle()
    env.discordMessage({ content: `再去 <#${hidden}>` })
    await env.idle()
    expect(env.qq.sent).toHaveLength(2)
    expect(gets()).toBe(1)
    env.clock.now += 61000
    env.discordMessage({ content: `还去 <#${hidden}>` })
    await env.idle()
    expect(gets()).toBe(2)
  })
})

// ================================================================== F5

describe('F5 写错的桥在 bridge.status 最上面提示', () => {
  const broken = { [INVALID_ROW_KEY]: true } as any

  it('群里、私聊不加 -a 都在最上面看到；-a 时那一行照常显示', async () => {
    env = await setup({ bridges: [bridge(), broken, bridge({ qq: 'abc' })] })
    expect(env.relay.settings.problems).toEqual([
      '第 2 行桥有写错的字段，已跳过（到控制台表格里检查第 2 行）',
      '第 3 行桥无效，已跳过：QQ 群号必须是纯数字（到控制台表格里检查第 3 行）',
    ])
    const group = (await env.command(OWNER_QQ, 'bridge.status', QQ_GROUP)).join('\n').split('\n')
    expect(group[1]).toBe('⚠ 第 2 行桥有写错的字段，已跳过（到控制台表格里检查第 2 行）')
    expect(group[2]).toContain('第 3 行桥无效')
    const dm = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(dm).toContain('⚠ 第 2 行桥有写错的字段，已跳过（到控制台表格里检查第 2 行）')
    // 每个问题只出现一次
    expect(dm.split('第 2 行桥有写错的字段').length).toBe(2)
  })

  it('没有写错的行：没有这类提示', async () => {
    env = await setup()
    expect(env.relay.settings.problems.some((p) => p.includes('行桥'))).toBe(false)
  })
})

// ================================================================== F6

describe('F6 413 重试时不截用户的文字', () => {
  const sym = Symbol.for('cordis.http.error')
  const tooLarge = () => Object.assign(new Error('413'), { [sym]: true, response: { status: 413, data: { message: 'Request entity too large', code: 40005 }, headers: new Headers() } })
  const file = (placeholder: string) => ({ name: 'a.png', mime: 'image/png', data: new ArrayBuffer(10), placeholder })

  function fake() {
    const calls: any[] = []
    const fn: any = async (_url: string, init: any) => {
      calls.push(init)
      if (calls.length === 1) throw tooLarge()
      return { data: { id: String(950000000000000000n + BigInt(calls.length)) } }
    }
    fn.isError = (e: any) => !!e?.[sym]
    const warns: string[] = []
    const sender = new DiscordSender({ warn: (m: string) => void warns.push(m) })
    return { bot: { selfId: '900000000000000001', http: fn }, calls, sender, warns }
  }
  const options = () => ({ signal: new AbortController().signal, deadline: Date.now() + 60000, sleep: async () => {} })

  it('1990 字的原文：原文原样发出，占位文字另发一条，两个 ID 都返回', async () => {
    const f = fake()
    const content = '字'.repeat(1990)
    const result = await f.sender.send(f.bot, DC_CHANNEL, { content, username: '小明', files: [file('[图片]'), file('[图片]')] }, null, options())
    expect(f.calls).toHaveLength(3)
    expect(f.calls[1].data.content).toBe(content)
    expect(f.calls[2].data.content).toBe('\\[图片\\]\n\\[图片\\]')
    expect(result).toMatchObject({ ok: true, messageId: '950000000000000002', extraIds: ['950000000000000003'] })
  })

  it('放得下就跟在后面；逐个放不下时合成一句', () => {
    const p = (content: string, n: number, placeholder = '[图片]') => ({ content, files: Array.from({ length: n }, () => file(placeholder)) })
    expect(dropAll(p('短', 2))).toEqual({ payload: { content: '短\n\\[图片\\]\n\\[图片\\]', files: [] } })
    const long = 'a'.repeat(1950)
    const merged = dropAll(p(long, 5, '[图片 很长很长很长很长很长的名字]'))
    expect(merged.payload.content).toBe(`${long}\n\\[另有 5 个文件过大未发送\\]`)
    expect(merged.extra).toBeUndefined()
    // 没有原文：占位文字太多时也合成一句
    expect(dropAll(p('', 300)).payload.content).toBe('\\[另有 300 个文件过大未发送\\]')
  })

  it('relay：QQ 发来 1996 字加图片，Discord 413 → 原文完整，提示另发', async () => {
    server = await startMedia({ size: 500 })
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { status: 413, body: { message: 'Request entity too large', code: 40005 } })
    const long = 'b'.repeat(1996)
    const payload = qqPayload([
      { type: 'text', data: { text: long } },
      { type: 'image', data: { file: 'a.png', url: `${server.base}/a.png` } },
    ])
    await env.qqMessage(payload)
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(3)
    expect(posts[1].json.content).toBe(long)
    expect(posts[2].json.content).toMatch(/图片/)
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).forwards).toBe(1)
    // 两条都记进对应表
    const rows = await env.relay.store.bySource(QQ_GROUP, String(payload.message_id))
    expect(rows.map((r) => r.dstMessage).sort()).toEqual([posts[1], posts[2]].map(() => expect.any(String)))
    expect(rows).toHaveLength(2)
  })
})
