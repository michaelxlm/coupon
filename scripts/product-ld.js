#!/usr/bin/env node
'use strict';
/* ==========================================================================
   product-ld.js · 券商品 Product / Offer JSON-LD 的「宁缺毋错」单一口径（零依赖）
   --------------------------------------------------------------------------
   背景：Search Console 对「字段存在但不完整」判**严重问题**（网页直接不显示商家
   信息），对「字段整体缺失」只判非严重警告。同族两站都栽过：
     - 本站 calculator.html 给免费工具 WebApplication 挂 `offers.price:"0"`（2026-11-11 已移除）
     - store-web 车型详情骨架挂占位 Product + 空 offers（同日修复）
   旧写法 `price: Number(c.price) || 0`、`price: price || undefined`、
   `image: safeUrl(...) || undefined` 在数据缺字段时正好产出两种严重问题形态：
   「有 offers 却无有效 price」与「有 Product 却无 image」。当前券快照每张券都有
   pict_url 与到手价，所以产物是干净的——属**潜伏**隐患：上游少给一个字段就会整片触发。
   本助手把三处生成点（build.js jsonLd / build.js detailPageShell / build-topics.js
   jsonLdBlock）的口径收口成一处，校验侧见 scripts/check-jsonld.js（由 selfcheck.js 阻断）。

   规则（buildProductNode）：
     1. name 为空 → 返回 null（不写 Product）
     2. image 归一后没有 http(s) 绝对地址 → 返回 null（宁可不写商品，也不写缺 image 的商品）
     3. price 是可解析正数 → 写 offers（price 字符串 + priceCurrency + url）；
        否则**整块不写 offers**——绝不写 0 / 空 price，也不写只有 @type 的空壳 offers
     4. availability / seller 等附加字段只透传调用方真实给出的值，
        配送政策 shippingDetails、退换货政策 hasMerchantReturnPolicy 不在这里代填
   用法：
     const LD = require('./product-ld');
     const node = LD.buildProductNode({ name, image, price, url, description });
     node === null 时调用方必须整块省略 Product（ItemList 的 ListItem 降级为只带 url + name）
   ========================================================================== */

/** 图片字段（字符串 / 协议相对 / 数组 / 对象）→ JSON-LD 可用的 http(s) 绝对地址；非法返回 '' */
function absoluteImageUrl(value) {
  let raw = '';
  if (Array.isArray(value)) raw = String(value[0] == null ? '' : value[0]).trim();
  else if (value && typeof value === 'object') raw = String(value.url || value.src || '').trim();
  else raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return 'https:' + raw; // 京东图常见协议相对 //img*.360buyimg.com（保留双斜杠）
  return ''; // 站内相对路径 / data: / javascript: 等一律不写（Google 不认相对 image）
}

/** 价格字段 → 可写入 offers 的正数；非正数 / 非法返回 0（= 不写 offers） */
function positivePrice(value) {
  const n = Number(value);
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * 组装 Product 节点；数据不足以「诚实完整」时返回 null。
 * opts: { name, image, price, url, description, currency, context, availability, seller }
 */
function buildProductNode(opts) {
  const o = opts || {};
  const name = String(o.name == null ? '' : o.name).trim();
  const image = absoluteImageUrl(o.image);
  if (!name || !image) return null;

  const node = {};
  if (o.context) node['@context'] = String(o.context);
  node['@type'] = 'Product';
  node.name = name;
  node.image = image;
  const desc = String(o.description == null ? '' : o.description).trim();
  if (desc) node.description = desc;

  const price = positivePrice(o.price);
  const url = String(o.url == null ? '' : o.url).trim();
  if (price > 0 && /^https?:\/\//i.test(url)) {
    const offers = {
      '@type': 'Offer',
      price: String(price),
      priceCurrency: String(o.currency || 'CNY'),
      url: url,
    };
    // 只透传调用方真实给出的附加字段：券快照剔除过期券后 InStock 才成立，缺省就不写
    if (o.availability) offers.availability = o.availability;
    if (o.seller) offers.seller = o.seller;
    node.offers = offers;
  }
  return node;
}

module.exports = { buildProductNode, absoluteImageUrl, positivePrice };
