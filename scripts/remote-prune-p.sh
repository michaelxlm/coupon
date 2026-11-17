#!/usr/bin/env bash
# ============================================================================
# remote-prune-p.sh · 远端收尾：修复 /p/ 回退 + 按 sitemap 差集清理过期详情页
# ----------------------------------------------------------------------------
# 背景（2026-11-17 实测，线上 coupon.zangeng.com）：
#   build.js 3.5 节已在 CI 工作区删除「不在本轮 detailIds/sitemap 的 /p/*.html」，
#   但 deploy.yml 的 sync 用 `tar xmf -` 增量覆盖 —— 只新增/覆盖、不删除远端多余文件。
#   于是历史轮次累计的旧壳（实测 553 条）永远残留在 60.205 上，并继续以独立静态页
#   对外返回 200（巡检口径 sitemapUnlisted）。本脚本在 sync 之后补上「删除」这一环。
#
# 权威清单：远端「刚被 sync 覆盖的 sitemap.xml」——即本轮 build 产出的清单。
#
# 三段式，全部自带安全闸：
#   A. 诊断：nginx 生效配置里 /p/ 是否已有「缺失文件回退 /p/_shell.html」。
#   B. 修复（仅当 A 判定缺失且可安全落地时）：写 extension conf → nginx -t 校验
#      → reload → 本地 curl 复验；任一环节失败即回滚并放弃，绝不删文件。
#   C. 清理（仅当 /p/ 回退已被复验为可用时）：按 sitemap 差集删除过期壳。
#      绝不删除 /p/_shell.html；清单缺失/为空 → 一律不删。
#
# 幂等：重复执行无副作用（清单与磁盘一致时 STALE_COUNT=0）。
#
# 用法（由 deploy.yml 在 sync 之后调用）：
#   ssh root@60.205.214.88 'bash -s' < scripts/remote-prune-p.sh
# ============================================================================
set -uo pipefail

ROOT="${PRUNE_ROOT:-/www/wwwroot/coupon.zangeng.com}"
VHOST_DIR="${PRUNE_VHOST_DIR:-/www/server/panel/vhost/nginx}"
VHOST="$VHOST_DIR/html_coupon.zangeng.com.conf"
EXT="${PRUNE_EXT:-$VHOST_DIR/extension/coupon.zangeng.com}"
PROBE="/p/__prune_probe_$$.html"
HOSTNAME_SITE="coupon.zangeng.com"
# PRUNE_SKIP_NGINX=1 时跳过 A/B/B2 三段（仅本地对夹具做删除逻辑回归用）
SKIP_NGINX="${PRUNE_SKIP_NGINX:-0}"

KEEP_LIST=$(mktemp)
STALE_LIST=$(mktemp)
CONF_BAK=$(mktemp)
trap 'rm -f "$KEEP_LIST" "$STALE_LIST" "$CONF_BAK"' EXIT

cd "$ROOT" || { echo "[prune] 致命：远端站点根目录不存在：$ROOT"; exit 1; }

# ------------------------------------------------------------------ 工具函数
find_nginx_bin() {
  local BIN
  for BIN in "nginx" "/www/server/nginx/sbin/nginx" "/usr/local/nginx/sbin/nginx"; do
    if command -v "$BIN" >/dev/null 2>&1 || [ -x "$BIN" ]; then echo "$BIN"; return 0; fi
  done
  return 1
}

nginx_reload() {
  local BIN
  BIN=$(find_nginx_bin) || return 1
  "$BIN" -s reload >/dev/null 2>&1 && return 0
  systemctl reload nginx >/dev/null 2>&1 && return 0
  /etc/init.d/nginx reload >/dev/null 2>&1 && return 0
  return 1
}

nginx_test() {
  local BIN
  BIN=$(find_nginx_bin) || return 1
  "$BIN" -t >/dev/null 2>&1
}

# nginx 生效配置里 `location ^~ /p/` 块内是否有 try_files → /p/_shell.html
detect_fallback() {
  [ -n "${1:-}" ] || return 1
  printf '%s\n' "$1" | awk '
    /location[[:space:]]+\^~[[:space:]]+\/p\// { inblk=1; n=0; next }
    inblk {
      n++
      if (n > 20) { inblk=0 }
      else if ($0 ~ /try_files[^;]*\/p\/_shell\.html/) { found=1; inblk=0 }
    }
    END { print found+0 }'
}

# 本地 curl 复验：缺失的 /p/<id> 应回退到壳（200 + data-shell="1"）
verify_fallback_http() {
  local body code
  body=$(mktemp)
  code=$(curl -sk --resolve "$HOSTNAME_SITE:443:127.0.0.1" \
        -o "$body" -w '%{http_code}' "https://$HOSTNAME_SITE$PROBE" 2>/dev/null || echo 000)
  if [ "$code" = "200" ] && grep -q 'data-shell="1"' "$body"; then rm -f "$body"; return 0; fi
  echo "    复验未过：HTTP $code"
  rm -f "$body"; return 1
}

# ===================================================================== A 诊断
echo "=== [prune] A. 诊断 nginx /p/ 路由 ==="
if [ "$SKIP_NGINX" = "1" ]; then
  echo "PRUNE_SKIP_NGINX=1：跳过 nginx 诊断/修复段"
  HAS_FALLBACK=1
  HAS_P_BLOCK=0; HAS_SHELL_LOC=0; EXT_INCLUDED=0
  NGINX_T=""
else
NGINX_T=$(nginx -T 2>/dev/null)
if [ -z "$NGINX_T" ]; then
  echo "NGINX_T_FAILED：读不到 nginx 生效配置"
  echo "=== [prune] 终止：诊断不清楚就不动线上 ==="
  exit 0
fi

HAS_FALLBACK=$(detect_fallback "$NGINX_T")
HAS_P_BLOCK=$(printf '%s\n' "$NGINX_T" | grep -cE 'location[[:space:]]+\^~[[:space:]]+/p/')
HAS_SHELL_LOC=$(printf '%s\n' "$NGINX_T" | grep -cE 'location[[:space:]]+=[[:space:]]+/p/_shell\.html')
EXT_INCLUDED=$(printf '%s\n' "$NGINX_T" | grep -cE 'include[^;]*extension/coupon\.zangeng\.com')
echo "P_LOCATION_FALLBACK=$HAS_FALLBACK  (1=缺失文件会回退到 /p/_shell.html)"
echo "HAS_P_LOCATION_BLOCK=$HAS_P_BLOCK"
echo "HAS_SHELL_EXACT_LOCATION=$HAS_SHELL_LOC"
echo "EXT_INCLUDED_BY_NGINX=$EXT_INCLUDED"
echo "--- 生效配置里的 /p/ 相关 location ---"
printf '%s\n' "$NGINX_T" | grep -nE 'location[[:space:]]+[^;{]*/p/' | head -10
echo "--- extension include 行 ---"
printf '%s\n' "$NGINX_T" | grep -nE 'include[^;]*extension/coupon\.zangeng\.com' | head -5
echo "--- extension 目录 ---"
if [ -d "$EXT" ]; then ls -1 "$EXT" | head -20; else echo "EXT_DIR_MISSING: $EXT"; fi
fi # end SKIP_NGINX

# ===================================================================== B 修复
if [ "$HAS_FALLBACK" != "1" ] && [ "$SKIP_NGINX" != "1" ]; then
  echo ""
  echo "=== [prune] B. 尝试修复 /p/ 回退（缺回退壳则旧链会 404，清理前必须先修）==="
  if [ "$HAS_P_BLOCK" != "0" ]; then
    echo "SKIP：已存在 location ^~ /p/ 块但缺 try_files —— 需人工改 vhost，不自动覆盖"
    echo "      （重复 location 会让 nginx -t 失败，故此处不写 extension）"
  elif [ "$EXT_INCLUDED" = "0" ] || [ ! -d "$EXT" ]; then
    echo "SKIP：extension 目录未被 nginx include 或目录不存在 —— 需人工改 vhost"
    echo "      期望 vhost 内含：include $EXT/*.conf;"
  else
    CONF="$EXT/p-fallback.conf"
    [ -f "$CONF" ] && cp -p "$CONF" "$CONF_BAK"
    {
      echo "# coupon.zangeng.com · /p/ 券详情页：静态优先 + 动态回退壳（同 URL 恒不 404）"
      echo "# 由 scripts/remote-prune-p.sh 生成（2026-11-17）。缺失的 /p/<id> 回退到"
      echo "# /p/_shell.html，由 detail-shell.js 水合最新券数据。"
      echo "# ^~ 前缀必需：否则被上方 location ~* .html\$ 正则抢匹配，缺失文件直接 404。"
      if [ "$HAS_SHELL_LOC" = "0" ]; then
        echo "location = /p/_shell.html {"
        echo "    add_header Cache-Control \"no-cache\" always;"
        echo "}"
      fi
      echo "location ^~ /p/ {"
      echo "    try_files \$uri /p/_shell.html;"
      echo "    add_header Cache-Control \"no-cache, must-revalidate\" always;"
      echo "}"
    } > "$CONF"
    echo "已写入 $CONF"

    if ! nginx_test; then
      echo "nginx -t 失败 —— 回滚 conf，不 reload，不删任何文件"
      if [ -s "$CONF_BAK" ]; then cp -p "$CONF_BAK" "$CONF"; else rm -f "$CONF"; fi
    elif ! nginx_reload; then
      echo "reload 失败 —— 回滚 conf，不删任何文件"
      if [ -s "$CONF_BAK" ]; then cp -p "$CONF_BAK" "$CONF"; else rm -f "$CONF"; fi
    elif ! verify_fallback_http; then
      echo "reload 后复验未通过（缺失 /p/ 未回退到壳）—— 回滚 conf，不删任何文件"
      if [ -s "$CONF_BAK" ]; then cp -p "$CONF_BAK" "$CONF"; else rm -f "$CONF"; fi
      nginx_reload || true
    else
      echo "修复成功：/p/ 缺失文件已回退到 /p/_shell.html（curl 复验 200 + data-shell=\"1\"）"
      HAS_FALLBACK=1
    fi
  fi
fi

# ======================================================== B2 生成 301 旧链表
echo ""
echo "=== [prune] B2. 旧链 301 表（safeId → _id）==="
if [ -f data/p-redirect-map.json ] && [ "$EXT_INCLUDED" != "0" ] && [ -d "$EXT" ]; then
  CONF2="$EXT/p-redirects.conf"
  [ -f "$CONF2" ] && cp -p "$CONF2" "$CONF_BAK"
  {
    echo "# coupon.zangeng.com · /p/ 旧链 301（safeId(tao_id) → _id）"
    echo "# 由 scripts/remote-prune-p.sh 依据 data/p-redirect-map.json 生成（2026-11-17）。"
    # 保留历史条目，只追加新条目（sort -u 去重）
    if [ -s "$CONF_BAK" ]; then grep -oE 'location = /p/[^ ]+\.html \{ return 301 [^;]+;' "$CONF_BAK"; fi
    tr ',' '\n' < data/p-redirect-map.json \
      | sed -nE 's/^[[:space:]]*"([^"]+)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1 \2/p' \
      | awk '$1 != $2 && $1 ~ /^[A-Za-z0-9_-]{1,120}$/ && $2 ~ /^[A-Za-z0-9_-]{1,120}$/ \
             { print "location = /p/" $1 ".html { return 301 /p/" $2 ".html; }" }' \
      | sort -u
  } > "$CONF2"
  CNT=$(grep -cE '^location = /p/' "$CONF2" 2>/dev/null || echo 0)
  echo "p-redirects.conf 条目数：$CNT"
  if nginx_test; then
    if nginx_reload; then
      echo "301 表已生效"
    else
      echo "reload 失败 —— 回滚 301 表"
      if [ -s "$CONF_BAK" ]; then cp -p "$CONF_BAK" "$CONF2"; else rm -f "$CONF2"; fi
    fi
  else
    echo "nginx -t 失败 —— 回滚 301 表，不 reload"
    if [ -s "$CONF_BAK" ]; then cp -p "$CONF_BAK" "$CONF2"; else rm -f "$CONF2"; fi
  fi
else
  echo "SKIP：无 data/p-redirect-map.json 或 extension 未被 include，跳过 301 表"
fi

# ===================================================================== C 清理
echo ""
echo "=== [prune] C. 按 sitemap 差集清理过期详情页 ==="
if [ ! -d p ]; then echo "NO_P_DIR（无需清理）"; exit 0; fi
TOTAL=$(find p -maxdepth 1 -type f -name '*.html' ! -name '_shell.html' | wc -l | tr -d ' ')
echo "P_HTML_BEFORE=$TOTAL"

if [ ! -f sitemap.xml ]; then
  echo "NO_SITEMAP：远端无 sitemap.xml，无法确定权威清单 —— 不做任何删除"
  exit 0
fi
grep -oE '<loc>[^<]*/p/[^<]*\.html</loc>' sitemap.xml \
  | sed -e 's|<loc>||' -e 's|</loc>||' -e 's|.*/||' \
  | sort -u > "$KEEP_LIST"
KEEP_N=$(wc -l < "$KEEP_LIST" | tr -d ' ')
echo "SITEMAP_KEEP=$KEEP_N"
if [ "$KEEP_N" -eq 0 ]; then
  echo "SITEMAP_EMPTY：sitemap.xml 里没有任何 /p/ 条目 —— 视为清单异常，不做任何删除"
  exit 0
fi

find p -maxdepth 1 -type f -name '*.html' ! -name '_shell.html' | while read -r f; do
  b=$(basename "$f")
  grep -qxF "$b" "$KEEP_LIST" || echo "$b"
done > "$STALE_LIST"
STALE_N=$(wc -l < "$STALE_LIST" | tr -d ' ')
echo "STALE_COUNT=$STALE_N（磁盘有、sitemap 无 = 待清理的过期壳）"
if [ "$STALE_N" -gt 0 ]; then
  echo "--- 待删清单（前 20）---"
  head -20 "$STALE_LIST"
fi

if [ "$HAS_FALLBACK" != "1" ]; then
  echo "=== [prune] 跳过删除：线上 /p/ 未确认回退到 _shell.html ==="
  echo "=== [prune] 删了会让旧链变 404 坏链；请先修 p-fallback.conf 并 nginx -t && reload ==="
  exit 0
fi

echo "--- 执行删除 ---"
while read -r b; do
  [ -n "$b" ] || continue
  rm -f "p/$b" || echo "[warn] 删除失败：p/$b"
done < "$STALE_LIST"

AFTER=$(find p -maxdepth 1 -type f -name '*.html' ! -name '_shell.html' | wc -l | tr -d ' ')
SHELL_OK=$([ -f p/_shell.html ] && echo yes || echo no)
echo "P_HTML_AFTER=$AFTER"
echo "DELETED=$((TOTAL - AFTER))"
echo "SHELL_KEPT=$SHELL_OK"

# 复验：抽一条已删的 URL，应回退到壳（200 + data-shell="1"）
FIRST=$(head -1 "$STALE_LIST" 2>/dev/null || true)
if [ -n "$FIRST" ]; then
  BODY=$(mktemp)
  CODE=$(curl -sk --resolve "$HOSTNAME_SITE:443:127.0.0.1" -o "$BODY" -w '%{http_code}' \
         "https://$HOSTNAME_SITE/p/$FIRST" 2>/dev/null || echo 000)
  if grep -q 'data-shell="1"' "$BODY"; then
    echo "POSTCHECK: /p/$FIRST → HTTP $CODE + 壳（回退正常，旧链不 404）"
  else
    echo "POSTCHECK: /p/$FIRST → HTTP $CODE（未回退到壳，需复核）"
  fi
  rm -f "$BODY"
fi
echo "=== [prune] 完成：磁盘详情页与 sitemap 清单已对齐 ==="
