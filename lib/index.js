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

const { decompress } = fzstd

/** Stable Cordis plugin name. */
export const name = 'session-cost-plus'

/** The host webserver must be up before routes can mount. */
export const inject = ['webServer']

/** API prefix exposed to the browser half. */
const API_PREFIX = '/api/dsh-session-cost-plus/session'

/** Simple in-memory session-log cache: avoids re-decompressing unchanged logs on every poll. */
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

/** Locate one session log under a sessions root by scanning cwd slugs. */
async function findSessionLog(sessionsRoot, sessionId) {
  let cwds
  try {
    cwds = await readdir(sessionsRoot)
  } catch {
    return null
  }
  for (const cwd of cwds) {
    const file = join(sessionsRoot, cwd, sessionId, 'session.jsonl.zstd')
    try {
      await stat(file)
      return file
    } catch {
      // Try the next cwd slug.
    }
  }
  return null
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

  const stepKey = (turn, step) => `${turn ?? 0}:${step ?? 0}`
  const toCount = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : (fallback ?? 0)

  const recordStep = (data, usage, time) => {
    const u = usage
    if (typeof u !== 'object' || u === null) return
    const turn = typeof data?.turn === 'number' ? data.turn : 0
    const step = typeof data?.step === 'number' ? data.step : 0
    const key = stepKey(turn, step)
    const previous = byStep.get(key)
    byStep.set(key, {
      time: Math.max(previous?.time ?? 0, time),
      turn,
      step,
      sessionId,
      provider: provider || previous?.provider || '',
      model: model || previous?.model || '',
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
        if (data?.usage === undefined) break
        recordStep(data, data.usage, time)
        break
      }
    }
  }

  return [...byStep.values()].sort((a, b) => a.time - b.time)
}

/** Build the priced cost summary for one session log. */
function summarizeRecords(records) {
  const totals = { total: 0, hit: 0, miss: 0, out: 0 }
  const periodTotals = new Map()
  for (const record of records) {
    const cost = priceRecord(record)
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
    periods: [...periodTotals.values()].sort((a, b) => a.total - b.total).reverse(),
  }
}

/** Load and price one session; null when the log is missing/unreadable. */
async function loadSessionCost(sessionsRoot, sessionId) {
  const file = await findSessionLog(sessionsRoot, sessionId)
  if (file === null) {
    logCache.delete(sessionId)
    return null
  }
  let info
  try {
    info = await stat(file)
  } catch {
    logCache.delete(sessionId)
    return null
  }
  const cached = logCache.get(sessionId)
  if (cached !== undefined
    && cached.file === file
    && cached.mtimeMs === info.mtimeMs
    && cached.size === info.size) {
    return cached.summary
  }
  const text = await readSessionText(file)
  const records = parseSessionLog(text, sessionId)
  const summary = summarizeRecords(records)
  const result = { sessionId, recordCount: records.length, ...summary }
  logCache.set(sessionId, {
    file,
    mtimeMs: info.mtimeMs,
    size: info.size,
    summary: result,
  })
  return result
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
}

/** Mount the session-cost route. */
export function apply(ctx) {
  const sessionsRoot = join(resolveDshHome(), 'sessions')

  ctx.effect(() => {
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
        const id = url.pathname.slice(`${API_PREFIX}/`.length)
        if (id === '') {
          writeJson(res, 400, { ok: false, error: 'session id required' })
          return
        }
        try {
          const result = await loadSessionCost(sessionsRoot, decodeURIComponent(id))
          if (result === null) {
            writeJson(res, 404, { ok: false, error: `no such session log: ${id}` })
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
    return () => { disposer() }
  }, 'session-cost-plus: routes')
}
