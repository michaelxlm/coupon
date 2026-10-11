/* ==========================================================================
   calculator.js · 凑单省钱计算器（calculator.html）
   —— 纯前端实时计算：Σ商品价格 = 凑单总额；已勾选且达到门槛 X 的券按减免 Y 叠加；
      到手价 = 总额 - min(总减免, 总额)。未达门槛的券提示「还差 ¥N」。
   URL 预填：?price= 首件商品价格；?quota=&off= 自动生成一条满减规则（来自收藏页「去凑单」）。
   静默失败：任何输入异常按 0 处理，不抛错。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;

  function $(id) { return doc.getElementById(id); }

  function money(n) {
    return '¥' + (Math.round(n * 100) / 100).toFixed(2);
  }

  function num(v) {
    var n = parseFloat(v);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  var itemsBox, couponBox;

  function addItemRow(name, price) {
    var row = doc.createElement('div');
    row.className = 'cal-row';
    row.innerHTML = '<input class="cal-input" type="text" placeholder="商品名称（选填）" aria-label="商品名称">'
      + '<input class="cal-input" type="number" min="0" step="0.01" placeholder="价格" data-role="price" aria-label="商品价格（元）">'
      + '<span></span>'
      + '<button type="button" class="cal-del" data-del aria-label="删除该行">✕</button>';
    var ins = row.getElementsByTagName('input');
    if (name) ins[0].value = name;
    if (price != null) ins[1].value = price;
    itemsBox.appendChild(row);
  }

  function addCouponRow(quota, off, on) {
    var row = doc.createElement('div');
    row.className = 'cal-row';
    row.innerHTML = '<input class="cal-check" type="checkbox" data-role="on" aria-label="启用该优惠">'
      + '<input class="cal-input" type="number" min="0" step="1" placeholder="满" data-role="quota" aria-label="满减门槛（元）">'
      + '<input class="cal-input" type="number" min="0" step="1" placeholder="减" data-role="off" aria-label="减免金额（元）">'
      + '<button type="button" class="cal-del" data-del aria-label="删除该券">✕</button>';
    var ins = row.getElementsByTagName('input');
    ins[0].checked = on !== false;
    if (quota != null) ins[1].value = quota;
    if (off != null) ins[2].value = off;
    couponBox.appendChild(row);
  }

  var tracked = false; // 每次访问只在首次得到有效结果时上报一次，避免输入抖动刷事件

  function recalc() {
    var total = 0;
    var priceInputs = itemsBox.querySelectorAll('[data-role="price"]');
    Array.prototype.forEach.call(priceInputs, function (i) { total += num(i.value); });

    var save = 0, used = 0, gaps = [];
    var rows = couponBox.querySelectorAll('.cal-row');
    Array.prototype.forEach.call(rows, function (r) {
      var on = r.querySelector('[data-role="on"]');
      var quota = num(r.querySelector('[data-role="quota"]').value);
      var off = num(r.querySelector('[data-role="off"]').value);
      if (!on || !on.checked || off <= 0) return;
      if (quota > 0 && total < quota) { gaps.push({ quota: quota, off: off, gap: quota - total }); return; }
      save += off;
      used++;
    });
    save = Math.min(save, total);
    var finalPrice = Math.max(total - save, 0);

    $('calTotal').textContent = money(total);
    $('calSave').textContent = '-' + money(save);
    $('calFinal').textContent = money(finalPrice);
    $('calRate').textContent = total > 0 ? (money(save) + ' · 约 ' + (Math.round((save / total) * 1000) / 10 + 0).toFixed(1) + '% off') : '—';

    var detail = $('calDetail');
    detail.innerHTML = '';
    if (total > 0 && used > 0) {
      Array.prototype.forEach.call(rows, function (r) {
        var on = r.querySelector('[data-role="on"]');
        var quota = num(r.querySelector('[data-role="quota"]').value);
        var off = num(r.querySelector('[data-role="off"]').value);
        if (!on || !on.checked || off <= 0) return;
        if (quota > 0 && total < quota) return;
        var li = doc.createElement('li');
        li.textContent = '满' + quota + '减' + off + ' ✓ 已生效';
        detail.appendChild(li);
      });
    }

    var warn = $('calWarn');
    if (gaps.length) {
      var parts = gaps.map(function (g) { return '满' + g.quota + '减' + g.off + ' 还差 ' + money(g.gap); });
      warn.textContent = '未达门槛：' + parts.join('；') + '。可加购小件凑单，或取消勾选该券。';
    } else if (total > 0 && !used) {
      warn.textContent = '还没有可用的优惠规则，填一张「满X减Y」试试。';
    } else {
      warn.textContent = '';
    }

    if (!tracked && total > 0 && save > 0 && global.Conv) {
      tracked = true;
      global.Conv.track('calc_result', { total: total, save: save, final: finalPrice, coupons: used });
    }
  }

  function prefill() {
    if (!global.URLSearchParams) return;
    var p;
    try { p = new URLSearchParams(global.location.search); } catch (e) { return; }
    var price = num(p.get('price'));
    var quota = num(p.get('quota'));
    var off = num(p.get('off'));
    var firstPrice = itemsBox.querySelector('[data-role="price"]');
    if (price > 0 && firstPrice) firstPrice.value = price;
    if (quota > 0 && off > 0) {
      // 清掉模板里的空规则行，替换为带入的券
      couponBox.innerHTML = '';
      addCouponRow(quota, off, true);
    }
  }

  function init() {
    itemsBox = $('calItems'); couponBox = $('calCoupons');
    if (!itemsBox || !couponBox) return;

    $('calAddItem').addEventListener('click', function () { addItemRow(); recalc(); });
    $('calAddCoupon').addEventListener('click', function () { addCouponRow(); recalc(); });

    // 事件委托：输入实时重算，✕ 删行（至少保留一行）
    function delegated(box, recalcOnDel) {
      box.addEventListener('input', recalc);
      box.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-del]') : null;
        if (!btn) return;
        var row = btn.parentNode;
        if (box.querySelectorAll('.cal-row').length <= 1) { // 最后一行：清空代替删除
          Array.prototype.forEach.call(row.querySelectorAll('input'), function (i) {
            if (i.type === 'checkbox') i.checked = true; else i.value = '';
          });
        } else {
          box.removeChild(row);
        }
        if (recalcOnDel) recalc();
      });
    }
    delegated(itemsBox, true);
    delegated(couponBox, true);
    couponBox.addEventListener('change', recalc); // checkbox 切换

    prefill();
    recalc();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
