// 插件自己调 Discord API 发送（清单 §8.2、§10）：每次发送一个请求，带 allowed_mentions，按错误类型决定重试。
// 不用 bot.sendMessage：它部分失败时会丢掉已发出的 ID，错误也没有结构（S22）。

import type { FileData } from '../types'
import { describeError, internalErrorInfo } from '../log'
import { escapeDiscord } from '../out/discord'
import { cutUnits } from '../text/split'

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
  | { ok: true; messageId: string }
  | { ok: false; reason: string; maybeSent: boolean; webhookGone?: boolean }

export interface SendOptions {
  signal: AbortSignal
  /** 这条消息最晚到什么时候（毫秒时间戳）不再发起新的尝试。 */
  deadline: number
  /** 被 429 限流时调用（给状态统计）。 */
  onRateLimit?: (ms: number) => void
  /** 测试用：替换等待函数。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const RETRY_DELAYS = [2000, 10000]

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
  | { kind: 'rate'; ms: number }
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
      let seconds = Number(data.retry_after)
      if (!Number.isFinite(seconds)) seconds = Number(e.response.headers?.get?.('retry-after'))
      if (!Number.isFinite(seconds) || seconds < 0) seconds = 1
      return { kind: 'rate', ms: Math.ceil(seconds * 1000) }
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

/** 去掉最大的那个文件，换成占位文字（413 时用）。 */
function dropLargest(payload: DiscordPayload): DiscordPayload {
  if (!payload.files.length) return payload
  let largest = 0
  payload.files.forEach((file, i) => {
    if (file.data.byteLength > payload.files[largest].data.byteLength) largest = i
  })
  const dropped = payload.files[largest]
  const placeholder = escapeDiscord(dropped.placeholder)
  // 加上占位文字后仍不能超过 2000 字，放不下时截掉正文末尾
  const room = 2000 - placeholder.length - 1
  const content = payload.content ? `${cutUnits(payload.content, room)}\n${placeholder}` : placeholder
  return {
    ...payload,
    content,
    files: payload.files.filter((_, i) => i !== largest),
  }
}

export class DiscordSender {
  /** 插件自己的 webhook ID（防自我回环，清单 §6.3）。 */
  ownWebhooks = new Set<string>()
  private webhookWarned = new Map<string, number>()

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

  /** 发送一次（一个 Discord 请求），按清单 §10 处理重试。 */
  async send(bot: any, channelId: string, payload: DiscordPayload, webhook: Webhook | null, options: SendOptions): Promise<SendResult> {
    const sleep = options.sleep ?? defaultSleep
    let retries = 0
    let usernameRetried = false
    let largeRetried = false
    let webhookRetried = false
    let wh = webhook
    let current = payload
    while (true) {
      const remaining = options.deadline - Date.now()
      if (remaining <= 0 || options.signal.aborted) return { ok: false, reason: '超过 60 秒，放弃', maybeSent: false }
      const mode = wh ? 'webhook' : 'bot'
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
        return { ok: true, messageId: String(id) }
      } catch (error) {
        const failure = classify(bot.http, error)
        const reason = describeError(error)
        switch (failure.kind) {
          case 'connect':
            if (retries >= RETRY_DELAYS.length) return { ok: false, reason, maybeSent: false }
            await sleep(Math.min(RETRY_DELAYS[retries++], Math.max(0, options.deadline - Date.now())), options.signal).catch(() => {})
            continue
          case 'rate':
            // 整个目标队列一起等（这条就在队首），不计入重试次数，仍受 60 秒限制
            options.onRateLimit?.(failure.ms)
            if (Date.now() + failure.ms > options.deadline) return { ok: false, reason: `${reason}，等待时间超过 60 秒`, maybeSent: false }
            await sleep(failure.ms, options.signal).catch(() => {})
            continue
          case 'tooLarge':
            if (largeRetried || !current.files.length) return { ok: false, reason, maybeSent: false }
            largeRetried = true
            current = dropLargest(current)
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
