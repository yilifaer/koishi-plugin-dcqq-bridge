// 把翻译的各步串起来（清单 §12.1）：关键词查原文 → 保护 → 术语表 → 跳过判断 → 缓存 → 请求 → 还原 → 关键词查译文 → 审核。
// 任何一步不通过都只发原文；这里只决定附不附译文，不影响原文的转发。

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from 'koishi'
import type { Settings } from '../bridges'
import { KeywordFilter, Moderator, parseKeywordLines, resolveModerationKey } from '../filter'
import { buildGlossary, Glossary, loadCommonWords, loadEveData, parseSlangYaml } from '../glossary'
import type { Msg } from '../types'
import { Translator } from './client'
import { protect, restore, stripTokens } from './protect'
import { isCommand, skipReason } from './skip'

export type TranslateDirection = 'en2zh' | 'zh2en'

export type TranslationOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string; skipped: boolean }

const CACHE_SIZE = 1000
const CACHE_TTL = 24 * 3600 * 1000

export class TranslationService {
  glossary: Glossary | null = null
  keywords: KeywordFilter | null = null
  /** 读取关键词、术语表时的问题（给 bridge.status 显示）。 */
  problems: string[] = []
  /** 各种原因的计数（跳过和失败都算）。 */
  outcomes = new Map<string, number>()
  translator: Translator
  moderator: Moderator
  private cache = new Map<string, { text: string; at: number }>()
  private markReady: () => void = () => {}
  private ready: Promise<void> = new Promise((resolve) => (this.markReady = resolve))
  private warnedHourCap = 0

  constructor(
    private ctx: Context,
    private getSettings: () => Settings,
    private logger: { warn(...args: any[]): void; info(...args: any[]): void },
    private now: () => number = Date.now,
  ) {
    this.translator = new Translator(ctx.http, () => {
      const t = this.getSettings().translate
      return { baseURL: t.baseURL, apiKey: t.apiKey, model: t.model, timeoutMs: t.timeoutMs, maxPerHour: t.maxPerHour }
    }, now)
    this.moderator = new Moderator(ctx.http, () => {
      const s = this.getSettings()
      return {
        baseURL: s.filter.moderationBaseURL,
        apiKey: resolveModerationKey(s.translate.baseURL, s.translate.apiKey, s.filter.moderationBaseURL, s.filter.moderationApiKey),
      }
    })
  }

  /** 审核打开却没有可用的 key（清单 §4.5）。 */
  moderationKeyMissing() {
    const s = this.getSettings()
    return s.filter.moderation && !resolveModerationKey(s.translate.baseURL, s.translate.apiKey, s.filter.moderationBaseURL, s.filter.moderationApiKey)
  }

  private path(file: string) {
    return resolve(this.ctx.baseDir ?? process.cwd(), file)
  }

  /** 读取关键词和术语表（启动时和 bridge.reload 时）。出错只记下来，不影响转发。 */
  async reload() {
    const s = this.getSettings()
    const problems: string[] = []
    // 关键词
    const lines = parseKeywordLines(s.filter.keywords)
    if (s.filter.keywordFile) {
      try {
        lines.push(...parseKeywordLines(await readFile(this.path(s.filter.keywordFile), 'utf8')))
      } catch (e: any) {
        problems.push(`关键词文件读不到：${s.filter.keywordFile}（${e?.code ?? '读取失败'}）`)
      }
    }
    const { filter } = KeywordFilter.compile(lines)
    // 只写第几条，不把关键词本身显示出来（状态可能在群里查看）
    lines.forEach((line, i) => {
      if (KeywordFilter.compile([line]).errors.length) problems.push(`关键词第 ${i + 1} 条写错，已跳过`)
    })
    this.keywords = filter
    if (s.translate.enabled && !filter.size) {
      problems.push('翻译已打开，但关键词表是空的（建议按服务商的要求设置关键词过滤）')
    }
    if (this.moderationKeyMissing()) problems.push('审核未配置密钥，译文全部不附')
    // 术语表
    let slang = null
    if (s.glossary.slangFile) {
      try {
        const parsed = parseSlangYaml(await readFile(this.path(s.glossary.slangFile), 'utf8'))
        slang = parsed.entries
        problems.push(...parsed.warnings.map((w) => `黑话表：${w}`))
      } catch (e: any) {
        problems.push(`黑话表文件读不到：${s.glossary.slangFile}（${e?.code ?? '读取失败'}）`)
      }
    }
    let eveData = null
    if (s.glossary.eve) {
      eveData = loadEveData()
      if (!eveData) problems.push('插件自带的 EVE 名称表读不到')
    }
    try {
      const built = buildGlossary(
        { eve: s.glossary.eve, systemStyle: s.glossary.systemStyle, overrides: s.glossary.overrides },
        { eveData, slang, commonWords: loadCommonWords() },
      )
      this.glossary = built.glossary
      problems.push(...built.warnings.map((w) => `术语表：${w}`))
    } catch (e: any) {
      this.glossary = null
      problems.push(`术语表加载失败：${e?.message ?? e}`)
    }
    this.problems = problems
    this.cache.clear()
    this.markReady()
    for (const problem of problems.slice(0, 20)) this.logger.warn(problem)
    if (problems.length > 20) this.logger.warn(`还有 ${problems.length - 20} 条术语表/关键词问题没有列出`)
  }

  private count(reason: string) {
    this.outcomes.set(reason, (this.outcomes.get(reason) ?? 0) + 1)
  }

  private skip(reason: string): TranslationOutcome {
    this.count(reason)
    return { ok: false, reason, skipped: true }
  }

  private fail(reason: string): TranslationOutcome {
    this.count(reason)
    return { ok: false, reason, skipped: false }
  }

  private prefixes(): string[] {
    const raw = (this.ctx.root.config as any)?.prefix
    const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
    return list.filter((p): p is string => typeof p === 'string' && p !== '')
  }

  async translate(msg: Msg, direction: TranslateDirection): Promise<TranslationOutcome> {
    // 关键词、术语表还没读完时先等（最多 5 秒）；读不完就不翻译，宁可不发给服务商
    const loaded = await Promise.race([this.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))])
    if (!loaded) return this.skip('词表未就绪')
    const source = (msg.translatable ?? '').trim()
    if (!source) return this.skip('没有可翻译的文字')
    if (this.keywords?.matches(source)) return this.skip('关键词命中原文')
    if (isCommand(source, this.prefixes(), (word) => this.ctx.$commander.resolve(word))) return this.skip('命令')
    const guarded = protect(source, msg.protect ?? [])
    const applied = this.glossary?.apply(guarded.text, direction) ?? { text: guarded.text, tokens: [], hints: [] }
    const stripped = stripTokens(applied.text)
    // 跳过判断只去掉保护用的占位符：术语（例如 Jita、Rifter）要算作文字
    const skip = skipReason(stripTokens(guarded.text), direction)
    if (skip) return this.skip(skip)

    if (this.moderationKeyMissing()) return this.skip('审核未配置密钥')
    const key = createHash('sha1').update(`${direction}\n${this.glossary?.version ?? ''}\n${source.replace(/\s+/g, ' ')}`).digest('hex')
    const cached = this.cache.get(key)
    if (cached && this.now() - cached.at < CACHE_TTL) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      this.count('缓存命中')
      return { ok: true, text: cached.text }
    }

    const result = await this.translator.translate({
      text: applied.text,
      direction,
      hints: applied.hints,
      tokens: [...guarded.tokens, ...applied.tokens].map((t) => t.token),
      sourceForChecks: stripped,
    })
    if (!result.ok) {
      // 超过每小时上限：每小时只记一条日志（清单 §4.4）
      if (result.reason === '超过每小时上限' && this.now() - this.warnedHourCap > 3600000) {
        this.warnedHourCap = this.now()
        this.logger.warn('翻译请求超过每小时上限，这一小时内只发原文')
      }
      return this.fail(result.reason)
    }
    const text = restore(restore(result.text, applied.tokens), guarded.tokens).trim()
    if (!text) return this.fail('空结果')
    if (this.keywords?.matches(text)) return this.fail('关键词命中译文')
    if (this.getSettings().filter.moderation) {
      // 送审的文字不带被保护的内容（用户名、QQ 号、网址等），只还原术语
      const checked = await this.moderator.check(stripTokens(restore(result.text, applied.tokens)))
      if (!checked.ok) return this.fail(checked.reason)
      if (checked.flagged) return this.fail('审核未通过')
    }
    this.cache.set(key, { text, at: this.now() })
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string)
    this.count('成功')
    return { ok: true, text }
  }
}
