/* home-core.js · WO-261 由 scripts/build-home-bundles.js 从源码拼接生成，勿手改。 组成：coupon-quality.js + tracker.js + conversion.js + app.js + share.js + store.js + coupon-page.js（首屏核心（defer，顺序即依赖顺序）） */

/* ==== coupon-quality.js ==== */
/*!
 * coupon-quality.js · 券质量与相关性统一口径（浏览器 / Node 双环境）
 * ------------------------------------------------------------------
 * 单一事实源：构建脚本（../../scripts/*.js）与前台页面（coupon-page.js /
 * list-page.js / favorites.js）都从这里取清洗、去重、过期判定与搜索相关性打分。
 * 硬口径：没有可点击 couponUrl 或券额为 0 的记录不是「券」，不得进入任何券池。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CouponQuality = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var YEAR_MS = 365 * 24 * 3600 * 1000;

  function validUrl(u) {
    if (typeof u !== 'string') return false;
    return /^https?:\/\/\S+$/i.test(u.trim());
  }

  function firstUrl(c) {
    if (!c) return '';
    var u = c.couponUrl || c.couponURL || '';
    return validUrl(u) ? String(u).trim() : '';
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  /** 一张券是否真的可领：可点击券链 + 券额 > 0。clickURL 只是商品推广链，不算券。 */
  function hasCoupon(c) {
    if (!c) return false;
    return !!firstUrl(c) && num(c.couponDiscount) > 0;
  }

  function endMs(c) {
    if (!c) return 0;
    var v = c.couponEndTime || c.endTime || c.couponEndDate || 0;
    if (!v) return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var s = String(v).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) { var n = Number(s); return n < 1e12 ? n * 1000 : n; }
    var t = Date.parse(s.replace(/-/g, '/'));
    return isFinite(t) ? t : 0;
  }

  /** ok | long | unknown | expired —— long 表示超长有效期，展示为「长期有效」而非具体日期 */
  function expiryState(c, now) {
    var ms = endMs(c);
    if (!ms) return 'unknown';
    var t = now || Date.now();
    if (ms <= t) return 'expired';
    if (ms > t + YEAR_MS) return 'long';
    return 'ok';
  }

  function saveScore(c) {
    if (!c) return 0;
    var off = num(c.couponDiscount);
    var quota = num(c.couponQuota);
    return off + (quota ? Math.min(100, (off / quota) * 100) : off * 0.4);
  }

  function normalizeTitle(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, '')
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '')
      .replace(/[a-z]$/, '')
      .slice(0, 60);
  }

  function dedupeKey(c) {
    if (!c) return '';
    if (c.tao_id) return 't:' + String(c.tao_id);
    if (c._id) return 'i:' + String(c._id);
    if (c.item_url) return 'u:' + String(c.item_url).split('?')[0];
    var t = normalizeTitle(c.title);
    return t ? 'n:' + t + '|' + Math.round(num(c.price) * 10) : firstUrl(c);
  }

  /** 保留券额更高 / 更新的那条，避免同款多券刷屏 */
  function dedupe(arr) {
    var seen = Object.create(null);
    var out = [];
    (arr || []).forEach(function (c) {
      var k = dedupeKey(c);
      if (!k) return;
      var prev = seen[k];
      if (prev === undefined) { seen[k] = out.length; out.push(c); return; }
      var old = out[prev];
      if (saveScore(c) > saveScore(old)) out[prev] = c;
    });
    return out;
  }

  function sortByValue(arr) {
    return (arr || []).slice().sort(function (a, b) {
      var d = saveScore(b) - saveScore(a);
      if (Math.abs(d) > 0.001) return d;
      return (Number(b.createTime) || 0) - (Number(a.createTime) || 0);
    });
  }

  /**
   * 所有券池的唯一入口：过滤无券 / 已过期，跨页去重，按省钱力度排序。
   * opts.keepOrder=true 时保留原顺序（榜单等已由后端排好序的场景）。
   */
  function cleanList(arr, opts) {
    var o = opts || {};
    var now = Date.now();
    var list = (arr || []).filter(function (c) {
      return hasCoupon(c) && expiryState(c, now) !== 'expired';
    });
    var out = dedupe(list);
    return o.keepOrder ? out : sortByValue(out);
  }

  // 原始快照用于审计；对客快照必须另行投影，不能把历史脏记录直接交给页面。
  function projectCustomerSnapshot(snapshot, now) {
    var src = snapshot && typeof snapshot === 'object' ? snapshot : {};
    var at = now || Date.now();
    var out = {}, rawTotal = 0, customerTotal = 0;
    function projectList(list, keepOrder) {
      var raw = Array.isArray(list) ? list : [];
      rawTotal += raw.length;
      var clean = raw.filter(function (c) { return hasCoupon(c) && expiryState(c, at) !== 'expired'; });
      clean = dedupe(clean);
      customerTotal += clean.length;
      return keepOrder ? clean : sortByValue(clean);
    }
    out.updatedAt = src.updatedAt || new Date(at).toISOString();
    out.featured = projectList(src.featured);
    out.browse = projectList(src.browse);
    out.drops = projectList(src.drops);
    out.rank = {};
    [ 'day', 'week', 'month' ].forEach(function (period) {
      out.rank[period] = projectList(src.rank && src.rank[period], true);
    });
    out.category = {};
    Object.keys(src.category || {}).forEach(function (key) { out.category[key] = projectList(src.category[key]); });
    var usableIds = Object.create(null);
    [ out.featured, out.browse, out.drops ].concat(Object.keys(out.rank).map(function (k) { return out.rank[k]; }))
      .concat(Object.keys(out.category).map(function (k) { return out.category[k]; }))
      .forEach(function (list) { list.forEach(function (c) { if (c && c._id) usableIds[String(c._id)] = 1; }); });
    out.detailIds = (Array.isArray(src.detailIds) ? src.detailIds : []).map(String).filter(function (id) { return usableIds[id]; });
    out.quality = { rawTotal: rawTotal, customerTotal: customerTotal, removed: rawTotal - customerTotal };
    return out;
  }

  /** 搜索相关性：标题前缀 > 标题包含 > 简介包含；券额与新鲜度做小幅加权 */
  function relevanceScore(c, kw) {
    if (!c || !kw) return saveScore(c);
    var q = String(kw).trim().toLowerCase();
    if (!q) return saveScore(c);
    var title = String(c.title || '').toLowerCase();
    var extra = String(c.jianjie || c.keywords || c.category || '').toLowerCase();
    var score = 0;
    if (title.indexOf(q) === 0) score += 120;
    else if (title.indexOf(q) > 0) {
      score += 60;
      if (title.indexOf(q) <= 4) score += 15;
    } else if (extra.indexOf(q) >= 0) score += 12;
    if (!title) score -= 40;
    if (title.length < 6) score -= 10;
    score += Math.min(30, num(c.couponDiscount));
    var age = Date.now() - (Number(c.createTime) || Number(c.createdAt) || 0);
    if (age > 0 && age < 7 * 24 * 3600 * 1000) score += 8;
    return score;
  }

  function rankByRelevance(arr, kw) {
    return (arr || []).slice().sort(function (a, b) {
      var d = relevanceScore(b, kw) - relevanceScore(a, kw);
      if (Math.abs(d) > 0.001) return d;
      return saveScore(b) - saveScore(a);
    });
  }

  function platformLabel(c) {
    var p = String((c && c.platform) || '').toLowerCase();
    if (p === 'taobao' || p === 'tb') return '淘宝';
    if (p === 'jd' || p === 'jingdong') return '京东';
    if (p === 'pdd') return '拼多多';
    return p ? p.toUpperCase() : '全网';
  }

  return {
    validUrl: validUrl,
    firstUrl: firstUrl,
    hasCoupon: hasCoupon,
    endMs: endMs,
    expiryState: expiryState,
    saveScore: saveScore,
    normalizeTitle: normalizeTitle,
    dedupeKey: dedupeKey,
    dedupe: dedupe,
    sortByValue: sortByValue,
    cleanList: cleanList,
    projectCustomerSnapshot: projectCustomerSnapshot,
    relevanceScore: relevanceScore,
    rankByRelevance: rankByRelevance,
    platformLabel: platformLabel,
    YEAR_MS: YEAR_MS
  };
});

/* ==== tracker.js ==== */
/* ==========================================================================
   tracker.js · 统一埋点 SDK（Web 端）
   上报地址：POST https://api.xuyiheng.com/api/v1/public/track

   设计原则（沿用并扩展原 pv.js）：
     - 静默失败：接口挂了 / 离线 / file:// 打开 / 存储被禁用，都不影响页面使用
     - body 用 text/plain，避免 application/json 触发跨域 CORS 预检
     - 优先 sendBeacon（页面关闭也能发出），降级 fetch keepalive + no-cors
     - 劫持 history.pushState / replaceState，捕获单页内切换的虚拟 PV
     - 零依赖、纯静态可用，直接以 <script src> 引入

   相比原 pv.js 新增：
     1. 自动生成并持久化匿名 visitorId（localStorage），作为 UV 统计口径
     2. 会话 sessionId（30 分钟滚动续期），支撑会话级分析
     3. track(event, props) 手动打点 API
     4. [data-track] 元素点击自动打点（无需在业务代码里逐个绑定）
     5. 事件队列 + 批量 flush（减少请求数），pagehide / 隐藏时兜底 flush

   接入方式（二选一）：
     A. 部署前修改下方 CONFIG.project（推荐，零额外配置）
     B. 在引入本脚本前声明 window.TrackerConfig = { project: 'xxx', ... } 覆盖
   ========================================================================== */

(function (global) {
  'use strict';

  // SDK 版本：所有接入项目必须保持一致（由 scripts/check-tracker-consistency.js 守卫）
  var SDK_VERSION = '2.5.1'; // 2.5.1 WO-336：补捕获阶段资源加载错误（window.onerror 收不到）；2.5.0 JS 错误 + 限流

  var CONFIG = {
    // 上报端点（中台统一埋点端点）
    endpoint: 'https://api.xuyiheng.com/api/v1/public/track',
    // 项目代号：每个站点部署时修改（color-tool / visitor / aiWeb / ...）
    project: 'unknown',
    // 终端类型：Web 站点固定 web
    terminal: 'web',
    // 调试模式：置 true 时在控制台打印上报内容（生产请保持 false）
    debug: false,
    // 存储键
    visitorKey: '__tk_vid',
    sessionKey: '__tk_sid',
    // 渠道归因存储键（WO-138）：会话级，新会话重新归因，不做跨会话长尾归因
    srcKey: '__tk_src',
    // 会话有效期（毫秒）：30 分钟无操作视为新会话
    sessionTTL: 30 * 60 * 1000,
    // 批量 flush 间隔（毫秒）
    flushInterval: 1000,
    // 单次批量上报最大条数
    maxBatch: 20,
    // Core Web Vitals 采集开关（WO-94）：置 false 可关闭 LCP/INP/CLS 上报
    webVitals: true,
  };

  // 允许接入方在引入脚本前用 window.TrackerConfig 覆盖默认配置
  if (global.TrackerConfig && typeof global.TrackerConfig === 'object') {
    for (var k in global.TrackerConfig) {
      if (Object.prototype.hasOwnProperty.call(global.TrackerConfig, k)) {
        CONFIG[k] = global.TrackerConfig[k];
      }
    }
  }

  var queue = [];
  var flushTimer = null;
  var lastPath = null;

  /* ------------------------------ 渠道归因（WO-138） ------------------------------ */
  /**
   * 客户端白名单：与中台 app/utils/channelSrcHelper.js 的登记口径一致。
   * 服务端会再做一次权威校验（白名单外降级未归因），本层过滤只是不把
   * 任意 query 字符串发出去（兼防注入值污染），不是安全边界。
   */
  var SRC_ALLOWED = [
    'gg', 'baidu', 'bing', 'gzh', 'xcx',
    'wx-mp', 'dy-mp', 'ks-mp',
    'juejin', 'zhihu', 'v2ex', 'sspai', 'smzdm', 'sheji', 'shequ', 'mcp-landing',
    // WO-138 补齐：微信本地生活入口（wechatLocalCommerce 生成链）+ 九站互推，
    //   与中台 utils/channelSrcHelper.CHANNEL_LABELS 同步登记，客户端不先拦才能到服务端归一
    'wx-menu', 'wx-reply', 'wx-qrcode', 'hub',
    // WO-174：微信贴图话题活动链接 / 小程序码带来的公域流量，单独成列看承接转化
    'wx-topic',
  ];

  /** 渠道值归一：只保留小写字母/数字/下划线/短横线，且必须在白名单内 */
  function normalizeSrc(value) {
    var raw = String(value || '').trim();
    var v = raw.toLowerCase().slice(0, 32);
    if (!/^[a-z0-9_-]+$/.test(v)) return '';
    for (var i = 0; i < SRC_ALLOWED.length; i++) {
      if (SRC_ALLOWED[i] === v) return v;
    }
    return '';
  }

  /**
   * 落地页首触归因：首次进页时若 URL 带合法 ?src= 则写入会话存储，
   * 之后站内切页（即使 URL 已不含 src）仍沿用同一渠道，避免 UV 归因丢失。
   * 会话级隔离：同一标签页会话只认首触渠道（first-touch in session）。
   */
  function persistSrcFromUrl() {
    if (readStore(global.sessionStorage, CONFIG.srcKey) !== null) return; // 本会话已归因，不覆盖
    try {
      var qs = global.location && global.location.search;
      if (!qs) return;
      var sp = new URLSearchParams(qs);
      var src = normalizeSrc(sp.get('src'));
      if (src) writeStore(global.sessionStorage, CONFIG.srcKey, src);
    } catch (e) { /* URLSearchParams / 存储不可用时忽略归因 */ }
  }

  /** 当前会话的渠道标识（无则空串 = 未归因） */
  function getSrc() {
    return normalizeSrc(readStore(global.sessionStorage, CONFIG.srcKey));
  }

  /* ------------------------------ 存储工具 ------------------------------ */
  // localStorage / sessionStorage 在隐私模式、跨域 iframe 下可能抛异常，全部包 try
  function readStore(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function writeStore(store, key, value) {
    try { store.setItem(key, value); return true; } catch (e) { return false; }
  }

  /** 生成匿名随机串（不含任何个人信息），作为 UV 统计口径 */
  function randomId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }

  /** 获取（或首次生成）匿名访客 ID，持久化在 localStorage */
  function getVisitorId() {
    var id = readStore(global.localStorage, CONFIG.visitorKey);
    if (!id) {
      id = randomId();
      if (!writeStore(global.localStorage, CONFIG.visitorKey, id)) {
        // 存储不可用时退回内存态，保证本次会话内 UV 仍可去重
        id = id + '_mem';
      }
    }
    return id;
  }

  /** 获取（或续期）会话 ID：30 分钟无活动则生成新会话 */
  function getSessionId() {
    var store = global.sessionStorage;
    var raw = readStore(store, CONFIG.sessionKey);
    var now = Date.now();
    if (raw) {
      var parts = String(raw).split('|');
      if (parts.length === 2 && now - parseInt(parts[1], 10) < CONFIG.sessionTTL) {
        writeStore(store, CONFIG.sessionKey, parts[0] + '|' + now); // 续期
        return parts[0];
      }
    }
    var sid = 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    writeStore(store, CONFIG.sessionKey, sid + '|' + now);
    return sid;
  }

  /* ------------------------------ 页面信息 ------------------------------ */
  /**
   * 页面标识优先取 body 上的 data-page-id（color-tool 约定），
   * 再取 data-page（visitor / aiWeb 约定），都没有则回落 'unknown'
   */
  function pageType() {
    var body = global.document && global.document.body;
    if (!body) return 'unknown';
    return body.getAttribute('data-page-id')
      || body.getAttribute('data-page')
      || 'unknown';
  }

  function currentPath() {
    try {
      return global.location.pathname + global.location.search;
    } catch (e) {
      return '';
    }
  }

  /* ------------------------------ 上报通道 ------------------------------ */
  /**
   * 实际发送：优先 sendBeacon，降级 fetch(keepalive)
   * @param {Array<Object>} events - 待上报事件列表
   */
  function send(events) {
    if (!events || !events.length) return;
    var body;
    try {
      body = JSON.stringify(events.length === 1 ? events[0] : { events: events });
    } catch (e) {
      return; // 序列化失败（循环引用等）直接放弃，绝不影响页面
    }

    if (CONFIG.debug && global.console) {
      global.console.log('[Tracker] send:', body);
    }

    try {
      if (global.navigator && global.navigator.sendBeacon) {
        // text/plain 不触发 CORS 预检，后端按字符串自行解析
        var blob = new global.Blob([ body ], { type: 'text/plain' });
        if (global.navigator.sendBeacon(CONFIG.endpoint, blob)) return;
      }
      if (global.fetch) {
        global.fetch(CONFIG.endpoint, {
          method: 'POST',
          mode: 'no-cors',
          keepalive: true,
          headers: { 'Content-Type': 'text/plain' },
          body: body,
        }).catch(function () { /* 统计失败不影响页面 */ });
      }
    } catch (e) { /* 同上 */ }
  }

  /** 立即冲刷队列（页面隐藏/关闭时兜底，避免丢数） */
  function flush() {
    if (flushTimer) {
      global.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    var events = queue.splice(0, CONFIG.maxBatch);
    send(events);
    // P2-9：剩余事件继续排期冲刷。原实现只发首批 20 条，剩余滞留队列；
    // 页面关闭时 flush 只执行一次，溢出部分（如高频点击流）直接丢失。滚动排期直到清空。
    if (queue.length) flushTimer = global.setTimeout(flush, CONFIG.flushInterval);
  }

  /**
   * 入队并按间隔批量上报
   * @param event
   */
  function enqueue(event) {
    if (queue.length >= CONFIG.maxBatch * 5) queue.shift(); // 极端情况下丢弃最旧，防内存膨胀
    queue.push(event);
    if (!flushTimer) {
      flushTimer = global.setTimeout(flush, CONFIG.flushInterval);
    }
  }

  /* ------------------------------ 事件构造 ------------------------------ */
  /**
   * 构造完整事件 payload（补齐公共字段）
   * @param {String} event - 事件名（pv / click / search / 自定义）
   * @param {Object} [props] - 自定义属性（扁平键值对，禁止携带 PII 与用户输入内容）
   * @return {Object}
   */
  function buildEvent(event, props) {
    var payload = {
      project: CONFIG.project,
      terminal: CONFIG.terminal,
      event: event || 'custom',
      page: pageType(),
      path: currentPath(),
      // 渠道归因（WO-138）：一级字段，非 pv 事件也携带
      src: getSrc(),
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      ts: Date.now(),
    };

    var doc = global.document;
    if (doc) {
      payload.title = doc.title || '';
      payload.referrer = doc.referrer || '';
    }
    if (global.screen) {
      payload.screen = { w: global.screen.width || 0, h: global.screen.height || 0 };
    }
    if (props && typeof props === 'object') payload.props = props;

    return payload;
  }

  /**
   * 手动打点（对外主 API）
   * @param {String} event - 事件名
   * @param {Object} [props] - 自定义属性
   * @param {Boolean} [immediate] - 是否立即上报（默认按批量间隔）
   */
  function track(event, props, immediate) {
    var payload = buildEvent(event, props);
    if (immediate) {
      send([ payload ]);
    } else {
      enqueue(payload);
    }
    return payload;
  }

  /** 上报一次页面访问（同路径去重，防止劫持后重复触发） */
  function trackPv() {
    var path = currentPath();
    if (path === lastPath) return;
    lastPath = path;
    // WO-21：来源归因——读取 URL 的 ?src= 随 pv 上报，使小程序导流可拆分
    var props = null;
    try {
      var qs = global.location && global.location.search;
      if (qs) {
        var sp = new URLSearchParams(qs);
        var src = sp.get('src');
        if (src) props = { src: String(src).slice(0, 32) };
      }
    } catch (e) { /* URLSearchParams 不可用时忽略来源归因 */ }
    track('pv', props, true); // PV 立即上报，避免用户快速跳走丢数
  }

  /** 允许强制重新上报当前页 PV（如页面内容切换但 URL 未变） */
  function refreshPv() {
    lastPath = null;
    trackPv();
  }

  /* ------------------------------ 自动行为 ------------------------------ */
  /** 劫持 history，捕获单页应用内的虚拟页面切换 */
  function patchHistory() {
    if (!global.history) return;
    [ 'pushState', 'replaceState' ].forEach(function (name) {
      var orig = global.history[name];
      if (typeof orig !== 'function') return;
      global.history[name] = function () {
        var ret = orig.apply(this, arguments);
        trackPv();
        return ret;
      };
    });
    global.addEventListener('popstate', trackPv);
  }

  /**
   * [data-track] 元素点击自动打点
   * 用法：<button data-track="copy_color">复制</button>
   *       <a data-track="aff_click" data-track-props='{"id":"123"}'>去购买</a>
   * 采用事件委托，动态插入的元素同样生效，无需逐个绑定
   */
  function bindDataTrack() {
    if (!global.document || !global.document.addEventListener) return;
    global.document.addEventListener('click', function (e) {
      var el = e.target;
      // 向上冒泡查找最近的带 data-track 的祖先（最多 5 层，避免长链遍历）
      for (var i = 0; el && i < 5; i++) {
        if (el.getAttribute && el.getAttribute('data-track')) break;
        el = el.parentNode;
      }
      if (!el || !el.getAttribute) return;

      var name = el.getAttribute('data-track');
      if (!name) return;

      var props = null;
      var rawProps = el.getAttribute('data-track-props');
      if (rawProps) {
        try { props = JSON.parse(rawProps); } catch (_) { props = null; }
      }
      track(name, props);
    }, false);
  }

  /** 页面隐藏 / 关闭时兜底 flush（移动端与 Safari 常不触发 unload） */
  function bindFlushOnLeave() {
    if (!global.addEventListener) return;
    var handler = function () { flush(); };
    global.addEventListener('pagehide', handler);
    global.addEventListener('beforeunload', handler);
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'hidden') flush();
      });
    }
  }

  /* ------------------------------ JS Error 捕获（WO-336 fe-error） ------------------------------ */
  // 错误频率控制：同一错误指纹 5 分钟内最多上报 5 次，防噪声刷屏
  var errorFingerprints = Object.create(null);
  var ERROR_WINDOW_MS = 5 * 60 * 1000;
  var ERROR_MAX_PER_FINGERPRINT = 5;

  function fingerprintError(type, msg) {
    var raw = (type || '') + '|' + (msg || '');
    // 取前 128 字符的 hash（djb2；模 2^32，算术运算避免位运算副作用与 lint 限制）
    var h = 5381;
    for (var i = 0; i < Math.min(raw.length, 128); i++) {
      h = (h * 33 + raw.charCodeAt(i)) % 4294967296;
    }
    return h.toString(36);
  }

  function shouldReportError(fp) {
    var now = Date.now();
    var entry = errorFingerprints[fp];
    if (!entry) { errorFingerprints[fp] = { count: 1, firstSeen: now }; return true; }
    if (now - entry.firstSeen > ERROR_WINDOW_MS) { errorFingerprints[fp] = { count: 1, firstSeen: now }; return true; }
    if (entry.count >= ERROR_MAX_PER_FINGERPRINT) return false;
    entry.count++;
    return true;
  }

  function reportJsError(props) {
    try {
      track('fe-error', props, true); // 错误立即上报（用户可能瞬间离开）
    } catch (e) { /* 错误捕获与上报失败均不能影响页面 */ }
  }

  function reportResourceError(source, message) {
    var src = String(source || '').slice(0, 256);
    // 资源指纹按 URL 区分：不同资源各自限 5 条 / 5 分钟，避免共用 message 相互误吞。
    // 真实浏览器中资源错误不冒泡到 onerror，捕获阶段与兜底路径不会双触发，无需额外去重。
    if (!shouldReportError(fingerprintError('resource', src))) return;
    reportJsError({
      type: 'resource',
      message: String(message || 'Failed to load resource').slice(0, 512),
      source: src,
      lineno: 0,
      colno: 0,
    });
  }

  function initJsError() {
    try {
      var previousOnError = global.onerror;
      // 1. 同步 JS 错误（+ 旧环境经 onerror 冒泡的资源错误兜底）。
      //    资源 ErrorEvent 通常没有 error 对象，据此避免把 app.js 内真实运行异常误判成资源加载失败。
      //    现代浏览器资源错误只在捕获阶段派发，见下方 1b。
      global.onerror = function (message, source, lineno, colno, error) {
        var delegated;
        if (typeof previousOnError === 'function') {
          try { delegated = previousOnError.apply(global, arguments); } catch (e) { /* 旧 handler 不影响本 SDK */ }
        }
        var suppressDefault = delegated === true;
        try {
          var isResource = !error && typeof source === 'string'
            && /\.(?:js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)(?:[?#]|$)/i.test(source);
          if (isResource) {
            reportResourceError(source, message);
          } else {
            var msg = typeof message === 'string' ? message : (error && error.message) ? error.message : String(message);
            var fp = fingerprintError('script', msg);
            if (shouldReportError(fp)) {
              var props = {
                type: 'script',
                message: String(msg).slice(0, 512),
                source: (source || '').toString().slice(0, 256),
                lineno: lineno || 0,
                colno: colno || 0,
              };
              // 带 stack（截断到 8KB 防膨胀）
              if (error && error.stack) props.stack = String(error.stack).slice(0, 8192);
              reportJsError(props);
            }
          }
        } catch (e) { /* 错误消息 / 来源 / stack 读取失败也不能影响页面 */ }
        // 返回 undefined 保留浏览器默认控制台输出；仅旧 handler 明确返回 true 时抑制。
        return suppressDefault ? true : undefined;
      };

      // 1b. 资源加载错误（img / script / link / video / audio …）：真实浏览器中此类错误
      //     不冒泡到 window.onerror，只在捕获阶段可达；target 为具体元素、src/href 为资源地址。
      //     仅处理带 src/href 的元素，避免与上面的 script 分类重复或误伤普通 ErrorEvent。
      try {
        global.addEventListener('error', function (e) {
          try {
            var target = e && e.target;
            if (!target || target === global || target === global.document) return;
            var src = target.src || target.href || target.currentSrc || '';
            if (!src) return;
            reportResourceError(src, 'Failed to load resource: ' + String(src));
          } catch (err) { /* 资源错误信息读取失败不影响页面 */ }
        }, true);
      } catch (e) { /* 环境不支持捕获阶段监听时跳过，不阻断 onerror 路径 */ }

      // 2. Promise 未捕获拒绝
      global.addEventListener('unhandledrejection', function (e) {
        try {
          var reason = e && e.reason;
          var msg = (reason && reason.message) || (typeof reason === 'string' ? reason : String(reason));
          var fp = fingerprintError('promise', msg);
          if (!shouldReportError(fp)) return;

          var props = {
            type: 'promise',
            message: String(msg).slice(0, 512),
          };
          if (reason && reason.stack) props.stack = String(reason.stack).slice(0, 8192);
          reportJsError(props);
        } catch (err) { /* 拒绝原因读取失败不能再次抛出 */ }
      });
    } catch (e) { /* 错误捕获器自身不能抛错 */ }
  }

  /* ------------------------------ Core Web Vitals（WO-94 自有 RUM 源） ------------------------------ */
  // Google field 阈值：据此给单条样本打 good/ni/po 标签，与中台 webVitals 看板口径一致
  var CWV_THRESHOLD = {
    LCP: { good: 2500, poor: 4000 },
    INP: { good: 200, poor: 500 },
    CLS: { good: 0.1, poor: 0.25 },
  };

  function cwvRating(name, value) {
    var t = CWV_THRESHOLD[name];
    if (!t) return '';
    if (value <= t.good) return 'good';
    if (value > t.poor) return 'po';
    return 'ni';
  }

  /**
   * 采集并上报 LCP / INP / CLS（真实用户 field 数据，非实验室分）
   * 每指标每页仅上报一次（sent 去重），结算时机：load 后尽早出 LCP、页面隐藏/关闭结算、
   * 以及 10s 兜底（保证长驻页面也有读数）。PerformanceObserver / 对应 entryType 不支持时静默跳过。
   */
  function initWebVitals() {
    try {
      if (!global.PerformanceObserver || !global.performance) return;
      var supported = global.PerformanceObserver.supportedEntryTypes || [];
      var current = {};
      var sent = {};

      var supports = function(type) { return supported.indexOf(type) !== -1; };
      var report = function(name) {
        if (sent[name] || current[name] === undefined || current[name] === null) return;
        sent[name] = true;
        var v = name === 'CLS' ? Math.round(current[name] * 1000) / 1000 : Math.round(current[name]);
        track('cwv', { name: name, value: v, rating: cwvRating(name, v) }, true);
      };
      var reportAll = function() { report('LCP'); report('INP'); report('CLS'); };

      // LCP：取最近一次条目的 startTime
      if (supports('largest-contentful-paint')) {
        try {
          var lcpPo = new global.PerformanceObserver(function (list) {
            var entries = list.getEntries();
            var last = entries[entries.length - 1];
            if (last) current.LCP = last.startTime;
          });
          lcpPo.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) { /* ignore */ }
      }

      // CLS：累加非“最近变更”引发的布局偏移
      if (supports('layout-shift')) {
        try {
          var clsValue = 0;
          var clsPo = new global.PerformanceObserver(function (list) {
            list.getEntries().forEach(function (entry) {
              if (!entry.hadRecentChange) clsValue += entry.value;
            });
            current.CLS = clsValue;
          });
          clsPo.observe({ type: 'layout-shift', buffered: true });
        } catch (e) { /* ignore */ }
      }

      // INP：以 event timing 的最大 duration 近似（需 durationThreshold 支持）
      if (supports('event')) {
        try {
          var inpValue = 0;
          var inpPo = new global.PerformanceObserver(function (list) {
            list.getEntries().forEach(function (entry) {
              if (entry.duration > inpValue) inpValue = entry.duration;
            });
            current.INP = inpValue;
          });
          inpPo.observe({ type: 'event', durationThreshold: 16, buffered: true });
        } catch (e) { /* ignore */ }
      }

      // 页面首次隐藏 / 关闭时结算
      var flushed = false;
      var onLeave = function() {
        if (flushed) return;
        flushed = true;
        reportAll();
      };
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          if (global.document.visibilityState === 'hidden') onLeave();
        });
      }
      if (global.addEventListener) {
        global.addEventListener('pagehide', onLeave);
        global.addEventListener('load', function () { global.setTimeout(function () { report('LCP'); }, 100); });
      }
      // 兜底：长驻页面 10s 后结算一次，确保看板有真实读数
      global.setTimeout(reportAll, 10000);
    } catch (e) { /* CWV 采集失败绝不影响页面 */ }
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    try {
      if (global.location && global.location.protocol === 'file:') return; // 本地双击打开不上报
    } catch (e) { return; }

    initJsError(); // WO-336：错误捕获最先注册（boot 自身的同步错误也能抓到）
    patchHistory();
    bindDataTrack();
    bindFlushOnLeave();
    persistSrcFromUrl(); // 渠道归因先于首次 PV，保证落地页那一条就带上 src
    trackPv();
    if (CONFIG.webVitals) initWebVitals();
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ------------------------------ 对外 API ------------------------------ */
  var api = {
    track: track,
    trackPv: trackPv,
    refreshPv: refreshPv,
    flush: flush,
    config: CONFIG,
    visitorId: getVisitorId,
    src: getSrc, // 当前会话渠道（WO-138，供接入方自查）
    sdkVersion: SDK_VERSION,
  };

  global.Tracker = api;
  // 兼容旧版 pv.js 的全局名与调用方式（PVTrack.track()）
  global.PVTrack = { track: trackPv, endpoint: CONFIG.endpoint };
})(window);

/* ==== conversion.js ==== */
/* ==========================================================================
   conversion.js · 转化与来源归因层
   依赖：tracker.js（window.Tracker）
   口径表：data/conversion.json（改埋点必须同步改口径表）

   职责分工：
     - tracker.js 负责「怎么发」：SDK 自动 PV、[data-track] 点击委托、批量上报
     - 本文件负责「发什么」：来源归因、暴露类事件（案例进入视口）、
       滚动深度、FAQ 展开、站外点击，并为每个事件带上 src 归因
     - 中台侧按 visitorId + sessionId 把 session_start 的 src 关联到同会话其它事件

   对外：window.Conv.track(event, props) —— 业务代码统一走这里手动打点
   调试：页面加 ?conversion=1 时，控制台打印归因与本地聚合计数
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc) return;

  var STORE_KEY = '__cv_src';
  var SESSION_FLAG = '__cv_started';
  var debug = /[?&]conversion=1/.test(global.location.search);
  var localCount = {};

  var ATTR_KEYS = ['src', 'utm_source', 'utm_medium', 'utm_campaign', 'ref', 'from'];

  function readStore(key, store) {
    try { return (store || global.localStorage).getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value, store) {
    try { (store || global.localStorage).setItem(key, value); } catch (e) { /* 忽略 */ }
  }

  function param(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(global.location.search);
      return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    } catch (e) { return ''; }
  }

  /** 解析来源：显式参数 > 首次来源（持久化）> referrer 域名 > direct */
  function resolveSource() {
    var explicit = '';
    for (var i = 0; i < ATTR_KEYS.length; i++) {
      var v = param(ATTR_KEYS[i]);
      if (v) { explicit = v; break; }
    }

    var saved = readStore(STORE_KEY);
    if (explicit) {
      if (explicit !== saved) writeStore(STORE_KEY, explicit);
      return { src: explicit, firstTouch: explicit !== saved };
    }
    if (saved) return { src: saved, firstTouch: false };

    var ref = '';
    try { ref = doc.referrer || ''; } catch (e) { ref = ''; }
    if (ref) {
      var m = /^https?:\/\/([^/]+)/i.exec(ref);
      if (m && m[1].replace(/^www\./, '') !== global.location.host.replace(/^www\./, '')) {
        return { src: 'ref:' + m[1], firstTouch: false };
      }
    }
    return { src: 'direct', firstTouch: false };
  }

  var attrs = {
    src: 'direct',
    utm_source: param('utm_source'),
    utm_medium: param('utm_medium'),
    utm_campaign: param('utm_campaign'),
    ref: param('ref') || param('from'),
  };

  function track(event, props) {
    localCount[event] = (localCount[event] || 0) + 1;
    var merged = { src: attrs.src };
    if (attrs.utm_source) merged.utm_source = attrs.utm_source;
    if (attrs.utm_medium) merged.utm_medium = attrs.utm_medium;
    if (attrs.utm_campaign) merged.utm_campaign = attrs.utm_campaign;
    if (props) {
      for (var k in props) {
        if (Object.prototype.hasOwnProperty.call(props, k)) merged[k] = props[k];
      }
    }
    if (global.Tracker && global.Tracker.track) {
      return global.Tracker.track(event, merged);
    }
    return null;
  }

  /** 会话建立：每会话只报一次，带完整归因 — 中台据此给同会话事件补 src */
  function trackSessionStart() {
    var s = resolveSource();
    attrs.src = s.src;
    var started = false;
    try { started = global.sessionStorage.getItem(SESSION_FLAG) === '1'; } catch (e) { started = false; }
    if (started) return;
    try { global.sessionStorage.setItem(SESSION_FLAG, '1'); } catch (e) { /* 忽略 */ }
    track('session_start', {
      first_touch: s.firstTouch ? 1 : 0,
      landing: global.location.pathname || '/',
    });
  }

  /** 站外点击：与 cta_click（站内主 CTA）分开记，不计入主转化 */
  function bindOutbound() {
    doc.addEventListener('click', function (e) {
      var el = e.target;
      for (var i = 0; el && i < 5; i++) {
        if (el.tagName === 'A') break;
        el = el.parentNode;
      }
      if (!el || el.tagName !== 'A') return;
      var href = el.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) return; // 站内相对路径不算站外
      try {
        if (new global.URL(href).host === global.location.host) return;
      } catch (_) { /* 解析失败照常上报 */ }
      if (el.getAttribute('data-track')) return; // 已有显式埋点，不重复计数
      track('outbound_click', { target: href.slice(0, 120) });
    }, false);
  }

  /** FAQ 展开：高频问题 = 内容缺口 */
  function bindFaq() {
    doc.addEventListener('toggle', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'DETAILS' || !el.open) return;
      var q = '';
      var sum = el.querySelector('summary');
      if (sum) q = (sum.textContent || '').trim().slice(0, 40);
      track('faq_open', { q: q });
    }, true);
  }

  /** 滚动深度：25 / 50 / 75 / 100，每档每会话只报一次 */
  function bindScrollDepth() {
    var marks = [25, 50, 75, 100];
    var sent = {};
    var ticking = false;
    function check() {
      ticking = false;
      var docEl = doc.documentElement;
      var scrollable = docEl.scrollHeight - global.innerHeight;
      if (scrollable <= 0) return;
      var pct = Math.round((global.scrollY || docEl.scrollTop) / scrollable * 100);
      for (var i = 0; i < marks.length; i++) {
        if (pct >= marks[i] && !sent[marks[i]]) {
          sent[marks[i]] = 1;
          track('scroll_depth', { depth: marks[i] });
        }
      }
    }
    global.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      global.setTimeout(check, 200);
    }, { passive: true });
    check();
  }

  /** 券/案例卡片曝光：进入视口 ≥50% 且停留 1s
   *  - 券卡（data-case="coupon:<id>"）：报专用无歧义事件 coupon_view，逐页逐会话一次
   *    （与 OSS coupon-slot.js 同口径，供 v4-ledger 真券 CTR = coupon_click / coupon_view）；
   *  - 其余 data-case：保留逐卡逐会话 case_view 归因。
   */
  var caseIO = null;          // IntersectionObserver 句柄（供动态新增节点补观察）
  var caseSeen = {};          // 已上报的非券 data-case id（每会话一次）
  var caseTimers = {};        // 每张卡的停留计时器（按 data-case id 索引）

  // 页面标识（与 coupon-slot.js currentPage() 同逻辑：body[data-page-id|data-page] 优先，回落路径文件名）
  function currentPageId() {
    var body = doc.body;
    var pid = body && (body.getAttribute('data-page-id') || body.getAttribute('data-page'));
    if (pid) return pid;
    var file = (global.location.pathname || '/').split('/').pop() || '';
    if (!file || file === '/' || file.indexOf('index') === 0) return 'home';
    return file.replace(/\.html?$/i, '') || 'home';
  }
  function viewed(key) { try { return global.sessionStorage.getItem(key) === '1'; } catch (e) { return false; } }
  function markViewed(key) { try { global.sessionStorage.setItem(key, '1'); } catch (e) { /* 隐私模式忽略 */ } }

  // 券曝光：逐页逐会话只报一次 coupon_view（sessionStorage 去重，键与 coupon-slot.js 一致）
  function emitCouponView() {
    var key = '__coupon_view_' + currentPageId();
    if (viewed(key)) return;
    markViewed(key);
    track('coupon_view', { page: currentPageId(), via: 'coupon-page' });
  }

  function scanCaseNodes() {
    if (!caseIO) return;
    var nodes = doc.querySelectorAll('[data-case]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__cvObserved) continue;
      nodes[i].__cvObserved = 1;
      caseIO.observe(nodes[i]);
    }
  }

  function bindCaseView() {
    if (!global.IntersectionObserver) {
      // 兜底（与 coupon-slot.js 同策略）：不支持 IO 时若页上有券卡，立即补报一次，宁可少采不虚采
      if (doc.querySelector('[data-case^="coupon:"]')) emitCouponView();
      return;
    }
    caseIO = new global.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var id = entry.target.getAttribute('data-case') || '';
        if (!id) return;
        if (id.indexOf('coupon:') === 0) {
          // 券曝光走 coupon_view（逐页逐会话去重在 emitCouponView 内完成），不再发含混 case_view
          if (entry.isIntersecting) {
            if (!caseTimers[id]) {
              caseTimers[id] = global.setTimeout(function () {
                caseTimers[id] = null;
                emitCouponView();
              }, 1000);
            }
          } else if (caseTimers[id]) {
            global.clearTimeout(caseTimers[id]);
            caseTimers[id] = null;
          }
          return;
        }
        // 非券 data-case：保留逐卡逐会话 case_view 归因
        if (caseSeen[id]) return;
        if (entry.isIntersecting) {
          caseTimers[id] = global.setTimeout(function () {
            caseSeen[id] = 1;
            track('case_view', { case: id });
          }, 1000);
        } else if (caseTimers[id]) {
          global.clearTimeout(caseTimers[id]);
          caseTimers[id] = null;
        }
      });
    }, { threshold: 0.5 });
    scanCaseNodes();
  }

  /** 供业务代码（如 coupon-page.js 动态渲染券卡后）补观察新插入的 [data-case] 节点 */
  function reobserve() {
    scanCaseNodes();
  }

  function boot() {
    if (!global.Tracker) return; // SDK 被拦截时不报错，页面照常可用
    trackSessionStart();
    bindOutbound();
    bindFaq();
    bindScrollDepth();
    bindCaseView();
    if (debug && global.console) {
      global.console.log('[Conversion] attrs:', attrs, 'localCount:', localCount);
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.Conv = {
    track: track,
    attrs: attrs,
    count: localCount,
    reobserve: reobserve,
  };
})(window);

/* ==== app.js ==== */
/* ==========================================================================
   app.js · 站点交互（主题、移动菜单、表单、复制）
   数据内容由 scripts/build.js 在构建期注入静态 HTML，本文件只负责运行期交互，
   因此禁用 JS 也不会影响页面可读性与 SEO。
   埋点：交互事件统一走 window.Conv.track（conversion.js），自动带来源归因。
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  var THEME_KEY = 'mrx_theme';

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(sel));
  }

  function toast(message) {
    var el = $('#toast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      doc.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    global.clearTimeout(el._timer);
    el._timer = global.setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function readStore(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
  }

  /* --------------------------------- 主题（三站统一：键名 mrx_theme，三态 auto / light / dark） --------------------------------- */
  var THEME_LEGACY = ['__theme'];
  var THEME_MODES = ['auto', 'light', 'dark'];
  var THEME_LABEL = { auto: '自动', light: '亮色', dark: '暗色' };
  var THEME_ICON = { auto: '🌗', light: '☀', dark: '🌙' };

  function systemTheme() {
    try {
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (e) { /* 不支持媒体查询时走兜底 */ }
    var def = doc.documentElement.getAttribute('data-theme-default');
    return def === 'dark' ? 'dark' : 'light';
  }

  function storedPref() {
    try {
      var v = readStore(THEME_KEY);
      if (v === 'auto' || v === 'light' || v === 'dark') return v;
      // 旧键只迁移不回迁
      for (var i = 0; i < THEME_LEGACY.length; i++) {
        var old = readStore(THEME_LEGACY[i]);
        if (old === 'light' || old === 'dark') {
          try { global.localStorage.setItem(THEME_KEY, old); } catch (e) {}
          return old;
        }
      }
    } catch (e) { /* 隐私模式忽略 */ }
    return 'auto';
  }

  function resolveTheme(pref) {
    return pref === 'dark' || pref === 'light' ? pref : systemTheme();
  }

  function applyTheme(actual, mode) {
    doc.documentElement.setAttribute('data-theme', actual);
    var btn = $('#themeToggle');
    if (btn) {
      // WO-197 契约：图标反映「模式」而非解析后的主题，三态循环每点一次图标必变（🌗 / ☀ / 🌙）
      var m = THEME_MODES.indexOf(mode) >= 0 ? mode : 'auto';
      var next = THEME_MODES[(THEME_MODES.indexOf(m) + 1) % THEME_MODES.length];
      btn.textContent = THEME_ICON[m];
      btn.setAttribute('data-theme-mode', m);
      btn.setAttribute('data-theme-next', next);
      // 读屏与悬浮提示同一串文案（七站统一：「当前主题：X（点击切换为Y）」），不留两套口径
      var tip = '当前主题：' + THEME_LABEL[m] + '（点击切换为' + THEME_LABEL[next] + '）';
      btn.setAttribute('aria-label', tip);
      btn.setAttribute('title', tip);
    }
  }

  function setTheme(pref, persist) {
    var mode = THEME_MODES.indexOf(pref) >= 0 ? pref : 'auto';
    var actual = resolveTheme(mode);
    applyTheme(actual, mode);
    if (persist !== false) writeStore(THEME_KEY, mode);
    if (global.Conv) global.Conv.track('theme_switch', { theme: mode });
  }

  function initTheme() {
    var pref = storedPref();
    applyTheme(resolveTheme(pref), pref);
    var btn = $('#themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cur = storedPref();
      var next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
      setTheme(next);
    });
    // auto 偏好下跟随系统实时生效
    try {
      var mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', function () {
          if (storedPref() !== 'auto') return;
          applyTheme(systemTheme(), 'auto');
        });
      }
    } catch (e) { /* 老浏览器忽略 */ }
  }

  /* ------------------------------- 移动端菜单 ------------------------------- */
  function initNav() {
    var toggle = $('#navToggle');
    var nav = $('#primaryNav');
    if (!toggle || !nav) return;
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* -------------------------------- 复制文本 -------------------------------- */
  function copyText(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand('copy');
        doc.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function initCopy() {
    $$('[data-copy]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var text = el.getAttribute('data-copy') || '';
        copyText(text).then(function () {
          toast('已复制：' + text);
          if (global.Conv) global.Conv.track('copy', { type: el.getAttribute('data-copy-type') || 'text' });
        }).catch(function () {
          toast('复制失败，请手动选中：' + text);
        });
      });
    });
  }

  /* -------------------------------- 联系表单 -------------------------------- */
  /**
   * 静态站没有后端：提交后拼 mailto 交给用户自己的邮件客户端发送，
   * 同时上报 form_submit（主转化事件）。后续接了后端，把 openMail 换成 fetch 即可。
   */
  function initForm() {
    var form = $('#contactForm');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = (form.elements.name && form.elements.name.value || '').trim();
      var company = (form.elements.company && form.elements.company.value || '').trim();
      var contact = (form.elements.contact && form.elements.contact.value || '').trim();
      var topic = (form.elements.topic && form.elements.topic.value || '').trim();
      var message = (form.elements.message && form.elements.message.value || '').trim();

      if (!name) { toast('请填写你的称呼'); return; }
      if (!contact) { toast('请填写邮箱或手机号，方便我联系你'); return; }

      if (global.Conv) global.Conv.track('form_submit', { topic: topic || '未选择' });

      var email = form.getAttribute('data-email') || '';
      if (!email) {
        toast('已收到，我们会尽快联系你');
        form.reset();
        return;
      }

      var subject = '[实测手记] ' + (topic || '咨询') + ' · ' + name + (company ? '（' + company + '）' : '');
      var body = [
        '称呼：' + name,
        '公司：' + (company || '-'),
        '联系方式：' + contact,
        '咨询类型：' + (topic || '-'),
        '',
        '留言：',
        message || '-',
      ].join('\n');

      global.location.href = 'mailto:' + email +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);

      toast('已打开邮件客户端，发送后我会回信');
      form.reset();
    });
  }

  /* ------------------------------ 回到顶部 ------------------------------ */
  // 滚动超过一屏后右下角浮现；纯 DOM 派生，无需页面预埋容器
  function initBackTop() {
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-back-top';
    btn.hidden = true;
    btn.setAttribute('aria-label', '回到顶部');
    btn.textContent = '↑';
    doc.body.appendChild(btn);
    btn.addEventListener('click', function () {
      try { global.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { doc.documentElement.scrollTop = 0; }
    });
    var ticking = false;
    global.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      global.setTimeout(function () {
        ticking = false;
        btn.hidden = (global.scrollY || doc.documentElement.scrollTop || 0) < 600;
      }, 100);
    }, { passive: true });
  }

  /* --------------------------- AB 实验客户端分桶（M11） --------------------------- */
  // 由匿名访客 ID 哈希决定桶（A/B），上报 exp_assign；券卡埋点带 bucket 供回收分析
  function initExp() {
    if (!global.Tracker) return;
    var vid = global.Tracker.visitorId();
    if (!vid) return;
    var h = 0;
    for (var i = 0; i < vid.length; i++) h = (h * 31 + vid.charCodeAt(i)) | 0;
    var bucket = (Math.abs(h) % 100) < 50 ? 'A' : 'B';
    global.__exp = { name: 'card_style_2026', bucket: bucket };
    global.Tracker.track('exp_assign', { exp: 'card_style_2026', bucket: bucket });
  }

  /* ----------------------------- PWA 注册（M5a） ----------------------------- */
  function initPWA() {
    if ('serviceWorker' in global.navigator) {
      global.addEventListener('load', function () {
        global.navigator.serviceWorker.register('/sw.js').catch(function () { /* 注册失败不影响页面 */ });
      });
    }
  }

  /* --------------------------- Web Push（已下线） ---------------------------
     原 M5b 浏览器推送订阅/引导（CouponPush / enablePush / initPush / initPushGuide）已整体移除：
     大陆 Chrome 走 Google FCM、prod 到 fcm.googleapis.com:443 实测不可达，投递恒失败；
     H5 券提醒改走公众号（服务号）网页授权订阅（见 my-alerts.js 引导卡 / store.js showRemindGuide）。
     Service Worker 仍保留（sw.js 仅做离线兜底，不再监听 push/notificationclick）。 */

  /* --------------------------------- 启动 --------------------------------- */
  function boot() {
    initTheme();
    initNav();
    initCopy();
    initForm();
    initBackTop();
    initExp();
    initPWA();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

/* ==== share.js ==== */
/* ==========================================================================
   share.js · 优惠券分享（M4 · W2 升级）
   —— 零依赖：优先调系统原生 Web Share（移动端拉起分享面板），
      降级到自绘 canvas 海报下载（商品图 / 券力大字 / 深链二维码），再降级到复制深链。
   —— W2：分享链接统一指向站内券详情页 /p/<tao_id>（可承接回流与追踪），
      海报右下角渲染该深链二维码（qrcode.js 零依赖生成，缺脚本/超长时降级为无码版式）。
   合规：分享卡片底部固定「小满券仓」品牌与深链，rel=sponsored 由券卡自身承载，不混入广告位。
   静默失败：任何一步异常都不影响页面，最多退化为复制链接。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;

  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  // W2 分享深链：优先站内详情页 /p/<id>（可承接/追踪），无 id 时退回联盟直链
  function deepLink(item) {
    if (item && item.id) {
      var origin = (global.location && global.location.origin) || 'https://coupon.zangeng.com';
      return origin + '/p/' + encodeURIComponent(String(item.id)) + '.html';
    }
    return safeUrl(item && item.url) || '';
  }

  function miniToast(msg) {
    var t = doc.getElementById('cpShareToast');
    if (!t) {
      t = doc.createElement('div');
      t.id = 'cpShareToast';
      t.className = 'toast';
      doc.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    global.clearTimeout(t._timer);
    t._timer = global.setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  function copyDeep(url) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(url).then(function () {
        miniToast('已复制分享链接');
        if (global.Tracker) global.Tracker.track('coupon_share', { type: 'copy', coupon_id: '' });
      }).catch(function () { miniToast('复制失败，请长按链接复制'); });
    } else {
      miniToast('已生成分享图');
    }
  }

  // 简单按字符换行（CJK 无空格，逐字测量）
  function wrapText(ctx, text, x, y, maxW, lh) {
    var chars = String(text || '').split('');
    var line = '', yy = y;
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = chars[i]; yy += lh; }
      else line = test;
    }
    if (line) ctx.fillText(line, x, yy);
  }

  // 品牌红（与 tokens.css --brand 同色系），canvas 无法读 CSS 变量，固定口径
  var BRAND = '#e4393c';

  // 在 (x,y) 起画至多 maxSide px 的二维码（含白边），返回占用边长；无 QRCode/失败返回 0
  function drawQr(ctx, text, x, y, maxSide) {
    try {
      if (!global.QRCode || !global.QRCode.encode || !text) return 0;
      var qr = global.QRCode.encode(text);
      if (!qr || !qr.size) return 0;
      var quiet = 2; // 白边界（海报场景够用，扫码 App 均兼容）
      var cells = qr.size + quiet * 2;
      var scale = Math.max(2, Math.floor(maxSide / cells));
      var side = cells * scale;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, side, side);
      ctx.fillStyle = '#111111';
      for (var yy = 0; yy < qr.size; yy++) {
        for (var xx = 0; xx < qr.size; xx++) {
          if (qr.modules[yy][xx]) ctx.fillRect(x + (xx + quiet) * scale, y + (yy + quiet) * scale, scale, scale);
        }
      }
      ctx.strokeStyle = '#dddddd'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, side - 1, side - 1);
      return side;
    } catch (e) { return 0; }
  }

  // 自绘海报（600×880）：品牌头 + 商品图 + 券力大字 + 到手价 + 标题 + 深链二维码
  // item.link 可显式覆盖二维码/分享目标（W5 里程碑战报指回首页，不依赖 tao_id）
  function drawPoster(item) {
    var W = 600, H = 880;
    var c = doc.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    var link = item.link || deepLink(item);
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
    x.fillStyle = BRAND; x.fillRect(0, 0, W, 96);
    x.fillStyle = '#ffffff'; x.font = 'bold 34px sans-serif'; x.fillText('小满券仓 · 先领券再下单更省', 30, 60);

    var done = false;
    function finish() {
      if (done) return; done = true;
      // 券力大字区
      x.fillStyle = BRAND; x.font = 'bold 46px sans-serif';
      var powerY = item.img ? 660 : 400;
      if (item.power) {
        // 自定义大字（里程碑战报等无券力场景）
        x.fillText(item.power, 30, powerY);
        if (item.sub) { x.font = 'bold 30px sans-serif'; x.fillStyle = '#222'; x.fillText(item.sub, 30, powerY + 48); }
      } else if (item.off) {
        x.fillText(item.quota ? ('满' + item.quota + '减' + item.off) : ('立减 ¥' + item.off), 30, powerY);
        x.font = 'bold 34px sans-serif';
        x.fillText('到手 ¥' + (item.price || '?'), 30, powerY + 52);
      } else {
        x.fillText('到手 ¥' + (item.price || '?'), 30, powerY);
      }
      // 标题（最多两行）
      x.fillStyle = '#222'; x.font = '22px sans-serif';
      wrapText(x, item.t || '优惠券', 30, powerY + 96, item.id ? 380 : 540, 30);

      // 右下二维码：扫我打开站内详情页
      var qrSide = drawQr(x, link, W - 200, powerY + 30, 170);
      if (qrSide) {
        x.fillStyle = '#666'; x.font = '15px sans-serif';
        x.fillText('扫码领券', W - 200 + qrSide / 2 - 30, powerY + 30 + qrSide + 22);
      } else {
        x.fillStyle = '#999'; x.font = '15px sans-serif';
        wrapText(x, '打开 coupon.zangeng.com 领券：' + link.slice(0, 60), 30, H - 40, W - 60, 20);
      }
      // 底部提示
      x.fillStyle = '#999'; x.font = '15px sans-serif';
      x.fillText('长按保存海报 · 微信扫码领券', 30, H - 24);
      try {
        var a = doc.createElement('a');
        a.download = 'coupon-' + (item.id || 'share') + '.png';
        a.href = c.toDataURL('image/png');
        a.click();
        if (global.Tracker) global.Tracker.track('poster_share', { coupon_id: item.id || '', qr: qrSide ? 1 : 0, title: item.t || '' });
        miniToast('已生成分享图，长按图保存');
      } catch (e) { copyDeep(link); }
    }

    if (item.img) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { try { x.drawImage(img, 60, 130, 480, 480); } catch (e) {} finish(); };
      img.onerror = function () { finish(); };
      img.src = item.img;
      global.setTimeout(function () { if (!done) finish(); }, 2500); // 图未加载也出图
    } else { finish(); }
  }

  function openShare(item) {
    var link = item.link || deepLink(item);
    var title = item.t || '优惠券';
    if (global.navigator && global.navigator.share) {
      global.navigator.share({ title: title, text: '先领券再下单更省：' + title, url: link })
        .then(function () { if (global.Tracker) global.Tracker.track('coupon_share', { type: 'web', coupon_id: item.id || '' }); })
        .catch(function () {});
      return;
    }
    drawPoster(item);
  }

  // 给券卡包裹层 .cp-cell 追加分享按钮（与收藏星标并列）
  function attach(cell, item) {
    if (!cell || !item || !item.id) return;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-share';
    btn.textContent = '↗';
    btn.setAttribute('aria-label', '分享该券');
    btn.setAttribute('data-track', 'coupon_share');
    btn.setAttribute('data-track-props', JSON.stringify({ coupon_id: item.id || '', title: item.t || '' }));
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openShare(item);
    });
    cell.appendChild(btn);
  }

  global.CouponShare = { attach: attach, openShare: openShare, deepLink: deepLink };
})(window);

/* ==== store.js ==== */
/* ==========================================================================
   store.js · 小满券仓本地数据层（收藏 / 最近看过 / 搜索历史 / 提醒订阅引导）
   —— 纯 localStorage、零依赖、静默失败（无痕模式 / 配额满时不报错，功能自动降级）。
   · 券卡星标：coupon-page.js / list-page.js 生成卡片时调 CouponStore.attachStar；
     预渲染静态券卡由本脚本启动时补增强（包一层 .cp-cell + 收藏按钮，禁 JS 不受影响）。
   · 最近看过：事件委托捕获 .cp-card 点击，从 DOM 反解券快照（上限 24 条）。
   · 收藏上限 100、搜索历史上限 10；数据结构为紧凑快照 {id,did,t,img,url,price,quota,off,at}。
   · 到期/大额提醒：走公众号（服务号）网页授权订阅（web-push / 带参小程序码均已退役）；
     id=tao_id（本机清单主键，历史兼容）、did=_id（详情页 URL 键，供 /my-alerts.html 构造 /p/<_id>.html）。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var K_FAV = 'coupon_favs';
  var K_RECENT = 'coupon_recent';
  var K_SEARCH = 'coupon_searches';
  var K_ALERT = 'coupon_alerts';
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var FAV_MAX = 100;
  var RECENT_MAX = 24;
  var SEARCH_MAX = 10;
  var ALERT_MAX = 50;
  var ALERT_IMPORT_MAX_BYTES = 512 * 1024;
  var ALERT_STALE_MS = 180 * 24 * 3600 * 1000;

  function lsGet(key) {
    try {
      var raw = global.localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function lsSet(key, arr) {
    try { global.localStorage.setItem(key, JSON.stringify(arr)); return true; } catch (e) { return false; }
  }

  /* ------------------------------- 快照工具 ------------------------------- */
  function numFrom(text, re) {
    var m = String(text || '').match(re);
    return m ? Number(m[1]) : 0;
  }

  // 从券卡 DOM 反解紧凑快照（预渲染卡与运行时卡同构，均带 cp-name/cp-off/cp-final）
  function itemFromCard(a) {
    var cid = (a.getAttribute('data-case') || '').replace(/^coupon:/, '');
    var did = a.getAttribute('data-id') || ''; // 详情页 URL 键＝_id（供 my-alerts 构造 /p/<_id>.html）
    var url = a.href || '';
    var id = cid || url;
    if (!id || id === '#') return null;
    var nameEl = a.querySelector('.cp-name');
    var offEl = a.querySelector('.cp-off');
    var finEl = a.querySelector('.cp-final');
    var imgEl = a.querySelector('img');
    var quota = 0, off = 0;
    if (offEl) {
      quota = numFrom(offEl.textContent, /满(\d+(?:\.\d+)?)减/);
      off = numFrom(offEl.textContent, quota > 0 ? /减(\d+(?:\.\d+)?)/ : /(\d+(?:\.\d+)?)/);
    }
    return {
      id: String(id),
      did: String(did),
      t: nameEl ? (nameEl.textContent || '').trim() : '',
      img: imgEl ? (imgEl.getAttribute('src') || '') : '',
      url: (/^https?:\/\//i.test(url) ? url : ''),
      price: finEl ? numFrom(finEl.textContent, /(\d+(?:\.\d+)?)/) : 0,
      quota: quota,
      off: off,
    };
  }

  /* -------------------------------- 收藏 -------------------------------- */
  function favs() { return lsGet(K_FAV); }

  function isFav(id) {
    if (!id) return false;
    return favs().some(function (f) { return f.id === String(id); });
  }

  // 返回切换后的收藏态（true=已收藏）
  function toggleFav(item) {
    if (!item || !item.id) return false;
    var id = String(item.id);
    var arr = favs();
    var next = arr.filter(function (f) { return f.id !== id; });
    var on = next.length === arr.length; // 原列表没删掉任何东西 → 新收藏
    if (on) next.unshift({ id: id, t: item.t || '', img: item.img || '', url: item.url || '', price: item.price || 0, quota: item.quota || 0, off: item.off || 0, at: Date.now() });
    lsSet(K_FAV, next.slice(0, FAV_MAX));
    return on;
  }

  function removeFav(id) {
    lsSet(K_FAV, favs().filter(function (f) { return f.id !== String(id); }));
  }

  function clearFavs() { lsSet(K_FAV, []); }

  // 导出收藏为 JSON 文本（本地备份 / 跨设备迁移）
  function exportFavs() {
    return JSON.stringify({ v: 1, site: 'coupon.zangeng.com', exportedAt: new Date().toISOString(), favs: favs() });
  }
  // 从 JSON 文本导入收藏：按 id 合并去重、保留已有；返回 {ok:true,added,total} 或 {ok:false,msg}
  function importFavs(text) {
    var obj;
    try { obj = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, msg: '不是合法的 JSON 文件' }; }
    var arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.favs) ? obj.favs : null);
    if (!arr) return { ok: false, msg: '文件中没有收藏数据' };
    var cur = favs();
    var seen = {};
    cur.forEach(function (f) { if (f && f.id != null) seen[String(f.id)] = 1; });
    var added = 0;
    arr.forEach(function (f) {
      if (!f || f.id == null) return;
      var id = String(f.id);
      if (seen[id]) return;
      cur.push({ id: id, t: f.t || '', img: f.img || '', url: f.url || '', price: Number(f.price) || 0, quota: Number(f.quota) || 0, off: Number(f.off) || 0, at: Number(f.at) || Date.now() });
      seen[id] = 1;
      added++;
    });
    lsSet(K_FAV, cur.slice(0, FAV_MAX));
    return { ok: true, added: added, total: Math.min(cur.length, FAV_MAX) };
  }

  /* ------------------------------ 收藏同步码（无账号、无网络请求） ------------------------------ */
  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function utf8Encode(str) {
    var out = '', i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0x800) out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  function utf8Decode(bytes) {
    var out = '', i = 0, c, c2, c3, c4, cp;
    while (i < bytes.length) {
      c = bytes.charCodeAt(i++);
      if (c < 0x80) { out += String.fromCharCode(c); continue; }
      if (c < 0xe0) { c2 = bytes.charCodeAt(i++); out += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f)); continue; }
      if (c < 0xf0) { c2 = bytes.charCodeAt(i++); c3 = bytes.charCodeAt(i++); out += String.fromCharCode(((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f)); continue; }
      c2 = bytes.charCodeAt(i++); c3 = bytes.charCodeAt(i++); c4 = bytes.charCodeAt(i++);
      cp = ((c & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f);
      out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
    }
    return out;
  }
  function b64urlEncode(str) {
    var bytes = utf8Encode(str), out = '', i, a, b, c;
    for (i = 0; i < bytes.length; i += 3) {
      a = bytes.charCodeAt(i); b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : -1; c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : -1;
      out += B64URL.charAt(a >> 2) + B64URL.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
      if (b < 0) break;
      out += B64URL.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));
      if (c < 0) break;
      out += B64URL.charAt(c & 63);
    }
    return out;
  }
  function b64urlDecode(s) {
    var bytes = '', i, n, a, b, c;
    s = String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
    for (i = 0; i < s.length; i += 4) {
      a = B64URL.indexOf(s.charAt(i)); b = B64URL.indexOf(s.charAt(i + 1));
      c = i + 2 < s.length ? B64URL.indexOf(s.charAt(i + 2)) : -1;
      n = i + 3 < s.length ? B64URL.indexOf(s.charAt(i + 3)) : -1;
      if (a < 0 || b < 0) break;
      bytes += String.fromCharCode((a << 2) | (b >> 4));
      if (c >= 0) bytes += String.fromCharCode(((b & 15) << 4) | (c >> 2));
      if (n >= 0) bytes += String.fromCharCode(((c & 3) << 6) | n);
    }
    return utf8Decode(bytes);
  }
  // 同步码只含必要字段，最多 30 条；不包含账号或任何 PII，链接本身即凭证
  function exportSyncCode() {
    var list = favs().slice(0, 30).map(function (f) {
      return { id: String(f.id || ''), t: f.t || '', u: f.url || '', p: Number(f.price) || 0, o: Number(f.off) || 0, q: Number(f.quota) || 0, i: f.img || '' };
    });
    return 'C1.' + b64urlEncode(JSON.stringify({ v: 1, f: list }));
  }
  function importSyncCode(code) {
    if (typeof code !== 'string' || code.indexOf('C1.') !== 0) return { ok: false, msg: '同步码格式不正确' };
    var obj;
    try { obj = JSON.parse(b64urlDecode(code.slice(3))); } catch (e) { return { ok: false, msg: '同步码已损坏，请重新生成' }; }
    if (!obj || !Array.isArray(obj.f)) return { ok: false, msg: '同步码中没有收藏数据' };
    var cur = favs(), seen = {}, added = 0;
    cur.forEach(function (f) { if (f && f.id != null) seen[String(f.id)] = 1; });
    obj.f.forEach(function (f) {
      if (!f || !f.id || seen[String(f.id)]) return;
      cur.push({ id: String(f.id), t: f.t || '', img: f.i || '', url: f.u || '', price: Number(f.p) || 0, quota: Number(f.q) || 0, off: Number(f.o) || 0, at: Date.now() });
      seen[String(f.id)] = 1;
      added++;
    });
    lsSet(K_FAV, cur.slice(0, FAV_MAX));
    return { ok: true, added: added, total: Math.min(cur.length, FAV_MAX) };
  }

  /* ------------------------------ 最近看过 ------------------------------ */
  function recent() { return lsGet(K_RECENT); }

  function pushRecent(item) {
    if (!item || !item.id) return;
    var id = String(item.id);
    var arr = recent().filter(function (f) { return f.id !== id; });
    item = { id: id, t: item.t || '', img: item.img || '', url: item.url || '', price: item.price || 0, quota: item.quota || 0, off: item.off || 0, at: Date.now() };
    arr.unshift(item);
    lsSet(K_RECENT, arr.slice(0, RECENT_MAX));
  }

  function removeRecent(id) {
    lsSet(K_RECENT, recent().filter(function (f) { return f.id !== String(id); }));
  }

  function clearRecent() { lsSet(K_RECENT, []); }

  /* ------------------------------ 搜索历史 ------------------------------ */
  function searches() { return lsGet(K_SEARCH); }

  function pushSearch(kw) {
    kw = String(kw || '').trim();
    if (!kw) return;
    var arr = searches().filter(function (s) { return s !== kw; });
    arr.unshift(kw);
    lsSet(K_SEARCH, arr.slice(0, SEARCH_MAX));
  }

  function clearSearches() { lsSet(K_SEARCH, []); }

  /* ---------------------- 猜你喜欢（M1）本地信号 ---------------------- */
  // 用户信号词：最近看过标题 + 搜索历史，供 coupon-page.js 做子串匹配重排
  function recommendTerms() {
    var terms = [];
    recent().forEach(function (r) { if (r && r.t) terms.push(r.t); });
    searches().forEach(function (s) { if (s) terms.push(s); });
    return terms.slice(0, 16);
  }
  // 已曝光/已收藏的券 id 集合，猜你喜欢去重用
  function seenIds() {
    var s = {};
    favs().forEach(function (f) { if (f && f.id != null) s[String(f.id)] = 1; });
    recent().forEach(function (f) { if (f && f.id != null) s[String(f.id)] = 1; });
    return s;
  }

  /* ---------------------- 降价/到期提醒（M2）本机清单 ---------------------- */
  function alerts() { return lsGet(K_ALERT, []); }
  function isAlert(id) { return alerts().some(function (x) { return x.id === String(id); }); }
  // 切换订阅：本地 localStorage 为主，后端上报为最佳努力（失败忽略）
  function toggleAlert(item) {
    var list = alerts();
    var id = String(item.id);
    if (!id) return false;
    var idx = -1;
    list.forEach(function (x, i) { if (x.id === id) idx = i; });
    var on;
    if (idx >= 0) { list.splice(idx, 1); on = false; }
    else {
      list.unshift({
        id: id, did: String(item.did || ''), t: item.t || '', img: item.img || '', url: item.url || '',
        price: Number(item.price) || 0, quota: Number(item.quota) || 0, off: Number(item.off) || 0,
        baseline: { price: Number(item.price) || 0, quota: Number(item.quota) || 0, couponDiscount: Number(item.off) || 0 },
        ts: Date.now(),
      });
      on = true;
    }
    lsSet(K_ALERT, list.slice(0, ALERT_MAX));
    syncAlert(on ? 'subscribe' : 'unsubscribe', item);
    return on;
  }
  // 导出/导入只操作本机清单，不调用 syncAlert，也不代表公众号服务号订阅已迁移。
  function exportAlerts() {
    return JSON.stringify({
      v: 1, type: 'price-alerts', site: MAIN_URL, exportedAt: new Date().toISOString(), alerts: alerts(),
    });
  }

  function alertNumber(value) {
    if (value == null || value === '') return 0;
    var n = Number(value);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function alertText(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function normalizeImportedAlert(item, now) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var id = alertText(item.id, 200).trim();
    if (!id) return null;
    var price = alertNumber(item.price);
    var quota = alertNumber(item.quota);
    var off = alertNumber(item.off);
    var baseline = item.baseline && typeof item.baseline === 'object' ? item.baseline : {};
    var basePrice = alertNumber(baseline.price);
    var baseQuota = alertNumber(baseline.quota);
    var baseOff = alertNumber(baseline.couponDiscount);
    if ([ price, quota, off, basePrice, baseQuota, baseOff ].indexOf(null) >= 0) return null;
    var url = alertText(item.url, 2048);
    var img = alertText(item.img, 2048);
    if (url && !/^https?:\/\/\S+$/i.test(url)) return null;
    if (img && !/^(?:https?:\/\/|\/)[^\s]+$/i.test(img)) return null;
    var ts = Number(item.ts);
    return {
      id: id, did: alertText(item.did, 200), t: alertText(item.t, 300), img: img, url: url,
      price: price, quota: quota, off: off,
      baseline: { price: basePrice == null ? price : basePrice, quota: baseQuota == null ? quota : baseQuota, couponDiscount: baseOff == null ? off : baseOff },
      ts: isFinite(ts) && ts > 0 ? ts : now,
    };
  }

  function previewAlerts(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, msg: '请选择备份文件' };
    var bytes = global.Blob ? new global.Blob([ text ]).size : text.length;
    if (bytes > ALERT_IMPORT_MAX_BYTES) return { ok: false, msg: '文件超过 512KB，请减少订阅记录后重试' };
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, msg: '不是合法的 JSON 文件' }; }
    var arr = Array.isArray(obj) ? obj : (obj && obj.v === 1 && obj.type === 'price-alerts' && Array.isArray(obj.alerts) ? obj.alerts : null);
    if (!arr) return { ok: false, msg: '文件不是降价提醒备份（仅支持 v1 / price-alerts）' };
    var now = Date.now(), valid = [], seen = Object.create(null), duplicates = 0, invalid = 0, expired = 0;
    arr.forEach(function (raw) {
      var item = normalizeImportedAlert(raw, now);
      if (!item) { invalid++; return; }
      var end = Number(raw.couponEndTime || raw.endTime || 0);
      if ((end > 0 && (end < 1e12 ? end * 1000 : end) <= now) || now - item.ts > ALERT_STALE_MS) { expired++; return; }
      if (seen[item.id]) { duplicates++; return; }
      seen[item.id] = 1;
      valid.push(item);
    });
    var existing = Object.create(null);
    alerts().forEach(function (item) { if (item && item.id != null) existing[String(item.id)] = 1; });
    var existingDuplicates = valid.filter(function (item) { return existing[item.id]; }).length;
    return {
      ok: valid.length > 0, alerts: valid, valid: valid.length, invalid: invalid, duplicates: duplicates,
      existingDuplicates: existingDuplicates, expired: expired, overflow: Math.max(0, valid.length - ALERT_MAX),
      msg: valid.length ? '' : '没有可导入的有效订阅记录',
    };
  }

  function importAlerts(text, mode) {
    if (mode !== 'merge' && mode !== 'replace') return { ok: false, msg: '请选择合并或替换模式' };
    var preview = previewAlerts(text);
    if (!preview.ok) return { ok: false, msg: preview.msg };
    var current = alerts(), next = mode === 'replace' ? [] : current.slice();
    var seen = Object.create(null);
    next.forEach(function (item) { if (item && item.id != null) seen[String(item.id)] = 1; });
    preview.alerts.forEach(function (item) {
      if (seen[item.id]) return;
      next.push(item);
      seen[item.id] = 1;
    });
    next = next.slice(0, ALERT_MAX);
    if (!lsSet(K_ALERT, next)) return { ok: false, msg: '浏览器禁止本地存储或空间不足，订阅清单未修改' };
    return { ok: true, added: next.length - Math.min(current.length, ALERT_MAX), total: next.length, mode: mode };
  }

  function syncAlert(action, item) {
    var dev = global.Tracker && global.Tracker.visitorId ? global.Tracker.visitorId() : '';
    if (!dev) return;
    var url = (action === 'subscribe' ? '/api/v1/front/coupon/alert/subscribe' : '/api/v1/front/coupon/alert/unsubscribe');
    // sourceGuard 对 /api/v1/front/coupon/ 全量要求携带 mainUrl，否则按「未登记来源」置空（订阅/退订静默失败并刷 P1）
    url += '?mainUrl=' + encodeURIComponent(MAIN_URL);
    try {
      global.fetch(API_BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: dev, tao_id: String(item.id), platform: (item.platform || 'jd'),
          title: item.t || '',
          baseline: { price: Number(item.price) || 0, quota: Number(item.quota) || 0, couponDiscount: Number(item.off) || 0 },
        }),
      }).catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 到期/大额提醒引导：公众号（服务号）网页授权订阅（web-push / 带参小程序码均已退役） ---------------- */
  var RS_ID = 'coupon-remind-modal';
  var rsKeyHandler = null;

  function oaConfigUrl(type) {
    return API_BASE + '/api/v1/front/coupon/oa/config?type=' + encodeURIComponent(type || 'expiry') +
      '&mainUrl=' + encodeURIComponent(MAIN_URL);
  }
  function oaSubscribeUrl() {
    return API_BASE + '/api/v1/front/coupon/oa/subscribe?mainUrl=' + encodeURIComponent(MAIN_URL);
  }
  function fetchJson(url) {
    return global.fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return (j && j.data) || {}; });
  }
  function postJson(url, body) {
    return global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return (j && j.data) || {}; });
  }

  function closeRemindModal() {
    var m = doc.getElementById(RS_ID);
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (rsKeyHandler) { doc.removeEventListener('keydown', rsKeyHandler); rsKeyHandler = null; }
  }
  // 通用提示弹窗（标题 + 说明 + 可选服务号关注二维码）
  function openRemindModal(titleText, subText, qrImg) {
    closeRemindModal();
    var mask = doc.createElement('div'); mask.className = 'rs-mask'; mask.id = RS_ID;
    var card = doc.createElement('div'); card.className = 'rs-card';
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    var title = doc.createElement('div'); title.className = 'rs-title'; title.textContent = titleText;
    var sub = doc.createElement('p'); sub.className = 'rs-sub'; sub.textContent = subText;
    card.appendChild(title); card.appendChild(sub);
    if (qrImg) {
      var img = doc.createElement('img'); img.className = 'rs-img'; img.src = qrImg;
      img.alt = '服务号关注二维码'; img.width = 180; img.height = 180; img.referrerPolicy = 'no-referrer';
      card.appendChild(img);
    }
    var closeBtn = doc.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'rs-close'; closeBtn.textContent = '我知道了';
    card.appendChild(closeBtn);
    mask.appendChild(card);
    doc.body.appendChild(mask);
    rsKeyHandler = function (e) { if (e.key === 'Escape') closeRemindModal(); };
    doc.addEventListener('keydown', rsKeyHandler);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeRemindModal(); });
    closeBtn.addEventListener('click', closeRemindModal);
  }

  // 微信内置浏览器判定：仅微信内可发起服务号网页授权、长按识别二维码
  function isWeixin() {
    return /MicroMessenger|WeChat/i.test((global.navigator && global.navigator.userAgent) || '');
  }

  // 发起服务号网页授权（snsapi_base 静默授权）：回跳当前页并带 code & oa_type
  function startOaAuth(appId, type) {
    var redirect = global.location.origin + global.location.pathname + '?oa_type=' + encodeURIComponent(type);
    var url = 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + encodeURIComponent(appId) +
      '&redirect_uri=' + encodeURIComponent(redirect) + '&response_type=code&scope=snsapi_base&state=oa#wechat_redirect';
    global.location.href = url;
  }

  // 点「到期/大额提醒」：探测 OA 通道 → 已开放则发起网页授权；未开放 / 缺 appid 则文案引导（未关注二维码由回调分支展示）
  function showRemindGuide() {
    var type = 'expiry';
    fetchJson(oaConfigUrl(type)).then(function (cfg) {
      if (!cfg || !cfg.enabled) { openRemindModal('提醒暂未开放', '公众号到期/大额提醒暂未开通，可先前往榜单浏览在券好物。'); return; }
      // 非微信环境：跳服务号网页授权无效 → 直接展示关注二维码，引导用微信「扫一扫」关注后进公众号开启
      if (!isWeixin()) { openRemindModal('在微信里开启到期提醒', '当前不在微信内，无法一键授权。请使用微信「扫一扫」扫描下方二维码关注服务号；关注后在公众号里回复「提醒」，或点底部菜单「优惠券 → 我的提醒」，即可开启券到期提醒，届时券到期会通过服务号消息直达本站详情页。', cfg.qr); return; }
      if (!cfg.appId) { openRemindModal('请在微信内开启提醒', '请在微信中打开本页面并关注服务号，即可开启到期/大额券提醒。', cfg.qr); return; }
      startOaAuth(cfg.appId, type);
    }).catch(function () { openRemindModal('网络异常', '暂时无法连接提醒服务，请稍后再试。'); });
  }

  // 网页授权回跳处理：命中 code(+state=oa/oa_type) → 服务端换公众号 openid 订阅；未关注展示关注二维码
  function handleOaCallback(code, type) {
    postJson(oaSubscribeUrl(), { code: code, type: type }).then(function (res) {
      if (res && res.needFollow) {
        openRemindModal('还差一步：关注服务号', '长按识别下方二维码关注服务号，关注后回复「提醒」或回到本页再次点击「开启提醒」，即可接收到期/大额券直达提醒。', res.qr);
      } else {
        openRemindModal('提醒已开启', '到期/大额券提醒已开启，届时服务号会发送消息并直达本站券详情页，无需再做任何操作。');
      }
    }).catch(function () { openRemindModal('开启失败', '订阅失败，请稍后再试。'); });
  }

  // 点「到期/大额提醒」：记入本机清单（供 /my-alerts.html 降价高亮）+ 走 OA 订阅引导
  function remindNow(item) {
    try { if (item && item.id && !isAlert(item.id)) toggleAlert(item); } catch (e) { /* 忽略 */ }
    showRemindGuide(item);
  }

  // 把「到期提醒」按钮挂到券卡价格行（点击 → 公众号网页授权订阅引导）
  function attachAlert(cardEl, item) {
    if (!cardEl || !item || !item.id) return;
    var price = cardEl.querySelector ? cardEl.querySelector('.cp-price') : null;
    if (!price) return;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-alert';
    btn.textContent = '到期提醒';
    btn.setAttribute('aria-label', '订阅该券的到期/大额提醒（公众号消息直达本站）');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      remindNow(item);
      if (global.Conv) global.Conv.track('alert_guide_view', { coupon_id: String(item.id) });
    });
    price.appendChild(btn);
  }

  /* ------------------------------ 券卡星标 ------------------------------ */
  function syncStar(btn, on) {
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? '取消收藏' : '收藏该券');
    btn.setAttribute('title', on ? '取消收藏' : '收藏该券');
    btn.classList.toggle('is-on', on);
  }

  // 给券卡（<a class="cp-card">）包一层 .cp-cell 并附加收藏星标
  function attachStar(cardEl, item) {
    if (!cardEl || cardEl.parentElement && cardEl.parentElement.classList.contains('cp-cell')) return;
    if (!item || !item.id) return;
    var cell = doc.createElement('div');
    cell.className = 'cp-cell';
    cardEl.parentNode.insertBefore(cell, cardEl);
    cell.appendChild(cardEl);
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-star';
    btn.setAttribute('data-track', 'fav_toggle');
    syncStar(btn, isFav(item.id));
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      syncStar(btn, toggleFav(item));
    });
    cell.appendChild(btn);
    // 分享按钮（M4）：与星标并列，缺 CouponShare 时静默跳过
    if (global.CouponShare && global.CouponShare.attach) {
      try { global.CouponShare.attach(cell, item); } catch (e) { /* 忽略 */ }
    }
    // 到期/大额提醒按钮（M2）：挂到券卡价格行内联
    if (global.CouponStore && global.CouponStore.attachAlert) {
      try { global.CouponStore.attachAlert(cell, item); } catch (e) { /* 忽略 */ }
    }
  }

  // 增强页面里已存在的静态券卡（构建期预渲染产物），运行时卡由各自脚本直接 attachStar
  function enhance(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.cp-card');
    Array.prototype.forEach.call(cards, function (a) {
      if (a.closest && a.closest('.cp-cell')) return;
      attachStar(a, itemFromCard(a));
    });
  }

  // 网页授权回跳自动处理：命中 code + (state=oa 或 oa_type) 即完成订阅并清理 URL（code 一次性、防刷新重放）
  function initOaCallback() {
    try {
      var p = new URLSearchParams(global.location.search || '');
      var code = p.get('code');
      if (!code) return;
      var state = p.get('state');
      var oaType = p.get('oa_type');
      if (state !== 'oa' && !oaType) return; // 非本流程授权回跳，交还其它逻辑
      var type = oaType === 'bigAmount' ? 'bigAmount' : 'expiry';
      p.delete('code'); p.delete('state'); p.delete('oa_type'); p.delete('appid');
      var qs = p.toString();
      var clean = global.location.pathname + (qs ? ('?' + qs) : '') + (global.location.hash || '');
      if (global.history && global.history.replaceState) global.history.replaceState(null, '', clean);
      handleOaCallback(code, type);
    } catch (e) { /* 忽略 */ }
  }

  // 非微信环境：站内底部轻量关注引导条（列表/详情页通用，本函数注入；my-alerts 已有内联卡故跳过；可关闭并记忆）
  function mountFollowBanner() {
    if (isWeixin()) return;
    try { if (global.localStorage.getItem('coupon_oa_banner') === '1') return; } catch (e) { /* 无痕忽略 */ }
    if (/my-alerts/i.test(global.location.pathname || '')) return;
    fetchJson(oaConfigUrl('expiry')).then(function (cfg) {
      if (!cfg || !cfg.enabled || !cfg.qr) return;
      if (doc.getElementById('oaBanner')) return;
      var bar = doc.createElement('div'); bar.className = 'oa-banner'; bar.id = 'oaBanner';
      var img = doc.createElement('img'); img.className = 'oa-banner-qr'; img.alt = '服务号关注二维码'; img.referrerPolicy = 'no-referrer'; img.src = cfg.qr;
      var txt = doc.createElement('div'); txt.className = 'oa-banner-txt';
      var strong = doc.createElement('strong'); strong.textContent = '开启券到期提醒';
      var span = doc.createElement('span'); span.textContent = '微信「扫一扫」关注服务号，关注后回复「提醒」即可开启到期/大额券直达提醒（手机可先截图再到微信里识别）。';
      txt.appendChild(strong); txt.appendChild(span);
      var cta = doc.createElement('button'); cta.type = 'button'; cta.className = 'btn btn-sm oa-banner-cta'; cta.textContent = '如何开启';
      cta.addEventListener('click', function () { showRemindGuide(); });
      var close = doc.createElement('button'); close.type = 'button'; close.className = 'oa-banner-close'; close.setAttribute('aria-label', '关闭'); close.textContent = '\u00d7';
      close.addEventListener('click', function () { try { global.localStorage.setItem('coupon_oa_banner', '1'); } catch (e) { /* 忽略 */ } if (bar.parentNode) bar.parentNode.removeChild(bar); });
      bar.appendChild(img); bar.appendChild(txt); bar.appendChild(cta); bar.appendChild(close);
      doc.body.appendChild(bar);
    }).catch(function () { /* 静默失败：不打扰 */ });
  }

  function boot() {
    Array.prototype.forEach.call(doc.querySelectorAll('.cp-grid'), enhance);
    // 点击券卡 = 视为「看过」，写最近看过快照（星标按钮在 a 外，不会误触）
    doc.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('.cp-card') : null;
      if (!a) return;
      if (a.getAttribute('href') === '#' || !a.getAttribute('href')) return;
      pushRecent(itemFromCard(a));
    });
    initOaCallback();
    mountFollowBanner();
  }

  global.CouponStore = {
    favs: favs, isFav: isFav, toggleFav: toggleFav, removeFav: removeFav, clearFavs: clearFavs,
    exportFavs: exportFavs, importFavs: importFavs,
    exportSyncCode: exportSyncCode, importSyncCode: importSyncCode,
    recent: recent, pushRecent: pushRecent, removeRecent: removeRecent, clearRecent: clearRecent,
    searches: searches, pushSearch: pushSearch, clearSearches: clearSearches,
    recommendTerms: recommendTerms, seenIds: seenIds,
    alerts: alerts, isAlert: isAlert, toggleAlert: toggleAlert, attachAlert: attachAlert,
    exportAlerts: exportAlerts, previewAlerts: previewAlerts, importAlerts: importAlerts, ALERT_MAX: ALERT_MAX,
    showRemindGuide: showRemindGuide, remindNow: remindNow,
    isWeixin: isWeixin, fetchOaConfig: function (type) { return fetchJson(oaConfigUrl(type || 'expiry')); },
    itemFromCard: itemFromCard, attachStar: attachStar, enhance: enhance,
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

/* ==== coupon-page.js ==== */
/* ==========================================================================
   coupon-page.js · 小满券仓领券中心页交互（coupon.zangeng.com）
   —— 动态请求后端优惠券接口（当前数据源京东，京东 / 淘宝等多平台可后续接入），支持：每日精选（手选池）、日/周/月榜单、关键词搜索 + 分页加载更多。
   所有请求携带 mainUrl，经后端 sourceGuard 放行（本站域须已登记，见 main-api scripts/register-static-projects.js）。
   静默失败：接口异常 / 空数据都不报错，给出友好空态（并提供「重试」）。

   健壮性（C3）：AbortController 超时 + 自增 token 丢弃过期响应（防切 tab/搜索乱序覆盖）+ 同参短时内存缓存。
   曝光埋点（C2）：券卡带 data-case，由 conversion.js 观察视口产出「曝光→点击」归因。
   防 CLS（C4）：卡片图带 width/height，配合 coupon.css 的 aspect-ratio 占位。
   排序透出（C8）：默认按「省钱力度」（券面额 + 折扣率）重排，兼顾券面额 / 到手价客户端排序（低成本，不改后端分页语义）。
   本地功能：券卡收藏星标 + 骨架屏加载态；?s=关键词 直达搜索；搜索历史由 store.js 落 localStorage。
   ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';
  var PAGE_SIZE = 20;
  // 榜单后端单次上限 100（服务端 cap），一次取满后前端本地分页，避免依赖后端不存在的 page 参数
  var RANK_LIMIT = 100;
  var TIMEOUT_MS = 12000;   // 单请求超时，超时中断并给出可重试错误态
  var CACHE_TTL = 30000;    // 同参结果短时内存缓存（切 tab 回来不重复打后端）
  var SEARCH_PAGE_SIZE = 100; // 搜索一次取满（后端上限 100），本地按相关性重排后分页
  var Q = window.CouponQuality || {};
  function cleanResult(arr, opts) { return (Q.cleanList || function (a) { return a || []; })(arr, opts); }
  function dedupeResult(arr) { return (Q.dedupe || function (a) { return a || []; })(arr); }

  var state = {
    mode: 'rank', period: 'week', search: '', page: 1, hasMore: false, loading: false,
    sort: '', platform: '', price: '', disc: '', category: '',
    list: [], rankAll: [], rankShown: 0, searchAll: [], searchShown: 0
  };

  var grid, statusEl, moreBtn, tabs, searchForm, searchInput, sortSelect;
  var recGrid, recSection;
  var loadActions = {}; // name -> function，供错误态「重试」复用最近一次加载动作

  // 短时内存缓存：url -> { t, data }
  var memCache = {};
  // 竞态令牌：每次触发一次「视图级」加载就自增，回调仅当令牌仍为最新时才落 DOM
  var viewToken = 0;
  // 已缓存热搜词（loadHotWords 填充），供输入联想子串匹配
  var hotWords = [];

  var doc = global.document; // 本模块多处用裸 doc 建 DOM（Top10/热搜词/氛围条/sparkline），口径同 drops-page.js/detail-page.js
  function $(id) { return global.document.getElementById(id); }

  // 构建期快照：后端不可达时回退渲染最近一次成功取到的券（data/coupon-snapshot.json，nginx 已放行）
  var snapshotCache = null;
  var snapshotLoading = false;
  function loadSnapshot(done) {
    if (snapshotCache) { done(snapshotCache); return; }
    if (snapshotLoading) { return; }
    snapshotLoading = true;
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, TIMEOUT_MS);
    global.fetch('/data/coupon-snapshot.json', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) { global.clearTimeout(timer); snapshotCache = json || {}; done(snapshotCache); })
      .catch(function () { global.clearTimeout(timer); done(null); });
  }

  // 快照更新时间戳（兜底时告知用户数据有多旧）
  function snapStamp(snap) {
    try {
      var t = snap && snap.updatedAt ? new Date(snap.updatedAt) : null;
      if (!t || isNaN(t.getTime())) return '';
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
    } catch (e) { return ''; }
  }

  // 券到期时间解析：兼容时间戳（秒/毫秒）与日期字符串；解析不出返回 0
  function endMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    var s = String(v).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) { var n = Number(s); return s.length >= 12 ? n : n * 1000; }
    var t = Date.parse(s.replace(/\.\d+/, '').replace(/-/g, '/'));
    return isNaN(t) ? 0 : t;
  }
  // 即将失效文案（3 天内）；无到期时间 / 已过期返回 ''
  function expireLabel(c) {
    var ms = endMs(c && c.couponEndTime);
    if (!ms) return '';
    var diff = ms - Date.now();
    if (diff <= 0) return '';
    var d = Math.ceil(diff / 86400000);
    return d <= 1 ? '即将到期' : (d + '天后失效');
  }

  // 即将失效排序权重（需求 4）：有未来到期时间者按到期早晚升序（越早越前）；无到期/已过期一律排最后。
  // 与 list-page.js 同口径。
  function expireRank(c) {
    var ms = endMs(c && c.couponEndTime);
    return (ms && ms > Date.now()) ? ms : Number.MAX_SAFE_INTEGER;
  }

  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  function buildUrl(path, params) {
    var qs = [];
    params.forEach(function (p) { if (p[1] !== undefined && p[1] !== null && p[1] !== '') qs.push(p[0] + '=' + encodeURIComponent(p[1])); });
    qs.push('mainUrl=' + encodeURIComponent(MAIN_URL));
    return API_BASE + PREFIX + path + '?' + qs.join('&');
  }

  function cacheGet(url) {
    var c = memCache[url];
    if (c && (Date.now() - c.t) < CACHE_TTL) return c.data;
    return null;
  }

  /**
   * 带超时与内存缓存的请求（C3）
   * @param {string} url
   * @param {Function} done - (err, data)
   * @param {Object} [o] - { cache:boolean } cache=true 时命中/写入短时内存缓存
   */
  function request(url, done, o) {
    o = o || {};
    if (o.cache) {
      var hit = cacheGet(url);
      if (hit) { done(null, hit); return; }
    }
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, TIMEOUT_MS);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    global.fetch(url, opts)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) {
        global.clearTimeout(timer);
        var d = (json && json.data) || {};
        if (o.cache) memCache[url] = { t: Date.now(), data: d };
        done(null, d);
      })
      .catch(function (err) { global.clearTimeout(timer); done(err, null); });
  }

  // 归一各接口返回的数组：random→{data:[]}, rank→{list:[]}, paging→{list:[]}
  function pickList(d) {
    if (!d) return [];
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.list)) return d.list;
    if (Array.isArray(d)) return d;
    return [];
  }

  function el(tag, cls, text) {
    var e = global.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 客户端排序（C8）：不改动后端分页/榜单语义，仅对已加载集合重排
  // value（省钱力度）与构建期 build.js sortByValue 同口径：分数 = 券面额 + 折扣率×100，同分按到手价低者前
  function saveScore(c) {
    var off = Number(c.couponDiscount) || 0;
    var price = Number(c.price) || 0;
    return off > 0 ? off + (off / (price + off)) * 100 : 0;
  }

  function sortList(list) {
    if (!state.sort) return list;
    var arr = list.slice();
    if (state.sort === 'value') arr.sort(function (a, b) { var d = saveScore(b) - saveScore(a); return d !== 0 ? d : ((Number(a.price) || 0) - (Number(b.price) || 0)); });
    else if (state.sort === 'discount') arr.sort(function (a, b) { return (Number(b.couponDiscount) || 0) - (Number(a.couponDiscount) || 0); });
    else if (state.sort === 'expire') arr.sort(function (a, b) { return expireRank(a) - expireRank(b); });
    else if (state.sort === 'priceAsc') arr.sort(function (a, b) { return (Number(a.price) || 0) - (Number(b.price) || 0); });
    else if (state.sort === 'priceDesc') arr.sort(function (a, b) { return (Number(b.price) || 0) - (Number(a.price) || 0); });
    return arr;
  }

  // 平台筛选（数据带 platform 后才显示；京东/淘宝来源由中台归并时注入）
  function filterPlat(list) {
    if (!state.platform) return list;
    return list.filter(function (c) { return (c.platform || 'jd') === state.platform; });
  }
  function matchPrice(c) {
    if (!state.price) return true;
    var p = Number(c.price) || 0;
    if (state.price === 'lt50') return p < 50;
    if (state.price === 'p50_100') return p >= 50 && p < 100;
    if (state.price === 'p100_300') return p >= 100 && p < 300;
    if (state.price === 'gt300') return p >= 300;
    return true;
  }
  function matchDiscount(c) {
    if (!state.disc) return true;
    var off = Number(c.couponDiscount) || 0;
    var quota = Number(c.couponQuota) || 0;
    var rate = quota > 0 ? (off / quota) * 100 : 0;
    if (state.disc === 'ge50') return rate >= 50;
    if (state.disc === 'd20_50') return rate >= 20 && rate < 50;
    if (state.disc === 'lt20') return rate < 20 || quota <= 0;
    return true;
  }
  var CAT_KW = {
    digital: '手机', appliance: '家电', home: '收纳', beauty: '面霜', baby: '儿童', food: '零食',
    apparel: '女装', pet: '猫粮', pc: '笔记本', audio: '耳机', kitchen: '电饭煲', furniture: '书桌',
    outdoor: '跑步', shoes: '运动鞋', bags: '双肩包', auto: '车载', stationery: '打印',
    medicine: '保健', game: '游戏', laundry: '洗衣液', 'gaming-chair': '电脑椅'
  };
  function matchCategory(c) {
    if (!state.category) return true;
    var kw = CAT_KW[state.category] || state.category;
    var text = String(c.title || '') + ' ' + String(c.category || '') + ' ' + String(c.keywords || '');
    return text.indexOf(kw) >= 0;
  }
  function applyFilters(list) {
    return list.filter(matchPrice).filter(matchDiscount).filter(matchCategory);
  }
  function currentView() { return sortList(applyFilters(filterPlat(state.list))); }
  function searchView() { return applyFilters(filterPlat(state.searchAll)).slice(0, state.searchShown); }
  function updateSearchMore() {
    if (!moreBtn || state.mode !== 'search') return;
    var left = applyFilters(filterPlat(state.searchAll)).length - state.searchShown;
    moreBtn.hidden = left <= 0;
    moreBtn.textContent = '加载更多';
  }

  // 猜你喜欢（M1）：基于本地 recent + searches 信号，对 /random 池做子串匹配重排
  function tokenizeTerm(term) {
    var out = [];
    var t = String(term || '').trim().toLowerCase();
    if (!t) return out;
    out.push(t);
    var cjk = t.replace(/[a-z0-9\s]/gi, '');
    for (var i = 0; i + 2 <= cjk.length; i++) out.push(cjk.slice(i, i + 2)); // CJK 二元分词
    return out;
  }
  function buildTermScores(terms) {
    var map = {};
    terms.forEach(function (term) {
      tokenizeTerm(term).forEach(function (tok) {
        if (tok.length < 2) return;
        map[tok] = (map[tok] || 0) + 1;
      });
    });
    return map;
  }
  function matchScore(title, tokenMap) {
    var t = String(title || '').toLowerCase();
    var s = 0;
    for (var tok in tokenMap) { if (t.indexOf(tok) >= 0) s += tokenMap[tok]; }
    return s;
  }

  /* ---------------- WO-189 P3 · 协同过滤二阶召回（可选离线产物） ----------------
     data/cooccurrence.json 由 scripts/train-cooccurrence.js 从真实 device-events 训练得到。
     硬约束：产物缺失 / enabled=false / sampleCount < CO_MIN_SAMPLES → 显式「样本不足则不启用」，
     现行 /recommend + /random 内容召回 + 重排兜底链完全不变。
     启用时：用 seenIds() 作种子做二阶召回（种子 → 共现邻居），只从已获取的真实券池解析成卡片，
     与内容召回结果合并去重；绝不凭空生成券对象或点击数据。 */
  var CO_URL = '/data/cooccurrence.json';
  var CO_MIN_SAMPLES = 50;
  var CO_TIMEOUT_MS = 2500;
  var coState = { status: 'idle', data: null, waiters: [] };
  var coPool = Object.create(null); // id(tao_id/_id) -> 真实券对象

  function loadCooccurrence(done) {
    if (coState.status === 'done') { done(coState.data); return; }
    if (coState.status === 'loading') { coState.waiters.push(done); return; }
    if (!global.fetch) { coState.status = 'done'; coState.data = null; done(null); return; }
    coState.status = 'loading';
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, CO_TIMEOUT_MS);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    global.fetch(CO_URL, opts)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) { coState.data = (json && typeof json === 'object') ? json : null; })
      .catch(function () { coState.data = null; })
      .then(function () {
        global.clearTimeout(timer);
        coState.status = 'done';
        var ws = coState.waiters.slice(); coState.waiters.length = 0;
        for (var i = 0; i < ws.length; i++) ws[i](coState.data);
      });
  }

  // 显式判定：产物缺失 / 训练侧标记禁用 / 样本量不足 → 不启用（保持现行链）
  function cooccurrenceEnabled(co) {
    if (!co || co.enabled === false) return false;
    var n = Number(co.sampleCount) || 0;
    if (n < CO_MIN_SAMPLES) return false;
    var m = co.cooccurrence;
    return !!(m && typeof m === 'object' && Object.keys(m).length);
  }

  function indexPool(list) {
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c) return;
      [ c.tao_id, c._id ].forEach(function (k) {
        var id = String(k || '');
        if (id && !coPool[id]) coPool[id] = c;
      });
    });
  }

  // 二阶召回：seed(seenIds) → 共现邻居（按权重聚合）→ 在真实券池里解析出券对象
  function coRecall(seen, co, baseList, limit) {
    var seeds = Object.keys(seen || {});
    if (!seeds.length) return [];
    var scores = Object.create(null);
    seeds.forEach(function (seed) {
      var row = co.cooccurrence[seed];
      if (!row || typeof row !== 'object') return;
      Object.keys(row).forEach(function (nid) {
        if (!nid || nid === seed) return;
        var w = Number(row[nid]) || 0;
        if (w > 0) scores[nid] = (scores[nid] || 0) + w;
      });
    });
    var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a] || a.localeCompare(b); });
    var taken = Object.create(null);
    (baseList || []).forEach(function (c) {
      var a = String(c.tao_id || c._id || ''), b = String(c._id || '');
      if (a) taken[a] = 1;
      if (b) taken[b] = 1;
    });
    seeds.forEach(function (s) { taken[s] = 1; }); // 已看过的不再推
    var out = [];
    for (var i = 0; i < ranked.length && out.length < limit; i++) {
      var id = ranked[i];
      if (taken[id]) continue;
      var c = coPool[id];
      if (!c) continue; // 只召回真实券池里存在的 id，不编造卡片
      taken[id] = 1;
      out.push(c);
    }
    return out;
  }

  // 现行内容召回结果先原样渲染（不因共现产物延迟），随后仅在「有样本且启用」时追加合并去重
  function finalizeRecommend(list, terms, seen) {
    indexPool(list);
    renderRecommend(list);
    loadCooccurrence(function (co) {
      var st = state.co || (state.co = {});
      st.sampleCount = co ? (Number(co.sampleCount) || 0) : 0;
      st.minSamples = CO_MIN_SAMPLES;
      st.enabled = cooccurrenceEnabled(co);
      st.reason = !co ? '产物不存在' : (co.enabled === false ? '产物标记 enabled=false'
        : (st.sampleCount < CO_MIN_SAMPLES ? '样本不足则不启用' : ''));
      if (!st.enabled) return; // 显式：样本不足则不启用，现行结果不再改动
      var extra = coRecall(seen, co, list, 4);
      if (!extra.length) return;
      renderRecommend(list.concat(extra).slice(0, 14));
    });
  }

  function loadRecommend() {
    if (!recGrid || !recSection || !global.CouponStore) return;
    var terms = global.CouponStore.recommendTerms();
    if (!terms.length) { recSection.hidden = true; return; }
    var seen = global.CouponStore.seenIds();
    var seenStr = Object.keys(seen).join(',');
    indexPool(state.list); indexPool(state.rankAll);
    loadCooccurrence(function () {}); // WO-189 P3：并行预热共现产物（缺省静默降级）
    // 首选后端召回（全手选池内容召回 + 热度）；失败或空则回落本地 /random 重排兜底
    var rUrl = buildUrl('/recommend', [ [ 'terms', terms.slice(0, 8).join(',') ], [ 'seen', seenStr ], [ 'limit', 10 ] ]);
    request(rUrl, function (err, d) {
      var list = err ? [] : pickList(d);
      if (list.length) { finalizeRecommend(list, terms, seen); return; }
      recommendFallback(terms, seen);
    }, { cache: true });
  }

  // 本地兜底：命中后端失败/空时，沿用原「/random 50 池 + 子串匹配重排」
  function recommendFallback(terms, seen) {
    var tokenMap = buildTermScores(terms);
    var url = buildUrl('/random', [ [ 'limit', 50 ] ]);
    request(url, function (err, d) {
      if (err) { recSection.hidden = true; return; }
      var scored = [];
      var pool = pickList(d);
      indexPool(pool); // WO-189 P3：把 /random 真实券池登记进候选池，供共现邻居解析
      pool.forEach(function (c) {
        var cid = String(c.tao_id || c._id || '');
        if (seen[cid]) return;
        var s = matchScore(c.title || '', tokenMap);
        if (s <= 0) return;
        scored.push({ c: c, s: s });
      });
      scored.sort(function (a, b) { return b.s - a.s; });
      var top = scored.slice(0, 10).map(function (x) { return x.c; });
      if (!top.length) { recSection.hidden = true; return; }
      finalizeRecommend(top, terms, seen);
    }, { cache: true });
  }

  function renderRecommend(top) {
    if (!top || !top.length) { recSection.hidden = true; return; }
    recSection.hidden = false;
    recGrid.innerHTML = '';
    top.forEach(function (c) { var card = buildCard(c); recGrid.appendChild(card); attachStar(card, c); });
    if (global.Conv && global.Conv.reobserve) global.Conv.reobserve();
  }

  // 热搜词（M6）：服务端 Redis zset 计数 TopN，渲染「大家都在搜」+ 供输入联想复用
  // 取 30 条缓存进 hotWords（联想用），「大家都在搜」仅展示前 8 条
  function loadHotWords() {
    var box = $('cpHotWords');
    var url = buildUrl('/hotwords', [ [ 'limit', 30 ] ]);
    request(url, function (err, d) {
      if (err) return;
      var list = (d && d.list) || [];
      hotWords = list.map(function (h) { return (h && h.word) || ''; }).filter(Boolean);
      if (!box) return;
      if (!hotWords.length) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '';
      hotWords.slice(0, 8).forEach(function (word) {
        var a = doc.createElement('button');
        a.type = 'button'; a.className = 'cp-his-chip';
        a.textContent = word;
        a.setAttribute('data-track', 'coupon_search');
        a.setAttribute('data-track-props', JSON.stringify({ type: 'hotword', word: word }));
        a.addEventListener('click', function () { applySearch(word); });
        box.appendChild(a);
      });
    }, { cache: true });
  }

  // 统一「选词即搜」入口：回填输入框 + 记历史 + 触发搜索（热搜词 chip / 输入联想 / URL 直达共用）
  function applySearch(word) {
    word = String(word || '').trim();
    if (!word) return;
    state.search = word;
    if (searchInput) searchInput.value = word;
    setActiveTab('');
    if (global.CouponStore) global.CouponStore.pushSearch(word);
    loadSearch(true);
    renderHistory();
    hideSuggest();
  }

  /* ---------------- 输入联想（需求 4）：输入时按子串匹配已缓存热搜词，下拉候选可点选 ---------------- */
  var suggestBox = null;
  function ensureSuggestBox() {
    if (suggestBox || !searchForm) return suggestBox;
    suggestBox = el('div', 'cp-suggest');
    suggestBox.setAttribute('role', 'listbox');
    suggestBox.setAttribute('aria-label', '搜索联想');
    suggestBox.hidden = true;
    // 相对定位挂到搜索表单下（表单已有 .cp-search 样式；无则退回 body 末尾）
    searchForm.style.position = 'relative';
    searchForm.appendChild(suggestBox);
    // mousedown 早于 input blur，用 mousedown 选中避免下拉先收起
    suggestBox.addEventListener('mousedown', function (e) {
      var b = e.target.closest ? e.target.closest('.cp-suggest-item') : null;
      if (b) { e.preventDefault(); applySearch(b.getAttribute('data-word')); }
    });
    return suggestBox;
  }

  function hideSuggest() { if (suggestBox) suggestBox.hidden = true; }

  function renderSuggest(term) {
    var box = ensureSuggestBox();
    if (!box) return;
    term = String(term || '').trim().toLowerCase();
    if (!term || !hotWords.length) { box.hidden = true; box.innerHTML = ''; return; }
    // 子串匹配优先（含输入即命中），不足再补前缀无关的热词，最多 8 条
    var hits = hotWords.filter(function (w) { return w.toLowerCase().indexOf(term) >= 0 && w.toLowerCase() !== term; });
    if (!hits.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = '';
    hits.slice(0, 8).forEach(function (w) {
      var it = el('button', 'cp-suggest-item', w);
      it.type = 'button';
      it.setAttribute('data-word', w);
      box.appendChild(it);
    });
    box.hidden = false;
  }

  function initSuggest() {
    if (!searchInput) return;
    ensureSuggestBox();
    var deb;
    searchInput.addEventListener('input', function () {
      global.clearTimeout(deb);
      deb = global.setTimeout(function () { renderSuggest(searchInput.value); }, 120);
    });
    searchInput.addEventListener('focus', function () { renderSuggest(searchInput.value); });
    searchInput.addEventListener('blur', function () { global.setTimeout(hideSuggest, 120); });
    searchInput.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideSuggest(); });
  }

  function parseProps(el) {
    try { return JSON.parse(el.getAttribute('data-track-props') || '{}'); } catch (e) { return null; }
  }

  // 历史低价走势（M7）：一页券卡一次批量取，画 sparkline 到价格行
  function loadPriceTrends(gridEl) {
    if (!gridEl) return;
    var cards = gridEl.querySelectorAll('a.cp-card[data-track-props]');
    var ids = [];
    for (var i = 0; i < cards.length; i++) {
      var p = parseProps(cards[i]);
      if (p && p.coupon_id) ids.push(p.coupon_id);
    }
    if (!ids.length) return;
    var url = buildUrl('/priceBatch', [ [ 'ids', ids.join(',') ] ]);
    request(url, function (err, d) {
      if (err) return;
      var map = (d && d.map) || {};
      for (var j = 0; j < cards.length; j++) {
        var pp = parseProps(cards[j]);
        if (!pp) continue;
        var series = map[pp.coupon_id];
        if (series && series.length >= 2) drawSpark(cards[j], series);
      }
    }, { cache: true });
  }

  function drawSpark(card, series) {
    var price = card.querySelector('.cp-price');
    if (!price || price.querySelector('.cp-spark')) return;
    var vals = series.map(function (s) { return Number(s.price) || 0; }).filter(Boolean);
    if (vals.length < 2) return;
    var w = 54, h = 16, pad = 2;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.setAttribute('class', 'cp-spark'); svg.setAttribute('aria-hidden', 'true');
    var pts = vals.map(function (v, i) {
      var x = pad + (w - 2 * pad) * (i / (vals.length - 1));
      var y = h - pad - (h - 2 * pad) * ((v - min) / span);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var poly = doc.createElementNS(ns, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', vals[vals.length - 1] <= vals[0] ? '#2bbf6a' : '#e4393c');
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);
    price.appendChild(svg);
  }

  // 平台展示名（chip 标签用）
  var PLATFORM_LABELS = { jd: '京东', taobao: '淘宝', pdd: '拼多多', douyin: '抖音', other: '其他' };
  function ensurePlatBar() {
    if ($('cpPlat')) return;
    var host = global.document.querySelector('.cp-toolbar');
    if (!host) return;
    var bar = el('div', 'cp-plat');
    bar.id = 'cpPlat';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '平台筛选');
    bar.hidden = true;
    host.appendChild(bar);
  }
  // chip 按已加载数据里真实出现的平台生成：
  // 旧实现写死 京东/淘宝/拼多多/抖音，数据单一平台时多数 chip 恒为 0 成「死入口」。
  // 现在只渲染确有数据的平台；单一平台时整条收起（筛选无意义，避免假条目误导）。
  function rebuildPlatBar() {
    var bar = $('cpPlat');
    if (!bar) return;
    var seen = {};
    state.list.forEach(function (c) { if (c) seen[c.platform || 'jd'] = 1; });
    var plats = Object.keys(seen);
    if (plats.length <= 1) { bar.hidden = true; bar.innerHTML = ''; return; }
    if (state.platform && !seen[state.platform]) state.platform = ''; // 选中平台已不在数据里 → 回「全部」
    bar.hidden = false;
    bar.innerHTML = '';
    [ [ '', '全部' ] ].concat(plats.map(function (p) { return [ p, PLATFORM_LABELS[p] || p ]; })).forEach(function (o) {
      var b = el('button', 'cp-plat-chip' + (state.platform === o[0] ? ' is-active' : ''), o[1]);
      b.type = 'button';
      b.setAttribute('data-plat', o[0]);
      b.addEventListener('click', function () {
        state.platform = o[0];
        Array.prototype.forEach.call(bar.children, function (x) { x.classList.toggle('is-active', x.getAttribute('data-plat') === o[0]); });
        if (!state.list.length) return;
        // 榜单：筛选后回到第一页（rankView 自带 slice，避免把 100 条一次铺满）
        if (state.mode === 'rank') {
          state.rankShown = Math.min(PAGE_SIZE, rankFiltered().length);
          render(rankView(), false);
          updateRankMore();
          return;
        }
        render(currentView(), false);
      });
      bar.appendChild(b);
    });
  }

  // 首页热门品类空探测：对带 data-kw 的品类 chip 发一个 pageSize=1 的轻量计数请求，
  // count 为 0（当前无券）则移除该 chip；请求失败静默保留，不误删。
  function probeCats() {
    var chips = global.document.querySelectorAll('.cp-cat-chip[data-kw]');
    Array.prototype.forEach.call(chips, function (chip) {
      var kw = chip.getAttribute('data-kw');
      if (!kw) return;
      var url = buildUrl('/paging', [ [ 'search', kw ], [ 'page', 1 ], [ 'pageSize', 1 ] ]);
      request(url, function (err, d) {
        if (err) return;
        var count = Number(d && d.count) || 0;
        if (count <= 0 && chip.parentNode) chip.parentNode.removeChild(chip);
      }, { cache: true });
    });
  }

  function buildCard(c) {
    var a = el('a', 'cp-card');
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url);
    a.href = link || '#';
    if (link) { a.target = '_blank'; a.setAttribute('rel', 'sponsored noopener'); }
    else { a.classList.add('is-dead'); a.setAttribute('aria-disabled', 'true'); }
    // 平台色描边（京东红 / 淘宝橙）供 CSS 区分
    a.setAttribute('data-plat', c.platform === 'taobao' ? 'taobao' : c.platform === 'pdd' ? 'pdd' : 'jd');
    // 超值 / 火爆 飘带（按券面额力度）
    var off = Number(c.couponDiscount) || 0;
    if (off >= 100) a.appendChild(el('span', 'cp-hot cp-hot--fire', '火爆'));
    else if (off >= 50) a.appendChild(el('span', 'cp-hot', '超值'));
    // 曝光埋点（C2）：data-case 供 conversion.js 视口观察；点击埋点保持 data-track
    var cid = String(c.tao_id || c._id || '');
    if (cid) a.setAttribute('data-case', 'coupon:' + cid);
    a.setAttribute('data-track', 'coupon_click');
    a.setAttribute('data-track-props', JSON.stringify({
      coupon_id: cid, title: c.title || '', mode: state.mode, period: state.mode === 'rank' ? state.period : '',
      exp: (global.__exp && global.__exp.bucket) || '',
    }));
    var imgSrc = safeUrl(c.pict_url);
    if (imgSrc) {
      var img = el('img');
      img.alt = c.title || '';
      img.width = 300;
      img.height = 300;
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.onerror = function () { img.parentNode && img.parentNode.removeChild(img); };
      img.src = imgSrc;
      a.appendChild(img);
    }
    a.appendChild(el('span', 'cp-name', c.title || '优惠券'));
    var price = el('div', 'cp-price');
    var quota = Number(c.couponQuota) || 0;
    if (off > 0) price.appendChild(el('span', 'cp-off', quota > 0 ? ('满' + quota + '减' + off) : ('立减¥' + off)));
    var finalPrice = Number(c.price) || 0;
    if (finalPrice > 0) price.appendChild(el('span', 'cp-final', '¥' + finalPrice));
    // 限时倒计时（couponEndTime 24h 内实时刷新）；否则展示即将失效文案
    var end = endMs(c.couponEndTime);
    if (end) {
      var diff = end - Date.now();
      if (diff > 0 && diff <= 86400000) {
        var cd = el('span', 'cp-countdown', '');
        cd.setAttribute('data-end', String(end));
        price.appendChild(cd);
        startCountdown();
      } else {
        var exLabel = expireLabel(c);
        if (exLabel) price.appendChild(el('span', 'cp-expire', exLabel));
      }
    }
    a.appendChild(price);
    return a;
  }

  // 限时倒计时：全站单一定时器，每秒刷新所有 .cp-countdown（couponEndTime 24h 内券卡）
  var countdownStarted = false;
  function startCountdown() {
    if (countdownStarted) return;
    countdownStarted = true;
    setInterval(function () {
      var now = Date.now();
      var nodes = global.document.querySelectorAll('.cp-countdown');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var end = Number(n.getAttribute('data-end')) || 0;
        var d = end - now;
        if (d <= 0) { n.textContent = '已结束'; n.classList.add('is-ended'); continue; }
        var p2 = function (x) { return (x < 10 ? '0' : '') + x; };
        var dd = Math.floor(d / 86400000);
        var hh = Math.floor((d % 86400000) / 3600000);
        var mm = Math.floor((d % 3600000) / 60000);
        var ss = Math.floor((d % 60000) / 1000);
        n.textContent = '⏱ ' + (dd > 0 ? (dd + '天 ') : '') + p2(hh) + ':' + p2(mm) + ':' + p2(ss);
      }
    }, 1000);
  }

  /* ---------------- W4 情报条 / 今日必抢 Top10 / 失效氛围条（本地对已加载数据估算，无埋点无 PII） ---------------- */
  var intel = { top10Done: false, moodTimer: 0 };

  function money(v) {
    v = Number(v) || 0;
    return v >= 10000 ? (Math.round(v / 100) / 100) + ' 万' : String(Math.round(v));
  }

  function renderIntelBar() {
    var bar = $('cpIntelBar');
    // 榜单走本地分页，情报条按全量统计（不受已展示条数影响）
    var src = (state.mode === 'rank' && state.rankAll.length) ? state.rankAll : state.list;
    if (!bar || !src.length) return;
    var sum = 0;
    src.forEach(function (c) { sum += Number(c.couponDiscount) || 0; });
    var n1 = $('cpIntelCount'), n2 = $('cpIntelSave');
    if (n1) n1.textContent = String(src.length);
    if (n2) n2.textContent = money(sum);
    bar.hidden = false;
  }

  // 与券卡同口径的跳转链（clickURL → couponUrl → item_url）
  function linkOf(c) {
    return safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) || '';
  }

  // Top10 分数：省钱力度 + 新鲜度加权（今日新增 +50），与 saveScore/build.js 同口径基础上叠加
  function topScore(c) {
    var s = saveScore(c);
    var ct = Number(c.createTime) || 0;
    if (ct && Date.now() - ct < 86400000) s += 50;
    return s;
  }

  // 今日必抢 Top10：两列榜单列表（排名徽章 + 标题 + 券力度 + 到手价），替代原先的横滑 chips
  function renderTop10() {
    var wrap = $('cpTop10Wrap'), box = $('cpTop10');
    if (!wrap || !box || intel.top10Done || state.list.length < 3) return;
    var top = state.list.slice().sort(function (a, b) { return topScore(b) - topScore(a); }).slice(0, 10);
    intel.top10Done = true;
    box.innerHTML = '';
    top.forEach(function (c, i) {
      var link = linkOf(c);
      if (!link) return;
      var a = doc.createElement('a');
      a.className = 'cp-top-item';
      a.href = link;
      a.target = '_blank';
      a.rel = 'sponsored noopener';
      a.setAttribute('role', 'listitem');
      a.setAttribute('data-track', 'top10_click');
      a.setAttribute('data-track-props', JSON.stringify({ pos: i + 1, coupon_id: String(c.tao_id || c._id || '') }));
      a.appendChild(el('span', 'cp-top-rank' + (i < 3 ? ' is-top' : ''), String(i + 1)));
      var body = el('span', 'cp-top-body');
      body.appendChild(el('span', 'cp-top-name', String(c.title || '优惠券')));
      var meta = el('span', 'cp-top-meta');
      var off = Number(c.couponDiscount) || 0, quota = Number(c.couponQuota) || 0;
      if (off > 0) meta.appendChild(el('span', 'cp-top-off', quota > 0 ? ('满' + quota + '减' + off) : ('立减¥' + off)));
      var price = Number(c.price) || 0;
      if (price > 0) meta.appendChild(el('span', 'cp-top-final', '¥' + price));
      body.appendChild(meta);
      a.appendChild(body);
      a.appendChild(el('span', 'cp-top-go', '›'));
      box.appendChild(a);
    });
    if (box.children.length) wrap.hidden = false;
  }

  // 临近失效氛围条：48h 内到期的券轮播（每 5s 一换），营造实时紧迫感；无则隐藏
  function renderMoodBar() {
    var bar = $('cpMoodBar');
    if (!bar) return;
    var soon = state.list.filter(function (c) {
      var ms = endMs(c.couponEndTime);
      return ms > Date.now() && ms - Date.now() < 48 * 3600000;
    }).sort(function (a, b) { return endMs(a.couponEndTime) - endMs(b.couponEndTime); }).slice(0, 8);
    clearInterval(intel.moodTimer);
    if (!soon.length) { bar.hidden = true; return; }
    var idx = 0;
    function show() {
      var c = soon[idx % soon.length];
      var hrs = Math.max(1, Math.round((endMs(c.couponEndTime) - Date.now()) / 3600000));
      bar.innerHTML = '';
      var a = doc.createElement('a');
      a.href = linkOf(c) || '#';
      if (linkOf(c)) { a.target = '_blank'; a.rel = 'sponsored noopener'; }
      a.setAttribute('data-track', 'mood_click');
      a.textContent = '⏰ 即将失效：' + String(c.title || '优惠券').slice(0, 20) + ' · 剩 ' + hrs + ' 小时';
      bar.appendChild(a);
      idx++;
    }
    show();
    bar.hidden = false;
    intel.moodTimer = setInterval(show, 5000);
  }

  function render(list, append) {
    rebuildPlatBar();
    if (!append) grid.innerHTML = '';
    if (!list.length) {
      if (!append) { showStatus('暂无优惠券，换个关键词或稍后再试。'); }
      return;
    }
    hideStatus();
    list.forEach(function (c) { var card = buildCard(c); grid.appendChild(card); attachStar(card, c); });
    // 动态新增的券卡带 data-case，通知归因层补观察（否则首屏 boot 时的 observer 覆盖不到）
    if (global.Conv && global.Conv.reobserve) global.Conv.reobserve();
    // W4：情报条 / Top10 / 氛围条（基于当前已加载集合，静默降级）
    try { renderIntelBar(); renderTop10(); renderMoodBar(); } catch (e) { /* 忽略 */ }
  }

  // 状态区（aria-live 已在 index.html 上声明），带错误态重试按钮
  function showStatus(text, retryFn) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.setAttribute('aria-busy', 'false');
    // 清除上一次残留的重试按钮
    var old = $('cpRetry');
    if (old) old.parentNode && old.parentNode.removeChild(old);
    if (retryFn) {
      var btn = el('button', 'btn btn-ghost cp-retry', '重试');
      btn.id = 'cpRetry';
      btn.type = 'button';
      btn.addEventListener('click', function () { retryFn(); });
      statusEl.appendChild(document.createElement('br'));
      statusEl.appendChild(btn);
    }
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.setAttribute('aria-busy', 'false');
    var old = $('cpRetry');
    if (old) old.parentNode && old.parentNode.removeChild(old);
  }

  // 后端不可达、用构建快照兜底时：灰化券卡 + 状态区加警示样式（快照券可能已失效，提示用户核对）
  function markStale(on) {
    if (grid) grid.classList.toggle('is-stale', !!on);
    if (statusEl) statusEl.classList.toggle('is-fallback', !!on);
  }

  // 收藏星标（store.js 提供）：包 .cp-cell + 按钮，运行时卡与预渲染卡同一套交互
  function attachStar(cardEl, c) {
    if (!global.CouponStore) return;
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url);
    var cid = String(c.tao_id || c._id || '') || link;
    if (!cid) return;
    global.CouponStore.attachStar(cardEl, {
      id: cid, t: c.title || '', img: safeUrl(c.pict_url), url: link || '',
      price: Number(c.price) || 0, quota: Number(c.couponQuota) || 0, off: Number(c.couponDiscount) || 0,
    });
  }

  // 骨架屏（性能小件）：重置加载时先占位，避免空白跳变（防 CLS 延伸）
  function showSkeleton(n) {
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var s = el('div', 'cp-skeleton');
      s.setAttribute('aria-hidden', 'true');
      s.appendChild(el('div', 'cp-sk-img'));
      s.appendChild(el('div', 'cp-sk-line'));
      s.appendChild(el('div', 'cp-sk-line is-short'));
      grid.appendChild(s);
    }
  }

  function setLoading(on, quiet) {
    state.loading = on;
    moreBtn.disabled = on;
    statusEl.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on && !quiet) showStatus('加载中…');
  }

  // 精选：纯手选池（后端 /random 已改为手选 + 京东/淘宝混合）
  function loadFeatured() {
    var token = ++viewToken;
    state.mode = 'featured';
    moreBtn.hidden = true;
    moreBtn.textContent = '加载更多';
    showSkeleton(8);
    setLoading(true, true);
    var action = loadActions.featured = function () { loadFeatured(); };
    var url = buildUrl('/random', [ [ 'limit', 10 ] ]);
    markStale(false);
    request(url, function (err, d) {
      if (token !== viewToken) return; // 竞态：已有更新的视图加载，丢弃过期响应
      setLoading(false);
      if (err) {
        loadSnapshot(function (snap) {
          if (snap && snap.featured && snap.featured.length) {
            state.list = cleanResult(snap.featured);
            render(currentView(), false);
            markStale(true);
            showStatus('⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '），券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      state.list = dedupeResult(cleanResult(pickList(d)));
      render(currentView(), false);
    }, { cache: true });
  }

  // 榜单本地分页：一次取满 RANK_LIMIT 条存 rankAll，rankShown 控制已展示条数（筛选/排序作用于全量后截断）
  function rankFiltered() { return sortList(applyFilters(filterPlat(state.rankAll))); }
  function rankView() { return rankFiltered().slice(0, state.rankShown); }
  function updateRankMore() {
    if (!moreBtn || state.mode !== 'rank') return;
    var left = rankFiltered().length - state.rankShown;
    if (left > 0) {
      moreBtn.hidden = false;
      moreBtn.textContent = '加载更多';
    } else {
      moreBtn.hidden = true;
      moreBtn.textContent = '加载更多';
    }
  }
  // 榜单接口会返回同一商品的多个不同券（同 pict_url/title、不同 tao_id），按商品身份去重，避免首页前排全是同一件
  function dedupeCoupons(arr) {
    if (Q.dedupe) return Q.dedupe(arr);
    var seen = Object.create(null);
    return (arr || []).filter(function (c) {
      var key = String((c.tao_id != null && c.tao_id !== '') ? c.tao_id : (c.pict_url || c.title || c.item_url || c.couponUrl || '')).trim();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  function setRankData(list) {
    state.rankAll = dedupeCoupons(cleanResult(list, { keepOrder: true }));
    state.rankShown = Math.min(PAGE_SIZE, state.rankAll.length);
    state.list = state.rankAll;
    render(rankView(), false);
    updateRankMore();
  }

  // 榜单：日/周/月
  function loadRank(period) {
    var token = ++viewToken;
    state.mode = 'rank';
    state.period = period;
    state.rankAll = [];
    state.rankShown = 0;
    intel.top10Done = false;
    moreBtn.hidden = true;
    showSkeleton(8);
    setLoading(true, true);
    var action = loadActions.rank = function () { loadRank(period); };
    var url = buildUrl('/rank', [ [ 'period', period ], [ 'limit', RANK_LIMIT ] ]);
    markStale(false);
    request(url, function (err, d) {
      if (token !== viewToken) return;
      setLoading(false);
      if (err) {
        loadSnapshot(function (snap) {
          var arr = snap && snap.rank && (snap.rank[period] || []);
          if (arr && arr.length) {
            setRankData(arr);
            markStale(true);
            showStatus('⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '）的' + ({ day: '日', week: '周', month: '月' }[period] || '') + '榜，券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      setRankData(pickList(d));
    }, { cache: true });
  }

  // 搜索：一次取满 100 条 → 本地相关性重排 → 20 条/页本地分页（避免弱相关商品占据首屏）
  function applySearchResults(list, reset) {
    state.searchAll = Q.rankByRelevance
      ? Q.rankByRelevance(dedupeResult(cleanResult(list)), state.search)
      : dedupeResult(cleanResult(list));
    state.searchShown = Math.min(PAGE_SIZE, state.searchAll.length);
    state.list = state.searchAll;
    render(searchView(), false);
    updateSearchMore();
  }
  function loadSearch(reset) {
    var token = reset ? ++viewToken : viewToken;
    state.mode = 'search';
    if (!reset && state.searchAll.length) {
      var all = applyFilters(filterPlat(state.searchAll));
      var prev = state.searchShown;
      state.searchShown = Math.min(prev + PAGE_SIZE, all.length);
      render(all.slice(prev, state.searchShown), true);
      updateSearchMore();
      return;
    }
    state.page = 1;
    state.searchAll = [];
    state.searchShown = 0;
    state.list = [];
    showSkeleton(8);
    setLoading(true, true);
    var action = loadActions.search = function () { loadSearch(true); };
    var url = buildUrl('/paging', [ [ 'search', state.search ], [ 'page', 1 ], [ 'pageSize', SEARCH_PAGE_SIZE ] ]);
    markStale(false);
    request(url, function (err, d) {
      if (token !== viewToken) return;
      setLoading(false);
      if (err) {
        var kw = state.search;
        loadSnapshot(function (snap) {
          var arr = (snap && snap.browse) || [];
          if (kw) arr = arr.filter(function (c) { return String(c.title || '').indexOf(kw) >= 0; });
          if (arr.length) {
            applySearchResults(arr, true);
            markStale(true);
            showStatus(kw ? ('⚠ 实时搜索暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '）展示匹配「' + kw + '」的券，可能已失效，下单前请核对。') : '⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '），券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      applySearchResults(pickList(d), true);
    }, { cache: false });
  }

  function setActiveTab(period) {
    var activeTabId = null;
    Array.prototype.forEach.call(tabs.children, function (t) {
      var active = t.getAttribute('data-period') === period;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      // roving tabindex：仅当前 tab 可聚焦，其余移出 Tab 序列（C7）
      t.tabIndex = active ? 0 : -1;
      if (active) activeTabId = t.id;
    });
    if (activeTabId) grid.setAttribute('aria-labelledby', activeTabId);
  }

  function init() {
    grid = $('cpGrid'); statusEl = $('cpState'); moreBtn = $('cpMore');
    tabs = $('cpTabs'); searchForm = $('cpSearchForm'); searchInput = $('cpSearchInput');
    sortSelect = $('cpSort');
    if (!grid || !statusEl) return;
    ensurePlatBar();
    // 默认排序跟随 select 初始选中项（省钱力度↓），与预渲染顺序一致
    if (sortSelect) state.sort = sortSelect.value || '';

    Array.prototype.forEach.call(tabs.children, function (t) {
      t.addEventListener('click', function () {
        var period = t.getAttribute('data-period');
        setActiveTab(period);
        loadRank(period);
      });
    });

    // 可访问性（C7）：tablist 支持左右方向键切换
    tabs.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var items = Array.prototype.slice.call(tabs.children);
      var idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      var next = e.key === 'ArrowRight' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next].focus();
      items[next].click();
      e.preventDefault();
    });

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        state.sort = sortSelect.value;
        if (!state.list.length) return;
        // 榜单切换到新排序时回到第一页，避免已展开条数显得「越排越少」
        if (state.mode === 'rank') {
          state.rankShown = Math.min(PAGE_SIZE, state.rankAll.length);
          render(rankView(), false);
          updateRankMore();
          return;
        }
        // 搜索态保留已累计的分页结果；尊重平台筛选
        if (state.mode === 'search' && state.searchAll.length) {
          state.searchShown = Math.min(PAGE_SIZE, state.searchAll.length);
          render(searchView(), false);
          updateSearchMore();
        } else render(currentView(), false);
      });
    }

    // 组合筛选：价格 / 折扣力度 / 品类（控件不存在时静默跳过）
    function bindFilter(id, key, attr) {
      var el = $(id);
      if (!el) return;
      state[key] = el.value || '';
      el.addEventListener('change', function () {
        state[key] = el.value || '';
        if (state.mode === 'search' && state.searchAll.length) {
          state.searchShown = Math.min(PAGE_SIZE, applyFilters(filterPlat(state.searchAll)).length);
          render(searchView(), false);
          updateSearchMore();
        } else if (state.mode === 'rank') {
          state.rankShown = Math.min(PAGE_SIZE, applyFilters(filterPlat(state.rankAll)).length);
          render(rankView(), false);
          updateRankMore();
        } else if (state.list.length) render(currentView(), false);
        syncUrl();
      });
    }
    bindFilter('cpPrice', 'price');
    bindFilter('cpDiscount', 'disc');
    bindFilter('cpCategory', 'category');

    // 搜索/筛选状态写回 URL，支持分享、回退与搜索引擎收录
    function syncUrl() {
      if (!global.history || !global.URLSearchParams) return;
      var p = new URLSearchParams();
      if (state.search) p.set('s', state.search);
      if (state.period && state.period !== 'week') p.set('period', state.period);
      if (state.sort) p.set('sort', state.sort);
      if (state.platform) p.set('platform', state.platform);
      if (state.price) p.set('price', state.price);
      if (state.disc) p.set('disc', state.disc);
      if (state.category) p.set('cat', state.category);
      var qs = p.toString();
      var url = global.location.pathname + (qs ? ('?' + qs) : '');
      global.history.replaceState(null, '', url);
    }
    function applyUrlState() {
      var s = '';
      if (global.URLSearchParams) {
        try {
          var q = new URLSearchParams(global.location.search);
          s = (q.get('s') || '').trim();
          var pairs = [ [ 'cpPrice', 'price', 'price' ], [ 'cpDiscount', 'disc', 'disc' ], [ 'cpCategory', 'category', 'cat' ] ];
          pairs.forEach(function (x) {
            var v = q.get(x[2]) || '';
            var el = $(x[0]);
            if (el) el.value = v;
            state[x[1]] = v;
          });
        } catch (e) { /* 忽略 */ }
      }
      if (s) {
        if (searchInput) searchInput.value = s;
        state.search = s;
        setActiveTab('');
        if (global.CouponStore) global.CouponStore.pushSearch(s);
        loadSearch(true);
        syncUrl();
      }
    }
    global.addEventListener('popstate', applyUrlState);

    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideSuggest();
      state.search = (searchInput.value || '').trim();
      setActiveTab('');
      if (!state.search) { loadFeatured(); syncUrl(); return; }
      if (global.CouponStore) global.CouponStore.pushSearch(state.search);
      loadSearch(true);
      syncUrl();
      renderHistory();
    });

    moreBtn.addEventListener('click', function () {
      if (state.loading) return;
      // 榜单：本地分页追加（不再请求后端）
      if (state.mode === 'rank') {
        var total = rankFiltered().length;
        if (state.rankShown >= total) return;
        var prev = state.rankShown;
        state.rankShown = Math.min(prev + PAGE_SIZE, total);
        render(rankView().slice(prev), true);
        updateRankMore();
        return;
      }
      // 搜索：100 条已在本地，直接追加下一屏（相关性排序不被后端分页打乱）
      if (state.mode === 'search') { loadSearch(false); return; }
      if (!state.hasMore) return;
      state.page += 1;
      loadSearch(false);
    });

    // URL 直达搜索：/?s=关键词（首页热门词 chip 的落地方式，零后端）
    var preKw = '';
    if (global.URLSearchParams) {
      try { preKw = (new URLSearchParams(global.location.search).get('s') || '').trim(); } catch (e) { /* 忽略 */ }
    }
    if (preKw) {
      applyUrlState();
    } else {
      // 默认展示周榜：与 HTML 中默认高亮的「周榜」tab 保持一致（此前加载精选导致 UI 与数据不符）
      setActiveTab('week');
      loadRank('week');
    }

    renderHistory();
    loadHotWords();
    initSuggest();
    probeCats();
    // 猜你喜欢（M1）：本地有浏览/搜索信号才拉取并展示
    recGrid = $('cpRecGrid'); recSection = $('cpRecSection');
    loadRecommend();
    // 历史低价走势（M7）：网格变化（含分页追加）后批量取趋势画 sparkline
    if (grid && 'MutationObserver' in global) {
      var _pt;
      var _mo = new MutationObserver(function () {
        global.clearTimeout(_pt);
        _pt = global.setTimeout(function () { loadPriceTrends(grid); }, 500);
      });
      _mo.observe(grid, { childList: true });
    }
    var rd = $('cpRecDismiss');
    if (rd) rd.addEventListener('click', function () { if (recSection) recSection.hidden = true; });
  }

  // 搜索历史 chip 行（store.js 落本地）：点击回填输入框并重新搜索
  function renderHistory() {
    var box = $('cpHistory');
    if (!box || !global.CouponStore) return;
    var arr = global.CouponStore.searches();
    box.innerHTML = '';
    if (!arr.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('span', 'cp-his-label', '最近搜索'));
    arr.slice(0, 8).forEach(function (kw) {
      var b = el('button', 'cp-his-chip', kw);
      b.type = 'button';
      b.addEventListener('click', function () {
        searchInput.value = kw;
        if (searchForm.requestSubmit) searchForm.requestSubmit();
        else searchForm.dispatchEvent(new Event('submit', { cancelable: true }));
      });
      box.appendChild(b);
    });
    var clear = el('button', 'cp-his-clear', '清空');
    clear.type = 'button';
    clear.setAttribute('aria-label', '清空搜索历史');
    clear.addEventListener('click', function () {
      global.CouponStore.clearSearches();
      renderHistory();
    });
    box.appendChild(clear);
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);

