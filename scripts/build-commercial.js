#!/usr/bin/env node
/* ==========================================================================
 * build-commercial.js · WO-121 高商业意图长尾内容页脚手架（零依赖 Node 18+）
 *
 * 定位：WO-121「内容站群高商业意图产出」的可复用产出骨架——把「怎么买最省 / 怎么领券 /
 * 满减怎么叠加」这类高转化意图长尾查询，批量落成带广告位 + CPS 券位的落地页，喂 §4.3 攒量漏斗。
 *
 * 复用 build-topics.js 同口径取数/渲染助手（buildPool / sceneList / renderCompare / renderGrid /
 * renderFaq / jsonLdBlock / applyChrome / replaceBlock），保证卡片、比价、JSON-LD、站点 chrome
 * 与场景导购页完全一致，不各写一套漂移逻辑。按 scripts/commercial.json 条目生成 buy/<slug>.html：
 *   · 带 data-ad-slot 广告槽（carousel / inline）+ img-slot；
 *   · 券卡 data-track="coupon_click" + data-case="coupon:*"（conversion.js 视口观察产出 coupon_view 曝光，
 *     经本次改动已接入真券 CTR = coupon_click / coupon_view 同一分母）；
 *   · 全页免费无解锁门槛；文案遵循 §0.1·4（无绝对化用语、不诱导、以商家活动页为准）。
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

const ROOT = path.resolve(__dirname, '..');
const SITE_URL_DEFAULT = (process.env.COUPON_SITE_URL || 'https://coupon.zangeng.com').replace(/\/+$/, '');
const OUT_DIR = 'buy';
const RELATED = ['<!-- COMMERCIAL:RELATED:START -->', '<!-- COMMERCIAL:RELATED:END -->'];

// 省钱攻略页内链（区别于场景导购的 /topic/ 相关）：链到其他高商业意图页
function renderRelated(items, currentSlug) {
  const links = items.filter(t => t.slug !== currentSlug)
    .map(t => `<a class="cp-his-chip" href="/buy/${H.esc(t.slug)}.html">${H.esc(t.kw)}怎么买最省</a>`);
  return '<div class="cp-his">' + links.join('\n          ') + '</div>';
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
  const hot = H.sortByValue(pool.filter(c => H.isLinkable(c) && !H.isExpired(c)));
  const outDir = path.join(ROOT, OUT_DIR);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const slugs = [];
  items.forEach(function (t) {
    if (!t || !t.slug) return;
    const list = H.sceneList(pool, buckets, hot, t);
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
    html = H.applyChrome(html);
    fs.writeFileSync(path.join(outDir, t.slug + '.html'), html, 'utf8');
    console.log('[build-commercial] buy/' + t.slug + '.html：比价 ' + Math.min(list.length, 8) + ' 行 / 卡片 ' + Math.min(list.length, 12) + ' 张 / 导语 ' + (introSource === 'ai' ? 'AI' : '静态兜底'));
    slugs.push(t.slug);
  });
  console.log('[build-commercial] 完成，共 ' + slugs.length + ' 个高商业意图省钱攻略页');
  return slugs;
}

module.exports = { buildCommercial };

// 独立运行：读盘上快照后生成
if (require.main === module) {
  let snap = {};
  try { snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'coupon-snapshot.json'), 'utf8')); } catch (e) { console.warn('[build-commercial] 读 coupon-snapshot.json 失败（生成空态壳）：', e.message); }
  try { buildCommercial(snap, SITE_URL_DEFAULT); } catch (e) { console.warn('[build-commercial] 异常（忽略，不阻断部署）：', e.message); }
}
