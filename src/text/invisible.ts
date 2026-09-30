// 零宽字符（B11）：Discord 舰队 ping 工具会插入大量零宽字符，转发和翻译前删掉。
// 只删 U+200B、U+200C、U+200D、U+2060、U+FEFF；U+200D 夹在两个 emoji 之间时是组合 emoji 的一部分，保留。
// 插件自己为防 ping 插入的零宽空格（清单 §8.3）在发送前才加，不经过这里。

const ALWAYS = /[​‌⁠﻿]/g
// 前面是 emoji（后面可以跟变体选择符、肤色），后面也是 emoji 的 U+200D 才保留
const LONE_ZWJ = /(?<!\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]*)‍|‍(?!\p{Extended_Pictographic})/gu

export function stripZeroWidth(text: string): string {
  return text.replace(ALWAYS, '').replace(LONE_ZWJ, '')
}
