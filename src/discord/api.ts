// 插件自己调 Discord API 发送（清单 §8.2、§10）：每次发送一个请求，带 allowed_mentions，按错误类型决定重试。
// 不用 bot.sendMessage：它部分失败时会丢掉已发出的 ID，错误也没有结构（S22）。

import type { FileData } from '../types'
import { describeError, internalErrorInfo } from '../log'
import { escapeDiscord } from '../out/discord'

export interface Webhook {
  id: string
  token: string
  guild_id?: string
}

export interface DiscordPayload {
  content: string
  /** webhook 模式：显示的名字和头像。 */
  username?: string
  avatarUrl?: string
  /** 机器人模式：原生回复。 */
  replyTo?: string
  files: Array<FileData & { placeholder: string }>
}

export type SendResult =
  /** extraIds：413 后占位文字另发的那一条（F6）。 */
  | { ok: true; messageId: string; extraIds?: string[] }
  | { ok: false; reason: string; maybeSent: boolean; webhookGone?: boolean }

export interface SendOptions {
  signal: AbortSignal
  /** 这条消息最晚到什么时候（毫秒时间戳）不再发起新的尝试。 */
  deadline: number
  /** 被 429 限流时调用（给状态统计）。 */
  onRateLimit?: (ms: number) => void
  /** 测试用：替换等待函数。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** 测试用：替换时钟。 */
  now?: () => number
}

const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const RETRY_DELAYS = [2000, 10000]
/** 一次发送最多被 429 几次。 */
const RATE_RETRIES = 5
/** 429 没说等多久时至少等这么久。 */
const RATE_UNKNOWN_MS = 2000

export function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type Failure =
  | { kind: 'connect' }
  | { kind: 'rate'; ms: number; global?: boolean }
  | { kind: 'tooLarge' }
  | { kind: 'username' }
  | { kind: 'unknownWebhook' }
  | { kind: 'other'; maybeSent: boolean }

export function classify(http: any, error: unknown): Failure {
  const e = error as any
  const isHttp = typeof http?.isError === 'function' ? http.isError(e) : !!e?.[Symbol.for('cordis.http.error')]
  if (isHttp && e.response) {
    const status = e.response.status
    const data = e.response.data && typeof e.response.data === 'object' ? e.response.data : {}
    if (status === 429) {
      const header = e.response.headers?.get?.('retry-after')
      let seconds = data.retry_after === undefined || data.retry_after === null || data.retry_after === '' ? NaN : Number(data.retry_after)
      if (!Number.isFinite(seconds) && header !== null && header !== undefined && header !== '') seconds = Number(header)
      // 没说等多久（或写得不对）：按未知处理，至少等 2 秒
      const ms = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : RATE_UNKNOWN_MS
      const global = data.global === true || e.response.headers?.get?.('x-ratelimit-global') === 'true'
      return global ? { kind: 'rate', ms, global } : { kind: 'rate', ms }
    }
    if (status === 413 || data.code === 40005) return { kind: 'tooLarge' }
    if (data.code === 10015) return { kind: 'unknownWebhook' }
    if (status === 400 && JSON.stringify(data.errors ?? data.message ?? '').includes('username')) return { kind: 'username' }
    // 4xx：请求被拒绝，肯定没发出；5xx：可能已经发出（webhook 没有去重手段）
    return { kind: 'other', maybeSent: status >= 500 }
  }
  const code = e?.cause?.cause?.code ?? e?.cause?.code
  if (isHttp && e.code !== 'ETIMEDOUT' && CONNECT_CODES.has(code)) return { kind: 'connect' }
  // 请求超时、连接中途断开、被中止等：可能已经发出，不重试
  return { kind: 'other', maybeSent: true }
}

function buildBody(payload: DiscordPayload, mode: 'webhook' | 'bot') {
  const json: any = { content: payload.content, allowed_mentions: { parse: [] } }
  if (mode === 'webhook') {
    if (payload.username) json.username = payload.username
    if (payload.avatarUrl) json.avatar_url = payload.avatarUrl
  } else if (payload.replyTo) {
    json.message_reference = { message_id: payload.replyTo, fail_if_not_exists: false }
  }
  if (!payload.files.length) return { body: json, multipart: false }
  json.attachments = payload.files.map((file, i) => ({ id: i, filename: file.name }))
  const form = new FormData()
  form.append('payload_json', JSON.stringify(json))
  payload.files.forEach((file, i) => {
    form.append(`files[${i}]`, new Blob([file.data], { type: file.mime }), file.name)
  })
  return { body: form, multipart: true }
}

const CONTENT_LIMIT = 2000

/**
 * 这一批的文件全部换成占位文字（413 时用；这样一定能发出去）。
 * 用户的原文一个字都不截（F6）：占位文字跟在后面放不下时，合成一句「[另有 N 个文件过大未发送]」；
 * 还放不下，就把占位文字放进 extra，另发一条。
 */
export function dropAll(payload: DiscordPayload): { payload: DiscordPayload; extra?: string } {
  if (!payload.files.length) return { payload }
  const joined = payload.files.map((file) => escapeDiscord(file.placeholder)).join('\n')
  const merged = escapeDiscord(`[另有 ${payload.files.length} 个文件过大未发送]`)
  const alone = joined.length <= CONTENT_LIMIT ? joined : merged
  const content = payload.content
  const fits = (tail: string) => content.length + 1 + tail.length <= CONTENT_LIMIT
  if (!content) return { payload: { ...payload, content: alone, files: [] } }
  if (fits(joined)) return { payload: { ...payload, content: `${content}\n${joined}`, files: [] } }
  if (fits(merged)) return { payload: { ...payload, content: `${content}\n${merged}`, files: [] } }
  return { payload: { ...payload, files: [] }, extra: alone }
}

export class DiscordSender {
  /** 插件自己的 webhook ID（防自我回环，清单 §6.3）。 */
  ownWebhooks = new Set<string>()
  private webhookWarned = new Map<string, number>()
  /** 被限流到什么时候：`webhook:<id>`、`channel:<id>`、`global`。 */
  private limitedUntil = new Map<string, number>()

  constructor(private logger: { warn(...args: any[]): void; debug?(...args: any[]): void }) {}

  /**
   * 取这个频道插件用的 webhook（R1）。失败时清掉适配器缓存的失败结果，下次会重新请求；
   * 机器人还没登录（selfId 为空）时先 getLogin，否则适配器会每次都新建一个 webhook。
   */
  async ensureWebhook(bot: any, channelId: string, force = false): Promise<Webhook> {
    if (!bot.selfId) await withTimeout(bot.getLogin(), 15000)
    if (!bot.selfId) throw new Error('Discord 机器人还没登录')
    if (force && bot.webhooks) bot.webhooks[channelId] = null
    try {
      const wh = await bot.ensureWebhook(channelId)
      if (!wh?.id || !wh?.token) throw new Error('webhook 没有 token')
      this.ownWebhooks.add(String(wh.id))
      return wh
    } catch (e) {
      if (bot.webhooks) bot.webhooks[channelId] = null
      throw e
    }
  }

  /** 能用 webhook 就返回，否则返回 null 并按频道每小时警告一次（DECISIONS 第 9 条）。 */
  async tryWebhook(bot: any, channelId: string): Promise<Webhook | null> {
    try {
      return await this.ensureWebhook(bot, channelId)
    } catch (e) {
      const last = this.webhookWarned.get(channelId) ?? 0
      if (Date.now() - last > 3600000) {
        this.webhookWarned.set(channelId, Date.now())
        const info = internalErrorInfo(e)
        const hint = info.code === 50013 || info.status === 403 ? '（机器人没有「管理 Webhook」权限？）' : ''
        this.logger.warn(`频道 ${channelId} 无法使用 webhook${hint}：${describeError(e)}；改由机器人发送`)
      }
      return null
    }
  }

  /** 这个目标（和全局）被限流到什么时候。 */
  rateLimitedUntil(key: string, now = Date.now()) {
    const until = Math.max(this.limitedUntil.get(key) ?? 0, this.limitedUntil.get('global') ?? 0)
    if (until <= now) {
      this.limitedUntil.delete(key)
      if ((this.limitedUntil.get('global') ?? 0) <= now) this.limitedUntil.delete('global')
      return 0
    }
    return until
  }

  /** 发送一次（一个 Discord 请求），按清单 §10 处理重试。 */
  async send(bot: any, channelId: string, payload: DiscordPayload, webhook: Webhook | null, options: SendOptions): Promise<SendResult> {
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    let retries = 0
    let rateRetries = 0
    let usernameRetried = false
    let largeRetried = false
    let webhookRetried = false
    let wh = webhook
    let current = payload
    /** 413 后放不进正文、要另发一条的占位文字。 */
    let extra: string | undefined
    while (true) {
      const remaining = options.deadline - now()
      if (remaining <= 0 || options.signal.aborted) return { ok: false, reason: '超过 60 秒，放弃', maybeSent: false }
      const mode = wh ? 'webhook' : 'bot'
      const target = wh ? `webhook:${wh.id}` : `channel:${channelId}`
      // 之前被限流过：先等到限流结束；等不到就放弃
      const until = this.rateLimitedUntil(target, now())
      if (until) {
        if (until > options.deadline) {
          this.logger.warn(`发往 Discord 频道 ${channelId} 被限流，要等到 60 秒之后，放弃这条`)
          return { ok: false, reason: 'Discord 限流，等待时间超过 60 秒', maybeSent: false }
        }
        await sleep(until - now(), options.signal).catch(() => {})
        continue
      }
      const { body, multipart } = buildBody(current, mode)
      const url = wh ? `/webhooks/${wh.id}/${wh.token}?wait=true` : `/channels/${channelId}/messages`
      try {
        const response = await bot.http(url, {
          method: 'POST',
          data: body,
          timeout: Math.max(1000, Math.min(multipart ? 45000 : 20000, remaining)),
          signal: options.signal,
        })
        const id = response?.data?.id
        if (!id) return { ok: false, reason: 'Discord 没有返回消息 ID', maybeSent: true }
        if (!extra) return { ok: true, messageId: String(id) }
        // 正文已经发出：占位文字另发一条（失败只写日志，不影响这条的结果）
        const rest = await this.send(bot, channelId, { content: extra, username: current.username, avatarUrl: current.avatarUrl, files: [] }, wh, options)
        if (!rest.ok) this.logger.warn(`发往 Discord 频道 ${channelId} 的「文件过大未发送」提示没有发出：${rest.reason}`)
        return { ok: true, messageId: String(id), ...(rest.ok ? { extraIds: [rest.messageId] } : {}) }
      } catch (error) {
        const failure = classify(bot.http, error)
        const reason = describeError(error)
        switch (failure.kind) {
          case 'connect':
            if (retries >= RETRY_DELAYS.length) return { ok: false, reason, maybeSent: false }
            await sleep(Math.min(RETRY_DELAYS[retries++], Math.max(0, options.deadline - now())), options.signal).catch(() => {})
            continue
          case 'rate':
            // 记下限流到什么时候（全局限流记全局），后面发往这个目标的消息先等；仍受 60 秒限制
            options.onRateLimit?.(failure.ms)
            const key = failure.global ? 'global' : target
            this.limitedUntil.set(key, Math.max(this.limitedUntil.get(key) ?? 0, now() + failure.ms))
            if (++rateRetries > RATE_RETRIES) return { ok: false, reason: `${reason}，被限流 ${RATE_RETRIES} 次，放弃`, maybeSent: false }
            if (now() + failure.ms > options.deadline) return { ok: false, reason: `${reason}，等待时间超过 60 秒`, maybeSent: false }
            continue
          case 'tooLarge':
            if (largeRetried || !current.files.length) return { ok: false, reason, maybeSent: false }
            largeRetried = true
            ;({ payload: current, extra } = dropAll(current))
            continue
          case 'username':
            if (usernameRetried || !wh) return { ok: false, reason, maybeSent: false }
            usernameRetried = true
            current = { ...current, username: 'QQ用户' }
            continue
          case 'unknownWebhook':
            if (webhookRetried || !wh) return { ok: false, reason, maybeSent: false }
            webhookRetried = true
            try {
              wh = await this.ensureWebhook(bot, channelId, true)
            } catch (e) {
              return { ok: false, reason: `webhook 已失效，重新创建失败：${describeError(e)}`, maybeSent: false, webhookGone: true }
            }
            continue
          default:
            return { ok: false, reason, maybeSent: failure.maybeSent }
        }
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref?.())])
}
