import { constants, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectPath = process.argv[2];
if (!projectPath) throw new Error('指定微信订阅项目的固定目录。');
const target = resolve(projectPath);
const runtime = fileURLToPath(new URL('../runtime/', import.meta.url));
const files = ['wechat-rss.mjs', 'digests.mjs', 'subscriptions.html', 'config.json'];
const copied = [];
const existing = [];

mkdirSync(join(target, 'state'), { recursive: true });
for (const name of files) {
  try {
    copyFileSync(join(runtime, name), join(target, name), constants.COPYFILE_EXCL);
    copied.push(name);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    existing.push(name);
  }
}
console.log(JSON.stringify({ project: target, copied, existing }, null, 2));
