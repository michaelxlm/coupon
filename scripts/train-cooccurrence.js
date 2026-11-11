#!/usr/bin/env node
/* ==========================================================================
 * train-cooccurrence.js · 协同过滤（item → item 共现）离线训练（WO-189 · P3）
 *
 * 零依赖：只用 Node 内置 fs / path；不 require 第三方包、不打后端、不写中台。
 * 可复跑：输入不变则输出字节级稳定（updatedAt 取自输入最新 ts，不用墙钟；
 *         设备/商品/pair 全部按字典序排序，覆盖写而非追加）。
 * 退出码：恒为 0（训练产物可选，缺输入只打印说明，绝不阻断 CI）。
 *
 * 用法（在 coupon/ 仓库根执行）：
 *   node scripts/train-cooccurrence.js
 *   node scripts/train-cooccurrence.js --input=data/device-events.jsonl --output=data/cooccurrence.json
 *   COUPON_ROOT=/path/to/coupon node scripts/train-cooccurrence.js
 *
 * --------------------------------------------------------------------------
 * 输入契约（可选文件）：data/device-events.jsonl，每行一个 JSON 对象：
 *   {"deviceId":"匿名设备ID","tao_id":"券商品ID","event":"view","ts":1730000000000}
 *   - deviceId / tao_id：必填，空串或缺失的行直接丢弃（不补全、不猜测）。
 *   - event：view / detail / click / fav / exposure / coupon_click / collect 之一
 *     （大小写不敏感，缺省按 view）；其它事件类型不计入正样本。
 *   - ts：秒或毫秒时间戳 / 数字字符串均可，仅用于取「数据截至时间」，不参与权重。
 *   - 非法 JSON 行、空行静默跳过。
 *   - **文件缺省不存在 / 为空 / 全为无效行时不造假数据、不写产物**，
 *     只在 stdout 打印说明并退出；前端保持现行 /recommend + /random 兜底链不变。
 *
 * 输出契约（仅当存在有效输入时写 data/cooccurrence.json）：
 *   {
 *     "version": 1,
 *     "updatedAt": "<ISO>",       // = 输入最新 ts；无合法 ts 时为 1970-01-01T00:00:00.000Z
 *     "source": "data/device-events.jsonl",
 *     "eventCount": N,            // 有效事件行数
 *     "deviceCount": M,           // 去重设备数
 *     "pairCount": P,             // 去重后的共现 pair 数
 *     "sampleCount": N,           // 样本量（= eventCount），供前端「样本不足则不启用」判定
 *     "minSamples": 50,           // 启用阈值（与 coupon-page.js CO_MIN_SAMPLES 同步）
 *     "enabled": bool,            // eventCount >= 50 && pairCount > 0
 *     "topK": 20,                 // 每个 item 保留权重最高的邻居数，控制产物体积
 *     "cooccurrence": { "<tao_id>": { "<neighbor_tao_id>": <weight> } }
 *   }
 *   权重口径：同一 deviceId 下两个不同 tao_id 两两共现记 1 次（对称、按 pair 去重），
 *            跨设备累加即权重；不含点击率/转化率等任何推测值。
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  for (const a of process.argv.slice(2)) if (a.indexOf(prefix) === 0) return a.slice(prefix.length);
  return fallback;
}

const ROOT = process.env.COUPON_ROOT
  ? path.resolve(process.env.COUPON_ROOT)
  : path.resolve(__dirname, '..');
const INPUT_REL = arg('input', 'data/device-events.jsonl');
const OUTPUT_REL = arg('output', 'data/cooccurrence.json');
const INPUT = path.resolve(ROOT, INPUT_REL);
const OUTPUT = path.resolve(ROOT, OUTPUT_REL);

const MIN_SAMPLES = 50;   // 与 assets/js/coupon-page.js 的 CO_MIN_SAMPLES 保持一致
const TOP_K = 20;
const POSITIVE_EVENTS = new Set(['view', 'detail', 'click', 'fav', 'exposure', 'coupon_click', 'collect']);

function toMs(ts) {
  if (ts == null || ts === '') return 0;
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000; // 秒 → 毫秒
}

function parseLines(text) {
  const devices = Object.create(null);
  let eventCount = 0;
  let maxTs = 0;
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let row;
    try { row = JSON.parse(raw); } catch (e) { continue; }
    if (!row || typeof row !== 'object') continue;
    const dev = String(row.deviceId == null ? '' : row.deviceId).trim();
    const item = String(row.tao_id == null ? '' : row.tao_id).trim();
    if (!dev || !item) continue;
    const ev = String(row.event == null ? 'view' : row.event).trim().toLowerCase();
    if (!POSITIVE_EVENTS.has(ev)) continue;
    eventCount++;
    const ms = toMs(row.ts);
    if (ms > maxTs) maxTs = ms;
    if (!devices[dev]) devices[dev] = Object.create(null);
    devices[dev][item] = 1; // 同设备同商品只记一次，pair 去重
  }
  return { devices, eventCount, maxTs };
}

function train(parsed) {
  const deviceIds = Object.keys(parsed.devices).sort();
  const pairs = Object.create(null);
  for (const dev of deviceIds) {
    const items = Object.keys(parsed.devices[dev]).sort();
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const key = JSON.stringify([items[i], items[j]]); // 有序 pair，避免分隔符冲突
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
  }
  const pairKeys = Object.keys(pairs).sort();
  const full = Object.create(null);
  for (const key of pairKeys) {
    const [a, b] = JSON.parse(key);
    const w = pairs[key];
    if (!full[a]) full[a] = Object.create(null);
    if (!full[b]) full[b] = Object.create(null);
    full[a][b] = w; // 对称
    full[b][a] = w;
  }
  // 每个 item 只保留权重最高的 TOP_K 个邻居（同权重按 id 字典序），控制产物体积
  const co = Object.create(null);
  for (const item of Object.keys(full).sort()) {
    const neighbors = Object.keys(full[item]).sort((x, y) => (full[item][y] - full[item][x]) || x.localeCompare(y));
    const row = Object.create(null);
    for (const n of neighbors.slice(0, TOP_K)) row[n] = full[item][n];
    co[item] = row;
  }
  return {
    version: 1,
    updatedAt: parsed.maxTs ? new Date(parsed.maxTs).toISOString() : '1970-01-01T00:00:00.000Z',
    source: INPUT_REL,
    eventCount: parsed.eventCount,
    deviceCount: deviceIds.length,
    pairCount: pairKeys.length,
    sampleCount: parsed.eventCount,
    minSamples: MIN_SAMPLES,
    enabled: parsed.eventCount >= MIN_SAMPLES && pairKeys.length > 0,
    topK: TOP_K,
    note: '权重仅来自真实 device-events 的同设备共现次数；无输入时不生成任何伪造样本。样本不足则不启用协同过滤。',
    cooccurrence: co,
  };
}

function main() {
  if (!fs.existsSync(INPUT)) {
    console.log('[cooccurrence] 输入 ' + INPUT_REL + ' 不存在。');
    console.log('[cooccurrence] 按约定不造假数据：不创建 device-events.jsonl、不写 data/cooccurrence.json。');
    console.log('[cooccurrence] 前端 sampleCount=0 →「样本不足则不启用」，保持现行 /recommend + /random 兜底链不变。');
    console.log('[cooccurrence] 待有真实埋点日志后重跑本脚本即可启用二阶召回；输出契约见本文件头部注释。');
    return;
  }
  let text;
  try { text = fs.readFileSync(INPUT, 'utf8'); }
  catch (e) {
    console.log('[cooccurrence] 读取 ' + INPUT_REL + ' 失败（' + e.message + '）：不写产物。');
    return;
  }
  const parsed = parseLines(text);
  if (!parsed.eventCount) {
    console.log('[cooccurrence] ' + INPUT_REL + ' 无有效事件行：不写产物（不造假数据）。');
    return;
  }
  const out = train(parsed);
  const dir = path.dirname(OUTPUT);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('[cooccurrence] 有效事件 ' + out.eventCount + ' 行 / 设备 ' + out.deviceCount
    + ' 个 / 共现 pair ' + out.pairCount + ' 个 → ' + OUTPUT_REL);
  console.log('[cooccurrence] sampleCount=' + out.sampleCount + ' minSamples=' + out.minSamples
    + ' enabled=' + out.enabled + (out.enabled ? '' : '（样本不足则不启用）'));
}

main();
