// 翻译输入 translatable 和保护列表 protect（清单 §6.4、§12.1 第 2 步）。全部是编造的 ID 和名字
import { describe, it, expect } from 'vitest'
import { h } from 'koishi'
import { renderContent, type ContentEnv } from '../src/discord/markdown'
import { renderDiscordMessage, type RawMessage, type RenderOptions } from '../src/discord/render'
import { parseQQMessage, renderQQElements, type QQSessionLike } from '../src/qq/parse'

const N = Date.UTC(2026, 8, 25, 13, 30, 15) / 1000
const NOW = Date.UTC(2026, 8, 25, 11, 30, 0)
const roles: Record<string, string> = { '501': '舰队指挥' }
const channels: Record<string, string> = { '601': '集合频道' }

const opts: RenderOptions = {
  timeZone: 'Asia/Shanghai',
  now: NOW,
  roleName: (id) => roles[id],
  channelName: (id) => channels[id],
}

const msg = (extra: Partial<RawMessage> = {}): RawMessage => ({
  id: '900',
  channel_id: '800',
  guild_id: '700',
  author: { id: '101', username: 'someone' },
  content: '',
  type: 0,
  mentions: [{ id: '102', username: 'pilot', member: { nick: '飞行员' } }],
  ...extra,
})
const render = (extra: Partial<RawMessage>) => renderDiscordMessage(msg(extra), opts)!

describe('renderContent onToken', () => {
  it('报告提及、表情、时间、斜杠命令、频道导航，不报告网址和原样输出的时间码', () => {
    const got: string[] = []
    const env: ContentEnv = {
      timeZone: 'Asia/Shanghai',
      now: NOW,
      userName: () => '甲',
      roleName: () => undefined,
      channelName: () => '乙',
      onToken: (s) => got.push(s),
    }
    const out = renderContent(`**<@1>** <@&2> <#3> <:ok:4> <t:${N}> </ping:5> <id:home> <https://example.com/a> <t:${N}:x>`, env)
    expect(out).toBe(`@甲 @角色 #乙 [ok] 2026年9月25日 21:30 /ping [频道导航] https://example.com/a <t:${N}:x>`)
    expect(got).toEqual(['@甲', '@角色', '#乙', '[ok]', '2026年9月25日 21:30', '/ping', '[频道导航]'])
  })

  it('不传 onToken 时行为不变', () => {
    const env: ContentEnv = { timeZone: 'UTC', now: NOW, userName: () => undefined, roleName: () => undefined, channelName: () => undefined }
    expect(renderContent('<@1> hi', env)).toBe('@用户 hi')
  })
})

describe('Discord translatable / protect', () => {
  it('正文里的提及、表情、时间进入翻译输入和保护列表，去重', () => {
    const m = render({ content: `<@102> <@&501> go <#601> <:fire:9> <:fire:9> at <t:${N}:t> </fleet join:7>` })
    expect(m.translatable).toBe('@飞行员 @舰队指挥 go #集合频道 [fire] [fire] at 21:30 /fleet join')
    expect(m.protect).toEqual(['@飞行员', '@舰队指挥', '#集合频道', '[fire]', '21:30', '/fleet join'])
  })

  it('embed：标题、描述、字段（一行「名：值」，和转发的排版一样）进入；作者、页脚、链接不进', () => {
    const m = render({
      content: 'hello',
      embeds: [{
        type: 'rich',
        author: { name: 'Bot Author' },
        title: 'Title <#601>',
        url: 'https://example.com/t',
        description: 'Desc line',
        fields: [{ name: 'Where', value: 'Line1\nLine2' }],
        footer: { text: 'Footer text' },
        timestamp: '2026-09-25T13:30:00.000Z',
      }, { type: 'link', title: 'Preview title' }],
    })
    expect(m.translatable).toBe('hello\n\nTitle #集合频道\n\nDesc line\n\nWhere：Line1\n  Line2')
    expect(m.translatable).not.toContain('Bot Author')
    expect(m.translatable).not.toContain('Footer text')
    expect(m.translatable).not.toContain('Preview title')
    expect(m.translatable).not.toContain('https://example.com/t')
    expect(m.protect).toEqual(['#集合频道'])
  })

  it('附件、贴纸、组件占位和文件名不进', () => {
    const m = render({
      content: 'see files',
      attachments: [
        { filename: 'a.png', content_type: 'image/png', url: 'https://cdn.example.com/a.png' },
        { filename: 'b.zip', url: 'https://cdn.example.com/b.zip' },
        { filename: 'c.ogg', content_type: 'audio/ogg', url: 'https://cdn.example.com/c.ogg' },
      ],
      sticker_items: [{ id: '31', name: 'wave', format_type: 3 }],
      components: [{ type: 17, components: [{ type: 10, content: 'panel text' }, { type: 13 }] }],
    })
    expect(m.translatable).toBe('see files\n\npanel text')
    expect(m.checkText).toContain('b.zip')
  })

  it('投票行不进', () => {
    const m = render({ content: 'vote now', poll: { question: { text: 'Which system?' } } })
    expect(m.body).toContain('[投票] Which system?')
    expect(m.translatable).toBe('vote now')
  })

  it('转发快照：内容和 embed 文字进入，`[转发的消息]` 和附件不进', () => {
    const m = render({
      message_reference: { type: 1 },
      message_snapshots: [{
        message: {
          content: 'orig <#601> <@&501>',
          embeds: [{ title: 'snap title', footer: { text: 'snap footer' } }],
          attachments: [{ filename: 's.pdf', url: 'https://cdn.example.com/s.pdf' }],
        },
      }],
    })
    expect(m.translatable).toBe('orig #集合频道 @角色\n\nsnap title')
    expect(m.protect).toEqual(['#集合频道', '@角色'])
  })

  it('只有图片、空正文：translatable 为空', () => {
    const m = render({ attachments: [{ filename: 'a.png', content_type: 'image/png', url: 'https://cdn.example.com/a.png' }] })
    expect(m.translatable).toBe('')
    expect(m.protect).toEqual([])
  })

  it('回复引用和 embed 页脚里的记号不进保护列表', () => {
    const m = render({
      type: 19,
      content: 'ok',
      message_reference: { message_id: '777' },
      referenced_message: msg({ id: '777', content: '<#601> earlier' }),
    })
    expect(m.reply?.content).toBe('#集合频道 earlier')
    expect(m.translatable).toBe('ok')
    expect(m.protect).toEqual([])
  })
})

describe('QQ translatable / protect', () => {
  const env = { selfId: '10000', now: 1_700_000_000_000, memberName: (id: string) => ({ '20002': '缓存名' } as Record<string, string>)[id] }
  const session = (elements: any[]): QQSessionLike => ({
    channelId: '123456',
    messageId: '555',
    userId: '20001',
    elements,
    event: { member: { nick: '某人' } },
  })

  it('文字、@、表情进入；图片不进', () => {
    const m = parseQQMessage(session([
      h.text('集合 '),
      h('at', { id: '20002' }),
      h.text(' 出发'),
      h('face', { id: '14', name: '微笑' }),
      h('img', { src: 'https://img.example.com/a.png' }),
    ]), env)
    expect(m.translatable).toBe('集合 @缓存名 出发[微笑]')
    expect(m.translatable).not.toContain('[图片]')
    expect(m.protect).toEqual(['@缓存名', '[微笑]'])
  })

  it('表情包、语音、文件、合并转发、卡片、视频占位不进；markdown 进入', () => {
    const r = renderQQElements([
      h.text('前'),
      h('mface', { url: 'https://img.example.com/m.gif' }),
      h('record', {}),
      h('file', { file: 'x.zip' }),
      h('forward', { id: '1' }),
      h('json', { data: JSON.stringify({ prompt: '分享' }) }),
      h('video', { src: 'https://img.example.com/v.mp4' }),
      h('markdown', { content: '后' }),
      h('at', { type: 'all' }),
      h('face', { id: '1' }),
      h('face', { id: '1' }),
    ], env)
    expect(r.text).toBe('前[表情包][语音][文件: x.zip][合并转发][卡片: 分享]后@全体成员[表情][表情]')
    expect(r.translatable).toBe('前后@全体成员[表情][表情]')
    expect(r.protect).toEqual(['@全体成员', '[表情]'])
  })

  it('只有图片：translatable 为空', () => {
    const m = parseQQMessage(session([h('img', { src: 'https://img.example.com/a.png' })]), env)
    expect(m.translatable).toBe('')
    expect(m.protect).toEqual([])
  })
})
