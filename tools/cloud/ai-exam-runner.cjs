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
const GH_TOKEN = process.env.GH_TOKEN || '';

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
        if (res.statusCode >= 400) { const e = new Error('GitHub HTTP ' + res.statusCode + ' ' + txt.slice(0, 200)); e.status = res.statusCode; return reject(e); }
        resolve(d);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('GitHub 请求超时')));
    if (data) req.write(data);
    req.end();
  });
}
async function ghRetry(method, path, body, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await ghReq(method, path, body); }
    catch (e) {
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
    const payload = { runnerVer: 'v8', jobId: jobId || '', at: new Date().toISOString(), error: extra || null, entries: RUN_LOG };
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
async function flushPartial(questions, opts) {
  opts = opts || {};
  const list = (questions || []).filter(q => q && q.stem);
  _flushChain = _flushChain.then(async () => {
    const payload = {
      count: list.length,
      reviewed: !!opts.reviewed,
      subject: opts.subject || 'math',
      updatedAt: new Date().toISOString(),
      questions: list
    };
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
let _stChain = Promise.resolve();
function setStatus(status, stage, msg, progress) {
  _stChain = _stChain.then(() => _setStatus(status, stage, msg, progress)).catch(() => {});
  return _stChain;
}
async function _setStatus(status, stage, msg, progress) {
  pushLog((stage ? '[' + stage + '] ' : '') + (msg || ''));
  // savedCount = 已成功落盘到 partial.json 的题数（= 客户端随时能抢救走的数量），
  // 让本地无需额外拉 Gist 就知道「现在有几题可抢救」，任务行可直接显示入口。
  const payload = { files: { 'status.json': { content: JSON.stringify({ status, stage: stage || '', msg: msg || '', progress: progress == null ? null : progress, log: RUN_LOG, qs: QS, savedCount: _partialCount, updatedAt: new Date().toISOString(), runnerVer: 'v8' }) } } };
  try { await ghRetry('PATCH', '/gists/' + GIST_ID, payload); log('status →', status, stage || '', msg || ''); return true; }
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
async function aiRetry(messages, opts, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      // 【H5】只给「慢调用」打点：每题都记耗时会把日志淹没，而出卷卡住时用户真正想知道的
      // 就是「是哪一次调用特别慢」。阈值 30s（正常出题 10~40s，超 60s 基本可判定异常）。
      const _t0 = Date.now();
      const r = await aiCall(messages, opts);
      const _dur = Date.now() - _t0;
      if (_dur >= 30000) pushLog('🐢 AI 调用较慢：' + Math.round(_dur / 1000) + 's' + (_dur >= 60000 ? '（异常，可能是思考模型在长推理）' : ''), 'warn', _dur);
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
      // 429 限流：退避加倍重试（限流是暂时的，多等一会儿比失败好）
      if (code === 429 && i < tries - 1) {
        log('AI 限流 429，退避', 15 * (i + 1), 's 后重试');
        pushLog('⏳ AI 限流 429，退避 ' + (15 * (i + 1)) + 's 后重试（第 ' + (i + 1) + ' 次）', 'warn');
        await sleep(15000 * (i + 1));
        continue;
      }
      if (i >= tries - 1) throw e;
      log('AI 调用失败重试', i + 1, e.message);
      pushLog('🔁 AI 调用失败，' + (3 * (i + 1)) + 's 后重试（第 ' + (i + 1) + '/' + (tries - 1) + ' 次）：' + String(e.message).slice(0, 80), 'warn');
      await sleep(3000 * (i + 1));
    }
  }
}
// 宽容 JSON 抽取：剥 <think> 思考块 → 剥代码围栏 → 找首个平衡的 {...} 或 [...]
function extractJson(txt) {
  let t = String(txt || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // 思考模型的显式思考块
    .replace(/<think>[\s\S]*$/i, '')             // 未闭合的思考块（后面不会再有正文了）
    .trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/g, '').trim();
  try { return JSON.parse(t); } catch (e) {}
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
    else if (ch === close) { depth--; if (!depth) return JSON.parse(t.slice(s, i + 1)); }
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
class CancelError extends Error { constructor(m) { super(m); this.name = 'CancelError'; } }
async function checkCancel(force) {
  if (_cancelCache && !force) return _cancelCache;
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
async function pool(items, conc, worker, onEachDone) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function runOne() {
    while (idx < items.length) {
      const ci = await checkCancel();
      if (ci && ci.canceled) break;                       // 已取消：不再取新题
      const i = idx++;
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

// 蓝本预设（与 js/core/exam-pipeline.js 保持同步）
const DEFAULT_BP = {
  shuyi: { name: '数学一（真题卷型）', subject: 'math', totalScore: 150, timeLimit: 180, types: [{ type: 'choice', count: 10, score: 5 }, { type: 'fill', count: 6, score: 5 }, { type: 'solve', count: 6, score: 0 }], starMix: { 1: 0, 2: 15, 3: 45, 4: 30, 5: 10 } },
  ctrl: { name: '专业课（6 道综合大题）', subject: 'ctrl', totalScore: 150, timeLimit: 180, types: [{ type: 'solve', count: 6, score: 25 }], starMix: { 1: 0, 2: 0, 3: 35, 4: 45, 5: 20 } },
  yingyi: { name: '英语一（真题卷型）', subject: 'eng', totalScore: 100, timeLimit: 180, types: [{ type: 'choice', count: 20, score: 0.5 }, { type: 'choice', count: 20, score: 2 }, { type: 'solve', count: 1, score: 10 }, { type: 'essay', count: 2, score: 15 }], starMix: { 1: 0, 2: 20, 3: 50, 4: 25, 5: 5 } },
  pol: { name: '政治（真题卷型）', subject: 'pol', totalScore: 100, timeLimit: 180, types: [{ type: 'choice', count: 16, score: 1 }, { type: 'choice', count: 17, score: 2 }, { type: 'solve', count: 5, score: 10 }], starMix: { 1: 10, 2: 30, 3: 40, 4: 15, 5: 5 } },
  ying2: { name: '英语二', subject: 'eng', totalScore: 100, timeLimit: 180, types: [{ type: 'fill', count: 10, score: 1 }, { type: 'choice', count: 15, score: 2 }, { type: 'essay', count: 2, score: 15 }, { type: 'solve', count: 1, score: 0 }], starMix: { 1: 8, 2: 22, 3: 40, 4: 25, 5: 5 } }
};
const SUBJ_TO_PRESET = { math: 'shuyi', ctrl: 'ctrl', eng: 'yingyi', pol: 'pol' };

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

function plannerSystem(subj, prefs) {
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
  return '你是考研' + subjName(subj) + '命题总工程师。请按给定蓝本规划一份押题卷。'
    + '\n【蓝本】' + (bp.name || '押题卷') + '：' + structure + '，共 ' + n + ' 题，总分 ' + totalScore + '，限时 ' + timeLimit + ' 分钟。'
    + '\n【难度】' + diffNote
    + '\n要求：①覆盖不同考点，突出今年高频与考生薄弱方向 ②题型分布严格符合蓝本结构 ③每题给出方向描述供出题 AI 执行。\n'
    + '只输出 JSON：{"title":"卷名","timeLimit":' + timeLimit + ',"questions":[{"topicName":"考点","type":"choice|fill|solve|essay","direction":"命题方向一句话"}]}';
}
function questionSystem(subj) {
  return '你是考研' + subjName(subj) + '命题专家。按给定蓝图出一道题：题目创新但解法严格在考纲内；题干严谨无歧义；选择题给 4 个选项（A. B. C. D. 开头）；答案必须正确——输出前自己把解答完整走一遍（能算的数值都算实），确保答案与解析逐步一致。\n'
    + '【解析完整性·硬要求】solution 必须"分步推导→结论→易错点"三段式完整；solve/essay 题解析 ≥60 字、choice 题 ≥25 字、fill 题 ≥20 字；禁止只写最终答案或一句话带过。\n'
    + '只输出 JSON：{"stem":"题干(LaTeX用$...$)","type":"choice|fill|solve|essay","options":["A. ..","B. ..","C. ..","D. .."]或省略,"answer":"正确答案","solution":"详细解析","trap":"常见陷阱一句话","diff":"easy|medium|hard","star":1-5}';
}
function chiefSystem(subj) {
  return '你是考研' + subjName(subj) + '押题卷总审查工程师。逐题检查：①解析是否完整（是否分步推导+结论+易错点、是否满足 solve/essay≥60字·choice≥25字·fill≥20字的下限——看的是**完整解析**，不是片段）②答案是否正确（工具开启时优先用 python_exec 真实验算关键步骤，不要心算）③题干是否严谨无歧义 ④选项是否有双对/无解 ⑤难度星级是否虚标。verdict 判定：全过关 ok；≤2 题小问题 minor；更多或整卷性问题 major。\n'
    + '只输出 JSON：{"verdict":"ok|minor|major","targetHardPct":40,"hardPct":实际hard百分比,"summary":"总评一句话","needsRewrite":[{"index":题号从1开始,"reason":"问题","fixHint":"修改指引"}]}';
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
    const job = JSON.parse(gist.files['job.json'].content);
    JOB_JOBID = String(job.jobId || '');
    const stNow = gist.files['status.json'] ? JSON.parse(gist.files['status.json'].content) : {};
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
    if (prefs.check) {
      const aiOk = !!(aiConf('endpoint') && aiConf('key') && aiConf('model'));
      await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
        'result.json': { content: JSON.stringify({ cloudJobCheck: true, ok: true, aiConfigPresent: aiOk, checkedAt: new Date().toISOString() }) },
        'status.json': { content: JSON.stringify({ status: 'done', stage: '', msg: '🧪 自检通过：Gist 读写 ✓ · CLOUDJOB_GH_TOKEN ✓ · AI 配置在场' + (aiOk ? ' ✓' : ' ✗'), progress: 100, updatedAt: new Date().toISOString(), runnerVer: 'v1' }) }
      } });
      log('🧪 自检完成');
      return;
    }
    const subj = prefs.subject === 'auto' ? 'math' : (prefs.subject || 'math');   // auto 由规划阶段自行判断科目语境
    JOB_SUBJ = subj;
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
    await setStatus('running', 'planning', isResume ? ('续跑规划中…（已有 ' + resumeQs.length + ' 题，补 ' + resumeNeed + ' 题）') : '总工程师正在规划蓝图…', 5);
    let plan;
    if (isResume && resumeNeed <= 0) {
      // 题已够：跳过规划与出题，直接进入终检打包（单纯把上次落盘的题走完审查流程）
      plan = { title: null, timeLimit: (job.resume && job.resume.timeLimit) || 120, questions: [] };
      pushLog('✅ 题量已满足（' + resumeQs.length + '/' + job.resume.target + '），跳过出题直接终检');
    } else if (isResume) {
      plan = await aiJson(
        [{ role: 'system', content: plannerSystem(subj, prefs) },
         { role: 'user', content: '【续跑任务】本卷此前已出好 ' + resumeQs.length + ' 题，还缺 ' + resumeNeed + ' 题。\n'
           + '已有题目涉及的考点与设问角度如下——请只规划**剩余的 ' + resumeNeed + ' 题**，'
           + '严禁重复已有考点与设问角度（否则用户会拿到两道雷同的题）：\n'
           + resumeQs.map((q, i) => (i + 1) + '. ' + String(q.topicName || '?') + '：' + String(q.stem || '').slice(0, 60)).join('\n')
           + '\n只输出 JSON，questions 数组长度必须恰好为 ' + resumeNeed + '。' }],
        {});
    } else {
      plan = await aiJson(
        [{ role: 'system', content: plannerSystem(subj, prefs) },
         { role: 'user', content: '请规划本卷蓝图。' }],
        {});
    }
    // 续跑且题已够时 questions 允许为空；其余情况空蓝图就是失败
    if (!plan || !Array.isArray(plan.questions)) throw new Error('蓝图规划失败：返回格式不对');
    if (!plan.questions.length && !(isResume && resumeNeed <= 0)) throw new Error('蓝图规划失败：无 questions');
    log('蓝图完成：', plan.questions.length, '题 ·', plan.title || '');
    pushLog('🗺 蓝图《' + (plan.title || '未命名卷') + '》规划完成：共 ' + plan.questions.length + ' 题 · 限时 ' + (plan.timeLimit || 120) + ' 分钟');
    plan.questions.forEach((pq, i) => pushLog('　第' + (i + 1) + '题 ' + (pq.topicName || '?') + ' · ' + (pq.type || '?') + ' · ★' + (pq.star || '?')));
    // 初始化逐题状态墙（浮窗卡片数据源）
    // 续跑时先为「上次已落盘的题」占位（st=done + resumed 标记），浮窗一眼能看出哪些是接着出的
    if (isResume) {
      resumeQs.forEach((q, i) => QS.push({ i: i + 1, topic: String(q.topicName || '?').slice(0, 30), star: q.star || '?', type: q.type || '?', score: q.score || 5,
        st: 'done', resumed: true, stem: String(q.stem || '').slice(0, 140), ans: String(q.answer || '').slice(0, 60) }));
    }
    plan.questions.forEach((pq, i) => QS.push({ i: resumeQs.length + i + 1, topic: String(pq.topicName || '?').slice(0, 30), star: pq.star || '?', type: pq.type || '?', score: pq.score || 5, st: 'wait' }));
    await setStatus('running', 'generating', '并发出题中… 0/' + plan.questions.length, 10);

    // ③ 并发出题池
    let genDone = 0;
    const genTotal = plan.questions.length;
    let questions = genTotal ? await pool(plan.questions, 4, async (pq, i) => {
      const ci = await checkCancel();
      if (ci && ci.canceled) throw new CancelError('cancel');
      QS[i].st = 'run';
      QS[i].t0 = Date.now();
      await setStatus('running', 'generating', '并发出题中… ' + genDone + '/' + genTotal, 10 + Math.round(genDone / genTotal * 45));
      const out = await aiToolJson(
        [{ role: 'system', content: questionSystem(subj) },
         { role: 'user', content: '蓝图第' + (i + 1) + '题：' + JSON.stringify(pq) }],
        {});
      out.topicName = pq.topicName || out.topicName || '';
      out.score = out.score || pq.score || 5;
      out.type = pq.type || out.type || 'solve';
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
    try {
      review = await aiToolJson(
        [{ role: 'system', content: chiefSystem(subj) },
         { role: 'user', content: '审查这份押题卷（题号从1开始）：\n' + JSON.stringify(questions.map((q, i) => ({ index: i + 1, stem: q.stem, options: q.options, answer: q.answer, solution: String(q.solution || ''), star: q.star })) ) }],
        {});
    } catch (e) { log('审查调用失败，仅按本地校验处理：', e.message); }
    const rewriteList = [];
    const seenRw = {};
    ((review.needsRewrite) || []).forEach(r => { if (r && r.index && !seenRw[r.index]) { seenRw[r.index] = 1; rewriteList.push(r); } });
    localIssues.forEach(li => { if (!seenRw[li.index]) { seenRw[li.index] = 1; rewriteList.push(li); } });
    log('审查 verdict=', review.verdict || 'n/a', '待重写', rewriteList.length, '题');
    pushLog('🧐 总审查 verdict=' + (review.verdict || 'n/a') + (review.summary ? '（' + String(review.summary).slice(0, 60) + '）' : '') + '，待重写 ' + rewriteList.length + ' 题');
    rewriteList.forEach(rw => pushLog('　第' + rw.index + '题需重写：' + String(rw.reason || '').slice(0, 50)));
    await cancelCheckpoint();   // 审查完成 → 检查取消

    // ⑥ 定向重写池
    if (rewriteList.length) {
      await setStatus('running', 'rewriting', '定向重写 ' + rewriteList.length + ' 题…', 68);
      rewriteList.forEach(rw => { const q = QS[rw.index - 1]; if (q) q.st = 'rewrite'; });
      await pool(rewriteList, 3, async (rw) => {
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
          cand.topicName = old.topicName; cand.score = old.score; cand.type = old.type || cand.type;
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
    const totalScore = questions.reduce((a, q) => a + (Number(q.score) || 5), 0);
    const exam = {
      title: plan.title || ('云端押题卷 · ' + (SUBJ_NAME[subj] || '')),
      subject: subj,
      timeLimit: plan.timeLimit || 120,
      totalScore: totalScore,
      questions: questions,
      chiefReview: { verdict: review.verdict || (rewriteList.length ? 'minor' : 'ok'), hardPct: review.hardPct || null, targetHardPct: review.targetHardPct || null, summary: review.summary || '', rewrittenCount: rewriteList.length },
      builtBy: 'cloud-actions',
      generatedAt: new Date().toISOString()
    };

    // ⑧ 收卷回写
    pushLog('📦 终检通过：' + questions.length + ' 题 · 总分 ' + totalScore + ' · 即将回写');
    // 先落盘终稿再写 result.json：这一步是整条链路的最后一跳、文件最大、最容易失败
    // （Gist 限额/网络/权限都可能在这一刻报错），落盘后即使它挂了，
    // 客户端也能从 partial.json 抢救出「已过总工审查的完整卷」，而不是退回初稿。
    await flushPartial(questions, { reviewed: true, subject: subj });
    await ghRetry('PATCH', '/gists/' + GIST_ID, { files: {
      'result.json': { content: JSON.stringify(exam) },
      'status.json': { content: JSON.stringify({ status: 'done', stage: '', msg: '出卷完成（' + questions.length + ' 题 · ' + totalScore + ' 分），可收卷导入', progress: 100, log: RUN_LOG, qs: QS, savedCount: _partialCount, updatedAt: new Date().toISOString(), runnerVer: 'v8' }) }
    } });
    log('✅ 完成');
  } catch (e) {
    // 取消路径：用户主动停止 → 按 savePartial 决定是否把已出合格题打包成 partial 卷
    if (e && e.name === 'CancelError') {
      const wantSave = !(e.message === 'user-cancel-no-save');
      const cands = (SAVED || []).filter(q => q && q.stem);
      try {
        if (wantSave && cands.length) {
          // 取消路径也补一次落盘：把「最后一次 flush 之后才完成」的题补进 partial.json，
          // 保证 result.json 与 partial.json 内容一致（客户端优先用前者，后者作兜底）。
          await flushPartial(cands);
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
            'status.json': { content: JSON.stringify({ status: 'canceled', stage: '', msg: '⏹ 已停止 · 已保存 ' + cands.length + ' 题（可收卷导入部分卷）', progress: 100, partialSaved: true, partialCount: cands.length, savedCount: _partialCount, log: RUN_LOG, qs: QS, updatedAt: new Date().toISOString(), runnerVer: 'v8' }) }
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
    try { await flushPartial(SAVED); } catch (e0) { log('!! 失败前抢救落盘异常：', e0.message); }
    // 【H5】先把完整日志单独落盘，再写 error 状态：
    // 万一写 status 这一步也失败，日志已经在 log.json 里，客户端仍能看到「AI 在哪一步挂的」。
    pushLog('❌ 执行失败：' + String((e && e.message) || e).slice(0, 200), 'error');
    try { await writeLogFile(String((e && e.message) || e), JOB_JOBID); } catch (eL) {}
    try { await setStatus('error', '', '云端执行失败：' + ((e && e.message) || e)); } catch (e2) {}
    process.exitCode = 1;
  }
})();
