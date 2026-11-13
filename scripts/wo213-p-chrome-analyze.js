#!/usr/bin/env node
'use strict';
// WO-213② 诊断：统计 coupon/p/*.html 的 (site-header 数, site-footer 数) 分布，定位 syncChromeOnDisk 跳过原因
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'p');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== '_shell.html');
const H = /<header class="site-header">/g, F = /<footer class="site-footer">/g;
const cat = {};
const examples = {};
for (const f of files) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const h = (t.match(H) || []).length;
  const ft = (t.match(F) || []).length;
  const key = h + ',' + ft;
  cat[key] = (cat[key] || 0) + 1;
  if (!examples[key]) examples[key] = f;
}
console.log('文件总数:', files.length);
console.log('(header数,footer数) -> 文件数 | 示例');
for (const k of Object.keys(cat).sort()) {
  console.log(`  ${k} -> ${cat[k]}  (例: ${examples[k]})`);
}
// 会触发 syncChromeOnDisk 失败的 = 非 (1,1)
const fail = files.filter(f => {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const h = (t.match(H) || []).length, ft = (t.match(F) || []).length;
  return h !== 1 || ft !== 1;
}).length;
console.log('\n应被 syncChromeOnDisk 跳过的文件数 (h!=1||f!=1):', fail);
