import yaml from 'js-yaml'
import type { BridgeRow, Direction } from './config'

// 清单 §14 + 附录 R18、O3：把旧插件 @myrtus/forward 的配置换成本插件的 bridges 行。只读，不改任何配置。

export interface ImportResult {
  bridges: BridgeRow[]
  skipped: Array<{ what: string; reason: string }>
  notes: string[]
}

export interface FoundOldConfig {
  path: string
  disabled: boolean
  hasIf: boolean
  config: any
}

const OLD_NAMES = ['@myrtus/forward', '@myrtus/koishi-plugin-forward']

const isDict = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

// 在 loader 的原始配置里找旧插件；分组要递归，`~group:` 里的都算停用
export function findOldConfigs(loaderConfig: unknown): FoundOldConfig[] {
  const found: FoundOldConfig[] = []
  if (!isDict(loaderConfig) || !isDict(loaderConfig.plugins)) return found
  const walk = (dict: Record<string, any>, path: string, disabled: boolean, hasIf: boolean) => {
    for (const key of Object.keys(dict)) {
      if (key.startsWith('$')) continue
      const off = key.startsWith('~')
      const bare = off ? key.slice(1) : key
      const name = bare.split(':')[0]
      const value = dict[key] ?? {}
      const here = `${path}/${key}`
      if (name === 'group') {
        if (isDict(value)) walk(value, here, disabled || off, hasIf || '$if' in value)
        continue
      }
      if (!OLD_NAMES.includes(name)) continue
      const config = isDict(value) ? value : {}
      found.push({ path: here, disabled: disabled || off, hasIf: hasIf || '$if' in config, config })
    }
  }
  walk(loaderConfig.plugins, 'plugins', false, false)
  return found
}

type ConstType = 'source' | 'target' | 'full'

// 按旧 Schema 补默认值；某种类型没有声明的字段在旧插件运行时会被去掉，这里也不看
interface Const {
  key: string
  type: ConstType
  name: string
  platform: string
  channelId: string
  selfId: string | undefined
  blockingWords: unknown[]
  onlyQuote: boolean
  disabled: boolean
  simulateOriginal: boolean
  hidePrefix: boolean
}

const text = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

function normalize(key: string, raw: Record<string, any>): Const | string {
  const type = raw.type
  if (type !== 'source' && type !== 'target' && type !== 'full') return `常量「${key}」的 type 不是 source / target / full`
  const src = type !== 'target'
  const tgt = type !== 'source'
  const selfId = raw.selfId == null || raw.selfId === '' ? (type === 'source' ? '*' : undefined) : text(raw.selfId)
  return {
    key,
    type,
    name: src ? text(raw.name).trim() : '',
    platform: text(raw.platform).trim(),
    channelId: text(raw.channelId).trim(),
    selfId,
    blockingWords: src && Array.isArray(raw.blockingWords) ? raw.blockingWords : [],
    onlyQuote: src && raw.onlyQuote === true,
    disabled: tgt && raw.disabled === true,
    simulateOriginal: tgt && raw.simulateOriginal === true,
    hidePrefix: tgt && raw.hidePrefix === true,
  }
}

const PLATFORMS = ['discord', 'onebot']

// 两个角色都要检查的：频道和平台
function checkChannel(c: Const): string | undefined {
  if (c.channelId === '*') return `常量「${c.key}」的 channelId 是 *（新插件的桥只连接一个具体的频道/群）`
  if (!/^\d+$/.test(c.channelId)) return `常量「${c.key}」的 channelId「${c.channelId}」不是纯数字（可能是私聊或写错）`
  if (!PLATFORMS.includes(c.platform)) return `常量「${c.key}」的平台「${c.platform}」不是 discord 或 onebot`
}

function checkSource(c: Const): string | undefined {
  if (c.type === 'target') return `常量「${c.key}」的类型是 target，不能当来源（旧插件里这条也不起作用）`
  return checkChannel(c)
}

function checkTarget(c: Const): string | undefined {
  if (c.disabled) return `目标「${c.key}」已停用（disabled）`
  if (c.selfId === undefined || c.selfId === '*') {
    return c.type === 'source'
      ? `常量「${c.key}」的类型是 source，没有写具体的 selfId，旧插件里当目标不起作用`
      : `目标「${c.key}」的 selfId 是 * 或没填（旧插件里 * 只在来源一侧有效）`
  }
  return checkChannel(c)
}

interface Pair {
  discord: string
  qq: string
  d2q: boolean
  q2d: boolean
  dConsts: Const[]
  qConsts: Const[]
}

const pushOnce = (list: Const[], c: Const) => { if (!list.includes(c)) list.push(c) }

function makeLabel(p: Pair): string {
  for (const c of p.dConsts) {
    const s = c.name.replace(/^Discord[- ]/, '').trim()
    if (s && s !== 'Discord') return s
  }
  for (const c of p.qConsts) {
    const s = c.name.replace(/^QQ-/, '').trim()
    if (s) return s
  }
  return p.dConsts[0].key
}

export function convertOldConfig(oldConfig: any): ImportResult {
  const skipped: ImportResult['skipped'] = []
  const notes: string[] = []
  const cfg = isDict(oldConfig) ? oldConfig : {}
  const rawConsts = isDict(cfg.constants) ? cfg.constants : {}
  const rules: any[] = Array.isArray(cfg.rules) ? cfg.rules : []

  const consts = new Map<string, Const | string>()
  const getConst = (key: string) => {
    if (!consts.has(key)) {
      const raw = rawConsts[key]
      consts.set(key, isDict(raw) ? normalize(key, raw) : `引用的常量「${key}」不存在`)
    }
    return consts.get(key)!
  }

  const pairs = new Map<string, Pair>()
  const seenEdges = new Set<string>()
  const discordTargets: Const[] = []
  const usedTargets: Const[] = []

  rules.forEach((rule, i) => {
    const r = isDict(rule) ? rule : {}
    const sKey = text(r.source)
    const targets: unknown[] = Array.isArray(r.targets) ? r.targets : []
    const ruleName = `规则 #${i + 1}（${sKey || '没有来源'}）`
    if (!sKey) return skipped.push({ what: ruleName, reason: '没有写来源' })
    if (!targets.length) return skipped.push({ what: ruleName, reason: '目标为空' })
    const s = getConst(sKey)
    if (typeof s === 'string') return skipped.push({ what: ruleName, reason: s })
    const sBad = checkSource(s)
    if (sBad) return skipped.push({ what: ruleName, reason: sBad })

    for (const tv of targets) {
      const tKey = text(tv)
      const edge = `${sKey} → ${tKey}`
      if (seenEdges.has(edge)) continue
      seenEdges.add(edge)
      const what = `规则 #${i + 1}：${edge}`
      const t = getConst(tKey)
      if (typeof t === 'string') { skipped.push({ what, reason: t }); continue }
      const tBad = checkTarget(t)
      if (tBad) { skipped.push({ what, reason: tBad }); continue }
      if (s.platform === t.platform) { skipped.push({ what, reason: `两边都是 ${s.platform}，新插件只连接 Discord 和 QQ` }); continue }
      const oq = [s, t].find(c => c.onlyQuote)
      if (oq) { skipped.push({ what, reason: `常量「${oq.key}」用了 onlyQuote（仅转发引用机器人的消息），新插件没有这个功能` }); continue }

      const d2q = s.platform === 'discord'
      const dc = d2q ? s : t
      const qc = d2q ? t : s
      const id = `${dc.channelId}:${qc.channelId}`
      let p = pairs.get(id)
      if (!p) pairs.set(id, p = { discord: dc.channelId, qq: qc.channelId, d2q: false, q2d: false, dConsts: [], qConsts: [] })
      if (d2q) p.d2q = true
      else p.q2d = true
      pushOnce(p.dConsts, dc)
      pushOnce(p.qConsts, qc)
      pushOnce(usedTargets, t)
      if (!d2q) pushOnce(discordTargets, t)
    }
  })

  // 屏蔽词：同一条只报告一次
  const badWords = new Set<string>()
  const skipWord = (c: Const, w: string, reason: string) => {
    const k = `${c.key}\n${w}`
    if (badWords.has(k)) return
    badWords.add(k)
    skipped.push({ what: `常量「${c.key}」的屏蔽词「${w}」`, reason })
  }
  const wordOk = (c: Const, w: unknown): w is string => {
    if (typeof w !== 'string') { skipWord(c, String(w), '不是文字'); return false }
    if (w === '') { skipWord(c, w, '空的屏蔽词（旧插件里会挡掉所有带文字的消息）'); return false }
    if (w.includes(';;')) { skipWord(c, w, '含有 ;;，新插件用 ;; 分隔屏蔽词，放不进去'); return false }
    try { new RegExp(w, 'i') } catch { skipWord(c, w, '不是有效的正则表达式（旧插件遇到它也会出错）'); return false }
    return true
  }

  let anyWords = false
  const bridges: BridgeRow[] = []
  for (const p of pairs.values()) {
    const words: string[] = []
    for (const c of [...p.dConsts, ...p.qConsts]) {
      for (const w of c.blockingWords) {
        if (wordOk(c, w) && !words.includes(w)) words.push(w)
      }
    }
    if (words.length) anyWords = true
    const direction: Direction = p.d2q && p.q2d ? 'both' : p.d2q ? 'd2q' : 'q2d'
    bridges.push({ label: makeLabel(p), discord: p.discord, qq: p.qq, direction, enabled: true, atAll: false, blockWords: words.join(';;') })
  }

  if (anyWords) {
    notes.push('屏蔽词的规则变了：旧插件区分大小写、只查正文、只对那个来源生效；新插件不区分大小写、查完整的文字（包括 embed）、对这个桥的两个方向都生效。')
  }
  const hidden = usedTargets.filter(c => c.hidePrefix).map(c => `「${c.key}」`)
  if (hidden.length) {
    notes.push(`这些目标在旧插件里设了 hidePrefix（不加前缀）：${hidden.join('、')}。新插件没有这个选项，转发的消息会带前缀。`)
  }
  const bot = discordTargets.filter(c => !c.simulateOriginal).map(c => `「${c.key}」`)
  if (bot.length) {
    notes.push(`这些 Discord 目标在旧插件里没开 simulateOriginal（由机器人自己发）：${bot.join('、')}。新插件默认用 webhook 显示 QQ 发送者的名字和头像；想和以前一样，就关掉 discordAsWebhook。`)
  }
  const extra = isDict(cfg.delay) && Object.keys(cfg.delay).length ? '、delay' : ''
  notes.push(`没有导入：simulateOriginal、hidePrefix${extra}（新插件没有对应的设置）。atAll 全部为 false。`)

  return { bridges, skipped, notes }
}

export function formatReport(results: Array<{ path: string; disabled: boolean; hasIf: boolean; result: ImportResult }>): string {
  if (!results.length) return '没有找到 @myrtus/forward 的配置。'
  const out: string[] = []
  for (const { path, disabled, hasIf, result } of results) {
    const n = (d: Direction) => result.bridges.filter(b => b.direction === d).length
    out.push(`== ${path} ==`)
    if (disabled) out.push('旧插件目前是停用状态（照样导入）。')
    if (hasIf) out.push('旧插件（或它所在的分组）设了 $if 条件，只在条件成立时运行；导入时没有考虑这个条件。')
    out.push(`生成了 ${result.bridges.length} 个桥：双向 ${n('both')} 个，Discord → QQ ${n('d2q')} 个，QQ → Discord ${n('q2d')} 个。`)
    if (result.skipped.length) {
      out.push(`跳过了 ${result.skipped.length} 项：`)
      for (const s of result.skipped) out.push(`- ${s.what}：${s.reason}`)
    } else {
      out.push('没有跳过任何项。')
    }
    if (result.notes.length) {
      out.push('注意：')
      for (const s of result.notes) out.push(`- ${s}`)
    }
    out.push('')
  }
  return out.join('\n').trimEnd()
}

// 所有字符串都加引号，ID 不会被 YAML 读成数字
export function bridgesToYaml(bridges: BridgeRow[]): string {
  const rows = bridges.map(b => ({
    label: b.label,
    discord: String(b.discord),
    qq: String(b.qq),
    direction: b.direction,
    enabled: b.enabled,
    atAll: b.atAll,
    blockWords: b.blockWords,
  }))
  return yaml.dump({ bridges: rows }, { forceQuotes: true, lineWidth: -1, noRefs: true })
}
