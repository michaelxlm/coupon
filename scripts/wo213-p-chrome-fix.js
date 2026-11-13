#!/usr/bin/env node
/**
 * wo213-p-chrome-fix.js · WO-213② 生产修复 codemod
 * ----------------------------------------------------------------------------
 * 根因（已诊断）：coupon/p/*.html 中 468 个陈旧产物缺 <footer class="site-footer">
 * （detailPageShell 现版会渲染 footer，但存量页是旧构建遗留，故 syncChromeOnDisk
 * 因 ftrCount=0 正确「拒绝对齐」并告警 468 次）。
 *
 * 修复：对 (header=1, footer=0) 的页，注入与 detailPageShell 完全一致的 footer：
 *   footer = P.renderFooter(COUPON_SITE, {}, { contactTitle:'联系', showSocial:false,
 *                                            showFooterLinks:false, footerAdSlot:'footer' })
 * 插入位置对齐模板（</main> 之后、脚本之前），再跑 NAV.injectIntoHtml(html,{site:'coupon'})
 * 注入 footer 广告位加载器 —— 与 build.js 的 chrome 输出逐字节同源，不触碰任何券内容。
 *
 * 安全保障：
 *   · 仅修改 (1,0) 页；已 (1,1) 跳过；非常规 (h!=1||f!=1 且非(1,0)) 跳过不碰。
 *   · 不拉取任何券数据，绝不空内容（与「整站 rebuild 可能清空券网格」隔离）。
 *   · 默认 dry-run，--apply 才写盘；幂等（重跑对 (1,1) 无副作用）。
 * 验收：跑后 wo213-p-chrome-analyze.js 应显示 0 个 (1,0)（即 syncChromeOnDisk 失败归零）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('@xuyiheng/static-build-kit/shared-partials');
const { COUPON_SITE } = require('./site-config');
const NAV = require('@xuyiheng/static-build-kit/shared-navigation');

const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'p');
const H = /<header class="site-header">/g;
const F = /<footer class="site-footer">/g;
const apply = process.argv.includes('--apply');

const footer = P.renderFooter(COUPON_SITE, {}, {
  contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer'
});

let fixed = 0, skipped = 0, other = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.html') && x !== '_shell.html')) {
  const fp = path.join(dir, f);
  let html = fs.readFileSync(fp, 'utf8');
  const h = (html.match(H) || []).length;
  const ft = (html.match(F) || []).length;
  if (h === 1 && ft === 0) {
    const at = html.indexOf('</main>');
    if (at === -1) { other++; if (other <= 5) console.log('  跳过(无</main>):', f); continue; }
    html = html.slice(0, at + '</main>'.length) + '\n' + footer + html.slice(at + '</main>'.length);
    html = NAV.injectIntoHtml(html, { site: 'coupon' });
    if (apply) fs.writeFileSync(fp, html);
    fixed++;
  } else if (h === 1 && ft === 1) {
    skipped++;
  } else {
    other++;
    if (other <= 5) console.log('  跳过(非常规):', f, `h=${h} f=${ft}`);
  }
}
console.log(`[wo213-p-chrome-fix] ${apply ? '已写盘' : 'dry-run'}：修复 ${fixed} 个，已正确 ${skipped} 个，非常规跳过 ${other} 个`);
