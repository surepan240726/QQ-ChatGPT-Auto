# QQ-ChatGPT-Auto

基于 AutoJs6、QQ Android 客户端和 ChatGPT Android 客户端的自动聊天脚本。

脚本读取当前打开的 QQ 聊天画面，将新增内容交给 ChatGPT 专用对话判断，再返回 QQ 自动发送回复。无需 OpenAI API Key、QQ 官方机器人接口或服务器。

> 当前稳定版：**v0.6.10**
>
> v0.6～v0.6.6 中曾实验的图片识别与图片上传功能现已不可用，仅保留在历史版本中作为开发记录。v0.6.10 已完全删除相关代码。

## 主要功能

- AutoJs6 内置 ML Kit 文字 OCR
- 补充读取 QQ 无障碍节点中可见的 emoji 文字
- 当前聊天有新内容时调用 ChatGPT
- 明确 `@GPT-6A`、`@GPT` 或 `@ChatGPT` 时直接回复
- 普通公开聊天由 ChatGPT 按约 60% 的目标决定是否主动参与
- `NR` 免回复标记
- 按聊天标题分别保存本地上下文
- 忽略机器人自己的最近发言
- 回复末尾自动添加脚本版本
- 音量上键紧急停止

## 运行环境

- Android 或兼容 Android 应用的系统
- [AutoJs6](https://github.com/SuperMonster003/AutoJs6) 6.7 或更高版本
- Android 版 QQ，包名 `com.tencent.mobileqq`
- Android 版 ChatGPT，包名 `com.openai.chatgpt`
- 已登录的 ChatGPT 账号
- 可正常使用 ChatGPT 的网络
- AutoJs6 无障碍权限
- AutoJs6 截图/录屏权限
- AutoJs6 文件访问权限
- 建议允许 AutoJs6 后台运行并关闭电池优化

不需要电脑常驻、OpenAI API Key、QQ 官方机器人接口、外部 OCR 或付费服务器。

## 快速开始

1. [下载 0.6.10 压缩包](https://github.com/surepan240726/QQ-ChatGPT-Auto/releases/download/v0.6.10/QQ-ChatGPT-Auto-v0.6.10.zip)并解压
2. 在 AutoJs6 中打开 `QQ-ChatGPT-Auto-v0.6.10.js`
3. 把 `ownerNickname` 改成自己在聊天中的 QQ 昵称
4. QQ 停在目标聊天页面
5. ChatGPT 停在机器人专用对话底部，并让最近的 `QQBOT_...` 回复可见
6. 运行脚本，先点击“第一步：测试 OCR”
7. 确认识别正确后点击“第二步：开始监听”
8. 如发生异常，按音量上键紧急停止

详细说明见 [安装说明](docs/INSTALL.md)、[配置说明](docs/CONFIG.md)和[故障排查](docs/TROUBLESHOOTING.md)。

## 当前回复规则

- 最新消息明确 `@GPT-6A`、`@GPT` 或 `@ChatGPT`：使用 `REPLY`
- 普通文字提及这些名字、承接机器人上一句话或普通公开聊天：不构成强制唤醒，只能按普通插话规则决定
- 普通公开聊天：目标约 60% 使用 `INTERJECT`，约 40% 使用 `NO_REPLY`
- 使用者最新消息以 `NR` 开头：手机本地直接跳过
- 脚本第一次看到当前画面时只建立基线，不补回历史消息

## 重要限制

- 这是依赖界面、无障碍节点和 OCR 的自动化脚本，不是 QQ 官方机器人
- QQ、ChatGPT 或系统界面更新后可能失效
- OCR 可能漏字、错字或混入时间、等级和按钮文字
- 自动发送前没有人工确认，存在误发或重复发送风险
- 只能处理当前打开的 QQ 聊天，不会在后台读取全部会话
- ChatGPT 免费或付费账号都受各自消息额度限制
- 请自行遵守相关平台规则并承担使用风险

## 版本历史

完整记录见 [CHANGELOG.md](CHANGELOG.md)。各版本压缩包请到 [GitHub 发布页](https://github.com/surepan240726/QQ-ChatGPT-Auto/releases)，在对应版本的 **Assets** 中下载 `QQ-ChatGPT-Auto-v版本号.zip`。

历史版本的标签都指向同一个包含 v0.6.10 源码的提交，因此 GitHub 自动生成的 `Source code (zip)` 和 `Source code (tar.gz)` 不是对应的旧版脚本。需要旧版本时，请下载该版本 **Assets** 中单独上传的压缩包。

## 隐私

仓库不包含运行日志、群聊截图、聊天记录、图片缓存、账号凭据或 API Key。聊天 OCR 会被输入到你已登录的 ChatGPT 专用对话中。

## 开源协议

[MIT License](LICENSE)

