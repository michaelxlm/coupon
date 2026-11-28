#!/usr/bin/env node
'use strict';

// 原始快照与对客投影分离。默认只读；--apply 才写盘，不访问网络或数据库。
const fs = require('fs');
const path = require('path');
const Q = require('../assets/js/coupon-quality');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'coupon-snapshot.raw.json');
const CUSTOMER = path.join(DATA, 'coupon-snapshot.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function project() {
  const hasRaw = fs.existsSync(RAW);
  const source = hasRaw ? RAW : CUSTOMER;
  const raw = readJson(source);
  const customer = Q.projectCustomerSnapshot(raw);
  return { hasRaw, raw, customer };
}

function main() {
  const apply = process.argv.includes('--apply');
  const { hasRaw, raw, customer } = project();
  console.log('模式: ' + (apply ? 'APPLY（写本地快照文件）' : 'DRY-RUN（只读）'));
  console.log('来源: ' + (hasRaw ? 'coupon-snapshot.raw.json' : '现有 coupon-snapshot.json（首次迁移）'));
  console.log('原始 ' + customer.quality.rawTotal + ' 条 → 对客 ' + customer.quality.customerTotal +
    ' 条，移除 ' + customer.quality.removed + ' 条');
  if (!apply) {
    console.log('加 --apply 才写入原始留档与对客投影');
    return;
  }
  // 首次迁移先原样留存旧快照；后续构建以 raw 为权威输入，不覆盖历史输入。
  if (!hasRaw) fs.writeFileSync(RAW, JSON.stringify(raw));
  fs.writeFileSync(CUSTOMER, JSON.stringify(customer));
  console.log('已写入 coupon-snapshot.raw.json 与 coupon-snapshot.json');
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error('[project-coupon-snapshot] 失败: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { project };
