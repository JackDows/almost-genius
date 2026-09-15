# Jira 工作提醒

## Windows 应用

桌面或开始菜单双击 **Jira 工作提醒**。程序路径为 `desktop/bin/JiraReminder.exe`，使用系统已有的 WebView2 运行库。

- **今日工作**：查看是否正在运行、今日填报状态、临期任务和下一次提醒。
- **记录与整理**：输入日报内容，或切换到周计划核对。
- **设置**：暂停/恢复提醒、配置 Jira 与企业微信、测试通知。
- 关闭窗口后收至系统托盘，提醒继续。点击绿色勾选图标可重新打开；右键可确认填报或暂停提醒。
- 托盘的 **退出并暂停提醒** 会暂停后退出界面；之后重新打开，在设置中恢复提醒。
- 登录 Windows 后自动启动托盘。多次点击快捷方式只打开同一个应用窗口。

界面每 5 秒读取真实后台状态；后台失联显示“后台未连接”，暂停时显示“提醒已暂停”。后台重新启动后会自动刷新会话令牌，保留当前未提交的文字。通知点击后优先打开独立应用。

构建和重新创建快捷方式：

```powershell
.\desktop\Build.ps1
.\desktop\Install-Desktop.ps1
```

构建使用系统 .NET Framework 编译器和微软 `Microsoft.Web.WebView2` NuGet 包 `1.0.4191.47`。SDK 解压目录为 `desktop/vendor/1.0.4191.47`。启动脚本保存为带 BOM 的 UTF-8，兼容系统 Windows PowerShell。

## 当前进度

已实现独立窗口、桌面与开始菜单快捷方式、系统托盘、企业微信消息收发、Jira 临期检查、Codex 整理、每日完成记录、15:00／22:00 提醒、断网补执行和 Windows 登录自动启动。

## 日常使用

[打开本机页面](http://127.0.0.1:60500/)。不需要保持 Codex 窗口打开。

- 直接将今天做的事情发给企业微信机器人，自动整理为 **50 字以内**的填报参考。
- 填好 Jira 后回复 **已填报**，或点击网页里的 **今日已完成**。生成描述不会自动标记完成，也不会自动向 Jira 填报。
- **状态**：查看今天的完成状态。**撤销完成**：取消误点的完成标记。
- **周计划**：查看本周核对入口。发送 **周计划 下周准备……** 继续补充、核对草稿。
- 整理失败时原文保留，发送 **重试** 或点击网页里的重试按钮。

## 运行连接配置

需要 Windows、Node.js 24、本机已登录的 Codex CLI，以及企业微信智能机器人（API 模式、长连接）和 Jira 账号。

```powershell
cd E:\aonorx-project\Daily\jira-reminder
.\Start.ps1
.\Install-Autostart.ps1
```

打开输出的本机地址，在表单填写 Bot ID 和 Secret。配置页只监听 `127.0.0.1:60500`，关闭网页后后台仍运行。

`Install-Autostart.ps1` 安装当前用户的登录任务 `Aonor-Jira-Reminder`，后台守护每 15 秒检查服务，不唤醒电脑，电池供电时也运行。网页可暂停提醒；`Remove-Autostart.ps1` 移除登录自动启动，当前服务可能仍运行，先在网页暂停提醒即可停止定时业务。

1. 保存并连接。
2. 在机器人单聊中发送页面显示的绑定码。
3. 在机器人中发送“测试”，核对回复。
4. 在配置页点击发送测试提醒，核对企业微信主动消息。

机器人密钥和绑定信息使用 Windows DPAPI 以当前用户加密保存到 `.local/wecom.dpapi`，Jira 凭据加密保存到 `.local/jira.dpapi`，只发往公司 Jira。SDK 日志不记录认证字段或消息内容。不要将 `.local`、缓存、日志或依赖目录提交到仓库。

`.local/state.json` 以本地明文保存原始工作记录、草稿、按北京时间日期划分的完成标记和发送记录。Codex 只接收要整理的文字，不接收 Jira 密码或机器人密钥；调用计入现有账号使用量。

## 已确认的提醒规则

- 北京时间，每天以开机视为需要提醒，不排除周末或调休。
- 15:00 开始：日报填报提醒、Jira 临期检查；周六加上本周工作与下周计划核对。
- 检查未完成且明天、后天到期的任务，并给出链接。
- 超过 15:00 才启动或联网，约 15 秒内开始补执行当天未完成的任务；不补发昨日提醒。
- 执行时离线，本机提醒联网；恢复后继续。
- 22:00 查询当天完成记录，未完成时企业微信和本机再次提醒。
- 22:00 后首次启动，将当天两轮提醒合并，避免重复。
- 只有用户明确回复“已填报”或点击“今日已完成”才记录完成，按北京时间日期保存。
- 日报描述不超过 50 字；周计划先核对；消息保持简短。
- 内容整理使用本机已登录的 Codex CLI，无需单独模型 API Key。

Jira 使用标准 **到期日（duedate）**，筛选所有分配给本人、状态类别未完成的任务。查询失败不会记为“没有临期任务”，五分钟后重试。每个日期、提醒类型和渠道分别保存发送记录，正常重启不重复；平台已收消息但确认前断线时，重试仍可能重复一条。Windows 通知能否实际显示取决于系统通知设置，网页保留完整内容和任务链接。

## 验证

```powershell
npm.cmd test
```

自动测试使用模拟的企业微信、Jira 和虚构工作记录，不发送真实消息。覆盖时间边界、晚开机、周末、离线补执行、分渠道去重、完成记录持久化、认证、分页和本机接口防跨站请求。真实接入另需核对企业微信消息、Jira 查询结果和 Windows 通知。

## 参考

- [企业微信官方 SDK](https://github.com/WecomTeam/aibot-node-sdk)
- [Codex 非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Jira 8.5 REST API](https://docs.atlassian.com/software/jira/docs/api/REST/8.5.0/)
- [Windows 计划任务的运行身份](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)
- [微软 WebView2 Windows Forms 接入说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)
