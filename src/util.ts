// 小工具：LRU、并发限制、按目标的有序队列、雪花 ID。

/** 只记「有没有见过」的 LRU。 */
export class SeenSet {
  private map = new Map<string, true>()
  constructor(private limit = 10000) {}

  has(key: string) {
    return this.map.has(key)
  }

  add(key: string) {
    this.map.delete(key)
    this.map.set(key, true)
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string)
  }
}

/** 带过期时间的缓存。 */
export class TtlCache<T> {
  private map = new Map<string, { value: T; at: number }>()
  constructor(private ttl: number, private now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (this.now() - hit.at > this.ttl) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: T) {
    this.map.set(key, { value, at: this.now() })
    if (this.map.size > 5000) this.map.delete(this.map.keys().next().value as string)
  }
}

/** 全局并发上限（预处理用，清单 §6.2 第 6 步）。 */
export class Limiter {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(private max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

/**
 * 每个目标频道一条队列：reserve() 同步占位（保证按收到的先后），返回的 turn 在前面所有占位都结束后 resolve；
 * 用完必须调用 done()。
 */
export class OrderedQueues {
  private tails = new Map<string, Promise<void>>()

  reserve(key: string): { turn: Promise<void>; done: () => void } {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let done!: () => void
    const finished = new Promise<void>((resolve) => (done = resolve))
    const tail = previous.then(() => finished)
    this.tails.set(key, tail)
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return { turn: previous, done }
  }

  /** 还有没有排着的（测试用）。 */
  get size() {
    return this.tails.size
  }
}

const DISCORD_EPOCH = 1420070400000n

export function snowflakeFromTime(ms: number): string {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString()
}

export function timeFromSnowflake(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
  } catch {
    return 0
  }
}

export function compareSnowflake(a: string, b: string): number {
  try {
    const x = BigInt(a)
    const y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  } catch {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
  }
}

/** 按时区取日期 `YYYY-MM-DD`。 */
export function dateIn(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (ms: number) => format.format(new Date(ms))
}

/** 某个时刻在这个时区的 UTC 偏移，例如 `UTC+8`、`UTC+9:30`、`UTC-3:30`；零偏移写 `UTC`（按那个时刻算，夏令时也对）。 */
export function utcOffset(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  const minutes = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000)
  if (!minutes) return 'UTC'
  const abs = Math.abs(minutes)
  return `UTC${minutes > 0 ? '+' : '-'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`
}
