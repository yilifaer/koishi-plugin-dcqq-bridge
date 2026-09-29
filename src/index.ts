import { Context } from 'koishi'
import { registerCommands } from './commands'
import { Config } from './config'
import { extendModels } from './store'
import { Relay } from './relay'

export const name = 'dcqq-bridge'

// 数据库：回复对应表、暂停状态、@全体 计数；没有数据库时 Koishi 的权限检查会失效，所以必须有
export const inject = { required: ['database', 'http'] }

export { Config }

export const usage = `
在 **Discord 频道** 和 **QQ 群**（OneBot，例如 LLBot）之间转发消息。

- 在下面的「桥」表格里一行填一对：Discord 频道 ID、QQ 群号、方向。ID 必须是纯数字。
- 发到 Discord 默认用 webhook 显示 QQ 发送者的名字和头像，机器人需要「管理 Webhook」权限。
- 私聊机器人发送 \`bridge.status\` 查看状态；\`bridge.pause\` 立即暂停所有转发（加 \`-t\` 只暂停翻译）。
- 翻译、过滤、EVE 术语表默认全部关闭，需要时在下面打开；打开翻译前请先读 README 里的合规提示。
- 从 @myrtus/forward 迁移：私聊机器人发送 \`bridge.import\`，把生成的配置粘进来，并在**同一次保存**里停用旧插件。

详细说明见 [README](https://github.com/yilifaer/koishi-plugin-dcqq-bridge#readme)。
`

export function apply(ctx: Context, config: Config) {
  extendModels(ctx)
  const relay = new Relay(ctx, config)
  relay.install()
  registerCommands(ctx, relay)
}
