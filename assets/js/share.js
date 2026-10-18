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
