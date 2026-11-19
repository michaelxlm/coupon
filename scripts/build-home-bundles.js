#!/usr/bin/env node
/* ==========================================================================
 * build-home-bundles.js · WO-261 首页脚本合并 / 次屏懒加载（零依赖，Node 18+）
 *
 * 单一事实源：assets/js 下的各功能脚本仍是唯一源码；本生成器在构建期把它们
 * 按依赖顺序拼接成两个 bundle，index.html 只引用 bundle，不引用散装脚本。
 *
 *   home-core.js  首屏 bundle（defer）：tracker → conversion → app → share →
 *                 store → coupon-page。顺序与改造前 index.html 完全一致，
 *                 保证 window.Tracker / window.Conv / window.CouponShare 依赖链不断。
 *   home-lazy.js  次屏 bundle（空闲注入）：challenge + activities。两者 boot 均带
 *                 readyState 守卫，DOMContentLoaded 之后注入仍可正常初始化。
 *
 * 由 scripts/build.js 在 run() 开头调用；生成物再交给 fingerprint.js 做内容哈希。
 * fail-loud：源文件缺失直接抛出（build.js 会告警），避免静默产出缺脚本的 bundle。
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'assets', 'js');

const GROUPS = [
  {
    out: 'home-core.js',
    desc: '首屏核心（defer，顺序即依赖顺序）',
    files: [
      'tracker.js',
      'conversion.js',
      'app.js',
      'share.js',
      'store.js',
      'coupon-page.js',
    ],
  },
  {
    out: 'home-lazy.js',
    desc: '次屏模块（requestIdleCallback 注入，不占首屏）',
    files: [
      'challenge.js',
      'activities.js',
    ],
  },
];

function build() {
  for (const g of GROUPS) {
    const parts = [
      '/* ' + g.out + ' · WO-261 由 scripts/build-home-bundles.js 从源码拼接生成，勿手改。' +
        ' 组成：' + g.files.join(' + ') + '（' + g.desc + '） */\n',
    ];
    for (const name of g.files) {
      const src = fs.readFileSync(path.join(JS_DIR, name), 'utf8').replace(/^\s*#!.*\n/, '');
      parts.push('\n/* ==== ' + name + ' ==== */\n' + src.trim() + '\n');
    }
    const dest = path.join(JS_DIR, g.out);
    fs.writeFileSync(dest, parts.join('') + '\n', 'utf8');
    console.log('[build-home-bundles] ' + g.out + ' ← ' + g.files.join(', '));
  }
  return GROUPS.map(g => g.out);
}

module.exports = { build, GROUPS };

if (require.main === module) {
  build();
}
