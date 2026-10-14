/* ==========================================================================
   share.js · 优惠券分享（M4）
   —— 零依赖：优先调系统原生 Web Share（移动端拉起分享面板），
      降级到自绘 canvas 海报下载（含商品图 / 券力 / 深链），再降级到复制深链。
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

  // 自绘海报：商品图（跨域尝试，污染则跳过图）+ 券力 + 标题 + 深链
  function drawPoster(item) {
    var c = doc.createElement('canvas');
    c.width = 600; c.height = 820;
    var x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 600, 820);
    x.fillStyle = '#e4393c'; x.fillRect(0, 0, 600, 92);
    x.fillStyle = '#ffffff'; x.font = 'bold 34px sans-serif'; x.fillText('小满券仓 · 领券中心', 30, 58);

    var done = false;
    function finish() {
      if (done) return; done = true;
      x.fillStyle = '#e4393c'; x.font = 'bold 42px sans-serif';
      x.fillText('到手 ¥' + (item.price || '?'), 30, 650);
      if (item.off) {
        x.font = 'bold 26px sans-serif';
        x.fillText('券 ' + (item.quota ? ('满' + item.quota + '减' + item.off) : ('立减¥' + item.off)), 30, 694);
      }
      x.fillStyle = '#222'; x.font = '22px sans-serif';
      wrapText(x, item.t || '优惠券', 30, 730, 540, 30);
      x.fillStyle = '#999'; x.font = '15px sans-serif';
      x.fillText('长按复制链接领券：' + (item.url || '').slice(0, 48), 30, 800);
      try {
        var a = doc.createElement('a');
        a.download = 'coupon-' + (item.id || 'share') + '.png';
        a.href = c.toDataURL('image/png');
        a.click();
        if (global.Tracker) global.Tracker.track('coupon_share', { type: 'poster', coupon_id: item.id || '' });
        miniToast('已生成分享图，长按图保存');
      } catch (e) { copyDeep(item.url || ''); }
    }

    if (item.img) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { try { x.drawImage(img, 60, 120, 480, 480); } catch (e) {} finish(); };
      img.onerror = function () { finish(); };
      img.src = item.img;
      global.setTimeout(function () { if (!done) finish(); }, 2500); // 图未加载也出图
    } else { finish(); }
  }

  function openShare(item) {
    var url = safeUrl(item.url) || '';
    var title = item.t || '优惠券';
    if (global.navigator && global.navigator.share) {
      global.navigator.share({ title: title, text: '先领券再下单更省：' + title, url: url })
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

  global.CouponShare = { attach: attach, openShare: openShare };
})(window);
