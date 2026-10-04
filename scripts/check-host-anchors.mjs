#!/usr/bin/env node
/**
 * host 声明锚点门（批A 修复新增防线）。
 *
 * 职责：src/types/sillytavern.d.ts 的每条 export 声明必须带 hostAnchor
 * 锚点注释（宿主源码 file:line + 片段）；本脚本解析全部锚点、读宿主
 * checkout 对应行、规范化空白后比对片段。任一失败（片段不再匹配、
 * 宿主文件/行缺失、声明缺锚点）→ exit 1。
 *
 * 锚点格式（写在声明上方的 doc 注释内，一条声明可带多条）：
 *   @hostAnchor <宿主内相对路径>:<行号> <片段文本>
 *
 * 注意：宿主 checkout 路径是本机专属常量——该门依赖本机存在的
 * TauriTavern 源码 checkout，其他机器跑此脚本会明确报错（不静默跳过）。
 * 宿主升级导致行号/内容漂移时，重核签名后同步更新 d.ts 与锚点。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DTS_PATH = join(ROOT, 'src', 'types', 'sillytavern.d.ts');
// 本机专属：TauriTavern 源码 checkout（工作区 repos 树）
const HOST_SRC_ROOT = 'D:\\code\\repos\\TauriTavern\\src';

const problems = [];

function fail(message) {
    console.error(`[check-host-anchors] FAIL: ${message}`);
    process.exit(1);
}

if (!existsSync(HOST_SRC_ROOT)) {
    fail(`宿主源码 checkout 不存在：${HOST_SRC_ROOT}（本门为本机专属检查，无该路径的机器不可跳过）`);
}
if (!existsSync(DTS_PATH)) {
    fail(`声明文件不存在：${DTS_PATH}`);
}

// ---- 解析：锚点逐条收集 + export 声明覆盖检查 -----------------------------

const EXPORT_RE = /^\s*export\b/;
const COMMENT_LINE_RE = /^\s*(?:\/\*\*|\*[^/]*|\*|\/\/)/;

const dtsText = readFileSync(DTS_PATH, 'utf8');
const dtsLines = dtsText.split(/\r?\n/);

function norm(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function anchorsInLine(line) {
    // 锚点独占一行（一条声明可带多条锚点行）；行尾容许 doc 注释收口
    const ANCHOR_LINE_RE = /@hostAnchor\s+([^\s:]+):(\d+)\s+(.+?)(?:\*\/)?\s*$/g;
    const found = [];
    let m;
    while ((m = ANCHOR_LINE_RE.exec(line)) !== null) {
        found.push({ file: m[1], line: Number(m[2]), fragment: m[3] });
    }
    return found;
}

const anchors = [];
for (let i = 0; i < dtsLines.length; i++) {
    for (const a of anchorsInLine(dtsLines[i])) {
        anchors.push({ ...a, dtsLine: i + 1 });
    }
}

// 覆盖检查：每条 export 声明上方的连续注释块内必须至少一条锚点
for (let i = 0; i < dtsLines.length; i++) {
    if (!EXPORT_RE.test(dtsLines[i])) continue;
    let found = false;
    let j = i - 1;
    // 向上走连续的注释行与空行（doc 注释紧邻声明）
    while (j >= 0 && (COMMENT_LINE_RE.test(dtsLines[j]) || dtsLines[j].trim() === '')) {
        if (anchorsInLine(dtsLines[j]).length > 0) found = true;
        j--;
    }
    if (!found) {
        problems.push(`声明缺 hostAnchor 锚点：sillytavern.d.ts:${i + 1} ${dtsLines[i].trim()}`);
    }
}

// ---- 比对：读宿主 checkout 对应行，规范化空白后包含匹配 -------------------

const hostLinesCache = new Map();

function readHostLine(file, lineNo) {
    if (!hostLinesCache.has(file)) {
        const path = join(HOST_SRC_ROOT, file);
        if (!existsSync(path)) {
            hostLinesCache.set(file, null);
            problems.push(`锚点指向的宿主文件不存在：${file}`);
        } else {
            hostLinesCache.set(file, readFileSync(path, 'utf8').split(/\r?\n/));
        }
    }
    const lines = hostLinesCache.get(file);
    if (lines === null) return undefined;
    return lines[lineNo - 1];
}

if (anchors.length === 0) {
    problems.push('未解析到任何 hostAnchor 锚点（格式漂移或全部缺失）');
}

for (const a of anchors) {
    const hostLine = readHostLine(a.file, a.line);
    if (hostLine === undefined) {
        // 文件缺失已记；行号越界在此记录
        const lines = hostLinesCache.get(a.file);
        if (lines !== null && lines !== undefined && (a.line < 1 || a.line > lines.length)) {
            problems.push(`锚点行号越界：${a.file}:${a.line}（宿主文件共 ${lines.length} 行）`);
        }
        continue;
    }
    const host = norm(hostLine);
    const fragment = norm(a.fragment);
    if (!host.includes(fragment)) {
        problems.push(`锚点漂移：${a.file}:${a.line} 宿主行为「${host}」不包含锚点片段「${fragment}」（d.ts:${a.dtsLine}）`);
    }
}

if (problems.length > 0) {
    for (const p of problems) console.error(`[check-host-anchors] FAIL: ${p}`);
    process.exit(1);
}

const moduleCount = (dtsText.match(/declare module/g) ?? []).length;
console.log(`[check-host-anchors] OK：${moduleCount} 个 @sillytavern 声明模块、${anchors.length} 条锚点全部与宿主源码一致（${HOST_SRC_ROOT}）。`);
