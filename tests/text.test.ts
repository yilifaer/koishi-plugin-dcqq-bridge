import { describe, expect, it } from 'vitest'
import { cutUnits, splitText, takePiece, truncate } from '../src/text/split'
import { deletedReplyLine, prefixFor, replyLine, stripOwnDecorations } from '../src/text/reply'

const hasBrokenPair = (s: string) => /[\uD800-\uDBFF]$/.test(s) || /^[\uDC00-\uDFFF]/.test(s)

describe('splitText', () => {
  it('短文字原样一段，空文字没有段', () => {
    expect(splitText('你好', 10)).toEqual(['你好'])
    expect(splitText('', 10)).toEqual([])
  })

  it('优先在空行切', () => {
    expect(splitText('aaaa\nbb\n\ncccc', 10)).toEqual(['aaaa\nbb', 'cccc'])
  })

  it('没有空行时在换行切', () => {
    expect(splitText('aaaa\nbbbb cccc', 10)).toEqual(['aaaa', 'bbbb cccc'])
  })

  it('没有换行时在句末切，标点留在前一段', () => {
    expect(splitText('一二三。四五六七八九十', 8)).toEqual(['一二三。', '四五六七八九十'])
    expect(splitText('Hi there. Next part', 12)).toEqual(['Hi there.', 'Next part'])
  })

  it('英文句点后面不是空白时不当句末（3.5、网址）', () => {
    expect(splitText('pi is 3.14159 ok', 10)).toEqual(['pi is', '3.14159 ok'])
  })

  it('在空格切，都没有就硬切', () => {
    expect(splitText('aaa bbb ccc', 8)).toEqual(['aaa bbb', 'ccc'])
    expect(splitText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('硬切不切开代理对', () => {
    const text = '😀'.repeat(10)
    for (const limit of [3, 5, 7]) {
      const pieces = splitText(text, limit)
      expect(pieces.join('')).toBe(text)
      for (const p of pieces) {
        expect(p.length).toBeLessThanOrEqual(limit)
        expect(hasBrokenPair(p)).toBe(false)
      }
    }
  })

  it('每段不超过上限，没有空段；firstLimit 只管第一段', () => {
    const text = ('一句话。'.repeat(30) + '\n\n').repeat(5)
    const pieces = splitText(text, 50, 20)
    expect(pieces[0].length).toBeLessThanOrEqual(20)
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(50)
      expect(p).not.toBe('')
    }
  })

  it('takePiece 返回剩余部分', () => {
    expect(takePiece('ab cd', 3)).toEqual(['ab', 'cd'])
  })
})

describe('truncate / cutUnits', () => {
  it('按码点截断并加省略号', () => {
    expect(truncate('😀😀😀', 2)).toBe('😀😀…')
    expect(truncate('abc', 3)).toBe('abc')
  })
  it('cutUnits 不切开代理对', () => {
    expect(cutUnits('a😀', 2)).toBe('a')
  })
})

describe('replyLine / prefixFor', () => {
  it('引用行：内容前 30 字，换行变空格', () => {
    const content = '第一行\n第二行' + '字'.repeat(40)
    const line = replyLine('小明', content)
    expect(line.startsWith('↪ 回复 小明：第一行 第二行')).toBe(true)
    expect(line.endsWith('…')).toBe(true)
    expect(Array.from(line.slice('↪ 回复 小明：'.length, -1)).length).toBe(30)
  })
  it('带链接、没有作者、已删除', () => {
    expect(replyLine('A', 'hi', 'https://discord.com/channels/1/2/3')).toBe('↪ 回复 A：hi · https://discord.com/channels/1/2/3')
    expect(replyLine('', 'hi')).toBe('↪ 回复：hi')
    expect(deletedReplyLine()).toBe('↪ 回复 一条已删除的消息')
  })
  it('前缀', () => {
    expect(prefixFor('测试桥', '小红', false)).toBe('[测试桥 - 小红]')
    expect(prefixFor('', '小红', false)).toBe('[小红]')
    expect(prefixFor('测试桥', '小红', true)).toBe('[测试桥 - 小红（补发）]')
  })
})

describe('stripOwnDecorations', () => {
  const opts = { fallbackText: '【重要】' }
  it('去掉 @全体、前缀行、引用行', () => {
    expect(stripOwnDecorations('@全体成员\n[测试桥 - 小红]\n↪ 回复 A：x\n正文', opts)).toBe('正文')
  })
  it('去掉 fallbackText 和前缀', () => {
    expect(stripOwnDecorations('【重要】 [测试桥 - 小红]\n正文 [图片]', opts)).toBe('正文 [图片]')
  })
  it('Discord 机器人模式的行内前缀（带转义）', () => {
    expect(stripOwnDecorations('\\[测试桥 - 小红\\] 正文', opts)).toBe('正文')
    expect(stripOwnDecorations('[小红] 正文', opts)).toBe('正文')
  })
  it('前缀只去一次，正文里的 [图片] 保留', () => {
    expect(stripOwnDecorations('[小红]\n[图片]', opts)).toBe('[图片]')
  })
})
