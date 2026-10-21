#!/usr/bin/env node
/* ==========================================================================
 * build-topics.js · F-AI-3 AI 场景导购 + 实时比价落地页预渲染（WO-125 · 零依赖 Node 18+）
 *
 * 背景：coupon 为纯静态站，主入口是百度等弱 JS 爬虫 → 场景页券内容需构建期落进 HTML 才被索引。
 * 本脚本读 data/coupon-snapshot.json（build.js 写盘的同一次取数结果，无需再打后端），
 * 按 scripts/topics.json 场景条目，把
 *   · AI 场景导语（TOPIC:INTRO · build.js 传入 content/topicIntro 结果，缺失回落 topics.json）
 *   · 实时比价表（TOPIC:COMPARE · 按省钱力度排序，复用 browse/list 同口径）
 *   · 在券好物卡片网格（TOPIC:GRID · 保留 CPS data-track="coupon_click"）
 *   · ItemList + FAQPage 结构化数据（TOPIC:JSONLD / TOPIC:FAQ）
 * 预渲染进 topic/<slug>.html。全页免费无解锁门槛；ad-slot / img-slot 骨架保留不动。
 *
 * 口径对齐 build.js：saveScore / sortByValue / buildCard / cardLink / isLinkable / isExpired 同规则，
 * 预渲染与运行时（list-page.js）顺序一致。幂等：注入内容用 TOPIC:* START/END 标记整段覆盖，重跑不叠加。
 * fail-soft：快照缺失/异常不抛出，页壳仍写盘（空态），绝不阻断部署。
 *
 * 用法：
 *   node scripts/build-topics.js                                   # 独立跑（读 data/coupon-snapshot.json，导语走静态兜底）
 *   require('./build-topics').buildTopics(snapshot, SITE_URL, {    # build.js 内联调用（复用同次快照对象）
 *     intros: { <slug>: '<AI 导语>' }                             #   有 AI 导语用 AI，无则回落 topics.json
 *   })
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./shared-partials');
const { COUPON_SITE, TOPIC_NAV } = require('./site-config');

const ROOT = path.resolve(__dirname, '..');
const SITE_URL_DEFAULT = (process.env.COUPON_SITE_URL || 'https://coupon.zangeng.com').replace(/\/+$/, '');
const TOP_N = 8;   // 比价表行数（验收下限：每场景 ≥5 张比价券卡）
const GRID_TOP = 12; // 卡片网格张数
const MIN_SHOW = 3;  // 低于此匹配数则回落热门池，避免场景页空壳

// 模板标记（与 topic-template.html 一一对应）：标记内整段覆盖，标记外不动
const BLOCKS = {
  jsonld: ['<!-- TOPIC:JSONLD:START -->', '<!-- TOPIC:JSONLD:END -->'],
  intro: ['<!-- TOPIC:INTRO:START -->', '<!-- TOPIC:INTRO:END -->'],
  compare: ['<!-- TOPIC:COMPARE:START -->', '<!-- TOPIC:COMPARE:END -->'],
  grid: ['<!-- TOPIC:GRID:START -->', '<!-- TOPIC:GRID:END -->'],
  faq: ['<!-- TOPIC:FAQ:START -->', '<!-- TOPIC:FAQ:END -->'],
  related: ['<!-- TOPIC:RELATED:START -->', '<!-- TOPIC:RELATED:END -->'],
  index: ['<!-- TOPIC:INDEX:START -->', '<!-- TOPIC:INDEX:END -->'],
};

// 站点 chrome：与 build.js 根页共用 shared-partials + site-config，避免场景页旧菜单漂移
const CHROME = {
  header: ['<!-- CHROME:HEADER:START -->', '<!-- CHROME:HEADER:END -->'],
  footer: ['<!-- CHROME:FOOTER:START -->', '<!-- CHROME:FOOTER:END -->'],
};

function applyChrome(html) {
  const header = P.renderHeader(COUPON_SITE, { nav: TOPIC_NAV }, {}, { navAriaCurrent: true });
  const footer = P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' });
  html = replaceBlock(html, CHROME.header, header);
  html = replaceBlock(html, CHROME.footer, footer);
  return html;
}

/* ---------------- 工具函数（与 build.js 同口径，独立内联免循环依赖） ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(u) {
  if (typeof u !== 'string') return '';
  const v = u.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^\/\//.test(v)) return 'https:' + v;
  return '';
}

function cardLink(c) {
  return safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) ||
    (c.item_url ? 'https://' + String(c.item_url).replace(/^https?:\/\//i, '') : '');
}

function saveScore(c) {
  const off = Number(c.couponDiscount) || 0;
  const price = Number(c.price) || 0;
  if (off <= 0) return 0;
  return off + (off / (price + off)) * 100;
}

function sortByValue(list) {
  return list.slice().sort((a, b) => {
    const d = saveScore(b) - saveScore(a);
    if (d !== 0) return d;
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });
}

function isLinkable(c) {
  return Boolean(safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) || (c.item_url && String(c.item_url).trim()));
}

// 券到期时间解析：兼容时间戳（秒/毫秒）与日期字符串；解析不出返回 0
function endMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) { const n = Number(s); return s.length >= 12 ? n : n * 1000; }
  const t = Date.parse(s.replace(/\.\d+/, '').replace(/-/g, '/'));
  return isNaN(t) ? 0 : t;
}
function isExpired(c) {
  const ms = endMs(c && c.couponEndTime);
  return ms > 0 && ms <= Date.now();
}
function expireLabel(c) {
  const ms = endMs(c && c.couponEndTime);
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return '';
  const d = Math.ceil(diff / 86400000);
  return d <= 1 ? '即将到期' : (d + '天后失效');
}

// 与 build.js 卡片同结构：CPS data-track="coupon_click" + data-case 归因 + 防 CLS 尺寸
function buildCard(c) {
  const link = cardLink(c);
  const cid = String(c.tao_id || c._id || '');
  const off = Number(c.couponDiscount) || 0;
  const quota = Number(c.couponQuota) || 0;
  const finalPrice = Number(c.price) || 0;
  const rel = link ? ' rel="sponsored noopener"' : '';
  const href = link ? esc(link) : '#';
  let html = `<a class="cp-card" href="${href}"${rel} target="_blank" data-track="coupon_click"`;
  if (cid) html += ` data-case="coupon:${esc(cid)}"`;
  html += '>';
  const imgSrc = safeUrl(c.pict_url);
  if (imgSrc) {
    html += `<img src="${esc(imgSrc)}" alt="${esc(c.title || '')}" width="300" height="300" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  }
  html += `<span class="cp-name">${esc(c.title || '优惠券')}</span><div class="cp-price">`;
  if (off > 0) html += `<span class="cp-off">${esc(quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off))}</span>`;
  if (finalPrice > 0) html += `<span class="cp-final">¥${esc(finalPrice)}</span>`;
  const exLabel = expireLabel(c);
  if (exLabel) html += `<span class="cp-expire">${esc(exLabel)}</span>`;
  html += '</div></a>';
  return html;
}

/* ---------------- 候选池构建与场景取数 ---------------- */
// 把快照各分区合成去重候选池（同一次构建数据，避免 topic 再打后端）
function buildPool(snap) {
  const seen = new Set();
  const pool = [];
  const lists = [];
  if (Array.isArray(snap.featured)) lists.push(snap.featured);
  if (Array.isArray(snap.browse)) lists.push(snap.browse);
  if (snap.rank) ['day', 'week', 'month'].forEach(k => { if (Array.isArray(snap.rank[k])) lists.push(snap.rank[k]); });
  if (snap.category) Object.keys(snap.category).forEach(k => { if (Array.isArray(snap.category[k])) lists.push(snap.category[k]); });
  if (Array.isArray(snap.drops)) lists.push(snap.drops);
  lists.forEach(arr => arr.forEach(c => {
    if (!c) return;
    const id = String(c.tao_id || c._id || c.item_url || c.title || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    pool.push(c);
  }));
  return pool;
}

function sortScene(list, sort) {
  const arr = list.slice();
  if (sort === 'discount') arr.sort((a, b) => (Number(b.couponDiscount) || 0) - (Number(a.couponDiscount) || 0));
  else if (sort === 'priceAsc') arr.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
  else if (sort === 'priceDesc') arr.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
  else if (sort === 'expire') arr.sort((a, b) => { const x = endMs(a.couponEndTime), y = endMs(b.couponEndTime); return (x && x > Date.now() ? x : Number.MAX_SAFE_INTEGER) - (y && y > Date.now() ? y : Number.MAX_SAFE_INTEGER); });
  else return sortByValue(arr);
  return arr;
}

// 场景取数：标题命中 match 词 ∪ 快照 category[match 词] 桶；不足 MIN_SHOW 回落热门池按 value 兜底
function sceneList(pool, buckets, hot, scene) {
  const terms = ((scene.match && scene.match.length ? scene.match : [scene.kw]) || [])
    .map(t => String(t).trim()).filter(Boolean);
  const lower = terms.map(t => t.toLowerCase());
  const picked = new Map();
  pool.forEach(c => {
    if (!isLinkable(c) || isExpired(c)) return;
    const title = String(c.title || '').toLowerCase();
    if (lower.some(k => k && title.includes(k))) picked.set(String(c.tao_id || c._id || c.item_url || c.title), c);
  });
  // 追加快照品类桶（build.js 已按关键词取数，标题未必含词，桶即搜索结果）
  terms.forEach(t => {
    (buckets[t] || []).forEach(c => {
      if (!c || !isLinkable(c) || isExpired(c)) return;
      picked.set(String(c.tao_id || c._id || c.item_url || c.title), c);
    });
  });
  let list = Array.from(picked.values());
  if (list.length < MIN_SHOW) list = list.concat(hot.filter(c => !picked.has(String(c.tao_id || c._id || c.item_url || c.title))));
  return sortScene(list, scene.sort || 'value');
}

/* ---------------- 渲染片段 ---------------- */
function renderCompare(list, kw) {
  const rows = list.slice(0, TOP_N).map((c, i) => {
    const off = Number(c.couponDiscount) || 0;
    const quota = Number(c.couponQuota) || 0;
    const price = Number(c.price) || 0;
    const power = off > 0 ? (quota > 0 ? ('满' + quota + '减' + off) : ('立减 ¥' + off)) : '—';
    const link = cardLink(c) || '#';
    const cid = String(c.tao_id || c._id || '');
    const rel = link !== '#' ? ' rel="sponsored noopener"' : '';
    const track = ` data-track="coupon_click"${cid ? ` data-case="coupon:${esc(cid)}"` : ''}`;
    return `  <tr><td class="cp-rank">${i + 1}</td>`
      + `<td class="cp-cname"><a href="${esc(link)}"${rel} target="_blank"${track}>${esc(c.title || '优惠券')}</a></td>`
      + `<td class="cp-off">${esc(power)}</td>`
      + `<td class="cp-final">${price > 0 ? ('¥' + esc(price)) : '—'}</td></tr>`;
  }).join('\n');
  return `<table class="cp-compare">\n          <caption>实时${esc(kw)}比价 · 按省钱力度排序，先领券再下单更省（全页免费，无需登录）</caption>\n          <thead>\n            <tr><th scope="col">#</th><th scope="col">商品</th><th scope="col">券力度</th><th scope="col">到手价</th></tr>\n          </thead>\n          <tbody>\n${rows}\n          </tbody>\n        </table>`;
}

function renderGrid(list) {
  if (!list.length) return '<div class="cp-empty">该场景暂无在券好物，先去 <a href="/browse.html">全部好物</a> 逛逛。</div>';
  return list.slice(0, GRID_TOP).map(buildCard).join('\n          ');
}

function faqItems(kw) {
  return [
    { q: `${kw}优惠券在哪里领？`, a: `本页已按省钱力度实时聚合 ${kw} 相关在券好物，点击任意券卡或比价行即跳转商家活动页领取，全页免费、无需登录、无解锁门槛。` },
    { q: `${kw}券领了怎么用最省？`, a: '先比价再凑单：对比到手价与券力度（满减门槛），把可用券叠加到商家活动页的满减/满赠上，最终优惠以商家活动页为准。' },
    { q: '页面价格会变动吗？', a: '券力度与到手价由各平台联盟实时同步，可能随时调整；本站按构建期最近一次快照排序展示，下单前请以商家活动页实时价格为准。' },
    { q: '本站参与交易或收费吗？', a: '不参与。本站仅作优惠券内容聚合与跳转，展示与核销由各平台官方活动页完成，不设付费墙、不收取任何费用。' },
  ];
}

function renderFaq(kw) {
  const items = faqItems(kw);
  return `<dl class="cp-faq">\n          ` + items.map(f => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join('\n          ') + '\n        </dl>';
}

// 其他场景互链（topic 页内链，避免只能靠 sitemap 发现）
function renderRelated(topics, currentSlug) {
  const links = topics.filter(t => t.slug !== currentSlug)
    .map(t => `<a class="cp-his-chip" href="/topic/${esc(t.slug)}.html">${esc(t.kw)}</a>`);
  links.push('<a class="cp-his-chip" href="/topic/index.html">全部场景 →</a>');
  return '<div class="cp-his">' + links.join('\n          ') + '</div>';
}

// 场景索引卡片：复用 cp-card 外观，标题 + 场景词 + 在券数量
function renderIndexCards(topics, counts) {
  return topics.map(function (t) {
    const n = Number(counts[t.slug]) || 0;
    return '<a class="cp-card" href="/topic/' + esc(t.slug) + '.html" data-topic="' + esc(t.slug) + '">'
      + '<span class="cp-name">' + esc(t.title) + '</span>'
      + '<div class="cp-price"><span class="cp-off">' + esc(t.kw) + '实时比价</span>'
      + (n > 0 ? '<span class="cp-expire">' + n + ' 件在券</span>' : '')
      + '</div></a>';
  }).join('\n          ');
}

function indexJsonLd(topics, url, siteUrl) {
  const items = topics.map((t, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: siteUrl + '/topic/' + t.slug + '.html',
    name: t.title,
    description: t.desc || '',
  }));
  const graph = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: '场景导购', description: '按生活场景找券：手机、美妆、零食、家居、通勤穿搭、开学装机、露营囤货，实时比价按省钱力度排序。', url: url, inLanguage: 'zh-CN', isPartOf: { '@type': 'WebSite', name: '小满券仓', url: siteUrl } },
    { '@context': 'https://schema.org', '@type': 'ItemList', name: '场景导购', url: url, itemListElement: items },
  ];
  return '<script type="application/ld+json">\n' + JSON.stringify(graph, null, 0) + '\n</script>';
}

// 场景索引页：站内唯一「场景导购」入口，生成 topic/index.html
function buildTopicIndex(topics, counts, siteUrl) {
  const canonical = siteUrl + '/topic/index.html';
  const tpl = fs.readFileSync(path.join(ROOT, 'topic-index-template.html'), 'utf8');
  let html = tpl
    .split('{{CANONICAL}}').join(canonical)
    .split('content="noindex, nofollow"').join('content="index, follow"');
  html = replaceBlock(html, BLOCKS.jsonld, indexJsonLd(topics, canonical, siteUrl));
  html = replaceBlock(html, BLOCKS.index, renderIndexCards(topics, counts));
  html = applyChrome(html);
  fs.writeFileSync(path.join(ROOT, 'topic', 'index.html'), html, 'utf8');
  console.log('[build-topics] topic/index.html：' + topics.length + ' 个场景入口');
}

function jsonLdBlock(list, scene, url, siteUrl, sceneIntro) {
  const items = list.slice(0, 20).map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: cardLink(c) || url,
    item: {
      '@type': 'Product',
      name: c.title || '优惠券',
      image: safeUrl(c.pict_url) || undefined,
      description: (c.title ? c.title + '。' : '') + '京东/淘宝等平台联盟实时优惠，先领券再下单更省。',
      offers: {
        '@type': 'Offer',
        price: Number(c.price) || 0,
        priceCurrency: 'CNY',
        url: cardLink(c) || url,
        availability: 'https://schema.org/InStock',
      },
    },
  }));
  const faq = faqItems(scene.kw).map(f => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  }));
  const graph = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: scene.title, description: sceneIntro || scene.desc || '', url: url, inLanguage: 'zh-CN', isPartOf: { '@type': 'WebSite', name: '小满券仓', url: siteUrl || SITE_URL_DEFAULT } },
    { '@context': 'https://schema.org', '@type': 'ItemList', name: scene.title, url: url, itemListElement: items },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
  ];
  return '<script type="application/ld+json">\n' + JSON.stringify(graph, null, 0) + '\n</script>';
}

function replaceBlock(html, pair, inner) {
  const [start, end] = pair;
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s !== -1 && e !== -1 && e > s) {
    return html.slice(0, s + start.length) + '\n' + inner + '\n' + html.slice(e);
  }
  return html;
}

/* ---------------- 主流程 ---------------- */
function buildTopics(snapshot, siteUrlOpt, options) {
  const SITE_URL = String(siteUrlOpt || SITE_URL_DEFAULT).replace(/\/+$/, '');
  const root = ROOT;
  const aiIntros = (options && options.intros) || {};
  const topics = JSON.parse(fs.readFileSync(path.join(root, 'scripts/topics.json'), 'utf8'));
  const tpl = fs.readFileSync(path.join(root, 'topic-template.html'), 'utf8');
  const snap = snapshot || {};
  const pool = buildPool(snap);
  const buckets = snap.category || {};
  const hot = sortByValue(pool.filter(c => isLinkable(c) && !isExpired(c)));
  const outDir = path.join(root, 'topic');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const slugs = [];
  const counts = {};
  topics.forEach(function (t) {
    const list = sceneList(pool, buckets, hot, t);
    counts[t.slug] = list.length;
    // AI 导语优先（content/topicIntro 构建期拉取）；未命中/生成失败回落 topics.json 场景导语
    const aiIntro = String(aiIntros[t.slug] || '').trim();
    const sceneIntro = aiIntro || String(t.intro || t.desc || '').trim();
    const introSource = aiIntro ? 'ai' : 'fallback';
    const canonical = SITE_URL + '/topic/' + t.slug + '.html';
    let html = tpl
      .split('{{SLUG}}').join(t.slug)
      .split('{{KW}}').join(t.kw)
      .split('{{TITLE}}').join(t.title)
      .split('{{DESC}}').join(t.desc || '')
      .split('{{CANONICAL}}').join(canonical)
      // 模板源件默认 noindex（防裸模板泄漏被收录）；生成的真实专题落地页恢复 index, follow 照常收录
      .split('content="noindex, nofollow"').join('content="index, follow"');
    // 结构化数据 / 导语 / 比价表 / 卡片网格 / FAQ —— 标记内整段覆盖，幂等
    html = replaceBlock(html, BLOCKS.jsonld, jsonLdBlock(list, t, canonical, SITE_URL, sceneIntro));
    html = replaceBlock(html, BLOCKS.intro, `<p class="hero-sub" data-intro-source="${introSource}">${esc(sceneIntro)}</p>`);
    html = replaceBlock(html, BLOCKS.compare, list.length ? renderCompare(list, t.kw) : '<p class="cp-empty">该场景实时比价正在上新，稍后再来。</p>');
    html = replaceBlock(html, BLOCKS.grid, renderGrid(list));
    html = replaceBlock(html, BLOCKS.faq, renderFaq(t.kw));
    html = replaceBlock(html, BLOCKS.related, renderRelated(topics, t.slug));
    html = applyChrome(html);
    fs.writeFileSync(path.join(outDir, t.slug + '.html'), html, 'utf8');
    console.log('[build-topics] topic/' + t.slug + '.html：比价 ' + Math.min(list.length, TOP_N) + ' 行 / 卡片 ' + Math.min(list.length, GRID_TOP) + ' 张 / 导语 ' + (introSource === 'ai' ? 'AI' : '静态兜底'));
    slugs.push(t.slug);
  });
  buildTopicIndex(topics, counts, SITE_URL);
  slugs.push('index');
  console.log('[build-topics] 完成，共 ' + topics.length + ' 个场景导购页 + 1 个索引页');
  return slugs;
}

module.exports = { buildTopics };

// 独立运行：读盘上快照后生成
if (require.main === module) {
  let snap = {};
  try { snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'coupon-snapshot.json'), 'utf8')); } catch (e) { console.warn('[build-topics] 读 coupon-snapshot.json 失败（生成空态壳）：', e.message); }
  try { buildTopics(snap, SITE_URL_DEFAULT); } catch (e) { console.warn('[build-topics] 异常（忽略，不阻断部署）：', e.message); }
}
