#!/usr/bin/env node
/* ==========================================================================
 * cache-bust.js · 给站内所有本地 CSS / JS 引用统一刷新版本指纹（零依赖）
 *
 * 背景：coupon 纯静态托管，Nginx 对 /assets/** 设 30 天长缓存，改了 CSS/JS 后
 * 浏览器/CDN 会继续用旧缓存。此前需手工把全站 ?v=YYYY.MM.DD 逐个改（易漏、易错），
 * 本脚本把这一约定自动化，与同族站（aiWeb/scripts/cache-bust.js）保持一致。
 *
 * 规则：
 *   - 只处理本地 .css/.js 引用；外部 URL（http(s):// / 协议相对 // / data:）自动跳过
 *     （如 https://antucao.oss-.../js/ad-slots.js 不打版本号）。
 *   - 幂等且可更新：已有 ?v= 会被替换成新值，不产生 ?v=a?v=b 叠串，可反复重跑。
 *   - 同步刷新 <body data-build="..."> 缓存令牌，与 ?v= 用同一个版本号，便于对账。
 *
 * 用法：
 *   node scripts/cache-bust.js                 使用默认版本号（今天，形如 2026.10.20）
 *   node scripts/cache-bust.js 2026.10.20      指定版本号
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function version() {
  if (process.argv[2]) return process.argv[2];
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
}

function walk(dir, out) {
  fs.readdirSync(dir).forEach(name => {
    if (name === 'node_modules' || name.startsWith('.')) return;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.html')) out.push(full);
  });
  return out;
}

function isExternal(u) {
  return /^(https?:)?\/\//i.test(u) || /^data:/i.test(u);
}

function run() {
  const v = version();
  const files = walk(ROOT, []);
  let touchedFiles = 0;
  let touchedLinks = 0;

  // 匹配本地 .css 的 href 与 .js 的 src（允许已带 ?query，稍后覆盖）
  const re = /(href|src)="([^"]*?\.(?:css|js))(?:\?[^"]*)?"/gi;
  // 匹配 body 上的 data-build 缓存令牌
  const reBuild = /data-build="[^"]*"/gi;

  files.forEach(file => {
    const src = fs.readFileSync(file, 'utf8');
    let count = 0;
    let next = src.replace(re, (whole, attr, p) => {
      if (isExternal(p)) return whole;            // 外部 CDN/OSS 资源不动
      count++;
      return attr + '="' + p + '?v=' + v + '"';   // 覆盖式：已有 ?v= 也会被替换
    });
    if (reBuild.test(next)) {
      next = next.replace(reBuild, 'data-build="' + v + '"');
      reBuild.lastIndex = 0;
      count++;
    }
    if (count > 0 && next !== src) {
      fs.writeFileSync(file, next);
      touchedFiles++;
      touchedLinks += count;
    }
  });

  console.log('版本号 v=' + v);
  console.log('已刷新 ' + touchedLinks + ' 处本地 CSS/JS/data-build 引用，涉及 ' + touchedFiles + ' 个 HTML 文件。');
}

run();
