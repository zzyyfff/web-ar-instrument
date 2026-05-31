import { describe, expect, it } from 'vitest'

/**
 * Scaffold smoke test — proves the Vitest harness runs end-to-end in CI from
 * commit 1. The real golden tests (gyro-locar pose, quat conventions,
 * recording-decoder compatibility) arrive with the instrument core in P1.
 */
describe('scaffold', () => {
  it('runs the test harness', () => {
    expect(1 + 1).toBe(2)
  })
})
