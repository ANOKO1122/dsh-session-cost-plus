import assert from 'node:assert/strict'
import test from 'node:test'
import { officialCost, PRO_REDIRECT_AT, isPeakBeijing } from '../lib/pricing.js'
import { createBalanceReader } from '../lib/balance.js'
import { internals } from '../lib/index.js'
const usage = { inputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 1000000, outputTokens: 1000000 }
const at = time => Date.parse(time + '+08:00')
test('latest Flash prices, aliases, disjoint input and weekday boundaries', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(officialCost({ ...usage, model, time: at('2026-09-11T14:00:00') }).total, 12.04)
    assert.equal(officialCost({ ...usage, model, time: at('2026-09-12T10:00:00') }).total, 6.02)
  }
  assert.equal(isPeakBeijing(at('2026-09-14T08:59:59')), false)
  assert.equal(isPeakBeijing(at('2026-09-14T09:00:00')), true)
  assert.equal(isPeakBeijing(at('2026-09-14T12:00:00')), false)
  assert.equal(isPeakBeijing(at('2026-09-14T18:00:00')), false)
})
test('Pro redirect uses the announced instant, unknown models are not silently Flash', () => {
  assert.equal(officialCost({ ...usage, model: 'deepseek-v4-pro', time: PRO_REDIRECT_AT - 1 }).total, 45.3)
  assert.equal(officialCost({ ...usage, model: 'deepseek-v4-pro', time: PRO_REDIRECT_AT }).total, 6.02)
  assert.equal(officialCost({ ...usage, model: 'gemini-pro', time: PRO_REDIRECT_AT }), null)
  const summary = internals.summarizeRecords([{ ...usage, model: 'unknown', time: PRO_REDIRECT_AT }])
  assert.equal(summary.unpricedRecords, 1)
  assert.equal(summary.total, 0)
})
test('v3 model source overrides stale header and final usage replaces chunks; uses step start', () => {
  const time = at('2026-09-14T11:59:59')
  const events = [
    { type: 'request/header', time, data: { header: { config: { provider: 'old', model: 'unknown' } } } },
    { type: 'step/start', time, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', time, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1 } } } },
    { type: 'assistant/message', time: time + 5000, data: { turn: 1, step: 1, usage, message: { source: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, stream: [] } },
  ]
  const records = internals.parseSessionLog(events.map(JSON.stringify).join('\n'), 's')
  assert.equal(records.length, 1)
  assert.equal(records[0].time, time)
  assert.equal(records[0].model, 'deepseek-v4-pro')
  assert.equal(records[0].inputTokens, 1000000)
  assert.equal(internals.summarizeRecords(records).total, 45.3)
})
test('locator prefers v3 and retains legacy fallback', async () => {
  const locator = internals.createSessionLogLocator({ readDir: async () => ['cwd'], statFile: async () => ({ size: 1 }) })
  assert.match((await locator.find('root', 'session')).file, /session\.v3\.jsonl\.zstd$/)
})
test('reported retry usage is retained separately from the successful attempt', () => {
  const time = at('2026-09-14T14:00:00')
  const stream = [{ type: 'chunk', time, chunk: { type: 'usage', usage } }]
  const events = [
    { type: 'request/header', time, data: { header: { config: { model: 'deepseek-flash', provider: 'deepseek' } } } },
    { type: 'assistant/attempt', time, data: { turn: 1, step: 1, stream } },
    { type: 'assistant/message', time, data: { turn: 1, step: 1, stream, message: { source: { model: 'deepseek-flash' } } } },
  ]
  const records = internals.parseSessionLog(events.map(JSON.stringify).join('\n'), 's')
  assert.equal(records.length, 2)
  assert.equal(internals.summarizeRecords(records).total, 24.08)
})
test('balance shares in-flight fetch, respects configured credential, cache and key rotation', async () => {
  let key = 'test-key-1', calls = 0, time = 0
  const config = { apiKeyEnv: 'CUSTOM_KEY', baseURL: 'https://api.deepseek.com/v1' }
  const ctx = { get: name => name === 'settings' ? { get: () => config } : { resolve: async ref => {
    assert.equal(ref, 'CUSTOM_KEY'); return { value: key }
  } } }
  const read = createBalanceReader(ctx, async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/user/balance')
    assert.equal(options.headers.Authorization, 'Bearer ' + key)
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2', topped_up_balance: '10.34', extra: 'secret' }] }) }
  }, () => time)
  const [a, b] = await Promise.all([read(), read()])
  assert.deepEqual(a, b); assert.equal(calls, 1)
  assert.ok(!JSON.stringify(a).includes('secret')); assert.ok(!JSON.stringify(a).includes(key))
  await read(); assert.equal(calls, 1)
  time = 15001; await read(); assert.equal(calls, 2)
  key = 'test-key-2'; await read(); assert.equal(calls, 3)
  config.baseURL = 'https://third-party.example/v1'
  await assert.rejects(read, /非官方/); assert.equal(calls, 3)
})
test('balance rejects malformed amounts and hides upstream error bodies', async () => {
  const ctx = { get: name => name === 'settings' ? { get: () => ({}) } : { resolve: async () => ({ value: 'test-key' }) } }
  const read = createBalanceReader(ctx, async () => ({ ok: false, status: 401 }))
  await assert.rejects(read, /HTTP 401/)
})
