// 在线词表（0.4.0）：黑话表、官方名称表可以写成网址，插件定时下载。
// - 用 ctx.http，不用 bot.http（那会把机器人的 token 发给别的网站）；每次请求 30 秒超时、有大小上限，边下边算（和媒体下载一样）。
// - 下载成功的内容存在 <实例目录>/data/dcqq-bridge/cache/ 下，每个网址只留一份：先写临时文件再改名覆盖旧的。
//   内容写进去了才写记录（ETag 等，带内容的 sha1）；启动时先读缓存马上用，再在后台下载；启动和转发都不等网络。
// - 下载失败：继续用手上的版本（内存 → 缓存 → 插件自带 / 没有），每次连续失败只写一条日志。
// - 网址一项里可以用 `||` 写几个备用网址，按顺序试，第一个成功的为准。

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'koishi'
import { baseName } from './glossary/slang'
import { describeError } from './log'
import { HttpStatusError, limitedBody, TooLarge } from './media'

export type OnlineKind = 'slang' | 'official'

export interface OnlineSpec {
  kind: OnlineKind
  /** 按顺序尝试的网址（第一个决定缓存文件名） */
  urls: string[]
  /** false：配置里有、但现在不用（例如没打开官方名称表）。不下载也不读缓存，但缓存文件保留。 */
  active: boolean
}

/** 大小上限：黑话表 5 MB、官方名称表 20 MB。 */
export const ONLINE_LIMITS: Record<OnlineKind, number> = { slang: 5 * 1024 * 1024, official: 20 * 1024 * 1024 }
const TIMEOUT = 30000
/** Node 定时器最长的间隔（2^31-1 毫秒，约 596.5 小时）；再大 Node 会改成 1 毫秒，变成不停地下载 */
const MAX_TIMER_MS = 2 ** 31 - 1
const EXT: Record<OnlineKind, string> = { slang: 'yaml', official: 'json' }
/** 缓存目录里只碰符合这个格式的文件（自己写的），别的文件不动 */
const CACHE_FILE_RE = /^(slang|official)-([0-9a-f]{12})\.(yaml|json|meta\.json)$/
const META_FILE_RE = /^(slang|official)-([0-9a-f]{12})\.meta\.json$/
const TEMP_FILE_RE = /^(slang|official)-[0-9a-f]{12}\.(yaml|json|meta\.json)\.[0-9a-z-]+\.tmp$/
/** 正在写的临时文件（同一个进程里所有实例共用，清理时跳过） */
const writingTemps = new Set<string>()

export interface CheckResult {
  error?: string
  /** 检查时顺便解析出来的内容（官方名称表），存起来给重建术语表用 */
  value?: unknown
}

export interface OnlineSource {
  key: string
  kind: OnlineKind
  urls: string[]
  /** 回复、状态里用的短名字（第一个网址的文件名） */
  name: string
  /** 缓存文件名（不带扩展名），例如 slang-0123456789ab */
  stem: string
  active: boolean
  /** 手上能用的内容；从来没下载到、也没有缓存时为 null */
  text: string | null
  hash: string | null
  /** 缓存目录里的内容文件的 sha1（读缓存、写缓存成功后更新）；没有或不知道时为 null。和 hash 不一样就要重写内容 */
  diskHash: string | null
  /** 上一次写内容缓存失败了（连续失败只写一条日志） */
  cacheWriteFailed?: boolean
  /** 手上的内容是从旧网址的那份缓存读的（改名接不过来时），自己名下还没写好之前那份不能删 */
  borrowed?: string
  value?: unknown
  /** text 是从哪来的 */
  from: 'download' | 'cache' | null
  /** 内容最近一次确认是最新的时间（下载成功或服务器回复「没变」），重启后从缓存的记录里读 */
  savedAt: number
  /** 条件请求用：上次成功的网址和它的 ETag / Last-Modified */
  meta: { url?: string; etag?: string; lastModified?: string }
  /** 这次运行里最近一次下载成功的时间 */
  lastSuccess: number
  /** 正在连续失败：原因和时间；成功后清空 */
  error: { reason: string; at: number } | null
  inflight?: Promise<boolean>
}

interface Meta {
  urls?: string[]
  url?: string
  etag?: string
  lastModified?: string
  savedAt?: number
  /** 内容文件的 sha1：读缓存时和文件对不上（没写完、被换过）就不用 ETag / Last-Modified，重新下载整份 */
  hash?: string
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 缓存文件名只由种类和第一个网址决定（网址里的 token 不会出现在文件名里）。 */
export function cacheStem(kind: OnlineKind, firstUrl: string) {
  return `${kind}-${sha1(`${kind}\n${firstUrl}`).slice(0, 12)}`
}

/** 下载出错的简短原因（不带网址里的路径和参数，只写主机名）。 */
function reasonOf(error: unknown, kind: OnlineKind) {
  if (error instanceof TooLarge) return `文件太大（超过 ${ONLINE_LIMITS[kind] / 1024 / 1024} MB）`
  if (error instanceof HttpStatusError) return `HTTP ${error.status}`
  const text = describeError(error)
  return text === '请求超时' ? '超时' : text
}

export class OnlineSources {
  readonly dir: string
  private sources = new Map<string, OnlineSource>()
  private disposed = false
  private abort = new AbortController()
  private stopTimer: (() => void) | null = null
  /** 定时检查的间隔（毫秒，已经限制在 Node 定时器的上限以内）；0 = 不定时 */
  intervalMs = 0

  constructor(
    private ctx: Context,
    private logger: { warn(...args: any[]): void; info(...args: any[]): void },
    private check: (kind: OnlineKind, text: string) => CheckResult,
    private now: () => number = Date.now,
  ) {
    this.dir = join(ctx.baseDir ?? process.cwd(), 'data/dcqq-bridge/cache')
  }

  get(kind: OnlineKind, firstUrl: string): OnlineSource | undefined {
    return this.sources.get(cacheStem(kind, firstUrl))
  }

  /** 正在用的在线来源，按配置的顺序 */
  list(): OnlineSource[] {
    return [...this.sources.values()].filter((s) => s.active)
  }

  /**
   * 按配置建好每个来源；新来源先读缓存（只读本机文件，不连网）。
   * 改了、调换了 `||` 里的网址时，自己名下没有缓存的来源先接过旧网址的缓存（见 adoptOrphans）。
   * 顺便清理缓存目录：删掉已经不在配置里的网址的缓存和记录，以及上次没写完留下的临时文件。
   */
  async sync(specs: OnlineSpec[]) {
    const next = new Map<string, OnlineSource>()
    for (const spec of specs) {
      if (!spec.urls.length) continue
      const stem = cacheStem(spec.kind, spec.urls[0])
      if (next.has(stem)) continue
      const old = this.sources.get(stem)
      const source: OnlineSource = old ?? {
        key: stem, kind: spec.kind, urls: spec.urls, name: baseName(spec.urls[0]), stem, active: spec.active,
        text: null, hash: null, diskHash: null, from: null, savedAt: 0, meta: {}, lastSuccess: 0, error: null,
      }
      source.urls = spec.urls
      source.active = spec.active
      next.set(stem, source)
      if (source.active && source.text === null && !old?.inflight) await this.loadCache(source)
    }
    const keep = new Set(next.keys())
    await this.adoptOrphans(next, keep)
    // 借来的那份是唯一能用的缓存：自己名下写好之前留着（例如断网时发了 bridge.reload）
    for (const source of next.values()) if (source.borrowed) keep.add(source.borrowed)
    if (this.disposed) return
    this.sources = next
    await this.cleanup(keep)
  }

  /**
   * 缓存文件名只按第一个网址算，改了第一个网址或者调换了 `||` 前后的顺序，文件名就变了。
   * 自己名下没有缓存的来源，先找同一种类、记录里的网址和现在配置的网址有重合的旧缓存，改名成自己的接着用，
   * 免得新版本下载好之前就把唯一能用的那份删掉（例如断网时把镜像调到前面）。
   * 旧记录里下载成功的那个网址还在配置里，才保留它的 ETag / Last-Modified。接不过来的旧缓存照常清理。
   */
  private async adoptOrphans(next: Map<string, OnlineSource>, keep: Set<string>) {
    const waiting = [...next.values()].filter((s) => s.text === null && !s.inflight)
    if (!waiting.length) return
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    const orphans: Array<{ stem: string; kind: OnlineKind; meta: Meta; taken?: boolean }> = []
    for (const name of names) {
      const m = META_FILE_RE.exec(name)
      if (!m) continue
      const kind = m[1] as OnlineKind
      const stem = `${kind}-${m[2]}`
      if (next.has(stem) || !names.includes(`${stem}.${EXT[kind]}`)) continue
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name), 'utf8'))
        if (meta && typeof meta === 'object') orphans.push({ stem, kind, meta })
      } catch {}
    }
    // 有几份都能接时用最近确认过的那份
    orphans.sort((a, b) => (Number(b.meta.savedAt) || 0) - (Number(a.meta.savedAt) || 0))
    for (const source of waiting) {
      if (this.disposed) return
      const ext = EXT[source.kind]
      // 不用的来源（例如没打开官方名称表）不读缓存，自己名下有文件时不动
      if (!source.active && names.includes(`${source.stem}.${ext}`)) continue
      const found = orphans.find((o) => {
        if (o.taken || o.kind !== source.kind) return false
        const urls = [...(Array.isArray(o.meta.urls) ? o.meta.urls : []), o.meta.url]
        return urls.some((u) => typeof u === 'string' && source.urls.includes(u))
      })
      if (!found) continue
      // 上面读目录的这段时间里，后台下载可能已经拿到了新版本：那就不用旧缓存，免得旧内容盖住刚写好的新文件
      if (source.text !== null || source.inflight) continue
      found.taken = true
      try {
        await rename(join(this.dir, `${found.stem}.${ext}`), join(this.dir, `${source.stem}.${ext}`))
      } catch (e) {
        // 改名失败：旧的这份先留着（下次再接），不能删；这次运行先直接读它，断网时也有词条
        keep.add(found.stem)
        this.logger.warn(`在线词表 ${source.name} 接不过旧网址的缓存：${describeError(e)}`)
        if (source.active) await this.loadCache(source, found.stem)
        continue
      }
      const old = found.meta
      const meta: Meta = { urls: source.urls, savedAt: typeof old.savedAt === 'number' ? old.savedAt : undefined, hash: str(old.hash) }
      const url = str(old.url)
      if (url && source.urls.includes(url)) Object.assign(meta, { url, etag: str(old.etag), lastModified: str(old.lastModified) })
      // 记录写不进去也没关系：读缓存时对不上 sha1，就当没有 ETag
      await this.writeAtomic(`${source.stem}.meta.json`, JSON.stringify(meta, null, 2)).catch(() => {})
      await rm(join(this.dir, `${found.stem}.meta.json`), { force: true }).catch(() => {})
      if (source.active) await this.loadCache(source)
    }
  }

  /** stem：从哪一份缓存读，默认是来源自己名下的（改名失败时读旧网址的那份）。 */
  private async loadCache(source: OnlineSource, stem = source.stem) {
    const own = stem === source.stem
    let text: string
    try {
      text = await readFile(join(this.dir, `${stem}.${EXT[source.kind]}`), 'utf8')
    } catch {
      return
    }
    if (this.disposed || source.text !== null) return
    const checked = this.check(source.kind, text)
    if (checked.error) {
      this.logger.warn(`在线词表 ${source.name} 的缓存不能用（${checked.error}），等下载`)
      return
    }
    let meta: Meta = {}
    try {
      meta = JSON.parse(await readFile(join(this.dir, `${stem}.meta.json`), 'utf8')) ?? {}
    } catch {}
    const hash = sha1(text)
    // 记录里的 sha1 和内容对不上（内容没写进去、两次改名之间断电、文件被换过）：记录不是这份内容的，
    // 不用它的 ETag（不然服务器回复「没变」，旧内容就一直被当成最新的），时间按文件的修改时间
    // 读的是旧网址的那份时，下载成功的那个网址还在配置里才用它的 ETag
    const matches = meta.hash === hash && (own || (typeof meta.url === 'string' && source.urls.includes(meta.url)))
    let savedAt = meta.hash === hash && typeof meta.savedAt === 'number' ? meta.savedAt : 0
    if (!savedAt) {
      try {
        savedAt = (await stat(join(this.dir, `${stem}.${EXT[source.kind]}`))).mtimeMs
      } catch {}
    }
    if (this.disposed || source.text !== null) return
    source.text = text
    source.hash = hash
    // 自己名下还没有这份内容：下次下载成功（包括「没变」）时补写；在那之前借来的那份不能删
    source.diskHash = own ? hash : null
    source.borrowed = own ? undefined : stem
    source.value = checked.value
    source.from = 'cache'
    source.savedAt = savedAt
    source.meta = matches ? { url: str(meta.url), etag: str(meta.etag), lastModified: str(meta.lastModified) } : {}
  }

  private async cleanup(keep: Set<string>) {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(this.dir, name)
      let remove = false
      if (TEMP_FILE_RE.test(name)) remove = !writingTemps.has(path)
      else {
        const m = CACHE_FILE_RE.exec(name)
        if (m) remove = !keep.has(`${m[1]}-${m[2]}`)
      }
      if (remove) await rm(path, { force: true }).catch(() => {})
    }
  }

  /** 先写同一目录下的临时文件，再改名覆盖旧文件：每个来源只留一份，写到一半断电也不会坏掉旧的。 */
  private async writeAtomic(name: string, data: string) {
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, name)
    const temp = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
    writingTemps.add(temp)
    try {
      await writeFile(temp, data)
      await rename(temp, target)
    } catch (e) {
      await rm(temp, { force: true }).catch(() => {})
      throw e
    } finally {
      writingTemps.delete(temp)
    }
  }

  /**
   * 把手上的版本存进缓存（下载成功、服务器回复「没变」之后）：
   * 缓存目录里的内容和手上的不一样（上次没写进去、文件被删了）就重写内容；
   * 内容确实是手上这份时才写记录（ETag、时间、sha1）。内容写不进去时不动旧记录：旧记录对应的还是旧内容。
   */
  private async persist(source: OnlineSource, savedAt: number) {
    const { text, hash } = source
    if (this.disposed || text === null || hash === null) return
    const file = `${source.stem}.${EXT[source.kind]}`
    let onDisk = source.diskHash === hash
    if (onDisk) onDisk = await stat(join(this.dir, file)).then(() => true, () => false)
    if (!onDisk) {
      try {
        await this.writeAtomic(file, text)
        source.diskHash = hash
        source.cacheWriteFailed = false
        // 自己名下有了，借来的那份下次清理时删掉
        source.borrowed = undefined
      } catch (e) {
        if (!source.cacheWriteFailed) this.logger.warn(`在线词表 ${source.name} 的缓存写不进去：${describeError(e)}`)
        source.cacheWriteFailed = true
        return
      }
    }
    if (this.disposed || source.hash !== hash) return
    const meta: Meta = { urls: source.urls, ...source.meta, savedAt, hash }
    await this.writeAtomic(`${source.stem}.meta.json`, JSON.stringify(meta, null, 2)).catch(() => {})
  }

  /** 下载所有正在用的来源（同时进行）。返回有没有内容变了的。 */
  async refreshAll(): Promise<boolean> {
    const results = await Promise.all(this.list().map((s) => this.refresh(s)))
    return results.some(Boolean)
  }

  /** 下载一个来源；同一个来源正在下载时等那一次。返回内容是否变了。 */
  refresh(source: OnlineSource): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    source.inflight ??= this.fetch(source).catch((e) => {
      this.logger.warn(`在线词表 ${source.name} 处理出错：${describeError(e)}`)
      return false
    }).finally(() => {
      source.inflight = undefined
    })
    return source.inflight
  }

  private async fetch(source: OnlineSource): Promise<boolean> {
    const reasons: string[] = []
    for (const url of source.urls) {
      if (this.disposed) return false
      // 每次请求用自己的中止信号，用完就解绑（F1）
      const child = new AbortController()
      const onAbort = () => child.abort(this.abort.signal.reason)
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const headers: Record<string, string> = {}
        if (source.text !== null && source.meta.url === url) {
          if (source.meta.etag) headers['If-None-Match'] = source.meta.etag
          if (source.meta.lastModified) headers['If-Modified-Since'] = source.meta.lastModified
        }
        const response = await this.ctx.http(url, {
          method: 'GET',
          headers,
          // 所有状态都交给 limitedBody：4xx、5xx 不读错误页（不然 http 库会把整个错误页读进内存，绕过大小上限），
          // 抛 HttpStatusError；304 返回空内容；2xx 边下边算大小
          responseType: limitedBody(ONLINE_LIMITS[source.kind], child.signal),
          validateStatus: () => true,
          timeout: TIMEOUT,
          signal: child.signal,
        })
        if (this.disposed) return false
        if (response.status === 304) {
          if (source.text === null) {
            reasons.push(`${hostOf(url)} 回复「没变」，但手上没有内容`)
            continue
          }
          // 先存好缓存再算成功（等 lastSuccess 的地方能看到写好的文件）
          const at = this.now()
          await this.persist(source, at)
          if (this.disposed) return false
          this.succeeded(source, at)
          return false
        }
        let text = new TextDecoder('utf-8').decode(response.data as ArrayBuffer)
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        const checked = text.trim() ? this.check(source.kind, text) : { error: '内容是空的' }
        if (checked.error) {
          reasons.push(`${hostOf(url)} 内容不对：${checked.error}`)
          continue
        }
        const hash = sha1(text)
        const changed = hash !== source.hash
        source.meta = {
          url,
          etag: response.headers?.get?.('etag') ?? undefined,
          lastModified: response.headers?.get?.('last-modified') ?? undefined,
        }
        if (changed) {
          source.text = text
          source.hash = hash
          source.value = checked.value
        }
        source.from = 'download'
        const at = this.now()
        await this.persist(source, at)
        if (this.disposed) return false
        this.succeeded(source, at)
        return changed
      } catch (e) {
        if (this.disposed) return false
        reasons.push(`${hostOf(url)} ${reasonOf(e, source.kind)}`)
      } finally {
        this.abort.signal.removeEventListener('abort', onAbort)
        child.abort()
      }
    }
    if (this.disposed) return false
    const reason = reasons.join('；') || '没有可用的网址'
    // 连续失败只在第一次写日志
    if (!source.error) {
      const using = source.text === null ? '现在没有可用的版本' : '继续用手上的版本'
      this.logger.warn(`在线词表 ${source.name} 下载失败（${reason}），${using}`)
    }
    source.error = { reason, at: this.now() }
    return false
  }

  private succeeded(source: OnlineSource, at: number) {
    if (source.error) this.logger.info(`在线词表 ${source.name} 恢复下载`)
    source.error = null
    source.savedAt = source.lastSuccess = at
  }

  /**
   * 后台检查：马上检查一次（不等它），之后每隔 intervalMs 检查一次（0 = 不定时）。内容变了就调用 onChange。
   * 间隔最长 2^31-1 毫秒（Node 定时器的上限）。再调用一次时先停掉上一次的定时器。
   */
  start(intervalMs: number, onChange: () => Promise<void> | void) {
    this.stopTimer?.()
    this.stopTimer = null
    this.intervalMs = 0
    if (this.disposed || !this.list().length) return
    const run = () => {
      void this.refreshAll().then(async (changed) => {
        if (changed && !this.disposed) await onChange()
      }).catch((e) => this.logger.warn(`在线词表检查出错：${describeError(e)}`))
    }
    run()
    if (!(intervalMs > 0)) return
    // 超过 Node 定时器的上限时 Node 会改成 1 毫秒（变成不停地下载），这里再限制一次
    this.intervalMs = Math.min(intervalMs, MAX_TIMER_MS)
    this.stopTimer = this.ctx.setInterval(run, this.intervalMs)
  }

  dispose() {
    this.disposed = true
    this.stopTimer?.()
    this.stopTimer = null
    this.abort.abort()
  }
}
