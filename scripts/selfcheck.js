#!/usr/bin/env node
/* ==========================================================================
 * selfcheck.js · 部署前质量门（零依赖，Node 18+）
 * 在 fingerprint.js 之后、sync 之前运行，对构建产物做关键校验。
 *   - 静态页 chrome 标记齐全（CHROME:HEADER/FOOTER 未丢，防 shared 同步断裂）
 *   - 兜底快照存在且为合法 JSON（运行时回退的数据源）
 *   - 指纹已生效（HTML 内不应残留手工 ?v=，应由 fingerprint 改写为哈希名）
 * 退出码：关键项失败 exit 1；仅警告项 exit 0（不阻断部署）。
 * 用法：node scripts/selfcheck.js
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 与 build.js STATIC_PAGES 对应的手写页（cat/*.html 由构建生成，无 CHROME 标记，不在此列）
const STATIC_PAGES = [
  'index.html', 'browse.html', 'rank.html', 'category.html', 'guide.html',
  'calculator.html', 'holidays.html', 'favorites.html', 'double11.html',
  'about.html', '404.html',
];

let errors = 0;
let warnings = 0;

function err(msg) { errors++; console.error('[selfcheck] ✗ ' + msg); }
function warn(msg) { warnings++; console.warn('[selfcheck] ⚠ ' + msg); }
function ok(msg) { console.log('[selfcheck] ✓ ' + msg); }

// 1) 静态页 chrome 标记齐全
for (const name of STATIC_PAGES) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) { err('缺失静态页 ' + name); continue; }
  const html = fs.readFileSync(f, 'utf8');
  const hasHdr = html.includes('<!-- CHROME:HEADER:START -->');
  const hasFtr = html.includes('<!-- CHROME:FOOTER:START -->');
  if (hasHdr && hasFtr) ok(name + ' chrome 标记齐全');
  else err(name + ' 缺少 CHROME 标记（header=' + hasHdr + ' footer=' + hasFtr + '），shared 同步可能断裂');
}

// 2) 兜底快照：存在 + 合法 JSON + featured 为非空数组（空为警告，可能因本次构建后端不可达）
const snapPath = path.join(ROOT, 'data', 'coupon-snapshot.json');
if (!fs.existsSync(snapPath)) {
  err('缺失 data/coupon-snapshot.json，运行时回退数据源不可用');
} else {
  try {
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const featured = Array.isArray(snap.featured) ? snap.featured.length : 0;
    const browse = Array.isArray(snap.browse) ? snap.browse.length : 0;
    const rankOk = snap.rank && Array.isArray(snap.rank.week);
    if (featured > 0) ok('快照 featured=' + featured + ' browse=' + browse + ' rank.week=' + (snap.rank && snap.rank.week ? snap.rank.week.length : 0));
    else warn('快照 featured 为空（本次构建可能未取到券，运行时回退将无内容）');
    if (!rankOk) warn('快照 rank.week 缺失/非数组');
  } catch (e) {
    err('data/coupon-snapshot.json 不是合法 JSON：' + e.message);
  }
}

// 3) 指纹生效：HTML 不应残留手工 ?v=（fingerprint.js 会改写为哈希名）
let vCount = 0;
for (const name of STATIC_PAGES) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) continue;
  const html = fs.readFileSync(f, 'utf8');
  const m = html.match(/\?v=[0-9]{4}\.[0-9]{2}\.[0-9]{2}/g);
  if (m) vCount += m.length;
}
if (vCount === 0) ok('未发现残留 ?v= 手工版本号（指纹已生效）');
else warn('仍有 ' + vCount + ' 处 ?v= 手工版本号，fingerprint.js 可能未运行（不影响功能，仅缓存非最优）');

console.log('[selfcheck] 完成：' + errors + ' 错误 / ' + warnings + ' 警告');
process.exit(errors > 0 ? 1 : 0);
