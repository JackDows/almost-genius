# Almost Genius

通过企业微信聊天的 Windows 个人 AI 助手：安排任务、整理工作、留存成长经历。

当前为 **v0.4.0 预览版**。用户验收并实际使用稳定后，才升级 v1.0.0。

- [安装包与预览版本](https://github.com/JackDows/almost-genius/releases)
- [安装、使用和开发说明](almost-genius/README.md)
- [本次范围与验收记录](docs/v0.4-preview-plan.md)
- [开源借鉴与许可证](almost-genius/THIRD_PARTY.md)

## 能做什么

- 直接闲聊、分享链接，使用现有 Codex 登录回答。
- 用自然语言创建全新任务，修改时间、暂停、删除、恢复、撤销；桌面上也能管理。
- 保留 Jira 日报、临期检查、周计划核对与过去两个月工时记录。
- 把工作经历提炼为待核对的技能、项目、经验；保留证据、个人背景与偏好。
- 导出个人档案，或加密备份后迁移至另一台电脑；没有备份也能重新配置。

## 构建和发行

源码位于 almost-genius。GitHub Actions 的“Windows 安装包”可以手动构建并下载产物。
推送与 package.json 一致的 v0.x 标签会发布预览版 Release。安装包包含 Node、Codex CLI 与桌面组件。
账号、个人记录、备份和开发测试目录不进入仓库或安装包。
