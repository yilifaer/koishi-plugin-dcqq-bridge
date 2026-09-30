// 翻译请求（清单 §12.1 第 4、5、8 步）：OpenAI 兼容的 chat/completions，只发要翻译的文字和术语参考，
// 不传 temperature；校验译文，失败只返回原因（不重试，429/5xx 在超时内重试 1 次）。不记录请求和响应内容。

export interface TranslatorConfig {
  baseURL: string
  apiKey: string
  model: string
  timeoutMs: number
  maxPerHour: number
  /** 额外合并进请求体的字段（已解析好的对象，B7）；不能覆盖 model、messages。 */
  extraBody?: Record<string, unknown>
}

/** 同时进行的翻译请求最多几个（B4）；排队的仍受 timeoutMs 限制（从提交时算）。 */
export const MAX_CONCURRENT = 4

export type TranslateResult =
  | { ok: true; text: string; promptTokens?: number; completionTokens?: number }
  | { ok: false; reason: string }

export interface TranslateInput {
  text: string
  direction: 'en2zh' | 'zh2en'
  hints: string[]
  /** 文字里所有的 ⟦…⟧ 占位符。 */
  tokens: string[]
  /** 去掉占位符后的原文（长度、拒绝检查用）。 */
  sourceForChecks: string
}

const RULES = '只翻译 <text> 和 </text> 之间的内容。形如 ⟦0⟧、⟦G0⟧ 的占位符必须原样保留，不能改动、删除或增加。玩家和角色名、军团和联盟名及其简称、舰队制式名、语音频道名一律不翻译、不音译，原样保留。保留原文的换行。只输出译文，不要解释，不要加任何说明或标签。'
const SYSTEM: Record<TranslateInput['direction'], string> = {
  en2zh: `你是翻译引擎，把英文翻译成简体中文。${RULES}`,
  zh2en: `你是翻译引擎，把中文翻译成英文。${RULES}`,
}

// 只认针对翻译任务本身的拒绝，不用「抱歉」「I can't」这类普通说法
const REFUSALS = ['无法翻译', '作为AI', '作为一个AI', "I can't translate", 'I cannot translate', "I can't help with", 'As an AI']
// 原文里有这类说法时不做拒绝判断（B6）：「这个我帮不上忙」→「I can't help with this」是正常译文
const SOURCE_REFUSALS = ['帮不', '无法翻译', '不能翻译', '翻译不了', '作为AI', '作为一个AI', 'as an ai', "can't help", 'cannot help', "can't translate", 'cannot translate']

const ANY_TOKEN = /⟦[^⟦⟧\n]*⟧/g
const HAN = /\p{Script=Han}/gu
const LETTER = /(?!\p{Script=Han})\p{L}/gu
const HOUR = 3600_000

function normalizeForRefusal(text: string) {
  // 统一引号和空白，汉字旁边的空白去掉（「作为 AI」也算）
  return text.toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ')
    .replace(/\s+(?=\p{Script=Han})|(?<=\p{Script=Han})\s+/gu, '')
}

function phraseRes(list: string[]) {
  return list.map((phrase) => {
    const p = normalizeForRefusal(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 英文短语按整词匹配（「has an aim」不算「as an ai」）
    return new RegExp(`${/^[a-z]/.test(p) ? '\\b' : ''}${p}${/[a-z]$/.test(p) ? '\\b' : ''}`)
  })
}
const REFUSAL_RES = phraseRes(REFUSALS)
const SOURCE_REFUSAL_RES = phraseRes(SOURCE_REFUSALS)

function refused(translated: string, sources: string[]) {
  const src = sources.map((s) => normalizeForRefusal(s.replace(ANY_TOKEN, ' ')))
  if (SOURCE_REFUSAL_RES.some((re) => src.some((s) => re.test(s)))) return false
  const out = normalizeForRefusal(translated)
  return REFUSAL_RES.some((re) => re.test(out) && !src.some((s) => re.test(s)))
}

function charCount(text: string) {
  return Array.from(text.replace(ANY_TOKEN, '').trim()).length
}

function lengthOk(translated: string, source: string, direction: TranslateInput['direction']) {
  if (direction === 'zh2en' && (source.match(HAN)?.length ?? 0) < 10) return true
  if (direction === 'en2zh' && (source.match(LETTER)?.length ?? 0) < 20) return true
  const ratio = charCount(translated) / Math.max(1, charCount(source))
  return direction === 'zh2en' ? ratio >= 0.8 && ratio <= 10 : ratio >= 0.1 && ratio <= 1.5
}

/** 每个占位符出现的次数和原文一样，没有多出来的或残缺的。 */
function placeholdersMatch(source: string, translated: string, known: string[]) {
  const count = (text: string) => {
    const map = new Map<string, number>()
    for (const m of text.match(ANY_TOKEN) ?? []) map.set(m, (map.get(m) ?? 0) + 1)
    return map
  }
  const a = count(source)
  const b = count(translated)
  const set = new Set([...known, ...a.keys()])
  for (const key of b.keys()) if (!set.has(key)) return false
  for (const key of set) if ((a.get(key) ?? 0) !== (b.get(key) ?? 0)) return false
  return !/[⟦⟧]/.test(translated.replace(ANY_TOKEN, ''))
}

function unwrap(text: string) {
  return text.trim().replace(/^<text>\s*/i, '').replace(/\s*<\/text>$/i, '').trim()
}

function parseData(data: unknown): any {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }
  if (data instanceof ArrayBuffer) return parseData(Buffer.from(data).toString('utf8'))
  return data
}

function retryAfterMs(headers: any) {
  const value = Number(headers?.get?.('retry-after'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0
}

type Attempt =
  | { kind: 'ok'; data: any }
  | { kind: 'retry'; reason: string; waitMs: number }
  | { kind: 'fail'; reason: string }

export class Translator {
  private sent: number[] = []
  private active = 0
  private waiters: Array<() => void> = []
  private counters = { requests: 0, failures: {} as Record<string, number>, promptTokens: 0, completionTokens: 0 }

  constructor(private http: any, private getConfig: () => TranslatorConfig, private now: () => number = Date.now) {}

  stats() {
    return { ...this.counters, failures: { ...this.counters.failures } }
  }

  private fail(reason: string): TranslateResult {
    this.counters.failures[reason] = (this.counters.failures[reason] ?? 0) + 1
    return { ok: false, reason }
  }

  /** 滚动一小时内的请求数是否已到上限；没到就记上这一次。 */
  private takeQuota(max: number) {
    const now = this.now()
    this.sent = this.sent.filter((t) => t > now - HOUR)
    if (max > 0 && this.sent.length >= max) return false
    this.sent.push(now)
    return true
  }

  /** 占一个并发名额；到 deadline 还没轮到就返回 false（不发请求）。 */
  private acquire(deadline: number): Promise<boolean> {
    if (this.active < MAX_CONCURRENT) {
      this.active++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.active++
        resolve(true)
      }
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve(false)
      }, Math.max(0, deadline - Date.now()))
      this.waiters.push(wake)
    })
  }

  private release() {
    this.active--
    this.waiters.shift()?.()
  }

  /** 正在进行和排队的请求数（测试、状态用）。 */
  load() {
    return { active: this.active, queued: this.waiters.length }
  }

  private async attempt(url: string, headers: Record<string, string>, body: any, timeout: number): Promise<Attempt> {
    try {
      const data = await this.http.post(url, body, { headers, timeout })
      return { kind: 'ok', data }
    } catch (e: any) {
      const status = e?.response?.status
      if (typeof status === 'number') {
        const reason = `HTTP ${status}`
        if (status === 429 || status >= 500) return { kind: 'retry', reason, waitMs: retryAfterMs(e.response.headers) }
        return { kind: 'fail', reason }
      }
      if (e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError') return { kind: 'fail', reason: '超时' }
      return { kind: 'fail', reason: '网络错误' }
    }
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const config = this.getConfig()
    const timeoutMs = Math.max(1, Number(config.timeoutMs) || 6000)
    // 超时从提交时算：排队等不到名额的直接按超时，不发请求
    const deadline = Date.now() + timeoutMs
    if (!await this.acquire(deadline)) return this.fail('超时')
    try {
      return await this.send(input, config, deadline)
    } finally {
      this.release()
    }
  }

  private async send(input: TranslateInput, config: TranslatorConfig, deadline: number): Promise<TranslateResult> {
    const left0 = deadline - Date.now()
    if (left0 <= 0) return this.fail('超时')
    if (!this.takeQuota(Math.max(0, Number(config.maxPerHour) || 0))) return this.fail('超过每小时上限')
    this.counters.requests++

    const url = `${String(config.baseURL).trim().replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const hints = input.hints.slice(0, 30)
    const user = (hints.length ? `术语参考：\n${hints.join('\n')}\n\n` : '') + `<text>${input.text}</text>`
    const body = {
      ...(config.extraBody ?? {}),
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM[input.direction] },
        { role: 'user', content: user },
      ],
    }

    let result = await this.attempt(url, headers, body, left0)
    if (result.kind === 'retry') {
      const waitMs = result.waitMs
      const left = deadline - Date.now() - waitMs
      if (left > 0) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs))
        result = await this.attempt(url, headers, body, left)
      }
    }
    if (result.kind !== 'ok') return this.fail(result.reason)

    const data = parseData(result.data)
    const promptTokens = Number(data?.usage?.prompt_tokens)
    const completionTokens = Number(data?.usage?.completion_tokens)
    const usage: { promptTokens?: number; completionTokens?: number } = {}
    if (Number.isFinite(promptTokens)) this.counters.promptTokens += usage.promptTokens = promptTokens
    if (Number.isFinite(completionTokens)) this.counters.completionTokens += usage.completionTokens = completionTokens

    const content = data?.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? unwrap(content) : ''
    if (!text) return this.fail('空结果')
    if (!placeholdersMatch(input.text, text, input.tokens)) return this.fail('占位符不符')
    if (!lengthOk(text, input.sourceForChecks, input.direction)) return this.fail('长度异常')
    if (refused(text, [input.sourceForChecks, input.text])) return this.fail('拒绝翻译')
    return { ok: true, text, ...usage }
  }
}
