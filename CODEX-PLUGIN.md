# 微信订阅推送 · Codex 插件

在 Windows 本机用 Codex Computer Use 巡检微信已经登录的公众号和视频号，在两轮定时任务中发送带标题、作者和原生微信链接的汇总。安装包有八个订阅来源、必看号状态、视频暂停、投递去重和失败恢复。

## 从 GitHub 安装

在目标机使用 Codex 桌面版、微信、Git 和 Node.js 24+。在 PowerShell 运行：

```powershell
codex plugin marketplace add https://github.com/xing0325/wechat-rss.git --ref codex-plugin
$install = codex plugin add wechat-rss@wechat-rss-local --json | ConvertFrom-Json
$project = Join-Path $env:USERPROFILE 'wechat-rss'
node (Join-Path $install.installedPath 'skills/wechat-rss/scripts/bootstrap.mjs') $project
```

重新打开 Codex，在 `%USERPROFILE%\wechat-rss` 新建本机聊天，选择「微信订阅推送」并执行部署技能。安装和运行可以使用目标机自己的 Codex 账号。

## 微信验收与定时

- 登录微信，启用 Computer Use，保持 Windows 交互桌面解锁。核对项目 `config.json`。默认目标是「文件传输助手」，正式发送关闭。获得授权后，用文件传输助手发送一条预演，并完成一次只读定时触发测试。
- 在项目 `config.json` 将 `delivery.chatName` 改成用户指定的正式群聊或私聊全名。核对会话和旧机切换后，建立目标账号的本机定时任务，再启用 `delivery.enabled`。
- 香港时间每日 19:50、22:50 巡检，20:30、23:30 投递。20:30 提示必看号缺更及覆盖状态，23:30 先列新增再回顾首轮。每条视频核验完后暂停，确认停止后离开。
- 沿用去重记录时，暂停旧机任务，再私下复制 `state/wechat-rss.sqlite`。这份公开仓库只发布程序、工作流和初始配置。

[部署技能](plugins/wechat-rss/skills/wechat-rss/references/deployment.md) · [Codex 本地插件](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli) · [Windows Computer Use](https://learn.chatgpt.com/docs/computer-use#windows-foreground-use)
