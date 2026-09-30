// 把翻译的各步串起来（清单 §12.1）：关键词查原文 → 保护 → 术语表 → 跳过判断 → 缓存 → 请求 → 还原 → 关键词查译文 → 审核。
// 任何一步不通过都只发原文；这里只决定附不附译文，不影响原文的转发。

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from 'koishi'
import type { Settings } from '../bridges'
import { KeywordFilter, Moderator, parseKeywordLines, resolveModerationKey } from '../filter'
import { buildGlossary, Glossary, loadCommonWords, loadEveData, mergeSlangFiles, parseSlangYaml, splitSlangPaths } from '../glossary'
import type { SlangFileResult, SlangFileSummary } from '../glossary'
import { fixToEntry, loadFixRows } from '../fixes'
import type { Msg } from '../types'
import { Translator } from './client'
import { keepValueRanges, protect, restore, restoreTerms, stripTokens } from './protect'
import { MemberNames, protectedNameRanges } from './names'
import { isCommand, isRealCommand, rootPrefixes, skipReason } from './skip'

export type TranslateDirection = 'en2zh' | 'zh2en'

export type TranslationOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string; skipped: boolean }

const CACHE_SIZE = 1000
const CACHE_TTL = 24 * 3600 * 1000
const HAN_OR_LETTER = /\p{L}/u

/** 比较用：去首尾空白、连续空白合成一个、不区分大小写（B3）。 */
function normalizeForCompare(text: string) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 译文去掉首尾空白，并且每行去掉行尾空白（U9：模型有时按 Markdown 的写法在行尾加两个空格）。 */
export function trimLines(text: string) {
  return text.replace(/[^\S\n]+$/gm, '').trim()
}

export class TranslationService {
  glossary: Glossary | null = null
  /** QQ 群成员名片缓存（U7），由 Relay 设置。 */
  memberNames: MemberNames | null = null
  keywords: KeywordFilter | null = null
  /** 读取关键词、术语表时的问题（给 bridge.status 显示）。 */
  problems: string[] = []
  /** 各个黑话表文件读到的条数（给 bridge.reload 的回复用，T8） */
  slangFiles: SlangFileSummary[] = []
  /** 各种原因的计数（跳过和失败都算）。 */
  outcomes = new Map<string, number>()
  translator: Translator
  moderator: Moderator
  /** text 为 null：译文和原文相同，不附（B3）。 */
  private cache = new Map<string, { text: string | null; at: number }>()
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
      return { baseURL: t.baseURL, apiKey: t.apiKey, model: t.model, timeoutMs: t.timeoutMs, maxPerHour: t.maxPerHour, extraBody: t.extraBody, context: t.context }
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
    // 黑话表可以有多个文件（`;;` 分隔，T8）：每个文件单独读、单独报错，后面文件的同一个原文覆盖前面的
    const paths = splitSlangPaths(s.glossary.slangFile)
    const files: SlangFileResult[] = []
    for (const file of paths) {
      const where = paths.length > 1 ? `黑话表 ${file}` : '黑话表'
      try {
        const parsed = parseSlangYaml(await readFile(this.path(file), 'utf8'))
        files.push({ path: file, entries: parsed.entries, warnings: parsed.warnings })
        // 多个文件时，一个文件写错只影响它自己
        const note = (w: string) => (paths.length > 1 ? w.replace('当作没有黑话表', '这个文件当作空的，其他文件照常加载') : w)
        problems.push(...parsed.warnings.map((w) => `${where}：${note(w)}`))
      } catch (e: any) {
        files.push({ path: file, entries: null, error: e?.code ?? '读取失败', warnings: [] })
        problems.push(`黑话表文件读不到：${file}（${e?.code ?? '读取失败'}）`)
      }
    }
    const mergedSlang = mergeSlangFiles(files)
    this.slangFiles = mergedSlang.summary
    let eveData = null
    if (s.glossary.eve) {
      eveData = loadEveData()
      if (!eveData) problems.push('插件自带的 EVE 名称表读不到')
    }
    // 纠错命令加的词条（B14），存在数据库里
    let fixes = null
    try {
      if (this.ctx.database) fixes = (await loadFixRows(this.ctx)).map(fixToEntry)
    } catch (e: any) {
      problems.push(`纠错词条读不到：${e?.message ?? e}`)
    }
    try {
      const built = buildGlossary(
        { eve: s.glossary.eve, systemStyle: s.glossary.systemStyle, overrides: s.glossary.overrides },
        { eveData, slang: mergedSlang.entries, slangWhere: mergedSlang.where, fixes, commonWords: loadCommonWords() },
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
    return rootPrefixes(this.ctx.root.config)
  }

  async translate(msg: Msg, direction: TranslateDirection): Promise<TranslationOutcome> {
    // 关键词、术语表还没读完时先等（最多 5 秒）；读不完就不翻译，宁可不发给服务商
    const loaded = await Promise.race([this.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))])
    if (!loaded) return this.skip('词表未就绪')
    const source = (msg.translatable ?? '').trim()
    if (!source) return this.skip('没有可翻译的文字')
    if (this.keywords?.matches(source)) return this.skip('关键词命中原文')
    const notCommands = this.getSettings().translate.notCommands
    if (isCommand(source, this.prefixes(), (word) => isRealCommand(this.ctx.$commander.resolve(word)), notCommands)) return this.skip('命令')
    // B10：标签后面的值、指定 embed 字段的值整段不翻译（字段位置按 translatable 算，只在没被裁剪时用）
    const fields = source === msg.translatable ? msg.fields : undefined
    // U6、U7：dotlan 链接里的军团名、建筑通知里的建筑名、QQ 群友名片里的名字也整段保护（只影响翻译输入）
    const members = direction === 'zh2en' && msg.platform === 'onebot' && this.getSettings().translate.protectMemberNames ? this.memberNames?.cards(msg.channelId) : undefined
    const names = protectedNameRanges(source, { direction, glossary: this.glossary, spans: msg.protect, members })
    const guarded = protect(source, msg.protect ?? [], [...keepValueRanges(source, this.getSettings().translate.keepValueLabels, fields), ...names])
    const applied = this.glossary?.apply(guarded.text, direction) ?? { text: guarded.text, tokens: [], hints: [] }
    const stripped = stripTokens(applied.text)
    // 跳过判断只去掉保护用的占位符：术语（例如 Jita、Rifter）要算作文字
    const skip = skipReason(stripTokens(guarded.text), direction)
    if (skip) return this.skip(skip)

    if (this.moderationKeyMissing()) return this.skip('审核未配置密钥')
    // B3：去掉所有占位符（保护 + 术语）后没有文字 → 不请求服务商；术语换完后和原文不同就本地生成译文
    if (!HAN_OR_LETTER.test(stripped)) {
      const local = trimLines(restore(restoreTerms(applied.text, applied.tokens), guarded.tokens))
      if (!local || normalizeForCompare(local) === normalizeForCompare(source)) return this.skip('只有术语')
      return this.finish(local, stripTokens(restoreTerms(applied.text, applied.tokens)), source, null)
    }
    // 保留标签、背景说明（U2）改了之后译文也要重新生成，所以一起算进缓存 key
    // 被保护的内容（名片、建筑名等）变了，发给模型的文字就不同，所以 guarded.text 也算进 key
    const labels = this.getSettings().translate.keepValueLabels.join(';;')
    const context = createHash('sha1').update(this.getSettings().translate.context ?? '').digest('hex')
    const key = createHash('sha1').update(`${direction}\n${this.glossary?.version ?? ''}\n${labels}\n${context}\n${guarded.text.replace(/\s+/g, ' ')}\n${source.replace(/\s+/g, ' ')}`).digest('hex')
    const cached = this.cache.get(key)
    if (cached && this.now() - cached.at < CACHE_TTL) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      this.count('缓存命中')
      if (cached.text === null) return this.skip('译文与原文相同')
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
    const text = trimLines(restore(restoreTerms(result.text, applied.tokens), guarded.tokens))
    // 送审的文字不带被保护的内容（用户名、QQ 号、网址等），只还原术语
    return this.finish(text, stripTokens(restoreTerms(result.text, applied.tokens)), source, key)
  }

  /** 译文的最后几步：和原文比较、关键词、审核、缓存。key 为 null 时不缓存（本地生成的译文）。 */
  private async finish(text: string, forModeration: string, source: string, key: string | null): Promise<TranslationOutcome> {
    if (!text) return this.fail('空结果')
    if (normalizeForCompare(text) === normalizeForCompare(source)) {
      if (key) this.remember(key, null)
      return this.skip('译文与原文相同')
    }
    if (this.keywords?.matches(text)) return this.fail('关键词命中译文')
    if (this.getSettings().filter.moderation) {
      const checked = await this.moderator.check(forModeration)
      if (!checked.ok) return this.fail(checked.reason)
      if (checked.flagged) return this.fail('审核未通过')
    }
    if (key) this.remember(key, text)
    this.count('成功')
    return { ok: true, text }
  }

  private remember(key: string, text: string | null) {
    this.cache.set(key, { text, at: this.now() })
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string)
  }
}
