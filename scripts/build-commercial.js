#!/usr/bin/env node
/* ==========================================================================
 * build-commercial.js · WO-121 高商业意图长尾内容页脚手架（零依赖 Node 18+）
 *
 * 定位：WO-121「内容站群高商业意图产出」的可复用产出骨架——把「怎么买最省 / 怎么领券 /
 * 满减怎么叠加」这类高转化意图长尾查询，批量落成带广告位 + CPS 券位的落地页，喂 §4.3 攒量漏斗。
 *
 * 复用 build-topics.js 同口径取数/渲染助手（buildPool / sortScene / renderCompare / renderGrid /
 * renderFaq / jsonLdBlock / applyChrome / replaceBlock），保证卡片、比价、JSON-LD、站点 chrome
 * 与场景导购页完全一致，不各写一套漂移逻辑。按 scripts/commercial.json 条目生成 buy/<slug>.html：
 *   · 带 data-ad-slot 广告槽（carousel / inline）+ img-slot；
 *   · 券卡 data-track="coupon_click" + data-case="coupon:*"（conversion.js 视口观察产出 coupon_view 曝光，
 *     经本次改动已接入真券 CTR = coupon_click / coupon_view 同一分母）；
 *   · 全页免费无解锁门槛；文案遵循 §0.1·4（无绝对化用语、不诱导、以商家活动页为准）。
 *
 * 取数与场景页的差异（WO-121 数据质量腿）：buy 页是「iPhone16 怎么买」这类具体品类查询的
 * 落地页，不做热门池回落（sceneList 的 <MIN_SHOW 兜底会把无关券灌进高转化页，损害转化与
 * E-E-A-T），无匹配即空态；并按标题去重（同商品多券链接只保留省钱力度最高的一条）。
 * 另生成 buy/index.html 索引页（与 topic/index.html 同构）：导航/页脚/相关互链均指向它，
 * 解决 buy 页无站内入口、只能靠 sitemap 发现的孤儿页问题。
 *
 * 幂等：TOPIC:* / COMMERCIAL:RELATED 标记内整段覆盖，重跑不叠加。
 * fail-soft：快照缺失/异常不抛出，页壳仍写盘（空态），绝不阻断部署。
 *
 * 用法：
 *   node scripts/build-commercial.js                 # 独立跑（读 data/coupon-snapshot.json，导语走静态兜底）
 *   require('./build-commercial').buildCommercial(snapshot, SITE_URL, { intros: { <slug>: '<AI 导语>' } })
 *     # build.js 内联调用（复用同次快照对象；有 AI 导语用 AI，无则回落 commercial.json intro/desc）
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { __helpers: H } = require('./build-topics');
const P = require('./shared-partials');
const { COUPON_SITE } = require('./site-config');

const ROOT = path.resolve(__dirname, '..');
const SITE_URL_DEFAULT = (process.env.COUPON_SITE_URL || 'https://coupon.zangeng.com').replace(/\/+$/, '');
const OUT_DIR = 'buy';
const RELATED = ['<!-- COMMERCIAL:RELATED:START -->', '<!-- COMMERCIAL:RELATED:END -->'];
const BUY_INDEX = ['<!-- COMMERCIAL:INDEX:START -->', '<!-- COMMERCIAL:INDEX:END -->'];
const BUY_NAV = '/buy/index.html'; // 省钱攻略页在主菜单中的高亮落点（与 TOPIC_NAV 同机制）

// 省钱攻略页内链（区别于场景导购的 /topic/ 相关）：链到其他高商业意图页 + 攻略索引页
function renderRelated(items, currentSlug) {
  const links = items.filter(t => t.slug !== currentSlug)
    .map(t => `<a class="cp-his-chip" href="/buy/${H.esc(t.slug)}.html">${H.esc(t.kw)}怎么买更省</a>`);
  links.push('<a class="cp-his-chip" href="/buy/index.html">全部省钱攻略 →</a>');
  return '<div class="cp-his">' + links.join('\n          ') + '</div>';
}

// buy 页 chrome：与场景页同走 shared-partials 单一源，仅主菜单高亮落在「省钱攻略」
const CHROME_HEADER = ['<!-- CHROME:HEADER:START -->', '<!-- CHROME:HEADER:END -->'];
const CHROME_FOOTER = ['<!-- CHROME:FOOTER:START -->', '<!-- CHROME:FOOTER:END -->'];
function applyBuyChrome(html) {
  const header = P.renderHeader(COUPON_SITE, { nav: BUY_NAV }, {}, { navAriaCurrent: true });
  const footer = P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' });
  html = H.replaceBlock(html, CHROME_HEADER, header);
  html = H.replaceBlock(html, CHROME_FOOTER, footer);
  return html;
}

/* ---------------- buy 页专属取数：严格匹配，不回落热门池，同品去重 ---------------- */
// 与 sceneList 同口径的候选（标题命中 match 词 ∪ 快照 category[词] 桶），但：
//   ① 不足 MIN_SHOW 不 concat 热门池（无关券灌入高转化页比空态更伤）；
//   ② 先按 sort 排序再按归一化标题去重——同商品多条券链接只留省钱力度/力度序最高的一条
function strictSceneList(pool, buckets, scene) {
  const terms = ((scene.match && scene.match.length ? scene.match : [scene.kw]) || [])
    .map(t => String(t).trim()).filter(Boolean);
  const lower = terms.map(t => t.toLowerCase());
  const picked = new Map();
  pool.forEach(c => {
    if (!H.isLinkable(c) || H.isExpired(c)) return;
    const title = String(c.title || '').toLowerCase();
    if (lower.some(k => k && title.includes(k))) picked.set(String(c.tao_id || c._id || c.item_url || c.title), c);
  });
  terms.forEach(t => {
    (buckets[t] || []).forEach(c => {
      if (!c || !H.isLinkable(c) || H.isExpired(c)) return;
      picked.set(String(c.tao_id || c._id || c.item_url || c.title), c);
    });
  });
  const sorted = H.sortScene(Array.from(picked.values()), scene.sort || 'value');
  const seenTitle = new Set();
  return sorted.filter(c => {
    const key = String(c.title || '').replace(/\s+/g, '').toLowerCase();
    if (!key) return true;
    if (seenTitle.has(key)) return false;
    seenTitle.add(key);
    return true;
  });
}

/* ---------------- 攻略索引页 buy/index.html（与 topic/index.html 同构，站内唯一「省钱攻略」入口） ---------------- */
function renderBuyIndexCards(items, counts) {
  return items.map(function (t) {
    const n = Number(counts[t.slug]) || 0;
    return '<a class="cp-card" href="/buy/' + H.esc(t.slug) + '.html" data-buy="' + H.esc(t.slug) + '">'
      + '<span class="cp-name">' + H.esc(t.title) + '</span>'
      + '<div class="cp-price"><span class="cp-off">实时比价 · ' + H.esc(t.kw) + '</span>'
      + (n > 0 ? '<span class="cp-expire">' + n + ' 件在券</span>' : '<span class="cp-expire">券源上新中</span>')
      + '</div></a>';
  }).join('\n          ');
}

function buyIndexJsonLd(items, url, siteUrl) {
  const graph = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: '省钱攻略', description: '高商业意图品类领券攻略：怎么领券、满减怎么叠加、到手价实时比价，先领券再下单更省。', url: url, inLanguage: 'zh-CN', isPartOf: { '@type': 'WebSite', name: '小满券仓', url: siteUrl } },
    { '@context': 'https://schema.org', '@type': 'ItemList', name: '省钱攻略', url: url, itemListElement: items.map((t, i) => ({ '@type': 'ListItem', position: i + 1, url: siteUrl + '/buy/' + t.slug + '.html', name: t.title, description: t.desc || '' })) },
  ];
  return '<script type="application/ld+json">\n' + JSON.stringify(graph, null, 0) + '\n</script>';
}

function buildBuyIndex(items, counts, siteUrl) {
  const canonical = siteUrl + '/buy/index.html';
  const tpl = fs.readFileSync(path.join(ROOT, 'buy-index-template.html'), 'utf8');
  let html = tpl
    .split('{{CANONICAL}}').join(canonical)
    // 模板源件默认 noindex；生成的真实索引页恢复 index, follow 照常收录
    .split('content="noindex, nofollow"').join('content="index, follow"');
  html = H.replaceBlock(html, H.BLOCKS.jsonld, buyIndexJsonLd(items, canonical, siteUrl));
  html = H.replaceBlock(html, BUY_INDEX, renderBuyIndexCards(items, counts));
  html = applyBuyChrome(html);
  fs.writeFileSync(path.join(ROOT, OUT_DIR, 'index.html'), html, 'utf8');
  console.log('[build-commercial] buy/index.html：' + items.length + ' 个省钱攻略入口');
}

function buildCommercial(snapshot, siteUrlOpt, options) {
  const SITE_URL = String(siteUrlOpt || SITE_URL_DEFAULT).replace(/\/+$/, '');
  const aiIntros = (options && options.intros) || {};
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/commercial.json'), 'utf8'));
  const tpl = fs.readFileSync(path.join(ROOT, 'commercial-template.html'), 'utf8');
  if (!Array.isArray(items)) return [];
  const snap = snapshot || {};
  const pool = H.buildPool(snap);
  const buckets = snap.category || {};
  const outDir = path.join(ROOT, OUT_DIR);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const slugs = [];
  const counts = {};
  items.forEach(function (t) {
    if (!t || !t.slug) return;
    const list = strictSceneList(pool, buckets, t); // buy 页严格取数：不灌热门、同品去重
    counts[t.slug] = list.length;
    // AI 导语优先（构建期拉取）；未命中回落 commercial.json 静态导语/desc
    const aiIntro = String(aiIntros[t.slug] || '').trim();
    const intro = aiIntro || String(t.intro || t.desc || '').trim();
    const introSource = aiIntro ? 'ai' : 'fallback';
    const canonical = SITE_URL + '/buy/' + t.slug + '.html';
    let html = tpl
      .split('{{SLUG}}').join(t.slug)
      .split('{{KW}}').join(t.kw)
      .split('{{TITLE}}').join(t.title)
      .split('{{DESC}}').join(t.desc || '')
      .split('{{CANONICAL}}').join(canonical)
      // 模板源件默认 noindex（防裸模板泄漏被收录）；生成的真实省钱攻略落地页恢复 index, follow 照常收录
      .split('content="noindex, nofollow"').join('content="index, follow"');
    // JSON-LD / 导语 / 比价表 / 卡片网格 / FAQ / 相关攻略 —— 标记内整段覆盖，幂等
    html = H.replaceBlock(html, H.BLOCKS.jsonld, H.jsonLdBlock(list, t, canonical, SITE_URL, intro));
    html = H.replaceBlock(html, H.BLOCKS.intro, `<p class="hero-sub" data-intro-source="${introSource}">${H.esc(intro)}</p>`);
    html = H.replaceBlock(html, H.BLOCKS.compare, list.length ? H.renderCompare(list, t.kw) : '<p class="cp-empty">该品类实时比价正在上新，稍后再来。</p>');
    html = H.replaceBlock(html, H.BLOCKS.grid, H.renderGrid(list));
    html = H.replaceBlock(html, H.BLOCKS.faq, H.renderFaq(t.kw));
    html = H.replaceBlock(html, RELATED, renderRelated(items, t.slug));
    html = applyBuyChrome(html);
    fs.writeFileSync(path.join(outDir, t.slug + '.html'), html, 'utf8');
    console.log('[build-commercial] buy/' + t.slug + '.html：比价 ' + Math.min(list.length, 8) + ' 行 / 卡片 ' + Math.min(list.length, 12) + ' 张 / 导语 ' + (introSource === 'ai' ? 'AI' : '静态兜底'));
    slugs.push(t.slug);
  });
  buildBuyIndex(items.filter(t => t && t.slug), counts, SITE_URL);
  slugs.push('index');
  console.log('[build-commercial] 完成，共 ' + (slugs.length - 1) + ' 个高商业意图省钱攻略页 + 1 个索引页');
  return slugs;
}

module.exports = { buildCommercial };

// 独立运行：读盘上快照后生成
if (require.main === module) {
  let snap = {};
  try { snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'coupon-snapshot.json'), 'utf8')); } catch (e) { console.warn('[build-commercial] 读 coupon-snapshot.json 失败（生成空态壳）：', e.message); }
  try { buildCommercial(snap, SITE_URL_DEFAULT); } catch (e) { console.warn('[build-commercial] 异常（忽略，不阻断部署）：', e.message); }
}
