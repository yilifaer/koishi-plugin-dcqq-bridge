import { afterEach, describe, expect, it } from 'vitest'
import { DC_CHANNEL, Env, QQ_GROUP, qqPayload, setup } from './harness'

let env: Env
afterEach(async () => {
  await env?.stop()
})

describe('基本转发', () => {
  it('Discord → QQ 带前缀', async () => {
    env = await setup()
    env.discordMessage({ content: 'Fleet forms <t:1790000000:F> in Jita' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)).toEqual(['[测试桥 - 舰长]\nFleet forms 2026年9月21日 星期一 22:13 in Jita'])
  })

  it('QQ → Discord 用 webhook，带 allowed_mentions', async () => {
    env = await setup()
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '你好 <@123>' } }]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toMatch(/^\/webhooks\/\d+\/tok\d+\?wait=true$/)
    expect(posts[0].json.username).toBe('[测试桥] 群名片小明')
    expect(posts[0].json.allowed_mentions).toEqual({ parse: [] })
    expect(posts[0].json.content).toBe('你好 <​@123>')
  })
})
