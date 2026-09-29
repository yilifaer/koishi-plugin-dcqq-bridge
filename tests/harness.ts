// 集成测试用的模拟环境：真实的 Koishi 4.18 + 真实的 Discord 适配器（连到一个模拟的 Discord HTTP 服务器，不连网关）
// + 真实的 onebot 适配器（用模拟的 LLBot 代替网络）+ 内存数据库。所有 ID 和名字都是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import Memory from '@koishijs/plugin-database-memory'
import { DiscordBot } from '@satorijs/adapter-discord'
import { OneBot, OneBotBot } from 'koishi-plugin-adapter-onebot'
import { registerCommands } from '../src/commands'
import type { BridgeRow, Config } from '../src/config'
import { Relay } from '../src/relay'
import { extendModels } from '../src/store'

export const DC_BOT = '900000000000000001'
export const DC_GUILD = '910000000000000001'
export const DC_CHANNEL = '920000000000000001'
export const DC_CHANNEL2 = '920000000000000002'
export const DC_USER = '930000000000000001'
export const QQ_BOT = '10000'
export const QQ_GROUP = '555000111'
export const QQ_GROUP2 = '555000222'
export const QQ_USER = '20001'
export const OWNER_QQ = '20099'

// ------------------------------------------------------------------ 模拟 Discord HTTP

export interface DiscordRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  json: any
  files: Array<{ field: string; filename: string; size: number }>
}

type Fault = { status?: number; body?: any; destroy?: boolean; delayMs?: number; headers?: Record<string, string> }

export class FakeDiscord {
  server!: http.Server
  base = ''
  requests: DiscordRequest[] = []
  channels = new Map<string, { id: string; guild_id: string; name: string; last_message_id?: string }>()
  roles = new Map<string, Array<{ id: string; name: string }>>()
  webhooks = new Map<string, Array<{ id: string; token: string; name: string; user: { id: string }; guild_id: string; channel_id: string }>>()
  /** 频道里已有的消息（给补发的 GET /channels/:id/messages 用），按 ID 升序。 */
  history = new Map<string, any[]>()
  /** 路径正则 → 依次使用的故障。 */
  faults: Array<{ method: string; pattern: RegExp; fault: Fault; times: number }> = []
  /** 在返回之前调用（测试可以在这里模拟「网关回声先到」）。 */
  beforeRespond: ((req: DiscordRequest, id: string) => Promise<void> | void) | null = null
  private nextId = 950000000000000000n

  newId() {
    return String(++this.nextId)
  }

  fault(method: string, pattern: RegExp, fault: Fault, times = 1) {
    this.faults.push({ method, pattern, fault, times })
  }

  posts() {
    return this.requests.filter((r) => r.method === 'POST' && /\/(webhooks\/\d+\/|channels\/\d+\/messages)/.test(r.path))
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => void this.handle(req, res, Buffer.concat(chunks)))
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private parse(req: http.IncomingMessage, raw: Buffer): Pick<DiscordRequest, 'json' | 'files'> {
    const type = String(req.headers['content-type'] ?? '')
    if (type.startsWith('application/json')) return { json: JSON.parse(raw.toString('utf8') || '{}'), files: [] }
    const boundary = /boundary=(.+)$/.exec(type)?.[1]
    if (!boundary) return { json: null, files: [] }
    const files: DiscordRequest['files'] = []
    let json: any = null
    for (const part of raw.toString('latin1').split(`--${boundary}`)) {
      const name = /name="([^"]+)"/.exec(part)?.[1]
      if (!name) continue
      const body = part.slice(part.indexOf('\r\n\r\n') + 4, part.lastIndexOf('\r\n'))
      if (name === 'payload_json') json = JSON.parse(Buffer.from(body, 'latin1').toString('utf8'))
      else files.push({ field: name, filename: /filename="([^"]*)"/.exec(part)?.[1] ?? '', size: Buffer.from(body, 'latin1').length })
    }
    return { json, files }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
    const url = new URL(req.url ?? '/', this.base)
    const path = url.pathname.replace(/^\/api\/v10/, '')
    const request: DiscordRequest = { method: req.method ?? 'GET', path: path + url.search, headers: req.headers, ...this.parse(req, raw) }
    this.requests.push(request)
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const fault = this.faults.find((f) => f.method === request.method && f.pattern.test(path))
    if (fault) {
      if (--fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1)
      if (fault.fault.delayMs) await new Promise((r) => setTimeout(r, fault.fault.delayMs))
      if (fault.fault.destroy) return req.socket.destroy()
      return send(fault.fault.status ?? 500, fault.fault.body ?? { message: 'error', code: 0 }, fault.fault.headers)
    }
    let m: RegExpExecArray | null
    if (request.method === 'GET' && path === '/users/@me') return send(200, { id: DC_BOT, username: 'bridge-bot' })
    if (request.method === 'GET' && (m = /^\/channels\/(\d+)$/.exec(path))) {
      const channel = this.channels.get(m[1])
      return channel ? send(200, channel) : send(404, { message: 'Unknown Channel', code: 10003 })
    }
    if (request.method === 'GET' && (m = /^\/guilds\/(\d+)\/roles$/.exec(path))) return send(200, this.roles.get(m[1]) ?? [])
    if (request.method === 'GET' && (m = /^\/channels\/(\d+)\/webhooks$/.exec(path))) return send(200, this.webhooks.get(m[1]) ?? [])
    if (request.method === 'POST' && (m = /^\/channels\/(\d+)\/webhooks$/.exec(path))) {
      const wh = { id: this.newId(), token: `tok${this.nextId}`, name: request.json?.name ?? 'Koishi', user: { id: DC_BOT }, guild_id: this.channels.get(m[1])?.guild_id ?? DC_GUILD, channel_id: m[1] }
      this.webhooks.set(m[1], [...(this.webhooks.get(m[1]) ?? []), wh])
      return send(200, wh)
    }
    if (request.method === 'GET' && (m = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      const after = url.searchParams.get('after') ?? '0'
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const list = (this.history.get(m[1]) ?? []).filter((x) => BigInt(x.id) > BigInt(after)).slice(0, limit)
      return send(200, [...list].reverse()) // Discord 按从新到旧返回
    }
    if (request.method === 'POST' && ((m = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path)) || (m = /^\/channels\/(\d+)\/messages$/.exec(path)))) {
      if (path.startsWith('/webhooks/')) {
        const all = [...this.webhooks.values()].flat()
        if (!all.some((w) => w.id === m![1] && w.token === m![2])) return send(404, { message: 'Unknown Webhook', code: 10015 })
      }
      const id = this.newId()
      await this.beforeRespond?.(request, id)
      return send(200, { id, content: request.json?.content ?? '' })
    }
    return send(404, { message: 'not found', code: 0 })
  }
}

// ------------------------------------------------------------------ 模拟 LLBot

export interface QQSent {
  group: string
  segments: any[]
  text: string
  id: string
}

export class FakeQQ {
  calls: Array<{ action: string; params: any }> = []
  sent: QQSent[] = []
  members = new Map<string, { role: string; card: string; nickname: string }>()
  atAllRemain: any = { can_at_all: true, remain_at_all_count_for_group: 10, remain_at_all_count_for_uin: 10 }
  /** 某个动作下一次（或每次）的结果：'timeout' | 'fail' | 自定义 data。 */
  faults = new Map<string, 'timeout' | 'fail' | 'throw'>()
  messages = new Map<string, any>()
  /** 带视频段的发送一律失败（LLBot 下载视频失败时的样子）。 */
  failVideo = false
  private messageId = 7000

  text(group = QQ_GROUP) {
    return this.sent.filter((s) => s.group === group).map((s) => s.text)
  }

  handle(action: string, params: any): any {
    this.calls.push({ action, params: JSON.parse(JSON.stringify(params ?? {})) })
    const fault = this.faults.get(action)
    if (fault === 'timeout') throw new OneBot.TimeoutError(params, action)
    if (fault === 'fail') return { status: 'failed', retcode: 1200, data: null }
    const ok = (data: any = null) => ({ status: 'ok', retcode: 0, data })
    switch (action) {
      case 'get_login_info':
        return ok({ user_id: +QQ_BOT, nickname: 'bot' })
      case 'get_group_info':
        return ok({ group_id: +params.group_id, group_name: '测试群' })
      case 'get_group_member_info': {
        const member = this.members.get(`${params.group_id}:${params.user_id}`)
        return member ? ok({ group_id: params.group_id, user_id: params.user_id, ...member }) : { status: 'failed', retcode: 100, data: null }
      }
      case 'get_group_at_all_remain':
        return ok(this.atAllRemain)
      case 'get_msg': {
        const message = this.messages.get(String(params.message_id))
        return message ? ok(message) : { status: 'failed', retcode: 1200, data: null }
      }
      case 'send_private_msg':
        return ok({ message_id: ++this.messageId })
      case 'send_group_msg': {
        if (this.failVideo && Array.isArray(params.message) && params.message.some((seg: any) => seg.type === 'video')) {
          return { status: 'failed', retcode: 1200, data: null }
        }
        const id = String(++this.messageId)
        const segments = params.message
        this.sent.push({ group: String(params.group_id), segments, text: flatten(segments), id })
        return ok({ message_id: +id })
      }
    }
    return ok()
  }
}

export function flatten(message: any): string {
  if (typeof message === 'string') return message
  let text = ''
  for (const seg of message ?? []) {
    if (seg.type === 'text') text += seg.data.text
    else if (seg.type === 'at') text += seg.data.qq === 'all' ? '<@全体>' : `<@${seg.data.qq}>`
    else if (seg.type === 'reply') text += `<回复 ${seg.data.id}>`
    else text += `<${seg.type}>`
  }
  return text
}

// ------------------------------------------------------------------ 组装

export interface Env {
  app: Context
  relay: Relay
  discord: FakeDiscord
  qq: FakeQQ
  dcBot: any
  qqBot: OneBotBot<Context>
  clock: { now: number }
  /** 模拟 Discord 网关推送一条 MESSAGE_CREATE。 */
  discordMessage(d: Record<string, any>): any
  /** 模拟 LLBot 上报一条群消息。 */
  qqMessage(payload: Record<string, any>): Promise<void>
  /** 等所有队列发完。 */
  idle(): Promise<void>
  /** 以某人的身份私聊或在群里发命令，返回机器人的回复文本。 */
  command(userId: string, text: string, groupId?: string): Promise<string[]>
  stop(): Promise<void>
}

/** PR 2 新增的配置项的默认值（全部关闭）。 */
export const PR2_DEFAULTS: Pick<Config, 'translate' | 'filter' | 'glossary'> = {
  translate: { enabled: false, baseURL: '', apiKey: '', model: '', label: '【机翻】', timeoutMs: 6000, maxPerHour: 0, extraBody: '', notCommands: 'help' },
  filter: { keywords: '', keywordFile: '', moderation: false, moderationBaseURL: 'https://api.openai.com/v1', moderationApiKey: '' },
  glossary: { eve: false, systemStyle: 'en(zh)', slangFile: '', overrides: [] },
}

export function bridge(row: Partial<BridgeRow> = {}): BridgeRow {
  return { label: '测试桥', discord: DC_CHANNEL, qq: QQ_GROUP, direction: 'both', enabled: true, atAll: false, blockWords: '', translate: false, ...row }
}

let snowflake = 960000000000000000n
export function discordId() {
  return String(++snowflake)
}

export function discordPayload(d: Record<string, any> = {}): any {
  return {
    id: discordId(),
    channel_id: DC_CHANNEL,
    guild_id: DC_GUILD,
    type: 0,
    content: 'hello',
    author: { id: DC_USER, username: 'pilot', global_name: 'Pilot' },
    member: { nick: '舰长' },
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    attachments: [],
    embeds: [],
    timestamp: new Date().toISOString(),
    ...d,
  }
}

let qqMessageId = 30000
export function qqPayload(message: any, extra: Record<string, any> = {}): any {
  const id = ++qqMessageId
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    group_id: +QQ_GROUP, user_id: +QQ_USER, message_id: id, message_seq: id,
    message, raw_message: typeof message === 'string' ? message : '', font: 0,
    sender: { user_id: +QQ_USER, nickname: '小明', card: '群名片小明', role: 'member' },
    ...extra,
  }
}

export async function setup(patch: Partial<Config> = {}, options: { online?: boolean; before?: (env: { discord: FakeDiscord; qq: FakeQQ }) => void } = {}): Promise<Env> {
  const discord = new FakeDiscord()
  await discord.start()
  discord.channels.set(DC_CHANNEL, { id: DC_CHANNEL, guild_id: DC_GUILD, name: '测试频道' })
  discord.channels.set(DC_CHANNEL2, { id: DC_CHANNEL2, guild_id: DC_GUILD, name: '第二频道' })
  discord.roles.set(DC_GUILD, [{ id: '940000000000000001', name: '舰队指挥' }])
  const qq = new FakeQQ()
  qq.members.set(`${QQ_GROUP}:${QQ_BOT}`, { role: 'admin', card: '机器人', nickname: 'bot' })
  qq.members.set(`${QQ_GROUP}:${QQ_USER}`, { role: 'member', card: '群名片小明', nickname: '小明' })
  options.before?.({ discord, qq })

  const clock = { now: Date.now() }
  const config: Config = {
    discordSelfId: '',
    qqSelfId: '',
    timezone: 'Asia/Shanghai',
    discordAsWebhook: true,
    keepDays: 7,
    authority: 4,
    qqReorderMs: 0,
    maxQueueAgeMinutes: 15,
    bridges: [bridge()],
    atAll: { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10 },
    ...PR2_DEFAULTS,
    ...patch,
  }

  const app = new Context()
  app.plugin(HTTP as any)
  app.plugin(Memory as any)
  let dcBot: any
  let qqBot!: OneBotBot<Context>
  app.plugin({
    name: 'fake-bots',
    apply(ctx: Context) {
      // 真实的 DiscordBot：REST 走模拟服务器；网关连不上（地址无效），和正式环境里网关断线时一样
      dcBot = new DiscordBot(ctx as any, { token: 'test-token', endpoint: discord.base + '/api/v10', gateway: 'ws://127.0.0.1:1', retryTimes: 0 } as any)
      qqBot = new OneBotBot(ctx, { selfId: QQ_BOT, protocol: 'none', advanced: { splitMixedContent: true } } as any)
      ;(qqBot.internal as any)._request = async (action: string, params: any) => qq.handle(action, params)
    },
  })
  let relay!: Relay
  app.plugin({
    name: 'dcqq-bridge-test',
    inject: ['database', 'http'],
    apply(ctx: Context) {
      extendModels(ctx)
      relay = new Relay(ctx, config, { timers: false, now: () => clock.now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) })
      relay.install()
      registerCommands(ctx, relay)
    },
  })
  await app.start()
  qqBot.online()
  if (options.online !== false) {
    dcBot.user = { id: DC_BOT, name: 'bridge-bot' }
  }
  await relay.start().catch(() => {})
  await app.database.createUser('onebot', OWNER_QQ, { authority: 4 })
  discord.requests = []
  qq.calls = []

  const env: Env = {
    app, relay, discord, qq, dcBot, qqBot, clock,
    discordMessage(d) {
      const payload = discordPayload(d)
      dcBot.dispatch(dcBot.session({ type: 'internal', _type: 'discord/message-create', _data: payload }))
      return payload
    },
    async qqMessage(payload) {
      await OneBot.dispatchSession(qqBot as any, { self_id: +QQ_BOT, time: Math.floor(clock.now / 1000), ...payload } as any)
    },
    async idle() {
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 10))
        if ((relay as any).queues.size === 0 && (relay as any).reorder.size === 0) {
          await new Promise((r) => setTimeout(r, 20))
          if ((relay as any).queues.size === 0) return
        }
      }
      throw new Error('队列没有在 4 秒内清空')
    },
    async command(userId, text, groupId) {
      const before = qq.sent.length
      const beforePrivate = qq.calls.filter((c) => c.action === 'send_private_msg').length
      const payload: any = groupId
        ? { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: +groupId, user_id: +userId, message: text, raw_message: text, message_id: ++qqMessageId, font: 0, sender: { user_id: +userId, nickname: 'u', role: 'member' } }
        : { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: +userId, message: text, raw_message: text, message_id: ++qqMessageId, font: 0, sender: { user_id: +userId, nickname: 'u' } }
      await env.qqMessage(payload)
      await new Promise((r) => setTimeout(r, 150))
      const group = qq.sent.slice(before).map((s) => s.text)
      const privates = qq.calls.filter((c) => c.action === 'send_private_msg').slice(beforePrivate).map((c) => flatten(c.params.message))
      return groupId ? group : privates
    },
    async stop() {
      await app.stop()
      await discord.stop()
    },
  }
  return env
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ------------------------------------------------------------------ PR A 追加的小工具

/** 和 setup() 默认值一样的完整配置。 */
export function baseConfig(patch: Partial<Config> = {}): Config {
  return {
    discordSelfId: '', qqSelfId: '', timezone: 'Asia/Shanghai', discordAsWebhook: true, keepDays: 7, authority: 4, qqReorderMs: 0,
    maxQueueAgeMinutes: 15,
    bridges: [bridge()],
    atAll: { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10 },
    ...PR2_DEFAULTS,
    ...patch,
  }
}

/** 模拟插件重载：在一个新的插件里装一个新的 Relay（和正式环境一样 install + start），返回它和卸载函数。 */
export async function installRelay(env: Env, config: Config): Promise<{ relay: Relay; dispose: () => void }> {
  let relay: Relay | undefined
  const fork = env.app.plugin({
    name: 'dcqq-bridge-reload',
    inject: ['database', 'http'],
    apply(ctx: Context) {
      relay = new Relay(ctx, config, { timers: false, now: () => env.clock.now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) })
      relay.install()
    },
  })
  for (let i = 0; i < 100 && !relay; i++) await sleep(10)
  if (!relay) throw new Error('新的 Relay 没有装上')
  await relay.start()
  return { relay, dispose: () => void fork.dispose() }
}
