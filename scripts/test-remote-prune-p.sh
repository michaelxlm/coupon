#!/usr/bin/env bash
# ============================================================================
# test-remote-prune-p.sh · remote-prune-p.sh 回归测试（本地可跑，零外部依赖）
# ----------------------------------------------------------------------------
# 被测脚本会「删除生产机上的文件」，属高危操作，故用夹具锁住两条底线：
#   1) 正向：只删「磁盘有、sitemap 无」的过期壳；在图页面与 /p/_shell.html 必须保留；
#      重复执行必须幂等（第二次 DELETED=0）。
#   2) 安全闸：无法确认 nginx 的 /p/ 回退可用时（例如读不到 nginx -T），
#      必须一个文件都不删 —— 否则会把旧链打成 404 坏链。
#
# 用法：bash scripts/test-remote-prune-p.sh
# ============================================================================
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/remote-prune-p.sh"
FAIL=0
ok()  { echo "  OK   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }

if [ ! -f "$SCRIPT" ]; then echo "找不到被测脚本：$SCRIPT"; exit 1; fi

# ------------------------------------------------------------ 用例 1：正向删除
echo "=== 用例 1：按 sitemap 差集删除过期壳 ==="
FIX=$(mktemp -d); mkdir -p "$FIX/p"
for id in aaa111222333444555666 aaa111222333444555667 bbb111222333444555668; do
  echo "<html>$id</html>" > "$FIX/p/$id.html"
done
for id in stale0000000000000001 stale0000000000000002 stale0000000000000003; do
  echo "<html>$id</html>" > "$FIX/p/$id.html"
done
echo '<html data-shell="1"></html>' > "$FIX/p/_shell.html"
cat > "$FIX/sitemap.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://coupon.zangeng.com/p/aaa111222333444555666.html</loc></url>
<url><loc>https://coupon.zangeng.com/p/aaa111222333444555667.html</loc></url>
<url><loc>https://coupon.zangeng.com/p/bbb111222333444555668.html</loc></url>
<url><loc>https://coupon.zangeng.com/</loc></url>
</urlset>
XML

PRUNE_ROOT="$FIX" PRUNE_SKIP_NGINX=1 bash "$SCRIPT" > "$FIX/log.txt" 2>&1
grep -E 'SITEMAP_KEEP|STALE_COUNT|DELETED=' "$FIX/log.txt" | sed 's/^/  /'

for f in aaa111222333444555666 aaa111222333444555667 bbb111222333444555668 _shell; do
  [ -f "$FIX/p/$f.html" ] && ok "保留 $f.html" || bad "丢失 $f.html"
done
for f in stale0000000000000001 stale0000000000000002 stale0000000000000003; do
  [ -f "$FIX/p/$f.html" ] && bad "未删除 $f.html" || ok "已删除 $f.html"
done

echo "  --- 幂等复跑 ---"
PRUNE_ROOT="$FIX" PRUNE_SKIP_NGINX=1 bash "$SCRIPT" > "$FIX/log2.txt" 2>&1
STALE2=$(grep -oE 'STALE_COUNT=[0-9]+' "$FIX/log2.txt" | head -1)
DEL2=$(grep -oE 'DELETED=[0-9]+' "$FIX/log2.txt" | head -1)
echo "  $STALE2 $DEL2"
[ "$STALE2" = "STALE_COUNT=0" ] && ok "复跑无残留" || bad "复跑仍有残留：$STALE2"
[ "$DEL2" = "DELETED=0" ] && ok "复跑未重复删除" || bad "复跑重复删除：$DEL2"
rm -rf "$FIX"

# --------------------------------------------------- 用例 2：安全闸（不删任何东西）
echo ""
echo "=== 用例 2：无法确认 /p/ 回退时必须不删任何文件 ==="
FIX=$(mktemp -d); mkdir -p "$FIX/p"
for id in keep111111111111111 keep222222222222222 stale333333333333333; do
  echo "<html>$id</html>" > "$FIX/p/$id.html"
done
echo '<html data-shell="1"></html>' > "$FIX/p/_shell.html"
printf '<urlset><url><loc>https://coupon.zangeng.com/p/keep111111111111111.html</loc></url></urlset>' > "$FIX/sitemap.xml"

PRUNE_ROOT="$FIX" bash "$SCRIPT" > "$FIX/log.txt" 2>&1
grep -E 'NGINX_T_FAILED|终止|STALE_COUNT|DELETED=' "$FIX/log.txt" | sed 's/^/  /'

[ -f "$FIX/p/stale333333333333333.html" ] && ok "安全闸生效：过期壳未被删" || bad "安全闸失效：过期壳被误删"
[ -f "$FIX/p/keep111111111111111.html" ] && ok "在图页面未被删" || bad "在图页面被误删"
[ -f "$FIX/p/_shell.html" ] && ok "回退壳未被删" || bad "回退壳被误删"
rm -rf "$FIX"

echo ""
[ "$FAIL" = "0" ] && echo "ALL_PASS" || echo "ALL_FAIL"
exit $FAIL
