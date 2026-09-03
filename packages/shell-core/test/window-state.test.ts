import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  closeWindowAction,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  minWindowSizeFor,
  parseSavedWindowState,
  readWindowState,
  restoreWindowState,
  writeWindowState,
  type Rect,
} from '../src/window-state.js'

const primary: Rect = { x: 0, y: 0, width: 1440, height: 900 }
const secondary: Rect = { x: 1440, y: 100, width: 1920, height: 1080 }

describe('restoreWindowState', () => {
  it('returns the default 1280x820 bounds when no state was saved', () => {
    const restored = restoreWindowState(undefined, [primary])
    expect(restored).toEqual({
      bounds: { x: 0, y: 0, width: 1280, height: 820 },
      maximized: false,
    })
  })

  it('restores a valid saved state inside the primary work area', () => {
    const saved = { bounds: { x: 120, y: 60, width: 1000, height: 700 }, maximized: false }
    expect(restoreWindowState(saved, [primary])).toEqual(saved)
  })

  it('pulls an off-screen window back onto the primary display', () => {
    const restored = restoreWindowState(
      { bounds: { x: 9000, y: 9000, width: 1280, height: 820 }, maximized: false },
      [primary],
    )
    expect(restored.bounds.x).toBeGreaterThanOrEqual(0)
    expect(restored.bounds.y).toBeGreaterThanOrEqual(0)
    expect(restored.bounds.x + restored.bounds.width).toBeLessThanOrEqual(primary.width)
    expect(restored.bounds.y + restored.bounds.height).toBeLessThanOrEqual(primary.height)
  })

  it('keeps a window that still intersects a disconnected secondary display on the primary', () => {
    const restored = restoreWindowState(
      { bounds: { x: 1500, y: 200, width: 1280, height: 820 }, maximized: false },
      [primary],
    )
    expect(restored.bounds.x + restored.bounds.width).toBeLessThanOrEqual(primary.width)
  })

  it('restores onto the secondary display when the window still intersects it', () => {
    const restored = restoreWindowState(
      { bounds: { x: 1600, y: 300, width: 1280, height: 820 }, maximized: false },
      [primary, secondary],
    )
    expect(restored.bounds.x).toBeGreaterThanOrEqual(secondary.x)
    expect(restored.bounds.x + restored.bounds.width).toBeLessThanOrEqual(
      secondary.x + secondary.width,
    )
  })

  it('enforces the 900x600 minimum on illegal sizes', () => {
    const restored = restoreWindowState(
      { bounds: { x: 0, y: 0, width: 10, height: -5 }, maximized: false },
      [primary],
    )
    expect(restored.bounds.width).toBe(MIN_WINDOW_SIZE.width)
    expect(restored.bounds.height).toBe(MIN_WINDOW_SIZE.height)
  })

  it('enforces the minimum against non-finite dimensions', () => {
    const restored = restoreWindowState(
      {
        bounds: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: Number.NaN },
        maximized: false,
      },
      [primary],
    )
    expect(restored.bounds.width).toBeLessThanOrEqual(primary.width)
    expect(restored.bounds.height).toBeLessThanOrEqual(primary.height)
  })

  it('clamps the default size to a work area smaller than the default', () => {
    const small: Rect = { x: 0, y: 0, width: 800, height: 500 }
    const restored = restoreWindowState(undefined, [small])
    expect(restored.bounds.width).toBeLessThanOrEqual(small.width)
    expect(restored.bounds.height).toBeLessThanOrEqual(small.height)
  })

  it('clamps oversized saved windows into the work area', () => {
    const restored = restoreWindowState(
      { bounds: { x: 0, y: 0, width: 4000, height: 3000 }, maximized: false },
      [primary],
    )
    expect(restored.bounds.width).toBe(primary.width)
    expect(restored.bounds.height).toBe(primary.height)
  })

  it('rounds positions and sizes to integers', () => {
    const restored = restoreWindowState(
      { bounds: { x: 10.4, y: 20.6, width: 100.5, height: 200.5 }, maximized: false },
      [primary],
    )
    expect(Number.isInteger(restored.bounds.x)).toBe(true)
    expect(Number.isInteger(restored.bounds.y)).toBe(true)
    expect(Number.isInteger(restored.bounds.width)).toBe(true)
    expect(Number.isInteger(restored.bounds.height)).toBe(true)
  })

  it('preserves the maximized flag with the saved normal bounds', () => {
    const saved = { bounds: { x: 40, y: 40, width: 1100, height: 750 }, maximized: true }
    expect(restoreWindowState(saved, [primary])).toEqual(saved)
  })

  it('falls back to the default state without any work areas', () => {
    expect(restoreWindowState(undefined, [])).toEqual({
      bounds: { x: 0, y: 0, width: DEFAULT_WINDOW_SIZE.width, height: DEFAULT_WINDOW_SIZE.height },
      maximized: false,
    })
  })
})

describe('parseSavedWindowState', () => {
  it('accepts a well-formed persisted state', () => {
    expect(
      parseSavedWindowState({ bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: true }),
    ).toEqual({ bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: true })
  })

  it('rejects shapes with missing or non-numeric fields', () => {
    expect(parseSavedWindowState(null)).toBeUndefined()
    expect(parseSavedWindowState('x')).toBeUndefined()
    expect(parseSavedWindowState({})).toBeUndefined()
    expect(parseSavedWindowState({ bounds: { x: 'a', y: 0, width: 1, height: 1 } })).toBeUndefined()
    expect(
      parseSavedWindowState({ bounds: { x: 0, y: 0, width: 1 }, maximized: false }),
    ).toBeUndefined()
    expect(
      parseSavedWindowState({ bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: 'yes' }),
    ).toBeUndefined()
  })
})

describe('window-state persistence', () => {
  it('persists only bounds and maximized through an atomic write', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-window-state-'))
    const file = path.join(dir, 'window-state.json')
    try {
      await writeWindowState(file, {
        bounds: { x: 8, y: 16, width: 1024, height: 768 },
        maximized: true,
      })
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      expect(Object.keys(raw).sort()).toEqual(['bounds', 'maximized'])
      expect(await readWindowState(file)).toEqual({
        bounds: { x: 8, y: 16, width: 1024, height: 768 },
        maximized: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats corrupt or missing files as absent state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-window-state-'))
    try {
      const missing = path.join(dir, 'missing.json')
      expect(await readWindowState(missing)).toBeUndefined()
      const corrupt = path.join(dir, 'corrupt.json')
      await writeFile(corrupt, '{not json', 'utf8')
      expect(await readWindowState(corrupt)).toBeUndefined()
      const wrongShape = path.join(dir, 'wrong.json')
      await writeFile(wrongShape, '{"bounds":1}', 'utf8')
      expect(await readWindowState(wrongShape)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('minWindowSizeFor', () => {
  it('keeps the standard minimum on normal displays', () => {
    expect(
      minWindowSizeFor({
        bounds: { x: 0, y: 0, width: 1280, height: 820 },
        maximized: false,
      }),
    ).toEqual(MIN_WINDOW_SIZE)
  })

  it('relaxes to a restored window that legitimately fits a smaller work area', () => {
    expect(
      minWindowSizeFor({
        bounds: { x: 0, y: 0, width: 800, height: 500 },
        maximized: false,
      }),
    ).toEqual({ width: 800, height: 500 })
  })
})

describe('closeWindowAction', () => {
  it('hides while the session is running and closes while quitting', () => {
    expect(closeWindowAction(false)).toBe('hide')
    expect(closeWindowAction(true)).toBe('close')
  })
})
