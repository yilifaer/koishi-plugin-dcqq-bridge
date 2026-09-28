import { describe, expect, it } from 'vitest'
import { Context } from 'koishi'

describe('smoke', () => {
  it('loads koishi', () => {
    expect(typeof Context).toBe('function')
  })
})
