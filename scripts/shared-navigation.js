'use strict';
/* ==========================================================================
   main-api/shared/navigation/index.js · 跨站「原生导航无缝化」单一事实源（WO-93）
   @file main-api/shared/navigation/index.js
   @description 六站（aiWeb / visitor / color-tool / notes / zangeng / history / coupon）
     均为多页静态结构，页面跳转走浏览器整页刷新，导航有白屏闪烁。本模块把
     **Speculation Rules 预取** 与 **View Transitions 过渡** 收敛为一段可注入的
     `<head>` 声明，作为跨站的唯一实现：编辑此文件 →
     `node main-api/scripts/sync-navigation.js` 分发各站本地副本
     `<site>/scripts/shared-navigation.js` → 各站 build / codemod 注入即全站生效。

   零依赖 · 纯声明式：
     - Speculation Rules（`<script type="speculationrules">`）：由浏览器原生在空闲/
       悬停等信号时预取同源链接，不支持的浏览器直接忽略该 JSON，无任何副作用。
     - View Transitions（`@view-transition { navigation: auto }`）：跨文档过渡由
       浏览器自动接管，不支持的浏览器无样式变化，故「硬刷无闪烁」有渐进增强保证。
     两者都不引入运行期 JS，符合静态站「零依赖 / 构建期注入」规范。

   用法（各站 build.js 或 codemod，纯构建期 Node）：
     const NAV = require('./shared-navigation');
     html = NAV.injectIntoHtml(html, { site: 'notes' });   // 幂等，已注入即原样返回

   约定：
     - 注入块以 `nav-seamless:v1` 注释标记，幂等判据与门禁检索锚点皆用它。
     - 只插到第一个 `</head>` 之前；无 `</head>` 的原样返回并计数（门禁会暴露漏页）。
     - opts 全部可选，默认口径复现本工单验收（同源链接 moderate 预取 + 跨文档过渡）。
   ========================================================================== */

const MARKER = 'nav-seamless:v1';

/**
 * 默认预取规则：只预取同源链接，排除明确非页面/敏感路径，中度积极度
 * @param opts
 */
function buildRules(opts) {
  const o = opts || {};
  const eagerness = o.eagerness || 'moderate';
  // href_matches 相对当前源解析；/* 命中同源全部路径，再用 not 排除非页面/第三方端点
  const exclude = Array.isArray(o.exclude) && o.exclude.length
    ? o.exclude
    : [ '/api/*', '/admin/*', '/login*', '*logout*' ];
  const not = exclude.map(pat => ({ href_matches: pat }));
  return {
    prefetch: [
      {
        where: {
          href_matches: '/*',
          and: [{ not: { or: not } }],
        },
        eagerness,
      },
    ],
  };
}

/**
 * 生成注入到 `<head>` 的无缝导航声明块（含幂等标记注释）。
 * @param {Object} [opts] - { eagerness='moderate', exclude=[...], site }
 * @return {String} 可直接插入 HTML 的片段（前后各带换行，缩进 2 空格）
 */
function renderNavSeamless(opts) {
  const rules = JSON.stringify(buildRules(opts));
  return `  <!-- ${MARKER} · 原生导航无缝化，由 shared/navigation 单一源注入，请勿手改本块 -->
  <script type="speculationrules">${rules}</script>
  <style>@view-transition{navigation:auto}</style>`;
}

/**
 * 幂等地把无缝导航声明注入到任意 HTML 的 `</head>` 之前。
 * @param {String} html - 完整 HTML 文本
 * @param {Object} [opts] - 透传 renderNavSeamless 的 opts
 * @return {String} 注入后的 HTML；已含标记或无 `</head>` 时原样返回
 */
function injectIntoHtml(html, opts) {
  const src = String(html == null ? '' : html);
  if (src.indexOf(MARKER) !== -1) return src; // 已注入：幂等跳过
  const headRe = /<\/head\s*>/i;
  if (!headRe.test(src)) return src; // 无 head：交由门禁暴露，不强插
  const block = renderNavSeamless(opts);
  return src.replace(headRe, `${block}\n</head>`);
}

module.exports = {
  MARKER,
  buildRules,
  renderNavSeamless,
  injectIntoHtml,
};
