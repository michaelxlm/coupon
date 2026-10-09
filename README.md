---
title: 小满券仓（coupon.zangeng.com）
owner: Michaelxlm
updated: 2026-10-09
scope: coupon（coupon.zangeng.com · 京东优惠券聚合静态站）
status: 有效
tags: [coupon, 小满券仓, 优惠券, 纯静态, sourceGuard, 统一埋点]
---

# 小满券仓（coupon.zangeng.com）

> 文档治理：本文件是 coupon 唯一项目介绍；跨项目规范与集中文档见 `main-api/app/docs/`；
> 统一视图见 `main-api/app/docs/knowledge-base/projects/coupon/README.md`（2026-10-09 纳入知识库）。

从 `zangeng.com` 剥离出来的**独立优惠券站**，域名 `coupon.zangeng.com`，专门展示京东优惠券数据。
优惠券数据实时来自中台 `main-api`（`/api/v1/front/coupon/jd/*`），与其他静态站（zangeng / color-tool / visitor / aiWeb / notes / history）**同一套零依赖静态站框架**：手写 HTML + 共享设计令牌 + push-to-deploy。

## 数据来源

- 精选（手选池）：`GET /api/v1/front/coupon/jd/random?limit=10&mainUrl=coupon.zangeng.com`
  由原「全库随机」改为**纯手选池**：只展示管理端「优惠券商品」页导入的京东手选券（`isHandpick='1'`）；
  当 `main-api` 的 `config.taobaoTbk.enable=true` 时，京东手选与淘宝有效券**混合同一榜**（按 `createTime` 倒序截断）。淘宝审核通过后仅切此开关即面客，无需改代码。
- 榜单（日 / 周 / 月）：`GET /api/v1/front/coupon/jd/rank?period=week|month|day&limit=20&mainUrl=coupon.zangeng.com`
  日榜已改为**真时间窗排序**（近 24h 按券面额降序），与精选不再同源。
- 搜索 / 分页：`GET /api/v1/front/coupon/jd/paging?search=关键词&page=1&pageSize=20&mainUrl=coupon.zangeng.com`

> 前台接口经后端字段白名单裁剪（`title/pict_url/item_url/price/couponDiscount/couponQuota/clickURL/couponUrl/tao_id`），不再下发 `data/佣金/内部状态位` 等敏感字段。

`coupon-page.js` 在每次请求里带上 `mainUrl=coupon.zangeng.com`，经 `main-api` 的 `sourceGuard` 中间件按 `projects.url` 放行。
**务必先在 main-api 侧登记该来源**（见下方「上线 checklist」），否则接口返回空数据（响应头 `X-Source-Guard: BLOCKED`）。

## 目录

```
coupon/
├── index.html          领券中心页（SEO / header / footer / 优惠券网格）
├── 404.html            404
├── assets/
│   ├── css/tokens.css  六站共享设计令牌（单一事实来源，勿改品牌令牌）
│   ├── css/main.css    站点组件样式（头部 / 页脚 / 按钮 / 广告位，复用 zangeng 模板）
│   ├── css/coupon.css  优惠券页独有样式（网格 / 券卡 / 榜单切换 / 搜索）
│   ├── js/tracker.js   统一埋点 SDK（上报 /api/v1/public/track，project=coupon-zangeng）
│   ├── js/conversion.js 转化与来源归因层
│   ├── js/app.js       站点交互（主题三态 / 移动菜单）
│   ├── js/coupon-page.js 领券中心交互（精选 / 榜单 / 搜索 / 分页加载更多）
│   └── img/            favicon.svg + og-cover.svg
├── scripts/
│   ├── build.js        构建期预渲染券网格 + schema.org JSON-LD（部署前由 CI 执行，fail-soft）
│   └── cache-bust.js   统一刷新本地 CSS/JS 的 ?v= 与 body data-build 版本号（零依赖）
├── data/ad-slots.json  自营广告位兜底（远程 OSS 同步 JSON 优先）
├── deploy/nginx.conf   部署配置（server_name 与证书路径按域名填）
├── robots.txt / sitemap.xml
└── .github/workflows/deploy.yml  push-to-deploy（39.107 上的 self-hosted runner 执行）
```

## 本地预览

```powershell
npx http-server -p 8080
# 或
python -m http.server 8080
```

然后访问 http://localhost:8080 （优惠券需联网请求 `api.xuyiheng.com`，本地预览同样受 sourceGuard 放行约束，登记后即可正常拉取）。

## 构建与缓存规范

站体仍为纯静态托管（HTML 直加源文件），但新增一个**部署前的可选预渲染步骤**（为让券内容可被百度等弱 JS 搜索引擎索引）：

1. **预渲染（CI 自动）**：`.github/workflows/deploy.yml` 在 `checkout` 后、`sync` 前执行 `node scripts/build.js`，拉一次后端「精选 + 周榜」写入 `index.html` 的 `#cpGrid`（`PRERENDER:GRID` 标记包裹，幂等替换）并生成 `ItemList/Product/Offer` JSON-LD。脚本 fail-soft：上游不可达 / 未取到券时保持原 HTML，绝不阻断部署。运行时 `coupon-page.js` 会清空重绘（渐进增强，禁 JS 仍可读到券）。
2. **缓存指纹**：Nginx 对 `/assets/**` 设 30 天长缓存，改了 `assets/css/*.css` / `assets/js/*.js` 后跑 `node scripts/cache-bust.js <版本号>`（形如 `2026.10.13`），一次性刷新全站本地 CSS/JS 的 `?v=` 与 `<body data-build>` 统一个 token（外部 OSS 脚本自动跳过）。当前 token：`2026.10.13`。

## 上线 checklist（缺一不可）

1. **DNS**：在域名服务商把 `coupon.zangeng.com` 的 A 记录指向 `60.205.214.88`（与 zangeng.com 同 IP）。
2. **Nginx**：在 60.205 上新建 `/etc/nginx/conf.d/coupon.zangeng.com.conf`（复制 `deploy/nginx.conf`，改证书路径为本域名），`nginx -t && nginx -s reload`；并用 certbot 申请 `coupon.zangeng.com` 证书。
3. **来源登记（关键）**：在本机 / 服务器跑 main-api 的登记脚本，把 `coupon.zangeng.com` 写入 `projects` 集合：
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
5. **管理端（可选）**：`coupon.zangeng.com` 已加入 `main-api` `config.deploy.projects`，可在管理端「静态站部署」页一键触发（需 39.107 设 `GITHUB_DEPLOY_TOKEN`）。
6. **推送即部署**：`git push` 到 `main` 分支即触发 `deploy.yml`，把仓库同步到 `60.205:/www/wwwroot/coupon.zangeng.com`。

## 合规

- 优惠券展示与核销由京东 / 折淘客完成，本站仅作内容聚合与跳转，不参与交易（页脚与卡片均标注 `rel="sponsored noopener"`）。
- 沿用 zangeng 同主体 ICP 备案号 `京ICP备18062653号-8`（同主域子站点共用）。

## 与 zangeng.com 原 coupon.html 的关系

原 `zangeng.com/coupon.html` 的领券逻辑（`zangeng/assets/js/coupon-page.js`）已整体迁移到本仓库：`index.html` + `assets/js/coupon-page.js`（`MAIN_URL` 改为 `coupon.zangeng.com`）。原 zangeng 页可保留为跳转入口，或直接 301 到本域名。
