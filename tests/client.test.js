import assert from 'node:assert/strict'
import test from 'node:test'

async function loadClientInternals() {
  let definition
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import(`../lib/client.js?test=${Date.now()}`)
    assert.ok(definition)
    const exports = definition.factory((id) => {
      if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('Fragment') }
      if (id === 'react') return {}
      throw new Error(`unexpected client dependency: ${id}`)
    })
    return exports.internals
  } finally {
    globalThis.window = previousWindow
  }
}

test('frame scheduler coalesces repeated patches and cancels pending work', async () => {
  const internals = await loadClientInternals()
  assert.equal(typeof internals.createFrameScheduler, 'function')

  const callbacks = new Map()
  let nextId = 0
  let applied = 0
  const cancelled = []
  const scheduler = internals.createFrameScheduler(
    (callback) => {
      const id = ++nextId
      callbacks.set(id, () => {
        callbacks.delete(id)
        callback()
      })
      return id
    },
    (id) => {
      cancelled.push(id)
      callbacks.delete(id)
    },
    () => {
      applied += 1
    },
  )

  scheduler.schedule()
  scheduler.schedule()
  assert.equal(callbacks.size, 1)
  callbacks.get(1)()
  assert.equal(applied, 1)

  scheduler.schedule()
  scheduler.dispose()
  assert.deepEqual(cancelled, [2])
  assert.equal(callbacks.size, 0)
})
