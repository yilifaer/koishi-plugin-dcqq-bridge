// 配置的运行时检查（清单 §4、§0「配置出错的原则」）：坏的一行跳过、写日志、在 bridge.status 里标出来，其他照常工作。

import type { AtAllConfig, BridgeRow, Config, Direction } from './config'
import { isValidTimeZone } from './discord/timestamp'

export interface Bridge {
  /** 在 bridges 列表里的位置（从 1 开始，只用来显示）。 */
  index: number
  label: string
  discord: string
  qq: string
  direction: Direction
  atAll: boolean
  /** 编译好的屏蔽词。 */
  blockWords: RegExp[]
  /** 桥的唯一标识：`<discord>:<qq>`。 */
  key: string
}

/** 配置里的一行（不管有效与否），给 bridge.status 显示用。 */
export interface RowStatus {
  index: number
  label: string
  discord: string
  qq: string
  direction: Direction
  enabled: boolean
  /** 这一行为什么无效（有效时为空）。 */
  invalid: string
  /** 不影响工作的提示（例如写错的屏蔽词、建议合并）。 */
  warnings: string[]
  bridge: Bridge | null
}

export interface Settings {
  discordSelfId: string
  qqSelfId: string
  timeZone: string
  discordAsWebhook: boolean
  keepDays: number
  authority: number
  qqReorderMs: number
  atAll: AtAllConfig
  rows: RowStatus[]
  bridges: Bridge[]
  /** 全局问题（例如时区写错）。 */
  problems: string[]
  /** 配置里出现过的所有 (discord, qq)，不管有效与否（清理暂停状态时用，R17）。 */
  allKeys: Set<string>
}

export function bridgeKey(discord: string, qq: string) {
  return `${discord}:${qq}`
}

const DIRECTIONS: Direction[] = ['both', 'd2q', 'q2d']

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback
}

/** 编译屏蔽词：每一条是正则，不区分大小写，多条用 `;;` 分隔；写错的那条跳过（DECISIONS 第 7 条）。 */
export function compileBlockWords(source: string): { patterns: RegExp[]; errors: string[] } {
  const patterns: RegExp[] = []
  const errors: string[] = []
  for (const raw of source.split(';;')) {
    const entry = raw.trim()
    if (!entry) continue
    try {
      patterns.push(new RegExp(entry, 'i'))
    } catch {
      errors.push(entry)
    }
  }
  return { patterns, errors }
}

export function normalizeSettings(config: Partial<Config>): Settings {
  const problems: string[] = []
  let timeZone = isValidTimeZone(text(config.timezone, 'Asia/Shanghai').trim() || 'Asia/Shanghai')
  if (!timeZone) {
    problems.push(`时区「${text(config.timezone)}」无效，已改用 UTC`)
    timeZone = 'UTC'
  }
  const atAll: any = config.atAll && typeof config.atAll === 'object' ? config.atAll : {}
  const settings: Settings = {
    discordSelfId: text(config.discordSelfId).trim(),
    qqSelfId: text(config.qqSelfId).trim(),
    timeZone,
    discordAsWebhook: config.discordAsWebhook !== false,
    keepDays: clampInt(config.keepDays, 7, 1, 3650),
    authority: clampInt(config.authority, 4, 0, 5),
    qqReorderMs: clampInt(config.qqReorderMs, 0, 0, 10000),
    atAll: {
      fallbackText: text(atAll.fallbackText, '【全体通知】'),
      reserve: clampInt(atAll.reserve, 0, 0, 1000),
      dailyCap: clampInt(atAll.dailyCap, 0, 0, 1000),
      cooldownMinutes: clampInt(atAll.cooldownMinutes, 0, 0, 100000),
      maxAgeMinutes: clampInt(atAll.maxAgeMinutes, 10, 0, 100000),
    },
    rows: [],
    bridges: [],
    problems,
    allKeys: new Set(),
  }

  const rows: BridgeRow[] = Array.isArray(config.bridges) ? config.bridges : []
  const seen = new Map<string, RowStatus>()
  rows.forEach((raw: any, i) => {
    const row = raw && typeof raw === 'object' ? raw : {}
    const status: RowStatus = {
      index: i + 1,
      label: text(row.label).trim(),
      discord: text(row.discord).trim(),
      qq: text(row.qq).trim(),
      direction: DIRECTIONS.includes(row.direction) ? row.direction : 'both',
      enabled: row.enabled !== false,
      invalid: '',
      warnings: [],
      bridge: null,
    }
    settings.rows.push(status)
    if (status.discord && status.qq) settings.allKeys.add(bridgeKey(status.discord, status.qq))
    if (!/^\d+$/.test(status.discord)) {
      status.invalid = status.discord ? 'Discord 频道 ID 必须是纯数字' : 'Discord 频道 ID 为空（在配置文件里写 ID 时要加引号）'
    } else if (!/^\d+$/.test(status.qq)) {
      status.invalid = status.qq ? 'QQ 群号必须是纯数字' : 'QQ 群号为空（在配置文件里写群号时要加引号）'
    }
    if (status.invalid || !status.enabled) return
    const key = bridgeKey(status.discord, status.qq)
    const earlier = seen.get(key)
    if (earlier) {
      // 一行 d2q、一行 q2d：两行都照常工作，只建议合成一行 both（清单 §4.2）
      const pair = [earlier.direction, status.direction].sort().join()
      if (pair !== 'd2q,q2d' || seen.get(key + ':second')) {
        status.invalid = `和第 ${earlier.index} 行重复（同一对 Discord 频道和 QQ 群）`
        return
      }
      seen.set(key + ':second', status)
      status.warnings.push(`和第 ${earlier.index} 行是同一对、方向相反，建议合成一行「双向」`)
      earlier.warnings.push(`和第 ${status.index} 行是同一对、方向相反，建议合成一行「双向」`)
    } else {
      seen.set(key, status)
    }
    const { patterns, errors } = compileBlockWords(text(row.blockWords))
    for (const bad of errors) status.warnings.push(`屏蔽词写错，已跳过：${bad}`)
    status.bridge = {
      index: status.index,
      label: status.label,
      discord: status.discord,
      qq: status.qq,
      direction: status.direction,
      atAll: row.atAll === true,
      blockWords: patterns,
      key,
    }
    settings.bridges.push(status.bridge)
  })
  return settings
}

/** 以某个平台 + 频道为来源、方向允许的桥。 */
export function bridgesFrom(settings: Settings, platform: 'discord' | 'onebot', channelId: string): Bridge[] {
  return settings.bridges.filter((b) => platform === 'discord'
    ? b.discord === channelId && b.direction !== 'q2d'
    : b.qq === channelId && b.direction !== 'd2q')
}
