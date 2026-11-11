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
  const SEARCH_DIRS = ['css', 'css/pages', 'js', 'js/pages'].map((d) => path.join(ASSETS, d));

  function hashFile(file) {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  }

  const manifest = {};
  SEARCH_DIRS.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach((f) => {
      // WO-210：资产版本化统一。manifest 模式此前只哈希 .min.* 资源，导致 mp-slot.js（及合并后的
      // slot-loader.js）等非 .min SDK 资源未带 ?v= 版本令牌（mp-slot.js 缺口即源于此）。这里把合并
      // 加载器 slot-loader.js 与小程序码位组件 mp-slot.js 显式纳入版本化，其余 .min.* 行为不变。
      if (!/\.min\.(css|js)$/.test(f) && !/^(slot-loader|mp-slot)\.js$/.test(f)) return;
      const abs = path.join(dir, f);
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
 * 指纹构建统一的引用解析（WO-140 · visitor mp-slot 404 自愈）：
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

function discoverTargets(src) {
  const targets = new Set();
  const queue = [...src.css];
  const seenCss = new Set(src.css);

  function addFromHtml(file) {
    const txt = fs.readFileSync(file, 'utf8');
    let m;
    RE_HTML_REF.lastIndex = 0;
    while ((m = RE_HTML_REF.exec(txt))) {
      const ref = m[2];
      const abs = resolveTargetRef(ref, file);
      if (!abs) continue;
      if (!ASSET_EXT.has(extOf(ref))) continue;
      if (isExcluded(abs)) continue;
      targets.add(abs);
    }
  }

  function addFromCss(file) {
    const txt = fs.readFileSync(file, 'utf8');
    let m;
    RE_CSS_URL.lastIndex = 0;
    while ((m = RE_CSS_URL.exec(txt))) {
      const ref = m[2];
      const abs = resolveTargetRef(ref, file);
      if (!abs) continue;
      if (!ASSET_EXT.has(extOf(ref))) continue;
      if (isExcluded(abs)) continue;
      targets.add(abs);
      if (extOf(ref) === '.css' && !seenCss.has(abs)) { seenCss.add(abs); queue.push(abs); }
    }
  }

  src.html.forEach(addFromHtml);
  while (queue.length) addFromCss(queue.shift());
  return targets;
}

function rewriteFile(file, manifest, hashCache) {
  const isCss = file.endsWith('.css');
  const txt = fs.readFileSync(file, 'utf8');
  let count = 0;
  const re = isCss ? RE_CSS_URL : RE_HTML_REF;
  re.lastIndex = 0;

  const out = txt.replace(re, (whole, ...args) => {
    let prefix, ref, suffix;
    if (isCss) {
      const quote = args[0];
      ref = args[1];
      const h = resolveTargetRef(ref, file);
      if (!h || !manifest.has(h)) return whole;
      prefix = 'url(' + quote;
      suffix = quote + ')';
      const newName = manifest.get(h).name;
      const base = baseOf(stripQueryHash(ref));
      const rebuilt = ref.replace(base, newName).replace(/[?#].*$/, '');
      count++;
      if (VERBOSE) console.log(`  ${path.relative(ROOT, file)} :: ${ref} -> ${rebuilt}`);
      return prefix + rebuilt + suffix;
    } else {
      const attr = args[0];
      ref = args[1];
      const h = resolveTargetRef(ref, file);
      if (!h || !manifest.has(h)) return whole;
      const newName = manifest.get(h).name;
      const base = baseOf(stripQueryHash(ref));
      const rebuilt = ref.replace(base, newName).replace(/[?#].*$/, '');
      count++;
      if (VERBOSE) console.log(`  ${path.relative(ROOT, file)} :: ${ref} -> ${rebuilt}`);
      return `${attr}="${rebuilt}"`;
    }
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
  };
  src.html.forEach(f => checkFile(f, false));
  src.css.forEach(f => checkFile(f, true));
  return missing;
}

function runRename() {
  const src = collectSourceFiles();
  const targets = discoverTargets(src);

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
