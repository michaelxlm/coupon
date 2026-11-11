#!/usr/bin/env node
'use strict';
/* ==========================================================================
   check-jsonld.js · 商家信息结构化数据门禁（零依赖，Node 18+）
   --------------------------------------------------------------------------
   与 scripts/product-ld.js 同一口径的**产物侧**校验，接入 selfcheck.js 作阻断项：
   Search Console 对「字段存在但不完整」判**严重问题**（网页不显示商家信息），对
   「字段整体缺失」只判非严重警告，所以门禁只禁两种形态，不要求字段齐全：
     1. 每个 ld+json 必须可解析（构建期 JSON.stringify 产物，解析失败＝模板污染）
     2. Product 必须有 image，且至少一个 http(s) 绝对地址（站内相对地址 Google 不认）
     3. offers 一旦出现就必须有 price 或 priceSpecification；带 price 时必须是可解析
        正数（`price:"0"` 是本站 calculator 免费工具踩过的坑）且必须带 priceCurrency；
        禁止只有 @type 的空壳 offers
     4. offers 只能挂在商品语义节点上（Product/Service/Vehicle 族）：给 WebApplication /
        Article / CollectionPage 等非商品节点挂 offers 会被整体按商家信息判定并判错
   不做的事：不要求 shippingDetails / hasMerchantReturnPolicy（缺省只是非严重提示，
   代填等于替商家编造配送与退换货政策）。
   用法：node scripts/check-jsonld.js        （独立跑，违例 exit 1）
        require('./check-jsonld')()          （被 selfcheck 集成，返回违例数组）
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const { absoluteImageUrl, positivePrice } = require('./product-ld'); // 与生成侧共用同一归一规则

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.github', 'scripts', 'data', 'templates', 'reports', 'deploy', 'archive']);
const LD_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

// 允许承载 offers 的商品语义 @type（其余节点挂 offers＝商家信息误判，见头注释第 4 条）
const OFFER_HOSTS = new Set([
  'Product', 'IndividualProduct', 'GroupProduct', 'SomeProducts',
  'Service', 'Vehicle', 'Car', 'Motorcycle', 'CargoVehicle', 'Bus',
]);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.html')) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

function typesOf(node) {
  const t = node['@type'];
  return Array.isArray(t) ? t.map(String) : (t == null ? [] : [String(t)]);
}

/** image 字段（字符串 / 数组 / 对象混合）→ 合法绝对地址列表（逐个走 product-ld 的归一规则） */
function absoluteImages(image) {
  const list = Array.isArray(image) ? image : [image];
  return list.map((x) => absoluteImageUrl(x)).filter((u) => u !== '');
}

function checkOffers(offers, where, errs) {
  const list = Array.isArray(offers) ? offers : [offers];
  list.forEach((o, i) => {
    const at = where + ' offers[' + i + ']';
    if (!o || typeof o !== 'object') { errs.push(at + ' 不是对象'); return; }
    if (typesOf(o).indexOf('AggregateOffer') !== -1) return; // 聚合报价不要求单值 price
    const keys = Object.keys(o).filter((k) => k !== '@type');
    if (!keys.length) {
      errs.push(at + ' 是空壳 offers（只有 @type）→ 无真实报价时整块不写 offers');
      return;
    }
    const hasPrice = o.price !== undefined && o.price !== null && String(o.price).trim() !== '';
    const hasSpec = o.priceSpecification !== undefined && o.priceSpecification !== null;
    if (!hasPrice && !hasSpec) {
      errs.push(at + ' 缺 price / priceSpecification → 严重问题「应指定 price 或 priceSpecification」；无真实报价请整块不写 offers');
      return;
    }
    if (hasPrice) {
      if (positivePrice(o.price) <= 0) errs.push(at + ' price 不是正数（' + o.price + '）：0 价 / 占位价不写 offers');
      if (!o.priceCurrency) errs.push(at + ' 有 price 但缺 priceCurrency');
    }
  });
}

/** 递归校验：Product 必有绝对 image；offers 必须完整且只能挂在商品语义节点上 */
function checkNode(node, where, errs) {
  if (Array.isArray(node)) {
    node.forEach((x, i) => checkNode(x, where + '[' + i + ']', errs));
    return;
  }
  if (!node || typeof node !== 'object') return;

  const types = typesOf(node);
  if (types.indexOf('Product') !== -1 && !absoluteImages(node.image).length) {
    errs.push(where + ' Product 缺合法 image（需 http(s) 绝对地址）→ 严重问题「未填写字段 image」');
  }
  if (node.offers !== undefined && node.offers !== null) {
    const allowed = types.some((t) => OFFER_HOSTS.has(t));
    if (!allowed) {
      errs.push(where + ' 在非商品节点 @type=' + (types.join('/') || '(无)') + ' 上挂 offers → 会被按商家信息判严重问题（免费工具/内容页不要挂报价）');
    }
    checkOffers(node.offers, where, errs);
  }

  Object.keys(node).forEach((k) => {
    const v = node[k];
    if (v && typeof v === 'object') checkNode(v, where + '.' + k, errs);
  });
}

function checkFile(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const html = fs.readFileSync(file, 'utf8');
  const errs = [];
  let blocks = 0;
  let m;
  LD_RE.lastIndex = 0;
  while ((m = LD_RE.exec(html))) {
    blocks++;
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch (e) {
      errs.push(rel + ' ld+json 解析失败：' + e.message);
      continue;
    }
    checkNode(json, rel, errs);
  }
  return { errs, blocks };
}

module.exports = function run() {
  const files = walk(ROOT, []);
  const problems = [];
  let blocks = 0;
  files.forEach((f) => {
    const r = checkFile(f);
    blocks += r.blocks;
    r.errs.forEach((e) => problems.push(e));
  });
  if (problems.length) {
    problems.slice(0, 40).forEach((p) => console.error('[check-jsonld] ✗ ' + p));
    console.error('[check-jsonld] 共 ' + problems.length + ' 处商家信息问题（扫描 ' + files.length + ' 页 / ' + blocks + ' 个 ld+json 块）');
  } else {
    console.log('[check-jsonld] 扫描 ' + files.length + ' 页 / ' + blocks + ' 个 ld+json 块，商家信息口径合规 ✓');
  }
  return problems;
};

if (require.main === module) {
  process.exit(module.exports().length ? 1 : 0);
}
