import { Schema } from 'koishi'

// 清单 §0「配置出错的原则」：Schema 校验失败会让整个插件加载失败（cordis 的行为），
// 所以每个字段都只做宽松的类型声明并加 .loose()（类型不对时回退到默认值，而不是报错），具体检查放到运行时（bridges.ts）。
// 例外：桥的每一行整体 loose（A6）。方向和几个开关不单独 loose，写错时整行回退成 INVALID_ROW，由运行时标成无效；
// 行仍是 Schema.object，控制台表格照常可编辑。

export type Direction = 'both' | 'd2q' | 'q2d'

export interface BridgeRow {
  label: string
  discord: string
  qq: string
  direction: Direction
  enabled: boolean
  atAll: boolean
  blockWords: string
  translate: boolean
}

/** 桥的一行写错时回退到的哨兵：带这个键的行在运行时标成无效（A6）。 */
export const INVALID_ROW_KEY = '__invalidRow'
const INVALID_ROW = { [INVALID_ROW_KEY]: true } as unknown as BridgeRow

export interface AtAllConfig {
  fallbackText: string
  reserve: number
  dailyCap: number
  cooldownMinutes: number
  maxAgeMinutes: number
}

export type GlossaryMode = 'keep' | 'force' | 'hint'
export type GlossaryDir = 'both' | 'en2zh' | 'zh2en'

export interface TranslateConfig {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  label: string
  timeoutMs: number
  maxPerHour: number
  /** JSON 对象字符串，合并进请求体（B7）。 */
  extraBody: string
  /** 不算命令的词，;; 分隔（B9）。 */
  notCommands: string
}

export interface FilterConfig {
  keywords: string
  keywordFile: string
  moderation: boolean
  moderationBaseURL: string
  moderationApiKey: string
}

export interface GlossaryConfig {
  eve: boolean
  systemStyle: 'en(zh)' | 'en' | 'zh'
  slangFile: string
  overrides: Array<{ en: string; zh: string; mode: GlossaryMode; dir: GlossaryDir }>
}

export interface Config {
  discordSelfId: string
  qqSelfId: string
  timezone: string
  discordAsWebhook: boolean
  keepDays: number
  authority: number
  qqReorderMs: number
  // 可选：旧的测试配置里没有这个字段，运行时按 15 处理
  maxQueueAgeMinutes?: number
  bridges: BridgeRow[]
  atAll: AtAllConfig
  translate: TranslateConfig
  filter: FilterConfig
  glossary: GlossaryConfig
}

const str = (value = '') => Schema.string().default(value).loose()
const num = (value: number) => Schema.number().default(value).loose()
const bool = (value: boolean) => Schema.boolean().default(value).loose()
// 不加 loose：写错时让整行失败（只用在桥的行里）
const strictBool = (value: boolean) => Schema.boolean().default(value)

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
    maxQueueAgeMinutes: num(15)
      .description('消息在队列里等太久（例如 Discord 长时间连不上）就丢掉，不再发出，单位分钟；0 = 不限制。'),
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
      ]).default('both').description('方向'),
      enabled: strictBool(true).description('启用'),
      atAll: strictBool(false).description('@全体'),
      blockWords: str().description('屏蔽词（正则，多个用 ;; 分隔）'),
      translate: strictBool(false).description('翻译'),
    }).default(INVALID_ROW).loose()).role('table').default([]).loose()
      .description('一行一个桥：连接一个 Discord 频道和一个 QQ 群。一个 Discord 频道要发往两个 QQ 群就写两行。ID 必须是纯数字；写错的行会被跳过，并在 `bridge.status` 里标出来。**@全体** 只对 Discord → QQ 方向有效，只有真正的 @everyone / @here 才会触发。**翻译**：还要打开下面「翻译」里的总开关才生效。**屏蔽词**：每一条是一个正则表达式（普通的词直接写），不区分大小写，检查正文、embed 和文件名，命中就不转发这条。'),
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

  Schema.object({
    translate: Schema.object({
      enabled: bool(false)
        .description('翻译总开关。打开后，表格里勾了「翻译」的桥会在原文后面附上机器翻译（英译中、中译英）。翻译失败或超时就只发原文。'),
      baseURL: str()
        .description('OpenAI 兼容接口的地址，例如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`。插件不预设任何服务商。'),
      apiKey: Schema.string().role('secret').default('').loose()
        .description('API key。只填在这里，不要发给任何人。'),
      model: str()
        .description('模型名。推荐不带推理（思考）的模型，例如 `gpt-4.1-mini`、`gpt-4o-mini`、`deepseek-chat`；推理模型慢，容易超时。'),
      label: str('【机翻】')
        .description('译文前的标注，不能为空（为空时自动用「【机翻】」）。'),
      timeoutMs: num(6000)
        .description('翻译请求最多等多少毫秒，超过就只发原文。'),
      maxPerHour: num(0)
        .description('每小时最多请求几次，0 = 不限。超过就只发原文。'),
      extraBody: Schema.string().role('textarea').default('').loose()
        .description('可选：额外合并进请求体的字段，写成 JSON 对象，例如 `{"max_tokens": 1000}`。不能覆盖 `model` 和 `messages`。写错时忽略，并在 `bridge.status` 里提示。'),
      notCommands: str('help')
        .description('这些词开头的消息不当作命令（照常翻译），多个用 `;;` 分隔，不区分大小写。只有第一个词是命令、并且整条消息不超过 3 个词时才当作命令不翻译。'),
    }).default({} as TranslateConfig).loose(),
  }).description('翻译'),

  Schema.object({
    filter: Schema.object({
      keywords: Schema.string().role('textarea').default('').loose()
        .description('关键词，一行一个，不区分大小写。`re:` 开头的按正则（英文词建议写成 `re:\\bword\\b`）。原文命中就不翻译，译文命中就不附译文；不影响原文转发。'),
      keywordFile: str()
        .description('可选：关键词文件路径（相对 Koishi 实例目录），格式同上，`#` 开头是注释。用 `bridge.reload` 重新读取。'),
      moderation: bool(false)
        .description('用 OpenAI 审核接口检查译文，被标记就不附译文。出错、超时或没有可用的 key 时也不附译文。'),
      moderationBaseURL: str('https://api.openai.com/v1')
        .description('审核接口地址（只有 OpenAI 提供这个接口）。'),
      moderationApiKey: Schema.string().role('secret').default('').loose()
        .description('审核接口的 key。留空时，只有当翻译接口地址和审核接口地址完全相同（协议、主机、端口、路径）时才借用翻译的 key；否则必须填，插件绝不会把别家的 key 发给 OpenAI。'),
    }).default({} as FilterConfig).loose(),
  }).description('过滤'),

  Schema.object({
    glossary: Schema.object({
      eve: bool(false)
        .description('使用插件自带的 EVE 官方名称表（物品、组别、类别、星系、星域、星座的中英文名）。'),
      systemStyle: Schema.union([
        Schema.const('en(zh)' as const).description('Jita(吉他)'),
        Schema.const('en' as const).description('Jita'),
        Schema.const('zh' as const).description('吉他'),
      ]).default('en(zh)').loose()
        .description('有名字的星系、星域、星座在英译中时怎么写。代号星系（例如 1DQ1-A）永远不翻。'),
      slangFile: str()
        .description('黑话表文件路径（YAML，相对 Koishi 实例目录）。格式见插件自带的 `data/eve-slang.example.yaml`。写错时只记错误，照常转发。用 `bridge.reload` 重新读取。'),
      overrides: Schema.array(Schema.object({
        en: str().description('英文'),
        zh: str().description('中文'),
        mode: Schema.union([
          Schema.const('force' as const).description('强制替换'),
          Schema.const('keep' as const).description('原样保留'),
          Schema.const('hint' as const).description('只作参考'),
        ]).default('force').loose().description('模式'),
        dir: Schema.union([
          Schema.const('both' as const).description('双向'),
          Schema.const('en2zh' as const).description('英译中'),
          Schema.const('zh2en' as const).description('中译英'),
        ]).default('both').loose().description('方向'),
      })).role('table').default([]).loose()
        .description('自己加的词条，优先级最高。'),
    }).default({} as GlossaryConfig).loose(),
  }).description('术语表'),
]) as Schema<Config>
