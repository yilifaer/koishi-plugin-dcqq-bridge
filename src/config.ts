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
  // 可选：0.4.1 新增，旧的测试配置里没有这个字段，运行时按关闭处理
  qqBackfill?: boolean
}

/** 桥的一行写错时回退到的哨兵：带这个键的行在运行时标成无效（A6）。 */
export const INVALID_ROW_KEY = '__invalidRow'
const INVALID_ROW = { [INVALID_ROW_KEY]: true } as unknown as Required<BridgeRow>

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
  /** 冒号后面的内容不翻译的行首标签，;; 分隔（B10）。 */
  keepValueLabels: string
  /** 加在系统提示词最后的背景说明（U2），多行文字。 */
  context: string
  /** 中译英时保护 QQ 群成员名片里的名字（U7）。 */
  protectMemberNames: boolean
  // 可选：0.4.1 新增，旧的测试配置里没有这个字段，运行时按空处理
  /** 永远不当作名字的词，;; 分隔（V2）。 */
  memberNameIgnore?: string
}

export interface FilterConfig {
  keywords: string
  keywordFile: string
  moderation: boolean
  moderationBaseURL: string
  moderationApiKey: string
  // 可选：0.4.1 新增，旧的测试配置里没有这几个字段，运行时按默认值处理
  /** 审核忽略的类别，;; 分隔，按前缀匹配（V4）。 */
  moderationIgnore?: string
  /** 各类别需要达到的最低分数，`类别=分数`，;; 分隔（V4）。 */
  moderationMinScore?: string
  /** 审核管哪个方向（V5）：both、en2zh、zh2en。 */
  moderationDirections?: 'both' | 'en2zh' | 'zh2en'
}

export interface GlossaryConfig {
  eve: boolean
  systemStyle: 'en(zh)' | 'en' | 'zh'
  slangFile: string
  overrides: Array<{ en: string; zh: string; mode: GlossaryMode; dir: GlossaryDir }>
  // 可选：0.4.0 新增，旧的测试配置里没有这两个字段，运行时按空和 6 处理
  officialUrl?: string
  refreshHours?: number
}

/** 掉线提醒（0.4.1 V10）：全部默认空，空 = 不提醒。 */
export interface AlertConfig {
  /** 提醒发到哪个 Discord 频道（频道 ID）。 */
  discordChannel: string
  /** 提醒私信给哪个 Discord 用户（用户 ID）。 */
  discordUser: string
  /** 掉线超过几分钟才提醒。 */
  afterMinutes: number
  /** Discord 断开时，在哪个 QQ 群里提醒（群号）。 */
  qqGroup: string
}

/** 补发（0.4.1 V11）：QQ 掉线期间 Discord → QQ 的消息，恢复后补发。 */
export interface BackfillConfig {
  /** 只补发最近几分钟的消息，更早的只写日志。 */
  qqOfflineMinutes: number
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
  // 可选：0.4.1 新增，旧的测试配置里没有这两节，运行时按默认值处理
  alert?: AlertConfig
  backfill?: BackfillConfig
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
      qqBackfill: strictBool(false).description('QQ掉线补发'),
    }).default(INVALID_ROW).loose()).role('table').default([]).loose()
      .description('一行一个桥：连接一个 Discord 频道和一个 QQ 群。一个 Discord 频道要发往两个 QQ 群就写两行。ID 必须是纯数字；写错的行会被跳过，并在 `bridge.status` 里标出来。**@全体** 只对 Discord → QQ 方向有效，只有真正的 @everyone / @here 才会触发。**翻译**：还要打开下面「翻译」里的总开关才生效。**屏蔽词**：每一条是一个正则表达式（普通的词直接写），不区分大小写，检查正文、embed 和文件名，命中就不转发这条。**QQ掉线补发**：QQ 机器人没登录或断开时，这个桥 Discord → QQ 的消息先记下来，恢复后补发（时间窗口见下面「补发」）；不勾的桥照旧，QQ 没登录时发送失败就丢。'),
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
      keepValueLabels: str()
        .description('可选：这些标签后面的内容原样保留、不翻译，多个用 `;;` 分隔，不区分大小写。某一行以「标签 + 冒号」开头（例如 `FC Name: 某人`）时，冒号后面到行尾的内容不发给模型；Discord embed 的字段名是这些标签时，整个字段值也不翻译。适合人名、舰队名、语音频道名。'),
      context: Schema.string().role('textarea').default('').loose()
        .description('可选：给模型的背景说明，原样加在系统提示词的最后（英译中、中译英都加）。可以写聊天的场景和常见说法，例如「这是某游戏玩家之间的聊天，X = Y」。README 里有 EVE 用的参考写法。改了以后翻译缓存自动失效。'),
      protectMemberNames: bool(true)
        .description('中译英时，QQ 群成员名片里的名字原样保留、不翻译（例如名片 `[ABC]某角色-小鱼干` 里的「小鱼干」）。只保护 3 个字及以上、含汉字的一段。成员名片每小时在后台更新一次，插件刚启动时的头几条消息可能还没有名片。名片里的交易广告（含「收」「售」「求购」「卖」，或者以「出」开头的一段，例如 `某某-收天使`）不当作名字。'),
      memberNameIgnore: str()
        .description('可选：这些词永远不当作名字（不保护、照常翻译），多个用 `;;` 分隔，不区分大小写，要和名片里的一段完全相同才算。适合名片里正好是普通词的情况，例如 `飞行员;;北极星`。`bridge.status -a` 会显示每个 QQ 群缓存了多少个名字，方便检查。'),
    }).default({} as Required<TranslateConfig>).loose(),
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
      moderationDirections: Schema.union([
        Schema.const('both' as const).description('两个方向'),
        Schema.const('en2zh' as const).description('只审核英译中（Discord → QQ）'),
        Schema.const('zh2en' as const).description('只审核中译英（QQ → Discord）'),
      ]).default('both').loose()
        .description('审核管哪个方向的译文。不审核的方向不送审，也不会因为没有审核密钥而不附译文。Discord → QQ 是把英文译成中文发进国内的 QQ 群，这个方向更需要谨慎；QQ → Discord 的原文本来就一字不差地转过去，审核只决定英文读者看不看得懂。'),
      moderationIgnore: str()
        .description('审核忽略的类别，多个用 `;;` 分隔，**按前缀匹配**：写 `illicit` 同时忽略 `illicit/violent`，写 `violence` 同时忽略 `violence/graphic`。只有不在这里的类别被标记，才算审核未通过。游戏社区建议写 `violence;;illicit`；sexual、hate、self-harm、harassment/threatening 这几类不建议忽略。默认空 = 任何类别被标记都不附译文。'),
      moderationMinScore: str()
        .description('可选：各类别需要达到的最低分数才算被标记，写成 `类别=分数`，多个用 `;;` 分隔，例如 `harassment=0.5`。类别名要完全相同（`harassment` 不影响 `harassment/threatening`）；没写的类别还是看审核结果里被标记的类别。写错的项忽略并在 `bridge.status` 里提示。'),
    }).default({} as Required<FilterConfig>).loose(),
  }).description('过滤'),

  Schema.object({
    alert: Schema.object({
      discordChannel: str()
        .description('QQ 机器人掉线时，往这个 Discord 频道发提醒（填频道 ID，纯数字）。留空 = 不发。'),
      discordUser: str()
        .description('QQ 机器人掉线时，私信提醒这个 Discord 用户（填用户 ID，纯数字；对方要允许接收服务器成员的私信）。留空 = 不发。上面的频道和这一项可以同时填。'),
      afterMinutes: num(10)
        .description('QQ 机器人没登录、或和 LLBot 的连接断开，超过这么多分钟才提醒；同一次掉线只提醒一次，恢复后再发一条恢复通知。Discord 断开超过同样的时间时，在下面的 QQ 群里提醒。'),
      qqGroup: str()
        .description('可选：Discord 机器人断开超过上面的分钟数时，在这个 QQ 群里提醒（填群号，纯数字）。留空 = 不发。'),
    }).default({} as AlertConfig).loose(),
  }).description('掉线提醒'),

  Schema.object({
    backfill: Schema.object({
      qqOfflineMinutes: num(30)
        .description('QQ 掉线补发（桥表格里勾了「QQ掉线补发」的桥）：恢复后只补发最近这么多分钟里的消息，更早的不补，只在日志里写一行。补发的消息前缀带「（补发）」，不 @全体，有译文（受翻译的 `maxPerHour` 限制）。'),
    }).default({} as BackfillConfig).loose(),
  }).description('补发'),

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
        .description('黑话表文件路径（YAML，相对 Koishi 实例目录）。多个文件用 `;;` 分隔，按顺序加载，后面文件里同一个原文的词条覆盖前面的。也可以写网址（`https://` 开头），插件定时下载；一项里用 `||` 分隔备用网址，前一个下载不了就用下一个。格式见插件自带的 `data/eve-slang.example.yaml`。写错时只记错误，照常转发。用 `bridge.reload` 重新读取。'),
      officialUrl: str()
        .description('可选：在线的 EVE 官方名称表网址（JSON），用 `||` 分隔备用网址。留空 = 用插件自带的表。下载到的表检查格式和条数，不对就继续用原来的。要先打开上面的「EVE 官方名称表」才会下载。'),
      refreshHours: num(6)
        .description('在线的黑话表、官方名称表每隔几小时检查一次更新，最长 168（一周），填更大的按 168 算；0 = 只在插件启动和 `bridge.reload` 时检查。没有填网址时这一项不起作用。'),
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
    }).default({} as Required<GlossaryConfig>).loose(),
  }).description('术语表'),
]) as Schema<Config>
