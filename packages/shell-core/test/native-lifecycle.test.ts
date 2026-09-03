import { describe, expect, it } from 'vitest'

import { RendererReloadBudget, shouldAutoReloadRenderer } from '../src/native-lifecycle.js'

describe('shouldAutoReloadRenderer', () => {
  it('reloads a crashed live surface once', () => {
    expect(
      shouldAutoReloadRenderer({ reloadsUsed: 0, hostSurfaceAlive: true, quitting: false }),
    ).toBe('reload')
  })

  it('refuses a second reload of the same surface', () => {
    expect(
      shouldAutoReloadRenderer({ reloadsUsed: 1, hostSurfaceAlive: true, quitting: false }),
    ).toBe('recovery')
  })

  it('never reloads while quitting or without a live Host surface', () => {
    expect(
      shouldAutoReloadRenderer({ reloadsUsed: 0, hostSurfaceAlive: true, quitting: true }),
    ).toBe('recovery')
    expect(
      shouldAutoReloadRenderer({ reloadsUsed: 0, hostSurfaceAlive: false, quitting: false }),
    ).toBe('recovery')
  })
})

describe('RendererReloadBudget', () => {
  it('grants exactly one reload per loaded surface', () => {
    const budget = new RendererReloadBudget()
    budget.noteSurfaceLoaded()
    expect(budget.consumeIfAvailable({ hostSurfaceAlive: true, quitting: false })).toBe(true)
    expect(budget.consumeIfAvailable({ hostSurfaceAlive: true, quitting: false })).toBe(false)
    // A fresh surface (Host restart or retry) earns a fresh budget.
    budget.noteSurfaceLoaded()
    expect(budget.consumeIfAvailable({ hostSurfaceAlive: true, quitting: false })).toBe(true)
  })

  it('does not consume the budget when the surface is dead or quitting', () => {
    const budget = new RendererReloadBudget()
    budget.noteSurfaceLoaded()
    expect(budget.consumeIfAvailable({ hostSurfaceAlive: false, quitting: false })).toBe(false)
    expect(budget.consumeIfAvailable({ hostSurfaceAlive: true, quitting: true })).toBe(false)
    expect(budget.reloadsUsed).toBe(0)
  })

  it('counts reloads only after a surface was loaded', () => {
    const budget = new RendererReloadBudget()
    expect(budget.reloadsUsed).toBe(0)
    expect(budget.consumeIfAvailable({ hostSurfaceAlive: true, quitting: false })).toBe(false)
  })
})
