// 管理命令（清单 §13）：只能看状态、暂停、恢复、导入；都需要配置的权限等级。
// 回复一律用元素数组并自己 catch（session.send 出错时会把整条内容写进日志，R10）。

import { h } from 'koishi'
import type { Context, Session } from 'koishi'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Bridge } from './bridges'
import { bridgesToYaml, convertOldConfig, findOldConfigs, formatReport } from './import'
import { describeError } from './log'
import type { Relay } from './relay'
import { splitText } from './text/split'

const DIRECTION_TEXT = { both: '双向', d2q: 'Discord→QQ', q2d: 'QQ→Discord' }

function timeFormatter(timeZone: string) {
  const format = new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return (ms: number) => (ms ? format.format(new Date(ms)) : '无')
}

async function reply(session: Session, text: string) {
  const pieces = splitText(text, 1500).slice(0, 5)
  for (const piece of pieces) {
    try {
      if (session.isDirect) await session.bot.sendPrivateMessage(session.userId!, [h.text(piece)])
      else await session.bot.sendMessage(session.channelId!, [h.text(piece)])
    } catch (e) {
      session.app.logger('dcqq-bridge').warn('命令回复发送失败：%s', describeError(e))
      return
    }
  }
}

/** 按编号、`Discord频道ID:QQ群号` 或桥名找桥。 */
export function findBridges(relay: Relay, target: string): { bridges: Bridge[]; error?: string } {
  const all = relay.settings.bridges
  const text = target.trim()
  if (/^\d+$/.test(text) && Number(text) <= relay.settings.rows.length) {
    const bridge = all.find((b) => b.index === Number(text))
    return bridge ? { bridges: [bridge] } : { bridges: [], error: `第 ${text} 个桥无效或没有启用` }
  }
  const pair = /^(\d+):(\d+)$/.exec(text)
  if (pair) {
    const found = all.filter((b) => b.discord === pair[1] && b.qq === pair[2])
    return found.length ? { bridges: found } : { bridges: [], error: `没有找到桥 ${text}` }
  }
  const named = all.filter((b) => b.label === text)
  if (named.length > 1) {
    const keys = [...new Set(named.map((b) => b.key))]
    if (keys.length > 1) {
      return { bridges: [], error: `有多个桥叫「${text}」，请用编号或「Discord频道ID:QQ群号」指定：\n${named.map((b) => `${b.index}. ${b.discord}:${b.qq}`).join('\n')}` }
    }
  }
  return named.length ? { bridges: named } : { bridges: [], error: `没有找到桥「${text}」` }
}

export async function statusText(relay: Relay, filter: (b: { discord: string; qq: string }) => boolean, all = true): Promise<string> {
  const lines: string[] = []
  const settings = relay.settings
  const time = timeFormatter(settings.timeZone)
  if (relay.paused.has('global')) lines.push('⏸ 全局暂停中')
  for (const problem of settings.problems) lines.push(`⚠ ${problem}`)
  if (relay.pausedTr.has('global')) lines.push('⏸ 翻译全局暂停中')
  for (const problem of relay.translation.problems.slice(0, 10)) lines.push(`⚠ ${problem}`)
  if (settings.translate.enabled) {
    const t = relay.translation.translator.stats()
    const reasons = Object.entries(t.failures).map(([r, n]) => `${r} ${n}`).join('、')
    lines.push(`翻译：请求 ${t.requests} 次，用量 ${t.promptTokens + t.completionTokens} tokens${reasons ? `，失败：${reasons}` : ''}`)
  }
  for (const platform of ['discord', 'onebot'] as const) {
    const problem = relay.botProblem(platform)
    if (problem) lines.push(`⚠ ${problem}`)
  }
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(relay.now()))
  let shown = 0
  for (const row of settings.rows) {
    if (!filter(row)) continue
    if (!all && (row.invalid || !row.enabled)) continue
    shown++
    const name = row.label || '（无名）'
    const head = `${row.index}. ${name} ${row.discord || '?'}:${row.qq || '?'} ${DIRECTION_TEXT[row.direction]}`
    if (row.invalid) {
      lines.push(`${head} ❌ 无效：${row.invalid}`)
      continue
    }
    if (!row.enabled) {
      lines.push(`${head} 未启用`)
      continue
    }
    const bridge = row.bridge!
    const state = relay.isPaused(bridge) ? '⏸ 暂停' : '启用'
    const stats = relay.stats.get(bridge.key)
    const parts = [`${head} ${state}`, `最近转发 ${time(stats.lastForwardAt)}`, `24 小时 ${stats.forwards} 条 / 失败 ${stats.failures}`]
    lines.push(parts.join('，'))
    if (stats.lastFailure) lines.push(`   最近一次失败：${stats.lastFailure.reason}（${time(stats.lastFailure.at)}）`)
    if (bridge.translate && settings.translate.enabled) {
      const paused = relay.isTranslationPaused(bridge) ? '（翻译暂停中）' : ''
      const last = stats.lastTranslateFailure ? `，最近一次失败：${stats.lastTranslateFailure.reason}` : ''
      lines.push(`   翻译${paused}：24 小时 ${stats.translated} 条 / 失败 ${stats.translateFailures}${last}`)
    }
    for (const problem of relay.health.get(bridge.key) ?? []) lines.push(`   ${problem.startsWith('⚠') ? problem : `⚠ ${problem}`}`)
    for (const warning of row.warnings) lines.push(`   ⚠ ${warning}`)
    if (bridge.atAll) {
      const remain = relay.gate.remain.get(bridge.qq)
      const fallbacks = [...relay.stats.atAllFallbacks(bridge.qq, date)].map(([reason, n]) => `${reason} ${n}`).join('、')
      const used = await relay.gate.usedToday(bridge.qq).catch(() => undefined)
      lines.push(`   @全体：今天用了 ${used ?? '?'} 次，剩余 ${remain ? `${remain.forUin} / ${remain.forGroup}（机器人 / 全群）` : '未知'}${fallbacks ? `，改发文字：${fallbacks}` : ''}`)
    }
  }
  if (!shown) lines.push('没有相关的桥。')
  return lines.join('\n')
}

export function registerCommands(ctx: Context, relay: Relay) {
  const authority = relay.settings.authority

  ctx.command('bridge.status [target:string]', '查看转发状态', { authority })
    .alias('桥接状态')
    .option('all', '-a 显示全部（私聊时）')
    .action(async ({ session, options }, target) => {
      if (!session) return
      let filter = (_: { discord: string; qq: string }) => true
      let all = true
      if (target) {
        const found = findBridges(relay, target)
        if (found.error) return void reply(session, found.error)
        const keys = new Set(found.bridges.map((b) => b.key))
        filter = (row) => keys.has(`${row.discord}:${row.qq}`)
      } else if (!session.isDirect) {
        // 在群里只显示和这个群有关的桥
        const id = session.channelId
        filter = (row) => (session.platform === 'discord' ? row.discord : row.qq) === id
      } else if (!options?.all) {
        // 私聊不带 -a：只显示启用的桥；带 -a 连无效、未启用的行也显示
        all = false
      }
      await reply(session, await statusText(relay, filter, all))
    })

  const pauseAction = (paused: boolean) => async ({ session, options }: { session?: Session; options?: { translate?: boolean } }, target?: string) => {
    if (!session) return
    // -t：只暂停或恢复翻译（清单 §13），转发照常
    const tr = !!options?.translate
    const what = tr ? '翻译' : '转发'
    try {
      if (!target) {
        await relay.setPaused('global', paused, tr)
        return void reply(session, paused ? `已全局暂停${what}。` : `已恢复全局${what}。`)
      }
      const found = findBridges(relay, target)
      if (found.error) return void reply(session, found.error)
      for (const key of new Set(found.bridges.map((b) => b.key))) await relay.setPaused(key, paused, tr)
      await reply(session, `${paused ? '已暂停' : '已恢复'}${what}：${found.bridges.map((b) => `${b.index}. ${b.label || b.key}`).join('、')}`)
    } catch (e) {
      await reply(session, `操作失败：${describeError(e)}`)
    }
  }

  ctx.command('bridge.pause [target:string]', '暂停转发（不带参数 = 全局暂停）', { authority })
    .alias('桥接暂停')
    .option('translate', '-t 只暂停翻译')
    .action(pauseAction(true))

  ctx.command('bridge.resume [target:string]', '恢复转发', { authority })
    .alias('桥接恢复')
    .option('translate', '-t 只恢复翻译')
    .action(pauseAction(false))

  ctx.command('bridge.reload', '重新读取关键词文件和黑话表', { authority })
    .action(async ({ session }) => {
      if (!session) return
      try {
        await relay.translation.reload()
        const glossary = relay.translation.glossary
        const problems = relay.translation.problems
        await reply(session, [
          `已重新读取。关键词 ${relay.translation.keywords?.size ?? 0} 条，术语 ${glossary?.size ?? 0} 条。`,
          ...(problems.length ? ['问题：', ...problems.slice(0, 30).map((p) => `⚠ ${p}`)] : []),
        ].join('\n'))
      } catch (e) {
        await reply(session, `重新读取失败：${describeError(e)}`)
      }
    })

  ctx.command('bridge.import', '从 @myrtus/forward 的配置生成桥（只输出，不改配置）', { authority })
    .action(async ({ session }) => {
      if (!session) return
      if (!session.isDirect) return void reply(session, '请私聊机器人使用这个命令。')
      const loader = ctx.get('loader') as any
      if (!loader?.config) return void reply(session, '无法读取配置。')
      const found = findOldConfigs(loader.config)
      const results = found.map((entry) => ({ ...entry, result: convertOldConfig(entry.config) }))
      let text = formatReport(results)
      const bridges = results.flatMap((r) => r.result.bridges)
      if (bridges.length) {
        const yaml = bridgesToYaml(bridges)
        try {
          const dir = resolve(ctx.baseDir, 'data/dcqq-bridge')
          await mkdir(dir, { recursive: true })
          const stamp = new Date(relay.now()).toISOString().replace(/[:.]/g, '-')
          const file = resolve(dir, `import-${stamp}.yaml`)
          await writeFile(file, yaml, 'utf8')
          text += `\n\n生成的配置已保存到：${file}`
        } catch (e) {
          text += `\n\n保存文件失败：${describeError(e)}`
        }
        text += `\n\n${yaml}`
      }
      await reply(session, text)
    })
}
