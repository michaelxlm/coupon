#!/usr/bin/env node
/* ==========================================================================
 * [已归档 · DEPRECATED] cache-bust.js
 * --------------------------------------------------------------------------
 * 本脚本已被 scripts/fingerprint.js（内容哈希指纹）取代，不再用于本仓库部署。
 * deploy.yml 在 build.js 之后运行 fingerprint.js，对本地 css/js 生成
 * <name>.<hash>.<ext> 并改写引用，配合 Nginx immutable 长缓存实现「无手工版本号」
 * 的最优缓存。手工 ?v=YYYY.MM.DD 方式已不再需要，保留此文件仅作历史参考。
 *
 * 如需本地手工刷新版本号（极少见场景），请改用 fingerprint.js：
 *   node scripts/fingerprint.js --dry     # 只报告命中
 *   node scripts/fingerprint.js           # 就地改写运行副本
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function version() {
  if (process.argv[2]) return process.argv[2];
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
}

function walk(dir, out) {
  fs.readdirSync(dir).forEach(name => {
    if (name === 'node_modules' || name.startsWith('.')) return;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.html')) out.push(full);
  });
  return out;
}

function isExternal(u) {
  return /^(https?:)?\/\//i.test(u) || /^data:/i.test(u);
}

function run() {
  console.warn('[cache-bust] 已废弃：请改用 scripts/fingerprint.js（内容哈希）。本脚本不再参与部署。');
  const v = version();
  const files = walk(ROOT, []);
  let touchedFiles = 0;
  let touchedLinks = 0;

  const re = /(href|src)="([^"]*?\.(?:css|js))(?:\?[^"]*)?"/gi;
  const reBuild = /data-build="[^"]*"/gi;

  files.forEach(file => {
    const src = fs.readFileSync(file, 'utf8');
    let count = 0;
    let next = src.replace(re, (whole, attr, p) => {
      if (isExternal(p)) return whole;
      count++;
      return attr + '="' + p + '?v=' + v + '"';
    });
    if (reBuild.test(next)) {
      next = next.replace(reBuild, 'data-build="' + v + '"');
      reBuild.lastIndex = 0;
      count++;
    }
    if (count > 0 && next !== src) {
      fs.writeFileSync(file, next);
      touchedFiles++;
      touchedLinks += count;
    }
  });

  console.log('[cache-bust] 版本号 v=' + v + '（已废弃，未实际写入）');
  console.log('[cache-bust] 命中 ' + touchedLinks + ' 处引用，涉及 ' + touchedFiles + ' 个文件（已废弃）。');
}

run();
