#!/usr/bin/env node
/**
 * 专题/活动落地页生成（M10）
 * —— 读取 scripts/topics.json，按 topic-template.html 渲染 topic/<slug>.html。
 *    页面通过 body[data-kw] + window.__TOPIC__ 复用 list-page.js 的搜索/分页/平台筛选能力，零重复逻辑。
 * 用法：node scripts/build-topics.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const topics = JSON.parse(fs.readFileSync(path.join(root, 'scripts/topics.json'), 'utf8'));
const tpl = fs.readFileSync(path.join(root, 'topic-template.html'), 'utf8');
const outDir = path.join(root, 'topic');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

let n = 0;
topics.forEach(function (t) {
  const html = tpl
    .split('{{SLUG}}').join(t.slug)
    .split('{{KW}}').join(t.kw)
    .split('{{TITLE}}').join(t.title)
    .split('{{DESC}}').join(t.desc || '')
    // 模板源件默认 noindex（防裸模板被收录）；生成的真实专题落地页恢复 index, follow 照常收录
    .split('content="noindex, nofollow"').join('content="index, follow"');
  fs.writeFileSync(path.join(outDir, t.slug + '.html'), html, 'utf8');
  console.log('[build-topics] 生成 topic/' + t.slug + '.html');
  n++;
});
console.log('[build-topics] 完成，共 ' + n + ' 个专题页');
