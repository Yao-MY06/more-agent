---
id: T<N>
title: <标题 / title>
kind: default
files: [<允许改动的文件 / allowed files>]
# depends: [T1]
# workdir: .
# worktree: true
# worker: <worker id>
# budget_usd: 2
# timeout_min: 60
---
# T<N>：<简短标题>

<!-- 头部字段（上面 --- 之间）：kind 决定派给谁；depends 列前置工单；files 是允许改动的文件（支持 * 和 **），omh verify 会据此查越界；workdir 是作业目录；worktree: true 时在独立 git worktree 里施工；worker 可钉死某个工人；budget_usd / timeout_min 覆盖默认值。 -->

## 目标
<一句话：这张单解决什么问题。>

## 动手前先读
1. <项目规矩，如 AGENTS.md / CLAUDE.md>
2. <这次改动涉及的文件、文档或 issue>

## 边界
1. 只动头部 `files` 里列出的文件，别的不碰。
2. 密钥不写进代码、文档和日志。
3. 不 git commit / push（经理验收后统一提交）。
4. 工单文件留在 `_tickets/doing/`，不要挪。
5. 不写遍历目录、逐个改文件内容的脚本；改哪个文件就点名改哪个。
6. 不打开数据库、图片、压缩包这类非文本文件（本单点名要处理的除外）。

## 验收（写命令，不写感觉；每条一行，命令放在反引号里，omh verify 会逐条重跑）
1. `<命令>` → <预期结果，如测试全过>
2. `<命令>` → <预期输出或字段值>

## 为什么这样验收
<这些检查要保住的真实目的。过了检查不是目标，这个才是。>

## 产出
- <要新建或修改的文件>
