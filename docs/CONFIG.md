# 配置说明

主要配置位于脚本开头的 `CFG`。

| 配置 | 作用 |
|---|---|
| `qqPackage` | QQ Android 包名 |
| `chatgptPackage` | ChatGPT Android 包名 |
| `ownerNickname` | 使用者在 QQ 聊天中显示的昵称 |
| `botAliases` | 机器人可能使用的名称 |
| `chatGptConversationTitle` | 可选的 ChatGPT 专用对话准确标题 |
| `quietMs` | 聊天画面稳定多久后处理 |
| `scanIntervalMs` | OCR 轮询间隔 |
| `chatgptTimeoutMs` | 等待 ChatGPT 回复的最长时间 |
| `interjectChance` | 提示给 ChatGPT 的主动参与目标 |
| `recentTurnsLimit` | 每个聊天保留的本地上下文轮数 |
| `setupRefreshEvery` | 多少次请求后重新发送完整规则 |
| `logFile` | 本地日志路径 |

## @ 唤醒

v0.6.10 只有最新消息明确包含对机器人别名的 `@` 时，才要求 ChatGPT 使用 `REPLY`。

普通文字提到 GPT、ChatGPT 或 GPT-6A，以及明显承接机器人上一句话，都不构成强制唤醒；它们仍可能按普通插话规则得到 `INTERJECT`。

## NR 免回复

当能够确认最新消息来自 `ownerNickname`，且正文以 `NR` 开头时，本轮在手机本地跳过，不请求 ChatGPT。

