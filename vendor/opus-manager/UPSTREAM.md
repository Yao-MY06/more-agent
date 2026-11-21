# 上游来源

本目录是 opus-manager 的 harness（`omh`）和经理技能的快照，resident 的经理用它派工人、验收。放在这里，是为了克隆 resident 一个仓库就能运行，不用再在旁边放一份 opus-manager。

- **原项目：** [yanauto/opus-manager](https://github.com/yanauto/opus-manager)，MIT，版权人 yanauto，见 `LICENSE`。
- **分叉点：** 上游提交 `c3d7fa6`（2026-09-30）。
- **快照来自：** 本项目作者的分叉，提交 `93d05c3`（2026-11-21），比分叉点多 29 个提交。
- **上游现状：** 原作者之后把项目改名为 broco（`@yanauto/broco`），整体重写并改用 Apache-2.0 许可。本目录不跟进 broco，两者已经不兼容。

## 复制了什么

| 路径 | 说明 |
|---|---|
| `harness/bin`、`harness/src` | `omh` 命令行和 MCP 服务，零依赖，Node 20 以上 |
| `harness/templates`、`harness/examples` | 工单和回执模板、配置示例 |
| `harness/test` | harness 自己的测试和夹具。resident 的 `test/stop-workers.test.ts` 用到 `fixtures/fake-worker.js` |
| `harness/package.json`、`harness/README.md` | 原样保留，方便对照 |
| `skill/zh`、`skill/en` | 经理技能 `SKILL.md` 和模板。resident 默认读 `skill/zh/opus-manager/SKILL.md` |
| `LICENSE` | 上游的 MIT 许可，原样保留 |

没有复制：`harness/validation/`（作者本机的验收脚本）、上游的演示视频、网站和文档。

## 分叉后的改动（相对 `c3d7fa6`）

| 方面 | 改了什么 |
|---|---|
| 多模型 harness | v0.3：Claude 当经理，其他 AI 命令行工具施工和审查；派单、看门狗、超时、用量和花费记录、跨厂商审查 |
| Windows | 首次在 Windows 上实跑后修的问题：启动 `.cmd` 启动脚本、读带 BOM 的配置、结束进程树 |
| 新的工人适配器 | CodeBuddy（WorkBuddy CLI）、Command Code；Codex 改用 `--sandbox workspace-write`，因为 codex-cli 0.165 删掉了 `--full-auto` |
| 派单和验收 | 派单前分诊（`omh triage`），退回留着模板占位符或"上次那个"这类指代的工单；`omh packet` 紧凑交付包；`omh checks` 按改动推荐最小验收命令；派单附带范围代码索引 |
| 范围检查 | 给派单前就没提交的文件拍内容快照，不再把它们算成越界 |
| 额度 | 总开关、额度优先的路由、额度池 |

完整历史在分叉仓库里，这里不重复。

## 升级方法

1. 在分叉仓库里改好、跑通 `cd harness && node --test test/*.test.js`，并提交。
2. 用 `git archive <提交> LICENSE harness/README.md harness/package.json harness/bin harness/src harness/templates harness/examples harness/test skill` 导出，覆盖本目录（`UPSTREAM.md` 保留）。
3. 更新本文件的"快照来自"和改动表。
4. 在 resident 里跑 `npm run check`。
