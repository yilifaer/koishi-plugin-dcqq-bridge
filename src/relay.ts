// 消息管道（清单 §6、§9、§11、§15、§16）。

import { Context, h, Logger, Universal } from 'koishi'
import type { Command, Element, Session } from 'koishi'
import type {} from '@satorijs/adapter-discord'
import { AtAllGate } from './atall'
import { Bridge, bridgesFrom, normalizeSettings, Settings } from './bridges'
import type { Config } from './config'
import { defaultSleep, DiscordSender, Webhook } from './discord/api'
import { collectRefs, RawMessage, renderDiscordMessage } from './discord/render'
import { describeError, internalErrorInfo } from './log'
import { download } from './media'
import { buildDiscordContents, webhookUsername } from './out/discord'
import { buildQQSends } from './out/qq'
import { collectAtIds, parseQQMessage } from './qq/parse'
import { qqOnline, sendQQ } from './qq/api'
import type { QQResult } from './qq/api'
import { checkDelivered } from './qq/verify'
import { MessageRow, PendingRow, Store } from './store'
import { Stats } from './stats'
import { TranslationOutcome, TranslationService } from './translate/service'
import { MemberNames } from './translate/names'
import { commandWord, rootPrefixes } from './translate/skip'
import { deletedReplyLine, prefixFor, replyLine, stripOwnDecorations } from './text/reply'
import type { FileData, Msg } from './types'
import { compareSnowflake, dateIn, Limiter, OrderedQueues, SeenSet, snowflakeFromTime, TtlCache } from './util'
import { LinkWatch } from './watch'

const HEAD_LIMIT = 60000
const NAME_TTL = 10 * 60 * 1000
const DISCORD_TYPES = new Set([0, 19, 20, 23])
const DISCORD_FILE_LIMIT = 10 * 1024 * 1024
const QQ_VIDEO_LIMIT = 8 * 1024 * 1024
const BACKFILL_WINDOW = 6 * 3600 * 1000
const BACKFILL_MAX = 200
/** d2q 图片下载上限。 */
const QQ_IMAGE_LIMIT = 10 * 1024 * 1024
/** Discord 一次请求的文件总大小上限（留一点余量给表单其他部分）。 */
const DISCORD_BATCH_BYTES = 24 * 1024 * 1024
const DISCORD_BATCH_FILES = 10
/** 插件停止超过这么久再启动：READY 时不补发（alive 心跳）。 */
const ALIVE_STALE = 15 * 60 * 1000
const ALIVE_INTERVAL = 60000
const MEMBER_TIMEOUT = 5000
/** 群成员名字查询超时后，这么久之内不再查。 */
const MEMBER_SLOW_TTL = 60000
/** 频道信息查询超时。 */
const CHANNEL_TIMEOUT = 10000
/** 频道信息查询超时或出错后，这么久之内不再查（F4）。 */
const CHANNEL_FAIL_TTL = 60000
/** 发 QQ 超时后，等这么久再去群里核对有没有发出去（V3）。 */
const VERIFY_WAIT = 4000
/** QQ 恢复后一次最多补发几条（V11）。 */
const QQ_REPLAY_MAX = 200

export interface RelayOptions {
  now?: () => number
  /** 测试时关掉定时任务。 */
  timers?: boolean
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** 测试用：在线词表的检查间隔（毫秒），不填时按 glossary.refreshHours。 */
  onlineRefreshMs?: number
}

interface Prepared {
  msg: Msg | null
  /** 因为什么不发（屏蔽词、回声等）。 */
  skip?: string
  images: Array<(FileData & { placeholder: string }) | { placeholder: string }>
  videos: Array<{ url: string; placeholder: string; file?: FileData }>
  /** 被屏蔽的桥。 */
  blocked: Set<string>
  /** 这条消息的翻译（同一条消息、同一个方向只翻一次，多个目标共用）。 */
  translation?: Promise<TranslationOutcome>
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
  /** 只暂停翻译：`global`、`<discord>:<qq>`。 */
  pausedTr = new Set<string>()
  translation: TranslationService
  /** 自检发现的问题：桥 key → 问题。 */
  health = new Map<string, string[]>()
  /** 本插件注册的命令（registerCommands 填进来）；这些命令和它们的子命令不转发（A8）。 */
  ownCommands = new Set<Command>()
  /** 注册 bridge.xxx 时自动建出来的上级命令（bridge）：它的子命令都算本插件的，单独一个词不算。 */
  ownGroups = new Set<Command>()
  private queues = new OrderedQueues()
  /** 两个方向各用一个预处理限流器，一个方向堵住不影响另一个（R8）。 */
  private limiters: Record<Direction, Limiter> = { d2q: new Limiter(4), q2d: new Limiter(4) }
  private seen = new SeenSet(10000)
  private sentIds = new SeenSet(10000)
  private lastseen = new Map<string, string>()
  private lastseenDirty = new Set<string>()
  /** 数据库里的 lastseen（补发起点用它，不用被实时消息推高的内存值，F3）。 */
  private persisted = new Map<string, string>()
  /** lastseen 还是上一次运行留下的（这次运行还没写过）的频道。 */
  private prevRun = new Set<string>()
  /** 上一次运行最后的 alive 心跳（毫秒）。 */
  private loadedAlive: number | undefined
  private startedAt = 0
  /** 这个实例安装之后收到过 READY。 */
  private readyReceived = false
  private roleNames = new TtlCache<Map<string, string>>(NAME_TTL)
  private channelInfo = new TtlCache<{ name?: string; guildId?: string }>(NAME_TTL)
  /** 查不到的频道（超时、出错）：短时间内不再查。 */
  private channelFailed: TtlCache<{ name?: string; guildId?: string }>
  private memberNames = new TtlCache<string>(NAME_TTL)
  private memberSlow = new TtlCache<true>(MEMBER_SLOW_TTL)
  private guildOf = new Map<string, string>()
  private reorder = new Map<string, Array<{ seq?: number; arrival: number; release: () => void }>>()
  private disposed = false
  /** dispose 时中止还在进行的下载。 */
  private abort = new AbortController()
  private warnedNoSeq = false
  private loaded: Promise<void>
  private resolveLoaded!: () => void
  private starting: Promise<void> | null = null
  /** load() 已经读完（dispose 时只有读完了才做最后一次写入，F2）。 */
  private loadedDone = false
  private checkTimer: NodeJS.Timeout | null = null
  private dateOf: (ms: number) => string
  /** 测试用：替换等待函数（也给提醒的发送用）。 */
  sleep?: RelayOptions['sleep']
  /** 两个机器人的连接状态、掉线提醒（V9、V10）。 */
  watch: LinkWatch

  constructor(public ctx: Context, config: Config, private options: RelayOptions = {}) {
    this.logger = ctx.logger('dcqq-bridge')
    this.now = options.now ?? Date.now
    this.sleep = options.sleep
    this.channelFailed = new TtlCache(CHANNEL_FAIL_TTL, this.now)
    this.settings = normalizeSettings(config)
    this.store = new Store(ctx)
    this.stats = new Stats(this.now)
    this.sender = new DiscordSender(this.logger)
    this.dateOf = dateIn(this.settings.timeZone)
    this.gate = new AtAllGate(this.store, () => this.settings.atAll, this.dateOf, this.now)
    this.translation = new TranslationService(ctx, () => this.settings, this.logger, this.now)
    this.watch = new LinkWatch(this)
    this.translation.memberNames = new MemberNames((group) => this.qqBot()?.internal?.getGroupMemberList(group), this.now)
    // 无效的行已经在 problems 里（F5），不再单独写一遍
    for (const problem of this.settings.problems) this.logger.warn(problem)
    for (const row of this.settings.rows) {
      for (const warning of row.warnings) this.logger.warn(`第 ${row.index} 行：${warning}`)
    }
    // 暂停状态、lastseen 读完之前，用到它们的地方都要等（start() 读完后 resolve）
    this.loaded = new Promise((resolve) => (this.resolveLoaded = resolve))
  }

  // ---------------------------------------------------------------- 生命周期

  install() {
    const ctx = this.ctx
    ctx.on('discord/message-create', (d: any, bot: any) => this.guard(() => {
      if (!this.isOurDiscord(bot)) return
      this.onDiscordMessage(d as RawMessage, false)
    }))
    ctx.on('discord/ready', (d: any, bot: any) => this.guard(() => {
      if (this.disposed || !this.isOurDiscord(bot, d?.user?.id)) return
      this.readyReceived = true
      // 同步取快照：READY 之后实时消息马上就会把 lastseen 往前推（R4）
      const snapshot = this.backfillSnapshot()
      setTimeout(() => this.onReady(snapshot).catch((e) => this.logger.warn('断线补发出错：%s', describeError(e))), 0)
    }))
    ctx.on('message-created', (session) => this.guard(() => this.onQQMessage(session)))
    ctx.on('bot-status-updated', (bot) => this.guard(() => {
      if (bot.status === Universal.Status.ONLINE) this.scheduleSelfCheck()
    }))
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => this.dispose())
    // 重载时适配器里已经有 webhook 缓存：马上认作自己的，防止重载那一刻的回声（A1）
    for (const wh of Object.values<any>(this.discordBot()?.webhooks ?? {})) {
      if (wh && typeof wh === 'object' && wh.id) this.sender.ownWebhooks.add(String(wh.id))
    }
  }

  private guard(fn: () => void) {
    try {
      fn()
    } catch (e) {
      this.logger.warn('处理事件出错：%s', describeError(e))
    }
  }

  start() {
    return this.starting ??= this.doStart()
  }

  private async doStart() {
    await this.load()
    this.startedAt = this.now()
    this.loadedDone = true
    this.resolveLoaded()
    if (this.options.timers !== false) {
      this.ctx.setInterval(() => void this.flushLastseen().catch(() => {}), 10000)
      this.ctx.setInterval(() => void this.heartbeat().catch(() => {}), ALIVE_INTERVAL)
      this.ctx.setInterval(() => void this.hourly().catch(() => {}), 3600000)
      this.ctx.setInterval(() => void this.watchTick(), 60000)
    }
    await this.translation.reload().catch((e) => this.logger.warn('读取关键词、术语表出错：%s', describeError(e)))
    // 在线词表：上面已经用了缓存，这里才在后台下载（不等），之后定时检查（0.4.0）
    if (!this.disposed) this.translation.startOnline(this.options.onlineRefreshMs)
    await this.hourly().catch(() => {})
    // 插件启动（重载）时 Discord 机器人已经在线：不补发，lastseen 设成频道最新的消息（A2）
    const bot = this.discordBot()
    if (!this.readyReceived && !this.disposed && bot?.status === Universal.Status.ONLINE && bot.selfId) {
      await this.prepareWebhooks(bot)
      for (const channel of this.backfillChannels()) {
        // 重载得很快时，旧实例这个循环可能还在跑：已经 dispose 就停（F2）
        if (this.disposed) return
        await this.resetLastseen(bot, channel)
      }
    }
    this.scheduleSelfCheck()
    if (this.options.timers !== false) void this.watchTick()
    await this.heartbeat().catch(() => {})
  }

  /** 每分钟的连接检查（V9、V10）；出错只记日志，不影响转发。 */
  async watchTick() {
    if (this.disposed) return
    await this.loaded
    await this.watch.tick().catch((e) => this.logger.warn('检查机器人连接出错：%s', describeError(e)))
  }

  /** 写 alive 心跳（和 lastseen 一起），READY 时用来判断插件停了多久。 */
  async heartbeat() {
    await this.loaded
    if (this.disposed) return
    await this.flushLastseen()
    await this.store.set('alive', this.now())
  }

  private async load() {
    try {
      for (const { key } of await this.store.entries('pause')) {
        const [kind, ...rest] = key.split(':')
        const pair = rest.join(':')
        if (kind !== 'pause' && kind !== 'pausetr') continue
        if (pair === 'global') {
          ;(kind === 'pause' ? this.paused : this.pausedTr).add('global')
          continue
        }
        if (!this.settings.allKeys.has(pair)) {
          await this.store.delete(key)
          this.logger.info(`已清除指向不存在的桥的暂停状态：${pair}`)
          continue
        }
        ;(kind === 'pause' ? this.paused : this.pausedTr).add(pair)
      }
    } catch (e) {
      // 读不到暂停状态时按「全局暂停」处理，宁可不转发
      this.paused.add('global')
      this.logger.warn('读取暂停状态失败，暂时全部暂停：%s', describeError(e))
    }
    try {
      const wanted = new Set(this.backfillChannels())
      for (const { key, value } of await this.store.entries('lastseen:')) {
        const channel = key.slice('lastseen:'.length)
        // 不再对应任何启用的 d2q/both 桥：删掉，以后重新启用时从那时开始，不补发
        if (!wanted.has(channel)) {
          await this.store.delete(key)
          this.logger.info(`已清除不再使用的频道 ${channel} 的 lastseen`)
          continue
        }
        if (typeof value !== 'string') continue
        this.persisted.set(channel, value)
        this.prevRun.add(channel)
        const current = this.lastseen.get(channel)
        if (!current || compareSnowflake(value, current) > 0) this.lastseen.set(channel, value)
      }
    } catch (e) {
      this.logger.warn('读取 lastseen 失败：%s', describeError(e))
    }
    try {
      const alive = await this.store.get<number>('alive')
      if (typeof alive === 'number' && Number.isFinite(alive)) this.loadedAlive = alive
    } catch {}
  }

  async dispose() {
    this.disposed = true
    this.abort.abort()
    // 在线词表：停掉定时检查，正在下载的结果不再使用
    this.translation.dispose()
    if (this.checkTimer) clearTimeout(this.checkTimer)
    // 最后一次写入：dispose 之后其他地方都不再写 lastseen（F2）
    if (this.starting && this.loadedDone) {
      await this.flushLastseen(true).catch(() => {})
      await this.store.set('alive', this.now()).catch(() => {})
    }
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
    // QQ 一直不恢复时，待补发的记录也只留 keepDays 天（V11）
    await this.store.prunePending(new Date(this.now() - this.settings.keepDays * 86400000))
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

  async setPaused(key: 'global' | string, paused: boolean, translationOnly = false) {
    const set = translationOnly ? this.pausedTr : this.paused
    const stateKey = `${translationOnly ? 'pausetr' : 'pause'}:${key}`
    if (paused) {
      set.add(key)
      await this.store.set(stateKey, true)
    } else {
      set.delete(key)
      await this.store.delete(stateKey)
    }
  }

  isTranslationPaused(bridge?: Bridge) {
    return this.pausedTr.has('global') || (!!bridge && this.pausedTr.has(bridge.key))
  }

  /** 这个桥现在要不要附译文（清单 §12.1 第 1 步）。 */
  needsTranslation(bridge: Bridge) {
    return this.settings.translate.enabled && bridge.translate && !this.isTranslationPaused(bridge)
  }

  /** 等这条消息的译文：最多 timeoutMs + 3 秒审核（清单 §6.2 第 7 步），超时就用原文。 */
  private async waitTranslation(bridge: Bridge, prepared: Prepared, deadline: number): Promise<string | undefined> {
    if (!prepared.translation || !this.needsTranslation(bridge)) return undefined
    const limit = Math.min(this.settings.translate.timeoutMs + 3500, Math.max(0, deadline - this.now() - 5000))
    const outcome = await timed(prepared.translation, limit, null)
    if (!outcome) {
      this.stats.translation(bridge.key, false, '等待超时')
      this.translation.logMissing(bridge.index, prepared.msg, { reason: '等待超时' })
      return undefined
    }
    if (outcome.ok) {
      this.stats.translation(bridge.key, true)
      return `${this.settings.translate.label} ${outcome.text}`
    }
    if (!outcome.skipped) this.stats.translation(bridge.key, false, outcome.reason)
    this.translation.logMissing(bridge.index, prepared.msg, outcome)
    return undefined
  }

  private startTranslation(msg: Msg, bridges: Bridge[], blocked: Set<string>, direction: 'en2zh' | 'zh2en', replay = false) {
    // 网关断线补发的消息不翻译（B4）；QQ 掉线后补发的消息（replay）要翻译（V11）
    if ((msg.backfill && !replay) || !this.settings.translate.enabled || !bridges.some((b) => !blocked.has(b.key) && b.translate)) return undefined
    // 暂停状态读完之后再判断（插件刚加载时 pausetr 还没读进来）
    return this.loaded.then(() => {
      if (!bridges.some((b) => !blocked.has(b.key) && this.needsTranslation(b))) return { ok: false, reason: '翻译暂停', skipped: true } as TranslationOutcome
      return this.translation.translate(msg, direction)
    }).catch((e): TranslationOutcome => {
      this.logger.warn('翻译出错：%s', describeError(e))
      return { ok: false, reason: '翻译出错', skipped: false }
    })
  }

  /**
   * 这条消息是不是本插件自己的命令（A8）：第一个词（有配置前缀时去掉一个）解析到的命令，
   * 或者它的上级命令，是本插件注册的。带不带前缀都算；其他插件的命令照常转发。
   * 和 Koishi 一样，`bridge status` 这种空格写法也算 bridge.status；只有 `bridge` 一个词（例如「bridge is down」）不算。
   */
  isOwnCommand(text: string): boolean {
    if (!this.ownCommands.size && !this.ownGroups.size) return false
    const word = commandWord(text, rootPrefixes(this.ctx.root.config))
    if (!word) return false
    const rest = text.trim().split(/\s+/).slice(1, 3)
    let command: any
    try {
      command = this.ctx.$commander.resolve(word)
      // 后面的词能接成子命令就用子命令
      let name = word
      for (const next of rest) {
        const sub = command && this.ctx.$commander.resolve(`${name}.${next}`)
        if (!sub) break
        command = sub
        name = `${name}.${next}`
      }
    } catch {
      return false
    }
    if (!command || this.ownGroups.has(command)) return false
    for (let c = command; c; c = c.parent) {
      if (this.ownCommands.has(c) || this.ownGroups.has(c)) return true
    }
    return false
  }

  // ---------------------------------------------------------------- lastseen

  private markSeen(channelId: string, id: string) {
    const current = this.lastseen.get(channelId)
    if (current && compareSnowflake(id, current) <= 0) return
    this.lastseen.set(channelId, id)
    this.lastseenDirty.add(channelId)
  }

  /** 把改过的 lastseen 写进数据库。dispose 之后只有 dispose 自己的那一次（final）会写（F2）。 */
  async flushLastseen(final = false) {
    await this.loaded
    if (this.disposed && !final) return
    const wanted = new Set(this.backfillChannels())
    for (const channel of [...this.lastseenDirty]) {
      // 没写的留给 dispose 的最后一次
      if (this.disposed && !final) return
      this.lastseenDirty.delete(channel)
      // 不再对应启用的 d2q/both 桥的频道不写（新配置里删掉的键不能被写回去）
      if (!wanted.has(channel)) continue
      const id = this.lastseen.get(channel)
      if (!id) continue
      await this.store.set(`lastseen:${channel}`, id)
      this.persisted.set(channel, id)
      this.prevRun.delete(channel)
    }
  }

  private isBridgeChannel(channelId: string) {
    return this.settings.bridges.some((b) => b.discord === channelId)
  }

  /** 需要补发的 Discord 频道（启用的 d2q/both 桥）。 */
  private backfillChannels() {
    return [...new Set(this.settings.bridges.filter((b) => b.direction !== 'q2d').map((b) => b.discord))]
  }

  /** READY 那一刻每个频道的补发起点：优先用数据库里的值（F3）。 */
  private backfillSnapshot() {
    const snapshot = new Map<string, { after: string; prevRun: boolean }>()
    for (const channel of this.backfillChannels()) {
      const saved = this.persisted.get(channel)
      const after = saved ?? this.lastseen.get(channel)
      if (after) snapshot.set(channel, { after, prevRun: !!saved && this.prevRun.has(channel) })
    }
    return snapshot
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
    // 适配器缓存的 webhook（重载后新实例的集合里还没有，A1）
    const cached = bot?.webhooks?.[d.channel_id]?.id
    if (d.webhook_id && cached && String(cached) === String(d.webhook_id)) return
    if (this.sentIds.has(d.id)) return
    if (!DISCORD_TYPES.has(Number(d.type ?? 0))) return
    // 3. 找桥
    const bridges = bridgesFrom(this.settings, 'discord', d.channel_id)
    if (!bridges.length) return
    // 本插件的命令不转发（A8）；开头 @ 机器人的也算
    const content = String(d.content ?? '').replace(/^\s*<@!?(\d+)>/, (all, id) => (bot?.selfId && id === bot.selfId ? '' : all))
    if (this.isOwnCommand(content)) return void this.logger.debug(`Discord 频道 ${d.channel_id} 的消息 ${d.id} 是本插件的命令，不转发`)
    // 4. 暂停
    const active = bridges.filter((b) => !this.isPaused(b))
    if (!active.length) return
    // 5. 在第一个 await 之前占好位置
    const slots = active.map((bridge) => ({ bridge, slot: this.queues.reserve(`onebot:${bridge.qq}`) }))
    const queuedAt = this.now()
    // 6. 预处理立即开始
    const prepared = this.limiters.d2q.run(() => this.prepareDiscord(d, backfill, active)).catch((e): Prepared => {
      this.logger.warn('处理 Discord 消息 %s 出错：%s', d.id, describeError(e))
      return { msg: null, skip: '预处理出错', images: [], videos: [], blocked: new Set() }
    })
    const release = this.releaseAfter(prepared, slots.length)
    for (const { bridge, slot } of slots) {
      void slot.turn
        .then(() => this.tooOld(bridge, 'd2q', queuedAt, d.id) ? undefined : this.deliverToQQ(bridge, prepared))
        .catch((e) => this.logger.warn('转发到 QQ 群 %s 出错：%s', bridge.qq, describeError(e)))
        .finally(() => {
          slot.done()
          release()
        })
    }
  }

  /** 所有目标都处理完后丢掉下载好的文件，让内存尽快释放（R9）。 */
  private releaseAfter(prepared: Promise<Prepared>, count: number) {
    let left = count
    return () => {
      if (--left > 0) return
      void prepared.then((p) => {
        p.images = []
        p.videos = []
      }, () => {})
    }
  }

  /** 成为队首时已经排了超过 maxQueueAgeMinutes：丢掉并写日志（R9）。 */
  private tooOld(bridge: Bridge, direction: Direction, queuedAt: number, messageId?: string) {
    if (this.disposed) return true
    const raw = Number(this.settings.maxQueueAgeMinutes ?? 15)
    const minutes = Number.isFinite(raw) ? Math.min(1440, Math.max(0, raw)) : 15
    // 0 = 不限制
    const waited = this.now() - queuedAt
    if (!minutes || waited <= minutes * 60000) return false
    this.fail(bridge, direction, `在队列里等了 ${Math.round(waited / 60000)} 分钟（超过 ${minutes} 分钟），丢弃`, messageId)
    return true
  }

  /** replay：QQ 掉线后补发（V11）。「已经转发过」由补发流程按桥检查，这里不查；译文照常请求。 */
  private async prepareDiscord(d: RawMessage, backfill: boolean, bridges: Bridge[], replay = false): Promise<Prepared> {
    const empty = (skip: string): Prepared => ({ msg: null, skip, images: [], videos: [], blocked: new Set() })
    // 回声兜底：别人的 webhook 集合里没有、但对应表里有（例如重启后）
    if (d.webhook_id && !this.sender.ownWebhooks.has(String(d.webhook_id))) {
      if ((await this.store.byTarget(d.channel_id, d.id)).length) return empty('自己发出的消息')
    }
    if (backfill && !replay && await this.store.hasSource(d.channel_id, d.id)) return empty('已经转发过')
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
    const translation = this.startTranslation(msg, bridges, blocked, 'en2zh', replay)
    const images: Prepared['images'] = []
    const videos: Prepared['videos'] = []
    await Promise.all(msg.media.map(async (media, i) => {
      if (media.kind === 'image') {
        const file = await download(this.ctx, media, { signal: this.abort.signal, maxBytes: QQ_IMAGE_LIMIT })
        images[i] = file ? { ...file, placeholder: media.placeholder } : { placeholder: media.placeholder }
      } else if (media.kind === 'video') {
        videos[i] = { url: media.urls[0] ?? '', placeholder: media.placeholder }
      } else {
        images[i] = { placeholder: media.placeholder }
      }
    }))
    return { msg, images: images.filter(Boolean), videos: videos.filter(Boolean), blocked, translation }
  }

  /** 返回 true = 这条消息还在待补发列表里（V11：QQ 没登录，这次没发出去；或者插件正在停用）。 */
  private async deliverToQQ(bridge: Bridge, preparing: Promise<Prepared>): Promise<boolean> {
    if (this.disposed) return true
    const head = this.now()
    const deadline = head + HEAD_LIMIT
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEAD_LIMIT)
    try {
      const prepared = await Promise.race([preparing, sleepUntil(deadline, this.now).then(() => null)])
      if (!prepared) {
        this.fail(bridge, 'd2q', '预处理超过 60 秒')
        return false
      }
      const msg = prepared.msg
      if (!msg || prepared.skip || prepared.blocked.has(bridge.key)) return false
      await this.loaded
      if (this.isPaused(bridge)) return false
      if (this.disposed) return true
      const bot = this.qqBot()
      // @全体（清单 §11）
      let atAll: Awaited<ReturnType<AtAllGate['decide']>> | null = null
      if (bridge.atAll && msg.mentionEveryone && bridge.direction !== 'q2d') {
        // 已经 dispose：不再做 @全体 决定（A1）
        if (this.disposed) return true
        if (!bot || !qqOnline(bot)) atAll = { ok: false, reason: '查询失败' }
        else atAll = await this.gate.decide(bot, bridge.qq, msg, deadline)
        // 在发送之前就记下次数；已经超时或记不下来时改发文字
        if (atAll.ok && this.now() >= deadline) atAll = { ok: false, reason: '查询失败' }
        if (atAll.ok) {
          try {
            await atAll.commit()
          } catch {
            atAll = { ok: false, reason: '查询失败' }
          }
        }
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
      const translated = await this.waitTranslation(bridge, prepared, deadline)
      const prefix = prefixFor(bridge.label, msg.author, msg.backfill)
      const sends = buildQQSends({
        quoteId,
        atAll: !!atAll?.ok,
        fallbackText: atAll && !atAll.ok ? this.settings.atAll.fallbackText : undefined,
        prefix,
        replyLine: line,
        text: fullText(msg),
        translation: translated,
        images: prepared.images.map((image) => ('data' in image ? { data: image.data, mime: image.mime } : { placeholder: image.placeholder })),
        videos: prepared.videos.map((video) => ({ url: video.url, placeholder: video.placeholder })),
      })
      if (!sends.length) {
        if (atAll?.ok) await atAll.revert().catch(() => {})
        return false
      }
      let part = 0
      let failure = ''
      /** 这条消息留在待补发列表里：QQ 发不出去，或者第一段还没发插件就停用了。 */
      let keep = false
      // 打开了掉线补发的桥：已经知道 QQ 掉线时不再等它连上，直接记进待补发列表（V11）
      const sendOptions = { signal: controller.signal, deadline, sleep: this.sleep, noWait: () => bridge.qqBackfill && this.watch.qqDown }
      for (let i = 0; i < sends.length; i++) {
        if (this.disposed) {
          if (i === 0 && atAll?.ok) await atAll.revert().catch(() => {})
          if (i === 0) keep = true
          break
        }
        if (this.now() >= deadline) {
          if (i === 0 && atAll?.ok) await atAll.revert().catch(() => {})
          failure = '超过 60 秒，后面的分段没有发出'
          break
        }
        let result = await sendQQ(() => this.qqBot(), bridge.qq, sends[i], sendOptions)
        // 超时：消息可能已经发出，先去群里核对，没发出才重发一次（V3）
        if (!result.ok && result.timedOut) result = await this.recheckAfterTimeout(bridge, msg, sends[i], prefix.length, i, result, sendOptions)
        // 明确没发出去：QQ 未连接，或者 LLBot 回复失败并且确认是因为 QQ 没登录（V11）
        const notSent = !result.ok && (!result.maybeSent || (bridge.qqBackfill && await this.notLoggedIn(result)))
        if (i === 0 && atAll?.ok && notSent) await atAll.revert().catch(() => {})
        if (result.ok) {
          if (result.messageId) await this.record(msg, 'onebot', bridge.qq, result.messageId, part)
          part++
          continue
        }
        // 第一段就没发出去：记进待补发列表，不算转发失败（V11）
        if (i === 0 && notSent && bridge.qqBackfill && await this.queuePending(bridge, msg, result.reason)) {
          keep = true
          break
        }
        // 视频发送失败：改发文字（这是另一条消息，不算重试）
        const video = this.videoOf(sends[i], prepared)
        if (video && result.reason !== 'QQ 未连接') {
          const fallback = await sendQQ(() => this.qqBot(), bridge.qq, [h.text(video.placeholder)], sendOptions)
          if (fallback.ok) {
            await this.record(msg, 'onebot', bridge.qq, fallback.messageId, part++)
            continue
          }
        }
        failure = result.reason
        this.logger.warn(`转发失败 [第 ${bridge.index} 个桥 d2q 消息 ${msg.messageId} 第 ${i + 1} 段]：${result.reason}`)
        if (!result.maybeSent && i === 0) break
      }
      this.count(bridge, part > 0, failure)
      return keep
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 发 QQ 超时之后（0.4.1 V3）：消息可能已经发出（S21），所以先等几秒，去群里取最近 20 条看机器人有没有发过这一条。
   * 已送达 → 当作成功；没有 → 在队首时限内重发一次；查询本身失败 → 不重发（宁可丢，不重复）。日志写明核对结果，不写消息内容。
   */
  private async recheckAfterTimeout(
    bridge: Bridge, msg: Msg, elements: Element[], prefixLength: number, index: number,
    failure: QQResult & { ok: false }, options: { signal: AbortSignal; deadline: number; sleep?: RelayOptions['sleep'] },
  ): Promise<QQResult> {
    const where = `第 ${bridge.index} 个桥 d2q 消息 ${msg.messageId} 第 ${index + 1} 段`
    await (this.sleep ?? defaultSleep)(VERIFY_WAIT, options.signal).catch(() => {})
    const bot = this.qqBot()
    if (this.disposed || !bot || !qqOnline(bot)) {
      this.logger.warn(`${where} 超时后核对：查询失败（QQ 已断开），不重发`)
      return failure
    }
    const checked = await checkDelivered(bot, bridge.qq, elements, prefixLength)
    if (checked.state === 'sent') {
      this.logger.info(`${where} 超时后核对：已送达，不重发`)
      return { ok: true, messageId: checked.messageId }
    }
    if (checked.state === 'unknown') {
      this.logger.warn(`${where} 超时后核对：查询失败（${checked.reason}），不重发`)
      return failure
    }
    if (this.now() >= options.deadline) {
      this.logger.warn(`${where} 超时后核对：未送达，但已超过 60 秒发送期限，不重发`)
      return failure
    }
    const again = await sendQQ(() => this.qqBot(), bridge.qq, elements, options)
    if (again.ok) this.logger.info(`${where} 超时后核对：未送达，已重发`)
    else this.logger.warn(`${where} 超时后核对：未送达，已重发但仍然失败：${again.reason}`)
    return again
  }

  /** LLBot 回复了失败（有 retcode）时，确认是不是因为 QQ 没登录；没登录就肯定没发出去（V11）。 */
  private async notLoggedIn(result: QQResult & { ok: false }) {
    if (result.retcode === undefined) return false
    return (await this.watch.refreshQQ()) === 'loggedOut'
  }

  // ---------------------------------------------------------------- QQ 掉线期间的补发（V11）

  /** 记一条待补发的消息；记不下来返回 false（照普通失败处理）。 */
  private async queuePending(bridge: Bridge, msg: Msg, reason: string): Promise<boolean> {
    try {
      const sentAt = Number.isFinite(msg.timestamp) && msg.timestamp > 0 ? msg.timestamp : this.now()
      await this.store.addPending(bridge.key, msg.channelId, msg.messageId, new Date(sentAt))
      this.logger.info(`第 ${bridge.index} 个桥 d2q 消息 ${msg.messageId}：QQ 现在发不出去（${reason}），已记入待补发，QQ 恢复后补发`)
      return true
    } catch (e) {
      this.logger.warn('记录待补发消息失败：%s', describeError(e))
      return false
    }
  }

  /** QQ 机器人恢复了：马上补发掉线期间记下来的消息，并重新做一次健康检查。 */
  onQQRecovered() {
    this.scheduleSelfCheck()
    void this.replayPending()
  }

  private replayJob: Promise<void> | null = null

  /**
   * 补发 QQ 掉线期间记下来的消息（V11）：按原来的顺序，只补最近 backfill.qqOfflineMinutes 分钟的，更早的只写一行日志。
   * 内容向 Discord 重新取（消息已删除就不补），前缀带「（补发）」，不 @全体，译文照常请求。同时只跑一次。
   */
  replayPending(): Promise<void> {
    return this.replayJob ??= this.doReplay()
      .catch((e) => void this.logger.warn('补发 QQ 掉线期间的消息出错：%s', describeError(e)))
      .finally(() => (this.replayJob = null))
  }

  private async doReplay() {
    await this.loaded
    const qq = this.qqBot()
    if (this.disposed || this.watch.qqDown || !qq || !qqOnline(qq)) return
    // 没有桥打开掉线补发（默认）：不用查数据库，每分钟的检查不增加负担
    if (!this.settings.bridges.some((b) => b.qqBackfill)) return
    const all = await this.store.pending()
    if (!all.length) return
    // 原来的顺序：先按发出的时间，同一时刻按消息 ID
    all.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || compareSnowflake(a.message, b.message))
    const minutes = this.settings.backfill.qqOfflineMinutes
    const now = this.now()
    const groups = new Map<string, { channel: string; message: string; rows: Array<{ row: PendingRow; bridge: Bridge }> }>()
    let expired = 0
    for (const row of all) {
      const bridge = this.settings.bridges.find((b) => b.key === row.bridge)
      // 桥已经删了、停用了或者关掉了补发：这条不补
      if (!bridge || !bridge.qqBackfill || bridge.direction === 'q2d') {
        await this.store.removePending(row.key)
        continue
      }
      if (now - row.sentAt.getTime() > minutes * 60000) {
        await this.store.removePending(row.key)
        expired++
        continue
      }
      const id = `${row.channel}:${row.message}`
      let group = groups.get(id)
      if (!group) groups.set(id, group = { channel: row.channel, message: row.message, rows: [] })
      group.rows.push({ row, bridge })
    }
    if (expired) this.logger.warn(`QQ 掉线期间有 ${expired} 条超过 ${minutes} 分钟，没有补发`)
    if (!groups.size) return
    const discord = this.discordBot()
    // Discord 暂时不可用：留着，下一分钟再试
    if (!discord) return
    const jobs: Array<Promise<void>> = []
    let count = 0
    /** QQ 又发不出去、留在待补发列表里的条数。 */
    let kept = 0
    for (const group of groups.values()) {
      if (this.disposed) break
      if (count >= QQ_REPLAY_MAX) {
        this.logger.warn(`待补发的消息超过 ${QQ_REPLAY_MAX} 条，这次先补发最早的 ${QQ_REPLAY_MAX} 条，其余的下一分钟继续`)
        break
      }
      let raw: RawMessage
      try {
        raw = await discord.internal.getChannelMessage(group.channel, group.message)
      } catch (e) {
        const info = internalErrorInfo(e)
        if (info.status === 404 || info.code === 10008) {
          // 消息已经被删了
          this.logger.debug(`待补发的消息 ${group.message} 在 Discord 上已经不存在，不补发`)
          for (const { row } of group.rows) await this.store.removePending(row.key)
          continue
        }
        // Discord 暂时取不到：这一条和后面的都留着（保持顺序），下一分钟再试
        this.logger.warn('补发时向 Discord 取消息失败：%s', describeError(e))
        break
      }
      // 已经发到过这个群的不重复发（例如上一次补发到一半插件重启了）
      const targets: Array<{ row: PendingRow; bridge: Bridge }> = []
      for (const target of group.rows) {
        if (await this.store.hasSource(group.channel, group.message, target.bridge.qq)) await this.store.removePending(target.row.key)
        else targets.push(target)
      }
      if (!targets.length) continue
      count++
      const d = { ...raw, channel_id: raw.channel_id ?? group.channel }
      const bridges = targets.map((t) => t.bridge)
      // 在第一个 await 之前占好位置，保证补发的先后顺序
      const slots = targets.map((target) => ({ ...target, slot: this.queues.reserve(`onebot:${target.bridge.qq}`) }))
      const queuedAt = this.now()
      const prepared = this.limiters.d2q.run(() => this.prepareDiscord(d, true, bridges, true)).catch((e): Prepared => {
        this.logger.warn('处理待补发的 Discord 消息 %s 出错：%s', d.id, describeError(e))
        return { msg: null, skip: '预处理出错', images: [], videos: [], blocked: new Set() }
      })
      const release = this.releaseAfter(prepared, slots.length)
      for (const { row, bridge, slot } of slots) {
        jobs.push(slot.turn
          // 插件已经停了（重载 / 卸载）：没发的行留在库里，由新实例接着补发，不能当成已处理删掉
          .then(() => this.disposed ? true : this.tooOld(bridge, 'd2q', queuedAt, d.id) ? false : this.deliverToQQ(bridge, prepared))
          // QQ 又掉线了会再次记进待补发列表（keep = true），其他情况这条就处理完了
          .then((keep) => {
            if (!keep) return this.store.removePending(row.key)
            kept++
          })
          .catch((e) => {
            this.logger.warn('补发到 QQ 群 %s 出错：%s', bridge.qq, describeError(e))
            if (this.disposed) return
            return this.store.removePending(row.key).catch(() => {})
          })
          .finally(() => {
            slot.done()
            release()
          }))
      }
    }
    await Promise.all(jobs)
    if (jobs.length) this.logger.info(`QQ 掉线期间的消息：处理了 ${jobs.length} 条${kept ? `，其中 ${kept} 条因为 QQ 又发不出去，留到下次恢复后补发` : ''}`)
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
    // 本插件的命令不转发（A8）；stripped.content 已经去掉了开头的 @机器人
    if (this.isOwnCommand(session.stripped?.content ?? session.content ?? '')) {
      return void this.logger.debug(`QQ 群 ${session.channelId} 的消息 ${session.messageId} 是本插件的命令，不转发`)
    }
    const delay = this.settings.qqReorderMs
    if (delay > 0) return this.buffer(session, delay, () => this.dispatchQQ(session, bridges))
    this.dispatchQQ(session, bridges)
  }

  /** QQ 消息重排（DECISIONS 第 12 条）：每条等 delay 毫秒；到点时连同序号更小的一起按序号放行。 */
  private buffer(session: Session, delay: number, release: () => void) {
    const group = session.channelId!
    const seqRaw = Number((session as any).onebot?.message_seq)
    const item = { seq: Number.isFinite(seqRaw) ? seqRaw : undefined, arrival: this.now(), release }
    if (item.seq === undefined && !this.warnedNoSeq) {
      this.warnedNoSeq = true
      this.logger.info('QQ 消息没有带消息序号（message_seq），重排只能按到达顺序')
    }
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
    const queuedAt = this.now()
    const prepared = this.limiters.q2d.run(() => this.prepareQQ(session, active)).catch((e): Prepared => {
      this.logger.warn('处理 QQ 消息 %s 出错：%s', session.messageId, describeError(e))
      return { msg: null, skip: '预处理出错', images: [], videos: [], blocked: new Set() }
    })
    const release = this.releaseAfter(prepared, slots.length)
    for (const { bridge, slot } of slots) {
      void slot.turn
        .then(() => this.tooOld(bridge, 'q2d', queuedAt, session.messageId) ? undefined : this.deliverToDiscord(bridge, prepared))
        .catch((e) => this.logger.warn('转发到 Discord 频道 %s 出错：%s', bridge.discord, describeError(e)))
        .finally(() => {
          slot.done()
          release()
        })
    }
  }

  private async prepareQQ(session: Session, bridges: Bridge[]): Promise<Prepared> {
    const bot = this.qqBot()
    const names = new Map<string, string>()
    const ids = [...collectAtIds(session.elements ?? []), ...collectAtIds(session.quote?.elements ?? [])]
    // 并行查，每个最多 5 秒（R8）
    await Promise.all([...new Set(ids)].map(async (id) => {
      const name = await this.memberName(bot, session.channelId!, id)
      if (name) names.set(id, name)
    }))
    const msg = parseQQMessage(session, { selfId: session.selfId, memberName: (id) => names.get(id), now: this.now() })
    const blocked = new Set<string>()
    for (const bridge of bridges) {
      if (bridge.blockWords.some((re) => re.test(msg.checkText))) blocked.add(bridge.key)
    }
    if (blocked.size === bridges.length) return { msg, skip: '命中屏蔽词', images: [], videos: [], blocked }
    const translation = this.startTranslation(msg, bridges, blocked, 'zh2en')
    const images: Prepared['images'] = []
    await Promise.all(msg.media.map(async (media, i) => {
      const limit = media.kind === 'video' ? QQ_VIDEO_LIMIT : DISCORD_FILE_LIMIT
      const file = media.urls.length ? await download(this.ctx, media, { signal: this.abort.signal, maxBytes: limit }) : null
      images[i] = file ? { ...file, placeholder: media.placeholder } : { placeholder: media.placeholder }
    }))
    return { msg, images: images.filter(Boolean), videos: [], blocked, translation }
  }

  private async deliverToDiscord(bridge: Bridge, preparing: Promise<Prepared>) {
    if (this.disposed) return
    const head = this.now()
    const deadline = head + HEAD_LIMIT
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEAD_LIMIT)
    try {
      const prepared = await Promise.race([preparing, sleepUntil(deadline, this.now).then(() => null)])
      if (!prepared) return this.fail(bridge, 'q2d', '预处理超过 60 秒')
      const msg = prepared.msg
      if (!msg || prepared.skip || prepared.blocked.has(bridge.key)) return
      await this.loaded
      if (this.isPaused(bridge) || this.disposed) return
      const bot = this.discordBot()
      if (!bot) return this.fail(bridge, 'q2d', this.botProblem('discord') ?? '没有 Discord 机器人')
      const limit = () => Math.max(0, Math.min(15000, deadline - this.now()))
      // 取 webhook 也受 60 秒限制；超时就当作 webhook 用不了（改由机器人发）
      let webhook: Webhook | null = this.settings.discordAsWebhook ? await timed(this.sender.tryWebhook(bot, bridge.discord), limit(), null) : null
      const found = msg.reply ? await this.findReplyTarget(msg.channelId, msg.reply.messageId, bridge.discord) : {}
      const link = found.targetId ? await timed(this.messageLink(bot, bridge.discord, found.targetId), limit(), undefined) : undefined
      const translated = await this.waitTranslation(bridge, prepared, deadline)
      let result = await this.sendToDiscord(bot, bridge, msg, prepared, webhook, found, link, deadline, controller.signal, translated)
      // webhook 失效又重建不了：改由机器人发（DECISIONS 第 9 条）
      if (result === 'webhookGone') {
        webhook = null
        result = await this.sendToDiscord(bot, bridge, msg, prepared, null, found, link, deadline, controller.signal, translated)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async sendToDiscord(
    bot: any, bridge: Bridge, msg: Msg, prepared: Prepared, webhook: Webhook | null,
    found: { targetId?: string; forwardedFrom?: MessageRow }, link: string | undefined, deadline: number, signal: AbortSignal,
    translated?: string,
  ): Promise<'done' | 'webhookGone'> {
    {
      // 回复（清单 §9）
      let line: string | undefined
      let replyTo: string | undefined
      if (msg.reply) {
        if (found.targetId && !webhook) replyTo = found.targetId
        else if (found.targetId) line = this.replyText(msg, found.forwardedFrom, link)
        else line = this.replyText(msg, found.forwardedFrom)
      }
      const files = prepared.images.filter((x): x is FileData & { placeholder: string } => 'data' in x)
      const placeholders = prepared.images.filter((x) => !('data' in x)).map((x) => x.placeholder)
      const contents = buildDiscordContents({
        prefix: webhook ? '' : prefixFor(bridge.label, msg.author, false),
        replyLine: line,
        // 顺序：渲染 → 附加译文 → 转义 → 加前缀 → 切分（清单 §8.3）
        text: [[fullText(msg), translated].filter(Boolean).join('\n\n'), ...placeholders].filter(Boolean).join('\n'),
      })
      if (!contents.length && !files.length) return 'done'
      if (!contents.length) contents.push('')
      const username = webhook ? webhookUsername(bridge.label, msg.author) : undefined
      // 文件跟着最后一段；一次最多 10 个、总共不超过 24 MiB，多的另起一次发送
      const batches: Array<{ content: string; files: typeof files }> = contents.map((content) => ({ content, files: [] }))
      fileBatches(files).forEach((chunk, i) => {
        if (i === 0) batches[batches.length - 1].files = chunk
        else batches.push({ content: '', files: chunk })
      })
      let part = 0
      let failure = ''
      for (let i = 0; i < batches.length; i++) {
        // 已经 dispose：不再发起新的发送（已发出的请求不中止）
        if (this.disposed) break
        if (this.now() >= deadline) {
          failure = '超过 60 秒，后面的分段没有发出'
          break
        }
        const result = await this.sender.send(bot, bridge.discord, {
          content: batches[i].content,
          username,
          avatarUrl: msg.avatar,
          replyTo: i === 0 ? replyTo : undefined,
          files: batches[i].files,
        }, webhook, { signal, deadline, sleep: this.sleep })
        if (result.ok) {
          for (const id of [result.messageId, ...(result.extraIds ?? [])]) {
            this.sentIds.add(id)
            await this.record(msg, 'discord', bridge.discord, id, part++)
          }
          continue
        }
        if (result.webhookGone && i === 0) return 'webhookGone'
        failure = result.reason
        this.logger.warn(`转发失败 [第 ${bridge.index} 个桥 q2d 消息 ${msg.messageId} 第 ${i + 1} 段]：${result.reason}`)
        if (!result.maybeSent && i === 0) break
      }
      this.count(bridge, part > 0, failure)
      return 'done'
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

  /** 每条消息每个桥只统计一次（清单 §13：24 小时转发数和失败数）。 */
  private count(bridge: Bridge, delivered: boolean, failure: string) {
    if (delivered) this.stats.forwarded(bridge.key)
    if (failure) this.stats.failed(bridge.key, failure)
  }

  private fail(bridge: Bridge, direction: Direction, reason: string, messageId?: string) {
    this.stats.failed(bridge.key, reason)
    this.logger.warn(`转发失败 [第 ${bridge.index} 个桥 ${direction}${messageId ? ` 消息 ${messageId}` : ''}]：${reason}`)
  }

  // ---------------------------------------------------------------- 名字缓存

  /** 频道名和所在服务器。查询超时或出错时 60 秒内不再查（F4），每条提到它的消息不用都等一次超时。 */
  private async channel(bot: any, channelId: string): Promise<{ name?: string; guildId?: string }> {
    const cached = this.channelInfo.get(channelId)
    if (cached) return cached
    const failed = this.channelFailed.get(channelId)
    if (failed) return failed
    try {
      // timed() 超时和出错都返回 undefined
      const raw = await timed<any, undefined>(bot?.internal?.getChannel(channelId), CHANNEL_TIMEOUT, undefined)
      if (raw === undefined || raw === null) {
        this.channelFailed.set(channelId, {})
        return {}
      }
      const info = { name: raw?.name, guildId: raw?.guild_id }
      if (info.guildId) this.guildOf.set(channelId, info.guildId)
      this.channelInfo.set(channelId, info)
      return info
    } catch {
      this.channelFailed.set(channelId, {})
      return {}
    }
  }

  private async roles(bot: any, guildId: string): Promise<Map<string, string>> {
    const cached = this.roleNames.get(guildId)
    if (cached) return cached
    const map = new Map<string, string>()
    try {
      for (const role of await timed<any[], any[]>(bot?.internal?.getGuildRoles(guildId), 10000, []) ?? []) map.set(String(role.id), String(role.name))
    } catch {}
    this.roleNames.set(guildId, map)
    return map
  }

  private async memberName(bot: any, groupId: string, userId: string): Promise<string | undefined> {
    const key = `${groupId}:${userId}`
    const cached = this.memberNames.get(key)
    if (cached !== undefined) return cached || undefined
    // 刚刚查询超时过：短时间内不再查，直接用 QQ 号
    if (this.memberSlow.get(key)) return undefined
    const lookup = Promise.resolve()
      .then(() => bot?.getGuildMember(groupId, userId))
      .then((member: any) => {
        const name = member?.nick || member?.user?.name || ''
        this.memberNames.set(key, name)
        return name as string
      }, () => {
        this.memberNames.set(key, '')
        return ''
      })
    const name = await timed(lookup, MEMBER_TIMEOUT, undefined)
    if (name === undefined) {
      this.memberSlow.set(key, true)
      return undefined
    }
    return name || undefined
  }

  // ---------------------------------------------------------------- 断线补发（清单 §15）

  private async onReady(snapshot: Map<string, { after: string; prevRun: boolean }>) {
    await this.loaded
    const bot = this.discordBot()
    if (!bot || this.disposed) return
    await this.prepareWebhooks(bot)
    // 插件停了多久：上一次运行最后的 alive 到这次启动（没有记录按「太久」处理）
    const downtime = this.loadedAlive === undefined ? Infinity : this.startedAt - this.loadedAlive
    for (const channel of this.backfillChannels()) {
      if (this.disposed) return
      // READY 比读完数据库还早时快照是空的，这时再取一次
      const point = snapshot.get(channel) ?? this.backfillSnapshot().get(channel)
      if (!point) {
        // 没有记录：不补发，从现在开始（DECISIONS 第 10 条）
        await this.initLastseen(bot, channel)
        continue
      }
      if (point.prevRun && downtime > ALIVE_STALE) {
        // 起点是插件停止之前留下的，而且停了超过 15 分钟：不补发，只重置
        this.logger.info(`频道 ${channel}：插件停止超过 15 分钟，不补发，从现在开始`)
        await this.resetLastseen(bot, channel)
        continue
      }
      await this.backfill(bot, channel, point.after).catch((e) => this.logger.warn(`频道 ${channel} 补发失败：${describeError(e)}`))
    }
    this.scheduleSelfCheck()
  }

  /** 自己的 webhook 集合（§6.3）。 */
  private async prepareWebhooks(bot: any) {
    if (!this.settings.discordAsWebhook) return
    for (const channel of new Set(this.settings.bridges.filter((b) => b.direction !== 'd2q').map((b) => b.discord))) {
      await this.sender.ensureWebhook(bot, channel).catch(() => {})
    }
  }

  /** 频道最新一条消息的 ID；取不到时用现在的时间。 */
  private async latestId(bot: any, channel: string) {
    const raw = await timed<any, undefined>(bot?.internal?.getChannel(channel), 10000, undefined)
    return (raw?.last_message_id as string | undefined) || snowflakeFromTime(this.now())
  }

  private async initLastseen(bot: any, channel: string) {
    const id = await this.latestId(bot, channel)
    if (this.disposed) return
    const current = this.lastseen.get(channel)
    if (current) return
    this.lastseen.set(channel, id)
    this.lastseenDirty.add(channel)
    await this.flushLastseen().catch(() => {})
  }

  /** 不补发：lastseen 直接设成频道最新的消息（A2）。 */
  private async resetLastseen(bot: any, channel: string) {
    const id = await this.latestId(bot, channel)
    if (this.disposed) return
    const current = this.lastseen.get(channel)
    // 期间实时消息推得更高（且不是上次运行留下的）就用那个
    if (current && !this.prevRun.has(channel) && compareSnowflake(current, id) > 0) this.lastseen.set(channel, current)
    else this.lastseen.set(channel, id)
    this.lastseenDirty.add(channel)
    this.prevRun.delete(channel)
    await this.flushLastseen().catch(() => {})
  }

  async backfill(bot: any, channel: string, after: string) {
    if (this.disposed) return 0
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
    if (this.disposed) return 0
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
    // 先问一次 QQ 有没有登录（V9）：没登录（或 OneBot 断开）时所有 QQ 接口都会失败，
    // 这里整个跳过；掉线本身由 watch 写一行日志，不再每座桥每次都写警告
    const link = await this.watch.refreshQQ()
    if (!discord || !qq || link !== 'ok') return
    // 同一个频道、同一个群每次自检只查一次（A8）：多个桥指向同一个群时共用结果。返回问题，没问题返回 null
    const once = new Map<string, Promise<string | null>>()
    const check = (key: string, fn: () => Promise<string | null>) => {
      let result = once.get(key)
      if (!result) once.set(key, result = fn())
      return result
    }
    for (const bridge of this.settings.bridges) {
      const problems: (string | null)[] = []
      problems.push(await check(`channel:${bridge.discord}`, async () => {
        try {
          const raw = await discord.internal.getChannel(bridge.discord)
          if (raw?.guild_id) this.guildOf.set(bridge.discord, raw.guild_id)
          return null
        } catch (e) {
          return `取不到 Discord 频道（${describeError(e)}）`
        }
      }))
      if (this.settings.discordAsWebhook && bridge.direction !== 'd2q') {
        problems.push(await check(`webhook:${bridge.discord}`, async () => {
          try {
            await this.sender.ensureWebhook(discord, bridge.discord, true)
            return null
          } catch (e) {
            const info = internalErrorInfo(e)
            return info.code === 50013 || info.status === 403 ? 'webhook 不可用（机器人没有「管理 Webhook」权限），改由机器人发送' : `webhook 不可用（${describeError(e)}）`
          }
        }))
      }
      problems.push(await check(`group:${bridge.qq}`, async () => {
        try {
          await qq.getGuild(bridge.qq)
          return null
        } catch (e) {
          return `取不到 QQ 群（${describeError(e)}）`
        }
      }))
      if (bridge.atAll) {
        problems.push(await check(`admin:${bridge.qq}`, async () => {
          try {
            return (await this.gate.isAdmin(qq, bridge.qq, true)) ? null : '⚠ 不是管理员'
          } catch (e) {
            return `查不到机器人在群里的身份（${describeError(e)}）`
          }
        }))
      }
      const found = problems.filter((p): p is string => !!p)
      const before = this.health.get(bridge.key)
      // 同一个问题只在状态变化时写日志：第一次出现、内容变了、恢复了（V9）
      if (found.length) {
        this.health.set(bridge.key, found)
        if (!before || before.join('\n') !== found.join('\n')) this.logger.warn(`第 ${bridge.index} 个桥：${found.join('；')}`)
      } else {
        this.health.delete(bridge.key)
        if (before) this.logger.info(`第 ${bridge.index} 个桥：之前的问题已恢复`)
      }
    }
  }
}

function fullText(msg: Msg) {
  return [msg.body, ...msg.blocks].filter((s) => s.trim() !== '').join('\n\n')
}

/** 最多等 ms 毫秒，超时或出错返回 fallback。 */
function timed<T, F>(promise: Promise<T> | undefined, ms: number, fallback: F): Promise<T | F> {
  if (!promise) return Promise.resolve(fallback)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then((value) => resolve(value), () => resolve(fallback)).finally(() => clearTimeout(timer))
  })
}

/** 按顺序把文件分批：每批最多 10 个、总大小不超过 24 MiB（A5）。 */
export function fileBatches<T extends { data: ArrayBuffer }>(files: T[]): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const file of files) {
    const size = file.data.byteLength
    if (current.length && (current.length >= DISCORD_BATCH_FILES || bytes + size > DISCORD_BATCH_BYTES)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(file)
    bytes += size
  }
  if (current.length) batches.push(current)
  return batches
}

function sleepUntil(deadline: number, now: () => number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - now())))
}
