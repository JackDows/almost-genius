# Jira 工作提醒

Windows 本机运行的 Jira 日报、临期任务和周计划提醒助手，支持企业微信机器人与 Codex。

- [安装与使用说明](jira-reminder/README.md)
- [下载安装包](https://github.com/JackDows/jira-reminder/releases)

## 发布版本

提交代码到 GitHub 后，在 Actions 中运行 **Windows 安装包**，可以先下载构建产物验证。

正式发布时，让 `jira-reminder/package.json` 版本与 Tag 一致，再推送 Tag。例如版本 `0.3.1` 对应：

```powershell
git tag v0.3.1
git push origin v0.3.1
```

GitHub Actions 会执行测试、生成 Windows x64 安装包并发布 Release。账号、个人工作记录和备份文件不进入仓库或安装包。
