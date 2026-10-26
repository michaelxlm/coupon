---
title: 小满券仓（coupon.zangeng.com）
owner: Michaelxlm
updated: 2026-10-26
scope: coupon（coupon.zangeng.com · 京东/淘宝优惠券聚合静态站）
status: 有效
tags: [coupon, 小满券仓, 优惠券, 纯静态, sourceGuard, 统一埋点, 品类落地页, 收藏, 凑单计算器, 大促日历, 券详情页, 扫码海报, 降价热榜, 长文导购, 降价提醒, 小程序码引导, 省钱挑战, 导航单一源, 视觉审计]
---

# 小满券仓（coupon.zangeng.com）

> 文档治理：本文件是 coupon 唯一项目介绍；跨项目规范与集中文档见 `main/app/docs/`；
> 统一视图见 `main/app/docs/knowledge-base/projects/coupon/README.md`（2026-10-09 纳入知识库）。

> **新功能落点自查（开发前默认动作 · [05 · Part 6 五](../main-api/app/docs/knowledge-base/05-项目优化建议.md#part-6--跨平台功能划分与归属存量已迁出--仅留开放动作)）**：动手前先跑 `node ../main/scripts/feature-placement.js "<功能描述>"` 评估该功能应落哪站 + 各端合规门控；跨站能力单一源见 [`main/shared/capabilities.json`](../main-api/shared/capabilities.json)。

从 `zangeng.com` 剥离出来的**独立优惠券站**，域名 `coupon.zangeng.com`，专门展示京东优惠券数据。
优惠券数据实时来自中台 `main`（`/api/v1/front/coupon/jd/*`），与其他静态站（zangeng / color-tool / visitor / aiWeb / notes / history）**同一套零依赖静态站框架**：手写 HTML + 共享设计令牌 + push-to-deploy。

## 数据来源

- 精选（手选池）：`GET /api/v1/front/coupon/jd/random?limit=10&mainUrl=coupon.zangeng.com`
  由原「全库随机」改为**纯手选池**：只展示管理端「优惠券商品」页导入的京东手选券（`isHandpick='1'`）；
  当中台 `main` 的 `config.taobaoTbk.enable=true` 时，京东手选与淘宝有效券**混合同一榜**（按 `createTime` 倒序截断）。淘宝审核通过后仅切此开关即面客，无需改代码。
- 榜单（日 / 周 / 月）：`GET /api/v1/front/coupon/jd/rank?period=week|month|day&limit=20&mainUrl=coupon.zangeng.com`
  日榜已改为**真时间窗排序**（近 24h 按券面额降序），与精选不再同源。
- 搜索 / 分页：`GET /api/v1/front/coupon/jd/paging?search=关键词&page=1&pageSize=20&mainUrl=coupon.zangeng.com`
- 历史低价走势（券详情页走势迷你图）：`GET /api/v1/front/coupon/jd/priceTrend?tao_id=&limit=30`；批量 `jd/priceBatch?ids=a,b,c`
- 今日降价 TopN（`/drops.html` 正式版数据源）：`GET /api/v1/front/coupon/jd/topDrops?limit=24&mainUrl=coupon.zangeng.com`——近 48h `priceHistory` 两日快照对比（到手价降 / 券面额加码），商品字段实时富化
- 优惠券长文（`/guides/*` 预渲染数据源，对齐 `ad` 线无鉴权只读模式）：`GET /api/v1/front/coupon/content/list?page=1&pageSize=20`、`GET /api/v1/front/coupon/content/detail?slug=`——读 `Automate.couponMaterial`（`businessLine='coupon'`，`generated/published` 态），经 `sourceGuard` 按 `mainUrl` 放行、字段白名单裁剪
- 场景导购 AI 导语（WO-125，`/topic/*` 预渲染数据源）：`GET /api/v1/front/coupon/content/topicIntro?slug=phone&kw=手机&title=…`——读 `Automate.couponTopicIntro` 缓存（TTL 30 天，`tier='light'` 只生成一次即复用）；slug 白名单由 `config.couponFront.topicIntroSlugs` 控制（与 `scripts/topics.json` 同步维护），非白名单直接 `null`；AI 不可用/生成失败同样返回 `null`，构建回落静态导语
- 降价提醒（匿名 deviceId）：`POST /coupon/alert/subscribe|unsubscribe`、`GET /coupon/alert/list?deviceId=`——**仅本机清单/降价高亮数据层**；**Web Push 已下线**（大陆 Chrome 走 Google FCM、prod 到 `fcm.googleapis.com:443` 不可达、投递恒失败），券到期/大额/降价提醒改引导至小程序：`GET /coupon/mpcode?tao_id=&mainUrl=`（带参小程序码：入参 `tao_id`，后端跨京东/淘宝归并集反查得券 `_id`，以其 24hex 作 `getUnlimited` scene（`tao_id` 达 46 字超 scene 32 上限），实测返回 JPEG、按字节魔数定类型，Redis 缓存 30 天）、`GET /coupon/jd/detail?id=`（小程序 `onLoad` 读 scene=`_id` 还原当前券）

> 上述三项 W2/W3 新接口（`jd/topDrops`、`content/list`、`content/detail`）已在中台 `app/router/api/v1/front/coupon/router.js` 落地。**依赖数据现状**：`couponPriceHistories` 每日快照尚未积累（现为 0）、`couponMaterial` 存量全为 `approved` 无 `published`，故上线初期 `topDrops` / `content/list` 会返回空——前端一律 fail-soft：`/drops.html` 回落预渲染力度榜 + 快照兜底、`/guides.html` 渲染空态索引壳（仍写盘不 404）、详情页走势图为空，**均不阻断部署**。待快照与发布态内容就绪即自动接通。

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
├── category.html       品类中心（静态导航 21 品类 → cat/*.html）
├── cat/<slug>.html     品类落地页（build.js 依 categories.json 生成，paging?search=kw）
├── guide.html          领券攻略（HowTo + FAQPage，纯静态内容，含省钱工具交叉链接）
├── calculator.html     凑单省钱计算器（满X减Y 叠加算到手价，WebApplication + FAQPage JSON-LD，支持 ?price=&quota=&off= 预填）
├── holidays.html       全年大促日历（8 档静态内容 + 每年滚动倒数增强，FAQPage + BreadcrumbList）
├── favorites.html      我的收藏（localStorage 收藏 + 最近看过，noindex,follow 不入 sitemap）
├── drops.html          今日降价热榜（W2/W3，data-mode=drops：topDrops 接口优先→预渲染力度榜→快照兜底，每张可一键生成扫码战报）
├── guides.html         长文导购索引（W3，CollectionPage JSON-LD；接口无发布文章时为空态壳，仍写盘不 404）
├── guides/<slug>.html  长文导购页（W3，build.js 拉 /content/list 预渲染 AI 流水线长文，Article + BreadcrumbList JSON-LD）
├── topic/<slug>.html   场景导购页（WO-125，build-topics.js 预渲染：AI 场景导语 + 实时比价 TOP8 + 券卡网格 + FAQ；CollectionPage + ItemList + FAQPage JSON-LD）
├── topic/index.html    场景导购索引（WO-125，build-topics.js 由 topic-index-template.html 生成：7 个场景入口 + CollectionPage/ItemList JSON-LD）
├── p/<tao_id>.html     券详情页（W1，build.js 依榜单/精选合集逐券写盘，Product+Offer+BreadcrumbList，含价格走势/订阅提醒/扫码分享）
├── my-alerts.html      我的降价提醒中心（W5，noindex：列本机 deviceId 订阅 + 当前力度对比 + 「去小程序订阅提醒」引导卡，每张已订阅券内嵌带参小程序码；web-push 已下线）
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
│   ├── js/qrcode.js     零依赖 QR 编码器（自实现 Nayuki 移植，v1–15 / EC-M / GF(256)，无网络，供海报二维码）
│   ├── js/share.js      扫码战报海报（canvas 版式对齐品牌色；深链指向站内 /p/<id>，右下渲染 qrcode 二维码；支持自定义大字 power/sub）
│   ├── js/detail-page.js 券详情页交互（fetch /jd/priceTrend 走势迷你图、订阅降价提醒、分享海报、相关推荐；全程 fail-soft）
│   ├── js/drops-page.js 降价热榜页交互（三级数据源：topDrops 接口→预渲染 priceBatch 标记→快照兜底；打 drops_view）
│   ├── js/my-alerts.js  降价提醒中心（读 alert/list + snapshot.detailIds 白名单给详情入口 + 每张已订阅券内嵌带参小程序码引导至小程序；web-push 已下线）
│   └── js/challenge.js  今日省钱挑战（纯 localStorage 连续回访 streak + 累计省钱，里程碑一键晒战报，仅首页，fail-soft）
│   └── img/            favicon.svg + og-cover.svg
├── scripts/
│   ├── build.js        构建期委托全站 chrome + 预渲染 index/browse/rank + 生成 cat/*.html + 写 data/coupon-snapshot.json + 存量 p/guides chrome 对齐 + 重写 sitemap.xml（CI 执行，fail-soft）
│   ├── site-config.js  站点导航/页脚单一源（7 项主导航 + 12 项页脚），build.js / build-topics.js / topic 模板共用，改菜单只改这一处
│   ├── build-topics.js 场景导购页生成器（WO-125：按 topics.json + 快照渲染 topic/<slug>.html 与索引页，TOPIC:* 标记整段替换、重复运行幂等）
│   ├── topics.json     7 个场景配置（slug/kw/title/desc/intro/match/sort；新增场景需同步中台 config.couponFront.topicIntroSlugs）
│   ├── fingerprint.js  内容哈希指纹（取代 cache-bust.js，部署前把资源引用改写为 <name>.<hash>.<ext>）
│   ├── selfcheck.js    部署前质量门（chrome 标记 / 兜底快照 / 指纹生效 / W1–W5 资产存在 / drops、guides 含 JSON-LD / 详情页数量与 detailIds 对齐 / 抽样 JSON-LD 合法 / topic 场景页结构与导语门禁 + 索引页与首页入口校验，关键项失败阻断 sync）
│   └── archive/cache-bust.js  [已废弃] 手工 ?v= 刷新脚本历史归档，勿再用
├── data/
│   ├── ad-slots.json   自营广告位兜底（远程 OSS 同步 JSON 优先）
│   ├── categories.json 21 品类元数据（slug/name/kw/icon/desc，品类页与 build.js 共用）
│   └── coupon-snapshot.json 构建期兜底快照（首页精选/日周月榜/全部好物/品类按 kw/drops 力度榜/detailIds 详情白名单），运行时后端不可达时回退渲染，nginx 放行 `/data/coupon-snapshot.json`
├── deploy/nginx.conf   部署配置（server_name 与证书路径按域名填）
├── robots.txt / sitemap.xml  （sitemap 由 build.js 重写：固定页 + cat/* + /p/* 详情页 + /drops + /guides* + /topic/* + guide/calculator/holidays/about，现 160 条；favorites/my-alerts 为 noindex 不入）
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

1. **预渲染与生成（CI 自动）**：`.github/workflows/deploy.yml` 在 `checkout` 后先过**编码门禁** `node scripts/check-encoding.js`（八站统一硬断），再执行 `node scripts/build.js`。**全站 chrome（WO-86）**：`injectChrome()` 先把 10 张手写页（index/browse/rank/category/guide/calculator/holidays/favorites/about/404）的 `<header>/<footer>` 在 `CHROME:HEADER/FOOTER` 标记内整段委托 `shared-partials` 的 `renderHeader/renderFooter` 渲染（`STATIC_PAGES` 定义各页导航高亮，cat 页由 `catPageShell` 同样委托）——与历史/notes/zangeng 共单一源，实现「六站一处改 chrome 生效」，标记内覆盖、重跑幂等。随后一次拉取后端：将首页（精选+周榜去重）、`browse.html`（paging 前 20）、`rank.html`（周榜前 50）写入各自 `PRERENDER:GRID` 标记的券网格并注入 `ItemList/Product/Offer` JSON-LD；再依 `data/categories.json` 的关键词生成 `cat/<slug>.html` 品类落地页（**页面壳每次写盘**，即使接口不可达也不 404，仅网格 fail-soft 留空）；3.8 步 `syncChromeOnDisk()` 再把 `/p/*`、`/guides*` 存量页的 header/footer 统一重渲染（两段各命中一次、幂等、原子写）；最后重写 `sitemap.xml`（固定页 + `cat/*` + `/p/*` + `/topic/*` + `guide`/`about`，`lastmod=当日`）。脚本 fail-soft：上游不可达 / 未取到券时保持原有 HTML 壳，绝不阻断部署。运行时 `coupon-page.js`（首页）/ `list-page.js`（browse/rank/category）会清空重绘（渐进增强，禁 JS 仍可读到预渲染内容）。
2. **内容哈希指纹（取代 cache-bust.js）**：部署前 `node scripts/fingerprint.js` 把本地 `css/js/图片/字体` 复制为 `<name>.<hash>.<ext>` 并改写 HTML/CSS 引用，配 Nginx 对 `/assets/**` 的 `immutable` 长缓存实现「内容变 URL 变、无手工版本号」的最优缓存。`cache-bust.js` 已归档至 `scripts/archive/`，不再使用。
3. **兜底快照（运行时韧性）**：`build.js` 随每次构建写出 `data/coupon-snapshot.json`（首页精选 / 日周月榜 / 全部好物 / 品类按 `data-kw`），`nginx.conf` 已放行该路径（`no-cache`）。当 `api.xuyiheng.com` 抖动 / 被墙导致前端 fetch 失败时，`coupon-page.js` / `list-page.js` 自动回退渲染该快照，整页不再空白。
4. **定时重建**：`deploy.yml` 除 `push` 外增加 `schedule`（UTC `20 */4 * * *` ≈ 北京每 4 小时一次）重跑门禁 + build + 指纹 + 自检 + sync，使优惠券（时效短）在搜索引擎侧保持新鲜，无需手动 push。CI 的 Node 口径与其余七站一致：优先用服务器已装 Node（`/www/server/nodejs/v20.18.3`，取不到回退 PATH），不再用 `setup-node` 重复下载。

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

## 爆款化改造（W1–W5 · 2026-10-18）

在不碰「无账号 / 无核销 / 无会员积分 / 不采集 PII」硬约束（遵循 2026-10-12 公众号定位决策）的前提下，靠**内容自传播 + SEO 长尾纵深 + 匿名设备（deviceId / localStorage）推送与回访**做大内容面积与回流理由。五个工作流已全部落地，CI 链（check-encoding → build → fingerprint → selfcheck）端到端 0 错 0 警，本地 http-server + 浏览器逐页验收通过。

- **W1 券详情落地页 `/p/<tao_id>.html`（传播地基）**：`build.js` 复用本次构建拉取的 `featured + rank(day/week/month) + browse + d11` 合集（`usable()` 去重），逐券写盘、**页面壳始终写盘**（接口不可达也不 404，fail-soft 与 cat 页同口径）。页含券力度大字 / 到手价 / 商品大图 / 价格走势迷你图（运行时 `detail-page.js` fetch `jd/priceTrend`）/ `立即领取`（`rel="sponsored noopener"`）/ 相关推荐 / 订阅降价提醒 / 分享。`Product`+`Offer`+`BreadcrumbList` JSON-LD；`/p/*` 纳入 `sitemap.xml`（初期限量约 60–120 条，写入 `coupon-snapshot.json` 的 `detailIds` 白名单）。新脚本 `assets/js/detail-page.js`（走势 + 订阅 + 分享 + 相关推荐，全程静默失败）。
- **W2 社交裂变**：`assets/js/qrcode.js` **零依赖 QR 编码器**（自实现 Nayuki 移植，v1–15 / EC-M / GF(256)，无网络）；`assets/js/share.js` 升级为——分享深链指向站内 `/p/<tao_id>`，海报右下渲染该深链二维码，版式对齐 `tokens.css` 品牌色。`/drops.html` 降价热榜页（`data-mode=drops`）：三级数据源 `jd/topDrops` 接口 → 预渲染 `priceBatch` 标记 → 快照兜底，每张热榜卡一键生成扫码战报（`drops_view` 埋点）。
- **W3 内容引擎 + SEO 爆发**：中台新增三只读接口（`jd/topDrops`、`content/list`、`content/detail`，见「数据来源」），经 `sourceGuard` 放行、字段白名单裁剪、config 开关灰度。`build.js` 拉长文预渲染 `/guides/<slug>.html`（`Article`+`BreadcrumbList` JSON-LD，`guideIndexShell`/`guidePageShell`）+ `/guides.html` 索引；`data/categories.json` 由 8 品类扩至 **21**，长尾落地页复用 `catPageShell`（`paging?search=`），sitemap 由 16 条 → **160 条**；刷新 `llms.txt`。沿用 `deploy.yml` 定时重建（`20 */4 * * *`）保新鲜。
- **W4 首页重塑（移动端优先「省钱情报流」）**：`index.html` + `coupon-page.js` + `coupon.css`。首屏情报条 `cpIntelBar`（实时在架券数 / 累计省钱力度，本地对已加载数据估算，不接埋点不采 PII）、今日必抢 `cpTop10` 横滑胶囊行、临近失效/降价倒计时氛围条 `cpMoodBar`；券卡升级（降幅 + 走势微图标记 + 一键「降价提醒」（web-push 下线后点击弹带参小程序码引导至小程序订阅，不再假翻「已提醒」），拇指区优先）；feed 顶部按 `saveScore()`（省钱力度 + 新鲜度 + 临近失效）前置 hero，前后端同口径。新增埋点 `drops_view`/`alert_guide_view`/`poster_share`/`top10_click`/`mood_click`/`challenge_share`（`alert_toggle`、`push_guide_view` 随 web-push 下线已停用）。
- **W5 留存与回访（匿名设备合规）**：`/my-alerts.html`（`noindex`）提醒中心——列本机 `deviceId` 订阅 + 当前力度对比（复用 `alert/list`），命中降价高亮一键跳详情。~~Web Push 引导~~**已下线**（2026-10-26：大陆 Chrome 走 Google FCM、prod 到 `fcm.googleapis.com:443` 不可达、投递恒失败），`app.js` 删 `CouponPush` 基座、`sw.js` 删 `push`/`notificationclick` 监听、`my-alerts.html`/`my-alerts.js` 引导卡改为每张已订阅券内嵌**带参小程序码**（`GET /front/coupon/mpcode?tao_id=`）+「微信扫码进小程序 · 顶部订阅到期/大额提醒」文案，`alert/list` 数据层保留仅作本机清单/降价高亮；`challenge.js` 今日省钱挑战：纯 `localStorage` 记录连续回访 streak + 累计省钱（匿名、非账号积分），里程碑（3/7/14/30/60/100 天）达成时触发扫码战报海报（复用 W2 `share.js`，item.link 指回首页）。

**构建 / CI 联动**：`build.js` 新增 `/p/*` 详情页、`/guides/*` 长文页、`/drops.html`、`sitemap.xml` 扩展（分项 fail-soft）；`selfcheck.js` 门禁扩展——STATIC_PAGES 纳入 `my-alerts.html`、新增关键资产存在性（qrcode/share/detail-page/drops-page/my-alerts/challenge.js 六脚本）、构建壳存在性（drops/guides 含 JSON-LD）、详情页数量与 `snapshot.detailIds` 对齐、抽样 `/p` 与 `/guides` JSON-LD 合法性。`deploy.yml` 沿用现有 push + schedule，无新增触发。

> **落点自查修复（2026-10-18）**：浏览器验收发现 `coupon-page.js` 多处用裸 `doc` 建 DOM（Top10 / 热搜词 / 氛围条 / sparkline）却漏声明局部 `doc`，`'use strict'` 下抛 `ReferenceError` 被 `request().catch` 与 `render()` 的 try/catch 静默吞掉——已补 `var doc = global.document;`（口径同 drops-page.js / detail-page.js）。

> **已知边界（非本任务引入）**：线上 `api.xuyiheng.com` 老部署代码的 `jd/priceBatch` 在 `couponPriceHistories=0` 时返回 `code:30000`；本地 `main-api` `priceHistory.batch/trend` 代码正确，待中台随 W3 接口一并重新部署即消除。当前走势/迷你图为空属预期降级。

## WO-125 场景导购 + 实时比价（2026-10-21）

场景化长尾落地页：每个场景一页，回答「这个场景该买什么、现在多少钱、省多少」，全部免费无解锁门槛。

- **场景源数据** `scripts/topics.json`：7 个场景（`phone` / `beauty` / `food` / `home` / `commute` / `study-kit` / `camping`），字段 `slug/kw/title/desc/intro/match/sort`——`kw` 用于匹配快照商品，`sort` 控制比价排序，`intro` 为 AI 不可用时的静态导语。**新增场景需同步中台 `config.couponFront.topicIntroSlugs` 白名单**，否则 AI 导语拉取会被拒（页面仍以静态导语生成）。
- **生成链路**：`build.js` 2.7 节先 `safeTopicIntros()` 逐个拉 `content/topicIntro`（单个失败 warn 后回落，不阻断），再把导语映射交给 `buildTopics()`；后者按 `data/coupon-snapshot.json` 渲染 `topic/<slug>.html`：比价 TOP8 表 + 券卡网格（≥9 张）+ 4 条 FAQ + `CollectionPage/ItemList/FAQPage` JSON-LD。AI 导语标 `data-intro-source="ai"`，静态兜底标 `fallback`，selfcheck 据此统计覆盖率。
- **页面约束**：保留 `data-ad-slot="carousel|inline"` 与 `data-img-slot="strip"` 三个广告位；券卡 CPS 埋点 `data-track="coupon_click"` 原样保留；全页免费、无登录/付费墙。
- **幂等与门禁**：`TOPIC:JSONLD/INTRO/COMPARE/GRID/FAQ` START/END 标记整段替换，重复运行字节级一致（本地两次构建 MD5 比对通过）；`selfcheck.js` 第 9 节逐页校验文件存在、`noindex` 回写、导语来源标记、比价行/券卡/CPS 数量、三广告位齐全、JSON-LD 三件套——结构缺失报错阻断部署，上游数据不足（<5 行/卡）与 AI fallback 仅告警。
- **sitemap**：`build.js` 写入 `/topic/<slug>.html` 与 `/topic/index.html`（`changefreq=daily`，`priority=0.65`），随每 4 小时定时重建刷新。
- **站内入口**：`COUPON_SITE.nav/footer_nav` 新增「场景导购」→ `/topic/index.html`；首页 hero 增加 7 场景快捷 chips；每个场景页底部「其他场景导购」互链 + 返回索引。`selfcheck` 校验索引页存在、≥5 个场景入口、首页可达，防止「页面在但用户进不去」。
- **本地验证**（2026-10-21）：完整构建 + selfcheck 通过——7 页「比价 8 行 / 卡片 9–12 张」，线上 `content/topicIntro` 已部署，AI 导语 7/7（`data-intro-source="ai"`）；selfcheck 0 错误 1 警告（既有 `?v=` 手工版本号）。

## 导航统一与导购站视觉审计（2026-10-22）

**背景**：导航硬编码散落在根页、topic 模板、build-topics 与 336 个 `/p/*` 伪静态页中，站内并存 7 项新菜单与 8 项旧菜单；首页首屏与券卡信息密度同国际导购站差距明显。

- **导航单一源**：新增 `scripts/site-config.js`，导出 `COUPON_SITE`（7 项主导航：领券中心 / 全部好物 / 榜单 / 品类 / 场景导购 / 攻略 / 长文导购，另 12 项页脚）与 `TOPIC_NAV`；`build.js`、`build-topics.js`、`topic-template.html`、`topic-index-template.html` 均消费同一源，模板不再写死菜单。
- **存量页 chrome 对齐**：`build.js` 新增 `syncChromeOnDisk()`，在 sitemap 前对 `p/*`、`guides/*`、`guides.html` 整段重渲染 header/footer；要求两段各命中一次，header 块不得含 `<main`、footer 块不得含 `</body>`，否则告警跳过；同目录 `.tmp` + rename 原子写，失败计数入日志。
- **幂等**：`renderHeader/renderFooter` 结果先 `trim()`，替换时连匹配点前空白一起归一，并跳过已是新 chrome 的页面；连续两次构建 337 个文件（`p/*` + `guides.html`）SHA256 全部一致、日志 `chrome 对齐 0`，不再产生空行噪声。
- **active 语义**：`p/*` 与 `drops.html` 仅高亮「榜单」入口，不输出错误的 `aria-current="page"`；`guides.html` 保留当前页语义。
- **一致性校验**：378 页全量脚本核对——7 项菜单不一致 0、多高亮 0、缺失折叠按钮 0；footer 结构 / 姊妹站 / 备案号缺失 0。about、double11、favorites、my-alerts 为页脚次级页，约定不高亮。
- **首屏与卡片**：`index.html` hero 改两栏（左价值主张、右搜索 + 热搜 chips，1440 搜索框 538px），删除独立「优惠券」分区标题，首卡顶 596→475px；`.cp-grid` 改 `minmax(210px,1fr)/gap16`（1440 6 列 / 1024 4 列 / 390 2 列）；到手价改 17px/800 红色主视觉 + 「到手」前缀，券力度降为浅红 pill；券卡补 `:focus-visible`；深色 `--coupon-red:#ff5c5e`。
- **响应式**：导航折叠断点 960→900px（901/920 仍 7 项同行、header 56px 不撑破）；≤720 隐藏排序文案与热搜词，移动端首卡顶 572→518px，390 无横向溢出。
- **同类问题修复**：比价表 `td.cp-off` 补 `display:table-cell; background:none; border-radius:0`，避免基础胶囊背景铺满整格（仅 7 张表 56 个 `td`，91 个 `span.cp-off` 仍在 `.cp-price` 内保持胶囊）；静态资源 `?v=` 统一 `2026.10.16`（CI fingerprint 仍会改写为内容哈希）。
- **质量门禁**：check-encoding 454 文件通过；build 成功（index 24 / browse 20 / rank 50 / topic 8 / cat 21 / p 120 / sitemap 160）；selfcheck 0 错误 1 条既有警告；WCAG 通过；浏览器 1440/1024/920/901/768/390 + topic/drops/guides/暗色 console 0 错误。

## WO-121 高商业意图产出·完整版改造（2026-10-25）

在 12 条人工 seed 脚手架之上，接入「AI 批量产条目 → 中台校验落库 → 接口下发 → 构建合并扩 buy 页」全链路。

- **条目双源合并**：`build.js` 2.8 节 `safeCommercial()` 拉中台 `/content/commercialList`（fail-soft：接口异常返 `[]` 只用本地 seed），`mergeCommercialItems()` 与 `scripts/commercial.json` 合并——seed 在前、按 slug/kw 去重（seed 优先），整批交给 `build-commercial.js`（`options.items` 缺省仍读本地 seed，本地脱后端构建不受影响）。
- **中台侧（WO-125 三件套模式）**：模型 `automate/couponCommercialEntry` 一次生成落库复用；`service/coupon/content.js` 生成 + 硬校验（格式 / 绝对化用语 SUPERLATIVE_RE 拦截 / slug·kw 去重 / 券池实证 match≥3——match 词须真实命中近期在售券标题，防无券空页）；调度任务 `coupon.content.generateCommercial`（每日 07:40，开关与配比见中台 `config.couponFront.commercial*`，总量上限达顶自动空转不烧 token）。
- **下发接口**：`GET /api/v1/front/coupon/content/commercialList`（sourceGuard 覆盖前缀、只回 published、字段白名单 7 项、异常降级 `[]`）。
- **生产验证**（2026-10-25）：首轮 `{sampled:6000, seeds:8, produced:8, published:8, rejected:0}`；8 个新 buy 页外网 200、`/buy/` 入口收录、sitemap buy 共 21 条（12 seed + 8 AI + 1 索引）；8 页全文扫描 14 个绝对化用语 0 命中。
- **日常运转**：任务已启用、每日滚动生成至上限；coupon 每次构建自动合并最新已发布条目，无需人工干预。

## 合规

- 优惠券展示与核销由京东 / 折淘客完成，本站仅作内容聚合与跳转，不参与交易（页脚与卡片均标注 `rel="sponsored noopener"`）。
- 沿用 zangeng 同主域 ICP 备案号 `京ICP备18062653号-26`（同主域子站点共用；页脚由 `scripts/build.js` 的 `COUPON_SITE.icp` 经 shared-partials `renderFooter` 渲染）。

## 与 zangeng.com 原 coupon.html 的关系

原 `zangeng.com/coupon.html` 的领券逻辑（`zangeng/assets/js/coupon-page.js`）已整体迁移到本仓库：`index.html` + `assets/js/coupon-page.js`（`MAIN_URL` 改为 `coupon.zangeng.com`）。原 zangeng 页可保留为跳转入口，或直接 301 到本域名。
