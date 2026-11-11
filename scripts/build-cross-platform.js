#!/usr/bin/env node
/* ==========================================================================
 * build-cross-platform.js · 跨平台「同款」报价离线产物生成器（WO-189）
 *
 * 用途：从构建期券快照 data/coupon-snapshot.json 生成可选离线产物
 *       data/cross-platform-offers.json，供前端 assets/js/price-compare.js 读取。
 *       前端优先读该产物；产物缺省/读取失败时降级为「暂无可比价数据」空态。
 *
 * 诚实口径（硬约束，不得放宽）：
 *   - 只使用券快照里「真实存在」的 c.platform 字段；缺 platform 的券直接跳过，
 *     绝不默认补 jd / taobao，更不生成 pdd / douyin 等尚未接入平台的报价或点击数据。
 *   - 只使用真实到手价 c.price（>0）；无价券不参与比价。
 *   - 同款归并只按 title 归一化（去括号块 / 促销词 / 规格数字 / 分隔符号），
 *     不调用任何外部接口、不猜测商品 ID 映射、不合并「看起来像」的近似词。
 *   - 某款只有单一平台报价时，原样保留并标 comparable=false，由前端明确提示
 *     「当前仅 1 个平台报价，暂不构成立足比价」。
 *
 * 零依赖：只用 Node 内置 fs / path；不 require 任何第三方包、不打后端。
 * 可复跑：输入不变则输出字节级稳定（updatedAt 取自快照时间戳，不用墙钟），
 *         分组/offers 全部按固定规则排序，覆盖写而非追加。
 * 退出码：恒为 0（产物可选，缺输入只打印说明，绝不阻断 CI）。
 *
 * 用法（在 coupon/ 仓库根执行）：
 *   node scripts/build-cross-platform.js
 *   node scripts/build-cross-platform.js --input=data/coupon-snapshot.json --output=data/cross-platform-offers.json
 *   COUPON_ROOT=/path/to/coupon node scripts/build-cross-platform.js
 * CI 接入建议：在 `node scripts/build.js` 写完 coupon-snapshot.json 之后追加本命令。
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------ 参数解析 ------------------------------ */
function arg(name, fallback) {
  const prefix = '--' + name + '=';
  for (const a of process.argv.slice(2)) if (a.indexOf(prefix) === 0) return a.slice(prefix.length);
  return fallback;
}

const ROOT = process.env.COUPON_ROOT
  ? path.resolve(process.env.COUPON_ROOT)
  : path.resolve(__dirname, '..');
const INPUT_REL = arg('input', 'data/coupon-snapshot.json');
const OUTPUT_REL = arg('output', 'data/cross-platform-offers.json');
const INPUT = path.resolve(ROOT, INPUT_REL);
const OUTPUT = path.resolve(ROOT, OUTPUT_REL);

/* ------------------------- 同款归并：title 归一化 -------------------------
 * 与 assets/js/price-compare.js 的 normalizeTitle 同口径：改动需两处同步。
 * 步骤：小写去空白 → 去括号块（促销/店铺/活动标签）→ 去促销词 → 去规格数量
 *       → 去分隔符号 → 去活动价/满减/折扣数字串。保留型号字母数字（避免过度归并）。
 * 归一结果长度 < 4 的键不参与归并，防止短键把不同商品误判为同款。
 * ------------------------------------------------------------------------ */
const PROMO_WORDS = [
  '优惠券', '领券', '券后', '大额券', '内部券', '隐藏券', '专属券',
  '包邮', '秒杀', '限时', '特价', '爆款', '旗舰店', '官方', '正品', '新品',
  '热卖', '直降', '满减', '买一送一', '第二件', '双十一', '双11', '618',
  '预售', '付定金', '定金', '到手价', '立减', '赠品', '免邮', '全国包邮',
  '超级', '狂欢', '活动', '专享', '限量', '抢购', '补贴', '百亿', '划算',
  '推荐', '优选', '自营', '同款', '现货', '速发', '礼盒', '新款', '升级款',
  '加量', '促销', '优惠', '京东', '淘宝', '天猫', '拼多多', '抖音', '专属',
  '折上折', '省钱', '必买', '清单', '攻略', '合集',
];
const SPEC_RE = /\d+(?:\.\d+)?(?:ml|l|g|kg|mg|斤|两|片|支|袋|盒|包|条|只|个|件|套|罐|瓶|粒|枚|张|本|台|部|双|对|米|cm|mm|寸|gb|tb)/gi;
const NUM_PROMO_RE = [
  /满\d+(?:\.\d+)?减\d+(?:\.\d+)?/g,
  /\d+(?:\.\d+)?折/g,
  /\d+(?:\.\d+)?元/g,
  /第\d+件/g,
  /\d+(?:\.\d+)?起/g,
];

function normalizeTitle(raw) {
  let s = String(raw == null ? '' : raw).toLowerCase();
  s = s.replace(/[\s\u3000]+/g, '');
  s = s.replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '');
  for (const w of PROMO_WORDS) s = s.split(w).join('');
  s = s.replace(SPEC_RE, '');
  for (const re of NUM_PROMO_RE) s = s.replace(re, '');
  s = s.replace(/[\/\\|+&·,，。!！?？~～:：;；'"“”‘’*#\-—_]/g, '');
  return s;
}

/* ------------------------------ 读取与收集 ------------------------------ */
function collectCoupons(snap) {
  const out = [];
  const push = (list) => { if (Array.isArray(list)) for (const c of list) if (c && typeof c === 'object') out.push(c); };
  push(snap.featured);
  push(snap.browse);
  push(snap.drops);
  if (snap.rank && typeof snap.rank === 'object') {
    for (const k of Object.keys(snap.rank).sort()) push(snap.rank[k]);
  }
  if (snap.category && typeof snap.category === 'object') {
    for (const k of Object.keys(snap.category).sort()) push(snap.category[k]);
  }
  // 同一券在多个池里重复出现：按 _id 优先、tao_id 兜底去重（不同平台的同款券 id 不同，不会被误删）
  const seen = Object.create(null);
  return out.filter((c) => {
    const key = String(c._id || c.tao_id || '').trim();
    if (!key || seen[key]) return false;
    seen[key] = 1;
    return true;
  });
}

/* ------------------------------ 生成产物 ------------------------------ */
function build(snap) {
  const coupons = collectCoupons(snap);
  const platformsSeen = Object.create(null);
  const groups = Object.create(null);
  let validOffers = 0;

  for (const c of coupons) {
    // 硬约束：platform 必须来自快照且真实存在，缺失/异常一律跳过，不默认补平台
    const plat = String(c.platform == null ? '' : c.platform).trim().toLowerCase();
    if (!plat || !/^[a-z0-9_-]{1,20}$/.test(plat)) continue;
    // 硬约束：必须有真实到手价
    const price = Number(c.price);
    if (!isFinite(price) || price <= 0) continue;
    const key = normalizeTitle(c.title);
    if (key.length < 4) continue; // 短键不归并，防误合并

    platformsSeen[plat] = 1;
    validOffers++;
    if (!groups[key]) groups[key] = { key: key, rawTitles: [], byPlatform: Object.create(null) };
    const g = groups[key];
    const raw = String(c.title || '').trim();
    if (raw) g.rawTitles.push(raw);

    // 同一平台只保留到手价最低的真实报价（含并列时按 id 稳定取舍），不生成任何额外行
    const prev = g.byPlatform[plat];
    // 只保留比价展示所需字段；不写入 clickURL/couponUrl，避免把数百字符的推广链
    // 塞进前端要 fetch 的产物（比价表也不跳转，仅作只读对比）。
    const offer = {
      platform: plat,
      price: Math.round(price * 100) / 100,
      tao_id: String(c.tao_id || ''),
      _id: String(c._id || ''),
      title: raw,
    };
    if (!prev || offer.price < prev.price || (offer.price === prev.price && offer._id < prev._id)) {
      g.byPlatform[plat] = offer;
    }
  }

  const items = Object.keys(groups).sort().map((key) => {
    const g = groups[key];
    const offers = Object.keys(g.byPlatform).sort().map((p) => g.byPlatform[p]);
    offers.sort((a, b) => a.price - b.price || a.platform.localeCompare(b.platform));
    const prices = offers.map((o) => o.price);
    const minPrice = Math.min.apply(null, prices);
    const maxPrice = Math.max.apply(null, prices);
    // 代表标题：取最短的原文（去促销块后更易读），同长按字典序稳定
    const label = g.rawTitles.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || key;
    return {
      key: key,
      label: label,
      platformCount: offers.length,
      comparable: offers.length >= 2,
      platforms: offers.map((o) => o.platform),
      offers: offers,
      minPrice: Math.round(minPrice * 100) / 100,
      maxPrice: Math.round(maxPrice * 100) / 100,
      diff: Math.round((maxPrice - minPrice) * 100) / 100,
    };
  });
  // 可比价组优先（真实存在 >=2 平台），再按平台数/差额/键排序，保证复跑稳定
  items.sort((a, b) => (b.comparable - a.comparable) || (b.platformCount - a.platformCount) || (b.diff - a.diff) || a.key.localeCompare(b.key));

  const plats = Object.keys(platformsSeen).sort();
  return {
    version: 1,
    // 用快照时间戳而非墙钟：输入不变时重复运行字节级一致
    updatedAt: String(snap.updatedAt || '') || '1970-01-01T00:00:00.000Z',
    generatedBy: 'scripts/build-cross-platform.js',
    source: INPUT_REL,
    note: '仅使用券快照中真实存在的 platform 与到手价；未生成任何缺失平台报价、点击数据或同款猜测。单平台组不构成立足比价。',
    totalCoupons: coupons.length,
    validOffers: validOffers,                                              // 通过 platform/price/键长校验的源券记录数（归并前）
    dedupedOffers: items.reduce((n, g) => n + g.offers.length, 0),        // 每平台取最低价后的真实报价条数
    groupCount: items.length,
    comparableGroupCount: items.filter((g) => g.comparable).length,
    platformsSeen: plats,
    normalizeRule: '小写去空白 → 去括号块 → 去促销词 → 去规格数量 → 去活动价数字 → 去分隔符号；键长<4 不归并',
    items: items,
  };
}

/* ------------------------------ 主流程 ------------------------------ */
function main() {
  if (!fs.existsSync(INPUT)) {
    console.log('[cross-platform] 输入快照 ' + INPUT_REL + ' 不存在：不生成任何伪造报价，跳过。');
    console.log('[cross-platform] 前端将降级为「暂无可比价数据」空态；先跑 `node scripts/build.js` 生成快照再重跑本脚本。');
    return;
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  } catch (e) {
    console.log('[cross-platform] 输入快照不是合法 JSON（' + e.message + '）：不写入产物，跳过。');
    return;
  }
  const out = build(snap);
  const dir = path.dirname(OUTPUT);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('[cross-platform] 券 ' + out.totalCoupons + ' 条 → 有效券记录 ' + out.validOffers
    + ' 条（归并后报价 ' + out.dedupedOffers + ' 条）→ 同款组 ' + out.groupCount
    + ' 个（可比价 ' + out.comparableGroupCount + ' 个）');
  console.log('[cross-platform] 快照中真实平台：' + (out.platformsSeen.join(', ') || '（无）')
    + '；未接入平台未生成任何报价。');
  console.log('[cross-platform] 已写出 ' + OUTPUT_REL);
}

main();
