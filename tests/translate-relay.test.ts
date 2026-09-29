// PR 2：翻译接进转发之后的整体行为（清单 §18.1「PR 2 必须有」）。翻译和审核都用模拟服务器，不调用外部 API。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Relay } from '../src/relay'
import { bridge, DC_CHANNEL, Env, OWNER_QQ, PR2_DEFAULTS, QQ_GROUP, QQ_USER, qqPayload, setup, sleep } from './harness'

class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []
  moderations: any[] = []
  /** 把 <text> 里的内容变成译文；默认英译中加「译：」，中译英加「EN: 」。 */
  translate: (text: string, body: any) => string | null = (text) => (/[一-鿿]/.test(text) ? `EN: ${text}` : `译：${text}`)
  delayMs = 0
  flagged = false
  moderationStatus = 200

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const reply = (status: number, body: unknown) => {
          if (res.destroyed) return
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.url?.endsWith('/moderations')) {
          this.moderations.push({ headers: req.headers, json })
          return reply(this.moderationStatus, { results: [{ flagged: this.flagged }] })
        }
        this.chat.push({ headers: req.headers, json })
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        const out = this.translate(text, json)
        const send = () => reply(200, { choices: [{ message: { role: 'assistant', content: out ?? '' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })
        if (this.delayMs) setTimeout(send, this.delayMs)
        else send()
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

let env: Env
let llm: FakeLLM

beforeEach(async () => {
  llm = new FakeLLM()
  await llm.start()
})

afterEach(async () => {
  await env?.stop()
  await llm.stop()
})

function on(patch: any = {}) {
  return {
    bridges: [bridge({ translate: true })],
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, ...patch.translate },
    filter: { ...PR2_DEFAULTS.filter, ...patch.filter },
    glossary: { ...PR2_DEFAULTS.glossary, ...patch.glossary },
    ...(patch.bridges ? { bridges: patch.bridges } : {}),
  }
}

describe('翻译接进转发', () => {
  it('Discord 英文 → QQ：原文 + 空行 + 【机翻】 译文，在同一条消息里', async () => {
    env = await setup(on())
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)).toEqual(['[测试桥 - 舰长]\nFleet forms in Jita tonight\n\n【机翻】 译：Fleet forms in Jita tonight'])
  })

  it('QQ 中文 → Discord：同一条消息里带【机翻】译文', async () => {
    env = await setup(on())
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '今晚八点集合出发' } }]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].json.content).toBe('今晚八点集合出发\n\n【机翻】 EN: 今晚八点集合出发')
  })

  it('没打开这个桥的翻译、或总开关关着 → 只发原文，不请求', async () => {
    env = await setup(on({ bridges: [bridge({ translate: false })] }))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
    expect(llm.chat).toHaveLength(0)
  })

  it('请求体里没有作者名、文件名、QQ 号；不带 temperature', async () => {
    env = await setup(on())
    await env.qqMessage(qqPayload([
      { type: 'text', data: { text: '今晚八点集合出发' } },
      { type: 'file', data: { file: '秘密名单.xlsx' } },
    ]))
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    const body = JSON.stringify(llm.chat[0].json)
    expect(body).not.toContain('群名片小明')
    expect(body).not.toContain('小明')
    expect(body).not.toContain('秘密名单')
    expect(body).not.toContain(QQ_USER)
    expect(body).not.toContain(QQ_GROUP)
    expect(llm.chat[0].json.temperature).toBeUndefined()
    expect(Object.keys(llm.chat[0].json).sort()).toEqual(['messages', 'model'])
  })

  it('提及和时间被保护：译文里原样还原', async () => {
    env = await setup(on())
    let seen = ''
    llm.translate = (text) => {
      seen = text
      return `译：${text}`
    }
    env.discordMessage({ content: 'CTA <t:1790000000:F> Jita, ping <@930000000000000009>', mentions: [{ id: '930000000000000009', username: 'wing', global_name: '僚机' }] })
    await env.idle()
    expect(seen).not.toContain('僚机')
    expect(seen).toMatch(/⟦\d+⟧/)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：CTA 2026年9月21日 星期一 22:13 Jita, ping @僚机')
  })

  it('翻译超时 → 只发原文；一直超时时连发 20 条，全部按顺序送达', async () => {
    env = await setup(on({ translate: { timeoutMs: 1000 } }))
    llm.delayMs = 5000
    for (let i = 0; i < 20; i++) env.discordMessage({ content: `Fleet message number ${i} forms up` })
    for (let i = 0; i < 100 && env.qq.text(QQ_GROUP).length < 20; i++) await sleep(200)
    const texts = env.qq.text(QQ_GROUP)
    expect(texts).toHaveLength(20)
    texts.forEach((t, i) => {
      expect(t).toBe(`[测试桥 - 舰长]\nFleet message number ${i} forms up`)
    })
  }, 30000)

  it('占位符不对的译文被丢掉，只发原文', async () => {
    env = await setup(on())
    llm.translate = (text) => `译：${text.replace(/⟦\d+⟧/g, '')}`
    env.discordMessage({ content: 'meet at <t:1790000000:t> in Jita please' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
  })

  it('命令不翻译（包括被禁用的别名）', async () => {
    env = await setup(on())
    env.app.command('jita <item:text>').alias('吉他', { filter: false } as any).action(() => 'price')
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '吉他 三钛合金' } }]))
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'jita tritanium' } }]))
    await env.idle()
    expect(llm.chat).toHaveLength(0)
  })

  it('太短或已经是目标语言 → 跳过：「gg [微笑]」「@张三 ok」「有人吗」这种中文发到 Discord 仍然翻译', async () => {
    env = await setup(on())
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'gg ' } }, { type: 'face', data: { id: '14' } }]))
    await env.qqMessage(qqPayload([{ type: 'at', data: { qq: QQ_USER, name: '张三' } }, { type: 'text', data: { text: ' ok' } }]))
    env.discordMessage({ content: '今晚八点集合' })
    await env.idle()
    expect(llm.chat).toHaveLength(0)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '有人吗' } }]))
    await env.idle()
    expect(llm.chat).toHaveLength(1)
  })

  it('关键词命中原文 → 不请求翻译；命中译文 → 丢掉译文；原文照转', async () => {
    env = await setup(on({ filter: { keywords: '禁词\n# 注释\nre:\\bbadword\\b' } }))
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '这里有禁词出现了' } }]))
    await env.idle()
    expect(llm.chat).toHaveLength(0)
    expect(env.discord.posts()[0].json.content).toBe('这里有禁词出现了')
    llm.translate = () => 'this has a BADWORD inside'
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '正常的一句中文消息' } }]))
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    expect(env.discord.posts()[1].json.content).toBe('正常的一句中文消息')
  })

  it('审核：flagged、出错 → 丢掉译文', async () => {
    env = await setup(on({ filter: { moderation: true, moderationBaseURL: llm.base } }))
    llm.flagged = true
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
    llm.flagged = false
    llm.moderationStatus = 500
    env.discordMessage({ content: 'Fleet forms in Amarr tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[1]).not.toContain('【机翻】')
    llm.moderationStatus = 200
    env.discordMessage({ content: 'Fleet forms in Dodixie tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[2]).toContain('【机翻】')
    // 同一个网站：借用翻译的 key
    expect(llm.moderations.at(-1).headers.authorization).toBe('Bearer test-key')
  })

  it('翻译用别家接口 + 审核打开 + 没填审核 key → 不向审核接口发任何请求，译文不附，状态里有提示', async () => {
    const openai = new FakeLLM()
    await openai.start()
    try {
      env = await setup(on({ filter: { moderation: true, moderationBaseURL: openai.base.replace('127.0.0.1', 'localhost') } }))
      env.discordMessage({ content: 'Fleet forms in Jita tonight' })
      await env.idle()
      expect(openai.moderations).toHaveLength(0)
      expect(openai.chat).toHaveLength(0)
      expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
      const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
      expect(status).toContain('审核未配置密钥，译文全部不附')
    } finally {
      await openai.stop()
    }
  })

  it('label 是空白 → 仍然带【机翻】', async () => {
    env = await setup(on({ translate: { label: ' ​ ' } }))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).toContain('\n\n【机翻】 译：')
  })

  it('没填接口地址或模型 → 按关闭处理，状态里有原因', async () => {
    env = await setup(on({ translate: { model: '' } }))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.chat).toHaveLength(0)
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('没有填接口地址或模型')
  })

  it('黑话表 YAML 写错 → 照样转发和翻译，状态里有提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-slang-'))
    await writeFile(join(dir, 'slang.yaml'), '- en: "CTA\n  zh: [broken', 'utf8')
    ;(globalThis as any).__slangDir = dir
    env = await setup(on({ glossary: { slangFile: join(dir, 'slang.yaml') } }))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】')
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('黑话表')
  })

  it('黑话表 force 词条：译文里是标准写法，请求里带术语参考', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-slang-'))
    await writeFile(join(dir, 'slang.yaml'), [
      '- { en: "stratop", zh: "战略行动", mode: force, dir: both }',
      '- { en: "logi", zh: "后勤", mode: hint, dir: en2zh }',
    ].join('\n'), 'utf8')
    env = await setup(on({ glossary: { slangFile: join(dir, 'slang.yaml') } }))
    env.discordMessage({ content: 'stratop tonight, bring logi please' })
    await env.idle()
    const user = llm.chat[0].json.messages.at(-1).content
    expect(user).toContain('logi => 后勤')
    expect(user).not.toContain('stratop')
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：战略行动 tonight')
  })

  it('bridge.pause -t 只暂停翻译，重载后仍然有效；resume -t 恢复', async () => {
    env = await setup(on())
    const replies = await env.command(OWNER_QQ, 'bridge.pause -t')
    expect(replies.join('')).toContain('已全局暂停翻译')
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[0]).not.toContain('【机翻】')
    expect(llm.chat).toHaveLength(0)
    // 新的 Relay（相当于重载插件）读到同一个数据库
    const again = new Relay(env.app, { ...env.relay.settings as any, ...on() }, { timers: false })
    await again.start()
    expect(again.isTranslationPaused()).toBe(true)
    expect(again.isPaused()).toBe(false)
    await again.dispose()
    await env.command(OWNER_QQ, 'bridge.resume -t')
    env.discordMessage({ content: 'Fleet forms in Amarr tonight' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[1]).toContain('【机翻】')
  })

  it('同一条消息发往两个目标：只请求一次翻译', async () => {
    env = await setup(on({ bridges: [bridge({ translate: true }), bridge({ translate: true, qq: '555000222' })] }))
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】')
    expect(env.qq.text('555000222')[0]).toContain('【机翻】')
  })

  it('缓存：同样的原文第二次不再请求', async () => {
    env = await setup(on())
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    expect(llm.chat).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP)[1]).toContain('【机翻】')
  })

  it('bridge.status 显示翻译次数；bridge.reload 重新读取', async () => {
    env = await setup(on())
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('翻译：24 小时 1 条 / 失败 0')
    const reload = (await env.command(OWNER_QQ, 'bridge.reload')).join('\n')
    expect(reload).toContain('已重新读取')
  })
})

void DC_CHANNEL
