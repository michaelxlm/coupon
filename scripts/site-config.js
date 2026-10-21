'use strict';
/* ==========================================================================
   site-config.js · 小满券仓站点级配置（导航单一源）
   --------------------------------------------------------------------------
   背景：header/footer 由 shared-partials 渲染，但站点导航数据此前只有 build.js
   持有，build-topics.js 生成的场景页因此长期停留在旧版手写菜单（5 项、无主题
   切换、无移动端抽屉）。本文件把站点配置抽出为单一源，build.js 与
   build-topics.js 共用，保证所有页面 menu 完全一致。

   修改导航只需改这里，然后 node scripts/build.js。
   ========================================================================== */

const COUPON_SITE = {
  site_name: '小满券仓',
  logo_text: '券',
  domain: 'coupon.zangeng.com',
  slogan: '全网优惠券，先领券再下单更省',
  icp: '京ICP备18062653号-26',
  icp_url: 'https://beian.miit.gov.cn/',
  nav: [
    { label: '领券中心', url: '/' },
    { label: '全部好物', url: '/browse.html' },
    { label: '榜单', url: '/rank.html' },
    { label: '品类', url: '/category.html' },
    { label: '场景导购', url: '/topic/index.html' },
    { label: '攻略', url: '/guide.html' },
    { label: '长文导购', url: '/guides.html' },
  ],
  footer_nav: [
    { title: '导航', links: [
      { label: '领券中心', url: '/' },
      { label: '全部好物', url: '/browse.html' },
      { label: '榜单', url: '/rank.html' },
      { label: '降价热榜', url: '/drops.html' },
      { label: '品类', url: '/category.html' },
      { label: '场景导购', url: '/topic/index.html' },
      { label: '领券攻略', url: '/guide.html' },
      { label: '凑单计算器', url: '/calculator.html' },
      { label: '大促日历', url: '/holidays.html' },
      { label: '双 11 专题', url: '/double11.html' },
      { label: '我的收藏', url: '/favorites.html' },
      { label: '关于与免责', url: '/about.html' },
    ] },
  ],
  contact: { email: 'xlm8826@gmail.com', feedback_url: 'https://antucao.com' },
};

// 场景导购（topic/index.html 与 topic/<slug>.html）在主菜单中的落点
const TOPIC_NAV = '/topic/index.html';

module.exports = { COUPON_SITE, TOPIC_NAV };
