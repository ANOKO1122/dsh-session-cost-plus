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
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('Fragment') }
      if (id === 'react') return {}
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: 'DSH-Button' }
      throw new Error(`unexpected client dependency: ${id}`)
    })
    return exports.internals
  } finally {
    globalThis.window = previousWindow
  }
}

test('compact footer combines totals and preserves native DSH refresh action', async () => {
  const { CompactFooter } = await loadClientInternals()
  let refreshed = 0
  const cost = { groups: ['费用 ≈¥2.358793', '命中 ¥0.763553', '未命中 ¥0.461184', '输出 ¥1.134056'], hasEstimateNote: false }
  const view = CompactFooter({
    cost,
    state: { isAvailable: true, updatedAt: Date.now(), balances: [{ currency: 'CNY', total_balance: '343.66', topped_up_balance: '343.66', granted_balance: '0.00' }] },
    error: '', busy: false, onRefresh: () => refreshed++,
  })
  assert.equal(view.props.style.flexWrap, 'wrap')
  assert.equal(view.props.style.color, 'var(--dsw-alias-label-tertiary)')
  const button = view.props.children.find(node => node?.type === 'DSH-Button')
  assert.equal(button.props.variant, 'ghost')
  assert.equal(button.props.size, 'sm')
  button.props.onClick()
  assert.equal(refreshed, 1)
  assert.ok(JSON.stringify(view).includes('¥343.66'))
  const disclosure = view.props.children.find(node => node?.type === 'details')
  assert.equal(disclosure.props.open, undefined)
  const panel = disclosure.props.children[1]
  assert.equal(panel.props.style.position, 'absolute')
  assert.equal(panel.props.style.bottom, 'calc(100% + 6px)')
  assert.ok(JSON.stringify(panel).includes('命中 ¥0.763553'))
  assert.ok(JSON.stringify(panel).includes('赠送 ¥0.00'))
  const collapsed = view.props.children.filter(node => node?.type !== 'details').map(node => node?.props?.children)
  assert.ok(!JSON.stringify(collapsed).includes('命中'))
  assert.ok(!JSON.stringify(collapsed).includes('充值'))
  const failed = CompactFooter({ cost, state: null, error: '网络失败', busy: true, onRefresh() {} })
  assert.ok(JSON.stringify(failed).includes('查询失败'))
  assert.equal(failed.props.children.find(node => node?.type === 'DSH-Button').props.disabled, true)
  const stale = CompactFooter({ cost: { ...cost, hasEstimateNote: true }, state: { balances: [], isAvailable: true, updatedAt: Date.now() }, error: '网络失败', busy: false, onRefresh() {} })
  assert.ok(stale.props.children[0].props.children.endsWith(' *'))
  assert.ok(JSON.stringify(stale).includes('余额未更新'))
  let focused = false
  const target = { open: true, querySelector: () => ({ focus: () => { focused = true } }) }
  disclosure.props.onKeyDown({ key: 'Escape', currentTarget: target })
  assert.equal(target.open, false)
  assert.equal(focused, true)
})

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
