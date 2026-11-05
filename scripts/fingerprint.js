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
      if (!/\.min\.(css|js)$/.test(f)) return;
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
  const html = walk(ROOT, [], (f) => f.endsWith('.html'));
  const css = [];
  (function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || SRC_SKIP_DIRS.has(ent.name)) continue;
        scan(full);
      } else if (ent.name.endsWith('.css')) {
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
      const abs = resolveRef(ref, file);
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
      const abs = resolveRef(ref, file);
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
      const h = resolveRef(ref, file);
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
      const h = resolveRef(ref, file);
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
  if (!DRY && src.html.length > 0 && touchedRefs === 0 && localAssets.length > 0) {
    console.error('[fingerprint] 发现本地资源但改写引用为 0，疑似引用解析未适配，终止');
    process.exitCode = 1;
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
