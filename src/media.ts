// 下载媒体（清单 §6.2 第 6 步：单个下载超时 20 秒）。用 ctx.http，不用 bot.http（那会把 Discord 的 token 发给别的网站）。

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

/** 按顺序尝试 media.urls，成功返回文件，全部失败返回 null。 */
export async function download(ctx: Context, media: Media, options: DownloadOptions = {}): Promise<FileData | null> {
  for (const url of media.urls) {
    if (!/^https?:\/\//i.test(url)) continue
    try {
      const response = await ctx.http(url, {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: options.timeout ?? 20000,
        signal: options.signal,
      })
      const data = response.data as ArrayBuffer
      if (!data || !data.byteLength) continue
      if (options.maxBytes && data.byteLength > options.maxBytes) return null
      const fallback = media.kind === 'video' ? 'video/mp4' : 'image/png'
      let mime = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim()
      if (!mime || mime === 'application/octet-stream') mime = media.mime || guessMime(media.name || url, fallback)
      const name = media.name && /\.[a-z0-9]+$/i.test(media.name) ? media.name : `${media.name || media.kind}.${extFor(mime)}`
      return { name, mime, data }
    } catch {
      if (options.signal?.aborted) return null
    }
  }
  return null
}
