# omh — opus-manager harness

Claude Code manages; other AI CLIs build and review. This folder is the program that does the mechanical part. Design: [../docs/harness.md](../docs/harness.md) · 中文：[../docs/harness.zh-CN.md](../docs/harness.zh-CN.md). How Claude uses it: [../skill/en/opus-manager/SKILL.md](../skill/en/opus-manager/SKILL.md).

Node.js 20+, no dependencies.

```bash
npm install -g .          # or: node bin/omh.js …
cd /path/to/project
omh init --mcp            # _tickets/ _receipts/ .omh/config.json .mcp.json
omh detect                # installed AI CLIs
omh probe pi              # preset flags vs the tool's real --help
# edit .omh/config.json: workers (with the user's consent), routing, review, budget
omh trial <worker>        # tiny real ticket in a temp dir
```

Daily loop (Claude runs these; you can too):

```bash
omh new login-remember --title "Remember me on login" --kind frontend --files "src/login/**"
omh dispatch T1           # route → claim (open→doing) → sign → start detached
omh wait T1               # returns when the worker exits (run it in the background)
omh verify T1             # re-run acceptance commands + scope check (also writes T1.verify.json)
omh checks T1             # which acceptance profile fits the changed files (prints commands, never runs them)
omh packet T1             # one compact hand-off: state, changed files, checks, reviews, next step
omh review T1             # other-vendor read-only review → _receipts/T1.review-1.md
omh accept T1 --commit    # done/, progress.md, git commit
omh status · omh cost · omh next · omh log T1 · omh kill T1
```

Exit codes: 0 ok · 1 error (JSON on stderr: `{"error": "E_…", "message": …}`) · 2 `wait` timed out · 3 job failed / verify failed / probe mismatch.

Config reference: [examples/config.example.json](examples/config.example.json). Adapter format: appendix of the skill.

Tests: `npm test` (uses a fake worker; no AI CLI needed).
