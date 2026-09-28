// 消息管道（清单 §6、§9、§11、§15、§16）。

import { Context, Logger, Universal } from 'koishi'
import type { Element, Session } from 'koishi'
import type {} from '@satorijs/adapter-discord'
import { AtAllGate } from './atall'
import { Bridge, bridgesFrom, normalizeSettings, Settings } from './bridges'
import type { Config } from './config'
import { DiscordSender, Webhook } from './discord/api'
import { collectRefs, RawMessage, renderDiscordMessage } from './discord/render'
import { describeError, internalErrorInfo } from './log'
import { download } from './media'
import { buildDiscordContents, webhookUsername } from './out/discord'
import { buildQQSends } from './out/qq'
import { collectAtIds, parseQQMessage } from './qq/parse'
import { qqOnline, sendQQ } from './qq/api'
import { MessageRow, Store } from './store'
import { Stats } from './stats'
import { deletedReplyLine, prefixFor, replyLine, stripOwnDecorations } from './text/reply'
import type { FileData, Msg } from './types'
import { compareSnowflake, dateIn, Limiter, OrderedQueues, SeenSet, snowflakeFromTime, TtlCache } from './util'

const HEAD_LIMIT = 60000
const NAME_TTL = 10 * 60 * 1000
const DISCORD_TYPES = new Set([0, 19, 20, 23])
const DISCORD_FILE_LIMIT = 10 * 1024 * 1024
const QQ_VIDEO_LIMIT = 8 * 1024 * 1024
const BACKFILL_WINDOW = 6 * 3600 * 1000
const BACKFILL_MAX = 200

export interface RelayOptions {
  now?: () => number
  /** 测试时关掉定时任务。 */
  timers?: boolean
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

interface Prepared {
  msg: Msg | null
  /** 因为什么不发（屏蔽词、回声等）。 */
  skip?: string
  images: Array<(FileData & { placeholder: string }) | { placeholder: string }>
  videos: Array<{ url: string; placeholder: string; file?: FileData }>
  /** 被屏蔽的桥。 */
  blocked: Set<string>
}

type Direction = 'd2q' | 'q2d'

export class Relay {
  settings: Settings
  store: Store
  stats: Stats
  sender: DiscordSender
  gate: AtAllGate
  logger: Logger
  now: () => number
  /** 暂停状态：`global`、`<discord>:<qq>`。 */
  paused = new Set<string>()
  /** 自检发现的问题：桥 key → 问题。 */
  health = new Map<string, string[]>()
  private queues = new OrderedQueues()
  private limiter = new Limiter(4)
  private seen = new SeenSet(10000)
  private sentIds = new SeenSet(10000)
  private lastseen = new Map<string, string>()
  private lastseenDirty = new Set<string>()
  private roleNames = new TtlCache<Map<string, string>>(NAME_TTL)
  private channelInfo = new TtlCache<{ name?: string; guildId?: string }>(NAME_TTL)
  private memberNames = new TtlCache<string>(NAME_TTL)
  private guildOf = new Map<string, string>()
  private reorder = new Map<string, Array<{ seq?: number; arrival: number; release: () => void }>>()
  private disposed = false
  private loaded: Promise<void>
  private checkTimer: NodeJS.Timeout | null = null
  private dateOf: (ms: number) => string
  private sleep?: RelayOptions['sleep']

  constructor(public ctx: Context, config: Config, private options: RelayOptions = {}) {
    this.logger = ctx.logger('dcqq-bridge')
    this.now = options.now ?? Date.now
    this.sleep = options.sleep
    this.settings = normalizeSettings(config)
    this.store = new Store(ctx)
    this.stats = new Stats(this.now)
    this.sender = new DiscordSender(this.logger)
    this.dateOf = dateIn(this.settings.timeZone)
    this.gate = new AtAllGate(this.store, () => this.settings.atAll, this.dateOf, this.now)
    for (const problem of this.settings.problems) this.logger.warn(problem)
    for (const row of this.settings.rows) {
      if (row.invalid) this.logger.warn(`第 ${row.index} 行桥无效，已跳过：${row.invalid}`)
      for (const warning of row.warnings) this.logger.warn(`第 ${row.index} 行：${warning}`)
    }
    this.loaded = Promise.resolve()
  }

  // ---------------------------------------------------------------- 生命周期

  install() {
    const ctx = this.ctx
    ctx.on('discord/message-create', (d: any, bot: any) => this.guard(() => {
      if (!this.isOurDiscord(bot)) return
      this.onDiscordMessage(d as RawMessage, false)
    }))
    ctx.on('discord/ready', (d: any, bot: any) => this.guard(() => {
      if (!this.isOurDiscord(bot, d?.user?.id)) return
      // 同步取快照：READY 之后实时消息马上就会把 lastseen 往前推（R4）
      const snapshot = new Map(this.lastseen)
      setTimeout(() => this.onReady(snapshot).catch((e) => this.logger.warn('断线补发出错：%s', describeError(e))), 0)
    }))
    ctx.on('message-created', (session) => this.guard(() => this.onQQMessage(session)))
    ctx.on('bot-status-updated', (bot) => this.guard(() => {
      if (bot.status === Universal.Status.ONLINE) this.scheduleSelfCheck()
    }))
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => this.dispose())
  }

  private guard(fn: () => void) {
    try {
      fn()
    } catch (e) {
      this.logger.warn('处理事件出错：%s', describeError(e))
    }
  }

  async start() {
    this.loaded = this.load()
    await this.loaded
    if (this.options.timers !== false) {
      this.ctx.setInterval(() => void this.flushLastseen().catch(() => {}), 10000)
      this.ctx.setInterval(() => void this.hourly().catch(() => {}), 3600000)
    }
    await this.hourly().catch(() => {})
    // 插件加载时 Discord 机器人已经在线（例如控制台保存后重载）：补一次
    const bot = this.discordBot()
    if (bot?.status === Universal.Status.ONLINE && bot.selfId) {
      await this.onReady(new Map(this.lastseen)).catch((e) => this.logger.warn('断线补发出错：%s', describeError(e)))
    } else {
      this.scheduleSelfCheck()
    }
  }

  private async load() {
    try {
      for (const { key } of await this.store.entries('pause')) {
        const [kind, ...rest] = key.split(':')
        const pair = rest.join(':')
        if (kind !== 'pause' && kind !== 'pausetr') continue
        if (pair === 'global') {
          if (kind === 'pause') this.paused.add('global')
          continue
        }
        if (!this.settings.allKeys.has(pair)) {
          await this.store.delete(key)
          this.logger.info(`已清除指向不存在的桥的暂停状态：${pair}`)
          continue
        }
        if (kind === 'pause') this.paused.add(pair)
      }
    } catch (e) {
      // 读不到暂停状态时按「全局暂停」处理，宁可不转发
      this.paused.add('global')
      this.logger.warn('读取暂停状态失败，暂时全部暂停：%s', describeError(e))
    }
    try {
      for (const { key, value } of await this.store.entries('lastseen:')) {
        const channel = key.slice('lastseen:'.length)
        if (typeof value !== 'string') continue
        const current = this.lastseen.get(channel)
        if (!current || compareSnowflake(value, current) > 0) this.lastseen.set(channel, value)
      }
    } catch (e) {
      this.logger.warn('读取 lastseen 失败：%s', describeError(e))
    }
  }

  async dispose() {
    this.disposed = true
    if (this.checkTimer) clearTimeout(this.checkTimer)
    await this.flushLastseen().catch(() => {})
  }

  private async hourly() {
    const removed = await this.store.cleanup(this.settings.keepDays, this.now())
    if (removed) this.logger.debug(`清理了 ${removed} 行过期的对应记录`)
    // atall:<群>:<日期> 保留 7 天（R17）
    const cutoff = this.dateOf(this.now() - 7 * 86400000)
    for (const { key } of await this.store.entries('atall:')) {
      const date = key.split(':')[2]
      if (date && date < cutoff) await this.store.delete(key)
    }
  }

  // ---------------------------------------------------------------- 机器人

  /** 要用的 Discord 机器人（每次用到时再找，清单 §4.1）。 */
  discordBot(): any | null {
    return this.findBot('discord', this.settings.discordSelfId)
  }

  qqBot(): any | null {
    return this.findBot('onebot', this.settings.qqSelfId)
  }

  private findBot(platform: string, wanted: string) {
    const bots = this.ctx.bots.filter((bot) => bot.platform === platform)
    if (wanted) {
      const hit = bots.find((bot) => bot.selfId === wanted)
      if (hit) return hit
      // Discord 机器人第一次 READY 之前没有 selfId（R2）
      const unnamed = bots.filter((bot) => !bot.selfId)
      return unnamed.length === 1 && bots.length === 1 ? unnamed[0] : null
    }
    return bots.length === 1 ? bots[0] : null
  }

  botProblem(platform: 'discord' | 'onebot'): string | null {
    const bots = this.ctx.bots.filter((bot) => bot.platform === platform)
    const name = platform === 'discord' ? 'Discord' : 'QQ'
    const wanted = platform === 'discord' ? this.settings.discordSelfId : this.settings.qqSelfId
    const bot = platform === 'discord' ? this.discordBot() : this.qqBot()
    if (!bot) {
      if (!bots.length) return `没有找到 ${name} 机器人`
      if (wanted) return `找不到 ID 为 ${wanted} 的 ${name} 机器人`
      return `有多个 ${name} 机器人，请在配置里填写要用哪一个`
    }
    if (platform === 'onebot' && !qqOnline(bot)) return 'QQ 机器人离线（LLBot 断开后可能需要在控制台重载 onebot 适配器）'
    if (platform === 'discord' && bot.status !== Universal.Status.ONLINE) return 'Discord 机器人未连接网关（发往 Discord 不受影响，Discord → QQ 暂时收不到）'
    return null
  }

  private isOurDiscord(bot: any, readySelfId?: string) {
    if (!bot || bot.platform !== 'discord') return false
    const ours = this.discordBot()
    if (!ours) return false
    const id = readySelfId ?? bot.selfId
    if (ours.selfId && id) return ours.selfId === id
    if (this.settings.discordSelfId && id) return this.settings.discordSelfId === id
    return this.ctx.bots.filter((b) => b.platform === 'discord').length === 1
  }

  // ---------------------------------------------------------------- 暂停

  isPaused(bridge?: Bridge) {
    return this.paused.has('global') || (!!bridge && this.paused.has(bridge.key))
  }

  async setPaused(key: 'global' | string, paused: boolean) {
    if (paused) {
      this.paused.add(key)
      await this.store.set(`pause:${key}`, true)
    } else {
      this.paused.delete(key)
      await this.store.delete(`pause:${key}`)
    }
  }

  // ---------------------------------------------------------------- lastseen

  private markSeen(channelId: string, id: string) {
    const current = this.lastseen.get(channelId)
    if (current && compareSnowflake(id, current) <= 0) return
    this.lastseen.set(channelId, id)
    this.lastseenDirty.add(channelId)
  }

  async flushLastseen() {
    await this.loaded
    const dirty = [...this.lastseenDirty]
    this.lastseenDirty.clear()
    for (const channel of dirty) {
      const id = this.lastseen.get(channel)
      if (id) await this.store.set(`lastseen:${channel}`, id)
    }
  }

  private isBridgeChannel(channelId: string) {
    return this.settings.bridges.some((b) => b.discord === channelId)
  }

  // ---------------------------------------------------------------- Discord → QQ

  onDiscordMessage(d: RawMessage, backfill: boolean) {
    if (this.disposed || !d?.id || !d.channel_id) return
    // 1. 去重（实时、网关重放、补发三条路共用）
    if (this.seen.has(d.id)) return
    this.seen.add(d.id)
    if (d.guild_id) this.guildOf.set(d.channel_id, d.guild_id)
    if (this.isBridgeChannel(d.channel_id)) this.markSeen(d.channel_id, d.id)
    // 2. 自己发的
    const bot = this.discordBot()
    if (bot?.selfId && d.author?.id === bot.selfId) return
    if (d.webhook_id && this.sender.ownWebhooks.has(String(d.webhook_id))) return
    if (this.sentIds.has(d.id)) return
    if (!DISCORD_TYPES.has(Number(d.type ?? 0))) return
    // 3. 找桥
    const bridges = bridgesFrom(this.settings, 'discord', d.channel_id)
    if (!bridges.length) return
    // 4. 暂停
    const active = bridges.filter((b) => !this.isPaused(b))
    if (!active.length) return
    // 5. 在第一个 await 之前占好位置
    const slots = active.map((bridge) => ({ bridge, slot: this.queues.reserve(`onebot:${bridge.qq}`) }))
    // 6. 预处理立即开始
    const prepared = this.limiter.run(() => this.prepareDiscord(d, backfill, active)).catch((e): Prepared => {
      this.logger.warn('处理 Discord 消息 %s 出错：%s', d.id, describeError(e))
      return { msg: null, skip: '预处理出错', images: [], videos: [], blocked: new Set() }
    })
    for (const { bridge, slot } of slots) {
      void slot.turn
        .then(() => this.deliverToQQ(bridge, prepared))
        .catch((e) => this.logger.warn('转发到 QQ 群 %s 出错：%s', bridge.qq, describeError(e)))
        .finally(slot.done)
    }
  }

  private async prepareDiscord(d: RawMessage, backfill: boolean, bridges: Bridge[]): Promise<Prepared> {
    const empty = (skip: string): Prepared => ({ msg: null, skip, images: [], videos: [], blocked: new Set() })
    // 回声兜底：别人的 webhook 集合里没有、但对应表里有（例如重启后）
    if (d.webhook_id && !this.sender.ownWebhooks.has(String(d.webhook_id))) {
      if ((await this.store.byTarget(d.channel_id, d.id)).length) return empty('自己发出的消息')
    }
    if (backfill && await this.store.hasSource(d.channel_id, d.id)) return empty('已经转发过')
    const bot = this.discordBot()
    const guildId = d.guild_id ?? this.guildOf.get(d.channel_id) ?? (await this.channel(bot, d.channel_id)).guildId
    const refs = collectRefs(d)
    const roles = refs.roles.length && guildId ? await this.roles(bot, guildId) : new Map<string, string>()
    const channels = new Map<string, string>()
    for (const id of refs.channels) {
      const name = (await this.channel(bot, id)).name
      if (name) channels.set(id, name)
    }
    const msg = renderDiscordMessage(guildId && !d.guild_id ? { ...d, guild_id: guildId } : d, {
      timeZone: this.settings.timeZone,
      now: this.now(),
      roleName: (id) => roles.get(id),
      channelName: (id) => channels.get(id),
      backfill,
    })
    if (!msg) return empty('空消息')
    const blocked = new Set<string>()
    for (const bridge of bridges) {
      if (bridge.blockWords.some((re) => re.test(msg.checkText))) blocked.add(bridge.key)
    }
    if (blocked.size === bridges.length) return { msg, skip: '命中屏蔽词', images: [], videos: [], blocked }
    const images: Prepared['images'] = []
    const videos: Prepared['videos'] = []
    await Promise.all(msg.media.map(async (media, i) => {
      if (media.kind === 'image') {
        const file = await download(this.ctx, media)
        images[i] = file ? { ...file, placeholder: media.placeholder } : { placeholder: media.placeholder }
      } else if (media.kind === 'video') {
        videos[i] = { url: media.urls[0] ?? '', placeholder: media.placeholder }
      } else {
        images[i] = { placeholder: media.placeholder }
      }
    }))
    return { msg, images: images.filter(Boolean), videos: videos.filter(Boolean), blocked }
  }

  private async deliverToQQ(bridge: Bridge, preparing: Promise<Prepared>) {
    const head = this.now()
    const deadline = head + HEAD_LIMIT
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEAD_LIMIT)
    try {
      const prepared = await Promise.race([preparing, sleepUntil(deadline, this.now).then(() => null)])
      if (!prepared) return this.fail(bridge, 'd2q', '预处理超过 60 秒')
      const msg = prepared.msg
      if (!msg || prepared.skip || prepared.blocked.has(bridge.key)) return
      if (this.isPaused(bridge)) return
      const bot = this.qqBot()
      // @全体（清单 §11）
      let atAll: Awaited<ReturnType<AtAllGate['decide']>> | null = null
      if (bridge.atAll && msg.mentionEveryone && bridge.direction !== 'q2d') {
        if (!bot || !qqOnline(bot)) atAll = { ok: false, reason: '查询失败' }
        else atAll = await this.gate.decide(bot, bridge.qq, msg)
        if (!atAll.ok) {
          this.stats.atAllFallback(bridge.qq, this.dateOf(this.now()), atAll.reason)
          this.logger.info(`QQ 群 ${bridge.qq} 没有 @全体（${atAll.reason}），改发文字`)
        }
      }
      // 回复（清单 §9）
      let quoteId: string | undefined
      let line: string | undefined
      if (msg.reply) {
        const found = await this.findReplyTarget(msg.channelId, msg.reply.messageId, bridge.qq)
        if (found.targetId) quoteId = found.targetId
        else line = this.replyText(msg, found.forwardedFrom)
      }
      const sends = buildQQSends({
        quoteId,
        atAll: !!atAll?.ok,
        fallbackText: atAll && !atAll.ok ? this.settings.atAll.fallbackText : undefined,
        prefix: prefixFor(bridge.label, msg.author, msg.backfill),
        replyLine: line,
        text: fullText(msg),
        images: prepared.images.map((image) => ('data' in image ? { data: image.data, mime: image.mime } : { placeholder: image.placeholder })),
        videos: prepared.videos.map((video) => ({ url: video.url, placeholder: video.placeholder })),
      })
      if (!sends.length) return
      if (atAll?.ok) await atAll.commit()
      let part = 0
      for (let i = 0; i < sends.length; i++) {
        if (this.now() >= deadline) {
          this.fail(bridge, 'd2q', '超过 60 秒，后面的分段没有发出')
          break
        }
        const result = await sendQQ(() => this.qqBot(), bridge.qq, sends[i], { signal: controller.signal, deadline, sleep: this.sleep })
        if (i === 0 && atAll?.ok && !result.ok && !result.maybeSent) await atAll.revert()
        if (result.ok) {
          await this.record(msg, 'onebot', bridge.qq, result.messageId, part++)
          this.stats.forwarded(bridge.key)
        } else {
          // 视频发送失败：改发文字
          const video = this.videoOf(sends[i], prepared)
          if (video && !result.maybeSent) {
            const fallback = await sendQQ(() => this.qqBot(), bridge.qq, [textElement(video.placeholder)], { signal: controller.signal, deadline, sleep: this.sleep })
            if (fallback.ok) {
              await this.record(msg, 'onebot', bridge.qq, fallback.messageId, part++)
              continue
            }
          }
          this.fail(bridge, 'd2q', result.reason, msg.messageId)
          if (!result.maybeSent && i === 0) break
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private videoOf(send: Element[], prepared: Prepared) {
    if (send.length !== 1 || send[0].type !== 'video') return null
    const src = String(send[0].attrs.src ?? send[0].attrs.url ?? '')
    return prepared.videos.find((video) => video.url === src) ?? null
  }

  // ---------------------------------------------------------------- QQ → Discord

  onQQMessage(session: Session) {
    if (this.disposed || session.platform !== 'onebot') return
    const bot = this.qqBot()
    if (!bot || session.selfId !== bot.selfId) return
    if (session.isDirect || !session.guildId) return
    // 自己发的（不依赖 LLBot 的 reportSelfMessage 设置）
    if (session.userId === session.selfId) return
    const bridges = bridgesFrom(this.settings, 'onebot', session.channelId!)
    if (!bridges.length) return
    const delay = this.settings.qqReorderMs
    if (delay > 0) return this.buffer(session, delay, () => this.dispatchQQ(session, bridges))
    this.dispatchQQ(session, bridges)
  }

  /** QQ 消息重排（DECISIONS 第 12 条）：每条等 delay 毫秒；到点时连同序号更小的一起按序号放行。 */
  private buffer(session: Session, delay: number, release: () => void) {
    const group = session.channelId!
    const seqRaw = Number((session as any).onebot?.message_seq)
    const item = { seq: Number.isFinite(seqRaw) ? seqRaw : undefined, arrival: this.now(), release }
    let list = this.reorder.get(group)
    if (!list) this.reorder.set(group, list = [])
    list.push(item)
    setTimeout(() => {
      const current = this.reorder.get(group)
      if (!current || !current.includes(item)) return
      const allSeq = current.every((x) => x.seq !== undefined)
      let out: typeof current
      if (allSeq) {
        out = current.filter((x) => x.seq! <= item.seq!).sort((a, b) => a.seq! - b.seq!)
      } else {
        out = current.slice(0, current.indexOf(item) + 1)
      }
      const rest = current.filter((x) => !out.includes(x))
      if (rest.length) this.reorder.set(group, rest)
      else this.reorder.delete(group)
      for (const x of out) x.release()
    }, delay)
  }

  private dispatchQQ(session: Session, bridges: Bridge[]) {
    const active = bridges.filter((b) => !this.isPaused(b))
    if (!active.length) return
    const slots = active.map((bridge) => ({ bridge, slot: this.queues.reserve(`discord:${bridge.discord}`) }))
    const prepared = this.limiter.run(() => this.prepareQQ(session, active)).catch((e): Prepared => {
      this.logger.warn('处理 QQ 消息 %s 出错：%s', session.messageId, describeError(e))
      return { msg: null, skip: '预处理出错', images: [], videos: [], blocked: new Set() }
    })
    for (const { bridge, slot } of slots) {
      void slot.turn
        .then(() => this.deliverToDiscord(bridge, prepared))
        .catch((e) => this.logger.warn('转发到 Discord 频道 %s 出错：%s', bridge.discord, describeError(e)))
        .finally(slot.done)
    }
  }

  private async prepareQQ(session: Session, bridges: Bridge[]): Promise<Prepared> {
    const bot = this.qqBot()
    const names = new Map<string, string>()
    const ids = [...collectAtIds(session.elements ?? []), ...collectAtIds(session.quote?.elements ?? [])]
    for (const id of new Set(ids)) {
      const name = await this.memberName(bot, session.channelId!, id)
      if (name) names.set(id, name)
    }
    const msg = parseQQMessage(session, { selfId: session.selfId, memberName: (id) => names.get(id), now: this.now() })
    const blocked = new Set<string>()
    for (const bridge of bridges) {
      if (bridge.blockWords.some((re) => re.test(msg.checkText))) blocked.add(bridge.key)
    }
    if (blocked.size === bridges.length) return { msg, skip: '命中屏蔽词', images: [], videos: [], blocked }
    const images: Prepared['images'] = []
    await Promise.all(msg.media.map(async (media, i) => {
      const limit = media.kind === 'video' ? QQ_VIDEO_LIMIT : DISCORD_FILE_LIMIT
      const file = media.urls.length ? await download(this.ctx, media, { maxBytes: limit }) : null
      images[i] = file ? { ...file, placeholder: media.placeholder } : { placeholder: media.placeholder }
    }))
    return { msg, images: images.filter(Boolean), videos: [], blocked }
  }

  private async deliverToDiscord(bridge: Bridge, preparing: Promise<Prepared>) {
    const head = this.now()
    const deadline = head + HEAD_LIMIT
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEAD_LIMIT)
    try {
      const prepared = await Promise.race([preparing, sleepUntil(deadline, this.now).then(() => null)])
      if (!prepared) return this.fail(bridge, 'q2d', '预处理超过 60 秒')
      const msg = prepared.msg
      if (!msg || prepared.skip || prepared.blocked.has(bridge.key)) return
      if (this.isPaused(bridge)) return
      const bot = this.discordBot()
      if (!bot) return this.fail(bridge, 'q2d', this.botProblem('discord') ?? '没有 Discord 机器人')
      const webhook: Webhook | null = this.settings.discordAsWebhook ? await this.sender.tryWebhook(bot, bridge.discord) : null
      // 回复（清单 §9）
      let line: string | undefined
      let replyTo: string | undefined
      if (msg.reply) {
        const found = await this.findReplyTarget(msg.channelId, msg.reply.messageId, bridge.discord)
        if (found.targetId && !webhook) replyTo = found.targetId
        else if (found.targetId) line = this.replyText(msg, found.forwardedFrom, await this.messageLink(bot, bridge.discord, found.targetId))
        else line = this.replyText(msg, found.forwardedFrom)
      }
      const files = prepared.images.filter((x): x is FileData & { placeholder: string } => 'data' in x)
      const placeholders = prepared.images.filter((x) => !('data' in x)).map((x) => x.placeholder)
      const contents = buildDiscordContents({
        prefix: webhook ? '' : prefixFor(bridge.label, msg.author, false),
        replyLine: line,
        text: [fullText(msg), ...placeholders].filter(Boolean).join('\n'),
      })
      if (!contents.length && !files.length) return
      if (!contents.length) contents.push('')
      const username = webhook ? webhookUsername(bridge.label, msg.author) : undefined
      // 文件跟着最后一段；一次最多 10 个，多的另起一次发送
      const batches: Array<{ content: string; files: typeof files }> = contents.map((content) => ({ content, files: [] }))
      for (let i = 0; i < files.length; i += 10) {
        const chunk = files.slice(i, i + 10)
        if (i === 0) batches[batches.length - 1].files = chunk
        else batches.push({ content: '', files: chunk })
      }
      let part = 0
      for (let i = 0; i < batches.length; i++) {
        if (this.now() >= deadline) {
          this.fail(bridge, 'q2d', '超过 60 秒，后面的分段没有发出', msg.messageId)
          break
        }
        const result = await this.sender.send(bot, bridge.discord, {
          content: batches[i].content,
          username,
          avatarUrl: msg.avatar,
          replyTo: i === 0 ? replyTo : undefined,
          files: batches[i].files,
        }, webhook, { signal: controller.signal, deadline, sleep: this.sleep })
        if (result.ok) {
          this.sentIds.add(result.messageId)
          await this.record(msg, 'discord', bridge.discord, result.messageId, part++)
          this.stats.forwarded(bridge.key)
        } else {
          this.fail(bridge, 'q2d', result.reason, msg.messageId)
          if (!result.maybeSent && i === 0) break
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------- 回复、对应表

  async findReplyTarget(srcChannel: string, replyId: string, dstChannel: string): Promise<{ targetId?: string; forwardedFrom?: MessageRow }> {
    try {
      const pick = (rows: MessageRow[]) => rows.find((r) => r.dstChannel === dstChannel && r.part === 0) ?? rows.find((r) => r.dstChannel === dstChannel)
      const asSource = pick(await this.store.bySource(srcChannel, replyId))
      if (asSource) return { targetId: asSource.dstMessage }
      const [row] = await this.store.byTarget(srcChannel, replyId)
      if (!row) return {}
      if (row.srcChannel === dstChannel) return { targetId: row.srcMessage, forwardedFrom: row }
      const sibling = pick(await this.store.bySource(row.srcChannel, row.srcMessage))
      return { targetId: sibling?.dstMessage, forwardedFrom: row }
    } catch (e) {
      this.logger.warn('查询回复对应失败：%s', describeError(e))
      return {}
    }
  }

  private replyText(msg: Msg, forwardedFrom?: MessageRow, link?: string) {
    const reply = msg.reply!
    if (reply.deleted) return deletedReplyLine()
    const author = forwardedFrom?.srcAuthor || reply.author
    const content = forwardedFrom ? stripOwnDecorations(reply.content, { fallbackText: this.settings.atAll.fallbackText }) : reply.content
    return replyLine(author, content, link)
  }

  private async messageLink(bot: any, channelId: string, messageId: string) {
    const guildId = this.guildOf.get(channelId) ?? (await this.channel(bot, channelId)).guildId
    return guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : undefined
  }

  private async record(msg: Msg, dstPlatform: string, dstChannel: string, dstMessage: string, part: number) {
    try {
      await this.store.addMapping({
        srcPlatform: msg.platform,
        srcChannel: msg.channelId,
        srcMessage: msg.messageId,
        dstPlatform,
        dstChannel,
        dstMessage,
        part,
        srcAuthor: msg.author,
      }, new Date(this.now()))
    } catch (e) {
      this.logger.warn('写对应表失败：%s', describeError(e))
    }
  }

  private fail(bridge: Bridge, direction: Direction, reason: string, messageId?: string) {
    this.stats.failed(bridge.key, reason)
    this.logger.warn(`转发失败 [第 ${bridge.index} 个桥 ${direction}${messageId ? ` 消息 ${messageId}` : ''}]：${reason}`)
  }

  // ---------------------------------------------------------------- 名字缓存

  private async channel(bot: any, channelId: string): Promise<{ name?: string; guildId?: string }> {
    const cached = this.channelInfo.get(channelId)
    if (cached) return cached
    try {
      const raw = await bot?.internal?.getChannel(channelId)
      const info = { name: raw?.name, guildId: raw?.guild_id }
      if (info.guildId) this.guildOf.set(channelId, info.guildId)
      this.channelInfo.set(channelId, info)
      return info
    } catch {
      this.channelInfo.set(channelId, {})
      return {}
    }
  }

  private async roles(bot: any, guildId: string): Promise<Map<string, string>> {
    const cached = this.roleNames.get(guildId)
    if (cached) return cached
    const map = new Map<string, string>()
    try {
      for (const role of await bot?.internal?.getGuildRoles(guildId) ?? []) map.set(String(role.id), String(role.name))
    } catch {}
    this.roleNames.set(guildId, map)
    return map
  }

  private async memberName(bot: any, groupId: string, userId: string): Promise<string | undefined> {
    const key = `${groupId}:${userId}`
    const cached = this.memberNames.get(key)
    if (cached !== undefined) return cached || undefined
    try {
      const member = await bot?.getGuildMember(groupId, userId)
      const name = member?.nick || member?.user?.name || ''
      this.memberNames.set(key, name)
      return name || undefined
    } catch {
      this.memberNames.set(key, '')
      return undefined
    }
  }

  // ---------------------------------------------------------------- 断线补发（清单 §15）

  private async onReady(snapshot: Map<string, string>) {
    await this.loaded
    const bot = this.discordBot()
    if (!bot) return
    // 自己的 webhook 集合（§6.3）
    if (this.settings.discordAsWebhook) {
      for (const channel of new Set(this.settings.bridges.filter((b) => b.direction !== 'd2q').map((b) => b.discord))) {
        await this.sender.ensureWebhook(bot, channel).catch(() => {})
      }
    }
    const channels = [...new Set(this.settings.bridges.filter((b) => b.direction !== 'q2d').map((b) => b.discord))]
    for (const channel of channels) {
      const after = snapshot.get(channel) ?? this.lastseen.get(channel)
      if (!after) {
        // 没有记录：不补发，从现在开始（DECISIONS 第 10 条）
        await this.initLastseen(bot, channel)
        continue
      }
      await this.backfill(bot, channel, after).catch((e) => this.logger.warn(`频道 ${channel} 补发失败：${describeError(e)}`))
    }
    this.scheduleSelfCheck()
  }

  private async initLastseen(bot: any, channel: string) {
    let id: string | undefined
    try {
      id = (await bot.internal.getChannel(channel))?.last_message_id ?? undefined
    } catch {}
    const current = this.lastseen.get(channel)
    if (current) return
    this.lastseen.set(channel, id || snowflakeFromTime(this.now()))
    this.lastseenDirty.add(channel)
    await this.flushLastseen().catch(() => {})
  }

  async backfill(bot: any, channel: string, after: string) {
    const lower = snowflakeFromTime(this.now() - BACKFILL_WINDOW)
    let cursor = compareSnowflake(after, lower) > 0 ? after : lower
    const collected: RawMessage[] = []
    let more = false
    while (true) {
      const page: RawMessage[] = await bot.internal.getChannelMessages(channel, { after: cursor, limit: 100 })
      if (!Array.isArray(page) || !page.length) break
      const ascending = [...page].sort((a, b) => compareSnowflake(a.id, b.id))
      for (const message of ascending) {
        if (collected.length >= BACKFILL_MAX) {
          more = true
          break
        }
        collected.push(message)
      }
      cursor = ascending[ascending.length - 1].id
      if (more || page.length < 100) break
    }
    if (more) this.logger.warn(`频道 ${channel} 断线期间的消息超过 ${BACKFILL_MAX} 条，只补发了最早的 ${BACKFILL_MAX} 条`)
    for (const message of collected) {
      this.onDiscordMessage({ ...message, channel_id: message.channel_id ?? channel }, true)
    }
    return collected.length
  }

  // ---------------------------------------------------------------- 启动自检（清单 §16）

  scheduleSelfCheck() {
    if (this.disposed || this.options.timers === false) return
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = setTimeout(() => void this.selfCheck().catch(() => {}), 3000)
  }

  async selfCheck() {
    const discord = this.discordBot()
    const qq = this.qqBot()
    if (!discord || !qq || !qqOnline(qq)) return
    for (const bridge of this.settings.bridges) {
      const problems: string[] = []
      try {
        const raw = await discord.internal.getChannel(bridge.discord)
        if (raw?.guild_id) this.guildOf.set(bridge.discord, raw.guild_id)
      } catch (e) {
        problems.push(`取不到 Discord 频道（${describeError(e)}）`)
      }
      if (this.settings.discordAsWebhook && bridge.direction !== 'd2q') {
        try {
          await this.sender.ensureWebhook(discord, bridge.discord, true)
        } catch (e) {
          const info = internalErrorInfo(e)
          problems.push(info.code === 50013 || info.status === 403 ? 'webhook 不可用（机器人没有「管理 Webhook」权限），改由机器人发送' : `webhook 不可用（${describeError(e)}）`)
        }
      }
      try {
        await qq.getGuild(bridge.qq)
      } catch (e) {
        problems.push(`取不到 QQ 群（${describeError(e)}）`)
      }
      if (bridge.atAll) {
        try {
          if (!(await this.gate.isAdmin(qq, bridge.qq, true))) problems.push('⚠ 不是管理员')
        } catch (e) {
          problems.push(`查不到机器人在群里的身份（${describeError(e)}）`)
        }
      }
      if (problems.length) {
        this.health.set(bridge.key, problems)
        this.logger.warn(`第 ${bridge.index} 个桥：${problems.join('；')}`)
      } else {
        this.health.delete(bridge.key)
      }
    }
  }
}

function fullText(msg: Msg) {
  return [msg.body, ...msg.blocks].filter((s) => s.trim() !== '').join('\n\n')
}

function textElement(content: string): Element {
  return { type: 'text', attrs: { content }, children: [] } as any
}

function sleepUntil(deadline: number, now: () => number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - now())))
}
