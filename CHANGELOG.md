# 更新记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- M0 影子运行：Leader（默认 Opus 5.5、中等强度）判断请求归属并记录，不执行任何工作，也不发送任何消息。
- 引入 dsh-superagent-prototype 的引擎、存储和效果队列（MIT），连同上游测试一起运行。
- 命令：`project`、`say`、`replay`、`run`、`status`、`decisions`、`report`、`review`。
- M1 单项目闭环：登记项目时加 `--execute`，Leader 就会把工作交给经理会话；经理用 `omh` 派工人和验收，结果由 Leader 转告。未开启的项目仍只做影子运行。
- 经理按轮次运行，等工人时不花额度；每一轮脱离 runner，崩溃或重启后只收取一次。
- 命令：`inbox`、`tickets`、`stop`。停止工单时等经理这一轮真正结束，再停掉工人和审查，并把 `omh` 的工单移到 `blocked`。
- M2 记忆：你的消息和经理的汇报写进 Markdown 文件，重启后还在，也可以直接手改。Leader 的卡片带上相关记录、当前工单和规则。
- Leader 新增四个动作：`answer` 直接回答旧事，`attach` 接到旧工单继续做，`remember` 记下规则，`recall` 按词或引用查更多。
- 经理的卡片带上本项目和全局的规则及相关记录，别的项目的记录不会出现。
- 命令：`remember`、`memory list|search|show|forget`，都不需要 runner 在运行。
- 环境变量 `RESIDENT_MEMORY=off`，用来测量没有记忆时的基线。
- 记忆评测：`npm run eval:memory`，用真实模型跑两组，由程序判分，可以用 `--noise` 加入干扰记录。

### 变更

- `project list` 的输出多了一列，显示 `执行` 或 `影子`。
- Leader 需要澄清时，问题现在会进收件箱。
- 决策报告多了 `attached`、`answered`、`remembered` 三个计数。
- 修复：数据库被短暂锁住时，runner 和只读命令会等待最多 10 秒，不再报 `database is locked` 退出。
- Leader 每次调用的花费随卡片变大而增加：300 条记录时约 $0.038，几乎没有记录时约 $0.02。卡片有上限，不会继续涨。
