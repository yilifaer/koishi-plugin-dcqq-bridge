// bridge.status 用的统计（只在内存里，插件重载后清零）。不记任何聊天内容。

const DAY = 86400000

export interface BridgeStats {
  lastForwardAt: number
  forwards: number[]
  failures: number[]
  lastFailure: { reason: string; at: number } | null
}

export class Stats {
  private map = new Map<string, BridgeStats>()
  /** 这个 QQ 群今天因为什么原因改发了文字：群号 → 日期 → 原因 → 次数。 */
  private fallbacks = new Map<string, { date: string; reasons: Map<string, number> }>()

  constructor(private now: () => number = Date.now) {}

  private entry(key: string) {
    let stats = this.map.get(key)
    if (!stats) this.map.set(key, stats = { lastForwardAt: 0, forwards: [], failures: [], lastFailure: null })
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

  get(key: string) {
    const stats = this.entry(key)
    this.prune(stats.forwards)
    this.prune(stats.failures)
    return { lastForwardAt: stats.lastForwardAt, forwards: stats.forwards.length, failures: stats.failures.length, lastFailure: stats.lastFailure }
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
