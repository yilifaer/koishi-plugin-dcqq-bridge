import { describe, it, expect } from 'vitest'
import { renderContent, type ContentEnv } from '../src/discord/markdown'
import { collectRefs, displayName, isPublicUrl, renderDiscordMessage, type RawMessage, type RenderOptions } from '../src/discord/render'

// 全部是编造的 ID 和名字
const N = Date.UTC(2026, 8, 25, 13, 30, 15) / 1000
const NOW = Date.UTC(2026, 8, 25, 11, 30, 0)

const roles: Record<string, string> = { '501': '舰队指挥' }
const channels: Record<string, string> = { '601': '集合频道' }

const env: ContentEnv = {
  timeZone: 'Asia/Shanghai',
  now: NOW,
  userName: (id) => ({ '101': '小明' } as Record<string, string>)[id],
  roleName: (id) => roles[id],
  channelName: (id) => channels[id],
}
const r = (text: string) => renderContent(text, env)

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
  author: { id: '101', username: 'xiaoming', global_name: '明明' },
  member: { nick: '小明' },
  content: '',
  timestamp: '2026-09-25T11:29:00.000Z',
  type: 0,
  mention_everyone: false,
  mentions: [],
  embeds: [],
  attachments: [],
  ...extra,
})
const render = (extra: Partial<RawMessage> = {}, o: Partial<RenderOptions> = {}) =>
  renderDiscordMessage(msg(extra), { ...opts, ...o })

describe('renderContent：提及、表情、时间码', () => {
  it('用户提及和回退', () => {
    expect(r('hi <@101> and <@!101>')).toBe('hi @小明 and @小明')
    expect(r('<@999>')).toBe('@用户')
  })

  it('角色、频道提及和回退', () => {
    expect(r('<@&501> 去 <#601>')).toBe('@舰队指挥 去 #集合频道')
    expect(r('<@&502> <#602>')).toBe('@角色 #频道')
  })

  it('@everyone 原样保留', () => {
    expect(r('@everyone @here')).toBe('@everyone @here')
  })

  it('一条消息两个自定义表情（非贪婪）', () => {
    expect(r('a <:ok_hand2:111> b <a:party:222> c')).toBe('a [ok_hand2] b [party] c')
    expect(r('<:x:1><:y:2>')).toBe('[x][y]')
  })

  it('时间码换算，非法的原样保留', () => {
    expect(r(`集合 <t:${N}:F>`)).toBe('集合 2026年9月25日 星期五 21:30')
    expect(r(`<t:${N}>`)).toBe('2026年9月25日 21:30')
    expect(r(`<t:${N}:R>`)).toBe('2026年9月25日 21:30（约2小时后）')
    expect(r('<t:99999999999999999:f>')).toBe('<t:99999999999999999:f>')
    expect(r(`<t:${N}:x>`)).toBe(`<t:${N}:x>`)
  })

  it('尖括号链接、Markdown 链接', () => {
    expect(r('看 <https://example.com/a_b_c>')).toBe('看 https://example.com/a_b_c')
    expect(r('[说明](https://example.com/x)')).toBe('说明 https://example.com/x')
    expect(r('[**粗体说明**](<https://example.com/y>)')).toBe('粗体说明 https://example.com/y')
  })

  it('裸网址里的下划线、星号不被当成强调', () => {
    expect(r('https://example.com/a_b_c/d_e')).toBe('https://example.com/a_b_c/d_e')
    expect(r('**https://example.com/x**')).toBe('https://example.com/x')
  })

  it('斜杠命令提及、频道导航', () => {
    expect(r('用 </fleet:123> 或 </fleet join:124> 或 </a b c:125>')).toBe('用 /fleet 或 /fleet join 或 /a b c')
    expect(r('<id:customize> <id:browse> <id:guide> <id:linked-roles> <id:home>')).toBe('[频道导航] [频道导航] [频道导航] [频道导航] [频道导航]')
  })

  it('其他 < > & 原样保留', () => {
    expect(r('price < 5b and > 3b')).toBe('price < 5b and > 3b')
    expect(r('&amp; &lt; <b>x</b> <@abc>')).toBe('&amp; &lt; <b>x</b> <@abc>')
  })
})

describe('renderContent：Markdown', () => {
  it.each([
    ['**粗体**', '粗体'],
    ['__下划线__', '下划线'],
    ['*斜体*', '斜体'],
    ['_斜体_', '斜体'],
    ['***粗斜***', '粗斜'],
    ['~~删除~~', '删除'],
    ['||剧透||', '剧透'],
    ['**a** 和 *b* 和 ~~c~~', 'a 和 b 和 c'],
    ['*__混合__*', '混合'],
    ['# 标题', '标题'],
    ['## 标题', '标题'],
    ['### 标题', '标题'],
    ['-# 小字', '小字'],
    ['> 引用', '引用'],
    ['>>> 多行\n引用', '多行\n引用'],
    ['第一行\n> 第二行\n# 第三行', '第一行\n第二行\n第三行'],
  ])('%j', (input, expected) => {
    expect(r(input)).toBe(expected)
  })

  it('单词里的下划线不动', () => {
    expect(r('sov_timer')).toBe('sov_timer')
    expect(r('check sov_timer and hp_left_now')).toBe('check sov_timer and hp_left_now')
    expect(r('a _b_ c')).toBe('a b c')
  })

  it('行首 * 和 - 是列表', () => {
    expect(r('* item\n* two *强调*')).toBe('* item\n* two 强调')
    expect(r('- item\n  * sub')).toBe('- item\n  * sub')
  })

  it('不成对的标记和算式保留', () => {
    expect(r('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(r('**未闭合')).toBe('**未闭合')
  })

  it('行内代码和代码块：去掉反引号，内容原样', () => {
    expect(r('执行 `a_b **c** <@101>` 就行')).toBe('执行 a_b **c** <@101> 就行')
    expect(r('``含 ` 的代码``')).toBe('含 ` 的代码')
    expect(r('```js\nconst x = **1**\n# no\n```')).toBe('const x = **1**\n# no')
    expect(r('```\n> raw <t:1:f>\n```')).toBe('> raw <t:1:f>')
    expect(r('```单行 *x*```')).toBe('单行 *x*')
    expect(r('未闭合 ` 反引号')).toBe('未闭合 ` 反引号')
  })

  it('反斜杠转义', () => {
    expect(r('\\*不斜\\* \\_ \\~ \\| \\> \\`')).toBe('*不斜* _ ~ | > `')
    expect(r('\\# 不是标题')).toBe('# 不是标题')
    expect(r('\\> 不是引用')).toBe('> 不是引用')
    expect(r('\\*\\*x\\*\\*')).toBe('**x**')
    expect(r('C:\\path')).toBe('C:\\path')
  })
})

describe('displayName', () => {
  it('昵称 → 全局显示名 → 用户名 → 用户', () => {
    expect(displayName({ id: '1', username: 'u', global_name: 'g' }, { nick: 'n' })).toBe('n')
    expect(displayName({ id: '1', username: 'u', global_name: 'g' }, { nick: null })).toBe('g')
    expect(displayName({ id: '1', username: 'u', global_name: null })).toBe('u')
    expect(displayName({ id: '1' })).toBe('用户')
  })

  it('webhook 消息用 author.username', () => {
    const m = render({ content: 'x', webhook_id: '333', author: { id: '333', username: '新闻机器人' }, member: undefined })!
    expect(m.author).toBe('新闻机器人')
  })

  it('正文里的提及用 d.mentions 的昵称', () => {
    const m = render({
      content: '<@102> <@103>',
      mentions: [
        { id: '102', username: 'bob', global_name: '鲍勃', member: { nick: '老鲍' } },
        { id: '103', username: 'carl', global_name: null },
      ],
    })!
    expect(m.body).toBe('@老鲍 @carl')
  })
})

describe('renderDiscordMessage：基本字段', () => {
  it('普通消息', () => {
    const m = render({ content: '**你好** <@&501>' })!
    expect(m).toMatchObject({
      platform: 'discord',
      channelId: '800',
      messageId: '900',
      guildId: '700',
      authorId: '101',
      author: '小明',
      body: '你好 @舰队指挥',
      blocks: [],
      media: [],
      mentionEveryone: false,
      silent: false,
      backfill: false,
      timestamp: Date.parse('2026-09-25T11:29:00.000Z'),
    })
    expect(m.reply).toBeUndefined()
  })

  it('mention_everyone 只看原始数据', () => {
    expect(render({ content: '@everyone 集合' })!.mentionEveryone).toBe(false)
    expect(render({ content: '@everyone 集合', mention_everyone: true })!.mentionEveryone).toBe(true)
  })

  it('静默消息', () => {
    expect(render({ content: 'x', flags: 4096 })!.silent).toBe(true)
    expect(render({ content: 'x', flags: 4 })!.silent).toBe(false)
  })

  it('补发标记、时间戳缺失时用 now', () => {
    const m = render({ content: 'x', timestamp: undefined }, { backfill: true })!
    expect(m.backfill).toBe(true)
    expect(m.timestamp).toBe(NOW)
  })

  it('系统消息类型不转发', () => {
    for (const type of [6, 7, 8, 18, 21]) expect(render({ content: 'x', type })).toBeNull()
    for (const type of [0, 20, 23]) expect(render({ content: 'x', type })).not.toBeNull()
  })

  it('内容全空 → null', () => {
    expect(render()).toBeNull()
    expect(render({ content: '   ' })).toBeNull()
    expect(render({ embeds: [{ type: 'link', url: 'https://example.com', title: '预览' }] })).toBeNull()
  })

  it('投票', () => {
    expect(render({ poll: { question: { text: '今晚几点集合？' } } })!.body).toBe('[投票] 今晚几点集合？')
    expect(render({ content: '大家投', poll: { question: { text: '去哪？' } } })!.body).toBe('大家投\n[投票] 去哪？')
  })
})

describe('embed', () => {
  it('全部字段', () => {
    const m = render({
      embeds: [{
        type: 'rich',
        author: { name: '战报助手' },
        title: '**击杀** 通报',
        url: 'https://example.com/km/1',
        description: '在 <#601> 由 <@&501> 完成 <t:' + N + ':t>',
        fields: [
          { name: '地点', value: '某星系' },
          { name: '参与', value: '甲\n乙' },
        ],
        footer: { text: '来源' },
        timestamp: '2026-09-25T13:30:15.000Z',
        image: { url: 'https://example.com/i.png', proxy_url: 'https://media.example.net/i.png' },
        thumbnail: { url: 'https://example.com/t.png' },
      }],
    })!
    expect(m.body).toBe('')
    expect(m.blocks).toEqual([
      '战报助手\n击杀 通报 https://example.com/km/1\n在 #集合频道 由 @舰队指挥 完成 21:30\n地点：某星系\n参与：甲\n  乙\n来源 · 2026年9月25日 21:30',
    ])
    expect(m.media).toEqual([
      { kind: 'image', urls: ['https://media.example.net/i.png', 'https://example.com/i.png'], name: '', placeholder: '[图片]' },
      { kind: 'image', urls: ['https://example.com/t.png'], name: '', placeholder: '[图片]' },
    ])
    expect(m.checkText).toContain('某星系')
  })

  it('没有 type 的 embed 也渲染；只有时间戳的页脚', () => {
    const m = render({ embeds: [{ description: 'd', timestamp: '2026-09-25T13:30:15Z' }] })!
    expect(m.blocks).toEqual(['d\n2026年9月25日 21:30'])
  })

  it('链接预览 embed 跳过', () => {
    for (const type of ['link', 'article', 'video', 'image', 'gifv']) {
      const m = render({ content: 'https://example.com', embeds: [{ type, title: '预览', thumbnail: { url: 'https://example.com/p.png' } }] })!
      expect(m.blocks).toEqual([])
      expect(m.media).toEqual([])
    }
  })

  it('内网地址的 url 被丢掉，proxy_url 优先', () => {
    const m = render({
      embeds: [
        { title: 'a', image: { url: 'http://127.0.0.1/a.png', proxy_url: 'https://media.example.net/a.png' } },
        { title: 'b', image: { url: 'http://192.168.1.5/b.png' } },
        { title: 'c', thumbnail: { url: 'http://localhost:8080/c.png' } },
      ],
    })!
    expect(m.media.map((x) => x.urls)).toEqual([['https://media.example.net/a.png'], [], []])
    expect(m.media.every((x) => x.placeholder === '[图片]')).toBe(true)
  })

  it('isPublicUrl', () => {
    expect(isPublicUrl('https://example.com/x')).toBe(true)
    expect(isPublicUrl('https://8.8.8.8/x')).toBe(true)
    for (const u of ['http://10.0.0.1/', 'http://172.20.1.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://a.localhost/', 'ftp://example.com/', 'attachment://x.png', 'nope']) {
      expect(isPublicUrl(u)).toBe(false)
    }
  })
})

describe('附件和贴纸', () => {
  it('每种附件', () => {
    const m = render({
      content: '看附件',
      attachments: [
        { filename: 'a.png', content_type: 'image/png', size: 10, url: 'https://cdn.example.com/a.png', proxy_url: 'https://media.example.net/a.png' },
        { filename: 'b.jpg', url: 'https://cdn.example.com/b.jpg' },
        { filename: 'c.mp4', content_type: 'video/mp4', url: 'https://cdn.example.com/c.mp4' },
        { filename: 'd.ogg', content_type: 'audio/ogg', url: 'https://cdn.example.com/d.ogg' },
        { filename: 'e.zip', content_type: 'application/zip', url: 'https://cdn.example.com/e.zip' },
      ],
    })!
    expect(m.media).toEqual([
      { kind: 'image', urls: ['https://cdn.example.com/a.png', 'https://media.example.net/a.png'], name: 'a.png', size: 10, mime: 'image/png', placeholder: '[图片]' },
      { kind: 'image', urls: ['https://cdn.example.com/b.jpg'], name: 'b.jpg', size: undefined, mime: undefined, placeholder: '[图片]' },
      { kind: 'video', urls: ['https://cdn.example.com/c.mp4'], name: 'c.mp4', size: undefined, mime: 'video/mp4', placeholder: '[视频: c.mp4] https://cdn.example.com/c.mp4' },
    ])
    expect(m.blocks).toEqual(['[音频: d.ogg] https://cdn.example.com/d.ogg\n[文件: e.zip] https://cdn.example.com/e.zip'])
    expect(m.checkText).toContain('e.zip')
    expect(m.checkText).toContain('a.png')
  })

  it('只有附件的消息也转发', () => {
    const m = render({ attachments: [{ filename: 'x.png', content_type: 'image/png', url: 'https://cdn.example.com/x.png' }] })!
    expect(m.body).toBe('')
    expect(m.media).toHaveLength(1)
  })

  it('所有贴纸格式', () => {
    const m = render({
      sticker_items: [
        { id: '11', name: '贴纸一', format_type: 1 },
        { id: '12', name: '贴纸二', format_type: 2 },
        { id: '13', name: '贴纸三', format_type: 3 },
        { id: '14', name: '贴纸四', format_type: 4 },
      ],
    })!
    expect(m.media.map((x) => [x.kind, x.urls, x.placeholder])).toEqual([
      ['image', ['https://cdn.discordapp.com/stickers/11.png'], '[贴纸: 贴纸一]'],
      ['image', ['https://cdn.discordapp.com/stickers/12.png'], '[贴纸: 贴纸二]'],
      ['image', ['https://media.discordapp.net/stickers/14.gif'], '[贴纸: 贴纸四]'],
    ])
    expect(m.blocks).toEqual(['[贴纸: 贴纸三]'])
  })
})

describe('组件消息', () => {
  it('V2 文字和图片', () => {
    const m = render({
      flags: 32768,
      components: [{
        type: 17,
        components: [
          { type: 10, content: '## 公告\n**今晚** 集合' },
          { type: 9, components: [{ type: 10, content: '第二段' }], accessory: { type: 11, media: { url: 'https://example.com/th.png' } } },
          { type: 12, items: [{ media: { url: 'https://example.com/g1.png', proxy_url: 'https://media.example.net/g1.png' } }] },
          { type: 13, file: { url: 'attachment://f.txt' } },
          { type: 1, components: [{ type: 2 }] },
        ],
      }],
    })!
    expect(m.blocks).toEqual(['公告\n今晚 集合\n第二段\n[文件]'])
    expect(m.media.map((x) => x.urls)).toEqual([['https://example.com/th.png'], ['https://media.example.net/g1.png', 'https://example.com/g1.png']])
  })

  it('什么都取不到 → [组件消息]', () => {
    expect(render({ flags: 32768, components: [{ type: 1, components: [{ type: 2 }] }] })!.blocks).toEqual(['[组件消息]'])
    expect(render({ components: [{ type: 1, components: [{ type: 2 }] }] })!.blocks).toEqual(['[组件消息]'])
  })

  it('普通消息下面的按钮不加 [组件消息]', () => {
    expect(render({ content: '点按钮', components: [{ type: 1, components: [{ type: 2 }] }] })!.blocks).toEqual([])
  })
})

describe('转发、公告推送、回复', () => {
  it('转发的消息', () => {
    const m = render({
      message_reference: { type: 1, message_id: '555', channel_id: '444', guild_id: '333' },
      message_snapshots: [{
        message: {
          content: '原文 <@&501> <#601> **重要**',
          embeds: [{ title: '快照 embed' }, { type: 'link', title: '预览' }],
          attachments: [
            { filename: 's.png', content_type: 'image/png', url: 'https://cdn.example.com/s.png' },
            { filename: 's.pdf', content_type: 'application/pdf', url: 'https://cdn.example.com/s.pdf' },
          ],
          sticker_items: [{ id: '21', name: '快照贴纸', format_type: 1 }],
        },
      }],
    })!
    expect(m.reply).toBeUndefined()
    expect(m.blocks).toEqual(['[转发的消息]\n原文 @角色 #集合频道 重要\n\n快照 embed\n\n[文件: s.pdf] https://cdn.example.com/s.pdf'])
    expect(m.media.map((x) => x.urls[0])).toEqual(['https://cdn.example.com/s.png', 'https://cdn.discordapp.com/stickers/21.png'])
    expect(m.checkText).toContain('s.pdf')
  })

  it('转发但快照读不到也照样转发', () => {
    const m = render({ message_reference: { type: 1, message_id: '555' } })!
    expect(m.blocks).toEqual(['[转发的消息]'])
  })

  it('公告频道推送：带 message_reference 但当普通消息', () => {
    const m = render({ content: '推送内容', flags: 2, message_reference: { message_id: '556', channel_id: '445', guild_id: '334' } })!
    expect(m.body).toBe('推送内容')
    expect(m.blocks).toEqual([])
    expect(m.reply).toBeUndefined()
  })

  it('回复', () => {
    const m = render({
      type: 19,
      content: '收到',
      message_reference: { message_id: '777', channel_id: '800' },
      referenced_message: msg({ id: '777', content: '**集合** <@&501>', author: { id: '104', username: 'dave', global_name: '大卫' }, member: undefined }),
    })!
    expect(m.reply).toEqual({ messageId: '777', author: '大卫', content: '集合 @舰队指挥', deleted: false })
  })

  it('回复的原消息已删除', () => {
    const m = render({ type: 19, content: '收到', message_reference: { message_id: '778' }, referenced_message: null })!
    expect(m.reply).toEqual({ messageId: '778', author: '', content: '', deleted: true })
  })

  it('被回复的消息内容为空时的替代文字', () => {
    const ref = (extra: Partial<RawMessage>) => render({
      type: 19, content: 'x', message_reference: { message_id: '779' }, referenced_message: msg({ id: '779', ...extra }),
    })!.reply!.content
    expect(ref({ attachments: [{ filename: 'p.png', content_type: 'image/png', url: 'https://cdn.example.com/p.png' }] })).toBe('[图片]')
    expect(ref({ attachments: [{ filename: 'p.zip', url: 'https://cdn.example.com/p.zip' }] })).toBe('[附件]')
    expect(ref({ embeds: [{ title: '通报' }] })).toBe('[embed 通报]')
  })

  it('非 19 类型的消息不带回复', () => {
    const m = render({ type: 0, content: 'x', message_reference: { message_id: '1' }, referenced_message: null })!
    expect(m.reply).toBeUndefined()
  })
})

describe('collectRefs', () => {
  it('收集正文、embed、被回复消息里的角色和频道，去重；快照里的角色不收集', () => {
    const refs = collectRefs(msg({
      type: 19,
      content: '<@&1> <#2> <@&1>',
      embeds: [{ description: '<@&3>', fields: [{ name: '<#4>', value: '<@&5>' }] }, { type: 'link', description: '<@&9>' }],
      components: [{ type: 10, content: '<@&6>' }],
      referenced_message: msg({ content: '<@&7> <#8>' }),
    }))
    expect(refs.roles.sort()).toEqual(['1', '3', '5', '6', '7'])
    expect(refs.channels.sort()).toEqual(['2', '4', '8'])

    const fwd = collectRefs(msg({
      message_reference: { type: 1 },
      message_snapshots: [{ message: { content: '<@&10> <#11>' } }],
    }))
    expect(fwd).toEqual({ roles: [], channels: ['11'] })
  })
})
