/**
 * dsh-session-cost-plus — host face.
 *
 * Reads the current session's zstd-compressed JSONL log and prices every
 * provider-reported usage record using the price that was actually in effect
 * at that record's timestamp. This is what makes a session that crosses the
 * flat → peak/off-peak boundary (or an off-peak → peak boundary) sum both
 * periods correctly instead of applying today's price to the whole session.
 *
 * The client face calls GET /api/dsh-session-cost-plus/session/:id and
 * renders the returned totals.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Vendored pure-JS zstd decoder: handles the concatenated zstd frames DSH
// appends to session.jsonl.zstd (Node's built-in zstd only decodes the first
// frame). Source: https://unpkg.com/fzstd@0.1.1/lib/index.js (MIT).
import fzstd from './vendor/fzstd.cjs'
import { officialCost, VERIFIED_AT } from './pricing.js'
import { createBalanceReader } from './balance.js'

const { decompress } = fzstd

/** Stable Cordis plugin name. */
export const name = 'session-cost-plus'

/** The host webserver must be up before routes can mount. */
export const inject = ['webServer']

/** API prefix exposed to the browser half. */
const API_PREFIX = '/api/dsh-session-cost-plus/session'

const MAX_LOG_CACHE_ENTRIES = 64
const MAX_PATH_CACHE_ENTRIES = 256

/** Insert or refresh one LRU-style Map entry and enforce a hard size limit. */
function setBoundedMapEntry(map, key, value, maxEntries) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive safe integer')
  }
  map.delete(key)
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
}

/** Bounded session-summary cache: avoids retaining every session forever. */
const logCache = new Map()

/** UTC instant the v4 peak/off-peak scheme starts billing (Beijing 2026-08-17 00:00). */
const NEW_PRICING_AT = Date.UTC(2026, 7, 16, 16, 0, 0)

/**
 * DeepSeek official pricing, CNY per 1M tokens.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
const TIERED_PRICES = {
  'deepseek-v4-flash': {
    peak: { hit: 0.1, miss: 3, out: 9 },
    off: { hit: 0.05, miss: 1.5, out: 4.5 },
  },
  'deepseek-v4-pro': {
    peak: { hit: 0.3, miss: 9, out: 27 },
    off: { hit: 0.15, miss: 4.5, out: 13.5 },
  },
}

/** Old flat prices, used for records before NEW_PRICING_AT (and legacy models). */
const FLAT_PRICES = {
  'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 2 },
  'deepseek-v4-pro': { hit: 0.025, miss: 3, out: 6 },
  'deepseek-chat': { hit: 0.5, miss: 2, out: 8 },
  'deepseek-reasoner': { hit: 1, miss: 4, out: 16 },
}

const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Resolve $DSH_HOME, falling back to ~/.dsh. */
function resolveDshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/** Normalize a model id for price-table lookup. */
function normalizeModel(model) {
  if (typeof model !== 'string') return ''
  return model.trim().toLowerCase()
}

/** Resolve the price-table family for a model id. */
function lookupPrice(model) {
  const key = normalizeModel(model)
  if (key.includes('v4-pro') || key.includes('pro')) return { model: 'deepseek-v4-pro', kind: 'tiered' }
  if (key.includes('v4-flash') || key.includes('flash')) return { model: 'deepseek-v4-flash', kind: 'tiered' }
  if (key === 'deepseek-chat' || key.includes('deepseek-chat')) return { model: 'deepseek-chat', kind: 'flat' }
  if (key === 'deepseek-reasoner' || key.includes('deepseek-reasoner')) return { model: 'deepseek-reasoner', kind: 'flat' }
  return { model: DEFAULT_MODEL, kind: 'tiered' }
}

/** Whether a UTC epoch ms falls in Beijing peak hours (9-12, 14-18). */
function isPeakBeijing(time) {
  const bj = new Date(time + 8 * 3600e3)
  const t = bj.getUTCHours() + bj.getUTCMinutes() / 60
  return (t >= 9 && t < 12) || (t >= 14 && t < 18)
}

/** Price one usage record at the scheme effective for its own timestamp. */
function priceRecord(record) {
  const current = officialCost(record)
  if (current !== null) return current
  const key = normalizeModel(record.model)
  if (record.time > 0 && record.time < VERIFIED_AT && Object.hasOwn(FLAT_PRICES, key)) {
    return { ...legacyPriceRecord(record), uncertain: true }
  }
  const fallback = officialCost({ ...record, model: 'deepseek-flash' })
  return fallback === null ? null : { ...fallback, assumedModel: true }
}

/** Retained historical table for reference only; unverified history is not billed. */
function legacyPriceRecord(record) {
  const resolved = lookupPrice(record.model)
  let price
  let period
  if (record.time < NEW_PRICING_AT) {
    price = FLAT_PRICES[resolved.model]
    period = 'flat'
  } else if (resolved.kind === 'flat') {
    price = FLAT_PRICES[resolved.model]
    period = 'flat'
  } else {
    const peak = isPeakBeijing(record.time)
    price = TIERED_PRICES[resolved.model][peak ? 'peak' : 'off']
    period = peak ? 'peak' : 'off'
  }
  const hit = (record.cacheReadTokens || 0) * price.hit
  const miss = ((record.inputTokens || 0) + (record.cacheWriteTokens || 0)) * price.miss
  const out = (record.outputTokens || 0) * price.out
  return {
    period,
    hit: hit / 1e6,
    miss: miss / 1e6,
    out: out / 1e6,
    total: (hit + miss + out) / 1e6,
  }
}

/** Build a bounded locator that reuses validated session-log paths. */
function createSessionLogLocator({
  readDir = readdir,
  statFile = stat,
  maxEntries = MAX_PATH_CACHE_ENTRIES,
} = {}) {
  const pathCache = new Map()

  return {
    async find(sessionsRoot, sessionId) {
      const cached = pathCache.get(sessionId)
      if (cached !== undefined) {
        try {
          const info = await statFile(cached)
          setBoundedMapEntry(pathCache, sessionId, cached, maxEntries)
          return { file: cached, info }
        } catch {
          pathCache.delete(sessionId)
        }
      }

      let cwds
      try {
        cwds = await readDir(sessionsRoot)
      } catch {
        return null
      }
      for (const cwd of cwds) {
        for (const filename of ['session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        const file = join(sessionsRoot, cwd, sessionId, filename)
        try {
          const info = await statFile(file)
          setBoundedMapEntry(pathCache, sessionId, file, maxEntries)
          return { file, info }
        } catch {
          // Try the next cwd slug.
        }
        }
      }
      return null
    },
    delete(sessionId) {
      pathCache.delete(sessionId)
    },
    clear() {
      pathCache.clear()
    },
    get size() {
      return pathCache.size
    },
  }
}

const sessionLogLocator = createSessionLogLocator()

/** Locate one session log, reusing a validated path for subsequent polls. */
async function findSessionLog(sessionsRoot, sessionId) {
  return sessionLogLocator.find(sessionsRoot, sessionId)
}
/** Decompress a zstd session log (all concatenated frames) and decode UTF-8. */
async function readSessionText(file) {
  const bytes = await readFile(file)
  const decoded = decompress(new Uint8Array(bytes))
  return new TextDecoder().decode(decoded)
}

/**
 * Parse a session log into per-(turn, step) usage records.
 * The last usage sample per step wins (assistant/message overrides the chunk
 * sample), matching the harness token-meter projection.
 */
function parseSessionLog(text, sessionId) {
  let provider = ''
  let model = ''
  const byStep = new Map()
  const starts = new Map()
  let attemptIndex = 0

  const stepKey = (turn, step) => `${turn ?? 0}:${step ?? 0}`
  const toCount = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : (fallback ?? 0)

  const recordStep = (data, usage, time, attempt) => {
    const u = usage
    if (typeof u !== 'object' || u === null) return
    const turn = typeof data?.turn === 'number' ? data.turn : 0
    const step = typeof data?.step === 'number' ? data.step : 0
    const baseKey = stepKey(turn, step)
    const key = attempt === undefined ? baseKey : baseKey + ':attempt:' + attempt
    const previous = byStep.get(key)
    byStep.set(key, {
      time: starts.get(baseKey) ?? previous?.time ?? time,
      turn,
      step,
      sessionId,
      provider: data?.message?.source?.provider || provider || previous?.provider || '',
      model: data?.message?.source?.model || model || previous?.model || '',
      inputTokens: toCount(u.inputTokens, previous?.inputTokens),
      cacheReadTokens: toCount(u.cacheReadTokens, previous?.cacheReadTokens),
      cacheWriteTokens: toCount(u.cacheWriteTokens, previous?.cacheWriteTokens),
      outputTokens: toCount(u.outputTokens, previous?.outputTokens),
    })
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event !== 'object' || event === null) continue
    const time = typeof event.time === 'number' ? event.time : 0
    switch (event.type) {
      case 'step/start':
        starts.set(stepKey(event.data?.turn, event.data?.step), time)
        break
      case 'request/context': {
        const data = event.data
        if (typeof data?.model === 'string' && data.model !== '') {
          model = data.model
          if (typeof data.provider === 'string') provider = data.provider
        }
        break
      }
      case 'request/header': {
        const header = event.data?.header
        const config = header?.config
        if (typeof config?.model === 'string' && config.model !== '') {
          model = config.model
          if (typeof config.provider === 'string') provider = config.provider
        }
        break
      }
      case 'assistant/chunk': {
        const data = event.data
        const chunk = data?.chunk
        if (chunk?.type !== 'usage') break
        recordStep(data, chunk.usage, time)
        break
      }
      case 'assistant/message': {
        const data = event.data
        const stream = Array.isArray(data?.stream) ? data.stream : []
        const reported = stream.filter(item => item?.type === 'chunk' && item.chunk?.type === 'usage').at(-1)?.chunk.usage
        recordStep(data, data?.usage ?? reported, time)
        break
      }
      case 'assistant/attempt': {
        const data = event.data
        const stream = Array.isArray(data?.stream) ? data.stream : []
        const reported = stream.filter(item => item?.type === 'chunk' && item.chunk?.type === 'usage').at(-1)?.chunk.usage
        if (reported) {
          // A failed/retried attempt can still report billable usage.
          byStep.delete(stepKey(data?.turn, data?.step))
          recordStep(data, reported, time, ++attemptIndex)
        }
        break
      }
    }
  }

  return [...byStep.values()].sort((a, b) => a.time - b.time)
}

/** Build the priced cost summary for one session log. */
function summarizeRecords(records) {
  const totals = { total: 0, hit: 0, miss: 0, out: 0 }
  let unpricedRecords = 0
  let uncertainRecords = 0
  let assumedModelRecords = 0
  const periodTotals = new Map()
  for (const record of records) {
    const cost = priceRecord(record)
    if (cost === null) { unpricedRecords++; continue }
    if (cost.uncertain) uncertainRecords++
    if (cost.assumedModel) assumedModelRecords++
    totals.total += cost.total
    totals.hit += cost.hit
    totals.miss += cost.miss
    totals.out += cost.out
    const bucket = periodTotals.get(cost.period) ?? { period: cost.period, total: 0, hit: 0, miss: 0, out: 0 }
    bucket.total += cost.total
    bucket.hit += cost.hit
    bucket.miss += cost.miss
    bucket.out += cost.out
    periodTotals.set(cost.period, bucket)
  }
  return {
    ...totals,
    unpricedRecords,
    uncertainRecords,
    assumedModelRecords,
    pricingVerifiedAt: VERIFIED_AT,
    estimate: true,
    periods: [...periodTotals.values()].sort((a, b) => a.total - b.total).reverse(),
  }
}

/** Load and price one session; null when the log is missing/unreadable. */
async function loadSessionCost(sessionsRoot, sessionId) {
  const located = await findSessionLog(sessionsRoot, sessionId)
  if (located === null) {
    logCache.delete(sessionId)
    return null
  }
  const { file, info } = located
  const cached = logCache.get(sessionId)
  if (cached !== undefined
    && cached.file === file
    && cached.mtimeMs === info.mtimeMs
    && cached.size === info.size) {
    setBoundedMapEntry(logCache, sessionId, cached, MAX_LOG_CACHE_ENTRIES)
    return cached.summary
  }
  const text = await readSessionText(file)
  const records = parseSessionLog(text, sessionId)
  const summary = summarizeRecords(records)
  const result = { sessionId, recordCount: records.length, ...summary }
  setBoundedMapEntry(logCache, sessionId, {
    file,
    mtimeMs: info.mtimeMs,
    size: info.size,
    summary: result,
  }, MAX_LOG_CACHE_ENTRIES)
  return result
}

/** Reject traversal, separators, control characters, and unreasonable ids. */
function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId.length <= 200
    && sessionId !== '.'
    && sessionId !== '..'
    && !/[\\/\u0000-\u001F\u007F]/u.test(sessionId)
}

/** Minimal loopback fence: this endpoint exposes local usage/cost facts. */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write a JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Test hooks (pure functions only). */
export const internals = {
  NEW_PRICING_AT,
  TIERED_PRICES,
  FLAT_PRICES,
  DEFAULT_MODEL,
  normalizeModel,
  lookupPrice,
  isPeakBeijing,
  priceRecord,
  parseSessionLog,
  summarizeRecords,
  createSessionLogLocator,
  setBoundedMapEntry,
  isSafeSessionId,
}

/** Mount the session-cost route. */
export function apply(ctx) {
  const sessionsRoot = join(resolveDshHome(), 'sessions')
  const readBalance = createBalanceReader(ctx)

  ctx.effect(() => {
    const offBalance = ctx.webServer.register({
      kind: 'prefix', path: '/api/dsh-session-cost-plus/balance',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET required' })
        try { writeJson(res, 200, { ok: true, ...await readBalance() }) }
        catch (error) {
          // Deliberately never return fetch/credential error details.
          const safe = error instanceof Error && /^(官方|当前|未找到|未配置|不支持)/.test(error.message)
          writeJson(res, 502, { ok: false, error: safe ? error.message : '余额查询失败，请检查网络和凭据配置' })
        }
      },
    })
    const route = {
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const encodedId = url.pathname.startsWith(`${API_PREFIX}/`)
          ? url.pathname.slice(`${API_PREFIX}/`.length)
          : ''
        let sessionId
        try {
          sessionId = decodeURIComponent(encodedId)
        } catch {
          sessionId = ''
        }
        if (!isSafeSessionId(sessionId)) {
          writeJson(res, 400, { ok: false, error: 'valid session id required' })
          return
        }
        try {
          const result = await loadSessionCost(sessionsRoot, sessionId)
          if (result === null) {
            writeJson(res, 404, { ok: false, error: `no such session log: ${sessionId}` })
            return
          }
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'failed to read session log',
          })
        }
      },
    }
    const disposer = ctx.webServer.register(route)
    return () => { disposer(); offBalance() }
  }, 'session-cost-plus: routes')
}
