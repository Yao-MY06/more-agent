# resident

more-agent 的常驻层：用户只和一个 Leader 对话，由它判断每条请求该交给哪个项目。方案见 [../docs/superagent-plan.zh-CN.md](../docs/superagent-plan.zh-CN.md)。

**当前是 M0 影子运行：Leader 只记录“本来会派给谁、会说什么”，不派发任何工作，也不发送任何消息。** 测试会检查源码里只有 Leader 调用会启动进程，并且不调用 `omh`。

## 组成

引擎不是自己写的。`vendor/dsh-superagent/` 来自 DeepSeek 开源的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT），`src/core` 原样未改，上游测试也一起带过来运行。来源和改动见 [UPSTREAM.md](vendor/dsh-superagent/UPSTREAM.md)。

本仓库只写了上游绑定在 DSH 上、需要换掉的部分：

| 文件                           | 实现上游的              | 作用                                             |
| ------------------------------ | ----------------------- | ------------------------------------------------ |
| `src/policy.ts`                | `Policy`、`SourceScope` | 单人本机的准入规则：只有本人直接提交的请求能开工 |
| `src/leader/`                  | `Assessor`              | 用 Leader 判断请求，并在代码里校验回答           |
| `src/llm/claude-cli.ts`        | 新增                    | 通过 `claude -p` 调用模型，无工具、无会话        |
| `src/shadow.ts`                | `Executor`、`Outbox`    | M0 的替身：工单只走流程，什么都不执行            |
| `src/spool.ts`                 | Source                  | 其他进程用文件提交请求                           |
| `src/runtime.ts`、`src/cli.ts` | Runtime                 | 组装和命令行                                     |

## 使用

需要 Node 24.13（见 `.nvmrc`）和已登录的 `claude` CLI。

```bash
npm ci --ignore-scripts
npm run build
```

```bash
npm run resident -- project add opus-manager ../opus-manager
```

```bash
npm run resident -- say "把 omh packet 的输出再精简一点"
```

```bash
npm run resident -- run --until-idle
```

```bash
npm run resident -- report
```

| 命令                                       | 说明                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `project add <id> <路径> [--brief 文本]`   | 登记项目。id 只能用小写字母、数字和连字符。不给 `--brief` 时取 README 开头 1500 字                            |
| `project list`                             | 列出项目，每行是 `id` 和路径                                                                                  |
| `say <文本> [--thread 话题]`               | 提交请求，输出请求 id。不需要 runner 在运行                                                                   |
| `replay <文件.jsonl>`                      | 回放历史请求，每行 `{id, text, thread?, expected?}`。有一行不合法就整个文件都不提交；相同 id 重放不会重复判断 |
| `run [--until-idle]`                       | 运行，同一状态目录只允许一个。`--until-idle` 处理完就退出                                                     |
| `status [--json]`                          | 状态计数                                                                                                      |
| `decisions`                                | 以 JSON 输出全部决策                                                                                          |
| `report [--json]`                          | 决策报告                                                                                                      |
| `review <请求 id> ok\|wrong [--note 备注]` | 人工核对一条决策，以最后一次为准                                                                              |

退出码：`0` 成功，`1` 用法错误或运行失败，错误信息写到 stderr。

**环境变量**

| 变量                      | 默认值            | 说明                                      |
| ------------------------- | ----------------- | ----------------------------------------- |
| `RESIDENT_HOME`           | `~/.more-agent`   | 状态目录                                  |
| `RESIDENT_LEADER_MODEL`   | `claude-opus-5-5` | Leader 模型                               |
| `RESIDENT_LEADER_EFFORT`  | `medium`          | Leader 强度                               |
| `RESIDENT_LEADER_COMMAND` | `["claude"]`      | 替换 `claude` 的命令，JSON 数组，用于测试 |

## 保证和限制

- **不丢不重：** 请求 id 只存一次，决策和后续动作在同一事务里入队。`test/crash.test.ts` 真实 kill 两次 runner 来验证。
- **决策恰好一次，模型调用不是：** 崩溃时正在进行的调用会重做，所以可能多花一次额度。
- **崩溃后重启最多等 10 秒：** 要等旧 runner 的锁过期。
- **Leader 没有工具：** `--restricted --tools ""` 是硬边界，不是提示词约定。请求文本和项目简介都当数据处理，但模型仍可能被其中的内容误导判断。
- **`expected` 不会发给模型：** 回放时的标准答案只用于计算命中率，有测试保证。
- **当前没有跨话题批处理：** 上游的批处理依赖常驻会话，M0 每次评估单独调用一次模型。
- **Windows 上没有文件权限位保护：** 状态目录靠用户目录的 ACL 保护。
- **`node:sqlite` 在 Node 24 仍标记为实验性：** 上游和 OpenClaw 都在用，`npm run resident` 关闭了这条警告。升级 Node 时要回归测试。
- **电脑休眠或关机时不工作。**

## 开发

```bash
npm run check
```

```bash
npm run coverage
```

格式化和 lint 用 Biome，`vendor/` 不参与。修改 `vendor/` 前先看 [UPSTREAM.md](vendor/dsh-superagent/UPSTREAM.md)。
