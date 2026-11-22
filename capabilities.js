/* !
 * 跨站能力软互联出站组件（WO-83；能力归属见 05 · Part 6 五，工单见 11 · §4.2）
 * @file main-api/shared/capabilities.js
 * @description 轻量、零依赖、纯静态可用的「跨站入口卡」渲染器。单一数据源为同目录的 capabilities.json
 *   （WO-78 建，跨站能力清单）。组件在运行时读取该 JSON，把「非本站、status=live」的能力渲染成
 *   出站入口卡（复制链接 / 打开），点击埋点复用宿主站统一 tracker（pv.js 的 window.Tracker，
 *   通过 [data-track] 事件委托自动上报，无需业务代码逐个绑定）。
 *
 * 设计约束：
 *   - 软互联（WO-83）：「复制链接 → 浏览器打开」，不依赖任何配置即可用。
 *   - 硬内嵌（WO-84）：H5 端对 embedMode 含 iframe 且命中 embedAllowlist 白名单的能力，追加「嵌入」按钮，用模态 iframe 内联本站能力（?embed=1）。小程序端永依 E7 不内嵌 H5，本组件只在浏览器运行，天然 H5-only。备案（WO-56）不作开关。
 *   - 静默失败：fetch 失败 / file:// / 存储禁用 / tracker 未加载，都不得影响宿主页面。
 *   - 单一源同步：编辑 main-api/shared/capabilities.json → node main-api/scripts/sync-capabilities.js 覆盖各站副本，
 *     六站入口卡随之更新（改一处，多站同步）。
 *
 * 接入方式（各站 HTML 仅需要一个脚本标签）：
 *   <script src="<相对路径>/capabilities.js" data-site="<本站 site>" defer></script>
 *   - data-site：本站在 capabilities.json 中的 site 值（visitor / color-tool / aiWeb ...），用于排除自身。
 *   - capabilities.json 必须与本脚本同目录（组件按自身 URL 推断 JSON 地址）。
 */
(function(global) {
  'use strict';

  const doc = global.document;
  if (!doc) return;

  // ===== 解析本脚本自身 URL，推断同目录 capabilities.json 与 data-site =====
  // 指纹/压缩产物同样要能定位同目录 JSON（aiWeb 页面引用 capabilities.<hash>.js）：
  // capabilities.js / capabilities.min.js / capabilities.<hash>.js / capabilities.<hash>.min.js
  const CAP_SCRIPT_RE = /capabilities(?:\.[A-Za-z0-9_-]{8,12})?(?:\.min)?\.js(?:\?.*)?$/i;
  const CAP_JSON_OF_RE = /(capabilities)(?:\.[A-Za-z0-9_-]{8,12})?(?:\.min)?\.js(?:\?.*)?$/i;

  function selfScript() {
    let el = doc.currentScript;
    if (!el) {
      const all = doc.getElementsByTagName('script');
      for (let i = all.length - 1; i >= 0; i--) {
        if (CAP_SCRIPT_RE.test(all[i].getAttribute('src') || '')) { el = all[i]; break; }
      }
    }
    return el || null;
  }

  function resolveDataUrl(script) {
    // 优先显式配置，其次按脚本自身 URL 同目录推断，最后回落相对当前页
    if (global.CapabilitiesConfig && global.CapabilitiesConfig.dataUrl) {
      return global.CapabilitiesConfig.dataUrl;
    }
    if (script && script.src) {
      return script.src.replace(CAP_JSON_OF_RE, '$1.json');
    }
    return 'capabilities.json';
  }

  function resolveCurrentSite(script) {
    if (global.CapabilitiesConfig && global.CapabilitiesConfig.site) return global.CapabilitiesConfig.site;
    if (script && script.getAttribute('data-site')) return script.getAttribute('data-site');
    // 按主机名兜底推断（线上域名 → site）
    const host = (global.location && global.location.hostname) || '';
    if (/2002cs\.com/.test(host)) return 'color-tool';
    if (/fangkelianmeng\.com/.test(host)) return 'visitor';
    if (/xuliming\.com/.test(host)) return 'aiWeb';
    if (/xuyiheng\.com/.test(host)) return 'main-tool';
    if (/585\.ink/.test(host)) return 'notes';
    return '';
  }

  function isEnglish() {
    const lang = (doc.documentElement && doc.documentElement.getAttribute('lang')) || '';
    return /^en/i.test(lang);
  }

  // ===== 文案（zh / en） =====
  const STR = {
    title(en) { return en ? 'You may also need' : '你可能需要'; },
    sub(en) { return en ? 'Cross-site tools · copy, open, or embed inline (H5)' : '跨站能力 · 复制链接 / 前往 / 内嵌（H5 端可 iframe 内嵌）'; },
    copy(en) { return en ? 'Copy link' : '复制链接'; },
    copied(en) { return en ? 'Copied' : '已复制'; },
    open(en) { return en ? 'Open' : '打开'; },
    embed(en) { return en ? 'Embed' : '嵌入'; },
    embedClose(en) { return en ? 'Close' : '关闭'; },
    embedNewTab(en) { return en ? 'Open in new tab' : '新窗口打开'; },
  };

  // ===== 样式（只注入一次；尽量用宿主 CSS 变量，保持视觉对齐） =====
  function injectStyle() {
    if (doc.getElementById('cap-style')) return;
    const css = [
      // 顶层容器：跟宿主 .card 类对齐（用 --radius-lg / --shadow-soft 等变量）
      '.cap-block{box-sizing:border-box;width:100%;max-width:var(--maxw,var(--ss-maxw,1140px));margin:1.5rem auto;padding:1.5rem;border:1px solid var(--color-border,#e2e6eb);border-radius:var(--radius-lg,22px);background:var(--color-surface,#fff);box-shadow:var(--shadow-soft,0 6px 24px rgba(18,23,42,.08))}',
      '.cap-head{font-size:var(--font-display-size,1.15rem);font-weight:650;color:var(--color-text,#1a1d24);margin:0 0 .25rem;font-family:var(--font-display,inherit)}',
      '.cap-sub{font-size:.95rem;color:var(--color-muted-text,#5f6775);margin:0 0 1rem}',
      '.cap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.9rem}',
      '.cap-card{display:flex;flex-direction:column;gap:.5rem;padding:.9rem 1rem;border:1px solid var(--color-border,#e2e6eb);border-radius:var(--radius-md,12px);background:var(--color-background,#f6f7f9)}',
      '.cap-site{font-size:11px;color:var(--color-muted-text,#5f6775);letter-spacing:.04em;text-transform:uppercase;font-weight:600}',
      '.cap-label{font-size:.9rem;font-weight:600;color:var(--color-text,#1a1d24);line-height:1.4}',
      '.cap-actions{display:flex;gap:.5rem;margin-top:.25rem;flex-wrap:wrap}',
      '.cap-btn{display:inline-flex;align-items:center;justify-content:center;padding:.45rem .75rem;font-size:.82rem;line-height:1;font-weight:600;border-radius:var(--radius-sm,8px);cursor:pointer;text-decoration:none;border:1px solid var(--color-border,#e2e6eb);background:var(--color-surface,#fff);color:var(--color-text,#1a1d24);transition:border-color .15s,background .15s}',
      '.cap-btn:hover{border-color:var(--color-focus,#0b66ff)}',
      '.cap-btn--open{background:var(--color-primary,#2457d6);border-color:var(--color-primary,#2457d6);color:var(--color-on-accent,#fff)}',
      '[data-theme="dark"] .cap-block{background:var(--color-surface,#171a21);box-shadow:var(--shadow-soft,0 6px 24px rgba(0,0,0,.45))}',
      '[data-theme="dark"] .cap-card{background:var(--color-background,#0f1115)}',
      '.cap-btn--embed{border-color:var(--color-primary,#2457d6);color:var(--color-primary,#2457d6)}',
      '.cap-embed-overlay{position:fixed;inset:0;z-index:var(--z-modal,1050);display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:16px}',
      '.cap-embed-overlay.is-open{display:flex}',
      '.cap-embed-box{display:flex;flex-direction:column;width:min(1000px,100%);height:min(85vh,900px);background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e6eb);border-radius:var(--radius-md,12px);overflow:hidden;box-shadow:var(--shadow-lg,0 18px 48px rgba(18,23,42,.12))}',
      '.cap-embed-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--color-border,#e2e6eb);background:var(--color-background,#f6f7f9)}',
      '.cap-embed-src{flex:1;min-width:0;font-size:14px;font-weight:600;color:var(--color-text,#1a1d24);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cap-embed-frame{flex:1;width:100%;border:0;background:#fff}',
      '.cap-embed-x{flex:none;padding:6px 12px;font-size:13px;line-height:1;border:1px solid var(--color-border,#e2e6eb);border-radius:var(--radius-sm,8px);background:var(--color-surface,#fff);color:var(--color-text,#1a1d24);cursor:pointer;text-decoration:none}',
      '.cap-embed-x:hover{border-color:var(--color-focus,#0b66ff)}',
      '@media (max-width:720px){.cap-block{padding:1.25rem;margin:1.25rem 0}.cap-grid{grid-template-columns:1fr}}',
    ].join('\n');
    const style = doc.createElement('style');
    style.id = 'cap-style';
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // ===== 复制链接（navigator.clipboard，降级 execCommand） =====
  function copyText(text, cb) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(function() { cb(true); }, function() { legacyCopy(text, cb); });
    } else {
      legacyCopy(text, cb);
    }
  }
  function legacyCopy(text, cb) {
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      doc.body.removeChild(ta);
      cb(ok);
    } catch (e) { cb(false); }
  }

  // ===== 硬内嵌（WO-84）：iframe 模态，按 embedAllowlist 白名单门控，H5-only =====
  function embedSrcFor(cap) {
    const base = cap.entryUrl || '';
    if (!base) return '';
    if (cap.embedParam) return base + cap.embedParam;
    return base + (base.indexOf('?') !== -1 ? '&' : '?') + 'embed=1';
  }

  function canEmbed(cap, allow) {
    try { if (global.top !== global.self) return false; } catch (e) { return false; } // 自身已在 iframe 内，不嵌套
    const mode = String(cap.embedMode || '').toLowerCase();
    if (mode.indexOf('iframe') === -1) return false;
    if (!allow) return true; // 无白名单数据（旧 json）时按 embedMode 放行
    const origin = allow[cap.site];
    if (!origin) return false;
    try { return new global.URL(cap.entryUrl, global.location.href).origin === origin; } catch (e) { return String(cap.entryUrl).indexOf(origin) === 0; }
  }

  function ensureModal(en) {
    let ov = doc.getElementById('cap-embed-overlay');
    if (ov) return ov;
    ov = doc.createElement('div');
    ov.id = 'cap-embed-overlay';
    ov.className = 'cap-embed-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.innerHTML =
      '<div class="cap-embed-box">' +
        '<div class="cap-embed-bar">' +
          '<span class="cap-embed-src"></span>' +
          '<a class="cap-embed-x cap-embed-newtab" href="#" target="_blank" rel="noopener nofollow">' + escapeHtml(STR.embedNewTab(en)) + '</a>' +
          '<button class="cap-embed-x cap-embed-close" type="button">' + escapeHtml(STR.embedClose(en)) + '</button>' +
        '</div>' +
        '<iframe class="cap-embed-frame" title="\u8de8\u7ad9\u5185\u5d4c" src="about:blank"></iframe>' +
      '</div>';
    doc.body.appendChild(ov);
    ov.addEventListener('click', function(e) { if (e.target === ov) closeEmbed(); });
    ov.querySelector('.cap-embed-close').addEventListener('click', closeEmbed);
    doc.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeEmbed(); });
    return ov;
  }

  function openEmbed(cap, en) {
    injectStyle();
    const ov = ensureModal(en);
    ov.querySelector('.cap-embed-src').textContent = (cap.site || '') + ' \u00b7 ' + (cap.label || cap.capability || '');
    ov.querySelector('.cap-embed-newtab').href = cap.entryUrl;
    ov.querySelector('.cap-embed-frame').src = embedSrcFor(cap);
    ov.classList.add('is-open');
    if (doc.body) doc.body.style.overflow = 'hidden';
  }

  function closeEmbed() {
    const ov = doc.getElementById('cap-embed-overlay');
    if (!ov) return;
    ov.classList.remove('is-open');
    const frame = ov.querySelector('.cap-embed-frame');
    if (frame) frame.src = 'about:blank';
    if (doc.body) doc.body.style.overflow = '';
  }

  // ===== 渲染 =====
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildCard(cap, currentSite, en, allow) {
    const wrap = doc.createElement('div');
    wrap.className = 'cap-card';
    const props = JSON.stringify({ capability: cap.capability, to: cap.site, from: currentSite || '', url: cap.entryUrl });

    const site = doc.createElement('div');
    site.className = 'cap-site';
    site.textContent = cap.site || '';
    wrap.appendChild(site);

    const label = doc.createElement('div');
    label.className = 'cap-label';
    label.textContent = cap.label || cap.capability || '';
    wrap.appendChild(label);

    const actions = doc.createElement('div');
    actions.className = 'cap-actions';

    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cap-btn';
    copyBtn.textContent = STR.copy(en);
    // 复用宿主 tracker：点击由 pv.js 的 [data-track] 事件委托自动上报
    copyBtn.setAttribute('data-track', 'capability_copy');
    copyBtn.setAttribute('data-track-props', props);
    copyBtn.addEventListener('click', function() {
      copyText(cap.entryUrl, function(ok) {
        if (ok) {
          copyBtn.textContent = STR.copied(en);
          setTimeout(function() { copyBtn.textContent = STR.copy(en); }, 1600);
        }
      });
    });
    actions.appendChild(copyBtn);

    const openLink = doc.createElement('a');
    openLink.className = 'cap-btn cap-btn--open';
    openLink.href = cap.entryUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener nofollow';
    openLink.textContent = STR.open(en);
    openLink.setAttribute('data-track', 'capability_open');
    openLink.setAttribute('data-track-props', props);
    actions.appendChild(openLink);

    // 硬内嵌（WO-84）：命中白名单且 embedMode 含 iframe → 追加「嵌入」按钮（模态 iframe）
    if (canEmbed(cap, allow)) {
      const embedBtn = doc.createElement('button');
      embedBtn.type = 'button';
      embedBtn.className = 'cap-btn cap-btn--embed';
      embedBtn.textContent = STR.embed(en);
      embedBtn.setAttribute('data-track', 'capability_embed');
      embedBtn.setAttribute('data-track-props', props);
      embedBtn.addEventListener('click', function() { openEmbed(cap, en); });
      actions.appendChild(embedBtn);
    }

    wrap.appendChild(actions);
    return wrap;
  }

  function render(caps, currentSite) {
    const en = isEnglish();
    const list0 = Array.isArray(caps) ? caps : ((caps && caps.capabilities) || []);
    const allow = (caps && !Array.isArray(caps) && caps.embedAllowlist) ? (caps.embedAllowlist.origins || null) : null;
    // 只展示非本站、status=live、audience≠internal（内部管理页不出站卡）的能力
    const list = list0.filter(function(c) {
      return c && c.status === 'live' && c.entryUrl &&
             (!c.audience || c.audience !== 'internal') &&
             (!currentSite || c.site !== currentSite);
    });
    if (!list.length) return;

    injectStyle();

    const block = doc.createElement('section');
    block.className = 'cap-block';
    block.setAttribute('aria-label', STR.title(en));

    const h = doc.createElement('div');
    h.className = 'cap-head';
    h.textContent = STR.title(en);
    block.appendChild(h);

    const sub = doc.createElement('div');
    sub.className = 'cap-sub';
    sub.textContent = STR.sub(en);
    block.appendChild(sub);

    const grid = doc.createElement('div');
    grid.className = 'cap-grid';
    list.forEach(function(cap) { grid.appendChild(buildCard(cap, currentSite, en, allow)); });
    block.appendChild(grid);

    // 挂载（优先级：占位属性 → 主内容容器末尾 → footer 之前 → body 末尾）
    const placeholder = doc.querySelector('[data-capabilities]');
    if (placeholder) {
      placeholder.appendChild(block);
    } else {
      // 优先挂到 <main> / .site-main 等主内容容器末尾，跟宿主 .card 类在同一居中容器里
      const mainContainer =
        doc.querySelector('main, [role="main"], .site-main, .main-content, #main-content, .content');
      if (mainContainer) {
        mainContainer.appendChild(block);
      } else {
        const footer = doc.querySelector('footer, .site-footer');
        if (footer) {
          footer.parentNode.insertBefore(block, footer);
        } else {
          doc.body.appendChild(block);
        }
      }
    }
  }

  // ===== 启动 =====
  function boot() {
    // 嵌入态（本页正被别的站点 iframe 内嵌）不渲染跨站出站卡，避免 iframe 内递归内嵌 / 双重导航（WO-84）
    try { if (global.top !== global.self) return; } catch (e) { return; }
    try {
      const script = selfScript();
      const currentSite = resolveCurrentSite(script);
      const url = resolveDataUrl(script);
      // 预置数据（同步 SSR 场景可提前注入 window.CapabilitiesData）
      if (global.CapabilitiesData) { render(global.CapabilitiesData, currentSite); return; }
      const xhr = new global.XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 5000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 400) {
          try {
            const json = JSON.parse(xhr.responseText);
            render(json, currentSite);
          } catch (e) { /* 解析失败静默 */ }
        }
      };
      // 网络失败 / 超时 / file://（status 0）一律静默，不影响宿主页面
      xhr.onerror = function() {};
      xhr.ontimeout = function() {};
      xhr.send();
    } catch (e) { /* 任何异常都不外溢 */ }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 对外 API（供宿主按需手动挂载 / 覆盖配置）
  global.Capabilities = {
    boot,
    render,
    config(cfg) { global.CapabilitiesConfig = Object.assign(global.CapabilitiesConfig || {}, cfg || {}); },
  };
})(window);
