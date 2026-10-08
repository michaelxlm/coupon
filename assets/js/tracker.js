/* ==========================================================================
   tracker.js · 统一埋点 SDK（Web 端）
   上报地址：POST https://api.xuyiheng.com/api/v1/public/track
   来源：与 aiWeb / color-tool / visitor 共用同一份 SDK（main-api 中台口径）

   设计原则：
     - 静默失败：接口挂了 / 离线 / file:// 打开 / 存储被禁用，都不影响页面使用
     - body 用 text/plain，避免 application/json 触发跨域 CORS 预检
     - 优先 sendBeacon（页面关闭也能发出），降级 fetch keepalive + no-cors
     - 劫持 history.pushState / replaceState，捕获单页内切换的虚拟 PV
     - 零依赖、纯静态可用，直接以 <script src> 引入

   能力：
     1. 自动生成并持久化匿名 visitorId（localStorage），作为 UV 统计口径
     2. 会话 sessionId（30 分钟滚动续期），支撑会话级分析
     3. track(event, props) 手动打点 API
     4. [data-track] 元素点击自动打点（无需在业务代码里逐个绑定）
     5. 事件队列 + 批量 flush，pagehide / 隐藏时兜底 flush

   接入方式（二选一）：
     A. 部署前修改下方 CONFIG.project（推荐，零额外配置；本项目为 585ink）
     B. 在引入本脚本前声明 window.TrackerConfig = { project: 'xxx', ... } 覆盖
        （构建脚本 scripts/build.js 会按 data/site.json 的 track 字段自动注入）
   用法：
     <button data-track="cta_click" data-track-props='{"pos":"hero"}'>免费试用</button>
     Tracker.track('form_submit', { topic: 'trial' });
   ========================================================================== */

(function (global) {
  'use strict';

  // SDK 版本：与中台 main-api 的 SDK 保持同步
  var SDK_VERSION = '2.1.0';

  var CONFIG = {
    // 上报端点（中台统一埋点端点）
    endpoint: 'https://api.xuyiheng.com/api/v1/public/track',
    // 项目代号：本项目为 585ink
    project: '585ink',
    // 终端类型：Web 站点固定 web
    terminal: 'web',
    // 调试模式：置 true 时在控制台打印上报内容（生产请保持 false）
    debug: false,
    // 存储键
    visitorKey: '__tk_vid',
    sessionKey: '__tk_sid',
    // 会话有效期（毫秒）：30 分钟无操作视为新会话
    sessionTTL: 30 * 60 * 1000,
    // 批量 flush 间隔（毫秒）
    flushInterval: 1000,
    // 单次批量上报最大条数
    maxBatch: 20,
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
  /** 页面标识取 body 上的 data-page，没有则回落 'unknown' */
  function pageType() {
    var body = global.document && global.document.body;
    if (!body) return 'unknown';
    return body.getAttribute('data-page') || 'unknown';
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
      return; // 序列化失败直接放弃，绝不影响页面
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
    var events = queue.slice(0, CONFIG.maxBatch);
    queue = queue.slice(CONFIG.maxBatch);
    send(events);
  }

  /** 入队并按间隔批量上报 */
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
   * @param {String} event - 事件名（pv / cta_click / 自定义）
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
    track('pv', null, true); // PV 立即上报，避免用户快速跳走丢数
  }

  /** 允许强制重新上报当前页 PV */
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
   * 用法：<button data-track="cta_click" data-track-props='{"pos":"hero"}'>免费试用</button>
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

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    try {
      if (global.location && global.location.protocol === 'file:') return; // 本地双击打开不上报
    } catch (e) { return; }

    patchHistory();
    bindDataTrack();
    bindFlushOnLeave();
    trackPv();
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ------------------------------ 对外 API ------------------------------ */
  global.Tracker = {
    track: track,
    trackPv: trackPv,
    refreshPv: refreshPv,
    flush: flush,
    config: CONFIG,
    visitorId: getVisitorId,
    sessionId: getSessionId,
    sdkVersion: SDK_VERSION,
  };
})(window);
