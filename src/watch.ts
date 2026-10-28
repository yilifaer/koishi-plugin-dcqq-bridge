// 两边机器人的连接状态（0.4.1 V9、V10）：每分钟看一次 QQ 有没有登录、OneBot 连不连着、Discord 在不在线。
// - 同一次掉线只在状态变化时写日志（掉线一行、恢复一行），不再每次健康检查都刷一遍警告；
// - QQ 掉线或 Discord 断开超过 alert.afterMinutes，往另一边发一条提醒，恢复后再发一条；同一次掉线只提醒一次；
// - QQ 恢复后通知 relay 补发掉线期间记下来的消息（V11）。

import { h, Universal } from 'koishi'
import { timeFormatter } from './commands'
import { describeError } from './log'
import { probeLogin, qqOnline, sendQQ } from './qq/api'
import type { Relay } from './relay'

export type QQLink = 'ok' | 'loggedOut' | 'disconnected'

/** 一次掉线：从什么时候开始、提醒发了没有。 */
export interface Outage {
  since: number
  /** 提醒已经发出去了（恢复后才会发恢复通知）。 */
  alerted: boolean
  /** 发提醒失败的原因已经写过日志（同一次掉线只写一次）。 */
  failureLogged: boolean
}

export interface QQOutage extends Outage {
  kind: 'loggedOut' | 'disconnected'
  /** 这次掉线里出现过「没登录」（恢复时据此决定写「重新登录」还是「重新连接」）。 */
  sawLoggedOut: boolean
}

/** 提醒请求的最长等待（毫秒）。 */
const ALERT_TIMEOUT = 30000

function minutesText(ms: number) {
  return Math.max(0, Math.round(ms / 60000))
}

export class LinkWatch {
  qq: QQOutage | null = null
  discord: Outage | null = null
  private lastQQSelfId = ''
  private refreshing: Promise<QQLink> | null = null
  private ticking: Promise<void> | null = null
  /** Discord 用户 ID → 私信频道 ID。 */
  private dms = new Map<string, string>()
  /** 后台发的恢复通知（每分钟的检查结束前等它们发完）。 */
  private background = new Set<Promise<unknown>>()

  constructor(private relay: Relay) {}

  private get time() {
    return timeFormatter(this.relay.settings.timeZone)
  }

  // ---------------------------------------------------------------- QQ

  /**
   * 问一次 QQ 的状态并更新记录：OneBot 没连上 = disconnected，连着但 LLBot 没登录 QQ = loggedOut，其他 = ok。
   * 健康检查（selfCheck）、发送失败时和每分钟的检查都调用它；同时进来的几次共用一个结果。
   */
  refreshQQ(): Promise<QQLink> {
    return this.refreshing ??= this.doRefreshQQ().finally(() => (this.refreshing = null))
  }

  private async doRefreshQQ(): Promise<QQLink> {
    const bot = this.relay.qqBot()
    if (bot?.selfId) this.lastQQSelfId = String(bot.selfId)
    let link: QQLink
    if (!bot || !qqOnline(bot)) {
      link = 'disconnected'
    } else {
      const login = await probeLogin(bot)
      // 问不出来（超时、不认识的错误）时，之前是没登录就还当没登录，别的当正常
      link = login === 'out' || (login === 'unknown' && this.qq?.kind === 'loggedOut') ? 'loggedOut' : 'ok'
    }
    this.applyQQ(link)
    return link
  }

  private applyQQ(link: QQLink) {
    const relay = this.relay
    const now = relay.now()
    if (link === 'ok') {
      const outage = this.qq
      if (!outage) return
      this.qq = null
      const minutes = minutesText(now - outage.since)
      if (outage.sawLoggedOut) relay.logger.info(`QQ 机器人已重新登录，离线 ${minutes} 分钟`)
      else relay.logger.debug(`QQ 机器人已重新连接，离线 ${minutes} 分钟`)
      if (outage.alerted) this.spawn(this.alertDiscord(`✅ QQ 机器人已恢复，离线 ${minutes} 分钟`, 'QQ 恢复通知'))
      relay.onQQRecovered()
      return
    }
    if (!this.qq) {
      this.qq = { since: now, kind: link, alerted: false, failureLogged: false, sawLoggedOut: link === 'loggedOut' }
    } else if (this.qq.kind !== link) {
      this.qq.kind = link
      if (link === 'loggedOut') this.qq.sawLoggedOut = true
    } else {
      return
    }
    // 状态变化时写一行；OneBot 连接断开适配器自己会写日志，这里不重复
    if (link === 'loggedOut') relay.logger.warn(`QQ 机器人没有登录（从 ${this.time(this.qq.since)} 起），暂停检查各个桥`)
  }

  /** QQ 现在是不是已知掉线（没登录或 OneBot 断开）。 */
  get qqDown() {
    return this.qq !== null
  }

  // ---------------------------------------------------------------- 每分钟的检查

  /** 每分钟一次：更新 QQ、Discord 的状态，该提醒就提醒，QQ 正常时看看有没有待补发的。 */
  tick(): Promise<void> {
    return this.ticking ??= this.doTick().finally(() => (this.ticking = null))
  }

  private async doTick() {
    const relay = this.relay
    const link = await this.refreshQQ()
    this.refreshDiscord()
    await this.alertIfDue(link)
    // QQ 正常时看看有没有掉线期间记下来的消息（插件重启、上一次没补完的也在这里补）
    if (link === 'ok') await relay.replayPending()
    await Promise.all([...this.background])
  }

  /** 后台发一条通知：出错只记日志，不影响检查。 */
  private spawn(task: Promise<unknown>) {
    const guarded = task.catch((e) => this.relay.logger.warn('发提醒出错：%s', describeError(e)))
    this.background.add(guarded)
    void guarded.finally(() => this.background.delete(guarded))
  }

  private refreshDiscord() {
    const relay = this.relay
    const bot = relay.discordBot()
    const up = !!bot && bot.status === Universal.Status.ONLINE
    const now = relay.now()
    if (up) {
      const outage = this.discord
      if (!outage) return
      this.discord = null
      const minutes = minutesText(now - outage.since)
      // 发过提醒的才值得写 info；启动时、网关重连这种几秒钟的断开只写 debug
      if (outage.alerted) relay.logger.info(`Discord 机器人已重新连接，离线 ${minutes} 分钟`)
      else relay.logger.debug(`Discord 机器人已重新连接，离线 ${minutes} 分钟`)
      if (outage.alerted) this.spawn(this.alertQQ(`✅ Discord 机器人已恢复，离线 ${minutes} 分钟`, 'Discord 恢复通知'))
    } else if (!this.discord) {
      this.discord = { since: now, alerted: false, failureLogged: false }
    }
  }

  private async alertIfDue(link: QQLink) {
    const relay = this.relay
    const { afterMinutes, discordChannel, discordUser, qqGroup } = relay.settings.alert
    const now = relay.now()
    const qq = this.qq
    if (qq && !qq.alerted && (discordChannel || discordUser) && now - qq.since >= afterMinutes * 60000) {
      const id = this.lastQQSelfId || relay.settings.qqSelfId || '（未知）'
      const text = `⚠ QQ 机器人 ${id} 掉线了（从 ${this.time(qq.since)} 起），QQ 和 Discord 之间暂停转发。可以在 LLBot 里点停止再启动；登不上就要扫码。`
      if (await this.alertDiscord(text, 'QQ 掉线提醒')) {
        qq.alerted = true
        relay.logger.warn(`QQ 机器人已掉线 ${minutesText(now - qq.since)} 分钟，已在 Discord 发出提醒`)
      }
    }
    const discord = this.discord
    // QQ 自己也掉线时发不出去，等它好了再说
    if (discord && !discord.alerted && qqGroup && link === 'ok' && now - discord.since >= afterMinutes * 60000) {
      const text = `⚠ Discord 机器人掉线了（从 ${this.time(discord.since)} 起），Discord 和 QQ 之间暂停转发。`
      if (await this.alertQQ(text, 'Discord 掉线提醒')) {
        discord.alerted = true
        relay.logger.warn(`Discord 机器人已掉线 ${minutesText(now - discord.since)} 分钟，已在 QQ 群发出提醒`)
      }
    }
  }

  // ---------------------------------------------------------------- 发提醒

  /** 用 Discord 机器人的身份发到频道和（或）私信；至少一处发出就返回 true。`allowed_mentions` 照旧不 ping 任何人。 */
  private async alertDiscord(text: string, what: string): Promise<boolean> {
    const relay = this.relay
    const { discordChannel, discordUser } = relay.settings.alert
    if (!discordChannel && !discordUser) return false
    const bot = relay.discordBot()
    if (!bot) return this.alertFailed(this.qq, `${what}没有发出：找不到 Discord 机器人`)
    const targets: string[] = []
    if (discordChannel) targets.push(discordChannel)
    if (discordUser) {
      const dm = await this.dmChannel(bot, discordUser)
      if (dm) targets.push(dm)
    }
    let sent = false
    for (const channel of targets) {
      const result = await relay.sender.send(bot, channel, { content: text, files: [] }, null, {
        signal: new AbortController().signal,
        deadline: Date.now() + ALERT_TIMEOUT,
        sleep: relay.sleep,
      })
      if (result.ok) sent = true
      else this.alertFailed(this.qq, `${what}没有发到 Discord：${result.reason}`)
    }
    return sent
  }

  /** 和这个用户的私信频道（创建一次，之后记住）。 */
  private async dmChannel(bot: any, userId: string): Promise<string | null> {
    const known = this.dms.get(userId)
    if (known) return known
    try {
      const channel = await bot.internal.createDM({ recipient_id: userId })
      const id = channel?.id ? String(channel.id) : ''
      if (!id) throw new Error('没有返回频道 ID')
      this.dms.set(userId, id)
      return id
    } catch (e) {
      this.alertFailed(this.qq, `无法给 Discord 用户创建私信：${describeError(e)}`)
      return null
    }
  }

  /** 在 QQ 群里发提醒（Discord 掉线时）。 */
  private async alertQQ(text: string, what: string): Promise<boolean> {
    const relay = this.relay
    const group = relay.settings.alert.qqGroup
    if (!group) return false
    const result = await sendQQ(() => relay.qqBot(), group, [h.text(text)], {
      signal: new AbortController().signal,
      deadline: Date.now() + ALERT_TIMEOUT,
      sleep: relay.sleep,
      noWait: () => true,
    })
    if (result.ok) return true
    return this.alertFailed(this.discord, `${what}没有发到 QQ 群：${result.reason}`)
  }

  /** 提醒发不出去：同一次掉线只写一次日志，下一分钟再试。 */
  private alertFailed(outage: Outage | null, message: string): false {
    if (!outage?.failureLogged) {
      if (outage) outage.failureLogged = true
      this.relay.logger.warn(message)
    }
    return false
  }
}
