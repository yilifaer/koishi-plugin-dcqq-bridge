import { createHash } from 'node:crypto'
import { DIRS, MODES } from './types'
import type {
  Direction, EveEntry, GlossaryApplication, GlossaryDir, GlossaryMode, GlossaryOptions, GlossarySources, SystemStyle,
} from './types'
import { structureTypeNames } from './load'

// 术语匹配（清单 §12.3，决定 P2）。
// 索引：每个方向一张表，键是来源词的前 2 个字符（ASCII 小写），值是按长度从长到短排好的候选。
// apply() 每个位置只查一次表，不对整段文字逐条跑正则；1.3 万条官方词条也够快。

const MAX_HINTS = 30
const MIN_LENGTH = 2
const TOKEN_RE = /⟦[^⟦⟧]*⟧/g
// 代号星系、虫洞星系只靠翻译前的占位符保护（清单 §12.1），不进术语表
const CODE_NAME_RE = /^(?:[A-Z0-9]{1,5}-[A-Z0-9]{1,5}|J\d{6})$/

// 优先级：overrides → 黑话表 → 物品 → 组别 → 类别 → 星系、星域、星座（数字越小越优先）
const PRIORITY = { override: 0, slang: 1, type: 2, group: 3, category: 4, system: 5, region: 5, constellation: 5 } as const
const PLACE_KINDS = new Set<EveEntry['kind']>(['system', 'region', 'constellation'])
const KIND_ORDER: EveEntry['kind'][] = ['type', 'group', 'category', 'system', 'region', 'constellation']

interface Candidate {
  /** 来源侧写法（原样） */
  term: string
  /** 来源侧写法（ASCII 小写） */
  lower: string
  mode: GlossaryMode
  /** force 时换成的文字 */
  value: string
  /** hint 行 `EN => 中文` */
  hint: string
  priority: number
  /** 3 个字母以内：大小写必须完全一致（P2） */
  exact: boolean
  /** 英文来源：允许末尾多一个 s */
  plural: boolean
  /** 常用英语单词：只在首字母大写、不在句首时匹配 */
  common: boolean
  /** 尾字符是字母或数字时，才需要检查右边界（左边界见 apply 里的跳过） */
  edgeR: boolean
}

type Index = Map<string, Candidate[]>

const isAlnum = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
const isUpper = (code: number) => code >= 65 && code <= 90
const isLetter = (ch: string) => /[A-Za-z]/.test(ch)
// 只转换 ASCII，保证长度不变，下标和原文一一对应
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())
const letterCount = (s: string) => { let n = 0; for (const ch of s) if (isLetter(ch)) n++; return n }
const charLength = (s: string) => [...s].length
const SENTENCE_END = new Set(['.', '!', '?', '。', '！', '？', '…', '\n', '\r'])

function atSentenceStart(text: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '　')) j--
  return j < 0 || SENTENCE_END.has(text[j])
}

function placeValue(en: string, zh: string, style: SystemStyle): string {
  if (style === 'en' || en === zh) return en
  if (style === 'zh') return zh
  return `${en}(${zh})`
}

export class Glossary {
  readonly version: string
  readonly size: number
  /** 去掉「级」的舰船名写法加了多少条（U4，给日志和测试用） */
  readonly shipAliases: number
  private readonly indexes: Record<Direction, Index>
  private readonly structures: readonly string[]

  /** 内部使用；请用 buildGlossary() */
  constructor(indexes: Record<Direction, Index>, size: number, version: string, structures: readonly string[] = [], shipAliases = 0) {
    this.indexes = indexes
    this.size = size
    this.version = version
    this.structures = structures
    this.shipAliases = shipAliases
  }

  /**
   * 官方表里建筑类（SDE 类别 65）物品的英文名（U6）：Astrahus、Fortizar、Keepstar、Ansiblex Jump Bridge 等，
   * 按长度从长到短。没有加载官方表（`glossary.eve` 关闭）时是空列表。
   */
  structureTypeNames(): string[] {
    return [...this.structures]
  }

  /** 整段文字正好是某个词条的原文（U7：群友名片里和术语相同的一段不当作名字）。 */
  hasSource(text: string, direction: Direction): boolean {
    const lower = asciiLower(text)
    const list = this.indexes[direction].get(lower.slice(0, 2)) ?? []
    return list.some((c) => (c.exact ? c.term === text : c.lower === lower))
  }

  apply(text: string, direction: Direction): GlossaryApplication {
    const index = this.indexes[direction]
    const n = text.length
    if (!index.size || n < MIN_LENGTH) return { text, tokens: [], hints: [] }
    const lower = asciiLower(text)

    // 已有的占位符（⟦0⟧ 等）内部和跨越它们的位置都不匹配
    let blocked: Uint8Array | null = null
    if (text.includes('⟦')) {
      blocked = new Uint8Array(n)
      for (const m of text.matchAll(TOKEN_RE)) blocked.fill(1, m.index!, m.index! + m[0].length)
    }

    // 每个位置找最长的可用候选
    const found: Array<{ start: number; end: number; cand: Candidate }> = []
    for (let i = 0; i < n - 1; i++) {
      if (blocked && blocked[i]) continue
      const code = text.charCodeAt(i)
      // 词中间（前一个字符也是字母数字）不可能是任何词条的开头
      if (i > 0 && isAlnum(code) && isAlnum(text.charCodeAt(i - 1))) continue
      const list = index.get(lower.slice(i, i + 2))
      if (!list) continue
      for (const cand of list) {
        const end = this.matchAt(text, lower, i, cand, blocked)
        if (end > 0) {
          found.push({ start: i, end, cand })
          break
        }
      }
    }
    if (!found.length) return { text, tokens: [], hints: [] }

    // 最长优先、互不重叠；一样长时靠前的优先
    found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    const taken = new Uint8Array(n)
    const chosen: typeof found = []
    for (const m of found) {
      let free = true
      for (let k = m.start; k < m.end; k++) if (taken[k]) { free = false; break }
      if (!free) continue
      taken.fill(1, m.start, m.end)
      chosen.push(m)
    }
    chosen.sort((a, b) => a.start - b.start)

    const tokens: GlossaryApplication['tokens'] = []
    const hints: string[] = []
    const seen = new Set<string>()
    let out = ''
    let last = 0
    for (const { start, end, cand } of chosen) {
      if (cand.mode === 'hint') {
        if (!seen.has(cand.hint) && hints.length < MAX_HINTS) {
          seen.add(cand.hint)
          hints.push(cand.hint)
        }
        continue
      }
      const token = `⟦G${tokens.length}⟧`
      // keep 也还原成标准写法；英文标准写法且原文带复数 s 时补回 s（审查 B1）
      let value = cand.value
      if (cand.mode === 'keep' && end - start > cand.term.length && /[A-Za-z]$/.test(value)) value += 's'
      tokens.push({ token, value })
      out += text.slice(last, start) + token
      last = end
    }
    out += text.slice(last)
    return { text: out, tokens, hints }
  }

  /** 候选在位置 i 能匹配时返回结束位置，否则返回 -1 */
  private matchAt(text: string, lower: string, i: number, cand: Candidate, blocked: Uint8Array | null): number {
    const len = cand.term.length
    if (i + len > text.length) return -1
    if (cand.exact ? !text.startsWith(cand.term, i) : !lower.startsWith(cand.lower, i)) return -1
    // 左边界：候选首字符是字母数字时，i 已保证前一个字符不是字母数字（见 apply 里的跳过）
    if (cand.common && (!isUpper(text.charCodeAt(i)) || atSentenceStart(text, i))) return -1
    let end = i + len
    const boundaryAt = (pos: number) => pos >= text.length || !isAlnum(text.charCodeAt(pos))
    if (cand.plural && end < text.length) {
      const ch = text[end]
      if ((ch === 's' || (!cand.exact && ch === 'S')) && boundaryAt(end + 1)) end += 1
      else if (!boundaryAt(end)) return -1
    } else if (cand.edgeR && !boundaryAt(end)) return -1
    if (blocked) for (let k = i; k < end; k++) if (blocked[k]) return -1
    return end
  }
}

interface RawTerm {
  source: string
  mode: GlossaryMode
  value: string
  hint: string
  priority: number
  english: boolean
  common?: boolean
}

function makeCandidate(t: RawTerm): Candidate {
  const exact = letterCount(t.source) <= 3
  const last = t.source[t.source.length - 1]
  return {
    term: t.source,
    lower: asciiLower(t.source),
    mode: t.mode,
    value: t.value,
    hint: t.hint,
    priority: t.priority,
    exact,
    plural: t.english && isLetter(last),
    common: !!t.common,
    edgeR: isAlnum(t.source.charCodeAt(t.source.length - 1)),
  }
}

/** overrides、黑话表、纠错词条共用的检查：有问题返回原因（不带「已跳过」），没问题返回 null。 */
export function userTermProblem(raw: { en?: unknown; zh?: unknown; mode?: unknown; dir?: unknown }): string | null {
  const en = typeof raw.en === 'string' ? raw.en.trim() : ''
  const zh = typeof raw.zh === 'string' ? raw.zh.trim() : ''
  if (!en || !zh) return '缺少 en 或 zh'
  if (!MODES.includes(raw.mode as GlossaryMode)) return `mode 无效（${String(raw.mode)}）`
  if (!DIRS.includes(raw.dir as GlossaryDir)) return `dir 无效（${String(raw.dir)}）`
  if (charLength(en) < MIN_LENGTH || charLength(zh) < MIN_LENGTH) return `en 或 zh 少于 ${MIN_LENGTH} 个字`
  return null
}

/**
 * 来源写法的匹配限制（和 buildGlossary 里的规则一致，给纠错命令的提醒用）：
 * exact = 3 个字母以内，只匹配大小写完全一致的写法；common = 常用英语单词。
 */
export function sourceTraits(source: string, commonWords: Set<string>): { exact: boolean; common: boolean } {
  return { exact: letterCount(source) <= 3, common: commonWords.has(source.trim().toLowerCase()) }
}

export function buildGlossary(options: GlossaryOptions, sources: GlossarySources): { glossary: Glossary; warnings: string[] } {
  const warnings: string[] = []
  const terms: Record<Direction, RawTerm[]> = { en2zh: [], zh2en: [] }
  let size = 0
  let shipAliases = 0

  // overrides 和黑话表：保持声明的 mode（只受 P2 大小写限制）
  const addUser = (
    raw: { en?: unknown; zh?: unknown; mode?: unknown; dir?: unknown; en_aliases?: unknown; zh_aliases?: unknown },
    where: string, priority: number,
  ) => {
    const en = typeof raw.en === 'string' ? raw.en.trim() : ''
    const zh = typeof raw.zh === 'string' ? raw.zh.trim() : ''
    const label = en ? `${where}（${en}）` : where
    const problem = userTermProblem(raw)
    if (problem) return void warnings.push(`${label}：${problem}，已跳过`)
    const mode = raw.mode as GlossaryMode
    const dir = raw.dir as GlossaryDir
    const hint = `${en} => ${zh}`
    const aliases = (value: unknown, field: string) => {
      const out: string[] = []
      if (!Array.isArray(value)) return out
      for (const a of value) {
        const alias = typeof a === 'string' ? a.trim() : ''
        if (!alias) continue
        if (charLength(alias) < MIN_LENGTH) warnings.push(`${label}：${field} 里的「${alias}」少于 ${MIN_LENGTH} 个字，已丢弃`)
        else out.push(alias)
      }
      return out
    }
    const enSources = [...new Set([en, ...aliases(raw.en_aliases, 'en_aliases')])]
    const zhSources = [...new Set([zh, ...aliases(raw.zh_aliases, 'zh_aliases')])]
    if (dir !== 'zh2en') {
      for (const source of enSources) terms.en2zh.push({ source, mode, value: zh, hint, priority, english: true })
    }
    if (dir !== 'en2zh') {
      for (const source of zhSources) terms.zh2en.push({ source, mode, value: en, hint, priority, english: false })
    }
    size++
  }

  ;(options.overrides ?? []).forEach((o, i) => addUser(o ?? {}, `术语覆盖第 ${i + 1} 条`, PRIORITY.override))
  // 纠错命令的词条和 overrides 同级，排在后面：同一个原文以控制台为准（去重时留先加入的）
  ;(sources.fixes ?? []).forEach((s) => addUser(s ?? {}, '纠错词条', PRIORITY.override))
  ;(sources.slang ?? []).forEach((s, i) => addUser(s ?? {}, sources.slangWhere?.[i] ?? `黑话表第 ${i + 1} 条`, PRIORITY.slang))

  // 官方名称表：默认 force，按规则降级成 hint
  const eve = options.eve ? sources.eveData : null
  if (eve && Array.isArray(eve.entries)) {
    const official = eve.entries.filter((e) => e && typeof e.en === 'string' && typeof e.zh === 'string'
      && !CODE_NAME_RE.test(e.en.trim()))
    // 一个中文对应多个英文的，不用于中译英
    const zhToEn = new Map<string, Set<string>>()
    // 已有的中译英来源写法（overrides、纠错、黑话表，含 zh_aliases）：去掉「级」的船名和它们重复时不加（U4）
    const userZh = new Set(terms.zh2en.map((t) => asciiLower(t.source)))
    for (const e of official) {
      const zh = e.zh.trim()
      if (!zhToEn.has(zh)) zhToEn.set(zh, new Set())
      zhToEn.get(zh)!.add(e.en.trim().toLowerCase())
    }
    const ordered = KIND_ORDER.flatMap((kind) => official.filter((e) => e.kind === kind))
    for (const e of ordered) {
      const en = e.en.trim()
      const zh = e.zh.trim()
      if (!en || !zh) continue
      const priority = PRIORITY[e.kind]
      const place = PLACE_KINDS.has(e.kind)
      const hint = `${en} => ${zh}`
      let used = false
      if (charLength(en) >= MIN_LENGTH) {
        // 地名：每个词都是常用词、或以 The 开头，也按常用词处理（审查 B2）
        const common = place
          ? /^the\s/i.test(en) || en.toLowerCase().split(/[\s-]+/).every((w) => sources.commonWords.has(w))
          : sources.commonWords.has(en.toLowerCase())
        const mode: GlossaryMode = common || letterCount(en) <= 3 ? 'hint' : 'force'
        const value = place ? placeValue(en, zh, options.systemStyle) : zh
        terms.en2zh.push({ source: en, mode, value, hint, priority, english: true, common })
        used = true
      }
      // 1 个字的中文不收；2 个字的组别、类别名多是普通词（其他、建筑、工具），也不收，连 hint 都不要（U5）
      const plainWord = (e.kind === 'group' || e.kind === 'category') && charLength(zh) === 2
      if (charLength(zh) >= MIN_LENGTH && !plainWord && zhToEn.get(zh)!.size === 1) {
        const short = charLength(zh) < 3 && !zh.endsWith('级')
        const mode: GlossaryMode = place || short ? 'hint' : 'force'
        terms.zh2en.push({ source: zh, mode, value: en, hint, priority, english: false })
        used = true
        // 舰船名玩家一般不带「级」（U4）：去掉以后 3 个字及以上才加，模式和原词条一样；
        // 2 个字的（灾难、挑战）多是普通词，交给黑话表人工挑选；和别的官方名称、用户词条重复时不加（用户词条优先）
        if (e.kind === 'type' && e.cat === 'ship' && zh.endsWith('级')) {
          const bare = zh.slice(0, -1).trim()
          if (charLength(bare) >= 3 && !zhToEn.has(bare) && !userZh.has(asciiLower(bare))) {
            terms.zh2en.push({ source: bare, mode, value: en, hint, priority, english: false })
            shipAliases++
          }
        }
      }
      if (used) size++
    }
  }

  const hash = createHash('sha1')
  const indexes = {} as Record<Direction, Index>
  for (const direction of ['en2zh', 'zh2en'] as Direction[]) {
    const index: Index = new Map()
    const dedupe = new Set<string>()
    hash.update(`\n#${direction}\n`)
    for (const t of terms[direction]) {
      const cand = makeCandidate(t)
      // 同一来源写法、同样的限制：只留优先级最高（最先加入）的那条
      const key = `${cand.exact ? cand.term : cand.lower}\u0000${cand.common}`
      if (dedupe.has(key)) continue
      dedupe.add(key)
      hash.update(`${cand.term}\u0001${cand.mode}\u0001${cand.value}\u0001${cand.hint}\u0001${cand.priority}\u0001${cand.common}\n`)
      const k = cand.lower.slice(0, 2)
      let list = index.get(k)
      if (!list) index.set(k, list = [])
      list.push(cand)
    }
    for (const list of index.values()) list.sort((a, b) => b.term.length - a.term.length || a.priority - b.priority)
    indexes[direction] = index
  }

  // 建筑类型名只用于保护（U6），不参与匹配；和官方名称表一样，只在 glossary.eve 打开时有
  const structures = structureTypeNames(eve)
  return { glossary: new Glossary(indexes, size, hash.digest('hex'), structures, shipAliases), warnings }
}
