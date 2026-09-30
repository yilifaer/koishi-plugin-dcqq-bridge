// bridge.status 用的统计（只在内存里，插件重载后清零）。不记任何聊天内容。

const DAY = 86400000

export interface BridgeStats {
  lastForwardAt: number
  forwards: number[]
  failures: number[]
  lastFailure: { reason: string; at: number } | null
  translated: number[]
  translateFailures: number[]
}

export class Stats {
  private map = new Map<string, BridgeStats>()
  /** 这个 QQ 群今天因为什么原因改发了文字：群号 → 日期 → 原因 → 次数。 */
  private fallbacks = new Map<string, { date: string; reasons: Map<string, number> }>()

  /** 统计从什么时候开始（插件每次重载都重新开始，A8）。 */
  readonly startedAt: number

  constructor(private now: () => number = Date.now) {
    this.startedAt = now()
  }

  private entry(key: string) {
    let stats = this.map.get(key)
    if (!stats) this.map.set(key, stats = { lastForwardAt: 0, forwards: [], failures: [], lastFailure: null, translated: [], translateFailures: [] })
    return stats
  }

  private prune(list: number[]) {
    const cutoff = this.now() - DAY
    while (list.length && list[0] < cutoff) list.shift()
  }

  forwarded(key: string) {
    const stats = this.entry(key)
    stats.lastForwardAt = this.now()
    stats.forwards.push(this.now())
    this.prune(stats.forwards)
  }

  failed(key: string, reason: string) {
    const stats = this.entry(key)
    stats.failures.push(this.now())
    stats.lastFailure = { reason, at: this.now() }
    this.prune(stats.failures)
  }

  /** 翻译结果（跳过的不算）。 */
  translation(key: string, ok: boolean, reason?: string) {
    const stats = this.entry(key)
    ;(ok ? stats.translated : stats.translateFailures).push(this.now())
    if (!ok && reason) this.lastTranslateFailure.set(key, { reason, at: this.now() })
    this.prune(stats.translated)
    this.prune(stats.translateFailures)
  }

  lastTranslateFailure = new Map<string, { reason: string; at: number }>()

  get(key: string) {
    const stats = this.entry(key)
    for (const list of [stats.forwards, stats.failures, stats.translated, stats.translateFailures]) this.prune(list)
    return {
      lastForwardAt: stats.lastForwardAt,
      forwards: stats.forwards.length,
      failures: stats.failures.length,
      lastFailure: stats.lastFailure,
      translated: stats.translated.length,
      translateFailures: stats.translateFailures.length,
      lastTranslateFailure: this.lastTranslateFailure.get(key) ?? null,
    }
  }

  atAllFallback(groupId: string, date: string, reason: string) {
    let entry = this.fallbacks.get(groupId)
    if (!entry || entry.date !== date) this.fallbacks.set(groupId, entry = { date, reasons: new Map() })
    entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1)
  }

  atAllFallbacks(groupId: string, date: string): Map<string, number> {
    const entry = this.fallbacks.get(groupId)
    return entry && entry.date === date ? entry.reasons : new Map()
  }
}
