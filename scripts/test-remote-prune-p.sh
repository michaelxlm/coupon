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
[ ! -f "$FIX/prune-diag.txt" ] && ok "诊断报告未落在站点根目录" || bad "诊断报告落在站点根目录"
rm -rf "$FIX" "$(dirname "$FIX")/.prune-diag"

# ------------------------------------------- 用例 3：vhost 补丁（改生产 nginx，必须有覆盖）
echo ""
echo "=== 用例 3：vhost 补丁（插入 location 块 / 就地插 try_files）==="
SRC=$(mktemp -d); mkdir -p "$SRC/p"
echo '<urlset></urlset>' > "$SRC/sitemap.xml"
# source 被测脚本（PRUNE_LIB_ONLY=1 只暴露函数、不执行 main）
if PRUNE_LIB_ONLY=1 bash -c "source '$SCRIPT'; declare -F vhost_insert_block >/dev/null" 2>/dev/null; then
  ok "成功 source 补丁函数"
else
  bad "无法 source 被测脚本以取用补丁函数"
fi

VH="$SRC/vhost.conf"
cat > "$VH" <<'VCONF'
server
{
    listen 443 ssl;
    server_name coupon.zangeng.com;
    root /www/wwwroot/coupon.zangeng.com;
    location ~* \.html$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
    }
    location / {
        try_files $uri $uri/index.html =404;
    }
    access_log /www/wwwlogs/coupon.zangeng.com.log;
    error_log /www/wwwlogs/coupon.zangeng.com.error.log;
}
VCONF
BLK="$SRC/block.conf"
( PRUNE_LIB_ONLY=1 bash -c "source '$SCRIPT'; write_block '$BLK' 0" >/dev/null 2>&1 )
( PRUNE_LIB_ONLY=1 bash -c "source '$SCRIPT'; vhost_insert_block '$VH' '$BLK'" >/dev/null 2>&1 )
grep -q 'location \^~ /p/' "$VH" && ok "路线2：块已插入 vhost" || bad "路线2：块未插入 vhost"
grep -q 'access_log /www/wwwlogs/coupon.zangeng.com.log;' "$VH" && ok "路线2：原有指令未被破坏" || bad "路线2：原有指令丢失"
[ "$(grep -c '^}' "$VH")" = "1" ] && ok "路线2：server 块闭合括号唯一（插入块已缩进）" || bad "路线2：闭合括号数量异常"
awk '/location \^~ \/p\//{f=1} f&&/^    \}/{exit} f{print}' "$VH" | grep -q 'try_files \$uri /p/_shell.html;' \
  && ok "路线2：try_files 位于 location 块内" || bad "路线2：try_files 未落在块内"

VH2="$SRC/vhost2.conf"
cat > "$VH2" <<'VCONF2'
server
{
    listen 443 ssl;
    location ^~ /p/ {
        add_header Cache-Control "no-cache, must-revalidate" always;
    }
    location / {
        try_files $uri $uri/index.html =404;
    }
}
VCONF2
( PRUNE_LIB_ONLY=1 bash -c "source '$SCRIPT'; vhost_insert_tryfiles '$VH2'" >/dev/null 2>&1 )
grep -q 'try_files \$uri /p/_shell.html;' "$VH2" && ok "路线3：已就地插入 try_files" || bad "路线3：未插入 try_files"
awk '/location \^~ \/p\//{f=1;next} f&&/^}/{exit} f{print}' "$VH2" | grep -q 'try_files' \
  && ok "路线3：try_files 在块内" || bad "路线3：try_files 不在块内"
rm -rf "$SRC"

# ------------------------------- 用例 4：301 表合并（曾因正则截断出非法 nginx 语法）
echo ""
echo "=== 用例 4：p-redirects.conf 合并 ==="
SRC2=$(mktemp -d); mkdir -p "$SRC2/data"
cat > "$SRC2/data/p-redirect-map.json" <<'JMAP'
{"oldsafe11111111111111111111":"6afbe8d7fe4afa6abd8031de","oldsafe22222222222222222222":"6afbe8d7fe4afa6abd8031e4"}
JMAP
# 模拟线上已有的 p-redirects.conf（含一条同 key 但旧目标的条目）
mkdir -p "$SRC2/ext"
cat > "$SRC2/ext/p-redirects.conf" <<'RCONF'
# coupon.zangeng.com · /p/ 旧链 301（safeId(tao_id) → _id）
# 由 scripts/remote-prune-p.sh 依据 data/p-redirect-map.json 生成（2026-11-17）。
location = /p/oldsafe11111111111111111111.html { return 301 /p/6afbe8d7fe4afa6abd8031aa.html; }
location = /p/keepold33333333333333333333.html { return 301 /p/6afbe8d7fe4afa6abd8031bb.html; }
RCONF
BAK="$SRC2/bak.conf"; cp -p "$SRC2/ext/p-redirects.conf" "$BAK"
OUT="$SRC2/merged.conf"
{
  echo "# header"
  {
    if [ -s "$BAK" ]; then grep -vE '^[[:space:]]*#' "$BAK"; fi
    tr ',' '\n' < "$SRC2/data/p-redirect-map.json" \
      | sed -nE 's/^[[:space:]]*\{?[[:space:]]*"([^"]+)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1 \2/p' \
      | awk '$1 != $2 && $1 ~ /^[A-Za-z0-9_-]{1,120}$/ && $2 ~ /^[A-Za-z0-9_-]{1,120}$/ \
             { print "location = /p/" $1 ".html { return 301 /p/" $2 ".html; }" }'
  } | grep -E '^[[:space:]]*location = /p/' | sed 's/^[[:space:]]*//' \
    | awk '{ line[$3] = $0 } END { for (k in line) print line[k] }' | sort
} > "$OUT"

grep -q 'location = /p/keepold33333333333333333333.html { return 301 /p/6afbe8d7fe4afa6abd8031bb.html; }' "$OUT" \
  && ok "用例4：历史条目保留" || bad "用例4：历史条目丢失"
grep -q 'location = /p/oldsafe11111111111111111111.html { return 301 /p/6afbe8d7fe4afa6abd8031de.html; }' "$OUT" \
  && ok "用例4：同 key 取最新目标" || bad "用例4：同 key 未取最新目标"
[ "$(grep -c 'location = /p/oldsafe11111111111111111111.html' "$OUT")" = "1" ] \
  && ok "用例4：无重复 location" || bad "用例4：出现重复 location"
grep -qE 'location = /p/[^ ]+ \{ return 301 [^ ]+; \}$' "$OUT" \
  && ok "用例4：每行均为完整合法的 nginx 指令" || bad "用例4：存在被截断的非法行"
rm -rf "$SRC2"

# ------------------- 用例 5：诊断报告处置口径（不落站点根目录 / 成功即删 / 异常保留）
echo ""
echo "=== 用例 5：诊断报告处置口径 ==="
FIX5=$(mktemp -d); mkdir -p "$FIX5/site/p"; echo '<urlset></urlset>' > "$FIX5/site/sitemap.xml"

DEFAULT_RPT=$( PRUNE_LIB_ONLY=1 PRUNE_ROOT="$FIX5/site" bash -c "source '$SCRIPT'; printf '%s' \"\$REPORT\"" 2>/dev/null )
echo "  默认报告落点：$DEFAULT_RPT"
case "$DEFAULT_RPT" in
  "$FIX5/site/prune-diag.txt") bad "用例5：报告落点仍在站点根目录" ;;
  "$FIX5/.prune-diag/site.txt") ok "用例5：报告落点在站点根目录之外" ;;
  *) bad "用例5：报告落点不符合预期：$DEFAULT_RPT" ;;
esac

RPT5="$FIX5/.prune-diag/site.txt"; mkdir -p "$(dirname "$RPT5")"; : > "$RPT5"
( PRUNE_LIB_ONLY=1 PRUNE_REPORT="$RPT5" bash -c "source '$SCRIPT'; PRUNE_OUTCOME=anomaly; finalize_report" >/dev/null 2>&1 )
[ -f "$RPT5" ] && ok "用例5：异常时报告保留" || bad "用例5：异常时报告被误删"
( PRUNE_LIB_ONLY=1 PRUNE_REPORT="$RPT5" bash -c "source '$SCRIPT'; PRUNE_OUTCOME=ok; finalize_report" >/dev/null 2>&1 )
[ ! -f "$RPT5" ] && ok "用例5：成功时报告清理" || bad "用例5：成功时报告残留"

PRUNE_ROOT="$FIX5/site" bash "$SCRIPT" > "$FIX5/log.txt" 2>&1
[ ! -f "$FIX5/site/prune-diag.txt" ] && ok "用例5：真跑一轮后站点根目录无报告" || bad "用例5：真跑一轮后站点根目录出现报告"
rm -rf "$FIX5" "$(dirname "$FIX5")/.prune-diag"

echo ""
[ "$FAIL" = "0" ] && echo "ALL_PASS" || echo "ALL_FAIL"
exit $FAIL
