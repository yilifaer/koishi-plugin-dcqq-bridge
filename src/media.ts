// 下载媒体（清单 §6.2 第 6 步：单个下载超时 20 秒；A3：大小上限边下边算）。用 ctx.http，不用 bot.http（那会把 Discord 的 token 发给别的网站）。

import type { Context } from 'koishi'
import type { FileData, Media } from './types'

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
}

function guessMime(name: string, fallback: string) {
  const ext = /\.([a-z0-9]+)(?:$|\?)/i.exec(name)?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || fallback
}

function extFor(mime: string) {
  return Object.entries(EXT_MIME).find(([, m]) => m === mime)?.[0] ?? 'bin'
}

export interface DownloadOptions {
  signal?: AbortSignal
  timeout?: number
  /** 超过这个字节数就算失败。 */
  maxBytes?: number
}

export class TooLarge extends Error {}

/** 服务器回复了错误状态（4xx、5xx，或者 2xx、304 以外的状态）。body 没有读。 */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

// 自定义 responseType：拿到 fetch 的 Response 后自己读 body。
// Content-Length 超上限立即取消；否则分块累计，超上限立即取消（不会把整个文件读进内存）。
// 调用时要带 validateStatus: () => true：不然 http 库遇到 4xx、5xx 会先用默认方式把整个错误页读进内存再报错，
// 绕过这里的大小上限。错误状态在这里处理：不读 body，直接取消，抛 HttpStatusError（304 照常返回空内容）。
export function limitedBody(maxBytes: number | undefined, signal?: AbortSignal) {
  return async (raw: Response): Promise<ArrayBuffer> => {
    if (!raw.ok && raw.status !== 304) {
      await raw.body?.cancel().catch(() => {})
      throw new HttpStatusError(raw.status)
    }
    const limit = maxBytes && maxBytes > 0 ? maxBytes : Infinity
    const length = Number(raw.headers.get('content-length') ?? NaN)
    if (Number.isFinite(length) && length > limit) {
      await raw.body?.cancel().catch(() => {})
      throw new TooLarge()
    }
    if (!raw.body) return new ArrayBuffer(0)
    const reader = raw.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) throw new TooLarge()
        chunks.push(value)
      }
    } catch (e) {
      await reader.cancel().catch(() => {})
      throw e
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out.buffer
  }
}

/**
 * 按顺序尝试 media.urls，成功返回文件，全部失败、超过大小上限或被中止返回 null。
 * 每次下载用一个自己的子 AbortController（F1）：父 signal 和插件一样长寿，
 * http 库会往传进去的 signal 上挂监听器而且不移除，直接传父 signal 会越积越多。
 */
export async function download(ctx: Context, media: Media, options: DownloadOptions = {}): Promise<FileData | null> {
  const { maxBytes, signal: parent } = options
  // 已知大小超上限：不发请求
  if (maxBytes && typeof media.size === 'number' && Number.isFinite(media.size) && media.size > maxBytes) return null
  if (parent?.aborted) return null
  const child = new AbortController()
  const onAbort = () => child.abort(parent?.reason)
  parent?.addEventListener('abort', onAbort, { once: true })
  const signal = child.signal
  try {
    for (const url of media.urls) {
      if (!/^https?:\/\//i.test(url)) continue
      if (signal.aborted) return null
      try {
        const response = await ctx.http(url, {
          method: 'GET',
          responseType: limitedBody(maxBytes, signal),
          // 所有状态都交给 limitedBody：错误页不读内容（见上面）
          validateStatus: () => true,
          timeout: options.timeout ?? 20000,
          signal,
        })
        const data = response.data as ArrayBuffer
        if (!data || !data.byteLength) continue
        const fallback = media.kind === 'video' ? 'video/mp4' : 'image/png'
        let mime = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim()
        if (!mime || mime === 'application/octet-stream') mime = media.mime || guessMime(media.name || url, fallback)
        const name = media.name && /\.[a-z0-9]+$/i.test(media.name) ? media.name : `${media.name || media.kind}.${extFor(mime)}`
        return { name, mime, data }
      } catch (e) {
        if (e instanceof TooLarge || signal.aborted) return null
      }
    }
    return null
  } finally {
    parent?.removeEventListener('abort', onAbort)
    // 结束后中止子 signal：http 库挂在它上面的监听器随子 controller 一起被回收
    child.abort()
  }
}
