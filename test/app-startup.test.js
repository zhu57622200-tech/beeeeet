import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('App first-screen startup', () => {
  it('load failure surfaces a retryable state instead of being silently swallowed', () => {
    const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

    expect(source).not.toContain('load().catch(() => {})')
    expect(source).toContain('firstLoadError')
    expect(source).toContain('retryFirstLoad')
    expect(source).toContain('@click="retryFirstLoad"')
    expect(source).toContain('网络连接不稳定')
  })
})
