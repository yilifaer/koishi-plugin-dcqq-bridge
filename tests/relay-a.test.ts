// 管道集成测试（清单 §18.1：B1、B2、B6、B7、B8、S12、对应表清理）。所有 ID 和名字都是编造的，只连本机。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, h, Universal } from 'koishi'
import { OneBotBot } from 'koishi-plugin-adapter-onebot'
import type { Config } from '../src/config'
import { classify, DiscordSender } from '../src/discord/api'
import { sendQQ } from '../src/qq/api'
import { Relay } from '../src/relay'
import { snowflakeFromTime } from '../src/util'
import {
  bridge, DC_BOT, DC_CHANNEL, DC_CHANNEL2, DC_GUILD, DC_USER, discordId, discordPayload, Env, flatten,
  QQ_BOT, QQ_GROUP, QQ_GROUP2, QQ_USER, qqPayload, setup, sleep, PR2_DEFAULTS } from './harness'

let env: Env | undefined
let media: MediaServer | undefined
afterEach(async () => {
  await env?.stop()
  env = undefined
  await media?.close()
  media = undefined
})

// ------------------------------------------------------------------ 小工具

interface Route { status?: number; delayMs?: number; size?: number; type?: string }
interface MediaServer { base: string; hits: Map<string, number>; close(): Promise<void> }

/** 本机的图片服务器（ctx.http 从这里下载）。 */
async function startMedia(routes: Record<string, Route>): Promise<MediaServer> {
  const hits = new Map<string, number>()
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    hits.set(path, (hits.get(path) ?? 0) + 1)
    const route = routes[path]
    if (!route) {
      res.statusCode = 404
      return res.end()
    }
    if (route.delayMs) await sleep(route.delayMs)
    res.statusCode = route.status ?? 200
    res.setHeader('Content-Type', route.type ?? 'image/png')
    res.end(route.status && route.status >= 400 ? 'error' : Buffer.alloc(route.size ?? 64, 7))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    hits,
    close: () => {
      server.closeAllConnections?.()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function image(url: string, filename = 'pic.png', size = 64) {
  return { id: discordId(), filename, content_type: 'image/png', size, url }
}

function cfg(patch: Partial<Config> = {}): Config {
  return {
    discordSelfId: '', qqSelfId: '', timezone: 'Asia/Shanghai', discordAsWebhook: true, keepDays: 7, authority: 4, qqReorderMs: 0,
    bridges: [bridge()],
    atAll: { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10 },
    ...PR2_DEFAULTS,
    ...patch,
  }
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时')
    await sleep(10)
  }
}

const text = (t: string) => [{ type: 'text', data: { text: t } }]
const sendCalls = (e: Env) => e.qq.calls.filter((c) => c.action === 'send_group_msg')
const isAtAll = (seg: any) => seg.type === 'at' && seg.data.qq === 'all'
const hasAtAll = (segments: any[]) => segments.some(isAtAll)

async function mappings(e: Env, query: Record<string, string>) {
  return e.app.database.get('dcqqbridge_message', query as any)
}

/** 一条 QQ 消息转到 Discord，返回 QQ 消息 ID 和 Discord 消息 ID。 */
async function forwardFromQQ(e: Env, content = '来自 QQ 的消息') {
  const payload = qqPayload(text(content))
  await e.qqMessage(payload)
  await e.idle()
  const [row] = await mappings(e, { srcChannel: QQ_GROUP, srcMessage: String(payload.message_id) })
  expect(row).toBeTruthy()
  return { qqId: String(payload.message_id), discordId: row.dstMessage, payload }
}

// ------------------------------------------------------------------ B1

describe('B1 配置的运行时检查', () => {
  it('重复只在启用的行之间检查：停用的行不挡住后面同一对的启用行', async () => {
    env = await setup({ bridges: [bridge({ label: '停用', enabled: false }), bridge({ label: '启用' })] })
    expect(env.relay.settings.rows[1].invalid).toBe('')
    expect(env.relay.settings.bridges.map((b) => b.label)).toEqual(['启用'])
    env.discordMessage({ content: 'x' })
    await env.idle()
    expect(env.qq.text()).toEqual(['[启用 - 舰长]\nx'])
  })

  it('两行启用的重复：跳过后面那行，只发一次', async () => {
    env = await setup({ bridges: [bridge({ label: '第一' }), bridge({ label: '第二' })] })
    expect(env.relay.settings.rows[1].invalid).toMatch(/重复/)
    env.discordMessage({ content: 'x' })
    await env.idle()
    expect(env.qq.text()).toEqual(['[第一 - 舰长]\nx'])
  })

  it('非数字 ID 的行被跳过，其他桥照常工作', async () => {
    env = await setup({ bridges: [bridge({ label: '坏', discord: 'general' }), bridge({ label: '坏2', qq: '群一' }), bridge({ label: '好', qq: QQ_GROUP2 })] })
    expect(env.relay.settings.rows[0].invalid).toMatch(/纯数字/)
    expect(env.relay.settings.rows[1].invalid).toMatch(/纯数字/)
    env.discordMessage({ content: 'x' })
    await env.idle()
    expect(env.qq.sent.map((s) => [s.group, s.text])).toEqual([[QQ_GROUP2, '[好 - 舰长]\nx']])
  })

  it('同一对一行 d2q、一行 q2d：两行都工作，并有合并建议', async () => {
    env = await setup({ bridges: [bridge({ label: '下行', direction: 'd2q' }), bridge({ label: '上行', direction: 'q2d' })] })
    expect(env.relay.settings.bridges).toHaveLength(2)
    expect(env.relay.settings.rows[0].warnings.join()).toMatch(/合成一行/)
    expect(env.relay.settings.rows[1].warnings.join()).toMatch(/合成一行/)
    env.discordMessage({ content: 'down' })
    await env.qqMessage(qqPayload(text('up')))
    await env.idle()
    expect(env.qq.text()).toEqual(['[下行 - 舰长]\ndown'])
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].json.username).toBe('[上行] 群名片小明')
    expect(posts[0].json.content).toBe('up')
  })

  it('找不到机器人：警告而不是异常；QQ → Discord 记录失败原因', async () => {
    env = await setup({ discordSelfId: '999999999999999999' })
    expect(env.relay.discordBot()).toBeNull()
    expect(env.relay.botProblem('discord')).toMatch(/找不到 ID 为 999999999999999999 的 Discord 机器人/)
    await env.qqMessage(qqPayload(text('x')))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(0)
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).lastFailure?.reason).toMatch(/找不到/)

    const bare = new Relay(new Context(), cfg(), { timers: false })
    expect(bare.botProblem('discord')).toBe('没有找到 Discord 机器人')
    expect(bare.botProblem('onebot')).toBe('没有找到 QQ 机器人')
  })

  it('有两个 QQ 机器人：警告而不是异常，不转发', async () => {
    env = await setup()
    const e = env
    e.app.plugin({
      name: 'second-qq',
      apply(ctx: Context) {
        const bot = new OneBotBot(ctx, { selfId: '10001', protocol: 'none' } as any)
        ;(bot.internal as any)._request = async (action: string, params: any) => e.qq.handle(action, params)
      },
    })
    await sleep(50)
    expect(e.relay.qqBot()).toBeNull()
    expect(e.relay.botProblem('onebot')).toMatch(/多个 QQ 机器人/)
    await expect(e.qqMessage(qqPayload(text('x')))).resolves.toBeUndefined()
    await e.idle()
    expect(e.discord.posts()).toHaveLength(0)
  })

  it('无效时区 → UTC，并记在 settings.problems', async () => {
    env = await setup({ timezone: 'Mars/Olympus_Mons' })
    expect(env.relay.settings.timeZone).toBe('UTC')
    expect(env.relay.settings.problems.join()).toMatch(/Mars\/Olympus_Mons.*UTC/)
    // 时间码按 UTC 换算
    env.discordMessage({ content: '<t:1790000000:t>' })
    await env.idle()
    expect(env.qq.text()[0]).toMatch(/14:13$/)
  })

  it('暂停按 (discord, qq) 保存：调换行顺序后仍在原来的桥上', async () => {
    const jia = bridge({ label: '甲' })
    const yi = bridge({ label: '乙', discord: DC_CHANNEL2, qq: QQ_GROUP2 })
    env = await setup({ bridges: [jia, yi] })
    await env.relay.setPaused(`${DC_CHANNEL}:${QQ_GROUP}`, true)
    env.discordMessage({ content: 'to jia' })
    env.discordMessage({ content: 'to yi', channel_id: DC_CHANNEL2 })
    await env.idle()
    expect(env.qq.sent.map((s) => s.group)).toEqual([QQ_GROUP2])

    // 「重载」：新的 Relay，同一个数据库，行顺序调换
    const reloaded = new Relay(env.app, cfg({ bridges: [yi, jia] }), { timers: false })
    await reloaded.start()
    const byPair = (d: string) => reloaded.settings.bridges.find((b) => b.discord === d)!
    expect(byPair(DC_CHANNEL).index).toBe(2)
    expect(reloaded.isPaused(byPair(DC_CHANNEL))).toBe(true)
    expect(reloaded.isPaused(byPair(DC_CHANNEL2))).toBe(false)

    // 桥从配置里删掉：暂停键被清掉
    const without = new Relay(env.app, cfg({ bridges: [yi] }), { timers: false })
    await without.start()
    expect(await without.store.get(`pause:${DC_CHANNEL}:${QQ_GROUP}`)).toBeUndefined()
  })
})

// ------------------------------------------------------------------ B2

describe('B2 防回环、去重、拓扑、顺序', () => {
  it('Discord 机器人自己发的消息不转发', async () => {
    env = await setup()
    expect(env.dcBot.selfId).toBe(DC_BOT)
    env.discordMessage({ author: { id: DC_BOT, username: 'bridge-bot', bot: true }, content: 'self' })
    await env.idle()
    await sleep(50)
    expect(env.qq.sent).toHaveLength(0)
  })

  it('自己 webhook 发的消息不转发；集合为空时对应表兜底', async () => {
    env = await setup()
    await forwardFromQQ(env)
    const wh = env.discord.webhooks.get(DC_CHANNEL)![0]
    expect(env.relay.sender.ownWebhooks.has(wh.id)).toBe(true)
    env.discordMessage({ webhook_id: wh.id, author: { id: wh.id, username: '[测试桥] 群名片小明', bot: true }, content: 'echo' })
    await env.idle()
    await sleep(50)
    expect(env.qq.sent).toHaveLength(0)

    // 重启后内存里的集合是空的：对应表里有这条（dst）就丢弃
    env.relay.sender.ownWebhooks.clear()
    const echoId = discordId()
    await env.relay.store.addMapping({ srcPlatform: 'onebot', srcChannel: QQ_GROUP, srcMessage: '31999', dstPlatform: 'discord', dstChannel: DC_CHANNEL, dstMessage: echoId, part: 0, srcAuthor: '小明' })
    env.discordMessage({ id: echoId, webhook_id: wh.id, author: { id: wh.id, username: '[测试桥] 群名片小明', bot: true }, content: 'echo 2' })
    await env.idle()
    await sleep(50)
    expect(env.qq.sent).toHaveLength(0)
    // 别人的 webhook 照常转发
    env.discordMessage({ webhook_id: '977777777777777777', author: { id: '977777777777777777', username: 'News', bot: true }, content: '新闻' })
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - News]\n新闻'])
  })

  it('QQ 自己发的消息不转发', async () => {
    env = await setup()
    await env.qqMessage(qqPayload(text('self'), { user_id: +QQ_BOT, sender: { user_id: +QQ_BOT, nickname: 'bot', card: '', role: 'admin' } }))
    await env.idle()
    await sleep(50)
    expect(env.discord.posts()).toHaveLength(0)
  })

  it('回声比 HTTP 响应先到（webhook 模式）也被拦住', async () => {
    env = await setup()
    const e = env
    e.discord.beforeRespond = async (req, id) => {
      const m = /^\/webhooks\/(\d+)\//.exec(req.path)
      if (!m) return
      e.discordMessage({ id, webhook_id: m[1], author: { id: m[1], username: req.json?.username, bot: true }, content: req.json?.content })
      await sleep(100)
    }
    await e.qqMessage(qqPayload(text('ping')))
    await e.idle()
    await sleep(100)
    await e.idle()
    expect(e.discord.posts()).toHaveLength(1)
    expect(e.qq.sent).toHaveLength(0)
  })

  it('回声比 HTTP 响应先到（机器人模式）也被拦住', async () => {
    env = await setup({ discordAsWebhook: false })
    const e = env
    e.discord.beforeRespond = async (req, id) => {
      e.discordMessage({ id, author: { id: DC_BOT, username: 'bridge-bot', bot: true }, content: req.json?.content })
      await sleep(100)
    }
    await e.qqMessage(qqPayload(text('ping')))
    await e.idle()
    await sleep(100)
    await e.idle()
    expect(e.discord.posts()).toHaveLength(1)
    expect(e.qq.sent).toHaveLength(0)
  })

  it('同一条消息先实时、再补发到达，只发一次', async () => {
    env = await setup()
    const base = BigInt(snowflakeFromTime(Date.now() - 60000))
    const d = discordPayload({ id: String(base + 5n), content: '只发一次' })
    env.discord.history.set(DC_CHANNEL, [d])
    env.discordMessage(d)
    await env.idle()
    const count = await env.relay.backfill(env.dcBot, DC_CHANNEL, String(base))
    expect(count).toBe(1)
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长]\n只发一次'])
  })

  it('同一条消息先补发、再实时到达，只发一次', async () => {
    env = await setup()
    const base = BigInt(snowflakeFromTime(Date.now() - 60000))
    const d = discordPayload({ id: String(base + 7n), content: '只发一次' })
    env.discord.history.set(DC_CHANNEL, [d])
    await env.relay.backfill(env.dcBot, DC_CHANNEL, String(base))
    await env.idle()
    env.discordMessage(d)
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\n只发一次'])
  })

  it('拓扑：一个群是 3 个 d2q 的目标 + 1 个 both 的一端', async () => {
    const [A, B, C] = ['920000000000000011', '920000000000000012', '920000000000000013']
    env = await setup({
      bridges: [
        bridge({ label: '新闻A', discord: A, direction: 'd2q' }),
        bridge({ label: '新闻B', discord: B, direction: 'd2q' }),
        bridge({ label: '新闻C', discord: C, direction: 'd2q' }),
        bridge({ label: '聊天', discord: DC_CHANNEL2, direction: 'both' }),
      ],
    })
    for (const id of [A, B, C]) env.discord.channels.set(id, { id, guild_id: DC_GUILD, name: '新闻' })
    await env.qqMessage(qqPayload(text('群里说话')))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    const wh = env.discord.webhooks.get(DC_CHANNEL2)![0]
    expect(posts[0].path.startsWith(`/webhooks/${wh.id}/`)).toBe(true)
    expect([A, B, C].some((id) => env!.discord.webhooks.has(id))).toBe(false)

    // d2q 转进群里的新闻：LLBot 上报了机器人自己的消息，不能出现在 both 桥的 Discord 频道
    env.discordMessage({ channel_id: A, content: '新闻 1' })
    env.discordMessage({ channel_id: B, content: '新闻 2' })
    await env.idle()
    expect(env.qq.text()).toEqual(['[新闻A - 舰长]\n新闻 1', '[新闻B - 舰长]\n新闻 2'])
    for (const sent of env.qq.sent) {
      await env.qqMessage(qqPayload(sent.segments, { message_id: +sent.id, user_id: +QQ_BOT, sender: { user_id: +QQ_BOT, nickname: 'bot', card: '', role: 'admin' } }))
    }
    await env.idle()
    await sleep(50)
    expect(env.discord.posts()).toHaveLength(1)
  })

  it('队列顺序：A 预处理慢（图片 1.5 秒），B 纯文字 → QQ 先收到 A 再收到 B', async () => {
    media = await startMedia({ '/slow.png': { delayMs: 1500 } })
    env = await setup()
    env.discordMessage({ content: 'A', attachments: [image(`${media.base}/slow.png`)] })
    env.discordMessage({ content: 'B' })
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长]\nA<image>', '[测试桥 - 舰长]\nB'])
  })
})

// ------------------------------------------------------------------ B6

describe('B6 回复', () => {
  function getMsg(id: string, content: string, sender = { user_id: +QQ_BOT, nickname: 'bot', card: '' }) {
    return { message_id: +id, real_id: +id, time: Math.floor(Date.now() / 1000), message_type: 'group', group_id: +QQ_GROUP, sender, message: text(content), raw_message: content }
  }

  it('QQ 回复一条转过来的 Discord 消息 → 机器人模式是原生回复', async () => {
    env = await setup({ discordAsWebhook: false })
    const d = env.discordMessage({ content: '原消息' })
    await env.idle()
    const qqId = env.qq.sent[0].id
    env.qq.messages.set(qqId, getMsg(qqId, '[测试桥 - 舰长]\n原消息'))
    await env.qqMessage(qqPayload([{ type: 'reply', data: { id: qqId } }, { type: 'at', data: { qq: QQ_BOT } }, { type: 'text', data: { text: ' 收到' } }]))
    await env.idle()
    const [post] = env.discord.posts()
    expect(post.path).toBe(`/channels/${DC_CHANNEL}/messages`)
    expect(post.json.message_reference).toEqual({ message_id: d.id, fail_if_not_exists: false })
    expect(post.json.content).toBe('\\[测试桥 - 群名片小明\\] 收到')
  })

  it('QQ 回复一条转过来的 Discord 消息 → webhook 模式是「↪ 回复 … · 链接」，名字用 srcAuthor', async () => {
    env = await setup()
    const d = env.discordMessage({ content: '集合了', member: { nick: '舰长' } })
    await env.idle()
    const qqId = env.qq.sent[0].id
    env.qq.messages.set(qqId, getMsg(qqId, '[测试桥 - 舰长]\n集合了'))
    await env.qqMessage(qqPayload([{ type: 'reply', data: { id: qqId } }, { type: 'text', data: { text: '好' } }]))
    await env.idle()
    const [post] = env.discord.posts()
    expect(post.json.message_reference).toBeUndefined()
    expect(post.json.content).toBe(`↪ 回复 舰长：集合了 · https://discord.com/channels/${DC_GUILD}/${DC_CHANNEL}/${d.id}\n好`)
  })

  it('Discord 回复一条转过来的 QQ 消息 → QQ 以 reply 段开头', async () => {
    env = await setup()
    const { qqId, discordId: dId } = await forwardFromQQ(env, '谁在线')
    const wh = env.discord.webhooks.get(DC_CHANNEL)![0]
    env.discordMessage({
      type: 19,
      content: '我在',
      message_reference: { message_id: dId, channel_id: DC_CHANNEL, guild_id: DC_GUILD },
      referenced_message: { id: dId, channel_id: DC_CHANNEL, content: '谁在线', webhook_id: wh.id, author: { id: wh.id, username: '[测试桥] 群名片小明', bot: true } },
    })
    await env.idle()
    const [sent] = env.qq.sent
    expect(sent.segments[0]).toEqual({ type: 'reply', data: { id: qqId } })
    expect(sent.text).toBe(`<回复 ${qqId}>[测试桥 - 舰长]\n我在`)
  })

  it('多段消息：回复时引用第一段', async () => {
    env = await setup()
    const long = Array.from({ length: 40 }, (_, i) => `第 ${i} 行，${'内容'.repeat(30)}`).join('\n')
    const d = env.discordMessage({ content: long })
    await env.idle()
    expect(env.qq.sent.length).toBeGreaterThan(1)
    const rows = await mappings(env, { srcChannel: DC_CHANNEL, srcMessage: d.id })
    expect(rows.map((r) => r.part).sort()).toEqual(env.qq.sent.map((_, i) => i))
    const first = env.qq.sent[0].id
    // Discord 里另一个人回复这条长消息
    env.discordMessage({
      type: 19,
      author: { id: '930000000000000002', username: 'wing', global_name: 'Wing' },
      member: { nick: '僚机' },
      content: '收到',
      message_reference: { message_id: d.id, channel_id: DC_CHANNEL, guild_id: DC_GUILD },
      referenced_message: { ...d },
    })
    await env.idle()
    const last = env.qq.sent[env.qq.sent.length - 1]
    expect(last.segments[0]).toEqual({ type: 'reply', data: { id: first } })
  })

  it('回复插件转过来的消息、在这个目标没有对应 → 引用行用 srcAuthor，去掉插件前缀', async () => {
    env = await setup({ discordAsWebhook: false, bridges: [bridge(), bridge({ label: '二群', qq: QQ_GROUP2, direction: 'd2q' })] })
    const { qqId, discordId: dId } = await forwardFromQQ(env, '谁在线')
    const [post] = env.discord.posts()
    expect(post.json.content).toBe('\\[测试桥 - 群名片小明\\] 谁在线')
    env.discordMessage({
      type: 19,
      content: '我在',
      message_reference: { message_id: dId, channel_id: DC_CHANNEL, guild_id: DC_GUILD },
      referenced_message: { id: dId, channel_id: DC_CHANNEL, content: post.json.content, author: { id: DC_BOT, username: 'bridge-bot', bot: true } },
    })
    await env.idle()
    const one = env.qq.sent.find((s) => s.group === QQ_GROUP)!
    const two = env.qq.sent.find((s) => s.group === QQ_GROUP2)!
    expect(one.segments[0]).toEqual({ type: 'reply', data: { id: qqId } })
    expect(two.text).toBe('[二群 - 舰长]\n↪ 回复 群名片小明：谁在线\n我在')
  })

  it('Discord 回复找不到对应 → 「↪ 回复 名字：内容」', async () => {
    env = await setup()
    const ref = discordPayload({ author: { id: '930000000000000003', username: 'fc', global_name: 'FC Bob' }, member: undefined, content: '今晚八点集合，带好船' })
    env.discordMessage({ type: 19, content: '好的', message_reference: { message_id: ref.id, channel_id: DC_CHANNEL }, referenced_message: ref })
    await env.idle()
    const [sent] = env.qq.sent
    expect(sent.segments[0].type).toBe('text')
    expect(sent.text).toBe('[测试桥 - 舰长]\n↪ 回复 FC Bob：今晚八点集合，带好船\n好的')
  })

  it('QQ 回复找不到对应 → 「↪ 回复 名字：内容」', async () => {
    env = await setup()
    env.qq.messages.set('40001', getMsg('40001', '明天几点', { user_id: 20002, nickname: '小红', card: '红红' }))
    await env.qqMessage(qqPayload([{ type: 'reply', data: { id: '40001' } }, { type: 'text', data: { text: '九点' } }]))
    await env.idle()
    const [post] = env.discord.posts()
    expect(post.json.content).toBe('↪ 回复 红红：明天几点\n九点')
  })

  it('被回复的 Discord 消息已删除 → 「↪ 回复 一条已删除的消息」，照常转发', async () => {
    env = await setup()
    env.discordMessage({ type: 19, content: '还在吗', message_reference: { message_id: discordId(), channel_id: DC_CHANNEL }, referenced_message: null })
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长]\n↪ 回复 一条已删除的消息\n还在吗'])
  })
})

// ------------------------------------------------------------------ B7

describe('B7 失败处理和分段', () => {
  it('一张图下载失败 → 其余照发，失败的写 [图片]', async () => {
    media = await startMedia({ '/ok.png': {} })
    env = await setup()
    env.discordMessage({ content: '两张图', attachments: [image(`${media.base}/missing.png`, 'a.png'), image(`${media.base}/ok.png`, 'b.png')] })
    await env.idle()
    expect(env.qq.sent).toHaveLength(1)
    const [sent] = env.qq.sent
    expect(sent.segments.filter((s: any) => s.type === 'image')).toHaveLength(1)
    expect(sent.text).toContain('[图片]')
    expect(sent.text).toContain('两张图')
  })

  it('文字 + 两张图，第二张下载 503 → 一次发送（文字、图 1、[图片]），下载不重试', async () => {
    media = await startMedia({ '/1.png': {}, '/2.png': { status: 503 } })
    env = await setup()
    const d = env.discordMessage({ content: '截图', attachments: [image(`${media.base}/1.png`, '1.png'), image(`${media.base}/2.png`, '2.png')] })
    await env.idle()
    expect(sendCalls(env)).toHaveLength(1)
    const [sent] = env.qq.sent
    expect(sent.text).toBe('[测试桥 - 舰长]\n截图\n[图片]<image>')
    expect(sent.segments.filter((s: any) => s.type === 'image')).toHaveLength(1)
    expect(media.hits.get('/1.png')).toBe(1)
    expect(media.hits.get('/2.png')).toBe(1)
    expect(await mappings(env, { srcChannel: DC_CHANNEL, srcMessage: d.id })).toHaveLength(1)
  })

  it('QQ → Discord：文字 + 两张图是一次 multipart 请求', async () => {
    media = await startMedia({ '/q1.png': {}, '/q2.png': {} })
    env = await setup()
    await env.qqMessage(qqPayload([
      { type: 'text', data: { text: '看图' } },
      { type: 'image', data: { file: 'q1.png', url: `${media.base}/q1.png` } },
      { type: 'image', data: { file: 'q2.png', url: `${media.base}/q2.png` } },
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].json.content).toBe('看图')
    expect(posts[0].files).toHaveLength(2)
  })

  it('Discord POST 503 → 不重试，失败记进统计', async () => {
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { status: 503, body: { message: 'Service Unavailable', code: 0 } })
    await env.qqMessage(qqPayload(text('x')))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(1)
    const stats = env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`)
    expect(stats.failures).toBe(1)
    expect(stats.forwards).toBe(0)
    expect(stats.lastFailure?.reason).toBeTruthy()
    expect(await mappings(env, { srcChannel: QQ_GROUP })).toHaveLength(0)
  })

  it('连接中途断开 → 不重试', async () => {
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { destroy: true })
    await env.qqMessage(qqPayload(text('x')))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(1)
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).failures).toBe(1)
  })

  it('classify：嵌套的连接错误码才重试；ETIMEDOUT、5xx、4xx 不重试', () => {
    const mark = (e: any) => Object.assign(e, { [Symbol.for('cordis.http.error')]: true })
    const withCode = (code: string) => mark({ message: 'fetch failed', cause: { cause: { code } } })
    for (const code of ['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(classify(undefined, withCode(code))).toEqual({ kind: 'connect' })
    }
    expect(classify(undefined, withCode('UND_ERR_SOCKET'))).toEqual({ kind: 'other', maybeSent: true })
    expect(classify(undefined, mark({ code: 'ETIMEDOUT', cause: { cause: { code: 'ECONNREFUSED' } } }))).toEqual({ kind: 'other', maybeSent: true })
    // 不是 HTTP 错误（没有标记）：不重试
    expect(classify(undefined, { cause: { cause: { code: 'ECONNREFUSED' } } })).toEqual({ kind: 'other', maybeSent: true })
    const res = (status: number, data: any) => mark({ response: { status, data, headers: new Headers() } })
    expect(classify(undefined, res(503, {}))).toEqual({ kind: 'other', maybeSent: true })
    expect(classify(undefined, res(403, { code: 50013 }))).toEqual({ kind: 'other', maybeSent: false })
    expect(classify(undefined, res(429, { retry_after: 1.5 }))).toEqual({ kind: 'rate', ms: 1500 })
    expect(classify(undefined, res(413, {}))).toEqual({ kind: 'tooLarge' })
    expect(classify(undefined, res(404, { code: 10015 }))).toEqual({ kind: 'unknownWebhook' })
    expect(classify(undefined, res(400, { code: 50035, errors: { username: { _errors: [{ code: 'USERNAME_INVALID' }] } } }))).toEqual({ kind: 'username' })
  })

  it('DiscordSender：连接没建立 → 重试 2 次（间隔 2 秒、10 秒），然后放弃', async () => {
    const sym = Symbol.for('cordis.http.error')
    const make = (failures: number) => {
      let calls = 0
      const fn: any = async () => {
        if (calls++ < failures) throw Object.assign(new Error('fetch failed'), { [sym]: true, cause: { cause: { code: 'ECONNREFUSED' } } })
        return { data: { id: '950000000000009999' } }
      }
      fn.isError = (e: any) => !!e?.[sym]
      return { bot: { selfId: DC_BOT, http: fn }, calls: () => calls }
    }
    const waits: number[] = []
    const options = () => ({ signal: new AbortController().signal, deadline: Date.now() + 60000, sleep: async (ms: number) => void waits.push(ms) })
    const sender = new DiscordSender({ warn() {} })
    const ok = make(2)
    expect(await sender.send(ok.bot, DC_CHANNEL, { content: 'x', files: [] }, null, options())).toEqual({ ok: true, messageId: '950000000000009999' })
    expect(ok.calls()).toBe(3)
    expect(waits).toEqual([2000, 10000])
    const bad = make(5)
    const result = await sender.send(bad.bot, DC_CHANNEL, { content: 'x', files: [] }, null, options())
    expect(result.ok).toBe(false)
    expect(bad.calls()).toBe(3)
  })

  it('429 带 retry_after → 队列等待后成功，两条按顺序到达', async () => {
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { status: 429, body: { message: 'You are being rate limited.', retry_after: 0.3, global: false } })
    await env.qqMessage(qqPayload(text('A')))
    await env.qqMessage(qqPayload(text('B')))
    await env.idle()
    expect(env.discord.posts().map((p) => p.json.content)).toEqual(['A', 'A', 'B'])
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).forwards).toBe(2)
  })

  it('413 → 这一批的文件全部换成占位文字，重发一次', async () => {
    media = await startMedia({ '/small.png': { size: 500 }, '/big.png': { size: 5000 } })
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { status: 413, body: { message: 'Request entity too large', code: 40005 } })
    await env.qqMessage(qqPayload([
      { type: 'text', data: { text: '两张' } },
      { type: 'image', data: { file: 'big.png', url: `${media.base}/big.png` } },
      { type: 'image', data: { file: 'small.png', url: `${media.base}/small.png` } },
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(2)
    expect(posts[0].files).toHaveLength(2)
    expect(posts[1].files).toHaveLength(0)
    expect(posts[1].json.content).toMatch(/^两张\n\\?\[图片\\?\]\n\\?\[图片\\?\]$/)
  })

  it('413 重发时 content 不超过 2000，正文不截断，占位文字放不下就另发一条（F6）', async () => {
    media = await startMedia({ '/small.png': { size: 500 }, '/big.png': { size: 5000 } })
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { status: 413, body: { message: 'Request entity too large', code: 40005 } })
    await env.qqMessage(qqPayload([
      { type: 'text', data: { text: 'a'.repeat(2000) } },
      { type: 'image', data: { file: 'big.png', url: `${media.base}/big.png` } },
      { type: 'image', data: { file: 'small.png', url: `${media.base}/small.png` } },
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(3)
    expect(posts[0].json.content.length).toBeLessThanOrEqual(2000)
    expect(posts[1].files).toHaveLength(0)
    expect(posts[1].json.content).toBe('a'.repeat(2000))
    expect(posts[2].json.content.length).toBeLessThanOrEqual(2000)
    expect(posts[2].json.content).toContain('[图片')
  })

  it('10015 Unknown Webhook → 重新创建 webhook 再发', async () => {
    env = await setup()
    await forwardFromQQ(env, 'first')
    const old = env.discord.webhooks.get(DC_CHANNEL)![0]
    env.discord.webhooks.set(DC_CHANNEL, []) // 有人在 Discord 里删掉了 webhook
    await env.qqMessage(qqPayload(text('second')))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts.map((p) => p.json.content)).toEqual(['first', 'second', 'second'])
    const fresh = env.discord.webhooks.get(DC_CHANNEL)![0]
    expect(fresh.id).not.toBe(old.id)
    expect(posts[2].path.startsWith(`/webhooks/${fresh.id}/${fresh.token}`)).toBe(true)
    expect(env.relay.sender.ownWebhooks.has(fresh.id)).toBe(true)
  })

  it('400 且和 username 有关 → 用「QQ用户」重发一次', async () => {
    env = await setup()
    env.discord.fault('POST', /^\/webhooks\//, { status: 400, body: { code: 50035, message: 'Invalid Form Body', errors: { username: { _errors: [{ code: 'USERNAME_INVALID', message: 'Username cannot contain "discord"' }] } } } })
    await env.qqMessage(qqPayload(text('x')))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(2)
    expect(posts[0].json.username).toBe('[测试桥] 群名片小明')
    expect(posts[1].json.username).toBe('QQ用户')
  })

  it('QQ 发送返回失败 → 不重试', async () => {
    env = await setup()
    env.qq.faults.set('send_group_msg', 'fail')
    env.discordMessage({ content: 'x' })
    await env.idle()
    expect(sendCalls(env)).toHaveLength(1)
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).failures).toBe(1)
  })

  it('QQ 发送超时 → 不重试', async () => {
    env = await setup()
    env.qq.faults.set('send_group_msg', 'timeout')
    env.discordMessage({ content: 'x' })
    await env.idle()
    expect(sendCalls(env)).toHaveLength(1)
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).forwards).toBe(0)
  })

  it('QQ 机器人离线、等待期间恢复 → 送达', async () => {
    env = await setup()
    env.qqBot.offline()
    env.discordMessage({ content: '等我' })
    await sleep(300)
    expect(env.qq.sent).toHaveLength(0)
    env.qqBot.online()
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长]\n等我'])
  })

  it('QQ 机器人离线超过期限 → 丢弃，原因「QQ 未连接」', async () => {
    env = await setup()
    env.qqBot.offline()
    // 让这条消息成为队首时只剩约 300 毫秒
    env.clock.now = Date.now() - 59700
    env.discordMessage({ content: '来不及', timestamp: new Date(env.clock.now).toISOString() })
    await env.idle()
    expect(env.qq.sent).toHaveLength(0)
    expect(env.relay.stats.get(`${DC_CHANNEL}:${QQ_GROUP}`).lastFailure?.reason).toBe('QQ 未连接')
    env.qqBot.online()
  })

  it('sendQQ：离线超过期限返回「QQ 未连接」、肯定没发；期限内上线就发出', async () => {
    let online = false
    const calls: any[] = []
    const bot = {
      get status() { return online ? Universal.Status.ONLINE : Universal.Status.OFFLINE },
      internal: { _request: () => {} },
      sendMessage: async (...args: any[]) => (calls.push(args), ['123']),
    }
    const signal = new AbortController().signal
    expect(await sendQQ(() => bot, QQ_GROUP, [h.text('x')], { signal, deadline: Date.now() + 150, sleep: async (ms) => { await sleep(Math.min(ms, 20)) } }))
      .toEqual({ ok: false, reason: 'QQ 未连接', maybeSent: false })
    expect(calls).toHaveLength(0)
    setTimeout(() => (online = true), 100)
    expect(await sendQQ(() => bot, QQ_GROUP, [h.text('x')], { signal, deadline: Date.now() + 2000, sleep: async (ms) => { await sleep(Math.min(ms, 20)) } }))
      .toEqual({ ok: true, messageId: '123' })
    expect(calls).toHaveLength(1)
  })

  it('分段：QQ 发来 2000 个 ( 和 2000 个 * → 每段不超过 2000', async () => {
    env = await setup()
    await env.qqMessage(qqPayload(text('('.repeat(2000))))
    await env.idle()
    let posts = env.discord.posts()
    expect(posts.every((p) => p.json.content.length <= 2000)).toBe(true)
    expect(posts.map((p) => p.json.content).join('')).toBe('('.repeat(2000))

    env.discord.requests = []
    await env.qqMessage(qqPayload(text('*'.repeat(2000))))
    await env.idle()
    posts = env.discord.posts()
    expect(posts.length).toBeGreaterThan(1)
    expect(posts.every((p) => p.json.content.length <= 2000)).toBe(true)
    expect(posts.map((p) => p.json.content).join('')).toBe('\\*'.repeat(2000))
  })

  it('分段：1990 字、很多 @everyone → 每段不超过 2000，每个 @ 后都有零宽空格', async () => {
    env = await setup({ discordAsWebhook: false })
    const body = '@everyone '.repeat(199)
    expect(body.length).toBe(1990)
    await env.qqMessage(qqPayload(text(body)))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts.length).toBeGreaterThan(1)
    for (const p of posts) {
      expect(p.json.content.length).toBeLessThanOrEqual(2000)
      expect(p.json.content).not.toMatch(/@(?!​)/)
      expect(p.json.allowed_mentions).toEqual({ parse: [] })
    }
    expect(posts.map((p) => p.json.content).join('').split('@​everyone').length - 1).toBe(199)
  })

  it('Discord → QQ：price < 5b and > 3b、&amp;、<@&123> 经过真实的 onebot 编码后不丢字', async () => {
    env = await setup()
    env.discordMessage({ content: 'price < 5b and > 3b &amp; `<@&123>`' })
    await env.idle()
    const [sent] = env.qq.sent
    expect(sent.segments.every((s: any) => s.type === 'text')).toBe(true)
    expect(sent.text).toBe('[测试桥 - 舰长]\nprice < 5b and > 3b &amp; <@&123>')
  })
})

// ------------------------------------------------------------------ B8

describe('B8 @全体', () => {
  const atAllBridge = (patch: Partial<Config['atAll']> = {}, extra: Partial<Config> = {}) => ({
    bridges: [bridge({ atAll: true })],
    atAll: { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10, ...patch },
    ...extra,
  })
  const everyone = (extra: Record<string, any> = {}) => ({ content: '@everyone 集合', mention_everyone: true, ...extra })

  it('通过：@全体 在最前面，并记下当天次数', async () => {
    env = await setup(atAllBridge())
    env.discordMessage(everyone())
    await env.idle()
    const [sent] = env.qq.sent
    expect(isAtAll(sent.segments[0])).toBe(true)
    expect(sent.text).toBe('<@全体>\n[测试桥 - 舰长]\n@everyone 集合')
    expect(await env.relay.gate.usedToday(QQ_GROUP)).toBe(1)
  })

  it('mention_everyone 为 false、只有 @everyone 文字 → 不 @全体', async () => {
    env = await setup(atAllBridge())
    env.discordMessage(everyone({ mention_everyone: false }))
    await env.idle()
    const [sent] = env.qq.sent
    expect(hasAtAll(sent.segments)).toBe(false)
    expect(sent.text).toBe('[测试桥 - 舰长]\n@everyone 集合')
    expect(env.qq.calls.some((c) => c.action === 'get_group_at_all_remain')).toBe(false)
  })

  it('机器人不是管理员 → fallbackText', async () => {
    env = await setup(atAllBridge())
    env.qq.members.set(`${QQ_GROUP}:${QQ_BOT}`, { role: 'member', card: '机器人', nickname: 'bot' })
    env.discordMessage(everyone())
    await env.idle()
    const [sent] = env.qq.sent
    expect(hasAtAll(sent.segments)).toBe(false)
    expect(sent.text).toBe('【全体通知】 [测试桥 - 舰长]\n@everyone 集合')
    expect(env.relay.stats.atAllFallbacks(QQ_GROUP, (env.relay as any).dateOf(env.clock.now)).get('不是管理员')).toBe(1)
  })

  it('remain_at_all_count_for_uin 为 0 → fallbackText', async () => {
    env = await setup(atAllBridge())
    env.qq.atAllRemain = { can_at_all: true, remain_at_all_count_for_group: 10, remain_at_all_count_for_uin: 0 }
    env.discordMessage(everyone())
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
    expect(env.qq.sent[0].text.startsWith('【全体通知】 ')).toBe(true)
  })

  it('for_group ≤ reserve → fallbackText；> reserve → 通过', async () => {
    env = await setup(atAllBridge({ reserve: 2 }))
    env.qq.atAllRemain = { can_at_all: true, remain_at_all_count_for_group: 2, remain_at_all_count_for_uin: 5 }
    env.discordMessage(everyone())
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
    env.qq.atAllRemain = { can_at_all: true, remain_at_all_count_for_group: 3, remain_at_all_count_for_uin: 5 }
    env.discordMessage(everyone())
    await env.idle()
    expect(hasAtAll(env.qq.sent[1].segments)).toBe(true)
  })

  it('查询剩余次数出错 → fallbackText', async () => {
    env = await setup(atAllBridge())
    env.qq.faults.set('get_group_at_all_remain', 'fail')
    env.discordMessage(everyone())
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
    expect(env.qq.sent[0].text.startsWith('【全体通知】 ')).toBe(true)
    expect(await env.relay.gate.usedToday(QQ_GROUP)).toBe(0)
  })

  it('查询机器人身份出错 → fallbackText', async () => {
    env = await setup(atAllBridge())
    env.qq.faults.set('get_group_member_info', 'fail')
    env.discordMessage(everyone())
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
  })

  it('dailyCap = 1 → 第二条改发文字', async () => {
    env = await setup(atAllBridge({ dailyCap: 1 }))
    env.discordMessage(everyone())
    await env.idle()
    env.discordMessage(everyone())
    await env.idle()
    expect(env.qq.sent.map((s) => hasAtAll(s.segments))).toEqual([true, false])
    expect(await env.relay.gate.usedToday(QQ_GROUP)).toBe(1)
  })

  it('两条 @everyone 在 1 秒内到达、cooldownMinutes = 10 → 只有第一条 @全体', async () => {
    env = await setup(atAllBridge({ cooldownMinutes: 10 }))
    env.discordMessage(everyone({ content: '@everyone 一' }))
    env.discordMessage(everyone({ content: '@everyone 二' }))
    await env.idle()
    expect(env.qq.sent.map((s) => hasAtAll(s.segments))).toEqual([true, false])
    expect(env.qq.sent[1].text).toBe('【全体通知】 [测试桥 - 舰长]\n@everyone 二')
  })

  it('超过 maxAgeMinutes 的旧消息 → 不 @全体', async () => {
    env = await setup(atAllBridge())
    env.discordMessage(everyone({ timestamp: new Date(env.clock.now - 11 * 60000).toISOString() }))
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
  })

  it('补发的消息 → 不 @全体', async () => {
    env = await setup(atAllBridge())
    env.relay.onDiscordMessage(discordPayload(everyone()), true)
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
    expect(env.qq.sent[0].text).toBe('【全体通知】 [测试桥 - 舰长（补发）]\n@everyone 集合')
  })

  it('静默消息（flags 4096）→ 不 @全体', async () => {
    env = await setup(atAllBridge())
    env.discordMessage(everyone({ flags: 4096 }))
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(false)
  })

  it('重启后同一条消息不会再 @全体', async () => {
    const config = atAllBridge()
    env = await setup(config)
    const d = env.discordMessage(everyone())
    await env.idle()
    expect(hasAtAll(env.qq.sent[0].segments)).toBe(true)
    const e = env
    const restarted = new Relay(e.app, cfg(config), { timers: false, now: () => e.clock.now })
    await restarted.start()
    restarted.onDiscordMessage({ ...d }, false)
    await waitFor(() => e.qq.sent.length >= 2)
    await sleep(50)
    expect(e.qq.sent.slice(1).some((s) => hasAtAll(s.segments))).toBe(false)
  })

  it('通过时的元素顺序：回复在最前，然后 @全体，然后文字', async () => {
    env = await setup(atAllBridge())
    const { qqId, discordId: dId } = await forwardFromQQ(env, '要开战吗')
    const wh = env.discord.webhooks.get(DC_CHANNEL)![0]
    env.discordMessage(everyone({
      type: 19,
      content: '@everyone 开战',
      message_reference: { message_id: dId, channel_id: DC_CHANNEL, guild_id: DC_GUILD },
      referenced_message: { id: dId, channel_id: DC_CHANNEL, content: '要开战吗', webhook_id: wh.id, author: { id: wh.id, username: '[测试桥] 群名片小明', bot: true } },
    }))
    await env.idle()
    const [sent] = env.qq.sent
    expect(sent.segments.map((s: any) => s.type)).toEqual(['reply', 'at', 'text'])
    expect(sent.segments[0].data.id).toBe(qqId)
    expect(isAtAll(sent.segments[1])).toBe(true)
    expect(sent.segments[2].data.text).toBe('\n[测试桥 - 舰长]\n@everyone 开战')
  })
})

// ------------------------------------------------------------------ S12、对应表清理

describe('S12 和对应表清理', () => {
  it('Discord 机器人不是 ONLINE 时，QQ → Discord 照样发', async () => {
    env = await setup()
    expect(env.dcBot.status).not.toBe(Universal.Status.ONLINE)
    await env.qqMessage(qqPayload(text('照样发')))
    await env.idle()
    expect(env.discord.posts().map((p) => p.json.content)).toEqual(['照样发'])
  })

  it('超过 keepDays 的对应行被每小时的任务删掉', async () => {
    env = await setup({ keepDays: 7 })
    const row = (id: string) => ({ srcPlatform: 'discord', srcChannel: DC_CHANNEL, srcMessage: id, dstPlatform: 'onebot', dstChannel: QQ_GROUP, dstMessage: `m${id}`, part: 0, srcAuthor: '舰长' })
    await env.relay.store.addMapping(row('old'), new Date(env.clock.now - 8 * 86400000))
    await env.relay.store.addMapping(row('edge'), new Date(env.clock.now - 6 * 86400000))
    await env.relay.store.addMapping(row('new'), new Date(env.clock.now - 3600000))
    await (env.relay as any).hourly()
    const left = await env.app.database.get('dcqqbridge_message', {})
    expect(left.map((r) => r.srcMessage).sort()).toEqual(['edge', 'new'])
  })
})

// 未用到的导入保持类型检查安静
void DC_USER
void QQ_USER
void flatten
