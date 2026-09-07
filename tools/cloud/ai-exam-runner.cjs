#!/usr/bin/env node
/* ============================================================
 * kaoyan2026 云端出卷执行器（GitHub Actions 内运行，2026-08-24）
 * 流水线：读任务 → 总工规划(1 call) → 并发出题池(conc 4) → 蓝本硬校验(纯代码)
 *        → 总工程师审查(1 call) → 定向重写池(conc 3) → 终检 → result.json 回写 Gist
 * 环境变量（全部来自 repo secrets / dispatch inputs）：
 *   GIST_ID      任务 Gist id（workflow_dispatch inputs）
 *   GH_TOKEN     GitHub 令牌（需 gist 权限）
 *   AI_ENDPOINT  OpenAI 兼容接口地址（如 https://api.xxx.com/v1）
 *   AI_KEY       接口密钥
 *   AI_MODEL     模型名
 * 设计原则：任何阶段失败 → status.json 标 error + 原因；绝不把半成品标 done。
 *           用户在本地取消（status=canceled）→ 阶段边界检测到即退出。
 * ============================================================ */
'use strict';
/* TOOLS:python v8 —— 云端闭环出题（2026-08-31）：出题/重写/审查 AI 可自主调用
 * 沙箱 Python（sympy/numpy），按人类命题人闭环工作：产生思路→计算验证→
 * 闭环调整→验收合格→输出。子进程 env 已净化，
 * GH_TOKEN/AI Key 等敏感变量不传入。不可用时自动退化为纯 LLM 出卷。 */
const { exec: cpExec } = require('child_process');
const osT = require('os');
const fsT = require('fs');
const pathT = require('path');
let PY_TOOLS_ON = false;
function execPython(code) {
  return new Promise((resolve) => {
    const f = pathT.join(osT.tmpdir(), 'at_tool_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.py');
    try { fsT.writeFileSync(f, String(code || ''), 'utf8'); } catch (e) { resolve({ ok: false, output: '', error: '写临时文件失败' }); return; }
    cpExec('python3 ' + JSON.stringify(f), {
      timeout: 30000, maxBuffer: 1024 * 1024, cwd: process.cwd(),
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', PYTHONIOENCODING: 'utf-8' }
    }, (err, stdout, stderr) => {
      try { fsT.unlinkSync(f); } catch (e) {}
      resolve({ ok: !err, output: String(stdout || '').slice(0, 1500), error: err ? (String(stderr || '').slice(0, 600) || err.message) : '' });
    });
  });
}
const https = require('https');
const { URL } = require('url');

const API = 'https://api.github.com';
const GIST_ID = process.env.GIST_ID || '';
const SOURCE_GIST_ID = process.env.SOURCE_GIST_ID || '';   // 【v11】PDF 导入时源文件所在独立 Gist（任务 Gist 截断时绕路用）
const GH_TOKEN = process.env.GH_TOKEN || '';
/* 【2026-09-02 PDF 导入】通用 shell 执行（poppler 工具链：pdfinfo/pdftotext/pdftoppm）。
 * 参数一律 JSON.stringify 引号化防注入；只允许跑本机二进制，不接收任何来自 Gist/AI 的命令文本。
 * ⚠️ poppler 在 ubuntu-latest 上**并未预装**（2026-09-02 真机踩坑），由 ensurePoppler 负责探测+自救。 */
function runShell(cmd, timeoutMs, maxBuffer) {
  return new Promise((resolve) => {
    cpExec(cmd, { timeout: timeoutMs || 60000, maxBuffer: maxBuffer || 8 * 1024 * 1024, cwd: process.cwd(),
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: 'C.UTF-8' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: err ? (String(stderr || '').slice(0, 400) || err.message) : '' }));
  });
}
/* 【v11 poppler 可用性】踩坑实证（2026-09-02）：GitHub Actions 的 ubuntu-latest
 * **并不预装** poppler-utils（此前假设「自带」是错的，真机实测 pdfinfo: not found）。
 * 三道防线：① 开跑前探测；② 缺失则运行时自救（Actions runner 有免密 sudo，装一次约 10~20s）
 * ——即使用户仓库里的 workflow 还是旧版（不含安装步骤），导入任务也能自己救回来；
 * ③ 装不上时给出「点一键安装升级 workflow」的明确出路，绝不再把环境缺失误报成文件损坏。 */
let POPPLER_READY = false;
async function ensurePoppler() {
  if (POPPLER_READY) return true;
  const probe = await runShell('command -v pdfinfo; command -v pdftotext; command -v pdftoppm', 20000);
  const out = String(probe.out || '');
  if (out.indexOf('pdfinfo') >= 0 && out.indexOf('pdftotext') >= 0 && out.indexOf('pdftoppm') >= 0) {
    POPPLER_READY = true;
    return true;
  }
  pushLog('⚙️ poppler-utils 缺失，尝试自动安装…', 'warn');
  const inst = await runShell('sudo apt-get update -qq && sudo apt-get install -y -qq poppler-utils', 240000);
  const probe2 = await runShell('command -v pdfinfo; command -v pdftotext; command -v pdftoppm', 20000);
  const out2 = String(probe2.out || '');
  POPPLER_READY = !!(out2.indexOf('pdfinfo') >= 0 && out2.indexOf('pdftotext') >= 0 && out2.indexOf('pdftoppm') >= 0);
  if (POPPLER_READY) pushLog('✅ poppler-utils 已自动安装就绪（pdfinfo/pdftotext/pdftoppm 齐备）');
  else pushLog('⚠️ poppler-utils 自动安装失败：' + String(inst.err || '').slice(0, 120), 'warn');
  return POPPLER_READY;
}
/* gist 大文件（>1MB 会被 API 响应截断）：抓 raw_url。secret gist 的 raw 匿名 404，
 * 必须带 GH_TOKEN；返回 Buffer（PDF/base64 都可能非 UTF-8 安全）。 */
function ghGetRawBuffer(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'User-Agent': 'kaoyan2026-cloudjob-runner' },
      timeout: 120000
    }, res => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('raw HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('raw 拉取超时')));
    req.on('error', reject);
    req.end();
  });
}
// 取 gist 中某文件的完整文本：truncated 或 content 缺失/空/与 size 对不上时都走 raw_url 回补。
// 教训：2026-09-02 导入任务因此崩在 JSON.parse 失败（GitHub Gist API 在大文件边界下
// 偶发把小文件 content 置空、不标 truncated——L902 守卫只看 key 不看 content 就掉坑）。
async function gistFileText(files, name) {
  const f = files && files[name];
  if (!f) return null;
  const needRaw = !!f.truncated || !f.content || !f.content.length
    || (f.size && f.content.length < f.size);
  if (!needRaw) return f.content;
  if (!f.raw_url) throw new Error(name + ' content 缺失且无 raw_url（无法回补）');
  const buf = await ghGetRawBuffer(f.raw_url);
  return buf.toString('utf8');
}
async function gistFileBuffer(files, name) {
  const f = files && files[name];
  if (!f) return null;
  const needRaw = !!f.truncated || !f.content || !f.content.length
    || (f.size && f.content.length < f.size);
  if (!needRaw) return Buffer.from(f.content, 'utf8');
  if (!f.raw_url) throw new Error(name + ' content 缺失且无 raw_url（无法回补）');
  return await ghGetRawBuffer(f.raw_url);
}
// 【v11】从资源 Gist / 任务 Gist 读 PDF/图片源文件：先 source.pdf（>1MB 走 b64 走 b64 通道）
async function readSourceBuffer(files, tag) {
  if (files['source.pdf']) return await gistFileBuffer(files, 'source.pdf');
  if (files['source.pdf.b64']) {
    const t = await gistFileText(files, 'source.pdf.b64');
    if (!t) return null;
    return Buffer.from(String(t).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  // 标签友好化：资源 Gist 'source.pdf.b64' / 任务 Gist 'source.pdf.b64'，但报错时区分
  if (Object.keys(files || {}).length === 0) throw new Error(tag + ' 内无任何 files');
  throw new Error(tag + ' 内没有 source.pdf / source.pdf.b64（候选 files：' + Object.keys(files).join(',') + '）');
}
// 执行器版本（单一事实来源）：本地 cloudjob.ts 用正则从本文件源码提取（本地资产 vs 仓库远端），
// 向导第②步显示「云端 v? vs 本地 v?」。改版本只改这一处，所有 status.json 回写自动跟随。
// 版本规则：runner 行为变更才 +1（v15 = 资料库 book 通道；v16 = 429 共享闸门不弃题 + score=0 自动均摊修复；v17 = book 分发致命修复 + 数学乱码转视觉）。
const RUNNER_VER = 'v25';

if (!GIST_ID || !GH_TOKEN) { console.error('缺 GIST_ID 或 GH_TOKEN'); process.exit(1); }

function log(...a) { console.log('[runner]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// AI 配置：优先 job.json 里的 prefs.ai（本地工具自动写入，免配 secrets），回退 repo secrets。
// 在主流程读到 job 后调用 initAiConf() 完成校验。
let JOB_AI = null;
let JOB_THINK = false;   // 思考模式（来自 job.prefs.think）——结构化 JSON 默认关闭，避免思考烧光 token 致空正文
let JOB_MAXTOK = 32768;  // 最大输出 token（2026-08-31 用户要求：默认 8000→32768；可被 job.prefs.maxTokens 覆盖，钳制 1024-65536）
let JOB_MAJOR = '';      // 专业课名（来自 job.prefs.major）——"专业课"科目出卷时必须具体到专业，否则出成泛化卷
function aiConf(k) {
  if (JOB_AI && JOB_AI[k]) return String(JOB_AI[k]);
  return process.env['AI_' + k.toUpperCase()] || '';
}
// 科目显示名：专业课带具体专业名（如「专业课（自控原理）」），其余科目用静态名。
function subjName(subj) {
  if (subj === 'ctrl' && JOB_MAJOR) return '专业课（' + JOB_MAJOR + '）';
  return (SUBJ_NAME[subj] || '综合');
}

// ---------- GitHub Gist ----------
function ghReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'kaoyan2026-cloudjob-runner',
        'Content-Length': data ? Buffer.byteLength(data) : 0
      },
      timeout: 30000
    }, res => {
      let txt = '';
      res.on('data', c => txt += c);
      res.on('end', () => {
        if (res.statusCode === 204) return resolve(null);
        let d = null;
        try { d = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (res.statusCode >= 400) {
          const e = new Error('GitHub HTTP ' + res.statusCode + ' ' + txt.slice(0, 200));
          e.status = res.statusCode;
          // 【2026-09-01 限额长退避】403/429 必须区分「限额」与「权限」：限额是暂时的
          //（窗口最长 60 分钟），权限错误是永久的。靠响应头识别，把 reset 时刻带给
          // ghRetry 安排真正的等待，而不是 2~8s 后放弃（那正是「进度冻结一小时」的元凶）。
          const rem = res.headers && res.headers['x-ratelimit-remaining'];
          const rst = res.headers && res.headers['x-ratelimit-reset'];
          if (res.statusCode === 429 || String(rem) === '0') {
            e.rateLimited = true;
            if (rst) e.rateReset = Number(rst) * 1000;
            const ra = res.headers && res.headers['retry-after'];
            if (ra) e.retryAfterMs = Number(ra) * 1000;
          }
          return reject(e);
        }
        resolve(d);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('GitHub 请求超时')));
    if (data) req.write(data);
    req.end();
  });
}
// 【2026-09-01 限额长退避】限额等待总预算：本地轮询 + 执行器回写共用同一个 PAT，
// 5000 次/时烧穿后，等窗口重置（最长 60 分钟）是唯一出路。预算 30 分钟封顶，
// 防止无限等把 Actions 时长烧光；预算耗尽才真正放弃（写 error 终态）。
let _rlWaitBudgetMs = 30 * 60 * 1000;
async function ghRetry(method, path, body, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await ghReq(method, path, body); }
    catch (e) {
      if (e.rateLimited) {
        // 等到 reset 时刻（+3s 余量），单次最长 5 分钟、且不得超过剩余预算
        let waitMs = e.retryAfterMs || (e.rateReset ? Math.max(0, e.rateReset - Date.now() + 3000) : 60000);
        waitMs = Math.min(waitMs, 300000, _rlWaitBudgetMs);
        if (waitMs <= 0) throw new Error('GitHub API 限额持续未恢复（已累计等待 30 分钟），本次任务放弃回写：' + e.message);
        _rlWaitBudgetMs -= waitMs;
        log('⏸ GitHub API 限额，退避 ' + Math.round(waitMs / 1000) + 's 后重试（等待预算剩 ' + Math.round(_rlWaitBudgetMs / 60000) + ' 分钟）');
        pushLog('⏸ GitHub API 限额耗尽：退避 ' + Math.round(waitMs / 1000) + 's 后继续（出题不中断，进度回写延后）', 'warn');
        await sleep(waitMs);
        i = -1;   // 限额等待不计入普通重试次数
        continue;
      }
      if (i >= tries - 1 || (e.status && e.status < 500 && e.status !== 403)) throw e;
      log('GitHub 请求失败重试', i + 1, e.message);
      await sleep(2000 * (i + 1));
    }
  }
}
// ---------- 过程事件日志（写进 status.json.log，前端 aiFloat 浮窗实时可视化） ----------
/* 【H5，2026-08-30】运行日志：带级别(level)与耗时(dur)，并在失败时单独落盘 log.json。
 * 为什么日志要带级别：出卷跑 10~20 分钟、日志上百条，失败后用户只想看「哪一刻开始出问题」，
 * 平铺文本没法筛选。带级别后客户端可以直接定位到最后一条 error/warn。
 * 为什么还要单独落盘 log.json：日志一直挂在 status.json 里，而 status.json 是每次状态变更
 * 全量覆写——如果最后一次写 status 恰好失败（网络/权限/体积），日志就跟着一起丢了，
 * 那正是最需要看日志的时刻。所以失败分支额外把完整日志写一份独立的 log.json。 */
const RUN_LOG = [];
function pushLog(msg, level, dur) {
  const lv = (level === 'warn' || level === 'error') ? level : 'info';
  RUN_LOG.push({ t: new Date().toISOString(), lv: lv, msg: String(msg), dur: (typeof dur === 'number' ? dur : null) });
  if (RUN_LOG.length > 120) RUN_LOG.splice(0, RUN_LOG.length - 120);   // 只留最近 120 条
}
// 失败时把完整日志单独写一份（不受 status.json 覆写失败影响）
async function writeLogFile(extra, jobId) {
  try {
    const payload = { runnerVer: RUNNER_VER, jobId: jobId || '', at: new Date().toISOString(), error: extra || null, entries: RUN_LOG };
    await ghRetry('PATCH', '/gists/' + GIST_ID, { files: { 'log.json': { content: JSON.stringify(payload) } } }, 2);
    log('📜 已落盘 log.json（' + RUN_LOG.length + ' 条）');
  } catch (e) { log('!! log.json 落盘失败（不影响主流程）：', e.message); }
}

// ---------- 逐题状态跟踪（写进 status.json.qs，前端浮窗渲染逐题卡片墙） ----------
// st: wait=排队中 / run=出题中 / done=完成 / fail=生成失败 / rewrite=重写中
const QS = [];
// 已出合格题目（用于「停止并保存」——取消时把已完成的题攒成 partial 卷）
let SAVED = [];

// ---------- 已出题目的持续落盘（partial.json） ----------
// 【2026-08-29 重构】旧实现的死结：已出题目只活在进程内存 SAVED 里，Gist 上没有任何题目内容
// （status.json.qs 只是状态摘要，stem 被截断到 140 字符，无法还原成题）。于是「停止并保存」
// 完全依赖本进程存活——可用户恰恰是在「出卷失败」（进程已走 error 分支退出）后才去点保存，
// 此时没人读 cancel.json、没人写 result.json，本地轮询 40s 永远等不到，题目随进程永久丢失。
//
// 改为：每出好一题，立即把「已完成题目全集」增量写进 Gist 的 partial.json。
// 题目不再只活在内存：进程崩了/失败了/被取消了，之前落盘的题仍在 Gist 上，
// 客户端可自行读取组装成部分卷（CloudJob.collectPartial），完全不需要本进程配合。
//
// 两个落盘时机：
//   ① 出题阶段每题完成后（初稿，reviewed=false）
//   ② 终检通过后、写 result.json 之前（终稿，reviewed=true）
//   ② 很关键：写 result.json 是整条链路最后一步、文件最大、最容易失败，
//      落盘终稿后即使这一步挂了，客户端仍能抢救到「经过审查的完整卷」而非初稿。
let _flushChain = Promise.resolve();
let _partialCount = 0;   // 已成功落盘的题数（写进 status.json.savedCount，即「可抢救数量」）
// 【2026-09-03 配额治理】每题完成即写 partial.json 的「全集」是第二烧配额大户：
// 22 题卷子 = 22 次 PATCH，且 payload 随题目累积越来越大。改为「每 3 题或距上次 ≥90s」
// 落一次（opts.force 绕过节流）：抢救粒度从「最多丢 1 题」变「最多丢 3 题/90s」，
// 而一题要 30s~2min —— 实际丢题窗口 <1 题，几乎无损。终稿/取消/失败前抢救一律 force。
// 【竞态修正】节流计数改为「同步预约」：旧实现在异步链内 PATCH 成功后才更新 _lastFlushCount，
// 并发完成多题时它们同步检查看到的都是旧值 → 全部通过节流各自排队（harness 实测 6 题落 7 次）。
// 现在决策与预约在函数顶部同步完成，异步链只负责 PATCH——后续调用立即看到已预约的题数。
let _flushAt = 0, _flushCount = 0;   // 最近一次「已发起」落盘的时刻与题数（同步预约，非落盘成功）
const _FLUSH_EVERY_N = 3, _FLUSH_MIN_MS = 90000;
async function flushPartial(questions, opts) {
  opts = opts || {};
  const list = (questions || []).filter(q => q && q.stem);
  const now = Date.now();
  if (!opts.force) {
    if (list.length > 0 && list.length <= _flushCount) return _flushChain;   // 已被预约覆盖（无更新的题）
    if (_flushCount > 0 && list.length - _flushCount < _FLUSH_EVERY_N
        && now - _flushAt < _FLUSH_MIN_MS) return _flushChain;   // 节流窗口内攒着
  }
  _flushAt = now; _flushCount = list.length;   // 同步预约：本次将落盘 list.length 题
  _flushChain = _flushChain.then(async () => {
    const payload = {
      count: list.length,
      reviewed: !!opts.reviewed,
      subject: opts.subject || 'math',
      updatedAt: new Date().toISOString(),
      questions: list
    };
    if (opts.imported) payload.imported = true;   // v10：导入通道落盘标记（客户端据此区分抢救卷类型）
    try {
      await ghRetry('PATCH', '/gists/' + GIST_ID, { files: { 'partial.json': { content: JSON.stringify(payload) } } }, 3);
      _partialCount = list.length;
      log('💾 落盘 partial.json：' + list.length + ' 题' + (opts.reviewed ? '（终稿·已过审）' : '（初稿）'));
    } catch (e) {
      // 落盘失败绝不中断出题主流程：最坏退回「这一题没落盘」，其余题目继续出
      log('!! partial.json 落盘失败（不中断出卷）：', e.message);
    }
  }).catch(() => {});
  return _flushChain;
}

/* 【H1 断点续跑，2026-08-30】读回已落盘的 partial.json。
 * 续跑的前提是「之前出的题还在」——这正是 2026-08-29 那次落盘重构换来的能力：
 * 题目不再只活在进程内存里，进程死了题还在 Gist 上，新进程可以直接接着出。 */
function readPartialJson(gist) {
  try {
    const f = gist && gist.files && gist.files['partial.json'];
    if (!f) return null;
    if (f.truncated) return { __truncated: true };
    return JSON.parse(f.content || '{}');
  } catch (e) { log('!! partial.json 解析失败：', e.message); return null; }
}

// setStatus 串行化：多 worker 并发完成时 PATCH 同一 gist 文件，链式排队避免互踩/乱序
//
// 【2026-09-03 配额救星·状态回写风暴治理】旧实现每次状态变更都全量 PATCH status.json
// （带整个 RUN_LOG + 全部 QS），一次 22 题出卷光「每题开工写一次 + 完成写一次」就烧 ~44 次
// PATCH，叠加 flushPartial 每题全集重写、checkCancel 每题探测，单任务 PATCH+GET 逼近 150 次。
// 多任务并发或本地云同步同时轮询时，一小时 5000 配额轻松烧穿 → 「进度冻结一小时」。
// 三重治理（均不改变出题质量与抢救能力）：
//   ① 去重：status+stage+msg+progress 全同 → 直接跳过（不写）。
//   ② 节流合并：同阶段内非终态且距上次真实写 < 8s → 只保留「最新一条」待发，窗口到点写一次。
//      并发出题时 genDone 递增被合并，进度条不倒退。
//   ③ 立即写：终态（done/error/canceled）、阶段切换（planning→generating 等里程碑）、
//      force（调用方显式要求）绕过节流，保证关键节点即时可见。
let _stChain = Promise.resolve();
const _ST_THROTTLE_MS = 8000;
let _stLast = { key: '', at: 0, stage: '' };
let _stPending = null;   // { status, stage, msg, progress, timer }
function _stKey(status, stage, msg, progress) { return [status, stage, msg, progress].join('|'); }
function setStatus(status, stage, msg, progress, force) {
  const key = _stKey(status, stage, msg, progress);
  const now = Date.now();
  const terminal = status !== 'running';   // done/error/canceled 必须即时
  const stageChanged = stage !== _stLast.stage;   // 阶段切换是里程碑，立即写
  // ① 去重：与上次真实写入完全相同 → 跳过
  if (!force && !terminal && !stageChanged && key === _stLast.key) return _stChain;
  // ② 节流合并：同阶段内非终态非强制 + 距上次写 < 窗口 → 攒最新待发（旧待发被覆盖）
  if (!force && !terminal && !stageChanged && (now - _stLast.at) < _ST_THROTTLE_MS) {
    if (_stPending) clearTimeout(_stPending.timer);
    const pend = { status, stage, msg, progress };
    pend.timer = setTimeout(function () {
      if (_stPending === pend) _stPending = null;
      _stChain = _stChain.then(() => _setStatus(status, stage, msg, progress)).catch(() => {});
    }, _ST_THROTTLE_MS - (now - _stLast.at));
    _stPending = pend;
    return _stChain;
  }
  // ③ 立即写（force / 终态 / 超窗口）：先丢弃待发（本次已含其最新信息）
  if (_stPending) { clearTimeout(_stPending.timer); _stPending = null; }
  _stChain = _stChain.then(() => _setStatus(status, stage, msg, progress)).catch(() => {});
  return _stChain;
}
// 强制冲刷待发状态（终止/收卷等关键退出点调用，确保节流攒着的最后进度不丢）
function flushPendingStatus() {
  if (_stPending) {
    const p = _stPending; _stPending = null;
    clearTimeout(p.timer);
    _stChain = _stChain.then(() => _setStatus(p.status, p.stage, p.msg, p.progress)).catch(() => {});
  }
  return _stChain;
}
// 丢弃待发状态（调用方紧接着要用 ghRetry 直写终态时用）：终态已含最新信息，
// 若不清待发，8s 后迟到的 running PATCH 会把刚写好的 done/error 覆盖回去。
function dropPendingStatus() {
  if (_stPending) { clearTimeout(_stPending.timer); _stPending = null; }
}
async function _setStatus(status, stage, msg, progress) {
  pushLog((stage ? '[' + stage + '] ' : '') + (msg || ''));
  // savedCount = 已成功落盘到 partial.json 的题数（= 客户端随时能抢救走的数量），
  // 让本地无需额外拉 Gist 就知道「现在有几题可抢救」，任务行可直接显示入口。
  const payload = { files: { 'status.json': { content: JSON.stringify({ status, stage: stage || '', msg: msg || '', progress: progress == null ? null : progress, log: RUN_LOG, qs: QS, savedCount: _partialCount, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER }) } } };
  try { await ghRetry('PATCH', '/gists/' + GIST_ID, payload); _stLast = { key: _stKey(status, stage, msg, progress), at: Date.now(), stage: stage }; log('status →', status, stage || '', msg || ''); return true; }
  catch (e) {
    const hint = (e && e.status === 404)
      ? '　👉 诊断：能读 job.json 却写不回 status，几乎可断定 CLOUDJOB_GH_TOKEN 对 Gist 缺「写」权限（请用 classic PAT 勾选 gist，或 fine-grained PAT 把 Gist 设为 Read & Write）'
      : '';
    log('!! 写状态失败（不中断主流程）：', e.message + hint);
    return false;
  }
}

// ---------- AI 调用（OpenAI 兼容 /chat/completions） ----------
function aiCall(messages, opts = {}) {
  const maxTok = opts.maxTokens || JOB_MAXTOK;   // 默认 32768（可经 job.prefs.maxTokens 配置）；思考模型开时一半耗在 reasoning 上
  // 本地 job.json 里 endpoint 是「完整请求 URL」（含 /chat/completions，如 openrouter 的
  // /api/v1/chat/completions）；repo secrets 回退时可能是 base URL（如 /api/v1）。幂等拼接，
  // 避免出现 /chat/completions/chat/completions 双拼导致 AI 404。
  let endpoint = aiConf('endpoint').trim().replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(endpoint)) endpoint += '/chat/completions';
  const payload = { model: aiConf('model'), messages, temperature: opts.temperature == null ? 0.7 : opts.temperature, max_tokens: maxTok };
  // 思考模式控制：结构化 JSON 场景默认「不思考」——思考模型（LongCat-2.0 等）若开着思考，
  // 会把 max_tokens 全烧在 reasoning_content 上、content 返回空（finish_reason=length），
  // 这正是「云端卡在总审查三小时」的根因。 opts.think=true 才显式发 enable_thinking:true；
  // opts._plain=true（400 降级重试）则彻底去掉 chat_template_kwargs，兼容不认该字段的接口。
  if (!opts._plain) {
    payload.chat_template_kwargs = { enable_thinking: !!opts.think };
  }
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + aiConf('key'), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: opts.timeoutMs || 240000
    }, res => {
      let txt = '';
      res.on('data', c => txt += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('AI HTTP ' + res.statusCode + ' ' + txt.slice(0, 300)));
        try {
          const d = JSON.parse(txt);
          const ch0 = d.choices && d.choices[0];
          const msg = ch0 && ch0.message;
          const content = String((msg && msg.content) || '').trim();
          if (!content) {
            // 空正文诊断：思考模型把 max_tokens 全烧在 reasoning 上时 content 为空（finish_reason=length）
            // 必须用 reject 而非 throw——此处处于 res.on('end') 事件回调内，throw 会变成
            // 未捕获异常直接崩掉进程，主流程 catch→setStatus('error') 永远执行不到，
            // 任务状态就冻结在半路（12 小时假运行的根因）。
            const fr = (ch0 && ch0.finish_reason) || '?';
            const hasReason = !!(msg && (msg.reasoning_content || msg.reasoning));
            return reject(new Error('AI 返回空正文（finish_reason=' + fr
              + (hasReason ? '；模型只输出了思考内容没写答案——请换非思考模型、关闭思考模式或调大 max_tokens' : '；模型未输出任何内容')
              + '）响应片段：' + txt.slice(0, 150)));
          }
          resolve(content);
        } catch (e) { reject(new Error('AI 响应解析失败: ' + txt.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 调用超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
// 【v16 429 共享闸门】全部 AI 调用共用一个限流闸门（单一收口）：任一调用撞 429 就把闸门推远
// （指数 + 抖动），所有在途/后续调用在闸门前排队错峰重试。旧实现各 worker 独立退避固定 15s——
// 10 路同时撞 429 → 同时睡 15s → 同时重撞（惊群），低并发量 API（2~3 路）被撞得整段失败。
let AI_GATE_UNTIL = 0;    // 闸门截止时间戳（最新一次 429 推远它）
let AI_GATE_STRIKES = 0;  // 连续 429 计数（指数退避档位）
let AI_GATE_LAST_LOG = 0; // 日志去重：风暴期每 10s 最多一行，不刷屏
async function aiGateWait() {
  while (Date.now() < AI_GATE_UNTIL) {
    await sleep(Math.min(AI_GATE_UNTIL - Date.now(), 800) + Math.random() * 250);   // 轮询 + 抖动：唤醒天然错峰
  }
}
async function aiRetry(messages, opts, tries = 3) {
  const deadline = Date.now() + 10 * 60000;   // 限流整体等待预算（防死循环；闸门是全员共享的，等待并行不叠加）
  let i = 0;   // 非 429 失败计数：429 不占重试次数——限流是全员的事，不能烧掉单题的重试配额（旧实现弃题的根源）
  for (;;) {
    try {
      await aiGateWait();
      // 【H5】只给「慢调用」打点：每题都记耗时会把日志淹没，而出卷卡住时用户真正想知道的
      // 就是「是哪一次调用特别慢」。阈值 30s（正常出题 10~40s，超 60s 基本可判定异常）。
      const _t0 = Date.now();
      const r = await aiCall(messages, opts);
      const _dur = Date.now() - _t0;
      if (_dur >= 30000) pushLog('🐢 AI 调用较慢：' + Math.round(_dur / 1000) + 's' + (_dur >= 60000 ? '（异常，可能是思考模型在长推理）' : ''), 'warn', _dur);
      AI_GATE_STRIKES = Math.floor(AI_GATE_STRIKES / 2);   // 成功半衰（不清零：混合流量下避免闸门反复失守）
      return r;
    }
    catch (e) {
      const m = (e && e.message) || '';
      const sm = m.match(/^AI HTTP (\d{3})/);
      const code = sm ? Number(sm[1]) : 0;
      // 400 且当前还带着 chat_template_kwargs：不少接口不认 enable_thinking 这个扩展字段，
      // 去掉该字段用纯 body 重试一次（对齐本地 ai.js 的「400 极简重试」降级链）。
      if (code === 400 && opts && !opts._plain) {
        log('AI 400：接口可能不认 chat_template_kwargs，去掉思考开关字段重试…');
        opts = Object.assign({}, opts, { _plain: true });
        continue;
      }
      // 401/403：令牌无效/无权限——重试毫无意义，立即失败并点破最常见根因
      if (code === 401 || code === 403) {
        throw new Error(m + '　👉 诊断：令牌无效或无权限。最常见根因是 endpoint 与 key 不匹配'
          + '（例如 endpoint 填了 api.agnes-ai.cn 但 key 还是 OpenRouter 的 sk-or-v1-…）。'
          + '请到押题页配置向导换成该平台自己的 key，保存后重新提交/重发任务');
      }
      // 其他 4xx（除 429/408）：请求本身有问题（模型名错/参数错），重试也不会好
      if (code && code >= 400 && code < 500 && code !== 429 && code !== 408) throw e;
      // 429 限流：推远全局闸门（指数 + 抖动），不占 tries，超时预算内一直重试——题目绝不因限流被弃
      if (code === 429 || code === 408) {
        if (Date.now() >= deadline) throw e;
        AI_GATE_STRIKES++;
        const backoff = Math.min(60000, 5000 * Math.pow(2, Math.min(AI_GATE_STRIKES - 1, 4))) * (0.8 + Math.random() * 0.4);
        const until = Date.now() + backoff;
        if (until > AI_GATE_UNTIL) {
          AI_GATE_UNTIL = until;
          if (Date.now() - AI_GATE_LAST_LOG > 10000) {
            AI_GATE_LAST_LOG = Date.now();
            pushLog('⏳ AI 限流 429：全局退避 ' + Math.round(backoff) + 's（连续 ' + AI_GATE_STRIKES + ' 次）——所有在途调用共享闸门、抖动错峰重试，题目不弃', 'warn');
          }
        }
        continue;
      }
      if (i >= tries - 1) throw e;
      i++;
      log('AI 调用失败重试', i, e.message);
      pushLog('🔁 AI 调用失败，' + (3 * i) + 's 后重试（第 ' + i + '/' + (tries - 1) + ' 次）：' + String(e.message).slice(0, 80), 'warn');
      await sleep(3000 * i);
    }
  }
}
// 【v13 子母卷】纯文本 AI 调用（带 aiRetry 重试链）：用于「命题形式研究报告」这类
// 输出为自然语言（非 JSON）的阶段。think 默认跟随 JOB_THINK，由调用方 opts 覆盖。
async function aiText(messages, opts) {
  return await aiRetry(messages, Object.assign({ think: JOB_THINK }, opts || {}));
}
// 宽容 JSON 抽取：剥 <think> 思考块 → 剥代码围栏 → 找首个平衡的 {...} 或 [...]
/* 【v23 LaTeX 转义修复】模型输出 JSON 字符串里的 LaTeX 命令（\sqrt \delta \frac…）含非法
 * JSON 转义（\s \d 不在合法集），严格 JSON.parse 必炸——李林四套卷实测
 * 「Bad escaped character in JSON at position 4247」整章报废。修复：非法 \x 补成合法 \\x。 */
function jsonRepairEscapes(t) {
  // 先处理 \u 后不跟 4 位十六进制的（LaTeX \use 等），再处理其余非法转义（\s \d 等）
  return String(t).replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u').replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
}
function extractJson(txt) {
  let t = String(txt || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // 思考模型的显式思考块
    .replace(/<think>[\s\S]*$/i, '')             // 未闭合的思考块（后面不会再有正文了）
    .trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/g, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  try { return JSON.parse(jsonRepairEscapes(t)); } catch (e) {}   // 【v23】LaTeX 非法转义修复后重试
  const starts = [t.indexOf('{'), t.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) throw new Error('输出中没有 JSON（原始输出前 160 字：' + t.slice(0, 160).replace(/\s+/g, ' ') + '）');
  const s = Math.min(...starts);
  const open = t[s], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (!depth) {
        const seg = t.slice(s, i + 1);
        try { return JSON.parse(seg); } catch (e) { return JSON.parse(jsonRepairEscapes(seg)); }   // 【v23】段内同样先修转义
      }
    }
  }
  throw new Error('JSON 不完整/被截断（输出末尾：…' + t.slice(-100).replace(/\s+/g, ' ') + '）。可尝试调大 max_tokens 或换模型');
}

// AI 调用 + 宽容 JSON 抽取一体化：网络/HTTP 错误由 aiRetry 重试；
// 解析类失败（没 JSON / 被截断 / 空正文）自动换一轮重问。
// 「空正文/finish_reason=length」= 思考模型把 token 全烧在 reasoning 上：优先「关思考」重试，
// 仍空再翻倍 max_tokens（上限 32768 ≈ 65536 的一半）——云端对齐本地后能跑通的关键，避免三小时卡死。
async function aiJson(messages, opts, tries = 3) {
  let o = Object.assign({ think: JOB_THINK }, opts || {});
  for (let i = 0; ; i++) {
    let out;
    try { out = await aiRetry(messages, o, 2); }
    catch (e) {
      const m = (e && e.message) || '';
      if (/空正文|finish_reason=length/.test(m)) {
        if (!(o._thinkOff)) { o = Object.assign({}, o, { _thinkOff: true, think: false }); log('思考模型烧光 token 致空正文 → 关思考重试'); }
        else if ((o.maxTokens || JOB_MAXTOK) < JOB_MAXTOK) { o = Object.assign({}, o, { maxTokens: Math.min((o.maxTokens || JOB_MAXTOK) * 2, JOB_MAXTOK) }); log('关思考仍空正文，max_tokens 翻倍至', o.maxTokens, '重试'); }
      } else if (/JSON 不完整/.test(m) && (o.maxTokens || JOB_MAXTOK) < JOB_MAXTOK) {
        o = Object.assign({}, o, { maxTokens: Math.min((o.maxTokens || JOB_MAXTOK) * 2, JOB_MAXTOK) });
        log('疑似输出截断，max_tokens 翻倍至', o.maxTokens, '重试');
      }
      if (i >= tries - 1) throw e;
      await sleep(2000 * (i + 1));
      continue;
    }
    try { return extractJson(out); }
    catch (e) {
      log('JSON 解析失败，重问', i + 1, '/', tries, '：', ((e && e.message) || '').slice(0, 120));
      if (/JSON 不完整/.test((e && e.message) || '') && (o.maxTokens || JOB_MAXTOK) < JOB_MAXTOK) {
        o = Object.assign({}, o, { maxTokens: Math.min((o.maxTokens || JOB_MAXTOK) * 2, JOB_MAXTOK) });
        log('疑似输出截断，max_tokens 翻倍至', o.maxTokens, '重试');
      }
      if (i >= tries - 1) throw e;
      await sleep(2500 * (i + 1));
    }
  }
}

// ---------- 工具调用循环（云端 sympy 验算/画图） ----------
// v8（2026-08-31 用户定调「像人一样闭环出题」）：与本地 AI 测验同一工作法——
// 产生思路→计算验证→闭环调整→验收合格→输出。每一轮都自主决定是否调工具/思考。
const TOOL_APPENDIX = [
  '',
  '【工程工具模式——像人类命题人一样闭环工作（本次任务已启用，真 Ubuntu + Python3 + sympy/numpy）】',
  '⚠️ 你【确实拥有】python_exec 工具且它真实可用——不要因为"以为自己没有工具"而跳过计算或凭感觉编造数值。',
  '【多轮循环机制】这不是一次性问答：你输出工具 JSON 后【立即停止本轮】，系统会真实执行代码并把 stdout',
  '作为新消息回传给你，你再继续——来回多轮直到验收合格。"输出工具 JSON 等结果"是被支持的。',
  '你的工作循环（严格遵守）：',
  '① 产生思路：确定考点、解法、难度定位与命题意图。',
  '② 计算验证：调用 Python 工具（只输出 {"tool":"python_exec","code":"<Python代码>"}）真实算出标准答案与关键中间量；严禁凭感觉写答案。',
  '③ 闭环调整：检查计算结果——若答案/难度/计算量不符合命题意图，调整思路再算（可多轮）；若发现之前的解法有问题，推翻重来。',
  '④ 验收合格：标准答案经工具确认无误、题面所需数值全部落实。',
  '⑤ 开始输出：围绕已验证的数值与思路，按原要求只输出最终 JSON（不再带工具标记）。',
  '若计算结果与预想不符，以计算结果为准调整题面或答案。',
].join('\n');
// 工具循环：出题/重写/审查共用。system 首条自动追加工具规约；
// 模型要工具就执行并回传，最多 maxRounds 轮；封顶后强制要求直接给最终 JSON。
async function aiToolJson(messages, opts, maxRounds) {
  if (!PY_TOOLS_ON) return aiJson(messages, opts);
  const MR = maxRounds || 8;
  const msgs = messages.map((m, i) => (i === 0 && m.role === 'system')
    ? { role: 'system', content: m.content + '\n' + TOOL_APPENDIX } : m);
  for (let round = 1; round <= MR; round++) {
    const obj = await aiJson(msgs, opts);
    if (obj && obj.tool === 'python_exec' && typeof obj.code === 'string') {
      const res = await execPython(obj.code);
      pushLog('🧮 [云端工具] 第' + round + '轮 Python ' + (res.error ? '出错' : '完成') + '：' + String(res.output || res.error || '').slice(0, 140).replace(/\n/g, ' '));
      msgs.push({ role: 'assistant', content: JSON.stringify(obj) });
      msgs.push({ role: 'user', content: '工具执行结果：\n' + (res.error ? ('[错误] ' + res.error + '\n（请修正代码再算，或换解法）') : '') + (res.output || '(无输出，请用 print)') + '\n请像命题人一样闭环推进：核对结果是否符合命题意图——不符则调整思路再算（输出 {"tool":...}）；已验收合格则按原要求输出最终 JSON。' });
      continue;
    }
    return obj;
  }
  const finalMsgs = msgs.map((m, i) => (i === 0)
    ? { role: 'system', content: String(m.content).replace(TOOL_APPENDIX, '\n【工具轮次已用完】不要再调用工具，立即按原要求输出最终 JSON。') } : m);
  return await aiJson(finalMsgs, opts);
}

// ---------- 取消信号（独立 cancel.json 承载） ----------
// 为什么不能把 canceled 写进 status.json：setStatus 每一轮都会 PATCH 覆盖 status.json，
// 前端写进去的 canceled 会被下一轮 running 覆盖冲掉 → 取消信号丢失。独立 cancel.json 不被覆盖。
let _cancelCache = null;
let _cancelCheckedAt = 0;   // 上次真实探测时刻（20s 节流）
class CancelError extends Error { constructor(m) { super(m); this.name = 'CancelError'; } }
/* 【2026-09-01 取消探测节流】出题池每取一题前后都查取消信号，且 cancel.json 在用户
 * 取消前根本不存在 → _cancelCache 永远是 null → 每次探测都是真实 GET（全量 gist，
 * 随 partial.json 增长越来越大）。35 题的卷子光取消探测就烧 ~100 次配额。
 * 节流到 20s 一次：取消延迟 ≤20s + 题边界，用户无感；配额省下一个数量级。
 * 已取消则永久缓存（取消不可逆）；阶段边界 cancelCheckpoint(force) 不受节流约束。
 * 【2026-09-03 再放宽到 30s】取消探测是无条件 GET 整个 gist（含已落盘的 partial.json 全集，
 * 越跑越大），是继 setStatus/flushPartial 之后的第三配额大户。放宽到 30s：取消响应延迟
 * ≤30s + 题边界（一题本就 30s~2min，用户点停止后最迟下一题边界生效），配额再省 1/3。 */
async function checkCancel(force) {
  if (_cancelCache && _cancelCache.canceled) return _cancelCache;
  if (!force && Date.now() - _cancelCheckedAt < 30000) return _cancelCache;
  _cancelCheckedAt = Date.now();
  try {
    const g = await ghRetry('GET', '/gists/' + GIST_ID);
    const f = g && g.files && g.files['cancel.json'];
    if (f && f.content) _cancelCache = JSON.parse(f.content);
  } catch (e) { /* 取消探测失败忽略，不拖垮主流程 */ }
  return _cancelCache;
}
// 阶段边界检查点：若已取消 → 抛 CancelError 退出主流程（由 catch 落 partial/取消处理）
async function cancelCheckpoint() {
  const c = await checkCancel(true);
  if (c && c.canceled) throw new CancelError((c.savePartial === false) ? 'user-cancel-no-save' : 'user-cancel-save');
}

// ---------- 并发池 ----------
// 固定并发版本（保留：非 AI 密集的场景仍可用，如组识别有本地 PDF 渲染瓶颈）
async function pool(items, conc, worker, onEachDone) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function runOne() {
    while (idx < items.length) {
      const ci = await checkCancel();
      if (ci && ci.canceled) break;                       // 已取消：不再取新题
      const i = idx++;
      // 【2026-09-03 竞态修复】while 检查与真正取号之间隔着 await checkCancel()——并发 worker
      // 可能同时通过检查，恢复后 idx++ 越过 items.length 拿到幽灵下标：worker 内访问
      // items[undefined] 会抛 TypeError，pool 把它记成 results[i]={__err} 多出一个「幽灵第 N+1 题」。
      // 旧版靠终检 validateQuestion 过滤掉它；但 v12 的节流时序让幽灵更易命中「本地硬校验→重写」
      // 通道——重写 mock/真实 AI 返回合法题时会把它洗成合法题混进最终卷（题量 6→7）。
      // 取号后立即边界守卫，越界直接归还（不消耗 done/不回调）。
      if (i >= items.length) break;
      try { results[i] = await worker(items[i], i); }
      catch (e) {
        if (e && e.name === 'CancelError') { results[i] = { __canceled: true }; break; }
        results[i] = { __err: (e && e.message) || String(e) }; log('worker 失败 @' + i, e.message);
      }
      done++; if (onEachDone) onEachDone(done, items.length);
      const ci2 = await checkCancel();
      if (ci2 && ci2.canceled) break;                     // 刚做完一题发现已取消：停
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, items.length)) }, runOne));
  return results;
}

// 【T7 v13 智能并发池】对齐本地「快升探测版」调度器并加 429 感知——目标：尽可能压满
// 接口吞吐、把总出题时长压到最短，同时被限流时自动收敛不烧重试配额。
//  - 每完成 2 个「快而稳」样本（平均耗时 <30s）→ 并发 +1（慢速成功=API 已饱和排队，不升）
//  - 任一失败 → 立即 -1；连续 2 失败 → 再 -1 到底（快速避险）
//  - 429 限流 → 额外降 1 + 置 10s 冷却（冷却期内不升档；aiRetry 自带退避，池只负责不再添乱）
//  - 空闲 worker 等 120ms 再看新许可（动态扩容时自动被唤醒补位）
// start=起始并发，max=上限（默认 start*5 封顶 20）；签名与 pool 完全兼容，调用点可平移。
let RATE_STRIKES = 0;   // 近期 429 计数（跨池共享：出题池撞限流，重写池开局也别太猛）
let RATE_COOLDOWN_UNTIL = 0;
function is429Err(e) {
  const m = (e && e.message) || '';
  return /HTTP 429|限流|too many|rate.?limit/i.test(m);
}
async function smartPool(items, start, worker, onEachDone, opts) {
  opts = opts || {};
  const MIN = 1, MAX = Math.max(start, opts.max != null ? opts.max : Math.min(20, start * 5));
  let cur = Math.min(start, items.length || 1), idx = 0, done = 0;
  let recent = [], sinceUp = 0, failStreak = 0;
  const _t0 = Date.now();
  function observe(ms, ok, err) {
    if (ok) {
      recent.push(ms); if (recent.length > 4) recent.shift();
      failStreak = 0; sinceUp++;
      if (cur < MAX && sinceUp >= 2 && recent.length >= 2
          && Date.now() >= RATE_COOLDOWN_UNTIL
          && recent.reduce(function (a, b) { return a + b; }, 0) / recent.length < 30000) {
        cur++; sinceUp = 0; recent = [];
        log('⚡ 并发升档 →', cur);
      }
    } else {
      failStreak++; recent = []; sinceUp = 0;
      const r429 = !!err && is429Err(err);
      const before = cur;
      if (cur > MIN) cur--;
      if (failStreak >= 2) { cur = Math.max(MIN, cur - 1); failStreak = 0; }
      if (r429) {
        RATE_STRIKES++; RATE_COOLDOWN_UNTIL = Date.now() + 10000;
        if (cur > MIN) cur--;
        pushLog('🚦 接口限流 429：并发降 ' + before + '→' + cur + '，冷却 10s（已撞限流 ' + RATE_STRIKES + ' 次）', 'warn');
      } else if (cur < before) {
        pushLog('⚠️ AI 调用失败：并发降 ' + before + '→' + cur, 'warn');
      }
    }
  }
  const results_store = new Array(items.length);
  let inFlight = 0;
  async function runOne() {
    while (idx < items.length) {
      if (inFlight >= cur) { await sleep(120); continue; }   // 活跃数达当前并发：小睡等新许可（cur 升档后自动补位）
      const ci = await checkCancel();
      if (ci && ci.canceled) break;
      const i = idx++;
      if (i >= items.length) break;                     // 同 pool 的幽灵下标守卫
      const wt = Date.now();
      inFlight++;
      try {
        results_store[i] = await worker(items[i], i);
        observe(Date.now() - wt, true, null);
      } catch (e) {
        if (e && e.name === 'CancelError') { results_store[i] = { __canceled: true }; break; }
        results_store[i] = { __err: (e && e.message) || String(e) };
        observe(Date.now() - wt, false, e);
        log('worker 失败 @' + i, e.message);
      } finally { inFlight--; }
      done++; if (onEachDone) onEachDone(done, items.length);
      const ci2 = await checkCancel();
      if (ci2 && ci2.canceled) break;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(MAX, items.length)) }, runOne));
  pushLog('⚡ 智能并发结束：峰值 ' + cur + ' 路 · 用时 ' + Math.round((Date.now() - _t0) / 1000) + 's · 完成 ' + done + '/' + items.length);
  return results_store;
}

// ---------- 提示词（与 sprint.js 本地管线同风格，独立内联） ----------
const SUBJ_NAME = { math: '数学', ctrl: '专业课', eng: '英语', pol: '政治' };

// 从蓝本派生题量（低耦合：本地/云端共用同一入口）
function bpQuestionCount(bp) { return (bp && Array.isArray(bp.types)) ? bp.types.reduce(function (a, t) { return a + (t.count || 0); }, 0) : 0; }
function bpStructureDesc(bp) {
  if (!bp || !Array.isArray(bp.types)) return '';
  return bp.types.map(function (t) { return (t.count || 0) + ' 道' + (t.label || t.type) + (t.score > 0 ? '(每 ' + t.score + ' 分)' : '(均摊)'); }).join(' + ');
}
function bpTotalScore(bp) { return Number(bp && bp.totalScore) || 150; }
function bpTimeLimit(bp) { return Number(bp && bp.timeLimit) || 180; }

// 蓝图预设（与 js/core/exam-pipeline.js 保持同步）
const DEFAULT_BP = {
  shuyi: { name: '数学一（真题卷型）', subject: 'math', totalScore: 150, timeLimit: 180, types: [{ type: 'choice', count: 10, score: 5 }, { type: 'fill', count: 6, score: 5 }, { type: 'solve', count: 6, score: 0 }], starMix: { 1: 0, 2: 15, 3: 45, 4: 30, 5: 10 } },
  ctrl: { name: '专业课（6 道综合大题）', subject: 'ctrl', totalScore: 150, timeLimit: 180, types: [{ type: 'solve', count: 6, score: 25 }], starMix: { 1: 0, 2: 0, 3: 35, 4: 45, 5: 20 } },
  yingyi: { name: '英语一（真题卷型）', subject: 'eng', totalScore: 100, timeLimit: 180, types: [{ type: 'choice', count: 20, score: 0.5 }, { type: 'choice', count: 20, score: 2 }, { type: 'solve', count: 1, score: 10 }, { type: 'essay', count: 2, score: 15 }], starMix: { 1: 0, 2: 20, 3: 50, 4: 25, 5: 5 } },
  pol: { name: '政治（真题卷型）', subject: 'pol', totalScore: 100, timeLimit: 180, types: [{ type: 'choice', count: 16, score: 1 }, { type: 'choice', count: 17, score: 2 }, { type: 'solve', count: 5, score: 10 }], starMix: { 1: 10, 2: 30, 3: 40, 4: 15, 5: 5 } },
  ying2: { name: '英语二', subject: 'eng', totalScore: 100, timeLimit: 180, types: [{ type: 'fill', count: 10, score: 1 }, { type: 'choice', count: 15, score: 2 }, { type: 'essay', count: 2, score: 15 }, { type: 'solve', count: 1, score: 0 }], starMix: { 1: 8, 2: 22, 3: 40, 4: 25, 5: 5 } }
};
const SUBJ_TO_PRESET = { math: 'shuyi', ctrl: 'ctrl', eng: 'yingyi', pol: 'pol' };

// 【2026-09-03 链路加固】从蓝图反推每道题的 score —— 不再相信出题 AI 自报 score。
// 出题 schema 里没有 score 字段，AI 会自由发挥（常全 5）；必须由 blueprint.types[].score 决定性覆盖。
// 旧版兜底 "|| 5" 是分值失真总根源（22 题 × 5 = 110 ≠ bp.totalScore 150，趋势图分母/成绩单档位全错）。
// 【2026-09-06 v16 修复·score=0 自动均摊】蓝图单题分值 0 = 剩余分自动均摊（本地 exam-pipeline.bpAutoScores
// 一直有此语义，云端从来没有）——旧 scoreForType 对 0 分行直接回 0，云端数一卷 6 道解答题全 0 分，
// 最后靠「总分对齐」把 86 分全贴给最后一题（0,0,0,0,0,86）。现按本地同款算法均摊（0.5 分刻度）。
function bpAutoScores(bp) {
  var fixed = 0, autoN = 0;
  ((bp && bp.types) || []).forEach(function (t) {
    if (t.score > 0) fixed += t.count * t.score;
    else autoN += t.count;
  });
  var rest = Math.max(0, (bpTotalScore(bp)) - fixed);
  if (!autoN) return [];
  var per = Math.floor((rest / autoN) * 2) / 2;
  var scores = [];
  for (var i = 0; i < autoN; i++) scores.push(per);
  var leftover = Math.round((rest - per * autoN) * 2) / 2;
  for (var j = autoN - 1; j >= 0 && leftover > 0; j--) { scores[j] += 0.5; leftover -= 0.5; }
  return scores;
}
// 蓝图分值队列：type → [分数...]（按蓝图行序展开；score=0 行从均摊序列依次取）。
function bpScoreQueues(bp) {
  var auto = bpAutoScores(bp), k = 0, q = {};
  ((bp && bp.types) || []).forEach(function (t) {
    var arr = q[t.type] || (q[t.type] = []);
    for (var i = 0; i < (t.count || 0); i++) arr.push(t.score > 0 ? Number(t.score) : (auto[k++] || 0));
  });
  return q;
}

// ==================== 【v16 蓝本槽位制】蓝本是卷面结构的唯一事实来源 ====================
// 旧链路：规划 AI 自由返回题型分布 → 只覆盖 score/star，题型数量错了没人管，直到终检 blueprintCheck
// 才暴露「题量不符/题型错位」，整卷返工。新链路：
//   ① bpSlots：按蓝本 types 顺序展开权威槽位（qid/type/score/star 全由槽位决定；
//      star 按 starMix 最大余数法装桶、升序排列 = 压轴在后的真题节奏，与本地 bpPerQuestionPlan 同款）；
//   ② reconcilePlanSlots：AI 规划题按「题型一致 + 顺序就近」入槽——AI 只贡献内容（考点/方向），
//      结构字段全被槽位覆盖；
//   ③ 缺槽 → 一次补规划（只补缺的题型/数量）；超产 → 弃用。AI 再怎么跑偏，卷面结构永不错位。
function bpSlots(bp) {
  var n = bpQuestionCount(bp);
  var targets = starMixTargets(bp, n);
  var starPool = [];
  for (var s = 1; s <= 5; s++) for (var k = 0; k < (targets[s] || 0); k++) starPool.push(s);
  var auto = bpAutoScores(bp), k2 = 0, qid = 0, slots = [];
  ((bp && bp.types) || []).forEach(function (t) {
    for (var i = 0; i < (t.count || 0); i++) {
      qid++;
      var poolIdx = Math.round((qid - 1) / Math.max(1, n - 1) * (starPool.length - 1));
      slots.push({
        qid: qid, type: t.type, label: t.label,
        score: t.score > 0 ? Number(t.score) : (auto[k2++] || 0),
        star: starPool[Math.min(poolIdx, starPool.length - 1)] || 3
      });
    }
  });
  return slots;
}
function reconcilePlanSlots(planQuestions, bp) {
  var slots = bpSlots(bp);
  var ai = Array.isArray(planQuestions) ? planQuestions.slice() : [];
  var used = new Array(ai.length).fill(false);
  var filled = [], missing = [];
  slots.forEach(function (slot) {
    var pick = -1;
    for (var i = 0; i < ai.length; i++) {
      if (used[i]) continue;
      if (String(ai[i].type || 'solve') === slot.type) { pick = i; break; }   // 同题型顺序就近
    }
    if (pick < 0) { missing.push(slot); return; }
    used[pick] = true;
    var q = ai[pick];
    q.type = slot.type; q.score = slot.score; q.star = slot.star; q.qid = slot.qid; q._slotLabel = slot.label;
    filled.push(q);
  });
  return { questions: filled, missing: missing, extras: ai.filter(function (q, i) { return !used[i]; }) };
}
function scoreForType(bp, qtype) {
  var types = (bp && bp.types) || [];
  var t = types.find(function (x) { return x && x.type === qtype; });
  if (!t) return 5;   // 蓝图未规定（如 essay 0 分）→ 兜底 5
  return Number(t.score) || 0;
}
// 把"每题 score 应分"转成自然语言描述注入 plannerSystem，让 AI 在规划阶段就把 score 写齐（方便审查对照）。
// 【v16】0 分行显示均摊结果（如"均摊14~14.5分"），不再让规划 AI 看到"0分/solve"自由发挥。
function scoreSpecText(bp) {
  var auto = bpAutoScores(bp), k = 0;
  var types = (bp && bp.types) || [];
  return types.map(function (t) {
    if (t.score > 0) return t.score + '分/' + (t.type || '?') + '×' + t.count + '道';
    var slice = auto.slice(k, k + (t.count || 0)); k += (t.count || 0);
    if (!slice.length) return '均摊/' + (t.type || '?') + '×' + t.count + '道';
    var mn = Math.min.apply(null, slice), mx = Math.max.apply(null, slice);
    return '均摊' + (mn === mx ? mn : mn + '~' + mx) + '分/' + (t.type || '?') + '×' + t.count + '道';
  }).join('，');
}
// 把"bp.starMix 比例"转成"目标数量"：例如 {1:0,2:15,3:45,4:30,5:10} + 22 题 → ★2×3 / ★3×10 / ★4×7 / ★5×2
// 出题完成后若分布明显偏离（±2 道以上）做一次 forceStarMix 再平衡，star 字段不再是 AI 自由发挥。
function starMixTargets(bp, n) {
  var mix = (bp && bp.starMix) || {};
  var targets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  var assigned = 0;
  [1, 2, 3, 4, 5].forEach(function (s) {
    var c = Math.round((mix[s] || 0) / 100 * n);
    targets[s] = c; assigned += c;
  });
  // 舍入误差：把差值贴到占比最大的档
  var diff = n - assigned;
  if (diff !== 0) {
    var topS = [3, 4, 2, 5, 1].sort(function (a, b) { return (mix[b] || 0) - (mix[a] || 0); })[0];
    targets[topS] = Math.max(0, targets[topS] + diff);
  }
  return targets;
}
// 根据目标分布，把当前 questions 数组按 star 重新平衡：只在分布差异 ≥2 道时才动手（避免无谓改写）。
function forceStarMix(questions, bp) {
  var n = questions.length;
  if (!n) return { changed: 0, distribution: {} };
  var targets = starMixTargets(bp, n);
  // 统计当前各 star 的题数
  var counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  questions.forEach(function (q) {
    var s = clampStar(q.star);
    counts[s] = (counts[s] || 0) + 1;
  });
  var changed = 0;
  // 多于目标的 star → 把多出来的题的 star 降到目标数最少的 star（保持题内容不变）
  [5, 4, 3, 2, 1].forEach(function (s) {
    var over = counts[s] - (targets[s] || 0);
    if (over <= 0) return;
    var deficitStars = [];
    [1, 2, 3, 4, 5].forEach(function (t) { if ((counts[t] || 0) < (targets[t] || 0)) deficitStars.push(t); });
    if (!deficitStars.length) return;
    var moved = 0;
    for (var i = 0; i < questions.length && moved < over; i++) {
      var q = questions[i];
      if (clampStar(q.star) !== s) continue;
      //  选当前缺口最大的目标 star
      var pickT = deficitStars.sort(function (a, b) { return (targets[b] - counts[b]) - (targets[a] - counts[a]); })[0];
      q.star = pickT;
      counts[s]--; counts[pickT] = (counts[pickT] || 0) + 1;
      changed++; moved++;
    }
  });
  return { changed: changed, distribution: counts, targets: targets };
}
function clampStar(v) {
  var n = Math.floor(Number(v));
  if (n >= 1 && n <= 5) return n;
  return 3;   // AI 不给或乱给 → 兜底 ★3（中档），避免渲染 ★?
}
// chiefSystem 的 targetHardPct 不再硬编码 40，按 bp.starMix 实际 ★4+★5 占比算
function targetHardPct(bp) {
  var mix = (bp && bp.starMix) || {};
  return Math.round(((mix[4] || 0) + (mix[5] || 0)));
}

// 题量档缩放（与本地 sprint.js 的 volumeBp 同规则，保证云/地两端题量口径一致）：
// lite：选择/填空减半、解答/写作保留，限时 ×0.7；full：全题型 ×1.5，限时 ×1.25。纯函数、不原地改蓝图。
function scaleBp(bp, cnt) {
  var out = JSON.parse(JSON.stringify(bp || {}));
  if (cnt === 'lite' || cnt === 'full') {
    var isLite = cnt === 'lite';
    out.types = (out.types || []).map(function (t) {
      var fac = isLite ? ((t.type === 'solve' || t.type === 'essay') ? 1 : 0.5) : 1.5;
      return Object.assign({}, t, { count: Math.max(1, Math.round((t.count || 1) * fac)) });
    });
    out.timeLimit = Math.round((out.timeLimit || 180) * (isLite ? 0.7 : 1.25));
  }
  return out;
}

// 从 prefs 解析「已生效的蓝本」：优先 prefs.blueprint（本地存的永远是 std 基准）+ count 缩放；
// 未传则回退科目预设并按 count 缩放（兼容旧任务）。题量据此真正生效，不再用 8/12/15 猜测。
function resolveBpFromPrefs(subj, prefs) {
  if (prefs && prefs.blueprint && prefs.blueprint.types && Array.isArray(prefs.blueprint.types)) {
    return scaleBp(prefs.blueprint, prefs && prefs.count);
  }
  var key = SUBJ_TO_PRESET[subj] || 'shuyi';
  var def = DEFAULT_BP[key] || DEFAULT_BP.shuyi;
  return scaleBp(def, prefs && prefs.count);
}

function plannerSystem(subj, prefs, styleNote) {
  const bp = resolveBpFromPrefs(subj, prefs);
  const diffNote = prefs.diff === 'superhard'
    ? '难度硬约束：全部为压轴难题（★4~★5），禁止基础题。'
    : prefs.diff === 'hard'
      ? '难度约束：约 70% 压轴难题（★4~★5），30% 中档（★3）。'
      : '难度约束：约 60% 中档综合题（★3），40% 压轴题（★4~★5）。';
  const n = bpQuestionCount(bp);
  const structure = bpStructureDesc(bp);
  const totalScore = bpTotalScore(bp);
  const timeLimit = bpTimeLimit(bp);
  // 【2026-09-03】把 starMix 配比 + score 分值硬约束 + avoidHint 注入 prompt——出题 AI 不再自由发挥。
  const starMixSpec = Object.keys((bp && bp.starMix) || {})
    .filter(function (s) { return (bp.starMix[s] || 0) > 0; })
    .map(function (s) { return '★' + s + ' ' + bp.starMix[s] + '%'; })
    .join('，');
  const scoreSpec = scoreSpecText(bp);
  const historyTopics = Array.isArray(prefs.historyTopics) ? prefs.historyTopics : [];
  const avoidHint = historyTopics.length
    ? '\n【避重·硬约束】以下考点与角度在最近卷已考过：' + historyTopics.slice(0, 30).map(function (t) { return String(t).slice(0, 50); }).join(' / ')
      + '——**严禁原样复刻**（可考同模块的不同考点，或换设问角度）。'
    : '';
  // 【v13 子母卷】styleNote：母卷命题形式研究报告（derive 模式）。注入后总工按母卷风格规划子卷，
  //   而非自由押题。非 derive 模式此参数为空，行为与旧版完全一致（零回归）。
  const styleBlock = styleNote
    ? '\n【子卷·仿母卷命题形式】本卷是某母卷的子卷，须严格模仿下列命题形式研究报告的'
      + '题型结构/考点分布逻辑/难度配比/设问风格出题（出新题、换数据换情境，绝不复刻母卷原题）：\n'
      + styleNote + '\n'
    : '';
  return '你是考研' + subjName(subj) + '命题总工程师。请按给定蓝本规划一份押题卷。'
    + '\n【蓝本】' + (bp.name || '押题卷') + '：' + structure + '，共 ' + n + ' 题，总分 ' + totalScore + '，限时 ' + timeLimit + ' 分钟。'
    + '\n【难度配比硬约束】' + starMixSpec + '——每题 star 严格按此分布（★1-2 基础 / ★3 中档 / ★4-5 压轴）。'
    + '\n【分值硬分配】每题 score = ' + scoreSpec + '；规划阶段把每题 score 直接写入（与蓝本严格一致）。'
    + '\n【难度】' + diffNote
    + styleBlock
    + avoidHint
    + '\n要求：①覆盖不同考点，突出今年高频与考生薄弱方向 ②题型分布严格符合蓝本结构 ③每题给出方向描述供出题 AI 执行。\n'
    + '只输出 JSON：{"title":"卷名","timeLimit":' + timeLimit + ',"questions":[{"topicName":"考点","type":"choice|fill|solve|essay","direction":"命题方向一句话","star":1-5,"score":按分值硬分配}]}';
}
// 【v13 子母卷】母卷命题形式研究员：读母卷指纹（结构 + 每题选题摘要），产出一份
//   「命题形式研究报告」文本，注入 plannerSystem 指导子卷规划。与「出题」解耦——
//   研究员只做归纳（零编造：只依据指纹里给的结构与摘要，不臆测母卷没有的东西）。
function deriveStyleSystem(subj, prefs) {
  return '你是考研' + subjName(subj) + '命题形式研究员。给你一张母卷的结构化指纹（题型分布、分值、难度★配比、'
    + '每题考点与题干摘要）。任务：归纳这张卷子的【命题形式特征】，供后续据此仿出一张同形式的子卷。'
    + '【铁律】①只做归纳，严禁编造指纹里没有的题号/考点；②聚焦"形式"而非"具体题目内容"——'
    + '要提炼出可迁移到一套全新题目的规律（如：选择题前 6 题考基础概念辨析、后 4 题考综合应用；'
    + '大题按章节轮动、每题设置多问递进；计算量分布、陷阱类型偏好等）。'
    + '只输出一段纯文本研究报告（≤500 字，分点陈述，不要 JSON、不要标题寒暄）：'
    + '1) 题型与分值结构规律 2) 考点分布逻辑（哪些模块占多少、如何轮动）3) 难度梯度与★配比规律 '
    + '4) 设问风格（直接求值/证明/辨析/应用情境的占比与套路）5) 仿制子卷时最该复刻的 3 个形式特征。';
}
function questionSystem(subj) {
  return '你是考研' + subjName(subj) + '命题专家。按给定蓝图出一道题：题目创新但解法严格在考纲内；题干严谨无歧义；选择题给 4 个选项（A. B. C. D. 开头）；答案必须正确——输出前自己把解答完整走一遍（能算的数值都算实），确保答案与解析逐步一致。\n'
    + '【解析完整性·硬要求】solution 必须"分步推导→结论→易错点"三段式完整；solve/essay 题解析 ≥60 字、choice 题 ≥25 字、fill 题 ≥20 字；禁止只写最终答案或一句话带过。\n'
    + '【字段必填】star（1-5 整数，按蓝图分配，不要自由发挥）+ diff（easy|medium|hard，按 star 派生：★1-2→easy，★3→medium，★4-5→hard）。\n'
    + '只输出 JSON：{"stem":"题干(LaTeX用$...$)","type":"choice|fill|solve|essay","options":["A. ..","B. ..","C. ..","D. .."]或省略,"answer":"正确答案","solution":"详细解析","trap":"常见陷阱一句话","diff":"easy|medium|hard","star":1-5}';
}
function chiefSystem(subj, bp) {
  // 【2026-09-03】接收 bp → targetHardPct 从硬编码 40 改为按 bp.starMix 实际 ★4+★5 占比算（数学一 40 / 专业课 65 / 政治 20 / 英语一 30 / 英语二 30）；
  // 同时要求审查时核对题分是否对齐蓝图。
  var tHP = targetHardPct(bp);
  var scoreSpec = scoreSpecText(bp);
  return '你是考研' + subjName(subj) + '押题卷总审查工程师。逐题检查：'
    + '①解析是否完整（是否分步推导+结论+易错点、是否满足 solve/essay≥60字·choice≥25字·fill≥20字的下限——看的是**完整解析**，不是片段）'
    + '②答案是否正确（工具开启时优先用 python_exec 真实验算关键步骤，不要心算）'
    + '③题干是否严谨无歧义 ④选项是否有双对/无解 ⑤难度星级 star 是否虚标（★1-2 基础 / ★3 中档 / ★4-5 压轴）'
    + '⑥【新增】题目方向 direction 是否与考点 topicName 一致 ⑦【新增】题分 score 是否与蓝图分值硬分配一致（蓝图：' + scoreSpec + '）。\n'
    + 'verdict 判定：全过关 ok；≤2 题小问题 minor；更多或整卷性问题 major。'
    + 'targetHardPct（按蓝本 ★4+★5 占比）：' + tHP + '。\n'
    + '只输出 JSON：{"verdict":"ok|minor|major","targetHardPct":' + tHP + ',"hardPct":实际hard百分比,"summary":"总评一句话","needsRewrite":[{"index":题号从1开始（必须在 1..' + (bpQuestionCount(bp)) + ' 范围内）, "reason":"问题","fixHint":"修改指引"}]}';
}

// ---------- 本地蓝本硬校验（纯代码，零幻觉防线） ----------
function validateQuestion(q) {
  if (!q || typeof q !== 'object') return '不是对象';
  if (!q.stem || typeof q.stem !== 'string' || q.stem.length < 8) return '题干缺失或过短';
  if (q.answer == null || q.answer === '') return '缺 answer';
  if (q.type === 'choice') {
    if (!Array.isArray(q.options) || q.options.length !== 4) return '选择题须 4 个选项';
    const letters = q.options.map(o => String(o).trim().charAt(0).toUpperCase());
    if (letters.join('') !== 'ABCD') return '选项前缀须 A/B/C/D（实为 ' + letters.join('') + '）';
    const ans = String(q.answer).trim().charAt(0).toUpperCase();
    if (letters.indexOf(ans) < 0) return 'answer 不在选项中';
    // 双对粗检：answer 出现在 ≥2 个选项正文里
    const ansBody = String(q.answer).trim().slice(1).trim();
    if (ansBody.length > 6 && q.options.filter(o => String(o).indexOf(ansBody) >= 0).length > 1) return '疑似多个选项含相同答案内容';
  }
  if (!q.solution || String(q.solution).length < 1) return '解析缺失';
  // 【2026-08-27 解析完整性分级】解析"一句话带过"是"每题返工"的元凶之一：AI 主观看一眼判不完整。
  // 纯代码按题型设最低词数下限，缺步骤/缺结论的残次解析在校验层就被拦住，不再全压给总工程师主观拍板。
  var solLen = String(q.solution).replace(/\s+/g, '').length;
  var minLen = q.type === 'solve' || q.type === 'essay' ? 60 : q.type === 'choice' ? 25 : 20;
  if (solLen < minLen) return '解析不完整（' + solLen + ' 字 < ' + minLen + ' 字下限，需分步推导+结论+易错点）';
  return '';
}
// LaTeX 花括号平衡粗检（防 AI 漏花括号导致渲染崩坏）
function braceBalanced(s) {
  let n = 0;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '{') n++;
    else if (ch === '}') n--;
  }
  return n === 0;
}

// ---------- 终止信号处理（2026-09-01「进度静止一小时不动」的另一半元凶） ----------
// Actions 超时（timeout-minutes）或手动取消工作流时，runner 进程收到 SIGTERM 直接被杀，
// status.json 永远停在最后一次成功回写——本地侧无限轮询一个死任务，表现为
// 「进度/日志冻结，一小时回来还是静止」。终止前尽力写一条 error 终态（带原因 +
// 可抢救题数），让本地立刻知道任务已死、该去抢救 partial.json，而不是干等。
let _sigHandled = false;
async function handleTermination(sig) {
  if (_sigHandled) return;
  _sigHandled = true;
  log('!! 收到 ' + sig + '：执行器将被终止（Actions 超时或手动取消），尽力回写终态…');
  dropPendingStatus();   // 丢弃节流攒着的待发 running，避免 8s 后迟到 PATCH 覆盖下面的 error 终态
  // 被杀的宽限期只有几秒：直写不走 ghRetry（限额长退避会白等几分钟，等来 SIGKILL）
  const payload = { files: {
    'status.json': { content: JSON.stringify({ status: 'error', stage: '', msg: '⚠ 执行器被强制终止（' + sig + '：Actions 超时或手动取消）· 已出 ' + _partialCount + ' 题已落盘 partial.json，可点「🆘 抢救已出题目」收卷', progress: null, log: RUN_LOG, qs: QS, savedCount: _partialCount, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER }) }
  } };
  for (let i = 0; i < 2; i++) {
    try { await ghReq('PATCH', '/gists/' + GIST_ID, payload); log('✅ 终态已回写'); break; }
    catch (e) { log('!! 终态回写失败（第 ' + (i + 1) + ' 次）：', e.message); await sleep(1500); }
  }
  process.exit(1);
}
process.on('SIGTERM', () => handleTermination('SIGTERM'));
process.on('SIGINT', () => handleTermination('SIGINT'));

// ---------- 主流程 ----------
// ==================== 📥 PDF 试卷导入（v10，2026-09-02 新增通道） ====================
/* 与「出卷通道」平行的第二条云端流水线：客户端把用户试卷（PDF/图片）base64 塞进
 * 任务 Gist（source.pdf.b64 或 source.pdf），云端用 Actions runner 自带的 poppler 工具链解析：
 *   pdfinfo 页数 → 逐页 pdftotext 判断文字层密度
 *   → 文字页按连续页分组喂文本模型；扫描页 pdftoppm 转 PNG 喂视觉模型
 *   → 逐题结构校验 + 跨组去重 → 每组识别完即 flushPartial 落盘（中途失败可抢救）
 *   → result.json（builtBy:'pdf-import'，结构与 mockExams 条目一致）
 * 零幻觉铁律：识别不出的题只标记（lowConfidence/noAnswer）绝不编造；
 * 客户端收卷后走「预览确认」人工修订，未经人工过目的导入不当成品用。 */
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function extOf(name) { const m = String(name || '').toLowerCase().match(/\.(\w+)$/); return m ? m[1] : ''; }

// 【v14 乱码文字层判定】有些 PDF 用无 ToUnicode 映射的子集字体（CID 编码）：本地阅读器
// 按内嵌字形直接画「看起来正常」，但 pdftotext 提取出来是「狶狶狶」碎片乱码。
// 旧防御只看字符数 ≥240，乱码页照样放行文本通道 → AI 收到噪声直接拒答（"输出中没有 JSON"）。
// 三重启发式（任一命中即乱码）：
//   ① 非常用字符占比 >0.45（CJK 扩展区/兼容区生僻字——注意 CID 乱码也常用 U+4E00 区的生僻字，
//      所以光靠①不够，见②③）
//   ② 长度 ≥3 的连续同字符覆盖 >50%（「狶狶狶狶犥犥犥」式碎片重复）
//   ③ 单一字符占比 >25%（真中文页 top 字频一般 <8%；乱码/点线页 top 字频暴增）
// 常用字符白名单：CJK 基本区 U+4E00-9FA5 + 假名 + ASCII + CJK 标点 + 全角（一律用 \u 转义写，
// 防止字面汉字区间被工具链编码破坏——曾发生「一-龥」变成「㐀-䶿」致全部正常中文误判乱码）
const COMMON_CJK_RE = /[\u4e00-\u9fa5\u3040-\u30ffA-Za-z0-9\u3000-\u303f\uff00-\uffef]/;
function garbledRatio(txt) {
  // Array.from 按码点拆分：代理对（CJK 扩展区 𠀋/𪚥 等）算 1 字符——若用 s.length（UTF-16 计数）
  // 会让这类字符的分母翻倍、rare 占比被稀释一半，导致扩展区乱码漏判。
  const arr = Array.from(String(txt || '').replace(/\s+/g, ''));
  const n = arr.length;
  if (n < 30) return 0;
  let rare = 0, topCnt = 0;
  const cnt = {};
  let runCover = 0, prev = '', run = 0;
  // run≥4 的连续同字符计入「重复覆盖」：正常中文/英文几乎不会出现 4 连同字；
  // CID 乱码（狶狶狶狶）与填空点线（＿＿＿＿）都会命中——前者是噪声该转视觉，
  // 后者视觉同样能读，转过去无害。阈值取 4 而非 3，避开「看看」「谢谢」类自然叠字。
  const flushRun = () => { if (run >= 4) runCover += run; };
  for (const ch of arr) {
    if (COMMON_CJK_RE.test(ch) === false) rare++;
    cnt[ch] = (cnt[ch] || 0) + 1;
    if (cnt[ch] > topCnt) topCnt = cnt[ch];
    if (ch === prev) run++; else { flushRun(); prev = ch; run = 1; }
  }
  flushRun();
  return Math.max(rare / n, runCover / n, topCnt / n * 0.9);
}
// 一页文字层是否「文本通道不可用」→ 转视觉。两个独立信号（任一命中即转）：
// ① garbledRatio > 0.45：CID 碎片乱码（狶狶狶式，生僻字主导+高重复）；
// ② PUA 私有区字符（\uE000-\uF8FF）占比 >3% 或绝对数 >30：字体无 ToUnicode 映射的
//    「半坏文字层」——真·实测样本（李林四套卷）中文正常但公式括号全变 \uf0ee\uf0ee，
//    pypdf 字频 rare 高达 0.80；整体 ratio 只 0.36 会漏判，但 PUA 信号 100% 特异
//    （正常 PDF 文字层零 PUA）。公式残缺对文本模型是噪声，视觉模型反而能看原型。
function puaCount(txt) {
  let n = 0;
  for (const ch of String(txt || '')) { const c = ch.codePointAt(0); if (c >= 0xE000 && c <= 0xF8FF) n++; }
  return n;
}
function pageIsGarbled(txt) {
  if (garbledRatio(txt) > 0.45) return true;
  const s = String(txt || '').replace(/\s+/g, '');
  if (s.length < 30) return false;
  const pua = puaCount(txt);
  if (pua > 30 || pua / s.length > 0.03) return true;
  // 【v17 数学乱码信号】字体无 ToUnicode 映射时，pdftotext 把公式字形输出成 🟥/□/■/U+FFFD
  // 这类替换字符——它们不是 PUA，旧检测全漏（李林四套卷实测：每页 10+ 个 🟥、积分/分式
  // 全碎成「n2+1」，但文字层"看起来"正常，被喂给文本模型提取出垃圾）。
  // 出现 ≥6 个或占比 >0.8% 即判乱码 → 转视觉整页识别。
  const boxy = (String(txt).match(/[\u{1F7E5}\u{1F7E6}\u{1F7E7}\u{1F7E8}□■▯]/gu) || []).length;
  return boxy >= 6 || boxy / s.length > 0.008;
}
function importTextSystem(subj) {
  return '你是考研' + subjName(subj) + '试卷数字化工程师。用户给你一份试卷其中几页的文字层提取（pdftotext 输出，'
    + '可能含页眉页脚、双栏错序、公式残缺、题目跨页）。任务：把每一道题完整还原成结构化 JSON。'
    + '【铁律】①只做搬运与整理，严禁增删改题意、严禁编造卷面上没有的答案或解析——卷面没给答案就输出 answer:"" 并置 noAnswer:true。'
    + '②题目跨页出现时合并为一题（sourcePages 给全部页码）。③公式保留为 LaTeX（$...$），文字层里错乱的上下标/根号按你能确定的最小修改还原；'
    + '拿不准是否还原正确就把 confidence 调低（0-1 小数），不要猜。④题号 no 用卷面原题号（数字），分卷/无题号按出现顺序编号。'
    + '⑤页眉页脚、答题卡填涂说明、注意事项等非试题文字一律丢弃。'
    + '⑥star 为难度粗评（1=送分直接套公式 … 5=压轴综合），看信息量/计算量/思维量快速判断即可，不必精确。'
    + '只输出 JSON：{"questions":[{"no":1,"stem":"题干","type":"choice|fill|solve|essay","options":["A. ..","B. ..","C. ..","D. .."],"answer":"卷面答案","solution":"卷面解析（没有则空串）","noAnswer":false,"topicName":"考点","score":数字或null,"star":1-5,"sourcePages":[1],"confidence":0.95}]}';
}
function importVisionSystem(subj) {
  return '你是考研' + subjName(subj) + '试卷数字化工程师。用户给你试卷整页的高清图片（扫描版/拍照版）。'
    + '任务：逐题识别图片中的试题，还原成结构化 JSON。'
    + '【铁律】①忠实转录：识别什么输出什么，严禁补全图片里没有的题干、答案或解析；看不清的字用 □ 占位并调低 confidence。'
    + '②卷面没印答案就 answer:"" + noAnswer:true，严禁用你的知识"顺手解出来"冒充卷面答案。'
    + '③数学公式必须用 LaTeX（$...$）准确还原（分式/根号/上下标/积分号）。④题号 no 用卷面原题号。'
    + '⑤一道题跨页时在两页都识别完整部分，sourcePages 标该页即可（合并由系统处理）。'
    + '⑥star 为难度粗评（1=送分直接套公式 … 5=压轴综合），看信息量/计算量/思维量快速判断即可，不必精确。'
    + '只输出 JSON：{"questions":[{"no":1,"stem":"题干","type":"choice|fill|solve|essay","options":["A. ..","B. ..","C. ..","D. .."],"answer":"卷面答案","solution":"卷面解析（没有则空串）","noAnswer":false,"topicName":"考点","score":数字或null,"star":1-5,"sourcePages":[1],"confidence":0.95}]}';
}
// 【v13 答案解析补全】解答器：给卷面缺答案/解析的题补「AI 参考答案」。
//   与转录通道解耦——转录铁律「严禁顺手解题」保持不变，补全是独立显式步骤（用户勾选才会跑）。
//   开思考模式（opts.think=true）提高解题正确率；输出仍走 JSON 便于机器回填。
function importFillSystem(subj) {
  return '你是考研' + subjName(subj) + '命题解析专家。用户给你一道试卷原题（卷面没有答案或解析）。'
    + '任务：把这道题完整解出来，给出参考答案与分步解析。'
    + '【铁律】①输出前先自己把解答完整走一遍，能算的数值必须算实，确保答案与解析逐步一致；'
    + '②解析按「思路→分步推导→结论」组织，solve/essay ≥60 字、choice/fill ≥25 字；'
    + '③若题目信息不全（缺条件/题干有 □ 占位导致无法唯一求解），不要硬编——'
    + 'answer 与 solution 各写「无法求解：<原因>」并在 unsure 里说明缺什么。'
    + '只输出 JSON：{"answer":"参考答案（choice 给字母）","solution":"分步解析","unsure":"无法求解的原因或不确定点，确定则空串"}';
}
// 导入题结构校验（与出卷题的 validateQuestion 不同：忠实搬运优先，残次不判死只标记）
function validateImported(q) {
  if (!q || typeof q !== 'object' || !q.stem || String(q.stem).trim().length < 6) return '题干缺失';
  const t = ['choice', 'fill', 'solve', 'essay'].indexOf(String(q.type)) >= 0 ? String(q.type) : ((Array.isArray(q.options) && q.options.length === 4) ? 'choice' : 'solve');
  if (t === 'choice' && (!Array.isArray(q.options) || q.options.length < 2)) return '选择题缺选项';
  if (t === 'choice' && Array.isArray(q.options) && q.options.length === 4 && q.answer) {
    const letters = q.options.map(o => String(o || '').trim().charAt(0).toUpperCase());
    if (letters.indexOf(String(q.answer).trim().charAt(0).toUpperCase()) < 0) return '答案不在选项中';
  }
  return '';
}
function normalizeImported(q, g) {
  let type = ['choice', 'fill', 'solve', 'essay'].indexOf(String(q.type)) >= 0 ? String(q.type) : ((Array.isArray(q.options) && q.options.length === 4) ? 'choice' : 'solve');
  let options = Array.isArray(q.options) ? q.options.filter(o => o != null && String(o).trim() !== '').map(o => String(o)) : [];
  let stem = String(q.stem || '').trim();
  let low = false;
  const conf = typeof q.confidence === 'number' ? q.confidence : null;
  if (conf != null && conf < 0.7) low = true;
  // 选择题结构不完整：把选项并入题干（忠实保留信息），降级 solve——判分管线对坏 choice 会直接报错
  if (type === 'choice' && (options.length !== 4 || !options.length)) {
    if (options.length >= 2) stem += '\n' + options.join('\n');
    options = []; type = 'solve'; low = true;
  }
  let answer = q.answer == null ? '' : String(q.answer).trim();
  const noAnswer = !!q.noAnswer || answer === '';
  if (noAnswer) low = true;
  // choice 答案不在选项内（validateImported 拦下）→ 同样标低置信，交人工裁决
  if (validateImported(q)) low = true;
  let pages = Array.isArray(q.sourcePages) && q.sourcePages.length ? q.sourcePages.map(Number).filter(n => n > 0) : (g.pages || []);
  // 【v16 导入评星】AI 粗评难度 1-5（缺失/非法回退 3）——导入卷不再全员三星
  const starRaw = Math.round(Number(q.star));
  const star = (starRaw >= 1 && starRaw <= 5) ? starRaw : 3;
  return {
    no: Number(q.no) || null,
    stem: stem, type: type, options: options.length === 4 ? options : undefined,
    answer: answer, solution: q.solution == null ? '' : String(q.solution).trim(),
    noAnswer: noAnswer, topicName: q.topicName == null ? '' : String(q.topicName).trim(),
    score: typeof q.score === 'number' && q.score > 0 ? q.score : null,
    star: star,
    sourcePages: pages, confidence: conf, lowConfidence: low,
    fromImport: true, importKind: g.kind, importNote: validateImported(q) || ''
  };
}
/* 【v20 完整性铁律】22 题的卷子只提回 17 题事故：模型对长解答卷会「抽样偷懒」。
 * schema 强制 num（原题号），规约要求题号连续覆盖——审计函数据此找缺口，缺则定向补提。 */
const BOOK_Q_COMPLETE_RULE = '【完整性铁律——最重要】必须输出本章全部题目，一题不落：'
  + '每题的 num 填原文题号（数字），输出前自查题号是否从最小号连续覆盖到最大号；'
  + '题干再长、解析再繁也不许省略或概括——宁可 solution 写简，不可丢题。原文没有的题号不许编造。';
function bookChapterSystem(subject, kind) {
  const kn = kind === '习题册' ? '习题册' : '讲义';
  return '你是考研资料数字化专家。下面是一本' + subject + kn + '中某一章的原文（文字层提取，可能有排版噪声）。'
    + '请产出本章的结构化学习内容，只输出 JSON（不要 markdown 围栏）：'
    + '{"content":["讲义要点段落1","段落2",…],"questions":[{"num":原题号数字,"stem":"题目原文(不重复题号前缀)","options":["A. ..","B. .."]或省略,"answer":"答案","solution":"解析（含步骤）","page":原文页码}]}。'
    + '要求：1) content 提炼本章真正的知识内容（定义/定理/方法/结论/例题讲解），每段≤300字，按原文顺序，公式用 $…$ LaTeX；'
    + '2) questions 提取原文中出现的例题与习题，没有题目就给空数组；3) 忠实原文，禁止编造原文没有的内容；4) 用简体中文。'
    + BOOK_Q_COMPLETE_RULE;
}

function bookChapterVisionSystem(subject, kind) {
  const kn = kind === '习题册' ? '习题册' : '讲义';
  return '你是考研资料数字化专家。下面是一本' + subject + kn + '中某一章的原文页面图片（公式密集，文字层不可靠，故走整页视觉识别）。'
    + '请产出本章的结构化学习内容，只输出 JSON（不要 markdown 围栏）：'
    + '{"content":["讲义要点段落1","段落2",…],"questions":[{"num":原题号数字,"stem":"题目原文(不重复题号前缀)","options":["A. ..","B. .."]或省略,"answer":"答案","solution":"解析（含步骤）","page":原文页码,"confidence":0.0到1.0}]}。'
    + '【双通道校对】若消息附带该页文字层：以图片理解版面/题号/公式结构，文字层仅用于校对汉字与数字；'
    + '冲突时公式一律以图片为准、汉字以文字层为准；文字层大面积乱码时忽略它。'
    + '【图形题】题干含函数图像/几何图时照常提取文字部分，confidence 酌情下调。'
    + '要求：1) content 提炼本章真正的知识内容（定义/定理/方法/结论/例题讲解），每段≤300字，按原文顺序，公式用 $…$ LaTeX；'
    + '2) questions 提取图片中出现的例题与习题，没有题目就给空数组；'
    + '3) 数学公式必须用 LaTeX（$…$）准确还原（分式/根号/上下标/积分号）；'
    + '4) 忠实原文，禁止编造原文没有的内容；5) 用简体中文；6) 忽略页眉页脚水印群号广告等噪声。'
    + BOOK_Q_COMPLETE_RULE;
}

/* 【v20 缺题审计】题号集合 → 1..max 中的缺口列表。纯函数（可单测）。
 * 无题号/题号<3 不审计（习题册节选本就跳号）；缺口>30 视为题号混乱不可信，不触发补提。 */
function auditGapNums(questions) {
  const found = {};
  (questions || []).forEach(function (q) {
    const n = parseInt(q && q.num, 10);
    if (n >= 1 && n <= 80) found[n] = 1;
  });
  const ks = Object.keys(found).map(Number);
  if (!ks.length) return [];
  const maxN = Math.max.apply(null, ks);
  if (maxN < 3) return [];
  const miss = [];
  for (let n = 1; n <= maxN; n++) if (!found[n]) miss.push(n);
  return miss.length > 30 ? [] : miss;
}

/* 【v20 定向补提规约】只找缺失题号——比首轮「全部重提」便宜且准。 */
function bookRepairSystem(chTitle, missList) {
  return '你是考研资料数字化专家。《' + chTitle + '》此前已提取过题目，但缺以下题号：' + missList.join('、') + '。'
    + '请在原文（文字或图片）中只找这些题号的题目，逐字转录。只输出 JSON：'
    + '{"questions":[{"num":题号,"stem":"题干全文(公式用$…$LaTeX)","options":["A. ..",…]或省略,"answer":"答案","solution":"解析"}]}。'
    + '原文确实没有的题号（跳号、只有答案没有题目、或属于下一套卷）就跳过，严禁编造。找不到任何缺失题就输出 {"questions":[]}。';
}

/* 【v18 两级目录·确定性解析器】「85 套卷」这类多卷合集书的正确结构 = 大类（入门/进阶/难/系列）→ 小类（每套卷一章）。
 * 书自带目录页（标题 … 页码）时，页码是作者给的权威事实——直接解析，零 AI 猜测：
 *   ① 前几页找「目录页」：≥6 行「标题 + 引导点/空格 + 页码」且页码单调不减；随后 ≥3 行的连续页并入（跨页目录）；
 *   ② 目录内「入门/进阶/难」这类层级标题（短、不含套/卷/题/数字、与下一条同页）识别为大类专业分隔，
 *      不成章，同时确定性给出每个小类的 group（省掉一次 AI 调用）；没有这类标题时才让调用方跑 AI 归类；
 *   ③ 印刷页码 → 物理页：offset = 目录后首页 − 最小印刷页（印刷页码连续编号的常见情形）；
 *   ④ 相邻条目页码差即每套卷的页范围，末章到全书最后一页。
 * 返回 {chapters:[{title,from,to,group}], headersFound, tocLastPage, entries} 或 null（无目录页 → 调用方走 AI 划分）。
 * 纯函数：不依赖任何模块作用域，可被单测直接求值调用。 */
function extractBookToc(pgTxt, pages) {
  const entryRe = /^\s*(.{2,40}?)[\s.…·⋯\-]{2,}(\d{1,3})\s*$/;
  const pageHits = [];
  const scanTo = Math.min(pages, 10);
  for (let p = 1; p <= scanTo; p++) {
    const lines = String(pgTxt[p] || '').split(/\r?\n/);
    const hits = [];
    for (const ln of lines) {
      const m = entryRe.exec(ln);
      if (!m) continue;
      const title = m[1].replace(/[.…·⋯\-]+$/, '').trim();
      const printed = parseInt(m[2], 10);
      if (!title || printed < 1 || printed > Math.max(pages, 1)) continue;
      hits.push({ title: title, printed: printed });
    }
    let mono = true;
    for (let i = 1; i < hits.length; i++) if (hits[i].printed < hits[i - 1].printed - 2) { mono = false; break; }
    pageHits.push({ page: p, hits: mono ? hits : [] });
  }
  // 目录页 = 首个 ≥6 条的页，向后并入连续 ≥3 条的页（最多 4 页目录）
  let start = -1;
  for (let i = 0; i < pageHits.length; i++) if (pageHits[i].hits.length >= 6) { start = i; break; }
  if (start < 0) return null;
  const found = [pageHits[start]];
  for (let i = start + 1; i < pageHits.length && i <= start + 4; i++) {
    if (pageHits[i].hits.length >= 3) found.push(pageHits[i]);
    else break;
  }
  // 跨页目录：按 title+printed 去重保序
  const seen = {}; const entries = []; let tocLastPage = 0;
  for (const f of found) {
    tocLastPage = f.page;
    for (const h of f.hits) {
      const k = h.title + '@' + h.printed;
      if (seen[k]) continue;
      seen[k] = 1; entries.push(h);
    }
  }
  if (entries.length < 6) return null;
  return tocEntriesToChapters(entries, tocLastPage, pages);
}

/* 【v20.1 共享】目录条目 → 章节（层级标题归组 + 印刷页→物理页校准 + 区间夹逼）。
 * 文字层解析（extractBookToc）与视觉读目录（extractBookTocVision）共用，保证两条路产出同构。纯函数。 */
function tocEntriesToChapters(entries, tocLastPage, pages) {
  const sorted = entries.slice().sort((a, b) => a.printed - b.printed);
  // ② 层级标题识别：短、无 套/卷/题/数字，且与下一条同页
  const headerSet = {};
  for (let i = 0; i < sorted.length - 1; i++) {
    const e = sorted[i], nx = sorted[i + 1];
    if (e.printed === nx.printed && e.title.length <= 8 && !/[0-9０-９一二三四五六七八九十百两套卷题篇]/.test(e.title)) headerSet[i] = e.title;
  }
  const headersFound = Object.keys(headerSet).length > 0;
  const contentStart = tocLastPage + 1;
  // 印刷页 → 物理页：默认恒偏移（印刷页码连续编号）；若最大印刷页 + 偏移超出实际页数，
  // 说明编号不连续（每套卷各自编号等）→ 退化为线性比例映射，保证末章落在最后一页。
  const minP = sorted[0].printed, maxP = sorted[sorted.length - 1].printed;
  const offset = Math.max(0, contentStart - minP);
  const useProp = (maxP + offset) > pages && maxP > minP;
  const phys = useProp
    ? function (printed) { return contentStart + Math.round((printed - minP) * (pages - contentStart) / (maxP - minP)); }
    : function (printed) { return printed + offset; };
  const chapters = [];
  let curGroup = '';
  for (let i = 0; i < sorted.length; i++) {
    if (headerSet[i] !== undefined) { curGroup = headerSet[i]; continue; }   // 分隔标题不成章
    let from = phys(sorted[i].printed);
    let to = i + 1 < sorted.length ? phys(sorted[i + 1].printed) - 1 : pages;
    if (from < contentStart) from = contentStart;
    if (from > pages) from = pages;
    if (to > pages) to = pages;
    if (to < from) to = from;
    chapters.push({ title: sorted[i].title.slice(0, 40), printed: sorted[i].printed, from: from, to: to, group: curGroup });
  }
  // 去重叠夹逼（印刷页码不连续时相邻章区间可能倒挂）
  chapters.sort((a, b) => a.from - b.from);
  for (let i = 0; i < chapters.length; i++) {
    if (i + 1 < chapters.length && chapters[i].to > chapters[i + 1].to) chapters[i].to = chapters[i + 1].to;
    if (chapters[i].to < chapters[i].from) chapters.splice(i, 1), i--;
  }
  if (chapters.length < 5) return null;
  return { chapters: chapters.slice(0, 150), headersFound: headersFound, tocLastPage: tocLastPage, entries: sorted };
}

/* 【v20.1 视觉读目录】乱码书（做题本/公式讲义）的目录页文字层同样是 🟥——文字解析拿不到条目，
 * 退回 AI 逐页摘要划分时，AI 看不清套卷边界，会把 85 套卷捏成 13 章（P3-34 这种 32 页「一套卷」）。
 * 目录页的套卷名是中文（不是公式），视觉识别准确率高 → 渲染前几页让模型抄目录。
 * 返回 {chapters, headersFound, tocLastPage, entries}（与 extractBookToc 同构）或 null。
 * 依赖注入（renderPageImgs/aiJson）保持纯逻辑可测。 */
async function extractBookTocVision(deps) {
  const { pages, renderPageImgs, aiJson } = deps;
  const frontN = Math.min(pages, 4);
  const plist = []; for (let p = 1; p <= frontN; p++) plist.push(p);
  const pngs = await renderPageImgs(plist);
  if (!pngs.length) return null;
  const r = await aiJson(
    [{ role: 'system', content: '你是目录识别专家。给你的图片是一本书的前几页（按顺序编号 1..N）。若其中有目录页（一列「标题 …… 页码」），把每一条目录项逐字抄下来，并给出目录所在的最后一页的编号；没有目录页就返回 tocFound:false。只输出 JSON：{"tocFound":true/false,"tocLastPage":目录最后一页的图片编号,"entries":[{"title":"目录条目标题原文","printed":条目右侧页码数字}]}。' },
     { role: 'user', content: [{ type: 'text', text: '这些是全书前 ' + frontN + ' 页。请找目录并抄全部条目（含页码）。' }].concat(pngs.map(u => ({ type: 'image_url', image_url: { url: u } }))) }],
    { think: false, temperature: 0.1, maxTokens: 12000 });
  if (!r || !r.tocFound || !Array.isArray(r.entries)) return null;
  const entries = r.entries
    .map(e => ({ title: String((e && e.title) || '').trim().slice(0, 40), printed: parseInt(e && e.printed, 10) }))
    .filter(e => e.title && e.printed >= 1 && e.printed <= Math.max(pages, 1));
  if (entries.length < 5) return null;
  // 目录结束页：模型报的编号（图片序=物理页）；异常值兜底为前几页的一半
  let tocLastPage = parseInt(r.tocLastPage, 10);
  if (!(tocLastPage >= 1 && tocLastPage <= frontN)) tocLastPage = Math.max(1, Math.min(frontN, 2));
  return tocEntriesToChapters(entries, tocLastPage, pages);
}

/* 【v22 R4 缩略图定界】最后一层兜底：纯扫描 + 无书签 + 无页脚锚点 + 无目录页的书
 * （实测：26合工大超越 1-25，25 页全扫描 0 书签）——旧版到 R5 直接抛「可读文字页过少」死路。
 * 方法论 R4：每 12 页一组低分辨率整页图喂 VLM，找「新套卷起始页」（每套首页顶部大字套名、题号从 1 重启）。
 * 返回 {chapters:[{title,from,to,group}]}（≥1 套）或 null。 */
async function detectSetsByGrid(deps) {
  const { pages, renderPageImgs, aiJson, budgetOk } = deps;
  const found = [];
  for (let i = 1; i <= pages; i += 12) {
    const group = []; for (let p = i; p < Math.min(i + 12, pages + 1); p++) group.push(p);
    if (budgetOk && !budgetOk('宫格定界 P' + group[0] + '-' + group[group.length - 1])) break;
    const imgs = await renderPageImgs(group, { dpi: 96, forceWhole: true });
    if (!imgs.length) continue;
    const r = await aiJson(
      [{ role: 'system', content: '你是试卷合订本结构分析引擎。给你的图片按顺序是一本书的连续页面（缩略图，只看版面结构不必读题）。'
        + '这是「多套模拟卷合订」：每套卷第一页同时满足两个特征——①顶部有大字试卷标题（如「XX模拟试卷N」「XX六套卷第N套」）；②该页从题号 (1)/1. 重新开始。'
        + '若某页题号从上页延续（如从 (15)、三、解答题 17 开始），它是续页，不是套首。'
        + '找出每一套卷的起始页。只输出 JSON：{"sets":[{"startPage":物理页码,"title":"套卷标题原文(≤40字)"}]}。'
        + '封面/目录/空白页不算套；整本就一套时输出 1 条；不确定就别列。' },
       { role: 'user', content: [{ type: 'text', text: '这些是全书第 ' + group[0] + '—' + group[group.length - 1] + ' 页（按图片顺序）。请找出新套卷的起始页。' }].concat(imgs.map(u => ({ type: 'image_url', image_url: { url: u } }))) }],
      { think: false, temperature: 0.1, maxTokens: 2000 });
    const sets = Array.isArray(r && r.sets) ? r.sets : [];
    sets.forEach(function (s) {
      const sp = parseInt(s && s.startPage, 10);
      if (sp >= group[0] && sp <= group[group.length - 1]) found.push({ page: sp, title: String((s && s.title) || '').trim().slice(0, 40) });
    });
  }
  // 【S2 边界精化】候选套首逐页高清确认（缩略图实测会把续页 (15)(16) 误判成套首）；
  //   首页 1 也强制确认（模型常因「书从中途开始」不自信而漏报第一套）。
  const cands = {};
  found.forEach(function (f) { cands[f.page] = f.title; });
  if (!cands[1]) cands[1] = '';
  const confirmed = [];
  const candPages = Object.keys(cands).map(Number).sort(function (a, b) { return a - b; });
  for (const cp of candPages) {
    if (budgetOk && !budgetOk('套首确认 P' + cp)) break;
    const one = await renderPageImgs([cp], { dpi: 200, forceWhole: true });
    if (!one.length) { confirmed.push({ page: cp, title: cands[cp] || '' }); continue; }
    const v = await aiJson(
      [{ role: 'system', content: '给你一本书的一页（高清）。判断它是否是一套试卷的第一页：①顶部有大字试卷标题；②本页从题号 (1)/1. 重新开始（若从 (15) 等延续题号开始则是续页）。'
        + '只输出 JSON：{"isStart":true/false,"title":"若 isStart 给出卷标题原文(≤40字)，否则空串"}。' },
       { role: 'user', content: [{ type: 'text', text: '请判断这一页是否新套卷首页。' }].concat(one.map(u => ({ type: 'image_url', image_url: { url: u } }))) }],
      { think: false, temperature: 0, maxTokens: 400 });
    if (v && v.isStart) confirmed.push({ page: cp, title: String(v.title || cands[cp] || '').trim().slice(0, 40) });
  }
  if (!confirmed.length) return null;
  confirmed.sort(function (a, b) { return a.page - b.page; });
  const starts = [];
  confirmed.forEach(function (f) { if (!starts.length || f.page > starts[starts.length - 1].page) starts.push(f); });
  if (starts[0].page > 1) starts.unshift({ page: 1, title: '前段（未识别到套首，按一套处理）' });
  const chapters = [];
  for (let i = 0; i < starts.length; i++) {
    let from = starts[i].page;
    let to = i + 1 < starts.length ? starts[i + 1].page - 1 : pages;
    if (to < from) to = from;
    chapters.push({ title: (starts[i].title || ('第' + (i + 1) + '部分')).slice(0, 40), from: from, to: to, group: '' });
  }
  return { chapters: chapters.slice(0, 150), headersFound: false, entries: starts, groups: [] };
}

/* 大类归类校验：AI 给的 groups 必须每个条目恰好落一组，否则全部退回「全册」单组。
 * ids 为 1-based 条目编号。纯函数。 */
function validateBookGroups(aiGroups, nEntries) {
  const out = new Array(nEntries).fill('');
  if (!Array.isArray(aiGroups) || !aiGroups.length) return out;
  const used = {};
  let ok = true;
  for (const g of aiGroups) {
    const title = String((g && g.title) || '').trim().slice(0, 12);
    const ids = Array.isArray(g && g.ids) ? g.ids : null;
    if (!title || !ids) { ok = false; break; }
    for (const idRaw of ids) {
      const id = parseInt(idRaw, 10) - 1;
      if (isNaN(id) || id < 0 || id >= nEntries || used[id]) { ok = false; break; }
      used[id] = 1; out[id] = title;
    }
    if (!ok) break;
    if (out.filter(Boolean).length > 12 * nEntries) { ok = false; break; }   // 防幻觉冗余
  }
  if (!ok || used[0] === undefined) return new Array(nEntries).fill('');
  for (let i = 0; i < nEntries; i++) if (!out[i]) return new Array(nEntries).fill('');
  return out;
}

/* 从 chapters[].group 推导书级 groups 列表（顺序=首次出现；组名空 → 「全册」）。纯函数。 */
function deriveBookGroups(chapters) {
  const groups = []; const idx = {};
  (chapters || []).forEach(function (c) {
    const title = String(c.group || '').trim() || '全册';
    if (!(title in idx)) { idx[title] = groups.length; groups.push({ title: title, count: 0, qCount: 0 }); }
    const g = groups[idx[title]];
    g.count++; g.qCount += (c.questions || []).length;
  });
  return groups;
}

/* ==================== 【v21 PDF 提取方法论·Runner 版 Skill】====================
 * 依据《PDF题目提取方法论（含Runner版Skill）》S0→S4 决策树改造 book 通道。
 * probe 三本真卷的实证结论（2026-09-07）：
 *   · 贾基八十五套卷（A3 数一 182页 / K16 数二 190页）：宽>高 = 2-up 双联页，
 *     书签 95/189 条（L1=入门/进阶/难 分组，L2=每套卷+物理起始页），文字层全乱码；
 *   · 李林四套卷做题本（16页）：非 2-up，书签 L1=卷一~卷四 起始页，L2=选择题/填空题/解答题 节噪点。
 * → 书签直拆（R1）是第一优先路线：零 VLM 成本、页码是出版方权威事实。 */

/* R1 书签 → 章节（纯函数，可单测）。raw = [[level,title,page1based],...]
 * 规则：
 *  ① 去重（title+page）；
 *  ② 节噪点剔除：「一、选择题」类小节书签不成章（李林 L2）；
 *  ③ 结构标题（封面/目录/前言/版权/后记/空白页，或 ≤8 字且无数字无套/卷 → 入门/进阶/难）→ 大类而非章；
 *  ④ 其余为章（套卷）：from=书签页，to=下一同列章起始页-1（末章到全书末页）；
 *  ⑤ 章数 ≥3 才可信（4 套卷的书合法；2 条以下多半是章节级书签混入）。 */
function normalizeBookmarks(raw, pages) {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const seen = {}; const entries = [];
  raw.forEach(function (it) {
    const level = parseInt(it && it[0], 10) || 1;
    const title = String((it && it[1]) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const page = parseInt(it && it[2], 10);
    if (!title || !(page >= 1 && page <= pages)) return;
    const k = title + '@' + page;
    if (seen[k]) return;
    seen[k] = 1; entries.push({ level: level, title: title, page: page });
  });
  const SECTION_RE = /^([一二三四五六七八九十]+|[0-9]{1,2})\s*[、.．]\s*(单项选择|多项选择|选择题|填空题|解答题|判断题|计算题|证明题|应用题|填空题部分|客观题|主观题)/;
  const META_RE = /^(封面|封底|目录|前言|出版说明|版权|后记|答案册|参考答案|附录[一二三四五六七八九十0-9]*|空白页|致读者|勘误)$/;
  const isStructural = function (t) {
    if (META_RE.test(t)) return true;
    if (/^第\s*[一二三四五六七八九十0-9０-９]+\s*[章讲节部篇]/.test(t)) return false;   // 讲义「第一章 …」是章不是组
    return t.length <= 8 && !/[0-9０-９套卷]/.test(t);   // 入门/进阶/难/冲刺 这类层级标题
  };
  const leaves = []; const groups = [];
  let curGroup = '';
  entries.sort(function (a, b) { return a.page - b.page || a.level - b.level; });
  entries.forEach(function (e) {
    if (SECTION_RE.test(e.title)) return;                       // 节噪点：直接丢
    if (isStructural(e.title)) {
      if (!META_RE.test(e.title)) { curGroup = e.title; groups.push(e.title); }  // 入门/进阶/难 → 大类
      return;                                                   // 封面/目录等元页：丢，不切组
    }
    leaves.push({ title: e.title, page: e.page, group: curGroup });
  });
  if (leaves.length < 3) return null;
  const chapters = [];
  for (let i = 0; i < leaves.length; i++) {
    let from = leaves[i].page;
    let to = i + 1 < leaves.length ? leaves[i + 1].page - 1 : pages;
    if (to < from) to = from;
    if (from > pages) continue;
    if (to > pages) to = pages;
    chapters.push({ title: leaves[i].title.slice(0, 40), from: from, to: to, group: leaves[i].group || '' });
  }
  if (chapters.length < 3) return null;
  return { chapters: chapters.slice(0, 150), headersFound: groups.length > 0, entries: leaves, groups: groups };
}

/* R2 页脚锚点（纯函数）：做题本常见「《套名》 第1页（共4页）」页脚——
 * 第 1 页出现处即新套起点，套名就在页脚里。要求文字层可读（乱码书走 R1/R4）。
 * 每页取页脚区（末 3 行）匹配；起点 ≥3 才可信。 */
function footerAnchorChapters(pgTxt, pages) {
  const re = /第\s*1\s*页\s*[（(]\s*共\s*(\d{1,2})\s*页\s*[)）]/;
  const starts = [];
  for (let p = 1; p <= pages; p++) {
    const lines = String(pgTxt[p] || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    const tail = lines.slice(-3).join(' ');
    const m = re.exec(tail);
    if (!m) continue;
    // 页脚里「第1页」之前的文字即套名（去掉水印噪声取 ≤40 字）
    // 【v24】2-up 页脚行混入左右两半的正文：只取尾部像「套卷名」的片段（…第N套/…卷N/…试卷N），
    //   正文垃圾被标点天然截断；取不到就回退「第N部分」（宁缺毋滥，脏标题比无名更伤体验）
    const pre = tail.slice(0, m.index).replace(/\s+/g, ' ').trim();
    const nm = /([0-9A-Za-z一-鿿（）()·\- ]{2,40}?(?:第\s*[0-9一二三四五六七八九十百]+\s*套|[卷套]\s*[0-9一二三四五六七八九十百]+|试卷\s*[0-9一二三四五六七八九十百]+|模拟卷\s*[0-9一二三四五六七八九十百]+))\s*$/.exec(pre);
    const name = (nm ? nm[1] : '').replace(/^[（）()\s·\-]+/, '').trim().slice(-40);
    starts.push({ page: p, title: name || ('第' + (starts.length + 1) + '部分'), total: parseInt(m[1], 10) });
  }
  if (starts.length < 3) return null;
  const chapters = [];
  for (let i = 0; i < starts.length; i++) {
    let from = starts[i].page;
    let to = i + 1 < starts.length ? starts[i + 1].page - 1 : pages;
    if (to < from) to = from;
    chapters.push({ title: starts[i].title.slice(0, 40), from: from, to: to, group: '' });
  }
  return { chapters: chapters.slice(0, 150), headersFound: false, entries: starts, groups: [] };
}

/* S4 validate_index 断言③（纯函数）：正文区每个物理页恰好归属一章。
 * 返回 {gaps:[[from,to]...未覆盖], overlaps:[[page,chA,chB]...]}——违规只报告+局部修，
 * 绝不全书重跑（铁律④：重跑粒度=套）。 */
function validateIndexCoverage(chapters, contentStart, pages) {
  const owner = {};
  (chapters || []).forEach(function (c, i) {
    for (let p = c.from; p <= c.to; p++) {
      if (p < contentStart || p > pages) continue;
      if (owner[p] === undefined) owner[p] = i;
    }
  });
  const gaps = []; let run = 0;
  for (let p = contentStart; p <= pages; p++) {
    if (owner[p] === undefined) { if (!run) run = p; }
    else if (run) { gaps.push([run, p - 1]); run = 0; }
  }
  if (run) gaps.push([run, pages]);
  return { gaps: gaps };
}

/* 2-up 裁半页参数（纯函数）：A3/K16 横版一页两联。pdftoppm -x -y -W -H 按设备像素裁。
 * 页宽 pt → 像素 = pt*dpi/72；左右各一半。 */
function halfCropArgs(pageWpt, pageHpt, dpi, half) {
  const wpx = Math.floor(pageWpt * dpi / 72);
  const hpx = Math.floor(pageHpt * dpi / 72);
  const hw = Math.floor(wpx / 2);
  const x = half === 'right' ? hw : 0;
  const w = half === 'right' ? wpx - hw : hw;
  return { x: x, y: 0, w: w, h: hpx };
}

/* 【v21 R1 / v24 换 fitz / v25 修自救触发】读 PDF 书签：临时脚本 + python3。
 * 【v25 根因】v24 脚本 fitz 缺失时静默 fall 到 pypdf，pypdf 对 LaTeX outline 返回空 [] →
 *   r.ok=true → pip 自救（装 pymupdf）永不触发 → 书签路线形同虚设（贾基靠改进后的页脚路线救回，
 *   李林无页脚 → 宫格只找到 1 套）。修复：fitz 缺失或 pypdf 返回空都 exit 43 触发自救装 pymupdf 重试。
 * 返回 [[level,title,page1based],...] 或 null（调用方落 R2/R3/R4 路线）。 */
async function readPdfBookmarks(pdfPath) {
  const py = [
    'import sys, json',
    'def read_fitz():',
    '    import fitz',
    '    d = fitz.open(sys.argv[1])',
    '    return [[int(t[0]), str(t[1])[:60], int(t[2])] for t in d.get_toc()]',
    'def read_pypdf():',
    '    from pypdf import PdfReader',
    '    r = PdfReader(sys.argv[1]); out = []',
    '    def walk(items, lv):',
    '        for it in items:',
    '            if isinstance(it, list):',
    '                walk(it, lv + 1)',
    '            else:',
    '                try:',
    '                    pg = r.get_destination_page_number(it) + 1',
    '                except Exception:',
    '                    pg = 0',
    '                out.append([lv, str(it.title or "")[:60], pg])',
    '    try:',
    '        walk(r.outline, 1)',
    '    except Exception:',
    '        pass',
    '    return out',
    '# 1) fitz 优先（对 LaTeX 生成的 outline 可靠）。缺库 → exit 43 触发 pip 装 pymupdf。',
    'try:',
    '    print(json.dumps(read_fitz(), ensure_ascii=False)); sys.exit(0)',
    'except ImportError:',
    '    sys.exit(43)',
    'except Exception as e:',
    '    print("FITZERR:" + str(e), file=sys.stderr)',
    '# 2) pypdf 兜底：非空才可信；空 → exit 43（多半是 fitz 缺失的降级，装 pymupdf 重试更值）',
    'try:',
    '    res = read_pypdf()',
    '    if res:',
    '        print(json.dumps(res, ensure_ascii=False)); sys.exit(0)',
    '    sys.exit(43)',
    'except Exception:',
    '    sys.exit(43)',
  ].join('\n');
  const f = pathT.join(osT.tmpdir(), 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.py');
  try { fsT.writeFileSync(f, py, 'utf8'); } catch (e) { return null; }
  let r = await runShell('python3 ' + JSON.stringify(f) + ' ' + JSON.stringify(pdfPath), 30000, 8 * 1024 * 1024);
  // exit 42/43 或模块缺失 → pip 自救装 pymupdf（pypdf 兜底），再跑一次
  if ((!r.ok && /4[23]|ModuleNotFoundError|No module named/.test(String(r.err) + String(r.out))) || (r.ok && String(r.out).trim().endsWith('[]'))) {
    pushLog('🐍 书签读取需 pymupdf（fitz 缺失或 pypdf 返空），pip 自救…');
    // Ubuntu 24.04 runner 是 externally-managed（PEP 668）：普通 pip install 会被拒。
    // 依次尝试 --break-system-packages（系统级）→ --user（用户级），任一成功即可。
    for (const pkg of ['pymupdf', 'pypdf']) {
      const pip1 = await runShell('python3 -m pip install --quiet --disable-pip-version-check --break-system-packages ' + pkg, 180000);
      if (!pip1.ok) await runShell('python3 -m pip install --quiet --disable-pip-version-check --user ' + pkg, 180000);
    }
    r = await runShell('python3 ' + JSON.stringify(f) + ' ' + JSON.stringify(pdfPath), 30000, 8 * 1024 * 1024);
    if (!r.ok) pushLog('⚠️ 书签读取仍失败（pip 自救未成功），本本将退回页脚/目录/宫格路线', 'warn');
  }
  try { fsT.unlinkSync(f); } catch (e) {}
  if (!r.ok) return null;
  try {
    const j = JSON.parse(String(r.out).trim().split('\n').pop());
    return Array.isArray(j) ? j : null;
  } catch (e) { return null; }
}

async function runImport(gist, job, prefs) {
  const subj = prefs.subject && prefs.subject !== 'auto' ? prefs.subject : (prefs.importSubject || 'math');
  // ---------- ① 拉源文件 ----------
  await setStatus('running', 'parsing', '📥 拉取试卷源文件…', 2);
  // 【v11 资源 Gist 拆文件】优先从独立资源 Gist 读源文件（任务 Gist 永远只几 KB，
  // 不再与几 MB 的 PDF 同 Gist 触发 GitHub API 截断边界）。回退到任务 Gist 内源文件（兼容老路径）。
  const gFiles = gist.files || {};
  let buf = null;
  let sourceOrigin = '';
  try {
    if (SOURCE_GIST_ID) {
      const assetGist = await ghRetry('GET', '/gists/' + SOURCE_GIST_ID);
      const aFiles = (assetGist && assetGist.files) || {};
      buf = await readSourceBuffer(aFiles, '资源 Gist');
      sourceOrigin = 'resource gist ' + SOURCE_GIST_ID;
      pushLog('📂 源文件来自资源 Gist（' + Math.round(buf.length / 1024) + 'KB，gist=' + SOURCE_GIST_ID.slice(0, 8) + '…）');
    }
  } catch (e) { pushLog('⚠️ 资源 Gist 读取失败，回退任务 Gist：' + String(e.message || e).slice(0, 120), 'warn'); }
  if (!buf) {
    try {
      buf = await readSourceBuffer(gFiles, '任务 Gist');
      sourceOrigin = 'task gist';
    } catch (e) { throw new Error('源文件读取失败：' + ((e && e.message) || e)); }
  }
  if (!buf || buf.length < 100) throw new Error('源文件读取为空（来源：' + sourceOrigin + '）——请确认提交时已上传试卷文件，或删除任务重试');
  const isImg = prefs.importKind === 'image';
  pushLog('📄 源文件 ' + Math.round(buf.length / 1024) + ' KB · 类型 ' + (isImg ? '图片' : 'PDF') + ' · ' + (prefs.fileName || '(未命名)') + ' · 来源 ' + sourceOrigin);
  // 【2026-09-05 v13 修复：非标准 PDF 头】部分扫描件/下载器产物在 %PDF 魔数前混入 BOM 或
  // 垃圾字节（如 \r\n、HTML 残片），旧版要求 %PDF 严格在 offset 0 → 整单报「不是合法 PDF」。
  // 现在在前 4KB 内搜索魔数，找到即裁掉头部杂质继续解析；找不到才判非 PDF。
  if (!isImg) {
    const isMagic = (o) => buf[o] === 0x25 && buf[o + 1] === 0x50 && buf[o + 2] === 0x44 && buf[o + 3] === 0x46;
    if (!isMagic(0)) {
      let found = -1;
      const scanMax = Math.min(buf.length - 4, 4096);
      for (let i = 1; i <= scanMax; i++) { if (isMagic(i)) { found = i; break; } }
      if (found > 0) {
        pushLog('🔧 非标准 PDF 头：%PDF 位于偏移 ' + found + '（前有 ' + found + ' 字节杂质/BOM），自动裁头后继续解析');
        buf = buf.subarray(found);
      } else {
        throw new Error('源文件不是合法 PDF（前 4KB 内未找到 %PDF 头）——若是图片请改用图片导入；'
          + '若文件确实是 PDF 且是 v13 前提交的任务，属旧版上传通道把字节写坏（latin1 损坏），请删除该任务后用最新页面重新提交');
      }
    }
  }
  const wd = pathT.join(osT.tmpdir(), 'cjimp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  fsT.mkdirSync(wd, { recursive: true });
  try {
    // ---------- ② 分组（文字组 / 视觉组） ----------
    const groups = [];
    if (isImg) {
      const mime = IMG_MIME[extOf(prefs.fileName)] || 'image/png';
      if (buf.length > 2.6 * 1024 * 1024) throw new Error('图片过大（' + Math.round(buf.length / 1048576) + ' MB > 2.6 MB 接口上限），请在手机端压缩后重试');
      groups.push({ kind: 'img', imgs: ['data:' + mime + ';base64,' + buf.toString('base64')], pages: [1] });
    } else {
      const pdfPath = pathT.join(wd, 'src.pdf');
      fsT.writeFileSync(pdfPath, buf);
      await ensurePoppler();   // 【v11】poppler 可能没预装 → 探测 + 缺失时自动 apt 安装
      const vi = await runShell('pdfinfo ' + JSON.stringify(pdfPath), 30000);
      if (!vi.ok) {
        // 错误信息纠偏：工具缺失 ≠ 文件损坏。旧版把 not found 也报成「文件损坏/加密」，
        // 用户会一直去换 PDF，而真正要做的是升级 workflow（或等 runner 自救失败后的明确指引）。
        if (/not found|No such file|command not found/i.test(String(vi.err))) {
          throw new Error('执行器环境缺少 poppler-utils（pdfinfo/pdftotext/pdftoppm 都不可用，自动安装也失败）——请到「🛠 配置向导」点一次「🚀 一键安装」升级 workflow（新版 workflow 自带安装步骤）');
        }
        throw new Error('PDF 解析失败（文件损坏或加密受保护）：' + String(vi.err).slice(0, 200));
      }
      const pm = vi.out.match(/^Pages:\s+(\d+)/m);
      const pages = pm ? parseInt(pm[1], 10) : 0;
      if (!pages) throw new Error('PDF 页数为 0');
      if (pages > (prefs.mode === 'book' ? 300 : 40)) throw new Error('共 ' + pages + ' 页，超过单次导入上限 ' + (prefs.mode === 'book' ? 300 : 40) + ' 页（' + (prefs.mode === 'book' ? '建议按章拆分后分批导入' : '建议拆分后分批导入') + '）');
      pushLog('🧾 pdfinfo：' + pages + ' 页，逐页提取文字层…');
      const pgTxt = {};
      for (let p = 1; p <= pages; p++) {
        await checkCancel();   // 每页边界：拉取用户取消信号
        const r = await runShell('pdftotext -f ' + p + ' -l ' + p + ' -layout ' + JSON.stringify(pdfPath) + ' -', 30000);
        pgTxt[p] = r.ok ? r.out : '';
        if (p === 1 || p === pages || p % 5 === 0) await setStatus('running', 'parsing', '🧾 逐页提取文字层 ' + p + '/' + pages + '…', 2 + Math.round(p / pages * 10));
      }
      // 文字密度阈值：pdftotext 压掉空白后 <240 字符判为「扫描页/公式页」，转图走视觉
      // 【v14 乱码防御】字符数够但乱码率高的页（CID 无 ToUnicode 字体）同样转视觉——
      //   否则喂文本模型只会得到「AI 已拒绝输出 JSON」。
      const TEXT_MIN = 240;
      let tGroup = [];
      const flushT = () => {
        if (!tGroup.length) return;
        const gp = tGroup.map(g => g.p);
        groups.push({
          kind: 'text', text: tGroup.map(g => g.txt).join('\n\n'), pages: gp,
          // 【v14 第二层防御】文本通道被 AI 拒答时的视觉重试闭包（renderPageImgs 声明提升，调用时才用）
          visionRetry: async function () {
            const out = [];
            for (let i = 0; i < gp.length; i += 2) {
              const chunk = gp.slice(i, i + 2);
              const pngs = await renderPageImgs(chunk);
              if (pngs.length) out.push({ imgs: pngs, pages: chunk });
            }
            return out;
          }
        });
        tGroup = [];
      };
      const imgPages = [];
      let garbledN = 0;
      for (let p = 1; p <= pages; p++) {
        const flat = String(pgTxt[p] || '').replace(/\s+/g, '').trim();
        const garbled = flat.length >= TEXT_MIN && pageIsGarbled(pgTxt[p]);
        if (garbled) garbledN++;
        if (flat.length >= TEXT_MIN && !garbled) tGroup.push({ p: p, txt: pgTxt[p] });
        else { flushT(); imgPages.push(p); }
      }
      flushT();
      if (garbledN) pushLog('⚠️ 检测到 ' + garbledN + ' 页文字层为乱码（PDF 用无 ToUnicode 的子集字体），已转视觉识别');
      if (imgPages.length) pushLog('👁 转视觉的页：' + imgPages.join(',') + '（文字层不足 ' + TEXT_MIN + ' 字符或乱码，转 150dpi 图片）');
      // 【v14】单页渲染 helper：分组转图与「文本组被拒后转视觉重试」共用（150dpi 与 2.6MB 上限口径一致）
      // 【v21 2-up】RENDER_2UP 置位时（book 分支探测到横版双联页），每物理页渲染成左/右两个半页图，
      //   dpi 提到 200（半页宽度减半，方法论要求 scale≥2.0 公式才认得清）。
      let RENDER_2UP = null;   // {pageW, pageH} pt（由 book 分支置位）
      async function renderPageImgs(pList, opts) {
        const out = [];
        const two = !opts && !!(RENDER_2UP && RENDER_2UP.pageW > RENDER_2UP.pageH * 1.1);   // opts.forceWhole 时不裁半（宫格定界看整页版面）
        const DPI = (opts && opts.dpi) || (two ? 200 : 150);
        for (const p of pList) {
          if (two) {
            for (const half of ['l', 'r']) {
              const cr = halfCropArgs(RENDER_2UP.pageW, RENDER_2UP.pageH, DPI, half === 'l' ? 'left' : 'right');
              const hb = pathT.join(wd, 'pg' + p + half);
              const cmd = 'pdftoppm -f ' + p + ' -l ' + p + ' -png -r ' + DPI +
                ' -x ' + cr.x + ' -y ' + cr.y + ' -W ' + cr.w + ' -H ' + cr.h + ' ' +
                JSON.stringify(pdfPath) + ' ' + JSON.stringify(hb);
              const r2 = await runShell(cmd, 90000);
              if (!r2.ok) { pushLog('⚠️ 第 ' + p + ' 页' + (half === 'l' ? '左' : '右') + '半页渲染失败：' + String(r2.err).slice(0, 100), 'warn'); continue; }
              for (const f of fsT.readdirSync(wd).filter(x => x.indexOf('pg' + p + half + '-') === 0 && /\.png$/.test(x))) {
                const data = fsT.readFileSync(pathT.join(wd, f));
                if (data.length > 2.6 * 1024 * 1024) { pushLog('⚠️ 第 ' + p + half + ' 图过大，跳过', 'warn'); continue; }
                out.push('data:image/png;base64,' + data.toString('base64'));
              }
            }
            continue;
          }
          const base = pathT.join(wd, 'pg' + p);
          const r = await runShell('pdftoppm -f ' + p + ' -l ' + p + ' -png -r ' + DPI + ' ' + JSON.stringify(pdfPath) + ' ' + JSON.stringify(base), 90000);
          if (!r.ok) { pushLog('⚠️ 第 ' + p + ' 页转图失败：' + String(r.err).slice(0, 120), 'warn'); continue; }
          // 【v19 致命修复】前缀必须带 '-'：旧版 indexOf('pg'+p)===0 让第 1 页同时命中
          // pg10~pg16（2 页组实际塞 8 张图 → payload 暴涨/网关拒收）。pg{p}- 才是精确匹配。
          for (const f of fsT.readdirSync(wd).filter(x => x.indexOf('pg' + p + '-') === 0 && /\.png$/.test(x))) {
            const data = fsT.readFileSync(pathT.join(wd, f));
            if (data.length > 2.6 * 1024 * 1024) { pushLog('⚠️ 第 ' + p + ' 页图 ' + Math.round(data.length / 1048576) + 'MB 过大，跳过', 'warn'); continue; }
            out.push('data:image/png;base64,' + data.toString('base64'));
          }
        }
        return out;
      }
      // 【v19】book 模式跳过这次预渲染：groups 对 book 无用（分章提取自己按页转图），
      //   旧版白烧 16 次 pdftoppm 还留下满目录 pg*.png 诱发前缀误匹配 bug。
      if (prefs.mode !== 'book') {
        for (let i = 0; i < imgPages.length; i += 2) {
          const chunk = imgPages.slice(i, i + 2);
          const pngs = await renderPageImgs(chunk);
          if (pngs.length) groups.push({ kind: 'img', imgs: pngs, pages: chunk });
        }
      }

      /* 【2026-09-06 资料库·book 分支】讲义/习题册整本导入：
       * 与试卷拆题共用逐页文字提取与乱码判定，分支差异在 AI 目标——
       *   ① AI 目录划分（整本 → 章节页码范围，2-30 章）
       *   ② 分章提取（并发 2）：讲义要点段落 + 例题/习题（题干/答案/解析）
       *   ③ book.json（结构 = studyBook 记录）→ 前端资料库阅读
       * 【v17 视觉通道】公式密集型 PDF（做题本/讲义）文字层被 pdftotext 压碎（🟥/分式碎裂），
       *   这类页已判乱码转视觉——分章提取按章决策：视觉页过半 → 整章走 2 页/次视觉识别合并；
       *   否则走文字层。旧 v1「仅处理文字层页、乱码页跳过」对数学资料等于丢内容。 */
      if (prefs.mode === 'book') {
        // 【v17 致命修复】subject 此前未定义（runImport 开头是 subj）——book 分支一进
        // 分章提取就 ReferenceError，整条链路从未真正跑通过。中文科目名供提示词用。
        const subject = SUBJ_NAME[subj] || subj;
        const imgSet = {}; imgPages.forEach(p => { imgSet[p] = 1; });
        // 【v21 预算硬顶】铁律⑤：视觉调用 ≤ 页数×1.2+20（声明提前：宫格定界/预检/提取/补提共用闸门）
        let BOOK_VLM = 0;
        const BOOK_BUDGET = Math.floor(pages * 1.2 + 20);
        function budgetOk(tag) {
          if (BOOK_VLM >= BOOK_BUDGET) { pushLog('⛔ 视觉调用预算到顶（' + BOOK_BUDGET + '），跳过：' + tag, 'warn'); return false; }
          BOOK_VLM++; return true;
        }
        if (garbledN) pushLog('⚠️ ' + garbledN + ' 页文字层乱码（公式字体无 ToUnicode），对应章节将走整页视觉识别');
        await setStatus('running', 'parsing', '🗂 解析目录结构…', 15);
        // 【v21 PDF 提取方法论·Runner Skill】结构来源决策树（S0→S5，禁止跳步）：
        //   S0 probe：pdfinfo 页尺寸 → 2-up 判定（宽>高=横版双联页，如 A3 合订卷）；
        //   R1 书签直拆：PDF 内嵌书签粒度≈套数 → 零 VLM 成本（三本真卷实测全命中）；
        //   R2 页脚锚点：「第1页（共N页）」页脚 = 新套起点（文字层可读的做题本）；
        //   R3 文字层目录页解析 → R4 视觉读目录 → R5 AI 逐页摘要划分（兜底）。
        let chapters = null, structSrc = '';
        const psz = String(vi.out || '').match(/Page size:\s+([\d.]+)\s*x\s*([\d.]+)/i);
        const pageW = psz ? parseFloat(psz[1]) : 0, pageH = psz ? parseFloat(psz[2]) : 0;
        const is2up = pageW > pageH * 1.1;
        if (is2up) {
          RENDER_2UP = { pageW: pageW, pageH: pageH };
          pushLog('📐 S0 probe：' + pageW + '×' + pageH + 'pt 横版 = 2-up 双联页 → 每页裁左右半页识别（dpi 200）');
        }
        // R1 书签
        const bm = await readPdfBookmarks(pdfPath);
        if (bm && bm.length) {
          const bmc = normalizeBookmarks(bm, pages);
          if (bmc) {
            chapters = bmc.chapters;
            structSrc = '🔖 书签直拆（' + bm.length + ' 条书签，零目录识别成本）';
            pushLog('🔖 R1 书签直拆：' + chapters.length + ' 个小类' + (bmc.headersFound ? ' · 大类 ' + bmc.groups.join('/') : '') + '（页码=书签权威值）');
          } else {
            pushLog('🔖 书签 ' + bm.length + ' 条但粒度不像套卷（章数<3），落后续路线');
          }
        }
        // R2 页脚锚点
        if (!chapters) {
          const fa = footerAnchorChapters(pgTxt, pages);
          if (fa) {
            chapters = fa.chapters;
            structSrc = '🦶 页脚锚点（第1页·共N页）';
            pushLog('🦶 R2 页脚锚点：' + chapters.length + ' 套（每套起点由页脚计数器确定）');
          }
        }
        // R3/R4 目录页（文字 → 视觉）
        if (!chapters) {
          let toc = extractBookToc(pgTxt, pages);
          if (!toc && (prefs.bookKind === '习题册' || imgPages.length * 2 >= pages)) {
            try {
              pushLog('📷 R4 目录页文字层不可用，转视觉读目录…');
              toc = await extractBookTocVision({ pages: pages, renderPageImgs: renderPageImgs, aiJson: aiJson });
              if (toc) { toc.viaVision = true; pushLog('📷 视觉目录读取成功：' + toc.entries.length + ' 条'); }
            } catch (e) { pushLog('⚠️ 视觉读目录失败（' + String((e && e.message) || e).slice(0, 100) + '），退回 AI 划分', 'warn'); toc = null; }
          }
          if (toc && toc.chapters.length) {
            chapters = toc.chapters;
            structSrc = (toc.viaVision ? '📷 视觉读目录' : '📑 目录页') + '（第 1-' + toc.tocLastPage + ' 页，' + toc.entries.length + ' 条）';
            pushLog('📑 R3 目录页：' + toc.entries.length + ' 个条目 → ' + chapters.length + ' 个小类（章），页码按目录精确切分' + (toc.headersFound ? '（含层级标题，大类已确定性归组）' : ''));
            // 大类归类：目录自带层级标题时解析阶段已分组；否则一次轻量 AI 调用（失败→全册，结构仍可用）
            if (!toc.headersFound) try {
              const gc = await aiJson(
                [{ role: 'system', content: '我会给出资料目录里的条目列表（编号. 标题）。请按内容把它们归入「大类」——通常是难度层级（如 入门/基础/进阶/强化/冲刺/难）或系列名（如 张宇八套卷/李林四套卷）；若条目本就是同一层级的一组试卷，可整体归为 1 个大类（组名概括书的内容，如 "模拟卷"）。只输出 JSON：{"groups":[{"title":"大类名(≤12字)","ids":[条目编号]}]}。要求：每个编号恰好属于一组、不重不漏；≤12 个大类。' },
                 { role: 'user', content: '【条目】\n' + toc.entries.map((e, i) => (i + 1) + '. ' + e.title).join('\n').slice(0, 12000) + '\n\n请归类。' }],
                { think: false, temperature: 0.2, maxTokens: 4000 });
              const groupNames = validateBookGroups(gc && gc.groups, chapters.length);
              if (groupNames.some(Boolean)) {
                chapters.forEach((c, i) => { c.group = groupNames[i]; });
                pushLog('🏷 大类归类：' + deriveBookGroups(chapters).map(g => g.title + '(' + g.count + ')').join(' · '));
              }
            } catch (e) { pushLog('⚠️ 大类归类失败（' + String(e.message || e).slice(0, 80) + '），全部归入「全册」', 'warn'); }
          }
        }
        // R4b 宫格定界（v22 纯扫描兜底）：书签/页脚/目录全空但整本以扫描页为主时，
        //   每 12 页一组低分辨率整页图让 VLM 找「新套卷起始页」（方法论 R4）。
        if (!chapters && imgPages.length * 2 >= pages) {
          try {
            pushLog('🧩 书签/页脚/目录均无结构 → 缩略图宫格定界（纯扫描兜底）…');
            const g = await detectSetsByGrid({ pages: pages, renderPageImgs: renderPageImgs, aiJson: aiJson, budgetOk: budgetOk });
            if (g && g.chapters.length) {
              chapters = g.chapters;
              structSrc = '🧩 宫格定界（VLM 找套首页）';
              pushLog('🧩 宫格定界：' + chapters.length + ' 套（起始页 ' + chapters.slice(0, 12).map(c => c.from).join('、') + (chapters.length > 12 ? '…' : '') + '）');
            }
          } catch (e) { pushLog('⚠️ 宫格定界失败（' + String((e && e.message) || e).slice(0, 100) + '）', 'warn'); }
        }
        // R5 AI 逐页摘要划分（最后兜底）
        if (!chapters) {
          structSrc = 'AI 划分';
          const digest = [];
          for (let p = 1; p <= pages; p++) {
            const t = String(pgTxt[p] || '').replace(/\s+/g, ' ').trim();
            if (t.length >= 40) digest.push('P' + p + ': ' + t.slice(0, 110));
          }
          if (digest.length < 3) throw new Error('无法建立结构：书签/页脚/目录/宫格定界四条路都没拿到结构，且可读文字页过少（' + digest.length + ' 页）——若是纯扫描版合订书，请确认已安装 v22+ 执行器（宫格定界）后重发；仍失败可按套拍照分批导入');
          const outline = await aiJson(
            [{ role: 'system', content: '你是教材结构分析专家。根据一份资料的逐页摘要（P页码: 内容首行）划分章节结构。只输出 JSON：{"chapters":[{"title":"章节名(≤40字)","from":起始页,"to":结束页,"group":"所属大类(≤12字，没有则留空)"}]}。要求：2-150 个章节；页码范围连续、不重叠、覆盖全部有内容的页。粒度=书的一级目录（章/讲），不要拆到小节。【特例】若这份资料是「多套试卷/习题的合集」（每套 2-6 页、标题形如 XX五套卷第N套 / 模拟卷N），则每一套卷单独成章（title 用套卷全名，如 "2024余炳森五套卷第3套"），并按难度层级或系列给出 group（如 入门/进阶/难；同书同层级时 group 可留空）。' },
             { role: 'user', content: '【逐页摘要】（共 ' + pages + ' 页）\n' + digest.join('\n') + '\n\n请划分章节。' }],
            { think: false, temperature: 0.2, maxTokens: JOB_MAXTOK });
          chapters = (Array.isArray(outline.chapters) ? outline.chapters : [])
            .map(c => ({ title: String((c && c.title) || '未命名章节').slice(0, 40), from: Math.max(1, Number(c && c.from) || 1), to: Math.min(pages, Number(c && c.to) || 1), group: String((c && c.group) || '').trim().slice(0, 12) }))
            .filter(c => c.to >= c.from).slice(0, 150);
          if (!chapters.length) throw new Error('AI 未划分出有效章节');
        }
        pushLog('🗂 章节划分（' + structSrc + '）：' + chapters.length + ' 章 · ' + (chapters.some(c => c.group) ? chapters.length + ' 个小类 / ' + deriveBookGroups(chapters).length + ' 个大类' : '单层级'));

        // 【v19 视觉能力预检】李林做题本事故根因：乱码书全部走视觉，而文本模型挂在宽容网关后时
        // 会「静默丢图」——模型没收到任何图片却照常回 {"content":[],"questions":[]}，
        // 旧版把空结果当正常跳过（无日志），最终只剩一句「模型未产出有效内容」，用户无从下手。
        // 现在开跑前用首页做一次 3 行小测：读不出图上文字 = 模型不支持视觉，立即中止并给出换模型指引。
        // 【v23】2-up 书即使乱码页少也全走视觉 → 预检条件同口径
        const visHeavy = pages > 0 && (imgPages.length * 2 >= pages || !!(RENDER_2UP && RENDER_2UP.pageW > RENDER_2UP.pageH * 1.1));
        if (visHeavy) {
          await setStatus('running', 'parsing', '👁 视觉能力预检…', 16);
          try {
            const probePages = imgPages.slice(0, 2);   // 首页可能是纯封面：带第 2 页，任一页读出文字即通过
            const t1 = await renderPageImgs(probePages);
            if (!t1.length) throw new Error('首页转图失败（pdftoppm 无产出）');
            const probe = await aiJson(
              [{ role: 'system', content: '你是视觉能力探针。给你资料页面图片，只输出 JSON：{"lines":["图中能读到的前 3 行文字原文"]}' },
               { role: 'user', content: [{ type: 'text', text: '请逐字读出第一张图片最靠上的 3 行文字（若全是公式或无文字，读第二张图的标题行；都没有则返回空数组）。' }].concat(t1.map(u => ({ type: 'image_url', image_url: { url: u } }))) }],
              { think: false, temperature: 0, maxTokens: 600 });
            const got = Array.isArray(probe && probe.lines) ? probe.lines.filter(l => String(l).trim().length >= 2) : [];
            if (!got.length) throw new Error('模型对图片返回空内容（典型症状：网关丢弃了图片段 / 模型不支持图片输入）');
            pushLog('👁 视觉预检通过：模型能读图（示例识别：「' + String(got[0]).slice(0, 24) + '」）');
          } catch (e) {
            throw new Error('视觉预检失败——这本书 ' + imgPages.length + '/' + pages + ' 页文字层不可用，整本必须靠视觉模型提取。'
              + '当前模型读不了图（' + String((e && e.message) || e).slice(0, 140) + '）。'
              + '出路：到 设置→AI 把模型换成支持图片输入的视觉模型（如 GLM-4V-Plus / Qwen-VL-Max / GPT-4o / gemini-2.5-flash），保存后回到 ☁️ 云端任务点「♻️ 重发」。');
          }
        }

        // ② 分章提取（并发 3）：要点段落 + 题目，每章独立落盘；【v20】题号审计 + 缺题定向补提
        // 预算闸门 BOOK_VLM/budgetOk 已在 book 分支开头声明（宫格定界/预检/提取/补提共用）
        const out = [];
        let done = 0, emptyN = 0, repairedN = 0;
        const poolRes = await pool(chapters, 3, async (ch, ci) => {
          await cancelCheckpoint();
          const ps = []; for (let p = ch.from; p <= ch.to; p++) ps.push(p);
          const visN = ps.filter(p => imgSet[p]).length;
          // 【v23】2-up 书强制视觉：pdftotext -layout 把左右两半逐行交织，文字通道喂给模型
          //   等于乱序阅读（题号/公式串行）；半页裁切图是唯一可靠读法。
          const is2upBook = !!(RENDER_2UP && RENDER_2UP.pageW > RENDER_2UP.pageH * 1.1);
          const wasVision = visN * 2 >= ps.length || is2upBook;
          let res = { content: [], questions: [] };
          if (wasVision) {
            // 视觉为主（公式页/扫描页占比过半）：整章转图识别，合并各次产出。
            // 【v21 窗口策略】方法论：单次 ≤2 逻辑页最优、≤4 硬顶；跨页题靠窗口重叠兜住。
            //   · 2-up：1 物理页 = 2 半页（逻辑页），窗口 2 物理页 = 4 逻辑页（顶格），步进 1；
            //   · 非 2-up：窗口 2 页步进 1（相邻窗口共享 1 页），跨页解答题至少完整出现一次。
            const is2up = !!(RENDER_2UP && RENDER_2UP.pageW > RENDER_2UP.pageH * 1.1);
            const chunks = [];
            if (ps.length <= 2) chunks.push(ps.slice());
            else for (let i = 0; i < ps.length; i += 1) chunks.push(ps.slice(i, i + 2));
            for (const chunk of chunks) {
              if (!chunk.length) continue;
              if (!budgetOk('《' + ch.title + '》P' + chunk.join('+'))) break;
              const pngs = await renderPageImgs(chunk);
              if (!pngs.length) { pushLog('⚠️ 《' + ch.title + '》第 ' + chunk.join('、') + ' 页转图无产出，该窗口跳过', 'warn'); continue; }
              // 【v21 双通道】文字层随图附上做汉字校对（乱码书它多半是噪声，规约已教模型忽略）
              let layerTxt = '';
              for (const p of chunk) layerTxt += '\n【P' + p + '】' + String(pgTxt[p] || '').slice(0, 3000);
              const vr = await aiJson(
                [{ role: 'system', content: bookChapterVisionSystem(subject, prefs.bookKind) },
                 { role: 'user', content: [{ type: 'text', text: '【章节】' + ch.title + '（原文页 ' + chunk.join('、') + (is2up ? ' · 每物理页已裁左右半页' : ' · 整页图片') + '）\n【该页文字层（仅校对汉字数字，公式以图为准）】' + (layerTxt.trim().slice(0, 6000) || '（无）') + '\n第一步：先数清楚这几页上一共出现了哪些题号；第二步：逐题输出，一题不落。只输出 JSON。' }].concat(pngs.map(u => ({ type: 'image_url', image_url: { url: u } }))) }],
                { think: false, temperature: 0.2, maxTokens: 16000 });
              if (Array.isArray(vr.content)) res.content = res.content.concat(vr.content);
              if (Array.isArray(vr.questions)) res.questions = res.questions.concat(vr.questions);
            }
            if (!res.content.length && !res.questions.length) {
              emptyN++;
              pushLog('⚠️ 《' + ch.title + '》视觉提取返回空（预检虽过，模型对这几页没读出内容——可重试或换更强的视觉模型）', 'warn');
              return;
            }
          } else {
            // 文字为主（原路径）
            let text = '';
            for (const p of ps) text += '\n【P' + p + '】\n' + String(pgTxt[p] || '');
            text = text.trim().slice(0, 24000);
            if (!text) return;
            res = await aiJson(
              [{ role: 'system', content: bookChapterSystem(subject, prefs.bookKind) },
               { role: 'user', content: '【章节】' + ch.title + '（原文页 ' + ch.from + '-' + ch.to + '）\n【原文】\n' + text + '\n\n请按系统规约提取本章讲义要点与题目，只输出 JSON。' }],
              { think: false, temperature: 0.3, maxTokens: 16000 });
          }
          const content = (Array.isArray(res.content) ? res.content : []).map(x => String(x || '').trim().slice(0, 500)).filter(Boolean).slice(0, 40);
          // 【v20】num 兜底：模型漏给 num 时从题干前缀解析原题号——「18.」「18、」「(18)」「（18）」（李林做题本用括号编号）
          function normQs(list, tag) {
            return (Array.isArray(list) ? list : []).map(function (q, qi) {
              const stem = String((q && q.stem) || '').trim().slice(0, 900);
              let n = parseInt(q && q.num, 10);
              if (!(n >= 1)) {
                const m = stem.match(/^\s*(?:[(（]\s*(\d{1,2})\s*[)）]|(\d{1,2})\s*[.、．])/);
                n = m ? parseInt(m[1] || m[2], 10) : 0;
              }
              const cf = Number(q && q.confidence);
              return {
                id: 'bq' + ci + '_' + tag + qi,
                num: n >= 1 && n <= 80 ? n : undefined,
                stem: stem,
                options: Array.isArray(q.options) ? q.options.slice(0, 4).map(o => String(o || '').slice(0, 120)) : undefined,
                answer: String((q && q.answer) || '').trim().slice(0, 200),
                solution: String((q && q.solution) || '').trim().slice(0, 800),
                conf: cf >= 0 && cf <= 1 ? Math.round(cf * 100) / 100 : undefined,
              };
            }).filter(q => q.stem);
          }
          // 滑窗重叠会让同一题号出现两份：按 num 去重，保留题干+解析更全的那份
          function dedupeByNum(list) {
            const byNum = {}, noNum = [];
            list.forEach(function (q) {
              if (!q.num) { noNum.push(q); return; }
              const old = byNum[q.num];
              const rich = (q.stem || '').length + (q.solution || '').length;
              if (!old || rich > (old.stem || '').length + (old.solution || '').length) byNum[q.num] = q;
            });
            return Object.keys(byNum).map(Number).sort(function (a, b) { return a - b; }).map(function (n) { return byNum[n]; }).concat(noNum);
          }
          let questions = dedupeByNum(normQs(res.questions, '')).slice(0, 80);
          // 【v20 缺题审计+定向补提】题号 1..max 有洞 → 拿原文（同通道）只补缺洞题号。
          //   最多两轮：模型第一轮偷懒漏了，第二轮拿「已提取题号清单」逼它只补缺口；
          //   某轮一题都没补回来 → 判定原文确实没有，停止（防无限烧调用）。
          for (let round = 0; round < 2; round++) {
            const miss = auditGapNums(questions);
            if (!miss.length) break;
            try {
              pushLog('🩹 《' + ch.title + '》题号审计缺 ' + miss.length + ' 题（' + miss.join('、') + '），第 ' + (round + 1) + ' 轮定向补提…');
              const got = [];
              if (wasVision) {
                // 【v21】补提窗口与提取一致 2 页/次（2-up 时 2 物理页=4 逻辑页顶格），并吃预算闸门
                for (let i = 0; i < ps.length; i += 2) {
                  const chunk = ps.slice(i, i + 2);
                  if (!budgetOk('补提《' + ch.title + '》P' + chunk.join('+'))) break;
                  const pngs = await renderPageImgs(chunk);
                  if (!pngs.length) continue;
                  const rr = await aiJson(
                    [{ role: 'system', content: bookRepairSystem(ch.title, miss) },
                     { role: 'user', content: [{ type: 'text', text: '【章节】' + ch.title + '（原文页 ' + chunk.join('、') + ' · 整页图片）\n只输出缺失题号的题目 JSON。' }].concat(pngs.map(u => ({ type: 'image_url', image_url: { url: u } }))) }],
                    { think: false, temperature: 0.2, maxTokens: 12000 });
                  if (Array.isArray(rr.questions)) got.push.apply(got, rr.questions);
                }
              } else {
                let text = '';
                for (const p of ps) text += '\n【P' + p + '】\n' + String(pgTxt[p] || '');
                const rr = await aiJson(
                  [{ role: 'system', content: bookRepairSystem(ch.title, miss) },
                   { role: 'user', content: '【章节】' + ch.title + '（原文页 ' + ch.from + '-' + ch.to + '）\n【原文】\n' + text.trim().slice(0, 24000) + '\n\n只输出缺失题号的题目 JSON。' }],
                  { think: false, temperature: 0.2, maxTokens: 12000 });
                if (Array.isArray(rr.questions)) got.push.apply(got, rr.questions);
              }
              const have = {}; questions.forEach(q => { if (q.num) have[q.num] = 1; });
              let added = 0;
              normQs(got, 'r' + round).forEach(function (q) {
                if (q.num && miss.indexOf(q.num) >= 0 && !have[q.num]) { questions.push(q); have[q.num] = 1; added++; }
              });
              if (added) {
                repairedN += added;
                questions.sort(function (a, b) { return (a.num || 999) - (b.num || 999); });
              }
              const still = auditGapNums(questions);
              if (!still.length) { pushLog('✅ 《' + ch.title + '》补提成功（+' + added + ' 题），题号已连续覆盖'); break; }
              if (!added) { pushLog('⚠️ 《' + ch.title + '》补提后仍缺 ' + still.join('、') + '（两轮无新增，判定原文跳号/图不清，停止补提）', 'warn'); break; }
            } catch (e) { pushLog('⚠️ 《' + ch.title + '》补提失败（' + String((e && e.message) || e).slice(0, 100) + '），保留已提取部分', 'warn'); break; }
          }
          if (!content.length && !questions.length) return;
          out.push({ id: 'ch' + (ci + 1), title: (ch.title || '章节').slice(0, 40), from: ch.from, to: ch.to, group: String(ch.group || '').slice(0, 12), content: content, questions: questions });
          done++;
          await setStatus('running', 'extracting', '📖 已提取 ' + done + '/' + chapters.length + ' 章 · ' + ch.title, 20 + Math.round(done / chapters.length * 70));
        }, (d, n) => { });
        out.sort((a, b) => a.from - b.from);
        const qTotal = out.reduce((a, c) => a + c.questions.length, 0);
        if (!out.length) {
          // 【v19】pool 把 worker 异常只记进 results[i].__err（console），用户端日志此前全盲。
          // 最终失败必须带第一个真实错误，否则「模型未产出有效内容」永远猜不动根因。
          const firstErr = (poolRes || []).find(r => r && r.__err);
          throw new Error('全部章节提取失败（' + chapters.length + ' 章：' + emptyN + ' 章返回空' + (firstErr ? '，' + (chapters.length - emptyN) + ' 章报错' : '') + '）'
            + (firstErr ? '。首个错误：' + String(firstErr.__err).slice(0, 220) : '')
            + '——视觉书请确认用的是支持图片输入的模型（GLM-4V/Qwen-VL/GPT-4o 等），换模型后点「♻️ 重发」');
        }
        // 【v21 S4 validate_index】断言③：正文区每页恰好归属一章。缺口并入前章（局部修，不全书重跑）。
        const contentStart = out.length ? out[0].from : 1;
        const cov = validateIndexCoverage(out, contentStart, pages);
        if (cov.gaps.length) {
          pushLog('🧮 validate_index：正文区 ' + contentStart + '-' + pages + ' 有 ' + cov.gaps.length + ' 段未归属 → 并入前章：'
            + cov.gaps.map(g => g[0] + '-' + g[1]).join('，'), 'warn');
          cov.gaps.forEach(function (g) {
            const prev = out.filter(c => c.from < g[0]).pop();
            if (prev && prev.to < g[0]) prev.to = Math.min(g[1], pages);
          });
        } else {
          pushLog('🧮 validate_index 通过：' + out.length + ' 章覆盖 P' + contentStart + '-' + pages + ' 无孤儿页');
        }
        const groups = deriveBookGroups(out);
        const book = {
          id: (job.jobId || 'book') + '-book',
          title: (String(prefs.bookTitle || '').trim() || '未命名资料').slice(0, 60),
          kind: (prefs.bookKind === '习题册' ? '习题册' : '讲义'),
          subject: subject,
          chapters: out, chapterCount: out.length, questionCount: qTotal,
          groups: groups,
          structSrc: structSrc, is2up: !!(RENDER_2UP && RENDER_2UP.pageW > RENDER_2UP.pageH * 1.1),
          basedOnPages: pages, builtBy: 'book-import', generatedAt: new Date().toISOString()
        };
        pushLog('✅ 整本提取完成：' + out.length + ' 章 · ' + qTotal + ' 题 · 视觉调用 ' + BOOK_VLM + '/' + BOOK_BUDGET + (repairedN ? '（含审计补提 ' + repairedN + ' 题）' : '') + (groups.length > 1 || groups[0].title !== '全册' ? '（' + groups.length + ' 个大类：' + groups.map(g => g.title + ' ' + g.count + ' 章').join(' / ') + '）' : ''));
        dropPendingStatus();
        await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
          'result.json': { content: JSON.stringify({ builtBy: 'book-import', book: book }) },
          'status.json': { content: JSON.stringify({ status: 'done', stage: 'finalizing', msg: '📚 整本提取完成（' + out.length + ' 章 · ' + qTotal + ' 题），可收录到资料库', progress: 100, log: RUN_LOG, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER, isBook: true }) }
        } });
        log('✅ 资料库任务完成');
        return;
      }
    }
    if (!groups.length) throw new Error('没有可识别的页面（文字层与转图均失败）');
    pushLog('🗂 识别分组：' + groups.map(g => g.kind + '(' + g.pages.join('+') + ')').join(' · '));
    await setStatus('running', 'parsing', '🗂 ' + groups.length + ' 组页面就绪（文字 ' + groups.filter(g => g.kind === 'text').length + ' · 视觉 ' + groups.filter(g => g.kind === 'img').length + '）', 13);
    // ---------- ③ 逐组识别（并发 3，组内按页保序） ----------
    const all = [];
    const failedGroups = [];
    // 识别一个组（text/img 两种形态共用）：返回题数；AI 失败抛错由调用方处理
    async function extractGroup(g) {
      await cancelCheckpoint();
      const userTxt = g.kind === 'text'
        ? '【第 ' + g.pages.join('、') + ' 页 · 文字层提取】\n' + String(g.text).slice(0, 24000)
        : '【第 ' + g.pages.join('、') + ' 页 · 整页图片】请从图片逐题识别。';
      const sys = g.kind === 'text' ? importTextSystem(subj) : importVisionSystem(subj);
      const msgs = g.kind === 'img'
        ? [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text: userTxt }].concat(g.imgs.map(u => ({ type: 'image_url', image_url: { url: u } }))) }]
        : [{ role: 'system', content: sys }, { role: 'user', content: userTxt }];
      const res = await aiJson(msgs, { think: false, temperature: 0.1 });
      const rawList = res && Array.isArray(res.questions) ? res.questions : (Array.isArray(res) ? res : []);
      const qs = [];
      for (const raw of rawList) {
        try { qs.push(normalizeImported(raw, g)); } catch (e) { pushLog('⚠️ 一题规范化失败已跳过：' + String(e.message || e).slice(0, 100), 'warn'); }
      }
      qs.forEach(q => all.push(q));
      // 每组识别完立即落盘 partial.json（含 imported 标记）：中途失败/停止也能抢救已识别题
      await flushPartial(all, { subject: subj, imported: true });
      pushLog('🔎 第 ' + g.pages.join(',') + ' 页（' + g.kind + '）识别出 ' + qs.length + ' 题，累计 ' + all.length + ' 题已落盘');
      return qs.length;
    }
    await pool(groups, 3, async (g) => {
      try { return { n: await extractGroup(g) }; }
      catch (e) {
        const m = String((e && e.message) || e);
        // 【v14 第二层防御】文字组被 AI 拒答（大概率是漏网的乱码文字层）→ 渲染整页转视觉重试一次。
        //   判据取反更稳：除明确的传输层错误（HTTP 401/403/408/429/5xx、断网、超时）外全部转视觉——
        //   解析类失败文案多样（没有 JSON / Unexpected token / 被截断 / 空正文），白名单容易漏。
        const transportErr = /HTTP 40[138]|HTTP 429|HTTP 5\d\d|Failed to fetch|timeout|超时|ECONN/i.test(m);
        if (g.kind === 'text' && typeof g.visionRetry === 'function' && !transportErr) {
          try {
            pushLog('🔁 第 ' + g.pages.join(',') + ' 页文本通道失败（' + m.slice(0, 60) + '），自动转视觉重试…', 'warn');
            await setStatus('running', 'extracting', '🔁 第 ' + g.pages.join(',') + ' 页转视觉重试…', 40);
            const imgGroups = await g.visionRetry();
            let n2 = 0, lastErr = null;
            for (const ig of imgGroups) {
              try { n2 += await extractGroup(Object.assign({ kind: 'img' }, ig)); }
              catch (e2) { lastErr = e2; pushLog('⚠️ 第 ' + ig.pages.join(',') + ' 页视觉重试仍失败：' + String(e2.message || e2).slice(0, 120), 'warn'); }
            }
            if (n2 > 0) return { n: n2, visionRescued: true };
            failedGroups.push({ pages: g.pages, err: (lastErr && String(lastErr.message || lastErr)) || m });
            return { __err: m };
          } catch (e3) {
            pushLog('⚠️ 第 ' + g.pages.join(',') + ' 页转视觉准备失败：' + String(e3.message || e3).slice(0, 120), 'warn');
          }
        }
        failedGroups.push({ pages: g.pages, err: m.slice(0, 160) });
        pushLog('⚠️ 第 ' + g.pages.join(',') + ' 页组识别失败：' + m.slice(0, 140), 'warn');
        return { __err: m };
      }
    }, (d, n) => setStatus('running', 'extracting', '🔎 AI 拆题中（' + d + '/' + n + ' 组 · 已识出 ' + all.length + ' 题）…', 15 + Math.round(d / n * 65)));
    if (!all.length) {
      throw new Error('所有页面识别失败（共 ' + groups.length + ' 组' + (failedGroups.length ? '：' + failedGroups.map(f => 'P' + f.pages.join('+') + ' ' + f.err).join('；') : '') + '）');
    }
    // ---------- ④ 合并去重 + 排序 + 打包 ----------
    await cancelCheckpoint();
    await setStatus('running', 'finalizing', '📦 整理成卷…', 85);
    const seen = {};
    const uniq = [];
    for (const q of all) {
      const k = String(q.stem).replace(/\s+/g, '').slice(0, 90);
      if (seen[k]) continue;
      seen[k] = 1; uniq.push(q);
    }
    const dropped = all.length - uniq.length;
    if (dropped) pushLog('🧹 跨页边界去重：丢弃 ' + dropped + ' 道重复题');
    uniq.sort((a, b) => ((a.sourcePages[0] || 0) - (b.sourcePages[0] || 0)) || ((Number(a.no) || 0) - (Number(b.no) || 0)));
    uniq.forEach((q, i) => { if (q.no == null) q.no = i + 1; });
    const lowN = uniq.filter(q => q.lowConfidence).length;
    // ---------- ④.5 AI 思考补全参考答案与解析（v13，prefs.fillAnswers 开启时） ----------
    // 只补「卷面缺答案/缺解析」的题：answer/solution 为空的才进补全队列。
    // 补全产物挂到 q.aiAnswer/q.aiSolution + aiFilled:true——绝不覆盖卷面原文字段，
    // 客户端预览与卷页用「🧠 AI 补全」徽标区分展示（零幻觉：卷面有无答案永远可溯）。
    let filledN = 0, fillFailN = 0;
    if (prefs.fillAnswers) {
      const needFill = uniq.filter(q => !String(q.answer || '').trim() || !String(q.solution || '').trim());
      if (needFill.length) {
        await setStatus('running', 'finalizing', '🧠 AI 思考补全 ' + needFill.length + ' 题的答案解析…', 86);
        pushLog('🧠 开始补全：' + needFill.length + '/' + uniq.length + ' 题缺卷面答案或解析（思考模式逐题求解）');
        await smartPool(needFill, 4, async (q) => {
          try {
            const r = await aiJson(
              [{ role: 'system', content: importFillSystem(subj) },
               { role: 'user', content: '【第 ' + (q.no || '?') + ' 题·' + (q.type || 'solve') + '】\n题干：' + String(q.stem).slice(0, 3000)
                 + (Array.isArray(q.options) && q.options.length ? '\n选项：\n' + q.options.join('\n') : '')
                 + (String(q.answer || '').trim() ? '\n（卷面已有答案，仅需补解析）：' + String(q.answer).slice(0, 300) : '') }],
              { think: true, temperature: 0.2 });
            const aiAns = String((r && r.answer) || '').trim();
            const aiSol = String((r && r.solution) || '').trim();
            if (/^无法求解/.test(aiAns) || (!aiAns && !aiSol)) {
              fillFailN++;
              q.aiNote = String((r && r.unsure) || aiAns || 'AI 判定信息不足').slice(0, 200);
              pushLog('⚠️ 第 ' + (q.no || '?') + ' 题无法补全：' + String(q.aiNote).slice(0, 80), 'warn');
              return;
            }
            if (!String(q.answer || '').trim() && aiAns) q.aiAnswer = aiAns;
            if (!String(q.solution || '').trim() && aiSol) q.aiSolution = aiSol;
            if (r.unsure) q.aiNote = String(r.unsure).slice(0, 200);
            q.aiFilled = true;
            filledN++;
          } catch (e) {
            fillFailN++;   // 单题失败不致命：该题保持无答案进人工复核
            log('补全失败 @题' + (q.no || '?'), e.message);
          }
        }, (d, n) => setStatus('running', 'finalizing', '🧠 AI 补全中（' + d + '/' + n + ' 题）…', 86 + Math.round(d / n * 9)));
        pushLog('🧠 补全完成：成功 ' + filledN + ' 题' + (fillFailN ? '，无法求解/失败 ' + fillFailN + ' 题（保持待人工）' : ''));
      } else {
        pushLog('🧠 已勾选补全，但所有题都有卷面答案与解析，跳过');
      }
    }
    const totalScore = uniq.reduce((a, q) => a + (Number(q.score) || 0), 0);
    const exam = {
      id: job.jobId + '-imp',
      title: (String(prefs.importTitle || '').trim() || '📄 导入试卷').slice(0, 60) + '（' + uniq.length + ' 题）',
      subject: subj,
      timeLimit: Number(prefs.importTimeLimit) > 0 ? Number(prefs.importTimeLimit) : Math.max(30, uniq.length * 6),
      totalScore: totalScore || uniq.length * 5,
      questions: uniq,
      imported: true, lowConfidenceCount: lowN, failedPages: failedGroups.map(f => f.pages.join('+')),
      aiFilledCount: filledN,
      builtBy: 'pdf-import', generatedAt: new Date().toISOString()
    };
    pushLog('✅ 识别完成：' + uniq.length + ' 题 · 待人工复核 ' + lowN + ' 题' + (failedGroups.length ? ' · 失败页组 ' + failedGroups.length : ''));
    await flushPartial(uniq, { subject: subj, imported: true, force: true });
    dropPendingStatus();
    await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
      'result.json': { content: JSON.stringify(exam) },
      'status.json': { content: JSON.stringify({ status: 'done', stage: 'finalizing', msg: '📄 识别完成（' + uniq.length + ' 题 · 待复核 ' + lowN + '），可收卷导入预览确认', progress: 100, log: RUN_LOG, qs: QS, savedCount: _partialCount, imported: true, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER }) }
    } });
    log('✅ 导入任务完成');
  } finally {
    try { fsT.rmSync(wd, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---------- 主流程 ----------
(async function main() {
  // 供 catch（取消/失败路径）使用：try 块内 let/const 的作用域到不了 catch，
  // 若在 catch 里直接引用 gist/subj 会 ReferenceError 崩进程 → partial 卷写不出去。
  let JOB_GIST = null;
  let JOB_SUBJ = 'math';
  let JOB_JOBID = '';   // 供 catch 里写 log.json 使用（job 是 try 内 const，catch 取不到）
  try {
    // ① 读任务
    let gist;
    try { gist = await ghRetry('GET', '/gists/' + GIST_ID); }
    catch (e) {
      if (e.status === 404) throw new Error('找不到任务 Gist（404）：gist_id 传错，或 CLOUDJOB_GH_TOKEN 缺 gist 权限。GIST_ID=' + GIST_ID);
      throw e;
    }
    if (!gist || !gist.files || !gist.files['job.json']) throw new Error('Gist 缺 job.json');
    JOB_GIST = gist;
    // 【2026-09-02 容错】用容错读取（content 缺失/空/size 不符自动 raw_url 回补）；
    // 万一仍失败，把 GIST_ID + files keys/sizes 全打出来方便直接定位
    var jobJsonRaw = await gistFileText(gist.files, 'job.json');
    if (!jobJsonRaw) {
      var fk = Object.keys(gist.files || {}).map(function (k) {
        var f = gist.files[k];
        return k + '(size=' + (f.size || 0) + ',truncated=' + !!f.truncated + ',contentLen=' + (f.content ? f.content.length : 0) + ')';
      }).join(',');
      throw new Error('GIST_ID=' + GIST_ID + ' job.json 读取为空/损坏。files=' + fk);
    }
    const job = JSON.parse(jobJsonRaw);
    JOB_JOBID = String(job.jobId || '');
    var statusJsonRaw = gist.files['status.json'] ? await gistFileText(gist.files, 'status.json') : '{}';
    const stNow = JSON.parse(statusJsonRaw || '{}');
    if (stNow.status === 'canceled') { log('任务已被用户取消，直接退出'); return; }
    const prefs = job.prefs || {};
    /* 【H1 断点续跑】job.resume 存在 → 从 partial.json 取回上次已出的题，只补缺口。
     * 为什么值得做：一次出卷 10~20 分钟、几十次 AI 调用，若第 16 题偶发网络失败就整卷作废，
     * 前面 15 题白烧的 token 与时间比这一题贵得多。续跑把「失败重来」变成「接着出」。 */
    let resumeQs = [];
    let resumeNeed = 0;
    const resuming = !!(job.resume && job.resume.target);
    if (resuming) {
      const pj = readPartialJson(gist);
      if (pj && pj.__truncated) throw new Error('partial.json 过大已被截断，无法续跑（请重新出卷）');
      resumeQs = ((pj && pj.questions) || []).filter(q => q && q.stem);
      if (!resumeQs.length) {
        log('续跑：partial.json 里没有可用题目，退回全新出卷');
        pushLog('⚠️ 续跑未找到已落盘题目，退回全新出卷', 'warn');
      } else {
        SAVED = resumeQs.slice();
        _partialCount = resumeQs.length;
        resumeNeed = Math.max(0, (job.resume.target || 0) - resumeQs.length);
        pushLog('▶️ 续跑模式：已落盘 ' + resumeQs.length + ' 题，目标 ' + job.resume.target + ' 题，还需补 ' + resumeNeed + ' 题');
      }
    }
    // AI 配置：优先任务自带的 prefs.ai（本地工具写入 secret Gist），回退 repo secrets
    JOB_AI = prefs.ai || null;
    // 思考模式：结构化 JSON 出卷默认关闭思考（思考模型会把 token 烧光致空正文、卡死）；
    // 仅当用户显式勾选「启用思考模式」（prefs.think=true）才开启。
    JOB_THINK = !!prefs.think;
    // 【2026-08-31】最大输出 token 可配置：job.prefs.maxTokens（出卷弹窗填写，随 job.json 下发）；
    // 不填/非法 = 默认 32768。钳制 1024-65536（防手滑 0 或爆预算）。
    var mt = parseInt(prefs.maxTokens, 10);
    JOB_MAXTOK = (mt >= 1024 && mt <= 65536) ? mt : 32768;
    // 专业课名：专业课（ctrl）科目出卷必须具体到专业，否则提示词只会写泛化的「专业课」三个字。
    JOB_MAJOR = String(prefs.major || '').trim();
    log('AI 配置来源：', JOB_AI ? 'job.json' : 'repo secrets', '· model =', aiConf('model') || '(空)', '· think =', JOB_THINK, '· major =', JOB_MAJOR || '(无)');
    if (!aiConf('endpoint') || !aiConf('key') || !aiConf('model')) {
      throw new Error('缺 AI 配置：任务未携带（prefs.ai）且 repo secrets 也未配置');
    }

    // ①.5 自检模式：只验证链路（Gist 读写 + secret 有效 + AI 配置在场），不调 AI、不耗 token
    if (prefs.check) {const aiOk = !!(aiConf('endpoint') && aiConf('key') && aiConf('model'));
      await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
        'result.json': { content: JSON.stringify({ cloudJobCheck: true, ok: true, aiConfigPresent: aiOk, checkedAt: new Date().toISOString() }) },
        'status.json': { content: JSON.stringify({ status: 'done', stage: '', msg: '🧪 自检通过：Gist 读写 ✓ · CLOUDJOB_GH_TOKEN ✓ · AI 配置在场' + (aiOk ? ' ✓' : ' ✗'), progress: 100, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER }) }
      } });
      log('🧪 自检完成');
      return;
    }
    const subj = prefs.subject === 'auto' ? 'math' : (prefs.subject || 'math');   // auto 由规划阶段自行判断科目语境
    JOB_SUBJ = subj;
    // 【v10 导入通道】prefs.mode==='import' → 走 PDF/图片识别流水线，与出卷流水线平行
    // 【v17 致命修复·资料库】book 模式也必须进 runImport——book 分支就写在 runImport 里面，
    //   旧入口只认 'import'，mode='book' 的任务直接掉进出卷管线（用户实测：四套卷 90+ 题
    //   被当成数一蓝本出了 22 道新题，日志全是「并发出题/总审查/定向重写」）。
    //   回归测试：tests/core/cloudjob-repo.test.ts「book 分发」守门断言。
    if (prefs.mode === 'import' || prefs.mode === 'book') {
      await runImport(gist, job, prefs);
      return;
    }
    log('接单', job.jobId, JSON.stringify(prefs));
    pushLog('📋 接单 ' + job.jobId + ' · ' + (SUBJ_NAME[subj] || subj) + ' · 难度 ' + (prefs.diff || 'mix') + ' · 模型 ' + (aiConf('model') || '?') + ' · maxTok ' + JOB_MAXTOK + (JOB_THINK ? ' · 💭 思考模式' : ' · ⚡ 不思考(结构化)'));
    pushLog('🧠 思考开关已对齐本地：' + (JOB_THINK ? '开启（若思考模型烧光 token 会自动关思考降级）' : '关闭（结构化 JSON 默认不思考，避免空正文卡死）'));
    // 云端工具探测：python3 + sympy 可用则启用出题/审查的工具调用
    try {
      await execPython('import sympy\nprint("ok")');
      PY_TOOLS_ON = true;
      pushLog('🧮 云端工具调用已启用：sympy 就绪（出题/重写/审查可自主调用 Python 验算）');
    } catch (e) {
      PY_TOOLS_ON = false;
      pushLog('⚠️ Python/sympy 不可用，本次退化为纯 LLM 出卷（不影响出卷，仅无工具验算）', 'warn');
    }

    // key/endpoint 匹配预检：最常见的 401 根因，开跑前先提醒（写进日志，浮窗可见）
    {
      const ep = aiConf('endpoint') || '', key = aiConf('key') || '';
      if (/sk-or-v1-/.test(key) && !/openrouter\.ai/i.test(ep)) pushLog('⚠️ key 是 OpenRouter 的（sk-or-v1-…）但 endpoint 不是 openrouter.ai——大概率会 401，请换该平台自己的 key');
      else if (/sk-ant-/.test(key) && !/anthropic/i.test(ep)) pushLog('⚠️ key 是 Anthropic 的（sk-ant-…）但 endpoint 不是 anthropic——大概率会 401');
    }

    // ② 总工规划
    const isResume = resuming && resumeQs.length > 0;
    // 【2026-09-03】把生效蓝图提到主流程作用域：worker / chief / 终检都要用到 bp.starMix 与 bp.types
    // （不再在 plannerSystem 里局部声明，避免 worker/chief 引用不到）。
    const bp = resolveBpFromPrefs(subj, prefs);
    // 【v13 子母卷】derive 模式：先读母卷指纹 → AI 归纳「命题形式研究报告」→ 注入 planner。
    //   研究报告失败不致命（降级为无风格约束的普通出卷，任务仍能完成，只是不"仿母卷"）。
    let deriveStyleNote = null;
    if (prefs.mode === 'derive' && !isResume) {
      await setStatus('running', 'planning', '🧬 研究母卷命题形式…', 3);
      try {
        let srcTxt = await gistFileText(gist.files, 'source.json');
        if (!srcTxt && SOURCE_GIST_ID) {
          const assetGist = await ghRetry('GET', '/gists/' + SOURCE_GIST_ID);
          srcTxt = await gistFileText((assetGist && assetGist.files) || {}, 'source.json');
        }
        if (!srcTxt) throw new Error('任务未携带 source.json 母卷指纹');
        const src = JSON.parse(srcTxt);
        pushLog('🧬 母卷《' + (src.motherTitle || '?') + '》指纹就绪：' + (src.questions || []).length + ' 题 · ★配比 ' + JSON.stringify(src.starMix || {}));
        deriveStyleNote = await aiText(
          [{ role: 'system', content: deriveStyleSystem(subj, prefs) },
           { role: 'user', content: '【母卷命题形式指纹】\n' + JSON.stringify(src).slice(0, 30000) }],
          { temperature: 0.3 });
        deriveStyleNote = String(deriveStyleNote || '').trim().slice(0, 1200);
        if (!deriveStyleNote) deriveStyleNote = null;
        pushLog(deriveStyleNote ? ('📝 命题形式研究报告完成（' + deriveStyleNote.length + ' 字），据此规划子卷') : '⚠️ 研究报告为空，降级为普通出卷');
      } catch (e) {
        pushLog('⚠️ 母卷形式研究失败，降级为普通出卷：' + String((e && e.message) || e).slice(0, 120), 'warn');
        deriveStyleNote = null;
      }
    }
    await setStatus('running', 'planning', isResume ? ('续跑规划中…（已有 ' + resumeQs.length + ' 题，补 ' + resumeNeed + ' 题）') : (deriveStyleNote ? '🧬 子卷总工按母卷形式规划蓝图…' : '总工程师正在规划蓝图…'), 5);
    let plan;
    if (isResume && resumeNeed <= 0) {
      // 题已够：跳过规划与出题，直接进入终检打包（单纯把上次落盘的题走完审查流程）
      plan = { title: null, timeLimit: (job.resume && job.resume.timeLimit) || 120, questions: [] };
      pushLog('✅ 题量已满足（' + resumeQs.length + '/' + job.resume.target + '），跳过出题直接终检');
    } else if (isResume) {
      plan = await aiJson(
        [{ role: 'system', content: plannerSystem(subj, prefs, deriveStyleNote) },
         { role: 'user', content: '【续跑任务】本卷此前已出好 ' + resumeQs.length + ' 题，还缺 ' + resumeNeed + ' 题。\n'
           + '已有题目涉及的考点与设问角度如下——请只规划**剩余的 ' + resumeNeed + ' 题**，'
           + '严禁重复已有考点与设问角度（否则用户会拿到两道雷同的题）：\n'
           + resumeQs.map((q, i) => (i + 1) + '. ' + String(q.topicName || '?') + '：' + String(q.stem || '').slice(0, 60)).join('\n')
           + '\n只输出 JSON，questions 数组长度必须恰好为 ' + resumeNeed + '。' }],
        {});
    } else {
      plan = await aiJson(
        [{ role: 'system', content: plannerSystem(subj, prefs, deriveStyleNote) },
         { role: 'user', content: deriveStyleNote ? '请依据上述母卷命题形式，规划一张同形式的子卷蓝图（新题、不复刻母卷）。' : '请规划本卷蓝图。' }],
        {});
    }
    // 续跑且题已够时 questions 允许为空；其余情况空蓝图就是失败
    if (!plan || !Array.isArray(plan.questions)) throw new Error('蓝图规划失败：返回格式不对');
    if (!plan.questions.length && !(isResume && resumeNeed <= 0)) throw new Error('蓝图规划失败：无 questions');
    // 【2026-09-03 链路加固】蓝图落地时按 bp 决定性覆盖 score + star，AI 自由发挥不再生效。
    // 【v16 蓝本槽位制】结构归位：题型/数量/分值/星级全由蓝本槽位决定，AI 只贡献内容；
    // 缺槽自动补规划一轮，超产弃用——卷面结构永不错位（不再等终检 blueprintCheck 才发现跑偏）。
    // 【注意】续跑路径只规划「剩余缺题」，不是全卷蓝图 —— 跳过归位；score 按题型队列出队
    // （含 0 分行均摊序列，与已落盘题保持同口径），星级 clampStar 兜底。
    if (isResume) {
      var scoreQueuesResume = bpScoreQueues(bp);
      plan.questions.forEach(function (pq) {
        var arr = scoreQueuesResume[pq.type];
        pq.score = (arr && arr.length) ? arr.shift() : scoreForType(bp, pq.type);
        pq.star = clampStar(pq.star);
      });
    } else {
      var rec = reconcilePlanSlots(plan.questions, bp);
      if (rec.extras.length) pushLog('🧹 弃用超产规划题 ' + rec.extras.length + ' 道（题型不符合蓝本槽位）');
      if (rec.missing.length) {
        pushLog('🧩 蓝图归位缺口 ' + rec.missing.length + ' 题（' + rec.missing.map(function (m2) { return m2.label || m2.type; }).join('、') + '），自动补规划…', 'warn');
        try {
          const repair = await aiJson(
            [{ role: 'system', content: plannerSystem(subj, prefs, deriveStyleNote) },
             { role: 'user', content: '【只补规划缺失题位】整卷大部分题位已规划完成，请只补规划以下缺失题位'
               + '（题型/星级/分值必须严格按给定槽位，考点优先取尚未覆盖的薄弱方向，禁止与其他题位重复考点）：\n'
               + rec.missing.map(function (m2, i2) { return (i2 + 1) + '. type=' + m2.type + ' ★' + m2.star + ' ' + m2.score + ' 分'; }).join('\n')
               + '\n只输出 JSON：{"questions":[{"topicName":"考点","type":"…","direction":"…","star":1-5,"score":分值}]}，'
               + '数组长度必须恰好为 ' + rec.missing.length + '，顺序与上述题位一一对应。' }],
            {});
          var repaired = 0;
          (repair && Array.isArray(repair.questions) ? repair.questions : []).forEach(function (q, i2) {
            if (i2 >= rec.missing.length) return;
            var slot = rec.missing[i2];
            q.type = slot.type; q.score = slot.score; q.star = slot.star; q.qid = slot.qid; q._slotLabel = slot.label;
            rec.questions.push(q); repaired++;
          });
          pushLog('🧩 补规划完成：+' + repaired + ' 题' + (repaired < rec.missing.length ? '（仍缺 ' + (rec.missing.length - repaired) + ' 题，终检将如实标记）' : ''));
        } catch (e) {
          pushLog('⚠️ 补规划失败（继续用已归位的题）：' + String((e && e.message) || e).slice(0, 80), 'warn');
        }
      }
      plan.questions = rec.questions;
    }
    var planStarMix = forceStarMix(plan.questions, bp);
    log('蓝图完成：', plan.questions.length, '题 ·', plan.title || '', '· star 分布=', JSON.stringify(planStarMix.distribution));
    pushLog('🗺 蓝图《' + (plan.title || '未命名卷') + '》规划完成：共 ' + plan.questions.length + ' 题 · 限时 ' + (plan.timeLimit || 120) + ' 分钟 · ★分布 ' + JSON.stringify(planStarMix.distribution));
    plan.questions.forEach((pq, i) => pushLog('　第' + (i + 1) + '题 ' + (pq.topicName || '?') + ' · ' + (pq.type || '?') + ' · ★' + (pq.star || '?') + ' · ' + (pq.score || 0) + '分'));
    // 初始化逐题状态墙（浮窗卡片数据源）
    // 续跑时先为「上次已落盘的题」占位（st=done + resumed 标记），浮窗一眼能看出哪些是接着出的
    if (isResume) {
      resumeQs.forEach((q, i) => QS.push({ i: i + 1, topic: String(q.topicName || '?').slice(0, 30), star: clampStar(q.star), type: q.type || '?', score: Number(q.score) || 5,
        st: 'done', resumed: true, stem: String(q.stem || '').slice(0, 140), ans: String(q.answer || '').slice(0, 60) }));
    }
    plan.questions.forEach((pq, i) => QS.push({ i: resumeQs.length + i + 1, topic: String(pq.topicName || '?').slice(0, 30), star: pq.star, type: pq.type || '?', score: pq.score || 5, st: 'wait' }));
    await setStatus('running', 'generating', '并发出题中… 0/' + plan.questions.length, 10);

    // ③ 并发出题池
    let genDone = 0;
    const genTotal = plan.questions.length;
    let questions = genTotal ? await smartPool(plan.questions, 4, async (pq, i) => {
      const ci = await checkCancel();
      if (ci && ci.canceled) throw new CancelError('cancel');
      QS[i].st = 'run';
      QS[i].t0 = Date.now();
      // 【2026-09-03 配额治理】开工不再单独 setStatus：QS[i].st='run' 会随「上一题完成」或
      // 「本题完成」的节流窗口合并写入，浮窗逐题卡片仍会更新，省掉每题一次的冗余 PATCH。
      const out = await aiToolJson(
        [{ role: 'system', content: questionSystem(subj) },
         { role: 'user', content: '蓝图第' + (i + 1) + '题：' + JSON.stringify(pq) }],
        {});
      out.topicName = pq.topicName || out.topicName || '';
      // 【2026-09-03】出题 AI 经常乱填 score → 按蓝图决定性覆盖；【v16】直接取规划阶段算好的
      // pq.score（含 0 分行均摊值）——旧实现按题型反查，出题阶段在完成顺序上乱序覆盖，
      // 同题型多行（英语一 choice 0.5/2 分）会全部错配到第一行。
      // diff 字段也按 clampStar 反推，避免与 star 自相矛盾。
      out.score = pq.score;
      out.type = pq.type || out.type || 'solve';
      out.star = clampStar(pq.star);   // 【v16 槽位制】星级由蓝本槽位决定（AI 自由发挥不生效）
      out.diff = ({ 1: 'easy', 2: 'easy', 3: 'medium', 4: 'hard', 5: 'hard' })[out.star] || 'medium';
      if (!validateQuestion(out)) {
        QS[i].st = 'done';
        QS[i].sec = Math.round((Date.now() - QS[i].t0) / 1000);
        QS[i].stem = String(out.stem || '').slice(0, 140);
        QS[i].ans = String(out.answer || '').slice(0, 60);
        genDone++;
        SAVED.push(out);   // 合格题攒进 SAVED，「停止并保存」时打包成 partial 卷
        // 每题完成即落盘：一题要 30s~2min，写一次 Gist 不到 1s，代价可忽略，
        // 换来的是「进程随时可死、已出的题永不丢」。
        await flushPartial(SAVED);
        pushLog('✅ 第' + (i + 1) + '题出好了 · ' + (out.topicName || '?') + ' · ★' + (out.star || '?') + '（' + genDone + '/' + genTotal + '）');
        await setStatus('running', 'generating', '并发出题中… ' + genDone + '/' + genTotal, 10 + Math.round(genDone / genTotal * 45));
      }
      return out;
    }) : [];   // 续跑且题量已够时 plan.questions 为空 → 不出新题，直接拿已落盘的题进终检
    // 池结束后：仍处 run 状态的题 = 生成失败或取消（pool 吞掉了异常）
    QS.forEach(q => { if (q.st === 'run') { q.st = 'fail'; q.err = '生成失败'; } });
    // 【H1】续跑：把上次已落盘的题并到新出的题前面，构成完整卷
    if (isResume) {
      const fresh = questions.filter(q => q && q.stem && !q.__err && !q.__canceled);
      questions = resumeQs.concat(fresh);
      pushLog('🔗 续跑合并：' + resumeQs.length + ' 题（已有） + ' + fresh.length + ' 题（新出） = ' + questions.length + ' 题');
    }
    await cancelCheckpoint();   // 出题阶段完成 → 检查取消（已出 SAVED 题可保存）

    // ④ 蓝本硬校验（纯代码）：坏题先标记，交由审查后统一重写
    const localIssues = [];
    questions.forEach((q, i) => {
      const bad = validateQuestion(q);
      const braceBad = !braceBalanced(q.stem) || !braceBalanced(q.solution);
      if (bad || braceBad) localIssues.push({ index: i + 1, reason: bad + (braceBad ? '；LaTeX 花括号不平衡' : ''), fixHint: '修复结构问题，保持题意不变' });
    });
    log('本地硬校验：', localIssues.length, '题有问题');
    pushLog('🔍 本地硬校验：' + (questions.length - localIssues.length) + ' 题过关，' + localIssues.length + ' 题待修');

    // ⑤ 总工审查
    await setStatus('running', 'reviewing', '总工程师审查中…', 58);
    let review = {};
    let reviewFailed = false;
    try {
      review = await aiToolJson(
        [{ role: 'system', content: chiefSystem(subj, bp) },
         { role: 'user', content: '审查这份押题卷（题号从1开始，共 ' + questions.length + ' 题）：\n' + JSON.stringify(questions.map((q, i) => ({
           index: i + 1, stem: q.stem, options: q.options, answer: q.answer,
           solution: String(q.solution || ''), star: q.star, diff: q.diff, score: q.score,
           topicName: q.topicName, type: q.type, direction: plan.questions[i] && plan.questions[i].direction
         })) ) }],
        {});
    } catch (e) {
      reviewFailed = true;
      log('审查调用失败，仅按本地校验处理：', e.message);
      pushLog('⚠️ 总审查调用失败（' + String((e && e.message) || '').slice(0, 60) + '），降级为本地校验通过', 'warn');
    }
    const rewriteList = [];
    const seenRw = {};
    // 【2026-09-03】needsRewrite 的 index 必须落在 1..questions.length 范围内（之前不校验，
    // AI 可能写 0 或超大下标 → 后续 questions[i] = undefined → 重写池空跑或越界）。
    ((review.needsRewrite) || []).forEach(r => {
      if (!r || !r.index) return;
      var idx = parseInt(r.index, 10);
      if (!(idx >= 1 && idx <= questions.length)) { log('审查 needsRewrite.index 越界：', r.index); return; }
      if (!seenRw[idx]) { seenRw[idx] = 1; rewriteList.push(r); }
    });
    localIssues.forEach(li => { if (!seenRw[li.index]) { seenRw[li.index] = 1; rewriteList.push(li); } });
    log('审查 verdict=', review.verdict || 'n/a', '待重写', rewriteList.length, '题');
    pushLog('🧐 总审查 verdict=' + (review.verdict || 'n/a') + (review.summary ? '（' + String(review.summary).slice(0, 60) + '）' : '') + '，待重写 ' + rewriteList.length + ' 题');
    rewriteList.forEach(rw => pushLog('　第' + rw.index + '题需重写：' + String(rw.reason || '').slice(0, 50)));
    await cancelCheckpoint();   // 审查完成 → 检查取消

    // ⑥ 定向重写池
    if (rewriteList.length) {
      await setStatus('running', 'rewriting', '定向重写 ' + rewriteList.length + ' 题…', 68);
      rewriteList.forEach(rw => { const q = QS[rw.index - 1]; if (q) q.st = 'rewrite'; });
      await smartPool(rewriteList, 3, async (rw) => {
        const i = rw.index - 1;
        const old = questions[i];
        if (!old) return null;
        // 【2026-08-27 收敛闭环】重写后不达标不再是"保留原题"摆烂（那等于返工白跑）：
        // 不达标就把「校验失败原因」作为新反馈再重写一轮（上限 2 轮），让 审查→重写→再校验 真正收敛。
        let fixed = null;
        let lastBad = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          const feedback = attempt === 0
            ? '必须修复：' + rw.reason + '。指引：' + (rw.fixHint || '')
            : '上一轮重写仍未通过校验，问题：' + (lastBad || '') + '。请针对性修复并确保解析完整（分步+结论+易错点）。';
          const cand = await aiToolJson(
            [{ role: 'system', content: questionSystem(subj) },
             { role: 'user', content: '重写这道题（原题如下）。' + feedback + '\n原题：' + JSON.stringify(old) }],
            {});
          // 旧题可能是 worker 失败占位（{__err}），topicName/score 会丢——回退到蓝图原题参数
          const pq0 = plan.questions[i];
          cand.topicName = old.topicName || (pq0 && pq0.topicName) || '';
          // 【2026-09-03】重写也按蓝图决定性覆盖 score（避免 AI 在重写 prompt 里再填 5）
          // 【v16】优先取蓝图规划阶段算好的 pq0.score（含均摊值）；旧题占位/续跑丢失时退回按行反查
          cand.score = (pq0 && pq0.score) || scoreForType(bp, cand.type || (pq0 && pq0.type) || old.type);
          cand.type = old.type || (pq0 && pq0.type) || cand.type;
          cand.star = clampStar(cand.star);
          cand.diff = ({ 1: 'easy', 2: 'easy', 3: 'medium', 4: 'hard', 5: 'hard' })[cand.star] || 'medium';
          const bad = validateQuestion(cand);
          if (!bad) { fixed = cand; break; }
          lastBad = bad;
          log('重写第', attempt + 1, '轮未过校验 @', rw.index, ':', bad);
        }
        if (!fixed) { log('重写 2 轮后仍不合格，保留原题 @', rw.index, lastBad); pushLog('⚠️ 第' + rw.index + '题重写 2 轮仍未过关，保留原题（' + String(lastBad || '').slice(0, 40) + '）'); const q = QS[i]; if (q) { q.st = 'done'; q.err = '重写未过，保留原题'; } return null; }
        questions[i] = fixed;
        const q = QS[i]; if (q) { q.st = 'done'; q.stem = String(fixed.stem || '').slice(0, 140); q.ans = String(fixed.answer || '').slice(0, 60); }
        pushLog('✏️ 第' + rw.index + '题重写完成');
        return null;
      }, (d, n) => setStatus('running', 'rewriting', '定向重写中… ' + d + '/' + n, 68 + Math.round(d / n * 20)));
    }

    // ⑦ 终检 + 打包
    await cancelCheckpoint();   // 终检前最后一道取消检查
    await setStatus('running', 'finalizing', '终检打包中…', 92);
    const finalBad = [];
    questions.forEach((q, i) => { const b = validateQuestion(q); if (b) finalBad.push((i + 1) + ':' + b); });
    if (finalBad.length > Math.ceil(questions.length / 3)) throw new Error('终检不合格题过多（' + finalBad.length + '/' + questions.length + '），放弃交付：' + finalBad.join('; ').slice(0, 300));
    // 剔除个别终检仍坏的题（宁缺毋滥），至少保留 60%
    questions = questions.filter(q => !validateQuestion(q));
    if (questions.length < 5) throw new Error('合格题不足 5 题，放弃交付');
    // 【2026-09-03】重写后 / 终检后做一次 forceStarMix（防止 AI 自由发挥让 ★4+★5 远超 bp.starMix）
    var finalMix = forceStarMix(questions, bp);
    if (finalMix.changed > 0) pushLog('🎯 终检再平衡 star 配比：调整 ' + finalMix.changed + ' 题 → ' + JSON.stringify(finalMix.distribution));
    // 【2026-09-03】总分对齐：Σ q.score 必须 = bp.totalScore（除不尽的零头贴最后一题）。
    // 出题阶段已按蓝本槽位决定性覆盖，理论已对齐；此处兜底防止某个 review/chief 误改了 score。
    // 【v16 护栏】贴齐上限 5 分——差得多说明有题位没出齐（补规划也失败了），把 40 分贴给
    // 最后一题是荒谬的（旧数一卷出现过 0,0,0,0,0,86），如实保留缺口让 blueprintCheck 标记。
    var bpTotal = bpTotalScore(bp);
    var sumScore = questions.reduce(function (a, q) { return a + (Number(q.score) || 0); }, 0);
    if (Math.abs(sumScore - bpTotal) > 0.01 && questions.length && Math.abs(bpTotal - sumScore) <= 5) {
      var drift = +(bpTotal - sumScore).toFixed(2);
      questions[questions.length - 1].score = +((Number(questions[questions.length - 1].score) || 0) + drift).toFixed(2);
      sumScore = questions.reduce(function (a, q) { return a + (Number(q.score) || 0); }, 0);
      pushLog('⚖️ 总分对齐：原 Σ ' + sumScore.toFixed(0) + ' → 强制贴齐蓝图 ' + bpTotal + '（最后一题吸收 ' + drift + ' 分）');
    } else if (Math.abs(sumScore - bpTotal) > 5) {
      pushLog('⚠️ 总分 Σ ' + sumScore + ' ≠ 蓝图 ' + bpTotal + '（差 ' + Math.round(Math.abs(bpTotal - sumScore)) + ' 分，疑有题位未出齐——不做贴齐，如实标记）', 'warn');
    }
    const totalScore = sumScore;
    const exam = {
      title: plan.title || ('云端押题卷 · ' + (SUBJ_NAME[subj] || '')),
      subject: subj,
      timeLimit: plan.timeLimit || 120,
      totalScore: totalScore,
      questions: questions,
      // 【2026-09-03】审查异常时不再默 ok（之前 reviewFailed=true 时 chiefReview.verdict 走 fallback 仍写 ok → 用户误以为"已过审"）；
      // 降级为 'unknown' 让前端明示"AI 审查未响应，本地校验通过"
      chiefReview: { verdict: reviewFailed ? 'unknown' : (review.verdict || (rewriteList.length ? 'minor' : 'ok')),
        hardPct: review.hardPct || null, targetHardPct: targetHardPct(bp),
        summary: review.summary || (reviewFailed ? 'AI 审查未响应，已按本地校验通过' : ''),
        rewrittenCount: rewriteList.length, reviewFailed: reviewFailed },
      builtBy: 'cloud-actions',
      generatedAt: new Date().toISOString()
    };

    // ⑧ 收卷回写
    pushLog('📦 终检通过：' + questions.length + ' 题 · 总分 ' + totalScore + ' · 即将回写');
    // 先落盘终稿再写 result.json：这一步是整条链路的最后一跳、文件最大、最容易失败
    // （Gist 限额/网络/权限都可能在这一刻报错），落盘后即使它挂了，
    // 客户端也能从 partial.json 抢救出「已过总工审查的完整卷」，而不是退回初稿。
    await flushPartial(questions, { reviewed: true, subject: subj, force: true });
    dropPendingStatus();
    await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
      'result.json': { content: JSON.stringify(exam) },
      'status.json': { content: JSON.stringify({ status: 'done', stage: '', msg: '出卷完成（' + questions.length + ' 题 · ' + totalScore + ' 分），可收卷导入', progress: 100, log: RUN_LOG, qs: QS, savedCount: _partialCount, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER }) }
    } });
    log('✅ 完成');
  } catch (e) {
    // 进入终态处理（取消/失败）：先丢弃节流攒着的待发 running，否则它会在下面
    // 直写 canceled/error 之后迟到触发，把终态覆盖回 running（客户端永远看到「进行中」）。
    dropPendingStatus();
    // 取消路径：用户主动停止 → 按 savePartial 决定是否把已出合格题打包成 partial 卷
    if (e && e.name === 'CancelError') {
      const wantSave = !(e.message === 'user-cancel-no-save');
      const cands = (SAVED || []).filter(q => q && q.stem);
      try {
        if (wantSave && cands.length) {
          // 取消路径也补一次落盘：把「最后一次 flush 之后才完成」的题补进 partial.json，
          // 保证 result.json 与 partial.json 内容一致（客户端优先用前者，后者作兜底）。
          await flushPartial(cands, { force: true });
          const partial = {
            title: '☁️ 云端押题卷（部分 · ' + cands.length + ' 题）',
            subject: (function () {
              try { if (JOB_GIST && JOB_GIST.files && JOB_GIST.files['job.json']) return (JSON.parse(JOB_GIST.files['job.json'].content).prefs || {}).subject; } catch (e) {}
              return JOB_SUBJ;
            })() || 'math',
            timeLimit: 120, totalScore: cands.reduce((a, q) => a + (Number(q.score) || 5), 0),
            questions: cands, partial: true, cancelReason: '用户停止时保存已出题目',
            builtBy: 'cloud-actions', generatedAt: new Date().toISOString()
          };
          await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
            'result.json': { content: JSON.stringify(partial) },
            'status.json': { content: JSON.stringify({ status: 'canceled', stage: '', msg: '⏹ 已停止 · 已保存 ' + cands.length + ' 题（可收卷导入部分卷）', progress: 100, partialSaved: true, partialCount: cands.length, savedCount: _partialCount, log: RUN_LOG, qs: QS, updatedAt: new Date().toISOString(), runnerVer: RUNNER_VER }) }
          } });
          log('⏹ 已停止并保存', cands.length, '题');
        } else {
          await setStatus('canceled', '', '⏹ 已停止（未保存题目）', 100);
          log('⏹ 已停止，未保存');
        }
      } catch (err2) {
        // 取消路径内部兜底：绝不能因写回异常让状态卡在 running 假运行
        log('!! 取消落盘异常，降级写 canceled：', err2.message);
        try { await setStatus('canceled', '', '⏹ 已停止（保存失败：' + String(err2.message || '').slice(0, 40) + '）', 100); } catch (e3) {}
        process.exitCode = 1;
        return;
      }
      process.exitCode = 0;
      return;
    }
    log('❌ 失败：', e.message);
    // 崩溃前的最后一次抢救：把内存里还没落盘的题尽力写出去。
    // 这是本次重构的核心场景——执行器失败退出后，本地仍能从 partial.json 捞回已出的题，
    // 而不是像旧实现那样「进程一死，题目全没，本地点多少次保存都没用」。
    // SAVED 定义在 try 块之外，catch 里可安全引用（gist/subj 是 try 内 const，不可引用）。
    try { await flushPartial(SAVED, { force: true }); } catch (e0) { log('!! 失败前抢救落盘异常：', e0.message); }
    // 【H5】先把完整日志单独落盘，再写 error 状态：
    // 万一写 status 这一步也失败，日志已经在 log.json 里，客户端仍能看到「AI 在哪一步挂的」。
    pushLog('❌ 执行失败：' + String((e && e.message) || e).slice(0, 200), 'error');
    try { await writeLogFile(String((e && e.message) || e), JOB_JOBID); } catch (eL) {}
    try { await setStatus('error', '', '云端执行失败：' + ((e && e.message) || e)); } catch (e2) {}
    process.exitCode = 1;
  }
})();
