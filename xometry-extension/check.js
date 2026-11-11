// npm run check: синтаксическая проверка всех .js в src/ (node --check по каждому файлу).
// Список файлов собирается сам, поэтому новый скрипт не забудется. В сборку для магазина не попадает.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(path.join(__dirname, 'src'));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    process.stderr.write(String(e.stderr || e.message));
  }
}
console.log(`${files.length - failed} of ${files.length} files OK`);
process.exit(failed ? 1 : 0);
