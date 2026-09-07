// 书测试启动器：在 Actions 内用 CLOUDJOB_GH_TOKEN（有 gist 权限）创建资源/任务 Gist 并派发 ai-exam
import fs from 'fs';
const T = process.env.GH_TOKEN;
const H = { accept: 'application/vnd.github+json', 'user-agent': 'launch', authorization: 'Bearer ' + T, 'content-type': 'application/json' };
async function api(m, p, b) {
  const r = await fetch('https://api.github.com' + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(m + ' ' + p + ' -> ' + r.status + ' ' + t.slice(0, 300));
  if (!t || r.status === 204) return {};   // dispatches 返回 204 空体
  return JSON.parse(t);
}
// AI 配置：从用户既有任务 Gist（secret gist 凭 URL 可读）取 prefs.ai
const src = await (await fetch('https://api.github.com/gists/7b42e4cf69d3cd066980efbac6a6dfd3', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'x' } })).json();
const ai = JSON.parse(src.files['job.json'].content).prefs.ai;
console.log('AI config loaded: model=' + ai.model);
const BOOKS = [
  { title: '贾基八十五套卷 数学一', file: 'test_pdfs/jiaji_a3_math1.pdf', fileName: '[A3][数学一][紧凑版] 贾基八十五套卷.pdf', asset: '50d4fd2eae8d00be680791c88621ac7c' },
  { title: '贾基八十五套卷 数学二', file: 'test_pdfs/jiaji_k16_math2.pdf', fileName: '[K16] 贾基八十五套卷 [数学二] [compact](1).pdf', asset: '008868923db7e70572e3c9ce7aee0ad7' },
];
const ts = Date.now();
for (const [i, b] of BOOKS.entries()) {
  let assetId = b.asset;
  if (!assetId) {
    const raw = fs.readFileSync(b.file);
    const ag = await api('POST', '/gists', { description: '[kaoyan2026] exam-import-asset zt' + ts + '_' + i + ' ' + b.fileName, public: false, files: { 'source.pdf.b64': { content: raw.toString('base64') } } });
    assetId = ag.id;
  }
  const jid = 'zt' + ts + '_' + i;
  const job = { ver: 1, jobId: jid, prefs: { subject: 'math', mode: 'book', think: false, bookTitle: b.title, bookKind: '习题册', importKind: '习题册', fileName: b.fileName, importTitle: b.title, importTimeLimit: 180, fillAnswers: false, ai }, createdAt: new Date().toISOString() };
  const tg = await api('POST', '/gists', { description: '[kaoyan2026] exam-import ' + jid, public: false, files: { 'job.json': { content: JSON.stringify(job) } } });
  await api('POST', '/repos/CTRL66666/KaoYanTools_WorkRepo/actions/workflows/ai-exam.yml/dispatches', { ref: 'main', inputs: { gist_id: tg.id, resource_gist_id: assetId } });
  console.log('TASK_GIST ' + jid + ' task=' + tg.id + ' asset=' + assetId + ' ' + b.title);
  await new Promise(r => setTimeout(r, 4000));
}
console.log('LAUNCH DONE');
