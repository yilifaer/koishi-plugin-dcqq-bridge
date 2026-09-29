// 配置的运行时检查（清单 §4、§0「配置出错的原则」）：坏的一行跳过、写日志、在 bridge.status 里标出来，其他照常工作。

import { INVALID_ROW_KEY } from './config'
import type { AtAllConfig, BridgeRow, Config, Direction, GlossaryDir, GlossaryMode } from './config'
import { isValidTimeZone } from './discord/timestamp'

export interface Bridge {
  /** 在 bridges 列表里的位置（从 1 开始，只用来显示）。 */
  index: number
  label: string
  discord: string
  qq: string
  direction: Direction
  atAll: boolean
  /** 这个桥打开了翻译（还要看总开关）。 */
  translate: boolean
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

export interface TranslateSettings {
  /** 实际是否启用：总开关打开，并且接口地址和模型都填了。 */
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  label: string
  timeoutMs: number
  maxPerHour: number
}

export interface FilterSettings {
  keywords: string
  keywordFile: string
  moderation: boolean
  moderationBaseURL: string
  moderationApiKey: string
}

export interface GlossarySettings {
  eve: boolean
  systemStyle: 'en(zh)' | 'en' | 'zh'
  slangFile: string
  overrides: Array<{ en: string; zh: string; mode: GlossaryMode; dir: GlossaryDir }>
}

export interface Settings {
  discordSelfId: string
  qqSelfId: string
  timeZone: string
  discordAsWebhook: boolean
  keepDays: number
  authority: number
  qqReorderMs: number
  /** 消息在队列里最多等几分钟，0 = 不限制。 */
  maxQueueAgeMinutes: number
  atAll: AtAllConfig
  translate: TranslateSettings
  filter: FilterSettings
  glossary: GlossarySettings
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
  const tr: any = config.translate && typeof config.translate === 'object' ? config.translate : {}
  const fl: any = config.filter && typeof config.filter === 'object' ? config.filter : {}
  const gl: any = config.glossary && typeof config.glossary === 'object' ? config.glossary : {}
  // 标注去掉空白和零宽字符后为空，就用【机翻】（清单 §4.4）
  let label = text(tr.label, '【机翻】').trim()
  if (!label.replace(/[\s\p{Cf}\u034f\u115f\u1160\u3164\uffa0]/gu, '')) {
    if (tr.label !== undefined) problems.push('译文标注不能为空，已改用「【机翻】」')
    label = '【机翻】'
  }
  const translate: TranslateSettings = {
    enabled: tr.enabled === true,
    baseURL: text(tr.baseURL).trim().replace(/\/+$/, ''),
    apiKey: text(tr.apiKey).trim(),
    model: text(tr.model).trim(),
    label,
    timeoutMs: clampInt(tr.timeoutMs, 6000, 1000, 60000),
    maxPerHour: clampInt(tr.maxPerHour, 0, 0, 1000000),
  }
  if (translate.enabled && (!translate.baseURL || !translate.model)) {
    problems.push('翻译已打开，但没有填接口地址或模型，按关闭处理')
    translate.enabled = false
  }
  const MODES: GlossaryMode[] = ['keep', 'force', 'hint']
  const DIRS: GlossaryDir[] = ['both', 'en2zh', 'zh2en']
  const overrides: GlossarySettings['overrides'] = []
  for (const [i, raw] of (Array.isArray(gl.overrides) ? gl.overrides : []).entries()) {
    const en = text(raw?.en).trim()
    const zh = text(raw?.zh).trim()
    if (!en || !zh || !MODES.includes(raw?.mode) || !DIRS.includes(raw?.dir)) {
      problems.push(`术语表自定义词条第 ${i + 1} 行无效，已跳过`)
      continue
    }
    overrides.push({ en, zh, mode: raw.mode, dir: raw.dir })
  }
  const settings: Settings = {
    discordSelfId: text(config.discordSelfId).trim(),
    qqSelfId: text(config.qqSelfId).trim(),
    timeZone,
    discordAsWebhook: config.discordAsWebhook !== false,
    keepDays: clampInt(config.keepDays, 7, 1, 3650),
    authority: clampInt(config.authority, 4, 0, 5),
    qqReorderMs: clampInt(config.qqReorderMs, 0, 0, 10000),
    maxQueueAgeMinutes: clampInt(config.maxQueueAgeMinutes, 15, 0, 1440),
    atAll: {
      fallbackText: text(atAll.fallbackText, '【全体通知】'),
      reserve: clampInt(atAll.reserve, 0, 0, 1000),
      dailyCap: clampInt(atAll.dailyCap, 0, 0, 1000),
      cooldownMinutes: clampInt(atAll.cooldownMinutes, 0, 0, 100000),
      maxAgeMinutes: clampInt(atAll.maxAgeMinutes, 10, 0, 100000),
    },
    translate,
    filter: {
      keywords: text(fl.keywords),
      keywordFile: text(fl.keywordFile).trim(),
      moderation: fl.moderation === true,
      moderationBaseURL: (text(fl.moderationBaseURL).trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      moderationApiKey: text(fl.moderationApiKey).trim(),
    },
    glossary: {
      eve: gl.eve === true,
      systemStyle: ['en(zh)', 'en', 'zh'].includes(gl.systemStyle) ? gl.systemStyle : 'en(zh)',
      slangFile: text(gl.slangFile).trim(),
      overrides,
    },
    rows: [],
    bridges: [],
    problems,
    allKeys: new Set(),
  }

  const rows: BridgeRow[] = Array.isArray(config.bridges) ? config.bridges : []
  const seen = new Map<string, RowStatus>()
  rows.forEach((raw: any, i) => {
    // 整行校验失败时 schema 返回的是光秃秃的哨兵（没有补默认值）；空行（null）会补上默认值，按普通空行处理
    const broken = !raw || typeof raw !== 'object' || Array.isArray(raw) || (raw[INVALID_ROW_KEY] === true && !('direction' in raw))
    const row = broken ? {} : raw
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
    if (broken) {
      status.invalid = `第 ${i + 1} 行有写错的字段（例如方向、启用写成了别的值），已跳过`
      return
    }
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
      translate: row.translate === true,
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
