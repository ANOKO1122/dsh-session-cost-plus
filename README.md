# dsh-session-cost-plus

DSH（DeepSeek Harness）Web GUI 插件：在底部官方统计条（字符 / 缓存命中 / token 统计）下方增加**本次会话实时费用估算**，并把官方缓存命中显示改为**两位小数、不截断**。

## 功能

- 费用行：`费用 ≈¥0.35 | 命中 ¥0.28 | 未命中 ¥0.02 | 输出 ¥0.05`
- **逐条按时间计价**：host 端读取 `$DSH_HOME/sessions/<cwd>/<session-id>/session.jsonl.zstd`，按每条请求的 `time`、`model`、token 分桶分别计价，再汇总
  - 能正确处理同一次会话跨过“峰谷前 → 峰谷后”或“空闲 → 高峰”的情况
- 价格：DeepSeek 官方定价（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
  - `deepseek-v4-flash` / `deepseek-v4-pro`：2026-08-17 前平峰价，之后峰谷价（高峰北京时间 9-12、14-18）
  - 旧版 `deepseek-chat` / `deepseek-reasoner` 平峰价（兼容仍在使用旧模型的情况）
  - 模型取每条请求日志里的模型；未识别时按 `deepseek-v4-flash` 兜底
- 缓存命中显示两位小数：官方 `87%` → `87.35%`
- 不截断：官方统计条和费用行都允许完整显示，不再用省略号 + 悬停 tooltip 才看全

> 费用仍以 DeepSeek 官方账单为准；本插件按 provider 上报的 usage 记录估算。

## 安装

本目录就是一个可安装的插件包。根据你本机 `dsh plugin` 支持的本地路径格式，任选其一：

```bash
# 方式一：在当前目录内直接添加当前目录
dsh plugin --profile web add .

# 方式二：使用 link: 绝对路径
dsh plugin --profile web add link:D:\\dsh花费查询

# 方式三：把本目录改名/复制为 dsh-session-cost-plus，再到上一级执行
# dsh plugin --profile web add ./dsh-session-cost-plus
```

如果 `dsh` 未全局安装，在命令前加 `npx --yes @deepseek-ai/dsh`：

```bash
npx --yes @deepseek-ai/dsh plugin --profile web add .
```

安装后**重启 `dsh web`** 生效。

## 目录结构

```
dsh-session-cost-plus/
├── package.json          # dsh.client manifest
├── cordis.patch.yml      # 插件挂载补丁
├── lib/
│   ├── index.js          # host 面：解析 session.jsonl.zstd 并逐条计价 API
│   └── client.js         # 浏览器面：费用行 + 统计条修补
└── README.md
```

## 价格表

| 模型 | 时段 | 命中（¥/M） | 未命中（¥/M） | 输出（¥/M） |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 高峰 | 0.10 | 3.0 | 9.0 |
| deepseek-v4-flash | 空闲 | 0.05 | 1.5 | 4.5 |
| deepseek-v4-pro | 高峰 | 0.30 | 9.0 | 27.0 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |

计费口径：`(未命中 + 缓存写入) × miss + 缓存命中 × hit + 输出 × out`，除以 1e6 得到元。

## 常见问题

- **看不到费用行？** 确认当前会话已有 token 用量（发过至少一次成功请求），且插件已随 `dsh web` 重启加载。若显示“费用计算中…”，说明 host 还没读到该会话日志，稍等下一次轮询即可。
- **模型价格不对？** 本插件内置的是 DeepSeek 官方公开价；如果官方调价，编辑 `lib/index.js` 顶部的 `TIERED_PRICES` / `FLAT_PRICES` 后重启即可。
- **依赖装不上？** host 端自带 vendored `fzstd`（纯 JS zstd 解压，已放在 `lib/vendor/fzstd.cjs`），不依赖 npm 网络；若手动放置目录也无需额外 `npm install`。
- **想只显示总额？** 可删除 `CostLine` 中 `groups` 数组里的明细项后重新构建/复制 `lib/client.js`。
