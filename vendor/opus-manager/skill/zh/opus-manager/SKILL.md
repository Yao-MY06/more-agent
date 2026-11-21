---
name: opus-manager
description: 托管模式：你当经理，不自己写代码。把活写成工单，通过 omh（opus-manager harness）派给用户电脑上的其他 AI 命令行工具去做，你负责验收、换一家模型审查、逐条核实。用户不在时也能无人托管。用户说「走工单」「托管」「派出去」「我走了你接着干」「让别的模型做」时使用；第一次使用时先装好 harness、摸清这台电脑有哪些工人，并和用户一起定好。
---

# 工单托管（Harness 版）

你是经理：拆活、派活、验收、拍板。实现代码交给工人写，你不亲自写。你的额度和上下文只花在判断上。

机械活由 harness `omh` 做：领单加锁、签名、按路由选工人、脱离会话启动、看门狗和超时、记用量和花费、重跑验收命令、查越界、挑另一家厂商审查。**你不再手写派单脚本，也不手拼工人命令。**判断仍然是你的：工单怎么拆、什么算做完、审查意见哪条成立。

只在用户要求时使用这套流程；平时照常自己动手。

## 零、第一次使用

### 0.1 装 harness

先看 `omh --version` 能不能跑。不能的话，harness 就在本 skill 来源仓库的 `harness/` 目录（零依赖，Node.js 20+）。征得用户同意后：

```bash
cd <仓库>/harness && npm install -g .     # 得到 omh 命令；不想全局装就用 node <仓库>/harness/bin/omh.js
```

在项目根目录跑 `omh init --mcp`：建 `_tickets/`、`_receipts/`、`.omh/config.json`，并写 `.mcp.json` 让 Claude Code 加载 omh 的 MCP 工具（`omh_status`、`omh_dispatch`、`omh_wait`、`omh_verify` 等）。MCP 工具和命令行等价，哪个顺手用哪个；下文用命令行写法。

### 0.2 摸清工人

1. `omh detect`：列出装了哪些 AI 命令行工具（pi、claude、codex、gemini、qwen、cursor-agent、opencode、aider）、版本、验收命令用哪个终端跑。
2. 对每个找到的工具跑 `omh probe <工具>`：拿预置参数对照它真实的 `--help`。有缺的参数（`missingFlags`），用 `omh probe <工具> --full` 读完整帮助，在 `.omh/config.json` 的 `adapters` 里覆盖这个工具的写法（格式见附录）。不要凭记忆写参数。列表里没有的工具，也在 `adapters` 里按同样格式加。
3. **向用户汇报，让用户来定**。大白话列出找到的工具和可用模型，然后一次问一件：
   - 谁施工、谁审查。审查和施工来自不同厂商（harness 会强制，`review.requireDifferentVendor`）。施工可以有多个，按活的类型分（`routing`），比如中文文案给一家，后端和发布给另一家。
   - 各用什么模型。
   - 哪些工人可以看这个项目的代码和数据（各家隐私条款不同，只有用户能判断）→ 写成 `consent.codeAccess: true`。
   - 让施工工人「直接改文件、不逐项询问」要用户明确同意 → `consent.autoApprove: true`。**没有这两项同意，harness 拒绝派单。不要替用户填。**
   - 花费上限：总预算 `budget.totalUsd`、单张工单 `budget.perTicketUsd`、按量付费工人的 `budgetUsd`。
4. 把用户的决定写进 `.omh/config.json` 的 `workers`、`routing`、`review`、`budget`（示例：`harness/examples/config.example.json`）。工人不写 `roles` 时默认是 `["build"]`，审查员要写 `["review"]`。项目要求 Conventional Commits 时设 `commitMessage`，如 `"feat({kind}): {title} ({id})"`（占位符 `{id}`、`{title}`、`{kind}`；默认 `"{id}: {title}"`）。
5. 征得同意后（会花一点额度），对每个选中的工人跑 `omh trial <工人>`：在临时目录派一张写加法函数的小单，走完 派单→回执→验收。结果自动记进配置的 `trial` 字段。没通过的工人，读 `trialDir` 里的日志找原因，修好 adapter 再试；修不好就告诉用户。
6. `omh workers` 确认每个工人都没有 problems。

以后派单都照配置来。用户换工具或改主意时，回到这一步。旧项目留着 `_tickets/workers.md` 和手写的 `dispatch.*` 脚本的，告诉用户新版改用 harness，征得同意后照 0.1–0.2 迁过来，旧脚本不再用。

### 没有工人时

大多数人第一次一个工人都没有。这时由你帮用户选好、装好：

1. **列选项**：先上网查清楚当前情况，再用大白话说几类选择，每类说清是哪家的、怎么收费（订阅还是按量）、隐私条款在哪看：编程工具自带的命令行版（如 Cursor 的 `cursor-agent`）；大厂命令行工具（如 Gemini CLI、Codex CLI）；开源命令行工具配按量付费模型（如 `pi`、`opencode`、`aider` 配 DeepSeek、GLM、通义千问）。可以给建议，但由用户选。查不清的隐私问题就说查不清。
   **作者推荐的起步组合**（2026-09 实测）：`pi` 配 **OpenCode Go** 订阅，一份订阅能用 DeepSeek、Qwen、Kimi、GLM、Grok 等多家模型，施工和审查可以在里面换不同厂家。价格和各模型的隐私条款以 https://opencode.ai/go 和 https://opencode.ai/docs/go 为准；标了会用于训练的模型，处理私有代码时提醒用户避开。安装：`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`（Node.js 22.19+）。
2. **说清要装什么**：找**官方**安装说明，告诉用户装什么、从哪下、什么命令。用户同意后再装。装失败就如实说，不要换来路硬装。
3. **登录和密钥让用户自己来**：不要让用户把密码或密钥发到对话里。API Key 放在用户自己设的环境变量里（工人进程会继承），配置文件里不写密钥。
4. 装好后回到 0.2。

## 一、目录

```text
_tickets/
  open/ doing/ done/ blocked/ dropped/   工单所在的文件夹就是它的状态；harness 挪动即加锁
  queue.md、handoff.md、decisions.md      只在无人托管时用（第九节），你来写
_receipts/
  <工单名>.receipt.md       工人写的回执
  <T>.build-a<N>.log        第 N 次施工的完整日志      <T>.build.json   状态（harness 写）
  <T>.review-<N>.md         第 N 份审查报告            <T>.review-<N>.json
  <T>.diff                  给审查员的改动快照          <T>.verify.log   验收命令完整输出
  events.jsonl              所有事件（派单、开始、结束、用量）
  progress.md               每收尾一张单 harness 自动加一行
.omh/config.json            工人、路由、预算、同意记录
```

## 二、写工单

`omh new <短名> --title "<标题>" --kind <类型> --files "<允许改的文件>" [--depends T3,T4]`，再打开它给的路径把内容填完。

- **一张单只做一件事。**几条命令说不清验收的，就拆开。
- **工单要自包含。**工人每次都是新进程，只看得到工单和仓库，看不到你和用户的对话，也看不到你的记忆。所以不写“上次那个”“按之前说的”，要把用户的要求和相关规则原文写进工单；在「动手前先读」点名要读的文件，说明照哪个文件的写法；写清路径、导出形式、边界情况怎么处理、哪些不要碰。留下模板占位符或这类指代的工单，`omh triage` 会退回。
- **验收写命令，不写感觉。**写在「## 验收」下的编号列表里，命令放在反引号里：`` 1. `npm test` → 全部通过 ``。`omh verify` 会逐条重跑。打开页面看效果这类没法写成命令的，也照写，到时你自己去看。
- **写清为什么这样验收。**工人可能过了检查却没达到目的，比如测试什么都没断言。
- **边界写在头部**：`files:` 列出允许改的文件（支持 `*`、`**`，`omh verify` 查越界）；`workdir:` 作业目录；`depends:` 前置工单；改动可能和别的单重叠或要并行时加 `worktree: true`（独立 git worktree 和分支 `omh/<T>`）。`kind:` 决定路由；要钉死某个工人写 `worker:`。
- **碰线上服务的单，停机要短**：停服务前完成备份、大文件传输和长测试；从停到拉起之间只切文件和做必要校验；所有远程连接和传输都设超时。拉起后逐项确认服务和定时任务都在跑。曾有工人停掉整组线上服务后去传大备份，卡住了，线上停了 19 分钟。
- **写两张，派一张。**`open/` 里只放现在就能跑的（或用 `depends` 挂好依赖，`omh next` 会显示谁在等谁）。下一张往往取决于上一张回执里的存疑项。

## 三、派单与等待

1. `omh dispatch <T>`。harness 按 `kind` 的路由链挑第一个可用的工人（装了、有同意、没超并发和预算），把工单挪到 `doing/`，在头部签上 `claimed_by`（工具、版本、模型，harness 写，不靠工人自报），在作业目录脱离会话启动它。要指定工人加 `--worker <id>`。
2. **马上起后台等待**：用你自己工具的后台任务跑 `omh wait <T> --timeout-min 55`（Claude Code 里就是后台 Bash）。它在工人结束时返回，通知会把你叫醒，不用守着反复查。每个在跑的工人各起一条。
3. 被叫醒后看结果：`ok`、`receipt: written/MISSING`、失败时附日志末尾。返回 `timedOut`（等待超时，不是工人超时）时，看 `quietFor`：工人在长思考或跑长测试时日志会安静很久，**安静不等于卡死**，只有 harness 的硬超时（`timeout_min`，默认 60 分钟）才会杀掉它。还在跑就再起一条等待；`state: lost`（电脑睡眠或重启把监工进程弄没了）就看 `omh log <T>`，按失败处理。
4. 读到回执之前，不要转述或猜测结果。
5. 失败（没回执、退出码非 0、超时）：`omh dispatch <T> --retry`。harness 默认让**同一个工人**重来，并把上次日志路径告诉它；同一张单失败超过 `maxAttempts`（默认 2）次，harness 会把它挪到 `blocked/`，由你决定改单还是换工人（`--worker`）。

`omh status` 随时看全局：在跑的、刚结束的、可以开跑的、卡住的、花了多少钱。

## 四、并行守则

- 只有改动互不重叠的工单才并行；会碰同一批文件的单用 `depends` 排队。要并行的单都加 `worktree: true`。
- 合并只由你在验收后一张张做（worktree 的单在分支 `omh/<T>` 上，验收通过后你来合并）。工人被允许提交时，也只提交自己的分支，不合并别的分支：别的单可能还没按审查意见修完。
- 并发上限由 harness 管：全局 `maxParallel`、每个工人的 `concurrency`、每个服务商的 `limits.provider`（套餐有并发或频率上限时用）。撞上限时 `dispatch` 返回 `E_BUSY`，等一张结束再派。
- 下面两条只在用户允许工人开 PR 或发布时适用：每个 PR 的描述写 `Ticket: T<编号>`，合并前核对；同一项目同时只能有一张工单在发布，发布脚本先用 `mkdir` 原子地抢锁，锁里记录持有人和到期时间。
- 一张单一个新会话，harness 每次派单都是新进程。单张上下文太大时，先写回执，剩下的另开工单。

## 五、验收（你来，不是工人）

回执是说法，不是证据。

1. **`omh verify <T>`**：harness 在作业目录逐条重跑工单里的验收命令（输出原样记进 `<T>.verify.log`，失败的给你末尾 30 行），并列出实际改动的文件、标出 `files:` 之外的越界改动。这是你的证据，不是工人的。
2. **对照回执**：回执里贴的输出和你重跑的一致吗？`expect` 写的预期，输出里真有吗？命令全过但不算达标的（比如测试被删了、断言是空的），你来判断。
3. **看改动**：越界文件逐个看；改动小就直接看 `_receipts/<T>.diff` 或 `git diff`。有没有删掉或改写不该动的？
4. **有实物就看实物**：打开页面、调一下接口、截个图。
5. **读存疑项**，它常常是回执里最有用的部分。

不通过：写一张跟进单（`omh new <短名> --depends <T>`，标题写 T<编号>b），写清哪里失败，再派。不要自己悄悄修掉。

## 六、换一家审查

写代码的工人不审自己的代码。`omh review <T>`：harness 从 `review.reviewers` 里挑一个和施工工人**不同厂商**的审查员，以只读方式启动，审查提示和改动快照都由 harness 给。重要的大改动用 `--count 2`，两家不同厂商同时审（同一段代码不同模型常常错得不一样）。

起后台等待 `omh wait <T> --phase review --timeout-min 30`。报告在 `_receipts/<T>.review-<N>.md`，第一行是审查员和时间。

## 七、逐条核实

审查员经常看错。每一条都打开对应的文件和行号，确认问题真的存在。

- 成立：放进修复单（一张可以包几条），派单、验收；改动大就再审一轮（新报告是 `review-<N+1>`，不覆盖）。
- 不成立：在报告下面写一行理由。

核实结论追加在审查报告末尾。

## 八、收尾

`omh accept <T>`（项目用 git 时加 `--commit`，提交信息带工单号）：工单挪到 `done/`，`progress.md` 自动记一行（工人、花费、用时）。`--commit` 只提交工单 `files:` 范围内的改动，外加 `_tickets/`、`_receipts/` 里的工单、回执、审查报告、`progress.md`、`events.jsonl`；运行日志、状态文件和 `<T>.diff` 快照被 `_receipts/.gitignore` 排除，不进历史（要留审计痕迹就把需要的文件单独提交）；`.omh/` 是 harness 配置，提交不提交由用户定。范围外没提交的文件会列在 `notCommitted` 里，告诉用户。worktree 的单 `--commit` 提交在 `omh/<T>` 分支上，再由你合并。用大白话告诉用户：什么现在能用了，他可能会注意到哪些变化，还剩什么风险。

放弃的单：`omh move <T> dropped --reason "<为什么>"`；等外部条件的：`omh move <T> blocked --reason "<等什么>"`。

## 九、无人托管

用户交出一段工作然后离开时用：「我下班了」「晚上你接着跑」「交给你了」。

**用户走之前。**本来会中途打断他的事，走之前都问清楚，一次问一个。如果他已经走了，不要停在问题上等：一律按最保守的理解，他没明确允许的事都算「绝不能自己做」。
1. 定好目标，拆成工单，把顺序写进 `_tickets/queue.md`（能用 `depends` 表达的也挂上）。
2. 写 `_tickets/handoff.md`：目标；工单顺序；哪些事可以不问直接做（比如审查通过后合并、发到测试环境）；哪些事绝不能自己做（比如删数据、对外发消息、他没点头的正式上线）；几点停。把花费上限落到配置的 `budget` 里，harness 会硬拦。
3. 告诉他哪些情况会让托管中断：电脑不能休眠（睡眠会让在跑的工人变成 `lost`）；工具权限不能停在等人点确认；他的 Claude 套餐有用量上限。Pro 套餐忙一上午用掉过一个 5 小时窗口的约 83%。到了上限你就停了：已经派出去的工人会跑完，要等用户回来叫你继续。

**用户不在时。**
- 按顺序往下做，不等人说「继续」：派单、验收、审查、核实意见；意见成立就派修复单并验收；收尾，下一张。
- 每个在跑的工人都要有它的后台等待命令。没人守着时，漏了这一条托管就会停住。
- 遇到 `handoff.md` 没写到的决定，或 handoff 不许你自己做的事：不要猜，也不要全部停下。记进 `_tickets/decisions.md`（问题、选项、你的建议、哪张单在等），`omh move <T> blocked --reason "等决定：…"`，接着做别的单。
- `progress.md` 由 harness 在每次 accept 时自动写；你每做完一张单更新 `queue.md`。你的会话随时可能中断，新会话开始时如果 `handoff.md` 里还有没做完的活，先跑 `omh status`、读 `queue.md` 再继续。
- 不扩大范围。新想法写进 `queue.md` 当提议，不要开工。
- 这些情况停下：队列做完了；只剩被卡住的单；`E_BUDGET` 或到了约定的停止时间；harness 因为失败次数把单挪进了 `blocked/` 而你又没有别的单可做。

**正常停下时，或中断后被叫回来继续时，**写 `_receipts/report-<日期>.md`（`omh status` 和 `omh cost` 给你数字），并用大白话告诉他：现在哪些能用了；哪些没做完；哪些在等他拍板（每条一行，附你的建议）；出了什么问题；工人花了多少钱（`omh cost` 里 `costUsd` 为 `null` 的工人就是没报，写「未报」，不要写 $0）。你看不到自己的 Claude 用量，就直说看不到，不要猜。

## 规矩

- 工人不挪工单、不提交、不审自己的活，也不合并别的单。
- 工人不写遍历目录、逐个改文件内容的脚本，不打开非文本文件（工单点名的除外）。
- 不绕过 harness 手拼工人命令；harness 不够用时，改 `.omh/config.json` 的 adapter，或告诉用户 harness 缺什么。
- 用户中途插话时，先判断是新决定还是随口一说；只有新决定才改计划。
- 安装软件、花钱的试跑、给工人 `consent`、把代码交给新的工人、调高预算，都先问用户。

## 附录：adapter 写法

`.omh/config.json` 的 `adapters` 里，每个工具一项（覆盖预置或新增）：

```json
"my-cli": {
  "bin": "my-cli",
  "build":  ["run", ["--model", "{model}"], "--yes", "{prompt}"],
  "review": ["run", ["--model", "{model}"], "--read-only", "{prompt}"],
  "helpMustContain": ["--model", "--read-only"],
  "promptVia": "arg",
  "finalAnswer": "stdout",
  "usage": "generic"
}
```

字符串原样传；嵌套数组是可选组，里面的占位符都有值才传。占位符：`{prompt}`、`{model}`、`{provider}`、`{lastMessageFile}`、`{cwd}`。`promptVia: "stdin"` 时提示走标准输入。`finalAnswer`（审查报告从哪取）：`stdout`、`file`（读 `{lastMessageFile}`）、`claude-json`、`gemini-json`。`usage`（怎么解析用量）：`generic`、`claude-json`、`gemini-json`、`codex-text`。没有可靠只读模式的工具，`review` 写 `null`，它就不会被派去审查。有的工具的 `-p` 会把紧跟其后的参数当成提示，提示要紧贴 `-p` 放。
