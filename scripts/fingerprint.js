#!/usr/bin/env node
/* =============================================================================
 * fingerprint.js · 内容哈希指纹（零依赖，Node 18+）
 *
 * 目标：把站内被 HTML/CSS 字面引用的静态资源（css/js/图片/字体）复制成带内容
 * 哈希的文件名（name.<hash>.ext），并把引用改写到哈希名。内容不变 → URL 不变
 * → 浏览器/CDN 强缓存命中；内容变 → 文件名变 → 精确 bust。配合服务器 Nginx 对
 * 资源加 `immutable` 长缓存、对 HTML 加 `no-cache`，实现"无手工版本号"的最优缓存。
 *
 * 关键设计（降风险）：
 *   - 哈希产物是「新增副本」，原始文件保留不删。因此任何未纳入本脚本改写的引用
 *     （运行时 JS 动态拼接的路径、data/*.json 里的路径、绝对 canonical URL）仍指向
 *     原文件名，照常可访问，不会 404。
 *   - 只改写 HTML 的 (href|src) 与 CSS 的 url() 里「解析到本地磁盘、且命中资源」的
 *     字面引用；外链（http(s):// / 协议相对 // / data: / mailto:）一律跳过。
 *   - og-cover.png / favicon / webmanifest 等被爬虫与分享按固定绝对地址消费，显式
 *     排除、保持原名 + 长缓存。
 *   - CSS 的 url() 引用的图片/字体也纳入指纹（会级联处理）。
 *
 * 用法：
 *   node scripts/fingerprint.js            就地改写运行副本（CI 用）
 *   node scripts/fingerprint.js --dry      只报告命中，不落盘（本地验证）
 *   node scripts/fingerprint.js --verbose  打印每条改写明细
 * ============================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
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

/** 收集所有可能含引用的源文件（HTML + CSS，排除 scripts/deploy/data 等） */
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

/**
 * 把一个引用字符串解析为磁盘绝对路径。
 *  - 以 "/" 开头：相对站点根
 *  - 否则：相对引用所在文件目录
 * 返回 null（外链、越界、不存在）。
 */
function resolveRef(refRaw, fromFile) {
  const clean = stripQueryHash(refRaw);
  if (!clean || isExternal(refRaw)) return null;
  const abs = clean.startsWith('/')
    ? path.join(ROOT, clean)
    : path.resolve(path.dirname(fromFile), clean);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 越界
  let st;
  try { st = fs.statSync(abs); } catch (e) { return null; }
  if (!st.isFile()) return null;
  return abs;
}

function baseOf(p) { return path.basename(p); }

function isExcluded(absPath) {
  const b = baseOf(absPath);
  if (EXCLUDE_BASE.has(b)) return true;
  // 已经是指纹名（幂等）
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

/* ------------------------------------------------------------------ *
 * 正则：HTML 的 (href|src) 与 CSS 的 url()
 * 用函数替换，回调里再解析，避免误伤外部 URL / data URI。
 * ------------------------------------------------------------------ */
const RE_HTML_REF = /(href|src)="([^"]+)"/gi;
const RE_CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/** 遍历源文件，发现被字面引用的本地资源，递归把 CSS url() 里的资源也纳入 */
function discoverTargets(src) {
  const targets = new Set();      // 绝对磁盘路径
  const queue = [...src.css];      // CSS 需要额外扫描其 url()
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
      // 嵌套 CSS（@import 少见，但 url() 引到别的 css 也纳入扫描）
      if (extOf(ref) === '.css' && !seenCss.has(abs)) { seenCss.add(abs); queue.push(abs); }
    }
  }

  src.html.forEach(addFromHtml);
  while (queue.length) addFromCss(queue.shift());
  return targets;
}

/** 改写单个源文件里命中 manifest 的本地引用为哈希名；返回 [新内容, 改写次数] */
function rewriteFile(file, manifest, hashCache) {
  const isCss = file.endsWith('.css');
  const txt = fs.readFileSync(file, 'utf8');
  let count = 0;
  const re = isCss ? RE_CSS_URL : RE_HTML_REF;
  re.lastIndex = 0;

  const out = txt.replace(re, (whole, ...args) => {
    let prefix, ref, suffix;
    if (isCss) {
      // groups: quote, url
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
      // groups: attr, value
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

function main() {
  const src = collectSourceFiles();
  const targets = discoverTargets(src);

  // 生成 manifest：绝对路径 -> {name, buf...}，并把哈希副本落盘（同目录）
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

  // 改写目标：所有 HTML + 所有被纳入的 CSS（改写后写回；CSS 同时把改写内容写入哈希副本）
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
    // 哈希副本内容 = 原 CSS 改写 url() 后的内容
    const info = hashCache.get(abs);
    if (!DRY && info) fs.writeFileSync(path.join(path.dirname(abs), info.name), out, 'utf8');
    if (n > 0) { touchedFiles++; touchedRefs += n; }
  }

  const label = DRY ? '[dry-run 未落盘] ' : '';
  console.log(`${label}指纹完成：资源 ${manifest.size} 个，改写引用 ${touchedRefs} 处，涉及 ${touchedFiles} 个文件`);

  // 拦 CI：有字面引用的 css/js 资源却一个都没命中，多半是引用形态未适配（异常），报错
  const localAssets = [...targets];
  if (!DRY && src.html.length > 0 && touchedRefs === 0 && localAssets.length > 0) {
    console.error('[fingerprint] 发现本地资源但改写引用为 0，疑似引用解析未适配，终止');
    process.exitCode = 1;
  }
}

main();
