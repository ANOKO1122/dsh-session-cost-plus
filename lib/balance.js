/** Read-only official account balance. Never expose a key or upstream error body. */
export function createBalanceReader(ctx, fetcher = fetch, now = Date.now) {
  let cached, cachedKey, pending, pendingKey
  return async function readBalance() {
    const config = ctx.get('settings')?.get('llm-deepseek')
    if (!config) throw new Error('未找到官方 DeepSeek 适配器配置')
    const environment = ctx.get('launchEnvironment')
    const endpoint = config.baseURL ?? environment?.get?.('DEEPSEEK_BASE_URL')?.value ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
    const url = new URL(endpoint)
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password) {
      throw new Error('当前使用非官方服务地址，不向官方接口发送此凭据')
    }
    const ref = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    const credentials = ctx.get('credentials')
    const key = credentials ? (await credentials.resolve(ref))?.value : environment?.get?.(ref)?.value ?? process.env[ref]
    if (typeof key !== 'string' || !key.trim()) throw new Error('未配置官方 DeepSeek API Key')
    if (cachedKey === key && cached && now() - cached.updatedAt < 15000) return cached
    if (pendingKey === key && pending) return pending
    const request = (async () => {
      const response = await fetcher('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000), redirect: 'error',
      })
      if (!response.ok) throw new Error('官方余额查询失败（HTTP ' + response.status + '）')
      const body = await response.json()
      if (!Array.isArray(body.balance_infos) || typeof body.is_available !== 'boolean') {
        throw new Error('官方余额响应格式异常')
      }
      const balances = body.balance_infos.map(item => {
        if (!['CNY', 'USD'].includes(item.currency)) throw new Error('不支持的余额币种')
        const fields = ['total_balance', 'granted_balance', 'topped_up_balance']
        if (fields.some(field => typeof item[field] !== 'string' || !/^-?\d+(\.\d+)?$/.test(item[field]))) {
          throw new Error('官方余额数值异常')
        }
        return Object.fromEntries(['currency', ...fields].map(field => [field, item[field]]))
      })
      const result = { isAvailable: body.is_available, balances, updatedAt: now() }
      cachedKey = key
      cached = result
      return result
    })()
    pendingKey = key
    pending = request
    try { return await request } finally { if (pending === request) pending = undefined }
  }
}
