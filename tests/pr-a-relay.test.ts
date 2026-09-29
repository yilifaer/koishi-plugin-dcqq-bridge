// PR A（0.2.1）的 A1、A2、A5、A7 测试：重载时的回声、补发触发、Discord 413/429、预处理和队列。所有 ID、名字都是编造的；只连 localhost。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Universal } from 'koishi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiscordSender } from '../src/discord/api'
import { fileBatches } from '../src/relay'
import {
  baseConfig, bridge, DC_BOT, DC_CHANNEL, DC_CHANNEL2, discordId, discordPayload, Env, installRelay, qqPayload, QQ_GROUP, setup, sleep,
} from './harness'

let env: Env | undefined
let media: MediaServer | undefined
afterEach(async () => {
  await env?.stop()
  env = undefined
  await media?.close()
  media = undefined
})

// ------------------------------------------------------------------ 小工具

interface MediaServer { base: string; close(): Promise<void> }

/** 本机的图片服务器：路径 → 延迟和大小。 */
async function startMedia(routes: Record<string, { delayMs?: number; size?: number }>): Promise<MediaServer> {
  const server = http.createServer(async (req, res) => {
    const route = routes[(req.url ?? '/').split('?')[0]]
    if (!route) {
      res.statusCode = 404
      return res.end()
    }
    if (route.delayMs) await sleep(route.delayMs)
    res.setHeader('Content-Type', 'image/png')
    res.end(Buffer.alloc(route.size ?? 64, 7))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections?.()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function image(url: string, filename = 'pic.png', size = 64) {
  return { id: discordId(), filename, content_type: 'image/png', size, url }
}

const text = (t: string) => [{ type: 'text', data: { text: t } }]

function snowflakeAt(ms: number, seq: number) {
  return String(((BigInt(Math.floor(ms)) - 1420070400000n) << 22n) + BigInt(seq))
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error('等待超时')
}

function dispatchReady(e: Env) {
  e.dcBot.dispatch(e.dcBot.session({ type: 'internal', _type: 'discord/ready', _data: { user: { id: DC_BOT, username: 'bridge-bot' }, session_id: 's1' } }))
}

function historyGets(e: Env, channel = DC_CHANNEL) {
  return e.discord.requests.filter((r) => r.method === 'GET' && r.path.startsWith(`/channels/${channel}/messages`))
}

// ================================================================== A1

describe('A1 重载时的回声和双实例', () => {
  for (const clearOwn of [false, true]) {
    it(`webhook POST 进行中重载，回声先于 HTTP 响应 → 不回 QQ${clearOwn ? '（新实例集合为空，靠适配器缓存）' : ''}`, async () => {
      env = await setup()
      const e = env
      let reloaded = false
      e.discord.beforeRespond = async (req, id) => {
        const m = /^\/webhooks\/(\d+)\//.exec(req.path)
        if (!m || reloaded) return
        reloaded = true
        // 旧实例停用、新实例装上；这时 HTTP 响应还没回来，对应表里也还没有这条
        await e.relay.dispose()
        const { relay } = await installRelay(e, baseConfig())
        if (clearOwn) relay.sender.ownWebhooks.clear()
        else expect(relay.sender.ownWebhooks.has(m[1])).toBe(true)
        e.discordMessage({ id, webhook_id: m[1], author: { id: m[1], username: req.json?.username, bot: true }, content: req.json?.content })
        await sleep(150)
      }
      await e.qqMessage(qqPayload(text('ping')))
      await waitFor(() => reloaded && e.discord.posts().length === 1)
      await sleep(400)
      expect(e.discord.posts()).toHaveLength(1)
      expect(e.qq.sent).toHaveLength(0)
    })
  }

  it('dispose 之后不再调用 gate.decide，也不再发送', async () => {
    media = await startMedia({ '/slow.png': { delayMs: 300 } })
    env = await setup({ bridges: [bridge({ atAll: true })] })
    const decide = vi.spyOn(env.relay.gate, 'decide')
    // 对照：正常时会调用
    env.discordMessage({ content: '@everyone 集合', mention_everyone: true })
    await env.idle()
    expect(decide).toHaveBeenCalledTimes(1)
    const sent = env.qq.sent.length
    // 预处理进行中（图片下载慢）dispose
    env.discordMessage({ content: '@everyone 再集合', mention_everyone: true, attachments: [image(`${media.base}/slow.png`)] })
    await sleep(50)
    await env.relay.dispose()
    await sleep(600)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(env.qq.sent).toHaveLength(sent)
    // QQ → Discord 也不再发
    await env.qqMessage(qqPayload(text('之后')))
    await sleep(200)
    expect(env.discord.posts()).toHaveLength(0)
  })
})

// ================================================================== A2

describe('A2 补发触发', () => {
  /** 旧实例停掉，数据库里放好上一次运行留下的 lastseen 和 alive。 */
  async function previousRun(e: Env, lastseen: string, aliveAgo: number) {
    await e.relay.dispose()
    await e.relay.store.set(`lastseen:${DC_CHANNEL}`, lastseen)
    await e.relay.store.set('alive', e.clock.now - aliveAgo)
  }

  it('停用 3 小时后启用，READY → 不补发，只把 lastseen 设成最新', async () => {
    const t = Date.now()
    const latest = snowflakeAt(t - 1000, 9)
    env = await setup({}, { before: ({ discord }) => void (discord.channels.get(DC_CHANNEL)!.last_message_id = latest) })
    const e = env
    await previousRun(e, snowflakeAt(t - 3 * 3600000 - 60000, 1), 3 * 3600000)
    e.discord.history.set(DC_CHANNEL, [discordPayload({ id: snowflakeAt(t - 3600000, 1), content: '停用期间' })])
    const { relay } = await installRelay(e, baseConfig())
    dispatchReady(e)
    await waitFor(async () => (await relay.store.get<string>(`lastseen:${DC_CHANNEL}`)) === latest)
    await sleep(200)
    expect(historyGets(e)).toHaveLength(0)
    expect(e.qq.sent).toHaveLength(0)
  })

  it('只停了 5 分钟（例如重启），READY → 补发', async () => {
    const t = Date.now()
    env = await setup()
    const e = env
    await previousRun(e, snowflakeAt(t - 10 * 60000, 1), 5 * 60000)
    e.discord.history.set(DC_CHANNEL, [discordPayload({ id: snowflakeAt(t - 7 * 60000, 1), content: '重启期间' })])
    await installRelay(e, baseConfig())
    dispatchReady(e)
    await waitFor(() => e.qq.sent.length === 1)
    expect(e.qq.text()[0]).toBe('[测试桥 - 舰长（补发）]\n重启期间')
    expect(historyGets(e)[0].path).toContain(`after=${snowflakeAt(t - 10 * 60000, 1)}`)
  })

  it('没有 alive 记录（从旧版本升级）→ 按停了太久处理，不补发', async () => {
    const t = Date.now()
    env = await setup()
    const e = env
    await e.relay.dispose()
    await e.relay.store.set(`lastseen:${DC_CHANNEL}`, snowflakeAt(t - 10 * 60000, 1))
    await e.relay.store.delete('alive')
    e.discord.history.set(DC_CHANNEL, [discordPayload({ id: snowflakeAt(t - 7 * 60000, 1), content: '升级期间' })])
    const { relay } = await installRelay(e, baseConfig())
    dispatchReady(e)
    await waitFor(async () => (await relay.store.get<string>(`lastseen:${DC_CHANNEL}`)) !== snowflakeAt(t - 10 * 60000, 1))
    await sleep(200)
    expect(historyGets(e)).toHaveLength(0)
    expect(e.qq.sent).toHaveLength(0)
  })

  it('桥取消勾选再勾选 → lastseen 被删掉，不补发', async () => {
    const t = Date.now()
    const latest = snowflakeAt(t - 1000, 9)
    env = await setup({}, { before: ({ discord }) => void (discord.channels.get(DC_CHANNEL)!.last_message_id = latest) })
    const e = env
    await previousRun(e, snowflakeAt(t - 3600000, 1), 0)
    const off = await installRelay(e, baseConfig({ bridges: [bridge({ enabled: false })] }))
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBeUndefined()
    off.dispose()
    await sleep(50)
    e.discord.history.set(DC_CHANNEL, [discordPayload({ id: snowflakeAt(t - 1800000, 1), content: '停用期间' })])
    const { relay } = await installRelay(e, baseConfig())
    dispatchReady(e)
    await waitFor(async () => (await relay.store.get<string>(`lastseen:${DC_CHANNEL}`)) === latest)
    await sleep(200)
    expect(historyGets(e)).toHaveLength(0)
    expect(e.qq.sent).toHaveLength(0)
  })

  it('只剩 q2d 桥的频道：lastseen 被删掉', async () => {
    env = await setup()
    const e = env
    await previousRun(e, snowflakeAt(Date.now() - 3600000, 1), 0)
    await installRelay(e, baseConfig({ bridges: [bridge({ direction: 'q2d' })] }))
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBeUndefined()
  })

  it('重载时 Discord 已经在线 → 不补发，lastseen 设成频道最新的消息', async () => {
    const t = Date.now()
    const latest = snowflakeAt(t - 1000, 9)
    env = await setup({}, { before: ({ discord }) => void (discord.channels.get(DC_CHANNEL)!.last_message_id = latest) })
    const e = env
    // 刚刚还在运行（alive 很新）也一样不补发
    await previousRun(e, snowflakeAt(t - 3600000, 1), 30000)
    e.discord.history.set(DC_CHANNEL, [discordPayload({ id: snowflakeAt(t - 1800000, 1), content: '重载期间' })])
    e.dcBot.status = Universal.Status.ONLINE
    const { relay } = await installRelay(e, baseConfig())
    expect(await relay.store.get(`lastseen:${DC_CHANNEL}`)).toBe(latest)
    await sleep(200)
    expect(historyGets(e)).toHaveLength(0)
    expect(e.qq.sent).toHaveLength(0)
  })

  it('运行中 READY → 补发，起点用数据库里的值，不用被实时消息推高的内存值（F3）', async () => {
    const t = Date.now()
    env = await setup()
    const e = env
    e.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await e.idle()
    await e.relay.heartbeat()
    expect(await e.relay.store.get('alive')).toBe(e.clock.now)
    expect(await e.relay.store.get(`lastseen:${DC_CHANNEL}`)).toBe(snowflakeAt(t - 3600000, 1))
    // 一条更新的消息把内存里的 lastseen 推高（还没写进数据库）
    e.discordMessage({ id: snowflakeAt(t - 1000, 1), content: '较新' })
    await e.idle()
    e.discord.history.set(DC_CHANNEL, [
      discordPayload({ id: snowflakeAt(t - 1800000, 1), content: '缺口' }),
      discordPayload({ id: snowflakeAt(t - 1000, 1), content: '较新' }),
    ])
    dispatchReady(e)
    await waitFor(() => historyGets(e).length > 0)
    await sleep(100)
    await e.idle()
    expect(historyGets(e)[0].path).toContain(`after=${snowflakeAt(t - 3600000, 1)}`)
    const texts = e.qq.text()
    expect(texts).toHaveLength(3)
    expect(texts[2]).toBe('[测试桥 - 舰长（补发）]\n缺口')
  })
})

// ================================================================== A5

describe('A5 Discord 413 / 429', () => {
  const sym = Symbol.for('cordis.http.error')
  const httpError = (status: number, data: any, headers: Record<string, string> = {}) =>
    Object.assign(new Error(String(status)), { [sym]: true, response: { status, data, headers: new Headers(headers) } })

  /** 假的 bot.http：按调用次序返回结果；另有一个假时钟，sleep 只推进时钟。 */
  function fake(respond: (url: string, n: number, init: any) => any) {
    const clock = { now: 1_000_000 }
    const calls: Array<{ url: string; init: any; at: number }> = []
    const fn: any = async (url: string, init: any) => {
      calls.push({ url, init, at: clock.now })
      const result = respond(url, calls.length, init)
      if (result instanceof Error) throw result
      return { data: { id: String(950000000000000000n + BigInt(calls.length)) } }
    }
    fn.isError = (e: any) => !!e?.[sym]
    const waits: number[] = []
    const warns: string[] = []
    const sender = new DiscordSender({ warn: (msg: string) => void warns.push(msg) })
    const options = (ms = 60000) => ({
      signal: new AbortController().signal,
      deadline: clock.now + ms,
      now: () => clock.now,
      sleep: async (wait: number) => {
        waits.push(wait)
        clock.now += Math.max(1, wait)
      },
    })
    return { bot: { selfId: DC_BOT, http: fn }, calls, waits, warns, sender, clock, options }
  }

  it('429 没有 retry_after 也没有 Retry-After → 至少等 2 秒再试', async () => {
    const f = fake((_, n) => (n === 1 ? httpError(429, { message: 'You are being rate limited.' }) : null))
    const result = await f.sender.send(f.bot, DC_CHANNEL, { content: 'x', files: [] }, null, f.options())
    expect(result.ok).toBe(true)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1].at - f.calls[0].at).toBeGreaterThanOrEqual(2000)
  })

  it('一直 429 → 最多重试 5 次后放弃', async () => {
    const f = fake(() => httpError(429, { retry_after: 0.1 }))
    const result = await f.sender.send(f.bot, DC_CHANNEL, { content: 'x', files: [] }, null, f.options())
    expect(result).toMatchObject({ ok: false, maybeSent: false })
    expect(f.calls).toHaveLength(6)
  })

  it('记下每个目标的限流时间：后面发往同一目标的先等，别的目标不受影响；等不到就放弃并写日志', async () => {
    const f = fake((url, n) => (n === 1 ? httpError(429, { retry_after: 30, global: false }) : null))
    // 第一条：要等 30 秒，但只剩 10 秒 → 放弃
    const first = await f.sender.send(f.bot, DC_CHANNEL, { content: 'a', files: [] }, null, f.options(10000))
    expect(first.ok).toBe(false)
    expect(f.calls).toHaveLength(1)
    // 别的频道：不用等
    const other = await f.sender.send(f.bot, DC_CHANNEL2, { content: 'b', files: [] }, null, f.options())
    expect(other.ok).toBe(true)
    expect(f.calls[1].at).toBe(f.calls[0].at)
    // 同一频道、期限不够：不发请求，直接放弃并写日志
    const short = await f.sender.send(f.bot, DC_CHANNEL, { content: 'c', files: [] }, null, f.options(5000))
    expect(short).toMatchObject({ ok: false, maybeSent: false })
    expect(f.calls).toHaveLength(2)
    expect(f.warns.some((w) => w.includes('限流'))).toBe(true)
    // 同一频道、期限够：等到限流结束再发
    const later = await f.sender.send(f.bot, DC_CHANNEL, { content: 'd', files: [] }, null, f.options())
    expect(later.ok).toBe(true)
    expect(f.calls[2].at - f.calls[0].at).toBeGreaterThanOrEqual(30000)
  })

  it('全局限流 → 所有目标都等', async () => {
    const f = fake((url, n) => (n === 1 ? httpError(429, { retry_after: 5, global: true }) : null))
    await f.sender.send(f.bot, DC_CHANNEL, { content: 'a', files: [] }, null, f.options(1000))
    const other = await f.sender.send(f.bot, DC_CHANNEL2, { content: 'b', files: [] }, null, f.options())
    expect(other.ok).toBe(true)
    expect(f.calls[1].at - f.calls[0].at).toBeGreaterThanOrEqual(5000)
  })

  it('Retry-After 头也认', async () => {
    const f = fake((_, n) => (n === 1 ? httpError(429, {}, { 'retry-after': '7' }) : null))
    await f.sender.send(f.bot, DC_CHANNEL, { content: 'x', files: [] }, null, f.options())
    expect(f.calls[1].at - f.calls[0].at).toBeGreaterThanOrEqual(7000)
  })

  it('413 → 这一批的所有文件都换成占位文字，重发一次（不带文件）', async () => {
    const f = fake((_, n) => (n === 1 ? httpError(413, { message: 'Request entity too large', code: 40005 }) : null))
    const file = (name: string, placeholder: string) => ({ name, mime: 'image/png', data: new ArrayBuffer(10), placeholder })
    const result = await f.sender.send(f.bot, DC_CHANNEL, { content: '两张', files: [file('a.png', '[图片 A]'), file('b.png', '[图片 B]')] }, null, f.options())
    expect(result.ok).toBe(true)
    expect(f.calls[0].init.data).toBeInstanceOf(FormData)
    expect(f.calls[1].init.data).not.toBeInstanceOf(FormData)
    expect(f.calls[1].init.data.content).toBe('两张\n\\[图片 A\\]\n\\[图片 B\\]')
  })

  it('按总大小分批：每批不超过 24 MiB、不超过 10 个', () => {
    const f = (mb: number) => ({ data: new ArrayBuffer(mb * 1024 * 1024) })
    expect(fileBatches([f(10), f(10), f(10)]).map((b) => b.length)).toEqual([2, 1])
    expect(fileBatches([f(8), f(8), f(8), f(1)]).map((b) => b.length)).toEqual([3, 1])
    expect(fileBatches(Array.from({ length: 12 }, () => ({ data: new ArrayBuffer(10) }))).map((b) => b.length)).toEqual([10, 2])
    expect(fileBatches([])).toEqual([])
  })

  it('QQ 发来 3 张 9 MiB 的图片 → 分两次发（2 + 1）', async () => {
    const size = 9 * 1024 * 1024
    media = await startMedia({ '/a.png': { size }, '/b.png': { size }, '/c.png': { size } })
    env = await setup()
    await env.qqMessage(qqPayload([
      { type: 'text', data: { text: '三张' } },
      ...['a', 'b', 'c'].map((n) => ({ type: 'image', data: { file: `${n}.png`, url: `${media!.base}/${n}.png` } })),
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts.map((p) => p.files.length)).toEqual([2, 1])
    expect(posts[0].json.content).toBe('三张')
  })
})

// ================================================================== A7

describe('A7 预处理和队列', () => {
  it('Discord → QQ 的预处理堵住时，QQ → Discord 不受影响（两个方向各一个限流器）', async () => {
    media = await startMedia({ '/slow.png': { delayMs: 1500 } })
    env = await setup()
    for (let i = 0; i < 5; i++) env.discordMessage({ content: `慢${i}`, channel_id: DC_CHANNEL, attachments: [image(`${media.base}/slow.png`)] })
    const start = Date.now()
    await env.qqMessage(qqPayload(text('快')))
    await waitFor(() => env!.discord.posts().length === 1, 1000)
    expect(Date.now() - start).toBeLessThan(1000)
    await env.idle()
  })

  it('群成员名字查询卡住：并行查、每个最多 5 秒，超时的短时间内不再查', async () => {
    env = await setup()
    const e = env
    const handle = e.qq.handle.bind(e.qq)
    e.qq.handle = (action: string, params: any) => {
      if (action === 'get_group_member_info' && ['20005', '20006'].includes(String(params.user_id))) {
        e.qq.calls.push({ action, params })
        return new Promise(() => {})
      }
      return handle(action, params)
    }
    const at = (id: string) => ({ type: 'at', data: { qq: id } })
    const start = Date.now()
    await e.qqMessage(qqPayload([at('20005'), { type: 'text', data: { text: ' ' } }, at('20006'), { type: 'text', data: { text: ' 集合' } }]))
    await waitFor(() => e.discord.posts().length === 1, 9000)
    const took = Date.now() - start
    expect(took).toBeGreaterThanOrEqual(4500)
    expect(took).toBeLessThan(8000)
    expect(e.discord.posts()[0].json.content).toContain('@20005')
    const lookups = () => e.qq.calls.filter((c) => c.action === 'get_group_member_info').length
    const before = lookups()
    const again = Date.now()
    await e.qqMessage(qqPayload([at('20005'), { type: 'text', data: { text: ' 再来' } }]))
    await waitFor(() => e.discord.posts().length === 2, 2000)
    expect(Date.now() - again).toBeLessThan(1500)
    expect(lookups()).toBe(before)
  }, 15000)

  it('成为队首时已经排了超过 maxQueueAgeMinutes → 丢掉并记失败；0 = 不限制', async () => {
    for (const minutes of [15, 0]) {
      env = await setup({ maxQueueAgeMinutes: minutes })
      const e = env
      let first = true
      e.discord.beforeRespond = async () => {
        if (!first) return
        first = false
        // 第一条发送期间过了 16 分钟
        e.clock.now += 16 * 60000
      }
      await e.qqMessage(qqPayload(text('A')))
      await e.qqMessage(qqPayload(text('B')))
      await e.idle()
      const contents = e.discord.posts().map((p) => p.json.content)
      if (minutes) {
        expect(contents).toEqual(['A'])
        expect(e.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).lastFailure?.reason).toMatch(/在队列里等了 16 分钟/)
      } else {
        expect(contents).toEqual(['A', 'B'])
      }
      await e.stop()
      env = undefined
    }
  })

  it('所有目标处理完后丢掉下载好的文件', async () => {
    env = await setup()
    const prepared = { msg: null, images: [{ name: 'a.png', mime: 'image/png', data: new ArrayBuffer(8), placeholder: '[图片]' }], videos: [{ url: 'x', placeholder: '[视频]' }], blocked: new Set() }
    const release = (env.relay as any).releaseAfter(Promise.resolve(prepared), 2)
    release()
    await sleep(0)
    expect(prepared.images).toHaveLength(1)
    release()
    await sleep(0)
    expect(prepared.images).toHaveLength(0)
    expect(prepared.videos).toHaveLength(0)
  })
})
