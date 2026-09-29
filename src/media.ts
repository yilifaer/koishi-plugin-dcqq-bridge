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

class TooLarge extends Error {}

// 自定义 responseType：拿到 fetch 的 Response 后自己读 body。
// Content-Length 超上限立即取消；否则分块累计，超上限立即取消（不会把整个文件读进内存）。
function limitedBody(maxBytes: number | undefined, signal?: AbortSignal) {
  return async (raw: Response): Promise<ArrayBuffer> => {
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

/** 按顺序尝试 media.urls，成功返回文件，全部失败、超过大小上限或被中止返回 null。 */
export async function download(ctx: Context, media: Media, options: DownloadOptions = {}): Promise<FileData | null> {
  const { maxBytes, signal } = options
  // 已知大小超上限：不发请求
  if (maxBytes && typeof media.size === 'number' && Number.isFinite(media.size) && media.size > maxBytes) return null
  for (const url of media.urls) {
    if (!/^https?:\/\//i.test(url)) continue
    if (signal?.aborted) return null
    try {
      const response = await ctx.http(url, {
        method: 'GET',
        responseType: limitedBody(maxBytes, signal),
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
      if (e instanceof TooLarge || signal?.aborted) return null
    }
  }
  return null
}
