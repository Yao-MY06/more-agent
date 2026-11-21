# T<N>: <short title>

<!-- Header fields (between the --- lines): kind picks the worker; depends lists prerequisite tickets; files are the paths this ticket may change (supports * and **) and omh verify flags anything outside them; workdir is where the worker runs; worktree: true builds in an isolated git worktree; worker pins a specific worker; budget_usd / timeout_min override defaults. -->

## Goal
<One sentence: what problem this ticket solves.>

## Read first
1. <Project rules, e.g. AGENTS.md / CLAUDE.md>
2. <Files, docs or issues this change touches>

## Boundaries
1. Only touch the files listed in the header `files`.
2. No secrets in code, docs or logs.
3. No git commit / push (the manager commits after acceptance).
4. Leave the ticket file in `_tickets/doing/`.
5. No scripts that walk directories and rewrite files; name each file you change.
6. Don't open databases, images, archives or other non-text files unless this ticket names them.

## Acceptance (commands, not feelings; one per line, command in backticks — omh verify re-runs each)
1. `<command>` → <expected result, e.g. all tests pass>
2. `<command>` → <expected output or field value>

## Why these checks
<The real purpose these checks protect. Passing the checks is not the goal; this is.>

## Output
- <Files to create or change>
