# koishi-plugin-dcqq-bridge

A [Koishi](https://koishi.chat/) plugin that bridges **Discord channels** and **QQ groups** (OneBot v11, e.g. LLBot): full embed rendering, Discord timestamp conversion, real @everyone → QQ @全体 mapping with safety checks, ping-safe relaying to Discord (`allowed_mentions`), reply mapping, retries with graceful fallback, backfill after gateway reconnects, and optional machine translation (any OpenAI-compatible API) with keyword/moderation filtering and an EVE Online glossary. Everything optional is off by default.

---

在 **Discord 频道** 和 **QQ 群** 之间转发消息（双向或单向）。

## 功能

- **一行一个桥**：一个 Discord 频道 ↔ 一个 QQ 群，方向可选 双向 / Discord→QQ / QQ→Discord。两个机器人自动识别。
- **Discord → QQ 完整渲染**：直接读 Discord 网关的原始数据，不经过适配器的解析（适配器会把 `<t:…>` 时间码、`<` `>` 之间的文字吞掉）。
  - 用户、角色、频道提及显示成名字；自定义表情显示成 `[名字]`；Markdown 标记去掉、文字保留。
  - embed 的作者、标题、描述、所有字段、页脚、时间戳、图片全部转发。
  - 时间码 9 种样式全部换算成设定的时区。
  - 贴纸、转发的消息、投票、组件消息都有去处。
- **QQ → Discord**：插件自己调用 Discord API。
  - 默认用 webhook 显示 QQ 发送者的名字和头像。
  - 每个请求都带 `allowed_mentions: { parse: [] }`，QQ 用户手打 `<@ID>` 也 ping 不到任何人。
  - 图片先下载再上传（QQ 图片地址会过期）；文件、表情包、合并转发、小程序卡片都显示成文字，不会静默消失。
- **回复**：两边互相回复转过来的消息时，尽量变成真正的回复；做不到时加一行 `↪ 回复 名字：内容`。
- **@全体**（默认关闭，按桥打开）：只有 Discord 上真正的 @everyone / @here 才会在 QQ 上 @全体。
  - 发送前检查机器人是不是管理员、今天还剩几次；支持冷却时间、每日上限、给人工管理员预留次数。
  - 查询失败时一律不 @全体，改成在消息前加文字。
- **失败处理**：
  - 一张图下载失败只换成 `[图片]`，其余照发。
  - 连接失败会重试；被 Discord 限流时整个队列一起等。
  - 可能已经发出去的请求不重发，避免重复消息。
  - 超长消息自动分段。
- **断线补发**：插件运行期间 Discord 网关断线、重新建立会话后，补发断线期间漏掉的消息（最多往回 6 小时、每个频道最多 200 条），前缀标 `（补发）`，补发的消息不会 @全体。插件自己停用、重载或 Koishi 关机后再启动时**不补发**（避免把旧插件已经转过的消息再转一遍）。
- **屏蔽词**：每个桥单独设置，检查正文、embed 和文件名。
- **自动翻译**（默认关闭，按桥打开）：英译中、中译英，原文和【机翻】译文在同一条消息里；支持任何 OpenAI 兼容接口，不预设服务商。翻译失败、超时、被过滤时只发原文。
- **过滤**（默认关闭）：关键词表，外加可选的 OpenAI 审核接口；命中就不附译文，原文照常转发。
- **EVE 术语表**（默认关闭）：插件自带从 CCP 官方数据生成的物品、组别、星系、星域中英文名；可以加载自己的黑话表文件。星系写成 `Jita(吉他)`，`1DQ1-A` 这类代号星系永远不翻。
- **管理命令**：查看状态、暂停（可以只暂停翻译）、恢复、重新读取词表、从旧插件导入配置。

## 安装

1. 在 Koishi 控制台的插件市场搜索 `dcqq-bridge` 并安装。
2. 需要先装好并启用：数据库插件（例如 `database-sqlite`）、Discord 适配器（`@satorijs/adapter-discord`）、OneBot 适配器（`koishi-plugin-adapter-onebot`）。
3. Discord 开发者后台里给机器人打开 **Message Content Intent**，否则收到的消息是空的。
4. 在要转发的 Discord 频道里，给机器人「查看频道」「发送消息」「附加文件」「管理 Webhook」权限。

## 配置

所有配置都在 Koishi 控制台的插件配置页里改，保存后立即生效。某一项写错时，只会影响那一项，不会让整个插件停掉：写错的桥会被跳过，并在 `bridge.status` 里标出来。

### 基本

| 配置项 | 默认 | 说明 |
|---|---|---|
| `discordSelfId` | 空 | 用哪个 Discord 机器人。只有一个时留空 |
| `qqSelfId` | 空 | 用哪个 QQ 机器人。只有一个时留空 |
| `timezone` | `Asia/Shanghai` | Discord 时间码换算到哪个时区。写错时改用 UTC |
| `discordAsWebhook` | 开 | 发到 Discord 时用 webhook 显示 QQ 发送者的名字和头像。关掉后由机器人发，前面加 `[桥名 - 名字]`。webhook 用不了时也会自动改由机器人发 |
| `keepDays` | `7` | 回复对应表保留几天 |
| `authority` | `4` | 管理命令需要的 Koishi 权限等级 |
| `qqReorderMs` | `0` | QQ 带回复的消息可能比后面的消息晚一点到（适配器要先查被回复的消息）。填 `1000` 左右时，每条 QQ 消息先等这么久，按 QQ 的消息序号排好再转发。`0` = 不等待 |
| `maxQueueAgeMinutes` | `15` | 消息在队列里等太久（例如 Discord 长时间连不上）就丢掉不发，单位分钟；`0` = 不限制 |

### 桥（表格，一行一个）

| 列 | 默认 | 说明 |
|---|---|---|
| 桥名 | 空 | 显示在前缀里，可以空 |
| Discord 频道 ID | 空 | 纯数字 |
| QQ 群号 | 空 | 纯数字 |
| 方向 | 双向 | 双向 / Discord → QQ / QQ → Discord |
| 启用 | 开 | |
| @全体 | 关 | 只对 Discord → QQ 方向有效 |
| 屏蔽词 | 空 | 每一条是一个正则表达式（普通的词直接写），不区分大小写，多条用 `;;` 分隔。命中就不转发这条消息 |
| 翻译 | 关 | 还要打开下面「翻译」里的总开关才生效 |

- 一个 Discord 频道要发往两个 QQ 群，就写两行。
- 同一对频道和群写了两行、方向正好相反时，两行都照常工作，`bridge.status` 会建议合成一行「双向」。
- 直接编辑 `koishi.yml` 时，ID 要加引号（`discord: '123…'`），否则会被当成数字并丢掉精度。
- 某一行的方向、启用、@全体、翻译写成了别的值（例如 `D2Q`、`no`）时，这一行整行无效并在 `bridge.status` 里提示，其他行照常工作。

### @全体

| 配置项 | 默认 | 说明 |
|---|---|---|
| `fallbackText` | `【全体通知】` | 没能 @全体 时加在消息最前面的文字 |
| `reserve` | `0` | 给人工管理员留几次：群里当天剩余次数不超过这个数时，插件不再 @全体 |
| `dailyCap` | `0` | 每个 QQ 群每天插件最多用几次，`0` = 不另外限制 |
| `cooldownMinutes` | `0` | 同一个 QQ 群两次 @全体 之间至少隔几分钟 |
| `maxAgeMinutes` | `10` | Discord 消息发出超过这么多分钟就不再 @全体 |

@全体 只在下面这些条件**全部满足**时才会发生：
- 这个桥打开了 @全体，方向包含 Discord → QQ；
- Discord 上是真正 ping 了所有人的 @everyone 或 @here（只写了文字、没有权限 ping 的不算；「静默」发送的也不算；角色 ping 永远只显示成文字）；
- 不是补发的旧消息；
- 没有在冷却中，也没到每日上限；
- 机器人在这个 QQ 群里是群主或管理员；
- QQ 显示还有剩余次数，并且剩余次数大于 `reserve`。

### 翻译

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | 关 | 总开关 |
| `baseURL` | 空 | OpenAI 兼容接口的地址（见下表） |
| `apiKey` | 空 | API key |
| `model` | 空 | 模型名 |
| `label` | `【机翻】` | 译文前的标注。不能为空，为空时自动用「【机翻】」 |
| `timeoutMs` | `6000` | 翻译请求最多等多少毫秒，超过就只发原文 |
| `maxPerHour` | `0` | 每小时最多请求几次，`0` = 不限 |

总开关打开但没填 `baseURL` 或 `model` 时，翻译按关闭处理，`bridge.status` 会显示原因。

服务商示例（只是例子，插件不预设任何一家；地址和模型名以各家官方文档为准）：

| 服务商 | `baseURL` | `model` 例子 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |

必须用服务商的 **API key**。Claude、ChatGPT 这类聊天订阅不能拿来当机器人的后端。

**哪些不翻译**：
- 太短的（例如 `gg`、`@张三 ok`）；
- 已经是目标语言的；
- Koishi 命令（例如查价命令）；
- 命中关键词的。

**不会发给翻译服务商的内容**：用户名、QQ 号、群号、频道名、文件名。提及、网址、时间、代号星系、ISK 数字会先换成占位符，翻译后再换回来。

### 过滤

| 配置项 | 默认 | 说明 |
|---|---|---|
| `keywords` | 空 | 关键词，一行一个，不区分大小写。`re:` 开头的按正则 |
| `keywordFile` | 空 | 可选的关键词文件（相对 Koishi 实例目录），格式同上，`#` 开头是注释 |
| `moderation` | 关 | 用 OpenAI 审核接口检查译文 |
| `moderationBaseURL` | `https://api.openai.com/v1` | 审核接口地址 |
| `moderationApiKey` | 空 | 审核接口的 key。留空时，只有翻译接口也是同一个网站才借用翻译的 key；插件绝不会把别家的 key 发给 OpenAI |

- 原文命中关键词：不翻译；译文命中关键词：不附译文。原文照常转发。
- 英文关键词建议写成 `re:\bword\b`，否则 `ass` 会命中 `class`。
- 审核接口管暴力、仇恨、色情这类内容，**不懂中国的政治敏感词**，那部分只能靠关键词表。
- 审核出错、超时或没有可用的 key 时，译文一律不附（宁可不翻，不发出没经过检查的译文）。
- 仓库里不附任何关键词表，由使用者自己维护。

### 术语表

| 配置项 | 默认 | 说明 |
|---|---|---|
| `eve` | 关 | 使用插件自带的 EVE 官方名称表（`data/eve-glossary.json`） |
| `systemStyle` | `en(zh)` | 有名字的星系、星域、星座在英译中时怎么写：`Jita(吉他)` / `Jita` / `吉他` |
| `slangFile` | 空 | 黑话表文件（YAML，相对 Koishi 实例目录） |
| `overrides` | 空 | 自己加的词条（表格），优先级最高 |

**黑话表格式**见插件自带的 [`data/eve-slang.example.yaml`](data/eve-slang.example.yaml)。每一条：
- `en`、`zh`：标准写法；
- `mode`：`keep` 原样保留 / `force` 一定换成对应的词 / `hint` 只作为参考交给模型；
- `dir`：`both` / `en2zh` / `zh2en`；
- `en_aliases`、`zh_aliases`：其他写法，匹配到时输出标准写法；
- `category`、`note`、`confidence`：只给人看。

黑话表写错时只在日志和 `bridge.status` 里提示，照常转发。改了文件后发送 `bridge.reload` 重新读取。

**匹配规则**：
- 最长的优先；
- 英文要求前后是词的边界，允许末尾多一个 `s`；
- 只有 3 个字母以内的英文词（例如 `FC`、`o7`、`x up`）要求大小写完全一致；
- 官方名称里是常用英语单词的（例如星域 Catch、Domain），只作参考，并且只在首字母大写、不在句首时匹配；
- 两个字以内的官方中文名（例如「吉他」）在中译英时只作参考。

## 管理命令

所有命令都需要达到 `authority` 设置的权限等级。**任何达到这个等级的人都能暂停、恢复、导入**；如果别的插件也需要给人这个等级，考虑把本插件的 `authority` 调高。

| 命令 | 作用 |
|---|---|
| `bridge.status [桥]`（`桥接状态`） | 每个桥的状态：启用、暂停或无效，最近一次转发时间，24 小时转发数和失败数，最近一次失败的原因。@全体 桥还显示今天剩余次数、改发文字的次数和原因。在群里只显示和这个群有关的桥；私聊时加 `-a` 连无效、未启用的行也显示 |
| `bridge.pause [桥]`（`桥接暂停`） | 暂停。不带桥 = 全局暂停，所有转发立即停止。重启后仍然有效。加 `-t` 只暂停翻译，转发照常 |
| `bridge.resume [桥]`（`桥接恢复`） | 恢复；加 `-t` 只恢复翻译 |
| `bridge.reload` | 重新读取关键词文件和黑话表 |
| `bridge.import` | 从 @myrtus/forward 的配置生成桥（只能私聊使用，只输出、不改任何配置） |

「桥」可以写成：`bridge.status` 里的编号、`Discord频道ID:QQ群号`、或桥名。

统计数字只保存在内存里，插件重载后清零；暂停状态保存在数据库里。

## 从 @myrtus/forward 迁移

1. **私聊**机器人发送 `bridge.import`，核对它给出的报告：生成了几个桥、跳过了哪些、为什么跳过，以及行为变化（例如屏蔽词现在不区分大小写、也检查 embed）。
2. 把回复里的 `bridges:` 配置粘进本插件的配置。这份配置也保存在 Koishi 实例目录的 `data/dcqq-bridge/import-<时间>.yaml`。
3. **在同一次保存里**停用 @myrtus/forward、启用本插件。两个插件绝不能同时转发同一个频道，否则每条消息会发两次。
4. 出问题时停用本插件、重新启用旧插件即可。旧插件的配置和数据表本插件都没动过。

## 常见问题

- **QQ 机器人离线，转发不出去**：OneBot 适配器用「正向 WebSocket」连接时，LLBot 重启或断开后不会自动重连。`bridge.status` 会显示「QQ 机器人离线」。解决办法：在 Koishi 控制台重载 onebot 适配器；或者把连接方式改成「反向 WebSocket」（由 LLBot 负责重连）。
- **Discord → QQ 收不到**：确认 Discord 开发者后台打开了 Message Content Intent，并且机器人在频道里有「查看频道」权限。
- **QQ → Discord 显示的是机器人自己的名字**：机器人没有「管理 Webhook」权限，插件已自动改由机器人发送。日志里每小时会提醒一次。
- **QQ 带回复的消息顺序偶尔颠倒**：见 `qqReorderMs`。

## 隐私与合规提示

> 以下不是法律意见。

- 为稳妥起见，译文都带「机器翻译」标注：《人工智能生成合成内容标识办法》2025-09-01 起施行，是否适用于群聊翻译存在争议，所以 `label` 不能为空。
- DeepSeek 开放平台协议 §3.3 把 API 开发者视为服务提供者，§3.4 要求对输入和输出做关键词过滤，关键词表就是用来满足这一条的。打开翻译但关键词表为空时，插件会在启动时提醒。
- 个人信息：把 QQ 群消息发到境外（Discord；打开翻译后还有翻译服务商，开启审核时还有 OpenAI）可能涉及个人信息出境，需要告知群成员并取得单独同意。建议在群公告里列出所有接收方。
- 使用 OpenAI 时，注意它的「支持的国家和地区」条款。
- webhook 模式会把 QQ 头像地址显示在 Discord 上，这个地址里带有 QQ 号。
- QQ 的用户协议禁止第三方客户端和自动发送消息，机器人账号本身就有被限制或封禁的风险。消息越多、@全体 越频繁，风险越高。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

测试用真实的 Koishi、Discord 适配器、OneBot 适配器，加上模拟的 Discord 服务器和模拟的 LLBot，不访问外网。实测步骤见 [docs/测试步骤.md](docs/测试步骤.md)，决策记录见 [DECISIONS.md](DECISIONS.md)。

## 数据来源与许可

**代码**使用 MIT 许可。以下两个数据文件**不属于 MIT**，详见 [`data/NOTICE`](data/NOTICE)：

- `data/eve-glossary.json`：从 CCP 的 EVE Online 静态数据生成，按 [EVE 开发者许可协议](https://developers.eveonline.com/license-agreement) 使用（仅限非商业、非营利用途）。用 `npm run build:glossary` 可以从官方最新数据重新生成。

  © 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.

- `data/common-words.txt`：常用英语单词表，取自 SCOWL（Spell Checker Oriented Word Lists，经 npm 包 wordlist-english）的第 10、20、35 级，按 SCOWL 的许可使用，版权声明原文见 `data/NOTICE`。

## 致谢

- [Koishi](https://koishi.chat/) 和 Satori 适配器。
- @myrtus/koishi-plugin-forward：本插件用来替换它，开发时阅读过它的代码来理解旧的行为，但没有复制它的任何代码（它是 AGPL-3.0 许可）。

## 许可证

[MIT](LICENSE)
