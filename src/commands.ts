// 管理命令（清单 §13）：只能看状态、暂停、恢复、导入；都需要配置的权限等级。
// 回复一律用元素数组并自己 catch（session.send 出错时会把整条内容写进日志，R10）。

import { h } from 'koishi'
import type { Command, Context, Session } from 'koishi'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Bridge } from './bridges'
import { bridgesToYaml, convertOldConfig, findOldConfigs, formatReport } from './import'
import { describeError } from './log'
import { qqOnline } from './qq/api'
import type { Relay } from './relay'
import { splitText } from './text/split'
import { utcOffset } from './util'

const DIRECTION_TEXT = { both: '双向', d2q: 'Discord→QQ', q2d: 'QQ→Discord' }

/** 时间后面标上时区（A8），例如 `09/30 12:38 (UTC+8)`；本机时区和配置的时区不同时不会看错。 */
export function timeFormatter(timeZone: string) {
  const format = new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return (ms: number) => (ms ? `${format.format(new Date(ms))} (${utcOffset(ms, timeZone)})` : '无')
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

/**
 * 要显示的、开了 @全体 的桥所在的 QQ 群：每个群实时查一次剩余次数（A8）。
 * 同一个群只查一次，所有群并行，每个最多 8 秒（和 @全体 判断用同一个超时），所以整个命令不会等太久。
 */
async function liveRemains(relay: Relay, filter: (b: { discord: string; qq: string }) => boolean) {
  const groups = new Set<string>()
  for (const row of relay.settings.rows) {
    if (filter(row) && !row.invalid && row.enabled && row.bridge?.atAll) groups.add(row.bridge.qq)
  }
  const result = new Map<string, Awaited<ReturnType<Relay['gate']['refreshRemain']>>>()
  if (!groups.size) return result
  const bot = relay.qqBot()
  await Promise.all([...groups].map(async (group) => {
    result.set(group, bot && qqOnline(bot) ? await relay.gate.refreshRemain(bot, group) : { error: 'QQ 机器人不在线' })
  }))
  return result
}

export async function statusText(relay: Relay, filter: (b: { discord: string; qq: string }) => boolean, all = true): Promise<string> {
  const lines: string[] = []
  const settings = relay.settings
  const time = timeFormatter(settings.timeZone)
  // 统计只在内存里，每次重载清零（A8）
  lines.push(`统计从 ${time(relay.stats.startedAt)} 重载后开始`)
  if (relay.paused.has('global')) lines.push('⏸ 全局暂停中')
  for (const problem of settings.problems) lines.push(`⚠ ${problem}`)
  if (relay.pausedTr.has('global')) lines.push('⏸ 翻译全局暂停中')
  for (const problem of relay.translation.problems.slice(0, 10)) lines.push(`⚠ ${problem}`)
  if (settings.translate.enabled) {
    const t = relay.translation.translator.stats()
    const reasons = Object.entries(t.failures).map(([r, n]) => `${r} ${n}`).join('、')
    lines.push(`翻译：请求 ${t.requests} 次，用量 ${t.promptTokens + t.completionTokens} tokens${reasons ? `，请求失败：${reasons}` : ''}`)
    const outcomes = [...relay.translation.outcomes].filter(([r]) => r !== '成功').map(([r, n]) => `${r} ${n}`).join('、')
    if (outcomes) lines.push(`   没附译文的原因：${outcomes}`)
  }
  for (const platform of ['discord', 'onebot'] as const) {
    const problem = relay.botProblem(platform)
    if (problem) lines.push(`⚠ ${problem}`)
  }
  const remains = await liveRemains(relay, filter)
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
      const live = remains.get(bridge.qq)
      let remain: string
      if (live && 'remain' in live) remain = `${live.remain.forUin} / ${live.remain.forGroup}（机器人 / 全群）`
      else {
        // 查不到：写清楚原因；以前查到过的话附上那次的结果
        const cached = relay.gate.remain.get(bridge.qq)
        const reason = live?.error ?? '未知'
        remain = cached ? `${reason}（上次查到 ${cached.forUin} / ${cached.forGroup}，${time(cached.checkedAt)}）` : reason
      }
      const fallbacks = [...relay.stats.atAllFallbacks(bridge.qq, date)].map(([reason, n]) => `${reason} ${n}`).join('、')
      const used = await relay.gate.usedToday(bridge.qq).catch(() => undefined)
      lines.push(`   @全体：今天用了 ${used ?? '?'} 次，剩余 ${remain}${fallbacks ? `，改发文字：${fallbacks}` : ''}`)
    }
  }
  if (!shown) lines.push('没有相关的桥。')
  return lines.join('\n')
}

export function registerCommands(ctx: Context, relay: Relay) {
  const authority = relay.settings.authority
  // 本插件注册的命令都记到 relay.ownCommands 里，这些命令的消息不转发（A8）。以后加的命令也要用这个函数注册；
  // 自动建出来的上级命令（bridge）记到 ownGroups：bridge.xxx 形式的新命令即使漏记了也不会被转发
  const command = ((...args: Parameters<Context['command']>) => {
    const created = ctx.command(...args)
    relay.ownCommands.add(created)
    for (let c: Command | null = created.parent; c; c = c.parent) {
      if (c.ctx?.scope === ctx.scope && !relay.ownCommands.has(c)) relay.ownGroups.add(c)
    }
    return created
  }) as Context['command']

  command('bridge.status [target:string]', '查看转发状态', { authority })
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

  command('bridge.pause [target:string]', '暂停转发（不带参数 = 全局暂停）', { authority })
    .alias('桥接暂停')
    .option('translate', '-t 只暂停翻译')
    .action(pauseAction(true))

  command('bridge.resume [target:string]', '恢复转发', { authority })
    .alias('桥接恢复')
    .option('translate', '-t 只恢复翻译')
    .action(pauseAction(false))

  command('bridge.reload', '重新读取关键词文件和黑话表', { authority })
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

  command('bridge.import', '从 @myrtus/forward 的配置生成桥（只输出，不改配置）', { authority })
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
