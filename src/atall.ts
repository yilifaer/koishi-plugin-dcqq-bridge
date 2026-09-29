// @全体 的决定（清单 §11）。在这个 QQ 群的发送队列轮到这条消息时调用；同一个群的发送是串行的，
// 所以不会有两条同时通过检查。查询出错一律按不通过处理（S17：LLBot 自己查失败时会照发）。

import type { AtAllConfig } from './config'
import type { Store } from './store'
import type { Msg } from './types'

export type AtAllReason = '不是管理员' | '次数用完' | '冷却中' | '已达上限' | '消息太旧' | '查询失败' | '静默消息' | '补发' | '已经发过'

export type AtAllDecision =
  | { ok: true; commit: () => Promise<void>; revert: () => Promise<void> }
  | { ok: false; reason: AtAllReason }

export interface AtAllRemain {
  forGroup: number
  forUin: number
  checkedAt: number
}

const ROLE_TTL = 10 * 60 * 1000

export interface AtAllGateOptions {
  /** 单个查询的超时（毫秒），默认 8000。 */
  queryTimeout?: number
  /** 整个 decide() 的超时（毫秒），默认 15000。 */
  decideTimeout?: number
}

class QueryTimeout extends Error {}

/** 超时就拒绝；原来的 promise 晚到的结果被丢弃。 */
function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  if (!(ms > 0)) return Promise.resolve(p)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new QueryTimeout()), ms)
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export class AtAllGate {
  private roleCache = new Map<string, { admin: boolean; at: number }>()
  /** 最近一次查到的剩余次数（给 bridge.status 显示）。 */
  remain = new Map<string, AtAllRemain>()

  constructor(
    private store: Store,
    private getConfig: () => AtAllConfig,
    private dateOf: (ms: number) => string,
    private now: () => number = Date.now,
    options: AtAllGateOptions = {},
  ) {
    this.queryTimeout = options.queryTimeout ?? 8000
    this.decideTimeout = options.decideTimeout ?? 15000
  }

  private queryTimeout: number
  private decideTimeout: number

  private query<T>(p: Promise<T> | T) {
    return withTimeout(p, this.queryTimeout)
  }

  countKey(groupId: string, ms = this.now()) {
    return `atall:${groupId}:${this.dateOf(ms)}`
  }

  async usedToday(groupId: string) {
    return (await this.query(this.store.get<number>(this.countKey(groupId)))) ?? 0
  }

  /** 机器人在群里是不是群主或管理员（缓存 10 分钟）。出错或超时抛出。 */
  async isAdmin(bot: any, groupId: string, force = false): Promise<boolean> {
    const cached = this.roleCache.get(groupId)
    if (!force && cached && this.now() - cached.at < ROLE_TTL) return cached.admin
    const member = await this.query(bot.getGuildMember(groupId, bot.selfId))
    const role = member?.roles?.[0]?.id ?? member?.roles?.[0]
    const admin = role === 'owner' || role === 'admin'
    this.roleCache.set(groupId, { admin, at: this.now() })
    return admin
  }

  /** 每个查询最多 queryTimeout，整体最多 decideTimeout；超时按「查询失败」，晚到的结果不产生任何效果。 */
  async decide(bot: any, groupId: string, msg: Msg): Promise<AtAllDecision> {
    const state = { expired: false }
    try {
      return await withTimeout(this.decideInner(bot, groupId, msg, state), this.decideTimeout)
    } catch {
      return { ok: false, reason: '查询失败' }
    } finally {
      state.expired = true
    }
  }

  private async decideInner(bot: any, groupId: string, msg: Msg, state: { expired: boolean }): Promise<AtAllDecision> {
    const config = this.getConfig()
    if (msg.backfill) return { ok: false, reason: '补发' }
    if (msg.silent) return { ok: false, reason: '静默消息' }
    if (this.now() - msg.timestamp > config.maxAgeMinutes * 60000) return { ok: false, reason: '消息太旧' }
    // 去重：这条 Discord 消息已经发到过这个群（重启后也有效）
    try {
      if (await this.query(this.store.hasSource(msg.channelId, msg.messageId, groupId))) return { ok: false, reason: '已经发过' }
    } catch {
      return { ok: false, reason: '查询失败' }
    }
    const lastKey = `atall-last:${groupId}`
    const countKey = this.countKey(groupId)
    let used = 0
    try {
      const last = await this.query(this.store.get<number>(lastKey))
      if (config.cooldownMinutes > 0 && last && this.now() - last < config.cooldownMinutes * 60000) return { ok: false, reason: '冷却中' }
      used = (await this.query(this.store.get<number>(countKey))) ?? 0
      if (config.dailyCap > 0 && used >= config.dailyCap) return { ok: false, reason: '已达上限' }
    } catch {
      return { ok: false, reason: '查询失败' }
    }
    try {
      if (!(await this.isAdmin(bot, groupId))) return { ok: false, reason: '不是管理员' }
    } catch {
      return { ok: false, reason: '查询失败' }
    }
    let remain: any
    try {
      remain = await this.query(bot.internal.getGroupAtAllRemain(groupId))
    } catch {
      return { ok: false, reason: '查询失败' }
    }
    const forGroup = Number(remain?.remain_at_all_count_for_group)
    const forUin = Number(remain?.remain_at_all_count_for_uin)
    if (typeof remain?.can_at_all !== 'boolean' || !Number.isFinite(forGroup) || !Number.isFinite(forUin)) return { ok: false, reason: '查询失败' }
    if (state.expired) return { ok: false, reason: '查询失败' }
    this.remain.set(groupId, { forGroup, forUin, checkedAt: this.now() })
    if (!remain.can_at_all || forUin <= 0 || forGroup <= config.reserve) return { ok: false, reason: '次数用完' }

    const previousLast = await this.query(this.store.get<number>(lastKey)).catch(() => undefined)
    if (state.expired) return { ok: false, reason: '查询失败' }
    return {
      ok: true,
      // 在发送之前就记下（超时按「已经用掉」算）
      commit: async () => {
        await this.store.set(countKey, used + 1)
        await this.store.set(lastKey, this.now())
      },
      // 只有明确失败（肯定没发出）才撤回
      revert: async () => {
        await this.store.set(countKey, used)
        if (previousLast) await this.store.set(lastKey, previousLast)
        else await this.store.delete(lastKey)
      },
    }
  }
}
