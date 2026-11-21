#!/usr/bin/env node
// Fake AI CLI used by the tests. Behaviour is chosen by FAKE_MODE.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-worker 1.0.0');
  process.exit(0);
}
const review = args[0] === '--review';
const prompt = args[args.length - 1] || '';
const mode = process.env.FAKE_MODE || 'ok';
const receipt = (prompt.match(/(\S+?\.receipt\.md)/) || [])[1];

if (review) {
  if (mode === 'reviewfail') {
    console.log('ERROR: model not supported');
    process.exit(1);
  }
  console.log(`审查：fake-reviewer @ now\n总评：一处低严重度问题。\n低｜add.js:1｜示例｜code｜fix`);
  if (mode !== 'nocost') console.log('total cost: $0.0042');
  process.exit(0);
}
if (mode === 'sleep') {
  setTimeout(() => {}, 60_000);
} else {
  console.log('working in', process.cwd());
  fs.writeFileSync('add.js', 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync('add.test.js', "import assert from 'node:assert';\nimport { add } from './add.js';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('ok');\n");
  fs.writeFileSync('package.json', '{"type":"module"}\n');
  if (mode === 'outofscope') fs.writeFileSync('extra.js', '// not allowed\n');
  if (mode !== 'noreceipt' && receipt) {
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, '# 回执\n\n## 2. 文件清单\n- `add.js`\n- `add.test.js`\n');
  }
  if (mode !== 'nocost') console.log('total cost: $0.0100');
  process.exit(mode === 'fail' ? 1 : 0);
}
