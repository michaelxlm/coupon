'use strict';
/* ==========================================================================
   main-api/shared/partials/index.js · 跨站公共 HTML 片段单一事实源（WO-85 · 阶段一）
   @file main-api/shared/partials/index.js
   @description 构建渲染型静态站（notes / history / zangeng / coupon …）的
     header / footer / ad-slot 公共片段的「唯一实现」。各站过去各自在 build.js 里
     复制了一份几乎相同的 renderHeader / renderFooter / 广告位标记，形成实现漂移。
     本模块把这些收敛为单源：编辑此文件 → node main-api/scripts/sync-partials.js
     → 覆盖各站本地副本 <site>/scripts/shared-partials.js → 各站 build 重新生成时同步生效。

   用法（各站 build.js，纯构建期 Node，零依赖）：
     const P = require('./shared-partials');
     function renderHeader(site, page, links) { return P.renderHeader(site, page, links, opts); }
     function renderFooter(site, links)       { return P.renderFooter(site, links, opts); }
     const ad = '\n  ' + P.renderAdSlotSection('inline');   // 注入位置逻辑仍留在各站

   约定：
     - opts 全部可选，默认值复现 notes / history 的既有输出（保证接入站零回归）。
     - 转义只在被渲染数据处进行（escapeHtml 文本 / escapeAttr 属性），模板骨架不转义。
     - 各站为独立 git 仓库，故 shared 源以「构建期本地副本」形式落地（同 design-tokens.css 机制）。
   ========================================================================== */

/* --------------------------------- 转义 --------------------------------- */
function escapeHtml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(input) {
  return escapeHtml(input).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------ 顶部推广条 ------------------------------ */
/**
 * @param {Object} links - { global: [{ position, label, url }] }
 * @param {Object} [opts] - { multiline: true }  false 则压成单行（zangeng 风格）
 */
function renderPromoStrip(links, opts) {
  const o = opts || {};
  const multiline = o.multiline !== false;
  const top = ((links || {}).global || []).filter((l) => l.position === 'top')[0];
  if (!top) return '';
  const attrs = `data-track="cta_click" data-track-props='{"pos":"top-strip","target":"${escapeAttr(top.url)}"}'`;
  if (multiline) {
    return `<div class="promo-strip">
  <div class="container">
    <span class="label">${escapeHtml(top.label)}</span>
    <a class="btn btn-primary btn-sm" href="${escapeAttr(top.url)}" ${attrs}>去看看</a>
  </div>
</div>`;
  }
  return `<div class="promo-strip"><div class="container"><span class="label">${escapeHtml(top.label)}</span><a class="btn btn-primary btn-sm" href="${escapeAttr(top.url)}" ${attrs}>去看看</a></div></div>`;
}

/* --------------------------------- 头部 --------------------------------- */
/**
 * @param {Object} site - 站点配置（site_name/logo_text/nav/cta ...）
 * @param {Object} page - 当前页配置（page.nav 用于高亮）
 * @param {Object} links - 全局链接（用于推广条）
 * @param {Object} [opts] - { navInline=false, promoMultiline=true, navAriaCurrent=false }
 *   navAriaCurrent=true 时，当前项额外输出 aria-current="page"（coupon）。
 *   nav 项如带 external:true → 追加 target="_blank" rel="noopener"。
 */
function renderHeader(site, page, links, opts) {
  const o = Object.assign({
    navInline: false,
    navAriaCurrent: false,
  }, opts || {});
  const navInline = o.navInline === true;
  const nav = (site.nav || []).map((n) => {
    const isActive = !!(page && page.nav && n.url === page.nav);
    const cls = 'nav-link' + (isActive ? ' is-active' : '');
    let extra = '';
    if (isActive && o.navAriaCurrent) extra += ' aria-current="page"';
    if (n.external) extra += ' target="_blank" rel="noopener"';
    return `<a class="${cls}" href="${escapeAttr(n.url)}"${extra}>${escapeHtml(n.label)}</a>`;
  }).join('\n      ');

  const promo = renderPromoStrip(links, { multiline: o.promoMultiline !== false });
  const navBlock = navInline
    ? `<nav class="nav" id="primaryNav" aria-label="主导航">${nav}</nav>`
    : `<nav class="nav" id="primaryNav" aria-label="主导航">
      ${nav}
    </nav>`;

  return `${promo}
<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="/" aria-label="${escapeAttr(site.site_name)} 首页">
      <span class="brand-mark">${escapeHtml(site.logo_text || site.short_name || '')}</span>
      <span class="brand-text">${escapeHtml(site.site_name)}</span>
    </a>
    ${navBlock}
    <div class="header-actions">
      <button class="icon-btn" id="themeToggle" type="button" aria-label="切换深色 / 浅色">🌙</button>
      <button class="icon-btn nav-toggle" id="navToggle" type="button" aria-label="展开菜单" aria-expanded="false">☰</button>
    </div>
  </div>
</header>`;
}

/* --------------------------------- 页脚 --------------------------------- */
/**
 * @param {Object} site - 站点配置（site_name/footer_nav/contact/social/slogan/disclaimer/icp ...）
 * @param {Object} links - 全局链接（position=footer 追加到底部链接）
 * @param {Object} [opts] - {
 *   contactTitle='联系我们',   联系列标题（zangeng 用 '联系'）
 *   showSocial=true,           品牌区是否渲染 social 行
 *   showFooterLinks=true,      底部是否追加 links.global[position=footer]
 *   compact=false,             true 时页脚列压成 zangeng 的紧凑格式
 *   footerAdSlot=null,         传入 position（如 'footer' 或 true）则在底部栏前插入一个容器内广告位
 * }
 *   footer_nav 列链接如带 external:true → 追加 target="_blank" rel="noopener"。
 */
function renderFooter(site, links, opts) {
  const o = Object.assign({
    contactTitle: '联系我们',
    showSocial: true,
    showFooterLinks: true,
    compact: false,
  }, opts || {});

  const year = new Date().getFullYear();
  const since = site.since_year || year;
  const yearText = since === year ? String(year) : `${since} - ${year}`;
  const c = site.contact || {};

  if (o.compact) {
    // zangeng 既有紧凑格式（单行内联），保持其构建产物零变化
    const cols = (site.footer_nav || []).map((col) => `
    <div class="footer-col">
      <h4>${escapeHtml(col.title)}</h4>
      <ul>${(col.links || []).map((l) => `<li><a href="${escapeAttr(l.url)}">${escapeHtml(l.label)}</a></li>`).join('\n        ')}</ul>
    </div>`).join('\n');
    const contactCol = `
    <div class="footer-col">
      <h4>${escapeHtml(o.contactTitle)}</h4>
      <ul>${c.email ? `<li><a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a></li>` : ''}${c.feedback_url ? `<li><a href="${escapeAttr(c.feedback_url)}" target="_blank" rel="noopener">反馈 / 其他 → antucao.com</a></li>` : ''}</ul>
    </div>`;
    return `<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="brand" href="/"><span class="brand-mark">${escapeHtml(site.logo_text || site.short_name || '')}</span><span class="brand-text">${escapeHtml(site.site_name)}</span></a>
        <p>${escapeHtml(site.slogan || '')}</p>
      </div>
      ${cols}
      ${contactCol}
    </div>
    <div class="container footer-bottom">
      <span>© ${yearText} ${escapeHtml(site.site_name)}${site.disclaimer ? ' · ' + escapeHtml(site.disclaimer) : ''}</span>
      <div class="footer-links">${site.icp ? `<a href="${escapeAttr(site.icp_url || 'https://beian.miit.gov.cn/')}" target="_blank" rel="noopener">${escapeHtml(site.icp)}</a>` : ''}</div>
    </div>
  </div>
</footer>`;
  }

  // 标准（notes / history）格式
  const cols = (site.footer_nav || []).map((col) => `
    <div class="footer-col">
      <h4>${escapeHtml(col.title)}</h4>
      <ul>
        ${(col.links || []).map((l) => `<li><a href="${escapeAttr(l.url)}"${l.external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(l.label)}</a></li>`).join('\n        ')}
      </ul>
    </div>`).join('\n');

  const contactCol = `
    <div class="footer-col">
      <h4>${escapeHtml(o.contactTitle)}</h4>
      <ul>
        ${c.email ? `<li><a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a></li>` : ''}
        ${c.feedback_url ? `<li><a href="${escapeAttr(c.feedback_url)}" target="_blank" rel="noopener">反馈 / 其他 → antucao.com</a></li>` : ''}
      </ul>
    </div>`;

  const social = o.showSocial
    ? (site.social || []).filter((s) => s.url).map((s) =>
        `<a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`)
      .join(' · ')
    : '';

  const footerLinks = o.showFooterLinks
    ? (((links || {}).global) || []).filter((l) => l.position === 'footer').map((l) =>
        `<a href="${escapeAttr(l.url)}">${escapeHtml(l.label)}</a>`)
      .join('\n      ')
    : '';

  const footerAd = o.footerAdSlot
    ? `\n    <div class="container">${renderAdSlot(o.footerAdSlot === true ? 'footer' : o.footerAdSlot)}</div>`
    : '';

  return `<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="brand" href="/">
          <span class="brand-mark">${escapeHtml(site.logo_text || site.short_name || '')}</span>
          <span class="brand-text">${escapeHtml(site.site_name)}</span>
        </a>
        <p>${escapeHtml(site.slogan || '')}</p>
        ${social ? `<p>${social}</p>` : ''}
      </div>
      ${cols}
      ${contactCol}
    </div>${footerAd}
    <div class="container footer-bottom">
      <span>© ${yearText} ${escapeHtml(site.site_name)}${site.disclaimer ? ' · ' + escapeHtml(site.disclaimer) : ''}</span>
      <div class="footer-links">
        ${site.icp ? `<a href="${escapeAttr(site.icp_url || 'https://beian.miit.gov.cn/')}" target="_blank" rel="noopener">${escapeHtml(site.icp)}</a>` : ''}
        ${footerLinks}
      </div>
    </div>
  </div>
</footer>`;
}

/* -------------------------------- 广告位 -------------------------------- */
/** 广告位占位（裸元素）：<div class="ad-slot" data-ad-slot="inline"></div> */
function renderAdSlot(position, opts) {
  const cls = (opts && opts.cls) ? `ad-slot ${opts.cls}` : 'ad-slot';
  return `<div class="${cls}" data-ad-slot="${escapeAttr(position)}"></div>`;
}

/** 广告位整节（含 section + container 约束到内容宽度） */
function renderAdSlotSection(position, opts) {
  const slot = (opts && opts.type === 'coupon')
    ? `<div class="coupon-slot" data-coupon-slot="${escapeAttr(position)}"></div>`
    : renderAdSlot(position, opts);
  return `<section class="section-sm"><div class="container">${slot}</div></section>`;
}

module.exports = {
  escapeHtml,
  escapeAttr,
  renderPromoStrip,
  renderHeader,
  renderFooter,
  renderAdSlot,
  renderAdSlotSection,
};
