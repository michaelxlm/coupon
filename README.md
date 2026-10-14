---
title: 小满券仓（coupon.zangeng.com）
owner: Michaelxlm
updated: 2026-10-13
scope: coupon（coupon.zangeng.com · 京东优惠券聚合静态站）
status: 有效
tags: [coupon, 小满券仓, 优惠券, 纯静态, sourceGuard, 统一埋点, 品类落地页, 收藏, 凑单计算器, 大促日历]
---

# 小满券仓（coupon.zangeng.com）

> 文档治理：本文件是 coupon 唯一项目介绍；跨项目规范与集中文档见 `main/app/docs/`；
> 统一视图见 `main/app/docs/knowledge-base/projects/coupon/README.md`（2026-10-09 纳入知识库）。

> **新功能落点自查（开发前默认动作 · [05 · Part 6 五](../main-api/app/docs/knowledge-base/05-项目优化建议.md#五功能归属与迁移总览)）**：动手前先跑 `node ../main/scripts/feature-placement.js "<功能描述>"` 评估该功能应落哪站 + 各端合规门控；跨站能力单一源见 [`main/shared/capabilities.json`](../main-api/shared/capabilities.json)。

从 `zangeng.com` 剥离出来的**独立优惠券站**，域名 `coupon.zangeng.com`，专门展示京东优惠券数据。
优惠券数据实时来自中台 `main`（`/api/v1/front/coupon/jd/*`），与其他静态站（zangeng / color-tool / visitor / aiWeb / notes / history）**同一套零依赖静态站框架**：手写 HTML + 共享设计令牌 + push-to-deploy。

## 数据来源

- 精选（手选池）：`GET /api/v1/front/coupon/jd/random?limit=10&mainUrl=coupon.zangeng.com`
  由原「全库随机」改为**纯手选池**：只展示管理端「优惠券商品」页导入的京东手选券（`isHandpick='1'`）；
  当中台 `main` 的 `config.taobaoTbk.enable=true` 时，京东手选与淘宝有效券**混合同一榜**（按 `createTime` 倒序截断）。淘宝审核通过后仅切此开关即面客，无需改代码。
- 榜单（日 / 周 / 月）：`GET /api/v1/front/coupon/jd/rank?period=week|month|day&limit=20&mainUrl=coupon.zangeng.com`
  日榜已改为**真时间窗排序**（近 24h 按券面额降序），与精选不再同源。
- 搜索 / 分页：`GET /api/v1/front/coupon/jd/paging?search=关键词&page=1&pageSize=20&mainUrl=coupon.zangeng.com`

> 前台接口经后端字段白名单裁剪（`title/pict_url/item_url/price/couponDiscount/couponQuota/clickURL/couponUrl/tao_id/createTime/updateTime/createdAt`），不再下发 `data/佣金/内部状态位` 等敏感字段。
> 券卡文案消费白名单里的 `couponQuota`+`couponDiscount` 拼「满X减Y」（无门槛回退「券 ¥off」），并用 `createTime` 对 24h 内新券打「今日新增」徽标。

`coupon-page.js` 在每次请求里带上 `mainUrl=coupon.zangeng.com`，经中台 `main` 的 `sourceGuard` 中间件按 `projects.url` 放行（**2026-10-13 已实跑登记并验证 `X-Source-Guard: PASS`**，见下方「验收状态」）。
来源未登记时接口返回空数据（响应头 `X-Source-Guard: BLOCKED`）；登记步骤见下方「上线 checklist」第 3 条。

## 目录

```
coupon/
├── index.html          领券中心页（首页：精选 + 周榜 + 热门品类 chip）
├── browse.html         全部好物（paging 无限加载更多，data-mode=browse）
├── rank.html           榜单（日/周/月 tab + 排序，rank limit=50，data-mode=rank）
├── category.html       品类中心（静态导航 8 品类 → cat/*.html）
├── cat/<slug>.html     品类落地页（build.js 依 categories.json 生成，paging?search=kw）
├── guide.html          领券攻略（HowTo + FAQPage，纯静态内容，含省钱工具交叉链接）
├── calculator.html     凑单省钱计算器（满X减Y 叠加算到手价，WebApplication + FAQPage JSON-LD，支持 ?price=&quota=&off= 预填）
├── holidays.html       全年大促日历（8 档静态内容 + 每年滚动倒数增强，FAQPage + BreadcrumbList）
├── favorites.html      我的收藏（localStorage 收藏 + 最近看过，noindex,follow 不入 sitemap）
├── about.html          关于与免责（AboutPage + 数据来源/合规，纯静态）
├── 404.html            404
├── assets/
│   ├── css/tokens.css  六站共享设计令牌（单一事实来源，勿改品牌令牌）
│   ├── css/main.css    站点组件样式（头部 / 页脚 / 按钮 / 广告位，复用 zangeng 模板）
│   ├── css/coupon.css  优惠券页独有样式（网格 / 券卡 / 满X减Y / 今日新增 / 品类 chip）
│   ├── js/tracker.js   统一埋点 SDK（上报 /api/v1/public/track，默认 project=coupon-zangeng）
│   ├── js/conversion.js 转化与来源归因层
│   ├── js/app.js       站点交互（主题三态 / 移动菜单 / 回到顶部）
│   ├── js/store.js     本地数据层（收藏 coupon_favs / 最近看过 coupon_recent / 搜索历史 coupon_searches，均静默失败）；券卡星标按钮 attachStar + 预渲染卡 enhance
│   ├── js/coupon-page.js 领券中心交互（首页：精选 / 榜单 / 搜索（含 ?s= 直达与搜索历史 chip）/ 分页加载更多 / 星标 / 骨架屏）
│   ├── js/activities.js 官方活动直链卡（拉 /coupon/activity/list，渲染 #cpActs，rel="sponsored noopener"，空池静默隐藏）
│   ├── js/list-page.js  通用列表脚本（browse / rank / category 三模式，按 body data-mode 分支；含到手价区间前端筛选 #listPrice）
│   ├── js/favorites.js  收藏 / 最近看过页渲染（取消收藏、删除、去凑单跳转）
│   ├── js/calculator.js 凑单计算器逻辑（多商品 × 多券叠加，实时算到手价/省钱额，未达门槛提示差多少）
│   ├── js/holidays.js   大促日历倒数（每年滚动重算下一次日期，最近一场高亮；黑五按 11 月第四个周五计算）
│   ├── js/double11.js   双 11 专题交互（大促页券网格增强）
│   └── img/            favicon.svg + og-cover.svg
├── scripts/
│   ├── build.js        构建期委托全站 chrome + 预渲染 index/browse/rank + 生成 cat/*.html + 写 data/coupon-snapshot.json + 重写 sitemap.xml（CI 执行，fail-soft）
│   ├── fingerprint.js  内容哈希指纹（取代 cache-bust.js，部署前把资源引用改写为 <name>.<hash>.<ext>）
│   ├── selfcheck.js    部署前质量门（chrome 标记 / 兜底快照 / 指纹生效，关键项失败阻断 sync）
│   └── archive/cache-bust.js  [已废弃] 手工 ?v= 刷新脚本历史归档，勿再用
├── data/
│   ├── ad-slots.json   自营广告位兜底（远程 OSS 同步 JSON 优先）
│   ├── categories.json 8 品类元数据（slug/name/kw/icon/desc，品类页与 build.js 共用）
│   └── coupon-snapshot.json 构建期兜底快照（首页精选/日周月榜/全部好物/品类按 kw），运行时后端不可达时回退渲染，nginx 放行 `/data/coupon-snapshot.json`
├── deploy/nginx.conf   部署配置（server_name 与证书路径按域名填）
├── robots.txt / sitemap.xml  （sitemap 由 build.js 重写：固定页 + cat/* + guide/calculator/holidays/about，现 16 条；favorites 为 noindex 不入）
└── .github/workflows/deploy.yml  push-to-deploy（39.107 上的 self-hosted runner 执行）
```

## 交互与内容能力（零后端，纯前端 localStorage）

- **收藏星标**：所有券卡（含预渲染静态卡）右上角星标，数据存 `coupon_favs`（上限 100）；`store.js` 统一读写，空间异常（隐私模式等）静默失败。
- **收藏导出 / 导入**：`favorites.html` 支持「导出收藏」下载 JSON 备份、在其它设备「导入收藏」按 id 合并去重（`store.js` 的 `exportFavs`/`importFavs`），弥补 localStorage 无法跨设备的短板。
- **即将失效提醒**：券卡在手价旁显示「N 天后失效 / 即将到期」（数据来自后端 `couponEndTime`，需 main-api 放行该字段后生效；构建期同时从预渲染/快照剔除已过期券）。
- **平台筛选**：京东/淘宝混合榜单支持按平台筛选（后端归并注入 `platform` 后，工具栏自动出现「全部/京东/淘宝」；字段缺失时控件自动隐藏，行为回退为现状）。
- **最近看过**：券卡点击自动记录快照（上限 24），在 `favorites.html` 与首页搜索历史 chip 行下方可见。
- **搜索历史 / 热搜词**：首页提交搜索后存 `coupon_searches`（上限 10）并以 chip 展示；未搜索时展示固定热搜词，均可点 `/?s=关键词` 直达搜索。
- **凑单计算器**：`calculator.html` 多商品 × 多券叠加算到手价；收藏页券卡可一键携带价格/门槛跳转预填（`?price=&quota=&off=`）。
- **大促日历**：`holidays.html` 8 档常规大促静态内容 + 每年滚动倒数；档期为往年规律估算，页面文案已声明“以京东官方公告为准”。
- **体验小件**：到手价区间前端筛选（50 以下 / 50-100 / 100-300 / 300 以上，对已加载集合生效）、骨架屏加载态、回到顶部按钮。
- 埋点新增事件：`fav_toggle` / `fav_remove` / `calc_result`；全站页脚“站点”栏已闭环指向三新页。

## 本地预览

```powershell
npx http-server -p 8080
# 或
python -m http.server 8080
```

然后访问 http://localhost:8080 （优惠券需联网请求 `api.xuyiheng.com`，本地预览同样受 sourceGuard 放行约束，登记后即可正常拉取）。

> `cat/*.html` 品类落地页由 `build.js` 生成，本地首次预览若想看到品类页需先跑 `node scripts/build.js`（未跑不 404，但 `category.html` 链接会指向尚不存在的 cat 页）。

## 构建与缓存规范

站体仍为纯静态托管（HTML 直加源文件），但新增一个**部署前的可选预渲染步骤**（为让券内容可被百度等弱 JS 搜索引擎索引）：

1. **预渲染与生成（CI 自动）**：`.github/workflows/deploy.yml` 在 `checkout` 后、`sync` 前执行 `node scripts/build.js`。**全站 chrome（WO-86）**：`injectChrome()` 先把 10 张手写页（index/browse/rank/category/guide/calculator/holidays/favorites/about/404）的 `<header>/<footer>` 在 `CHROME:HEADER/FOOTER` 标记内整段委托 `shared-partials` 的 `renderHeader/renderFooter` 渲染（`STATIC_PAGES` 定义各页导航高亮，cat 页由 `catPageShell` 同样委托）——与历史/notes/zangeng 共单一源，实现「六站一处改 chrome 生效」，标记内覆盖、重跑幂等。随后一次拉取后端：将首页（精选+周榜去重）、`browse.html`（paging 前 20）、`rank.html`（周榜前 50）写入各自 `PRERENDER:GRID` 标记的券网格并注入 `ItemList/Product/Offer` JSON-LD；再依 `data/categories.json` 的关键词生成 `cat/<slug>.html` 品类落地页（**页面壳每次写盘**，即使接口不可达也不 404，仅网格 fail-soft 留空）；最后重写 `sitemap.xml`（固定页 + `cat/*` + `guide`/`about`，`lastmod=当日`）。脚本 fail-soft：上游不可达 / 未取到券时保持原有 HTML 壳，绝不阻断部署。运行时 `coupon-page.js`（首页）/ `list-page.js`（browse/rank/category）会清空重绘（渐进增强，禁 JS 仍可读到预渲染内容）。
2. **内容哈希指纹（取代 cache-bust.js）**：部署前 `node scripts/fingerprint.js` 把本地 `css/js/图片/字体` 复制为 `<name>.<hash>.<ext>` 并改写 HTML/CSS 引用，配 Nginx 对 `/assets/**` 的 `immutable` 长缓存实现「内容变 URL 变、无手工版本号」的最优缓存。`cache-bust.js` 已归档至 `scripts/archive/`，不再使用。
3. **兜底快照（运行时韧性）**：`build.js` 随每次构建写出 `data/coupon-snapshot.json`（首页精选 / 日周月榜 / 全部好物 / 品类按 `data-kw`），`nginx.conf` 已放行该路径（`no-cache`）。当 `api.xuyiheng.com` 抖动 / 被墙导致前端 fetch 失败时，`coupon-page.js` / `list-page.js` 自动回退渲染该快照，整页不再空白。
4. **定时重建**：`deploy.yml` 除 `push` 外增加每日 `schedule`（UTC `20 0,8 * * *` ≈ 北京 08:20 / 16:20）重跑 build + 指纹 + sync，使优惠券（时效短）在搜索引擎侧保持新鲜，无需手动 push。

## 上线 checklist（缺一不可）

1. **DNS**：在域名服务商把 `coupon.zangeng.com` 的 A 记录指向 `60.205.214.88`（与 zangeng.com 同 IP）。
2. **Nginx（宝塔面板 · 60.205）**：生产用宝塔(BT)托管，vhost 为 `/www/server/panel/vhost/nginx/html_coupon.zangeng.com.conf`，`root /www/wwwroot/coupon.zangeng.com`，证书在 `/www/server/panel/vhost/cert/coupon.zangeng.com/`。**不要**把仓库 `deploy/nginx.conf` 复制到 `/etc/nginx/conf.d/`（root/证书路径不符会打挂站点）；该文件仅作「期望规则」参考。安全响应头（含 WO-84 `CSP frame-ancestors`）已写入 `extension/coupon.zangeng.com/security.conf` 并 reload 生效（2026-10-13 实跑：`X-Content-Type-Options`/`Referrer-Policy`/`CSP` 均已下发，首页与 `/data/coupon-snapshot.json` 均 200）。
3. **来源登记（关键）**：在本机 / 服务器跑中台 main 的登记脚本，把 `coupon.zangeng.com` 写入 `projects` 集合：
   ```bash
   cd main-api
   export MAIN_MONGO_URL='mongodb://<user>:<pass>@<host>:<port>/main'
   node scripts/register-static-projects.js --only=coupon
   # 验证：curl -I "https://api.xuyiheng.com/api/v1/front/coupon/jd/random?limit=3&mainUrl=coupon.zangeng.com"
   # 期望响应头 X-Source-Guard: PASS（BLOCKED 说明未登记 / 开关未归位）
   ```
   该来源已加入 `scripts/register-static-projects.js` 的 `TARGETS`（key=`coupon`，url=`coupon.zangeng.com`）。
4. **GitHub 仓库 + runner**：在 GitHub `michaelxlm` 下新建仓库 `coupon`；在 39.107 的 self-hosted runner 上注册一个仓库级 runner（标签 `static-deploy`），做法同其他静态站：
   ```bash
   # 复制已有 runner 二进制（避免重装）
   robocopy C:\actions-runner\zangeng C:\actions-runner\coupon /E /XD _work _diag /XF .runner .credentials
   # 用 gh 拿 registration-token 后
   .\config.cmd --url https://github.com/michaelxlm/coupon --token <TOKEN> --labels static-deploy --name coupon-runner --unattended
   ```
   注意：本机 Windows runner 无 rsync 且远端无 gzip，workflow 已采用未压缩 `tar cf - | ssh`（不要改回 rsync / `-z`）。
5. **管理端（可选）**：`coupon.zangeng.com` 已加入中台 `main` `config.deploy.projects`，可在管理端「静态站部署」页一键触发（需 39.107 设 `GITHUB_DEPLOY_TOKEN`）。
6. **推送即部署**：`git push` 到 `main` 分支即触发 `deploy.yml`，把仓库同步到 `60.205:/www/wwwroot/coupon.zangeng.com`。

## 验收状态（2026-10-13）

来源守卫登记、广告三域分离、官方活动直链卡三项已于 2026-10-13 实跑验收（证据与口径见知识库 `projects/coupon/README.md`）：

- **来源守卫登记（项 2）**：中台 `scripts/register-static-projects.js --audit` **7/7 PASS**，`coupon.zangeng.com` 已登记（`status='0'` `cheatSwitch='1'` `platform='h5'`）；线上 `GET /coupon/jd/random?mainUrl=coupon.zangeng.com` 返回 `HTTP 200` + `X-Source-Guard: PASS`。
- **官方活动直链卡（项 4 / WO-90）**：线上 `GET /coupon/activity/list?mainUrl=coupon.zangeng.com` 返回 `HTTP 200` + `PASS` + `list.Count=8`（taobao×2 / jd×6，均带官方直链）；`assets/js/activities.js` 拉取同接口、渲染 `#cpActs`、`rel="sponsored noopener"`，与中台 `service/coupon/activity.js` 字段白名单（`title/cover/url/platform/tag/startAt/endAt`）对齐。
- **广告三域分离（项 3）**：`scripts/check-coupon-ads.js` 实跑 **14/14 通过**（六站兜底 JSON 无 `type=coupon` + `OWN_TYPES=['self','domain','next']` 不含 coupon + 部署 `ad-slots.js` 0 处 coupon 残留）；本站 `data/ad-slots.json` 仅 `self` 同族互推，券内容走独立接口不回流广告位。
- **待改进（非阻塞）**：`main/scripts/check-coupon-ads.js` 的 `SITES` 列表未含 `coupon`，故该门禁不扫描本站兜底 JSON；建议把 `coupon` 加入 `SITES`（路径 `data/ad-slots.json`、探针 `index.html`）以闭环解耦守护（该项在 `main-api` 仓库，不在本站）。

## 改造落地（2026-10-13 评估后实施）

针对「单点故障 / SEO 时效 / 缓存漂移 / 质量门缺失」四项，已完成以下改造（代码已落仓库，待部署生效）：

- **兜底快照（运行时韧性）**：`build.js` 随构建写出 `data/coupon-snapshot.json`（首页精选 / 日周月榜 / 全部好物 / 品类按 `data-kw`），`nginx.conf` 已放行该路径；前端 `coupon-page.js` / `list-page.js` 在 `api.xuyiheng.com` fetch 失败时自动回退渲染，整页不再空白。
- **定时重建**：`deploy.yml` 增加每日 `schedule`（UTC `20 0,8 * * *` ≈ 北京 08:20 / 16:20）重跑 build + fingerprint + sync，保持 SEO 内容新鲜。
- **JSON-LD 质量**：`build.js` 的 Product/Offer `description` 改为用真实标题生成（不再千篇一律兜底文案），京东图走 `pict_url`，富媒体摘要更准。
- **缓存归一**：移除 `build.js` 写死的 `?v=` token，`cache-bust.js` 归档至 `scripts/archive/`，版本指纹统一由 `fingerprint.js` 管理。
- **质量门**：新增 `scripts/selfcheck.js`（chrome 标记 / 快照合法 / 指纹生效校验），接入 `deploy.yml` 在 sync 前运行，关键项失败阻断部署。

**第二批（内容质量 + 功能增强）：**

- **死链券过滤**：`build.js` 新增 `isLinkable`/`usable`，预渲染 / JSON-LD / 兜底快照统一剔除无跳转链接的死卡（运行时本会渲成不可点的 `is-dead`），提升索引与摘要质量。
- **兜底提示带快照时间**：前端回退文案追加快照 `updatedAt`（如「构建快照 2026-10-13 08:20」），让用户知道兜底数据有多旧。
- **收藏导出 / 导入**：`favorites.html` 支持导出 JSON 备份、跨设备按 id 合并导入（`store.js` `exportFavs`/`importFavs`），埋点 `fav_export`/`fav_import`。

**第三批（消费后端新字段 · 需 main-api 放行并重启后生效）：**

- **「即将失效」徽标**：`build.js` 与运行时 `coupon-page.js`/`list-page.js` 消费 `couponEndTime`，3 天内到期显示「N 天后失效 / 即将到期」；`usable()` 构建期剔除已过期券。
- **平台筛选**：消费归并时注入的 `platform`（jd/taobao），首页与 browse/rank/category 页工具栏动态注入「全部/京东/淘宝」（仅数据带 `platform` 时显示）。main-api 未重启前字段缺失，控件自动隐藏、无空筛。

> **WO-56 可达性（2026-10-13 更新）**：coupon.zangeng.com 已在 60.205 宝塔上线并返回 `200`（vhost `html_coupon.zangeng.com.conf`，证书 10-08 签发），「站点不可达」结论已不成立。仍需验证的是**百度抓取与收录**：用 `site:coupon.zangeng.com` + 爬虫 UA `curl` 确认搜索引擎侧可达（服务端 200 ≠ 已被收录）。

## 合规

- 优惠券展示与核销由京东 / 折淘客完成，本站仅作内容聚合与跳转，不参与交易（页脚与卡片均标注 `rel="sponsored noopener"`）。
- 沿用 zangeng 同主域 ICP 备案号 `京ICP备18062653号-26`（同主域子站点共用；页脚由 `scripts/build.js` 的 `COUPON_SITE.icp` 经 shared-partials `renderFooter` 渲染）。

## 与 zangeng.com 原 coupon.html 的关系

原 `zangeng.com/coupon.html` 的领券逻辑（`zangeng/assets/js/coupon-page.js`）已整体迁移到本仓库：`index.html` + `assets/js/coupon-page.js`（`MAIN_URL` 改为 `coupon.zangeng.com`）。原 zangeng 页可保留为跳转入口，或直接 301 到本域名。
