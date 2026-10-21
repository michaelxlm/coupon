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

// 与 build.js STATIC_PAGES 对应的手写页（cat/*.html、drops.html、guides.html、p/*.html、guides/*.html
// 由构建生成、chrome 由 shared 整页渲染而非标记注入，不在此列）
const STATIC_PAGES = [
  'index.html', 'browse.html', 'rank.html', 'category.html', 'guide.html',
  'calculator.html', 'holidays.html', 'favorites.html', 'double11.html',
  'my-alerts.html', 'about.html', '404.html',
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

// 4) WCAG accent 白字对比度门禁（审计 T4）
for (const p of require('./check-wcag')()) err('WCAG: ' + p);

// 5) W2 传播地基：零依赖 QR 脚本与分享/热榜/提醒关键资产必须存在（静态资产，缺失即构建断裂）
for (const rel of ['assets/js/qrcode.js', 'assets/js/share.js', 'assets/js/detail-page.js', 'assets/js/drops-page.js', 'assets/js/my-alerts.js', 'assets/js/challenge.js']) {
  if (fs.existsSync(path.join(ROOT, rel))) ok('资产存在 ' + rel);
  else err('缺失资产 ' + rel);
}

// 6) W1/W2/W3 构建产物壳：drops.html / guides.html 由 build 整页写盘（接口不可达也应存在，缺失=构建未跑或异常）
for (const name of ['drops.html', 'guides.html']) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) { err('缺失构建产物页 ' + name); continue; }
  const html = fs.readFileSync(f, 'utf8');
  if (!html.includes('application/ld+json')) { err(name + ' 缺少 JSON-LD'); continue; }
  ok(name + ' 已生成，含 JSON-LD');
}

// 7) W1 详情页壳 /p/*.html 数量：与 snapshot.detailIds 对齐；为 0 视为警告（后端本次可能不可达，池空则不生成）
const pDir = path.join(ROOT, 'p');
let pCount = 0;
try { pCount = fs.readdirSync(pDir).filter(f => f.endsWith('.html')).length; } catch (e) { /* 无目录 */ }
let snapDetailIds = [];
try {
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  snapDetailIds = Array.isArray(snap.detailIds) ? snap.detailIds.map(String) : [];
} catch (e) { /* 快照已在上面校验 */ }
if (pCount > 0) {
  ok('/p/* 详情页壳 ' + pCount + ' 张，snapshot.detailIds=' + snapDetailIds.length);
  if (snapDetailIds.length && Math.abs(snapDetailIds.length - pCount) > pCount * 0.5 + 1) {
    warn('snapshot.detailIds 与 /p/* 数量偏差过大（' + snapDetailIds.length + ' vs ' + pCount + '），my-alerts 详情链接可能大量 404');
  }
} else {
  warn('未发现 /p/* 详情页壳（本次构建详情池可能为空——后端不可达；上线前请确认有券时能生成）');
}

// 8) JSON-LD 合法性：抽样 /p 与 /guides 各一页，内联 ld+json 必须可解析（构建期 JSON.stringify 生成，解析失败=模板污染）
function firstJsonLdValid(file) {
  try {
    const html = fs.readFileSync(file, 'utf8');
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    if (!m) return 'no-ld';
    JSON.parse(m[1]);
    return 'ok';
  } catch (e) { return 'bad'; }
}
{
  let sample = null;
  try { const fl = fs.readdirSync(pDir).filter(f => f.endsWith('.html')); if (fl.length) sample = path.join(pDir, fl[0]); } catch (e) { /* 无目录 */ }
  if (sample) {
    const r = firstJsonLdValid(sample);
    if (r === 'ok') ok('/p 详情页 JSON-LD 合法（样例 ' + path.basename(sample) + '）');
    else err('/p 详情页 JSON-LD 解析失败（' + r + '）：' + path.basename(sample));
  }
  const gDir = path.join(ROOT, 'guides');
  let gsample = null;
  try { const gl = fs.readdirSync(gDir).filter(f => f.endsWith('.html')); if (gl.length) gsample = path.join(gDir, gl[0]); } catch (e) { /* 无目录：接口空属正常 */ }
  if (gsample) {
    const r = firstJsonLdValid(gsample);
    if (r === 'ok') ok('/guides 长文页 JSON-LD 合法（样例 ' + path.basename(gsample) + '）');
    else err('/guides 长文页 JSON-LD 解析失败（' + r + '）：' + path.basename(gsample));
  } else {
    console.log('[selfcheck] · /guides/* 暂无文章（接口空，跳过 JSON-LD 抽样）');
  }
}

// 9) WO-125 场景导购页 topic/*.html：导语 / 比价 / 结构化数据 / 广告位 / CPS 门禁
{
  let topics = [];
  try {
    topics = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'topics.json'), 'utf8'));
  } catch (e) {
    err('读 scripts/topics.json 失败：' + e.message);
  }
  const topicDir = path.join(ROOT, 'topic');
  let checked = 0;
  let aiIntroCount = 0;
  for (const t of (Array.isArray(topics) ? topics : [])) {
    if (!t || !t.slug) continue;
    const f = path.join(topicDir, t.slug + '.html');
    if (!fs.existsSync(f)) { err('缺失场景导购页 topic/' + t.slug + '.html（build-topics 未生成）'); continue; }
    checked++;
    const html = fs.readFileSync(f, 'utf8');

    // 收录态：模板 noindex 未回写即裸模板泄漏
    if (/<meta name="robots" content="noindex/i.test(html)) err('topic/' + t.slug + '.html 仍为 noindex（模板回写失效）');

    // AI 导语：ai=构建期拉取成功；fallback=topics.json 兜底（上游/AI 不可用时仅告警，不阻断部署）
    if (/data-intro-source="ai"/.test(html)) aiIntroCount++;
    else if (!/data-intro-source="fallback"/.test(html)) err('topic/' + t.slug + '.html 缺少导语标记 data-intro-source');
    else warn('topic/' + t.slug + '.html 导语为静态兜底（content/topicIntro 未命中或 AI 不可用）');

    // 比价表 / 券卡 / CPS：数据型指标不足仅告警；结构性缺失报错
    const rows = (html.match(/<td class="cp-rank">/g) || []).length;
    const cards = (html.match(/class="cp-card"/g) || []).length;
    const tracks = (html.match(/data-track="coupon_click"/g) || []).length;
    if (!rows) err('topic/' + t.slug + '.html 缺失实时比价表');
    else if (rows < 5) warn('topic/' + t.slug + '.html 比价行 ' + rows + ' < 5（本次快照可用券不足）');
    if (!cards) err('topic/' + t.slug + '.html 缺失在券好物卡片');
    else if (cards < 5) warn('topic/' + t.slug + '.html 券卡 ' + cards + ' < 5（本次快照可用券不足）');
    if (!tracks) err('topic/' + t.slug + '.html 缺失 CPS 埋点 data-track="coupon_click"');
    else if (tracks < 5) warn('topic/' + t.slug + '.html CPS 埋点仅 ' + tracks + ' 处');

    // 广告位与美图位：广告回归为关键项
    if (!/data-ad-slot="carousel"/.test(html) || !/data-ad-slot="inline"/.test(html)) {
      err('topic/' + t.slug + '.html 广告位骨架缺失（carousel/inline）');
    }
    if (!/data-img-slot="strip"/.test(html)) err('topic/' + t.slug + '.html 美图位骨架缺失（strip）');

    // 结构化数据：CollectionPage + ItemList + FAQPage 三件套，ItemList 少于 5 条仅告警
    const ldMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    if (!ldMatch) { err('topic/' + t.slug + '.html 缺少 JSON-LD'); continue; }
    let graph = null;
    try {
      const parsed = JSON.parse(ldMatch[1]);
      graph = Array.isArray(parsed) ? parsed : [ parsed ];
    } catch (e) {
      err('topic/' + t.slug + '.html JSON-LD 解析失败：' + e.message);
      continue;
    }
    const typeSet = new Set(graph.map(x => x && x['@type']));
    if (!typeSet.has('CollectionPage') || !typeSet.has('ItemList') || !typeSet.has('FAQPage')) {
      err('topic/' + t.slug + '.html JSON-LD 缺 CollectionPage/ItemList/FAQPage');
    }
    const itemList = graph.find(x => x && x['@type'] === 'ItemList');
    const itemCount = itemList && Array.isArray(itemList.itemListElement) ? itemList.itemListElement.length : 0;
    if (itemCount < 5) warn('topic/' + t.slug + '.html JSON-LD ItemList 仅 ' + itemCount + ' 条');
  }
  if (checked) ok('topic/* 场景导购页 ' + checked + ' 个结构完整，AI 导语 ' + aiIntroCount + '/' + checked);
  else err('未发现 topic/* 场景导购页（WO-125 构建产物缺失）');
}

console.log('[selfcheck] 完成：' + errors + ' 错误 / ' + warnings + ' 警告');
process.exit(errors > 0 ? 1 : 0);
