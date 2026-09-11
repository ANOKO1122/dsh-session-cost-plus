// CNY / 1M tokens. Verified against the official page on 2026-09-11.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
export const VERIFIED_AT = Date.parse('2026-09-11T03:00:26Z')
export const PRO_REDIRECT_AT = Date.parse('2026-09-14T12:00:00+08:00')
export const CURRENT_PRICES = {
  'deepseek-flash': { peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } },
  'deepseek-v4-pro': { peak: { hit: 0.30, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } },
}
export function isPeakBeijing(time) {
  const bj = new Date(time + 8 * 3600e3)
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60
  return bj.getUTCDay() >= 1 && bj.getUTCDay() <= 5
    && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}
export function officialCost(record) {
  const model = typeof record.model === 'string' ? record.model.trim().toLowerCase() : ''
  const isFlash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)
  const isPro = model === 'deepseek-v4-pro'
  if (!isFlash && !isPro) return null
  if (!Number.isFinite(record.time) || record.time <= 0) return null
  // The current page does NOT state when the old Flash aliases migrated.
  // Do not silently apply today's table to historical aliases.
  if (record.time < VERIFIED_AT && model !== 'deepseek-flash') return null
  const family = isPro && record.time < PRO_REDIRECT_AT ? 'deepseek-v4-pro' : 'deepseek-flash'
  const period = isPeakBeijing(record.time) ? 'peak' : 'off'
  const price = CURRENT_PRICES[family][period]
  const count = value => Number.isFinite(value) && value > 0 ? value : 0
  const hit = count(record.cacheReadTokens) * price.hit / 1e6
  const miss = (count(record.inputTokens) + count(record.cacheWriteTokens)) * price.miss / 1e6
  const out = count(record.outputTokens) * price.out / 1e6
  return { period, hit, miss, out, total: hit + miss + out }
}
