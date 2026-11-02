# 上游来源

本目录复制自 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，见 `LICENSE`）。固定的提交和每个文件的状态见 `manifest.json`。上游声明它是研究原型，不是正式产品。

`test/vendor.test.ts` 用 `manifest.json` 里的哈希校验 `unchanged` 列表，防止有人误改未修改的文件。

## 改动

| 文件 | 改了什么 | 原因 |
|---|---|---|
| `src/app/store.ts` | 去掉设置历史和数据库迁移，schema 从 1 开始 | 这两块依赖上游的 `policy.ts`，而它连着整个 DSH 和 GitHub Source |
| `src/kv.ts` | 只保留 Store 和 Runtime 的键 | 其余键属于已去掉的设置、提示词和 Source |
| `src/sources/host.ts` | 只保留 `Health` 类型 | `infra/health.ts` 只用到这个类型 |
| `tests/store.spec.ts` | 去掉设置、迁移、视图相关的 4 个测试；Windows 上跳过 POSIX 权限测试 | 对应代码已去掉；Windows 不用权限位，状态目录靠用户目录的 ACL 保护 |

## 升级方法

1. 在 `../../../refs/dsh-superagent-prototype` 拉取新提交。
2. 对比 `manifest.json` 的 `unchanged` 列表，覆盖没改过的文件。
3. 把 `modified` 列表里的改动手工合并过去。
4. 跑 `npm run check`，再更新 `manifest.json`。
