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

function hostname(url: string) {
  try {
    return new URL(String(url).trim()).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 审核用哪个 key：填了审核 key 就用它；没填时只有翻译和审核接口的主机名相同才借用翻译 key；
 * 否则 null（绝不能把别家的 key 发给 OpenAI）。
 */
export function resolveModerationKey(translateBaseURL: string, translateKey: string, moderationBaseURL: string, moderationKey: string): string | null {
  const own = String(moderationKey ?? '').trim()
  if (own) return own
  const borrowed = String(translateKey ?? '').trim()
  if (!borrowed) return null
  const a = hostname(translateBaseURL)
  const b = hostname(moderationBaseURL)
  return a && b && a === b ? borrowed : null
}

export type ModerationResult = { ok: true; flagged: boolean } | { ok: false; reason: string }

export class Moderator {
  constructor(private http: any, private getConfig: () => { baseURL: string; apiKey: string | null }) {}

  async check(text: string): Promise<ModerationResult> {
    const { baseURL, apiKey } = this.getConfig()
    if (!apiKey) return { ok: false, reason: '审核未配置密钥' }
    const url = `${String(baseURL).trim().replace(/\/+$/, '')}/moderations`
    try {
      const data = await this.http.post(url, { model: 'omni-moderation-latest', input: text }, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 3000,
      })
      const flagged = data?.results?.[0]?.flagged
      if (typeof flagged !== 'boolean') return { ok: false, reason: '审核结果无效' }
      return { ok: true, flagged }
    } catch (e: any) {
      const status = e?.response?.status
      if (typeof status === 'number') return { ok: false, reason: `审核 HTTP ${status}` }
      if (e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError') return { ok: false, reason: '审核超时' }
      return { ok: false, reason: '审核网络错误' }
    }
  }
}
