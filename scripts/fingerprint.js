#!/usr/bin/env node
/* =============================================================================
 * fingerprint.js · 内容哈希指纹（零依赖，Node 18+）· 双模式单源
 *
 * 背景（2026-11 改造）：此前各站各自存一份 fingerprint.js，已分叉为两种不兼容方案：
 *   - Gen-1（store-web / xuyiheng-tools）：生成 assets/manifest.json（path→token），
 *     prerender 引用资源时按 manifest 追加 ?v=<token>（查询串缓存失效）。
 *   - Gen-2（其余 8 站）：把资源复制为 name.<hash>.ext 并改写 HTML/CSS 引用（文件名失效）。
 * 本文件为两者唯一事实源，由 site.json 的 build.fingerprintMode 选择，行为完全等价于原方案：
 *   - 'manifest'（默认无声明时不走此分支，避免误伤 8 站）：复刻 Gen-1；
 *   - 其余（默认）：复刻 Gen-2 文件名重命名。
 *
 * 用法：
 *   node scripts/fingerprint.js            # 按 site.json 模式运行（CI 用）
 *   node scripts/fingerprint.js --dry      # 仅报告命中，不落盘（rename 模式）
 *   node scripts/fingerprint.js --verbose  # 打印每条改写明细（rename 模式）
 *   require('./fingerprint').run()         # build.js 调用，返回 manifest（manifest 模式）
 * ============================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 站点根目录双态解析：被站点 build.js require 时（WO-164 ④ 私有包化，模块位于
// node_modules/@xuyiheng/static-build-kit）以进程入口为基准；直接 CLI 运行
// （各站 scripts/ 本地副本）时以自身位置为基准；无入口（node -e）时约定 cwd 即站点根。
const ROOT = require.main === module
  ? path.resolve(__dirname, '..')
  : require.main
    ? path.resolve(path.dirname(require.main.filename), '..')
    : process.cwd();
const HASH_LEN = 10;

const DRY = process.argv.includes('--dry');
const VERBOSE = process.argv.includes('--verbose');

/* ------------------------------------------------------------------ *
 * WO-246（B3 决策：加窄范围入口）——只刷新指定 stem，不产生无关 diff
 *   用法：node scripts/fingerprint.js --only=mp-slot,slot-loader
 *   背景：全站 rename 模式每次都会给**所有**被引用资源重算哈希并改写引用，
 *     于是「只想修一个资源」也会连带把其余 N 个资源的哈希副本刷新一遍，
 *     产生一堆与本次改动无关的 diff（review 时看不出哪些是真改动、哪些是连带噪声），
 *     更糟的是连带刷新的副本会让长缓存立即失效，把本次改动的收益冲掉。
 *   本入口的语义（刻意收窄，避免变成另一套指纹逻辑）：
 *     · 只处理 stem 命中的资源（stem = 文件名去扩展名，如 mp-slot.js → mp-slot）；
 *     · 只改写指向这些资源的引用；其余引用**一个字都不动**；
 *     · 旧指纹变体照常 prune（否则旧副本永远躺在仓库里变成死文件）；
 *     · 资源完整性门禁照跑（本次不涉及的资源若本来就有 404，仍会如实报出来，不被掩盖）。
 *   ⚠ 本文件是**单源**（packages/static-build-kit/src/fingerprint.js），
 *     各站 scripts/ 下的副本由分发脚本同步，不要在站点副本里手改。
 * ------------------------------------------------------------------ */
const ONLY_STEMS = (() => {
  const hit = process.argv.find(a => a.startsWith('--only=') || a.startsWith('--stems='));
  if (!hit) return null;
  const raw = hit.split('=').slice(1).join('=');
  const stems = raw.split(',').map(s => s.trim()).filter(Boolean);
  return stems.length ? new Set(stems) : null;
})();

/**
 * 取资源的 stem（文件名去扩展名）
 * @param {String} absPath - 绝对路径
 * @return {String}
 */
function stemOf(absPath) {
  const b = path.basename(absPath);
  const ext = path.extname(b);
  return ext ? b.slice(0, -ext.length) : b;
}

/**
 * 判断某资源是否在窄范围入口的命中集合内
 * @param {String} absPath - 绝对路径
 * @return {Boolean} 未指定 --only 时恒为 true（保持原行为）
 */
function inOnlyScope(absPath) {
  if (!ONLY_STEMS) return true;
  return ONLY_STEMS.has(stemOf(absPath));
}

// 参与指纹的资源扩展名
const ASSET_EXT = new Set([
  '.css', '.js',
  '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
]);

// 显式排除（保持原名，供爬虫/分享/运行期按固定地址消费）
const EXCLUDE_BASE = new Set([
  'og-cover.png', 'og-cover.svg', 'favicon.png', 'favicon.ico', 'favicon.svg',
  'apple-touch-icon.png', 'site.webmanifest', 'manifest.webmanifest',
]);

// 目录黑名单：扫描引用来源、发现资源时都跳过
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '.user.ini', '.workbuddy']);
// 引用来源扫描跳过（脚本自身、部署产物、数据目录不作为改写目标）
const SRC_SKIP_DIRS = new Set(['scripts', 'deploy', 'data', 'reports', '.devtools']);

// 已带指纹的 basename（幂等判定：name.<8~12位哈希>.ext）
const HASHED_RE = /\.([A-Za-z0-9_-]{8,12})\.[A-Za-z0-9]+$/;

/* ------------------------------------------------------------------ *
 * 模式判定：site.json -> build.fingerprintMode（缺省 'rename'）
 * ------------------------------------------------------------------ */
function resolveMode() {
  try {
    const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
    const m = site && site.build && site.build.fingerprintMode;
    if (m === 'manifest' || m === 'rename') return m;
  } catch (e) {}
  return 'rename';
}

/* ==========================================================================
 * Gen-1 · manifest 模式：复刻原 store-web/xuyiheng-tools fingerprint.js
 *   扫描 assets 下 .min.css/.min.js，对每个取 sha256 前 10 位作为 token，
 *   生成 assets/manifest.json：{ "/assets/css/theme.min.css": "a1b2c3d4e5", ... }
 *   prerender 引用资源时按 manifest 追加 ?v=<token>。
 *   返回 manifest 对象（供 build.js 取用）。
 * ========================================================================== */
function runManifest() {
  const ASSETS = path.join(ROOT, 'assets');
  const SEARCH_DIRS = ['css', 'js'].map((d) => path.join(ASSETS, d));

  function collect(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) collect(full, out);
      else out.push(full);
    }
    return out;
  }

  function hashFile(file) {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  }

  const manifest = {};
  SEARCH_DIRS.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    collect(dir).forEach((file) => {
      const f = path.basename(file);
      // WO-210：资产版本化统一。manifest 模式此前只哈希 .min.* 资源，导致 mp-slot.js（及合并后的
      // slot-loader.js）等非 .min SDK 资源未带 ?v= 版本令牌（mp-slot.js 缺口即源于此）。这里把合并
      // 加载器 slot-loader.js 与小程序码位组件 mp-slot.js 显式纳入版本化，其余 .min.* 行为不变。
      // 续（WO-210 收尾）：再把站点级无版本化 SDK 资源 tracker.js 与 xuyiheng combo-popularity.js 纳入指纹，
      // 使全站资产（含 tracker 三套命名与 combo-popularity）一致带 ?v=，避免更新后被浏览器缓存钉死。
      // WO-244：补入 img-slot.js —— 此前名单只收 slot-loader，而 img-slot 是四个 slot 模块之一，
      // 若某页仍直接引用 img-slot.js（而非合并的 slot-loader.js），它就会是裸引用、被长缓存钉死。
      // 四个 slot 模块（ad/coupon/img/mp）非 .min 形态统一纳入，名单与 site-sdk 的 SLOT_MODULES 对齐。
      if (!/\.min\.(css|js)$/.test(f) && !/^(ad-slots|coupon-slot|img-slot|slot-loader|mp-slot|tracker|combo-popularity)\.js$/.test(f)) return;
      const abs = file;
      const rel = '/' + path.relative(ROOT, abs).replace(/\\/g, '/');
      manifest[rel] = hashFile(abs);
    });
  });
  const target = path.join(ASSETS, 'manifest.json');
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
  console.log('fingerprint：写入 manifest.json（' + Object.keys(manifest).length + ' 个资源版本）');
  return manifest;
}

/* ==========================================================================
 * Gen-2 · rename 模式：复刻原 8 站的「文件名内容哈希」指纹
 *   把站内被 HTML/CSS 字面引用的静态资源复制成 name.<hash>.ext 并改写引用；
 *   原始文件保留不删，配合 Nginx 对资源加 immutable 长缓存。
 * ========================================================================== */
function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64url').slice(0, HASH_LEN);
}

function isExternal(u) {
  return /^(https?:)?\/\//i.test(u) || /^data:/i.test(u) || /^mailto:/i.test(u) || /^tel:/i.test(u);
}

function stripQueryHash(u) {
  return u.replace(/[?#].*$/, '');
}

function extOf(u) {
  return path.extname(stripQueryHash(u)).toLowerCase();
}

function walk(dir, out, filterFn) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(full, out, filterFn);
    } else if (filterFn(full)) {
      out.push(full);
    }
  }
  return out;
}

function collectSourceFiles() {
  // 只收集「源文件」：排除 name.<8~12位hash>.ext 形式的旧指纹产物，
  // 否则 pruneStaleVariants 删除旧副本后，verifyRefs 再读取会 ENOENT。
  const html = walk(ROOT, [], (f) => f.endsWith('.html') && !HASHED_RE.test(path.basename(f)));
  const css = [];
  (function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || SRC_SKIP_DIRS.has(ent.name)) continue;
        scan(full);
      } else if (ent.name.endsWith('.css') && !HASHED_RE.test(ent.name)) {
        css.push(full);
      }
    }
  })(ROOT);
  return { html, css };
}

function resolveRef(refRaw, fromFile) {
  const clean = stripQueryHash(refRaw);
  if (!clean || isExternal(refRaw)) return null;
  const abs = clean.startsWith('/')
    ? path.join(ROOT, clean)
    : path.resolve(path.dirname(fromFile), clean);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let st;
  try { st = fs.statSync(abs); } catch (e) { return null; }
  if (!st.isFile()) return null;
  return abs;
}

function baseOf(p) { return path.basename(p); }

/**
 * 把「带指纹的引用」还原成它的源文件路径。
 * 例：/assets/js/mp-slot.MnvKqn57JW.js -> /assets/js/mp-slot.js
 * 命中条件：文件名符合 name.<8~12位hash>.ext；返回 null 表示该引用不是指纹资源。
 */
function sourceOfHashedRef(refRaw, fromFile) {
  const clean = stripQueryHash(refRaw);
  const base = baseOf(clean);
  const m = HASHED_RE.exec(base);
  if (!m) return null;
  if (!ASSET_EXT.has(extOf(refRaw))) return null;
  const ext = path.extname(base);
  const srcBase = base.slice(0, m.index) + ext;
  const dir = clean.startsWith('/')
    ? path.join(ROOT, path.dirname(clean))
    : path.dirname(path.resolve(path.dirname(fromFile), clean));
  const src = path.join(dir, srcBase);
  try { if (fs.statSync(src).isFile()) return src; } catch (e) {}
  return null;
}

/**
 * 引用 → 源文件（统一口径，WO-246 收口）
 *   ① 引用直接指向源文件（未指纹化）→ 源文件本身；
 *   ② 引用指向 name.<hash>.ext 副本（副本存在或已缺失）→ 还原成它的源文件。
 * 为什么要统一到「源」：旧实现里 ② 在「副本存在」时被 isExcluded 整条跳过，于是
 *   **源文件改了、副本没改（过期副本）时，整站跑是 0 改动、线上继续服务上一代产物** ——
 *   这正是 WO-246「整站 fingerprint 越界面」与那几处漂移能长期挂着的同源机制。
 *   统一到源之后，指纹变成内容驱动：哈希按源文件当前内容算，副本过期就会被刷新。
 */
function resolveSourceOf(refRaw, fromFile) {
  const hit = resolveRef(refRaw, fromFile);
  if (hit && !isExcluded(hit)) return hit;
  return sourceOfHashedRef(refRaw, fromFile);
}

/**
 * 引用 → 实际落盘路径（WO-140 · visitor mp-slot 404 自愈）：
 *   ① 引用指向的真实文件存在 → 原样返回；
 *   ② 引用已是 name.<hash>.ext 但副本缺失（例如上一轮构建的产物没进本次 checkout，
 *      而 HTML 仍带着旧指纹）→ 回落到源文件，让本轮重新算出哈希副本并改写引用；
 *   ③ 其余返回 null。
 * 缺了 ② 时，discoverTargets 会把这类引用整个跳过：哈希副本不生成、HTML 也不改写，
 * 部署后就是静默 404（visitor 的 mp-slot.MnvKqn57JW.js 即此形态）。
 */
function resolveTargetRef(refRaw, fromFile) {
  const hit = resolveRef(refRaw, fromFile);
  if (hit) return hit;
  if (isExternal(refRaw)) return null;
  return sourceOfHashedRef(refRaw, fromFile);
}

function isExcluded(absPath) {
  const b = baseOf(absPath);
  if (EXCLUDE_BASE.has(b)) return true;
  const m = HASHED_RE.exec(b);
  if (m) return true;
  return false;
}

function hashedName(absPath, hashCache) {
  if (hashCache.has(absPath)) return hashCache.get(absPath);
  const buf = fs.readFileSync(absPath);
  const h = contentHash(buf);
  const b = baseOf(absPath);
  const ext = path.extname(b);
  const stem = ext ? b.slice(0, -ext.length) : b;
  const name = stem + '.' + h + (ext || '');
  hashCache.set(absPath, { name, hash: h, ext, buf });
  return hashCache.get(absPath);
}

const RE_HTML_REF = /(href|src)="([^"]+)"/gi;
const RE_CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
/**
 * 内联懒加载片段（idle loader）：var s="assets/js/xxx.js" —— 不是 href/src 属性，
 * 旧实现改不到它，于是「副本被 prune + 内联仍指向旧副本」= 静默 404
 * （WO-246 的 en/ 6 页 site-enhance/docs/bookmark 即此类事故）。
 * 用负向后顾排除属性式（src=" / href="），避免同一处字符串被改写两次。
 */
const RE_INLINE_REF = /(?<!\bsrc=)(?<!\bhref=)(["'])([^"'\n]*?\.(?:js|css))\1/g;

/**
 * 过期副本检测：引用指向的副本还在，但副本名里的哈希 ≠ 源文件当前内容哈希
 * ⇒ 副本已过期（线上仍在服务上一代产物，而整站跑是 0 改动）。
 */
function staleCopyOf(refRaw, fromFile, srcPath) {
  const hit = resolveRef(refRaw, fromFile);
  if (!hit || !isExcluded(hit)) return null;
  const m = baseOf(hit).match(HASHED_RE);
  if (!m) return null;
  let buf;
  try { buf = fs.readFileSync(srcPath); } catch (e) { return null; }
  if (m[1] === contentHash(buf)) return null;
  return { copy: hit, want: contentHash(buf) };
}

function discoverTargets(src) {
  const targets = new Set();
  const queue = [...src.css];
  const seenCss = new Set(src.css);
  const stale = [];

  function noteRef(ref, file) {
    if (!ref || !ASSET_EXT.has(extOf(ref))) return null;
    const srcPath = resolveSourceOf(ref, file);
    if (!srcPath) return null;
    const st = staleCopyOf(ref, file, srcPath);
    if (st) {
      stale.push({
        file: path.relative(ROOT, file),
        ref,
        copy: path.relative(ROOT, st.copy),
        src: path.relative(ROOT, srcPath),
        want: st.want,
      });
    }
    return srcPath;
  }

  function addFromHtml(file) {
    const txt = fs.readFileSync(file, 'utf8');
    let m;
    RE_HTML_REF.lastIndex = 0;
    while ((m = RE_HTML_REF.exec(txt))) {
      const srcPath = noteRef(m[2], file);
      if (srcPath) targets.add(srcPath);
    }
    RE_INLINE_REF.lastIndex = 0;
    while ((m = RE_INLINE_REF.exec(txt))) {
      const srcPath = noteRef(m[2], file);
      if (srcPath) targets.add(srcPath);
    }
  }

  function addFromCss(file) {
    const txt = fs.readFileSync(file, 'utf8');
    let m;
    RE_CSS_URL.lastIndex = 0;
    while ((m = RE_CSS_URL.exec(txt))) {
      const ref = m[2];
      const srcPath = noteRef(ref, file);
      if (!srcPath) continue;
      targets.add(srcPath);
      if (extOf(ref) === '.css' && !seenCss.has(srcPath)) { seenCss.add(srcPath); queue.push(srcPath); }
    }
  }

  src.html.forEach(addFromHtml);
  while (queue.length) addFromCss(queue.shift());
  return { targets, stale };
}

function rewriteFile(file, manifest, hashCache) {
  const isCss = file.endsWith('.css');
  const txt = fs.readFileSync(file, 'utf8');
  let count = 0;

  // 统一按「源文件」查 manifest：引用指向源或指向副本都落到同一个源上，
  // 于是过期副本也能被本轮重新算哈希并改写引用（内容驱动）。
  const rebuild = (ref) => {
    if (!ref || !ASSET_EXT.has(extOf(ref))) return null;
    const srcPath = resolveSourceOf(ref, file);
    if (!srcPath || !manifest.has(srcPath)) return null;
    const newName = manifest.get(srcPath).name;
    const base = baseOf(stripQueryHash(ref));
    const out = ref.replace(base, newName).replace(/[?#].*$/, '');
    if (out === ref) return null; // 已经是当前哈希 ⇒ 不动、不计数
    return out;
  };

  if (isCss) {
    RE_CSS_URL.lastIndex = 0;
    const out = txt.replace(RE_CSS_URL, (whole, quote, ref) => {
      const rebuilt = rebuild(ref);
      if (!rebuilt) return whole;
      count++;
      if (VERBOSE) console.log(`  ${path.relative(ROOT, file)} :: ${ref} -> ${rebuilt}`);
      return 'url(' + quote + rebuilt + quote + ')';
    });
    return [out, count];
  }

  // HTML：先属性式（href/src），再内联式（var s="..."）——内联式靠负向后顾排除属性式，
  // 同一处字符串不会被改写两次。
  RE_HTML_REF.lastIndex = 0;
  let out = txt.replace(RE_HTML_REF, (whole, attr, ref) => {
    const rebuilt = rebuild(ref);
    if (!rebuilt) return whole;
    count++;
    if (VERBOSE) console.log(`  ${path.relative(ROOT, file)} :: ${ref} -> ${rebuilt}`);
    return `${attr}="${rebuilt}"`;
  });

  RE_INLINE_REF.lastIndex = 0;
  out = out.replace(RE_INLINE_REF, (whole, quote, ref) => {
    const rebuilt = rebuild(ref);
    if (!rebuilt) return whole;
    count++;
    if (VERBOSE) console.log(`  ${path.relative(ROOT, file)} :: ${ref} -> ${rebuilt} (内联)`);
    return quote + rebuilt + quote;
  });

  return [out, count];
}

// 清理同 stem 的旧指纹变体：rename 模式只写新 hash、不删旧 hash，旧 name.<hash>.ext
// 会在仓库/服务器累积成死文件。生成新 hash 文件后，删除同目录下同 stem 的旧变体，
// 仅保留源文件（abs）与被引用的最新 hash 文件（newName）。DRY 模式仅打印、不删除。
function pruneStaleVariants(abs, info) {
  const dir = path.dirname(abs);
  const newName = info.name; // e.g. pv.min.<hash>.js
  const ext = path.extname(newName);
  const srcBase = path.basename(abs); // e.g. pv.min.js（源，始终保留）
  const newBaseNoExt = path.basename(newName, ext); // pv.min.<hash>
  const m = newName.match(HASHED_RE);
  if (!m) return; // 非标准指纹名，跳过
  const hash = m[1];
  const stem = newBaseNoExt.slice(0, newBaseNoExt.length - (hash.length + 1)); // pv.min
  let pruned = 0;
  for (const e of fs.readdirSync(dir)) {
    if (e === newName || e === srcBase) continue;
    if (path.extname(e) !== ext) continue;
    const eBase = path.basename(e, ext);
    // 必须精确匹配「同一 stem + .<8~12位hash>」：先钉死前缀，再校验后缀。
    // 只校验后缀时，长度恰好相同的**不同** stem 会互相误删刚生成的指纹文件
    // （visitor 的 visitor.js 与 mp-slot.js 均为 7 字符，曾把 mp-slot.<hash>.js
    //  当成 visitor 的旧变体删掉 → 线上 HTML 指向 404）。WO-140：回灌 coupon 既有修复到单源。
    if (eBase.slice(0, stem.length) !== stem) continue;
    const suffix = eBase.slice(stem.length);
    if (!/^\.[A-Za-z0-9_-]{8,12}$/.test(suffix)) continue;
    const full = path.join(dir, e);
    if (DRY) {
      console.log(`  [dry] 将清理旧指纹变体: ${path.relative(ROOT, full)}`);
    } else {
      if (fs.existsSync(full)) { fs.unlinkSync(full); pruned++; }
    }
  }
  if (!DRY && pruned > 0) console.log(`  清理 ${pruned} 个旧指纹变体 (stem=${stem})`);
}

/**
 * 部署前资源完整性门禁（WO-140）：扫描构建后 HTML/CSS 的全部本地资源引用，
 * 逐个确认目标文件存在。缺一个就把 CI 打断，杜绝「HTML 指向 404」被静默发布。
 * DRY 模式不落盘，只提示跳过，避免把尚未生成的哈希副本误报为缺失。
 */
function verifyRefs(src) {
  if (DRY) { console.log('[dry-run] 跳过资源完整性门禁'); return []; }
  const missing = [];
  const checkFile = (file, isCss) => {
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return; } // 旧指纹产物已被 prune 删除，跳过
    const re = isCss ? RE_CSS_URL : RE_HTML_REF;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(txt))) {
      const ref = m[2];
      if (!ref || isExternal(ref) || !ASSET_EXT.has(extOf(ref))) continue;
      if (resolveRef(ref, file)) continue;
      missing.push({ file: path.relative(ROOT, file), ref });
    }
    // 内联懒加载片段同样纳入完整性门禁：它不是 href/src 属性，
    // 过去这一类 404 完全不进门禁（WO-246 的 en/ 6 页事故即此类）。
    if (!isCss) {
      RE_INLINE_REF.lastIndex = 0;
      while ((m = RE_INLINE_REF.exec(txt))) {
        const ref = m[2];
        if (!ref || isExternal(ref) || !ASSET_EXT.has(extOf(ref))) continue;
        if (resolveRef(ref, file)) continue;
        missing.push({ file: path.relative(ROOT, file), ref, inline: true });
      }
    }
  };
  src.html.forEach(f => checkFile(f, false));
  src.css.forEach(f => checkFile(f, true));
  return missing;
}

function runRename() {
  const src = collectSourceFiles();
  const { targets: allTargets, stale } = discoverTargets(src);
  // WO-246 窄范围入口：只保留 stem 命中的目标。
  //   注意 prune 仍按「本次处理过的资源」执行 ⇒ 只清理命中资源的旧变体，
  //   不会顺手删掉别的 stem 的历史副本（那属于无关 diff）。
  const targets = ONLY_STEMS
    ? new Set([ ...allTargets ].filter(abs => inOnlyScope(abs)))
    : allTargets;

  if (ONLY_STEMS) {
    const hit = [...targets].map(stemOf);
    const missed = [...ONLY_STEMS].filter(s => !hit.includes(s));
    console.log(`[fingerprint] 窄范围入口：--only=${[ ...ONLY_STEMS ].join(',')} 命中 ${targets.size} 个资源`
      + (missed.length ? `；未命中（无引用或不存在）：${missed.join(', ')}` : ''));
    if (!targets.size) {
      console.error('[fingerprint] 窄范围内没有任何资源命中，终止（避免空跑后误判为「已完成」）');
      process.exitCode = 1;
      return;
    }
  }

  const hashCache = new Map();
  const manifest = new Map();
  for (const abs of targets) {
    const info = hashedName(abs, hashCache);
    manifest.set(abs, info);
    const dest = path.join(path.dirname(abs), info.name);
    if (!DRY) {
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, info.buf);
    }
    pruneStaleVariants(abs, info); // 生成新 hash 后清理同 stem 旧变体（防死文件累积）
  }

  let touchedFiles = 0;
  let touchedRefs = 0;

  for (const file of src.html) {
    const [out, n] = rewriteFile(file, manifest, hashCache);
    if (n > 0) {
      touchedFiles++; touchedRefs += n;
      if (!DRY) fs.writeFileSync(file, out, 'utf8');
    }
  }

  for (const abs of targets) {
    if (extOf(abs) !== '.css') continue;
    const [out, n] = rewriteFile(abs, manifest, hashCache);
    const info = hashCache.get(abs);
    if (!DRY && info) fs.writeFileSync(path.join(path.dirname(abs), info.name), out, 'utf8');
    if (n > 0) { touchedFiles++; touchedRefs += n; }
  }

  const label = DRY ? '[dry-run 未落盘] ' : '';
  console.log(`${label}指纹完成：资源 ${manifest.size} 个，改写引用 ${touchedRefs} 处，涉及 ${touchedFiles} 个文件`);

  // 过期副本读数（WO-246 收口）：副本存在但内容已不是源文件当前内容 ⇒ 线上仍在服务上一代产物，
  // 而旧实现下整站跑是 0 改动、看不出任何异常。本轮已按源文件当前内容重算并改写引用。
  if (stale.length) {
    console.log(`[fingerprint] 发现 ${stale.length} 处过期副本（源文件已改、副本未刷新）：`);
    stale.slice(0, 20).forEach(x => console.log(`  - ${x.file} :: ${x.ref} → 旧副本 ${x.copy}，当前应为 ${x.want}`));
    if (stale.length > 20) console.log(`  ... 另有 ${stale.length - 20} 条`);
  } else {
    console.log('[fingerprint] 过期副本：0 处 ✓');
  }

  const localAssets = [...targets];
  // 「改写 0 处」不等于失败：HTML 可能已带指纹（自愈场景，本轮只补回缺失的哈希副本）。
  // 只有当输出里一个指纹引用都没有时，才判为引用解析未适配。
  const hashedRefCount = src.html.reduce((n, f) => {
    const txt = fs.readFileSync(f, 'utf8');
    let hit = 0;
    RE_HTML_REF.lastIndex = 0;
    let m;
    while ((m = RE_HTML_REF.exec(txt))) {
      if (HASHED_RE.test(baseOf(stripQueryHash(m[2])))) hit++;
    }
    return n + hit;
  }, 0);
  if (!DRY && src.html.length > 0 && touchedRefs === 0 && localAssets.length > 0 && hashedRefCount === 0) {
    console.error('[fingerprint] 发现本地资源但改写引用为 0，疑似引用解析未适配，终止');
    process.exitCode = 1;
  }

  const missing = verifyRefs(src);
  if (missing.length) {
    console.error(`[fingerprint] 资源完整性门禁失败：${missing.length} 个引用指向不存在的文件（上线即 404）`);
    missing.slice(0, 30).forEach(x => console.error(`  - ${x.file} :: ${x.ref}`));
    if (missing.length > 30) console.error(`  ... 另有 ${missing.length - 30} 条`);
    process.exitCode = 1;
  } else if (!DRY) {
    console.log('[fingerprint] 资源完整性门禁：全部本地引用可达 ✓');
  }
}

/* ------------------------------------------------------------------ *
 * 统一入口：按 site.json 模式分发
 * ------------------------------------------------------------------ */
function run(opts) {
  const mode = (opts && opts.mode) || resolveMode();
  if (mode === 'manifest') return runManifest();
  runRename();
  return null;
}

if (require.main === module) {
  run();
}

module.exports = { run, resolveMode };
