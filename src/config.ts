import { Schema } from 'koishi'

// 清单 §0「配置出错的原则」：Schema 校验失败会让整个插件加载失败（cordis 的行为），
// 所以每个字段都只做宽松的类型声明并加 .loose()（类型不对时回退到默认值，而不是报错），具体检查放到运行时（bridges.ts）。

export type Direction = 'both' | 'd2q' | 'q2d'

export interface BridgeRow {
  label: string
  discord: string
  qq: string
  direction: Direction
  enabled: boolean
  atAll: boolean
  blockWords: string
}

export interface AtAllConfig {
  fallbackText: string
  reserve: number
  dailyCap: number
  cooldownMinutes: number
  maxAgeMinutes: number
}

export interface Config {
  discordSelfId: string
  qqSelfId: string
  timezone: string
  discordAsWebhook: boolean
  keepDays: number
  authority: number
  qqReorderMs: number
  bridges: BridgeRow[]
  atAll: AtAllConfig
}

const str = (value = '') => Schema.string().default(value).loose()
const num = (value: number) => Schema.number().default(value).loose()
const bool = (value: boolean) => Schema.boolean().default(value).loose()

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    discordSelfId: str()
      .description('用哪个 Discord 机器人（填机器人的用户 ID）。这个 Koishi 里只有一个 Discord 机器人时留空。'),
    qqSelfId: str()
      .description('用哪个 QQ 机器人（填机器人的 QQ 号）。这个 Koishi 里只有一个 OneBot 机器人时留空。'),
    timezone: str('Asia/Shanghai')
      .description('Discord 时间码换算到哪个时区（IANA 名称，例如 `Asia/Shanghai`）。写错时改用 UTC，并在 `bridge.status` 里提示。'),
    discordAsWebhook: bool(true)
      .description('发到 Discord 时用 webhook 显示 QQ 发送者的名字和头像（机器人需要「管理 Webhook」权限）。关掉后由机器人自己发，消息前面加 `[桥名 - 名字]`。'),
    keepDays: num(7)
      .description('回复对应表保留几天（用来把回复转成对面的回复）。'),
    authority: num(4)
      .description('管理命令（`bridge.status` 等）需要的 Koishi 权限等级。'),
    qqReorderMs: num(0)
      .description('QQ 带回复的消息可能比后面的消息晚一点到。填大于 0 的毫秒数（建议 1000）时，每条 QQ 消息先等这么久，按 QQ 的消息序号排好再转发；0 = 不等待。'),
  }).description('基本'),

  Schema.object({
    bridges: Schema.array(Schema.object({
      label: str().description('桥名（显示在前缀里，可以空）'),
      discord: str().description('Discord 频道 ID'),
      qq: str().description('QQ 群号'),
      direction: Schema.union([
        Schema.const('both' as const).description('双向'),
        Schema.const('d2q' as const).description('Discord → QQ'),
        Schema.const('q2d' as const).description('QQ → Discord'),
      ]).default('both').loose().description('方向'),
      enabled: bool(true).description('启用'),
      atAll: bool(false).description('@全体'),
      blockWords: str().description('屏蔽词（正则，多个用 ;; 分隔）'),
    })).role('table').default([]).loose()
      .description('一行一个桥：连接一个 Discord 频道和一个 QQ 群。一个 Discord 频道要发往两个 QQ 群就写两行。ID 必须是纯数字；写错的行会被跳过，并在 `bridge.status` 里标出来。**@全体** 只对 Discord → QQ 方向有效，只有真正的 @everyone / @here 才会触发。**屏蔽词**：每一条是一个正则表达式（普通的词直接写），不区分大小写，检查正文、embed 和文件名，命中就不转发这条。'),
  }).description('桥'),

  Schema.object({
    atAll: Schema.object({
      fallbackText: str('【全体通知】')
        .description('没能 @全体 时加在消息最前面的文字。'),
      reserve: num(0)
        .description('给人工管理员留几次：群里当天剩余的 @全体 次数不超过这个数时，插件不再 @全体。'),
      dailyCap: num(0)
        .description('每个 QQ 群每天插件最多 @全体 几次，0 = 不另外限制。'),
      cooldownMinutes: num(0)
        .description('同一个 QQ 群两次 @全体 之间至少隔几分钟，0 = 不限制。'),
      maxAgeMinutes: num(10)
        .description('Discord 消息发出超过这么多分钟就不再 @全体（例如断线后补发、网关重放的旧消息）。'),
    }).default({} as AtAllConfig).loose(),
  }).description('@全体'),
]) as Schema<Config>
