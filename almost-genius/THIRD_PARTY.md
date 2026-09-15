# 开源来源与适配

## PAI / LifeOS Cortex

- 仓库：https://github.com/danielmiessler/LifeOS
- 固定提交：`5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c`
- 原文件：`LifeOS/install/LIFEOS/TOOLS/Cortex.ts`、`CaptureEnvelope.ts`
- 许可：MIT，见 `licenses/lifeos-LICENSE.txt`。
- 适配：去除 TypeScript 类型并使用 Node.js ESM；移除 Bun 入口；写入必须显式注入本应用写入器，禁止访问 LifeOS 默认目录；使用中文分词；保留来源、有效期、私密片段清理与 BM25 检索。
- 主记录在本应用状态库中；Cortex 检索读取由主记录构造的视图，不维护另一套可独立修改的个人数据。

## TELOS

- 仓库：https://github.com/danielmiessler/Telos
- 固定提交：`e5cc4d6eb93d2471cc7e4f52277dfe393ddf5d33`
- 参考文件：`personal_telos.md`。
- 许可：MIT，见 `licenses/telos-LICENSE.txt`。
- 适配：中文空白个人档案模板，保留背景、目标、挑战、项目和偏好的关系；不包含上游示例人物信息。

## BragDoc

- 仓库：https://github.com/edspencer/bragdoc-ai
- 固定提交：`fbac5e1fab234e77057b07927fe0d3e7c64cc2f4`
- 参考文件：`packages/cli/src/ai/prompts/extract-commit-achievements.mdx`。
- 许可：MIT，见 `licenses/bragdoc-LICENSE.txt`。
- 适配：将成果提取流程用于 Jira 工时与个人补充；保留证据和相关事项合并，增加待核对状态；不采用影响力评分，不推测贡献或量化结果。

以上内容随安装包发布，保留版权与许可。更新由 Almost Genius 的版本发布控制，不会自动更新上游或覆盖个人资料。
