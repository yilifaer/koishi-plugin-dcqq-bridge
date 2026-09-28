// Discord 时间码 `<t:N:S>` 的换算（清单 §7.3、B4）。一律用配置的时区，不用本机时区（S18）。

/** 时间戳上限（秒）：JS Date 能表示的最大时刻。负数（1970 年以前）也当成非法，原样保留。 */
const MAX_SECONDS = 8.64e12

const formats = new Map<string, Intl.DateTimeFormat>()

function getFormat(timeZone: string): Intl.DateTimeFormat {
  let fmt = formats.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formats.set(timeZone, fmt)
  }
  return fmt
}

/** 时区合法 → 返回规范名（例如 `asia/shanghai` → `Asia/Shanghai`）；不合法 → null。 */
export function isValidTimeZone(tz: string): string | null {
  if (typeof tz !== 'string' || !tz.trim()) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

const pad = (s: string) => s.padStart(2, '0')

// 相对时间的取整规则（R 样式，写进 DECISIONS.md）：
// diff = |t - now|（毫秒）；m = Math.round(diff / 60000)；
// m < 1 → `（刚刚）`；m < 60 → `（约m分钟后/前）`；
// 否则 h = Math.round(diff / 3600000)；h < 24 → `（约h小时后/前）`；
// 否则 d = Math.round(diff / 86400000) → `（约d天后/前）`。t > now 为「后」，否则为「前」。
function relative(ms: number, now: number): string {
  const diff = Math.abs(ms - now)
  const dir = ms > now ? '后' : '前'
  const m = Math.round(diff / 60000)
  if (m < 1) return '（刚刚）'
  if (m < 60) return `（约${m}分钟${dir}）`
  const h = Math.round(diff / 3600000)
  if (h < 24) return `（约${h}小时${dir}）`
  const d = Math.round(diff / 86400000)
  return `（约${d}天${dir}）`
}

/**
 * 把 `<t:N:S>` 换算成文字。N 非法或超出范围、样式未知 → null（调用方保留原文）。
 * @param seconds N（秒）
 * @param style 样式字母；undefined = f
 * @param now 「现在」（毫秒），给 R 样式用
 */
export function formatTimestamp(seconds: number, style: string | undefined, timeZone: string, now: number): string | null {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SECONDS) return null
  const ms = seconds * 1000
  let fmt: Intl.DateTimeFormat
  try {
    fmt = getFormat(timeZone)
  } catch {
    return null
  }
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(ms)) p[part.type] = part.value
  const { year, month, day, weekday, hour, minute, second } = p
  const date = `${year}年${month}月${day}日`
  const dashed = `${year}-${pad(month)}-${pad(day)}`
  const hm = `${hour}:${minute}`
  switch (style ?? 'f') {
    case 't': return hm
    case 'T': return `${hm}:${second}`
    case 'd': return dashed
    case 'D': return date
    case 'f': return `${date} ${hm}`
    case 'F': return `${date} ${weekday} ${hm}`
    case 's': return `${dashed} ${hm}`
    case 'S': return `${dashed} ${hm}:${second}`
    case 'R': return `${date} ${hm}${relative(ms, now)}`
    default: return null
  }
}
