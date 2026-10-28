// 过滤（清单 §12.2）：关键词表（原文命中不翻译、译文命中丢掉译文）和 OpenAI 审核接口（只查译文）。
// 过滤只决定附不附译文，不影响原文转发。不记录被检查的文字和密钥。

/** 一行一个，去掉首尾空白，跳过空行和 # 开头的注释。 */
export function parseKeywordLines(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

export class KeywordFilter {
  private constructor(private words: string[], private patterns: RegExp[]) {}

  /** 're:' 开头的按正则（不区分大小写），其余按不区分大小写的包含匹配；写错的正则跳过并返回错误。 */
  static compile(lines: string[]): { filter: KeywordFilter; errors: string[] } {
    const words: string[] = []
    const patterns: RegExp[] = []
    const errors: string[] = []
    for (const raw of lines) {
      const line = String(raw ?? '').trim()
      if (!line) continue
      if (line.startsWith('re:')) {
        const source = line.slice(3)
        if (!source) {
          errors.push('空的正则 re:')
          continue
        }
        try {
          patterns.push(new RegExp(source, 'i'))
        } catch {
          errors.push(`正则写错，已跳过：${line}`)
        }
      } else {
        words.push(line.toLowerCase())
      }
    }
    return { filter: new KeywordFilter([...new Set(words)], patterns), errors }
  }

  get size() {
    return this.words.length + this.patterns.length
  }

  matches(text: string): boolean {
    if (!text) return false
    const lower = text.toLowerCase()
    return this.words.some((w) => lower.includes(w)) || this.patterns.some((re) => re.test(text))
  }
}

/** origin（小写、去默认端口）+ 去掉末尾斜杠的路径；不是 http(s) 网址时 null。 */
function endpoint(url: string) {
  try {
    const u = new URL(String(url).trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/**
 * 审核用哪个 key：填了审核 key 就用它；没填时只有翻译和审核接口的 origin（协议、主机、端口）和路径都相同才借用翻译 key（B8）；
 * 否则 null（绝不能把别家的 key 发给 OpenAI）。
 */
export function resolveModerationKey(translateBaseURL: string, translateKey: string, moderationBaseURL: string, moderationKey: string): string | null {
  const own = String(moderationKey ?? '').trim()
  if (own) return own
  const borrowed = String(translateKey ?? '').trim()
  if (!borrowed) return null
  const a = endpoint(translateBaseURL)
  const b = endpoint(moderationBaseURL)
  return a && b && a === b ? borrowed : null
}

/** 审核里被标记、并且算数的一个类别（V4）：分数没有时为 undefined。 */
export interface ModerationHit {
  category: string
  score?: number
}

export type ModerationResult = { ok: true; flagged: boolean; hits?: ModerationHit[] } | { ok: false; reason: string }

/** 审核的判断规则（V4）：忽略的类别（按前缀）、各类别需要达到的最低分数（类别名要完全相同）。都为空时看审核结果里总的 flagged。 */
export interface ModerationRules {
  ignore?: readonly string[]
  minScore?: Readonly<Record<string, number>>
}

/** 类别是不是在忽略列表里：按前缀匹配，写 `illicit` 同时忽略 `illicit/violent`，写 `violence` 同时忽略 `violence/graphic`。 */
export function categoryIgnored(category: string, ignore: readonly string[] = []): boolean {
  const name = category.toLowerCase()
  return ignore.some((prefix) => !!prefix && name.startsWith(prefix.toLowerCase()))
}

/** 一条审核结果里被标记的类别带分数，用来写日志（不含文字）：`violence 0.31、harassment 0.55`。 */
export function describeHits(hits: readonly ModerationHit[]): string {
  return hits.map((h) => (typeof h.score === 'number' ? `${h.category} ${h.score.toFixed(2)}` : h.category)).join('、')
}

export class Moderator {
  constructor(private http: any, private getConfig: () => { baseURL: string; apiKey: string | null } & ModerationRules) {}

  async check(text: string): Promise<ModerationResult> {
    const { baseURL, apiKey, ignore = [], minScore = {} } = this.getConfig()
    if (!apiKey) return { ok: false, reason: '审核未配置密钥' }
    const url = `${String(baseURL).trim().replace(/\/+$/, '')}/moderations`
    try {
      const data = await this.http.post(url, { model: 'omni-moderation-latest', input: text }, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 3000,
      })
      const result = data?.results?.[0]
      const flagged = result?.flagged
      if (typeof flagged !== 'boolean') return { ok: false, reason: '审核结果无效' }
      const categories = result.categories && typeof result.categories === 'object' ? result.categories as Record<string, unknown> : null
      const scores = result.category_scores && typeof result.category_scores === 'object' ? result.category_scores as Record<string, unknown> : {}
      const score = (category: string) => (typeof scores[category] === 'number' ? scores[category] as number : undefined)
      // 被标记的类别（categories 里为 true 的），带分数
      const marked: ModerationHit[] = categories ? Object.keys(categories).filter((c) => categories[c] === true).map((category) => ({ category, score: score(category) })) : []
      // 没配忽略和分数门槛，或者结果里没有类别（看不出是哪一类）：和原来一样看总的 flagged
      if (!categories || (!ignore.length && !Object.keys(minScore).length)) return marked.length ? { ok: true, flagged, hits: marked } : { ok: true, flagged }
      // 配了：只看不在忽略列表里的类别；写了最低分数的类别，分数要达到才算（分数缺失时按命中算）
      const hits = marked.filter((h) => {
        if (categoryIgnored(h.category, ignore)) return false
        const key = h.category.toLowerCase()
        const min = Object.hasOwn(minScore, key) ? minScore[key] : undefined
        return min === undefined || h.score === undefined || h.score >= min
      })
      return hits.length ? { ok: true, flagged: true, hits } : { ok: true, flagged: false }
    } catch (e: any) {
      const status = e?.response?.status
      if (typeof status === 'number') return { ok: false, reason: `审核 HTTP ${status}` }
      if (e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError') return { ok: false, reason: '审核超时' }
      return { ok: false, reason: '审核网络错误' }
    }
  }
}
