# resident

more-agent 的常驻层：用户只和一个 Leader 对话，由它判断每条请求该交给哪个项目。

你对 Leader 说一件事，它判断归哪个项目，交给那个项目的经理会话；经理用 [`omh`](https://github.com/yanauto/opus-manager) 派工人、验收；结果再由 Leader 用几句话告诉你。

**每个项目默认只做影子运行：Leader 只记录“本来会派给谁、会说什么”，什么都不执行。** 登记时加 `--execute` 才会真的运行。

## 组成

引擎不是自己写的。`vendor/dsh-superagent/` 来自 DeepSeek 开源的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT），`src/core` 原样未改，上游测试也一起带过来运行。来源和改动见 [UPSTREAM.md](vendor/dsh-superagent/UPSTREAM.md)。

本仓库只写了上游绑定在 DSH 上、需要换掉的部分：

| 文件                            | 实现上游的              | 作用                                             |
| ------------------------------- | ----------------------- | ------------------------------------------------ |
| `src/policy.ts`                 | `Policy`、`SourceScope` | 单人本机的准入规则：只有本人直接提交的请求能开工 |
| `src/leader/`                   | `Assessor`              | 用 Leader 判断请求、转述汇报，并在代码里校验回答 |
| `src/llm/`                      | 新增                    | 通过 `claude -p` 调用 Leader，无工具、无会话     |
| `src/executor.ts`               | `Executor`              | 按项目开关分给影子运行或经理                     |
| `src/shadow.ts`                 | 新增                    | 影子运行：工单只走流程，什么都不执行             |
| `src/manager/`                  | 新增                    | 经理会话：按轮次运行，等工人时不花额度           |
| `src/memory/`                   | 新增                    | 记忆：Markdown 文件加内存中的全文索引            |
| `src/outbox.ts`、`src/inbox.ts` | `Outbox`                | 发给你的消息写进本地收件箱                       |
| `src/spool.ts`                  | Source                  | 其他进程用文件提交请求和命令                     |
| `src/runtime.ts`、`src/cli.ts`  | Runtime                 | 组装和命令行                                     |

## 经理怎么运行

经理不是一直在线的进程，而是一轮一轮地跑：

1. 第一轮读需求、写工单、派工人，然后结束本轮并汇报 `waiting`。
2. 工人跑的时候没有模型在运行。runner 每 5 秒问一次 `omh`。
3. 工人结束后，runner 用 `--resume` 开下一轮，经理接着验收。
4. 需要你决定时，经理汇报 `blocked` 并提一个问题，Leader 转给你。你回复后开下一轮。

每一轮都是脱离 runner 的独立进程，所以 runner 崩溃或重启不会打断它。

**经理能做什么由命令行决定，不靠提示词：** 没有 Bash；只能编辑 `_tickets/` 下的文件；只能用 `omh` 的 MCP 工具（不含 `omh_wait`）；不加载用户级设置和其他 MCP 服务。

启用前，项目里要先运行 `omh init`，并由你决定工人和同意项。这一步 resident 不会替你做。

## 记忆怎么运行

Leader 每次调用都是全新的，它知道的过去都来自卡片。卡片由程序现场拼出，不调用模型，也不保留任何会话。

| 卡片上的内容 | 来源                                                | 上限                     |
| ------------ | --------------------------------------------------- | ------------------------ |
| `rules`      | 你要求记住的规则，不会随时间变淡                    | 最新 10 条，放不下会说明 |
| `memory`     | 和这条请求相关的记录                                | 8 条，每条 600 字        |
| `work`       | 进行中和最近结束的工单                              | 20 张进行中，15 张已结束 |
| `recalled`   | Leader 用 `recall` 动作要来的内容，按词查或沿引用读 | 每条请求最多 2 次        |

- **Markdown 是唯一的真实来源。** 记忆存在 `<状态目录>/memory/YYYY-MM-DD.md`，可以直接手改，索引每次在内存里重建。
- **写进记忆的：** 你的消息、经理的汇报和问答。工人的输出和网页内容不进记忆。影子项目也记。
- **排序：** BM25 乘 30 天半衰期，规则不衰减，再用 MMR 压低几乎相同的记录。中文按两字一组切分。
- **作用范围：** 每条记录属于一个项目或全局。经理只看到自己项目和全局的记录，这由代码保证。Leader 看得到所有项目，不外溢靠提示词和评测，不是硬保证。
- **旧事实：** 新记录可以取代旧记录，被取代或忘记的不再出现，但原文还留在文件里。
- **Leader 的动作多了四个：** `answer`（直接回答）、`attach`（接到旧工单）、`remember`（记下规则）、`recall`（查记忆）。它仍然没有任何工具，`recall` 也只是回答里的一个字段，由程序执行。

**评测：** `npm run eval:memory -- <输出目录> [--noise 300]`，用真实模型跑，会花钱。题目是这个项目自己写的，只能说明这些题，不能和公开榜单比较。

## 使用

需要 Node 24.13（见 `.nvmrc`）和已登录的 `claude` CLI。

```bash
npm ci --ignore-scripts
npm run build
```

```bash
npm run resident -- project add demo ../demo --execute
```

```bash
npm run resident -- say "给 demo 加一个 add 函数" --thread add
```

```bash
npm run resident -- run --until-idle
```

```bash
npm run resident -- inbox
```

```bash
npm run resident -- say "用第一种做法" --thread add
```

| 命令                                                 | 说明                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `project add <id> <路径> [--brief 文本] [--execute]` | 登记项目。id 只能用小写字母、数字和连字符。不给 `--brief` 时取 README 开头 1500 字。重新登记时不加 `--execute` 会关掉执行 |
| `project list`                                       | 列出项目，每行是 `id`、`执行` 或 `影子`、路径                                                                             |
| `say <文本> [--thread 话题]`                         | 提交请求，输出请求 id。在同一话题上继续说，消息会直接到负责的经理，不再经过 Leader 判断。不需要 runner 在运行             |
| `inbox [--all] [--json]`                             | 查看 Leader 发给你的新消息，读过就不再显示；`--all` 显示全部                                                              |
| `remember <文本> [--project 项目] [--supersedes id]` | 记下一条规则，之后派的工作都会带上。也可以直接 `say "记住：……"`，由 Leader 判断范围。不需要 runner 在运行                 |
| `memory list\|search <词>\|show <id>\|forget <id>`   | 查看或作废记忆，可加 `--project`、`--reason`、`--json`。不需要 runner 在运行                                              |
| `tickets [--json]`                                   | 查看工单：阶段、项目、等你回答的问题、轮数和经理的牌价花费                                                                |
| `stop <工单 id 前缀> [--reason 原因]`                | 停止工单，连同它的经理和这个项目正在跑的工人（包括审查），并把 `omh` 里对应的工单移到 `blocked`                           |
| `replay <文件.jsonl>`                                | 回放历史请求，每行 `{id, text, thread?, expected?}`。有一行不合法就整个文件都不提交；相同 id 重放不会重复判断             |
| `run [--until-idle]`                                 | 运行，同一状态目录只允许一个。`--until-idle` 处理完就退出                                                                 |
| `status [--json]`                                    | 状态计数                                                                                                                  |
| `decisions`                                          | 以 JSON 输出全部决策                                                                                                      |
| `report [--json]`                                    | 决策报告                                                                                                                  |
| `review <请求 id> ok\|wrong [--note 备注]`           | 人工核对一条决策，以最后一次为准                                                                                          |

退出码：`0` 成功，`1` 用法错误或运行失败，错误信息写到 stderr。

**环境变量**

| 变量                               | 默认值                                           | 说明                                          |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `RESIDENT_HOME`                    | `~/.more-agent`                                  | 状态目录                                      |
| `RESIDENT_LEADER_MODEL`            | `claude-opus-5-5`                                | Leader 模型                                   |
| `RESIDENT_LEADER_EFFORT`           | `medium`                                         | Leader 强度                                   |
| `RESIDENT_LEADER_COMMAND`          | `["claude"]`                                     | 替换 `claude` 的命令，JSON 数组，用于测试     |
| `RESIDENT_MEMORY`                  | 开                                               | `off` 时卡片上没有任何记忆，用来测量基线      |
| `RESIDENT_MANAGER_MODEL`           | `claude-opus-5-5`                                | 经理模型                                      |
| `RESIDENT_MANAGER_EFFORT`          | `medium`                                         | 经理强度                                      |
| `RESIDENT_MANAGER_TURN_BUDGET_USD` | `3`                                              | 单轮牌价上限                                  |
| `RESIDENT_MANAGER_COMMAND`         | `["claude"]`                                     | 替换经理的 `claude` 命令，用于测试            |
| `RESIDENT_OMH`                     | `../opus-manager/harness/bin/omh.js`             | `omh` 的位置，相对本项目                      |
| `RESIDENT_MANAGER_SKILL`           | `../opus-manager/skill/zh/opus-manager/SKILL.md` | opus-manager 技能文件，经理的工单流程取自这里 |

## 保证和限制

- **不丢不重：** 请求 id 只存一次，决策和后续动作在同一事务里入队。`test/crash.test.ts` 真实 kill 两次 runner 来验证。
- **决策恰好一次，模型调用不是：** 崩溃时正在进行的调用会重做，所以可能多花一次额度。
- **崩溃后重启最多等 10 秒：** 要等旧 runner 的锁过期。
- **Leader 没有工具：** `--restricted --tools ""` 是硬边界，不是提示词约定。请求文本和项目简介都当数据处理，但模型仍可能被其中的内容误导判断。
- **`expected` 不会发给模型：** 回放时的标准答案只用于计算命中率，有测试保证。
- **经理的汇报只应用一次：** 取回汇报和更新工单在同一事务里。runner 崩溃后，正在跑的一轮继续运行，重启后只收取一次，也不会多开一轮。
- **中断的一轮会用同一个会话重来：** 进程真的死了（比如关机）时开新一轮，并告诉经理先查清状态。已经做过的外部操作是否重复，取决于经理的判断，不是硬保证。
- **同一项目同时只跑一张工单。** 第二张排队，等第一张结束或转入等你回答。
- **工人的权限没有变：** 工人以你的系统用户运行，隔离靠 `omh` 的同意项和 worktree，这不是安全沙箱。
- **经理跑在项目根目录，能读项目里的所有文件。**
- **防失控的上限：** 单轮牌价 $3、单张工单经理累计 $15、最多 30 轮、单轮硬超时 60 分钟。超限会停下来问你。
- **Leader 判断为“忽略”的消息不回复，** 只能在 `report` 里看到。
- **当前没有跨话题批处理：** 上游的批处理依赖常驻会话，这里每次评估单独调用一次模型。
- **Windows 上没有文件权限位保护：** 状态目录靠用户目录的 ACL 保护。
- **`node:sqlite` 在 Node 24 仍标记为实验性：** 上游和 OpenClaw 都在用，`npm run resident` 关闭了这条警告。升级 Node 时要回归测试。
- **电脑休眠或关机时不工作。**
- **记忆只有全文检索，没有向量：** 换一种说法、没有共同字词时找不到。评测里单一事实在 3000 条干扰下仍排第一，需要跨几次对话拼起来的问题在约 1000 条后开始漏，要等 M4 的整理。
- **工人能改记忆文件：** 工人以你的系统用户运行，能写状态目录。`origin` 字段防的是模型误写，防不住恶意工人。
- **规则太多会放不下：** 超出上限时卡片只说明少了几条。经理会在汇报里告诉你，Leader 能按词查。

## 开发

```bash
npm run check
```

```bash
npm run coverage
```

克隆后执行 `git config core.hooksPath .githooks`，lint 或类型错误就会阻断提交。

格式化和 lint 用 Biome，`vendor/` 不参与。修改 `vendor/` 前先看 [UPSTREAM.md](vendor/dsh-superagent/UPSTREAM.md)。
