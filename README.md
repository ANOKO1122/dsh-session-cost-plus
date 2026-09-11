# dsh-session-cost-plus

DSH Web 会话费用估算 + 当前官方 DeepSeek API Key 所属账户余额。v0.2.2 适配 Harness 0.1.5-alpha.1。

## 功能

- 输入框下用一条紧凑栏显示「总费用 · 官方余额 · 明细 · 刷新」，费用保留六位小数。保留 Harness 原生统计行，正常桌面宽度下底部从三行减为两行。
- 点击「明细」向上展开缓存命中/未命中/输出费用、充值/赠送余额、更新时间和计价说明；明细不增加底部高度，支持键盘展开、Escape 收起。窄窗口允许换行。
- 优先读取新版 `session.v3.jsonl.zstd`，兼容旧版日志及串联 zstd 帧；读取实际消息来源中的模型，最终 usage 覆盖流中间值，有 usage 的失败/重试单独计算。
- 每个 step 使用开始时间近似请求计费时间，跨峰谷分别计算；不把 reasoning tokens 重复加到输出。
- 缺失或无法识别的模型默认按 V4.1 Flash 计入费用；主栏用 * 提示估算假设，明细中显示“按 Flash 估算”条数。有有效请求时间时沿用峰谷规则。已识别模型的历史计价逻辑不变。费用是官方参考价估算，不代表第三方服务实际账单。
- 历史已知模型保留旧表估算，并明确显示历史价格未确认。官方当前页面没有给出旧 Flash 别名迁移的精确时刻；不能保证重建准确的历史账单。
- 保留缓存命中两位小数、统计条不截断、DOM 帧合并和有界日志缓存。
- 新增官方账户余额：总额、充值/赠送额、币种、账户可用状态、更新时间、刷新按钮；新会话尚无 token 也可看到。
- 余额栏使用 DSH 原生小号 ghost 按钮、主题文字颜色与紧凑统计布局，跟随深浅主题，窄窗口自动换行。
- 页面可见时每 30 秒刷新余额，服务端最多缓存 15 秒并合并并发请求；刷新失败明确标记旧数据，不假装实时成功。

## 官方当前价格

来源：[DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，核对于 2026-09-11 11:00:26（北京时间）。

| 模型 | 时段 | 缓存命中 ¥/百万 | 未命中 ¥/百万 | 输出 ¥/百万 |
| --- | --- | ---: | ---: | ---: |
| deepseek-flash（V4.1） | 高峰 | 0.04 | 2 | 8 |
| deepseek-flash（V4.1） | 空闲 | 0.02 | 1 | 4 |
| deepseek-v4-pro | 高峰 | 0.30 | 9 | 27 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |

高峰是北京时间**周一至周五 09:00–12:00、14:00–18:00**，其余时间为空闲。
旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 当前按 Flash 价格。
2026-09-14 12:00 起，按官方已公布安排，旧 Pro 名请求也按 Flash 价格计算。
核对时刻之前的旧名称历史记录保留旧表并标示不确定；新名称 deepseek-flash 使用当前表。未来官方再次调价需更新插件，价格并非自动抓取。

公式：`(inputTokens + cacheWriteTokens) × miss + cacheReadTokens × hit + outputTokens × out`，除以一百万。
DSH 的 inputTokens 已经是缓存未命中部分，不再减一次缓存命中。

## 余额与安全

余额来自 [GET /user/balance](https://api-docs.deepseek.com/api/get-user-balance/)。
读取 Harness 的 `llm-deepseek.apiKeyEnv` 及其凭据服务，不要求把密钥再输入一遍。
凭据仅在服务端使用，不返回浏览器、不写入日志。只向固定的官方 HTTPS 地址查询，禁止重定向。
如果 DeepSeek 适配器配置为第三方/内部地址，余额栏会说明不支持，不把该凭据发送到官方。
这是该 Key 所属的**整个账户**余额，不是本会话剩余预算，也不是剩余 token 数。跨设备消费及官方记账延迟都会影响数值。
没有官方 Key、凭据无效、网络失败、响应格式异常时均显示可见错误。

## 安装与更新

```sh
dsh plugin --profile web add .
# 或链接你的本地目录
dsh plugin --profile web add link:D:\dsh花费查询
```

更新后重启 `dsh web` 并刷新浏览器。无需重新添加已链接的本地插件。
开发测试：`npm test`。浏览器入口为 `lib/client.js`，价格表为 `lib/pricing.js`，余额接口为 `lib/balance.js`。

## 准确性边界

费用依赖日志中 provider 实际上报的 usage：无 usage 的中断/失败请求无法推算；一次请求内部的重试时间可能缺少精确边界。
第三方渠道折扣、账户优惠和历史价格切换都可能让估算不同于账单。**实际扣费以官方账单和余额为准。**
