'use strict';

// 模型评测 run 模块：对某个 BM 快照，用某个模型版本直接调 VLM 接口跑预测，
// 把每条样本的预测落库到 eval_registry/runs/<run_id>/，并计算夹住/没夹住准召率。
// 只读 BM 快照与图片，不动原图与平台 records。

const fs = require('fs');
const path = require('path');
const samplePool = require('./sample_pool');
const bmSnapshot = require('./bm_snapshot');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REGISTRY_DIR = path.join(PROJECT_ROOT, 'eval_registry');
const RUNS_DIR = path.join(REGISTRY_DIR, 'runs');
const MODELS_PATH = path.join(REGISTRY_DIR, 'models.json');

const DEFAULT_PROMPT = `判断机器人夹爪是否夹住了物体。只能输出下面一个字母，不要输出解释：
G：夹住，夹爪当前夹住了物体。
N：没夹住，夹爪当前没有夹住物体。`;

// 进行中的 run 进度（内存态，供前端轮询）。
const runJobs = new Map();

function nowIso() {
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(tz / 60)}:${pad(tz % 60)}`;
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitize(s) {
  return String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

// 读取模型注册表。
function loadModels() {
  if (!fs.existsSync(MODELS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
    return Array.isArray(raw.models) ? raw.models : [];
  } catch (error) {
    return [];
  }
}

function getModel(key) {
  return loadModels().find((m) => m.key === key) || null;
}

function buildEndpointFromHostPort(host, port, path = '/v1/chat/completions') {
  const h = String(host || '').trim().replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  const p = String(port || '').trim().replace(/[^\d]/g, '');
  if (!h || !p) return '';
  const pathNorm = path.startsWith('/') ? path : `/${path}`;
  return `http://${h}:${p}${pathNorm}`;
}

// 用请求里的 IP/端口（或完整 endpoint）覆盖注册表里的地址。
function applyEndpointOverride(modelCfg, override = {}) {
  if (!modelCfg) return null;
  const cfg = Object.assign({}, modelCfg);
  const host = String(override.endpoint_host || override.host || '').trim();
  const port = String(override.endpoint_port || override.port || '').trim();
  if (host && port) {
    cfg.endpoint = buildEndpointFromHostPort(host, port, override.endpoint_path);
  } else if (override.endpoint) {
    cfg.endpoint = String(override.endpoint).trim();
  }
  if (override.model) cfg.model = String(override.model).trim();
  return cfg;
}

function effectiveModelKey(modelCfg, override = {}) {
  const host = String(override.endpoint_host || override.host || '').trim();
  const port = String(override.endpoint_port || override.port || '').trim();
  if (host && port) {
    const base = (modelCfg && (modelCfg.key || modelCfg.model)) || 'custom';
    return `${base}@${host}:${port}`;
  }
  return (modelCfg && modelCfg.key) || '';
}

// 把模型原始输出解析成 G / N / Unknown。
function parsePrediction(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'Unknown';
  if (/没夹|未夹|没有夹|没抓|未抓|not[\s_]*grasp|\bno\b|\bfalse\b/i.test(text)) return 'N';
  if (/夹住|已夹|grasp|\byes\b|\btrue\b/i.test(text)) return 'G';
  const letter = text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
  if (letter === 'G' || letter === 'Y' || letter === 'B') return 'G';
  if (letter === 'N' || letter === 'A' || letter === 'C') return 'N';
  return 'Unknown';
}

function imageContentType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function imageBlock(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    type: 'image_url',
    image_url: { url: `data:${imageContentType(filePath)};base64,${buf.toString('base64')}` },
  };
}

// 调一次模型，返回 { raw, pred, error }。
async function callModel(modelCfg, sampleId) {
  const cam1 = samplePool.resolveImagePath(sampleId, '1');
  if (!cam1) return { raw: '', pred: 'Unknown', error: '找不到 cam1 图片' };
  const blocks = [imageBlock(cam1)];
  if (modelCfg.send_cam0) {
    const cam0 = samplePool.resolveImagePath(sampleId, '0');
    if (cam0) blocks.push(imageBlock(cam0));
  }
  const payload = {
    model: modelCfg.model,
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: modelCfg.prompt || DEFAULT_PROMPT }] }],
    max_tokens: 16,
    temperature: 0,
  };
  const apiKey = modelCfg.api_key_env ? process.env[modelCfg.api_key_env] : '';
  let response;
  try {
    response = await fetch(modelCfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { raw: '', pred: 'Unknown', error: `调用失败：${error.message || error}` };
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    return { raw: '', pred: 'Unknown', error: `响应解析失败 HTTP ${response.status}` };
  }
  if (!response.ok) {
    return { raw: '', pred: 'Unknown', error: result.detail || result.message || `HTTP ${response.status}` };
  }
  const raw = String(result.choices?.[0]?.message?.content || '').trim();
  const pred = parsePrediction(raw);
  return { raw, pred, error: pred === 'Unknown' ? `无法识别输出：${raw || '空'}` : '' };
}

// 由预测明细计算指标（夹住=G 为正类，没夹住=N 为另一类）。
function computeMetrics(predictions) {
  const scored = predictions.filter((p) => p.gt_label === 'G' || p.gt_label === 'N');
  const m = {
    evaluated: scored.length,
    excluded_no_gt: predictions.length - scored.length,
    correct: 0,
    confusion: { gg: 0, gn: 0, ng: 0, nn: 0, g_unknown: 0, n_unknown: 0 },
  };
  for (const p of scored) {
    if (p.gt_label === 'G' && p.pred_label === 'G') m.confusion.gg += 1;
    else if (p.gt_label === 'G' && p.pred_label === 'N') m.confusion.gn += 1;
    else if (p.gt_label === 'N' && p.pred_label === 'G') m.confusion.ng += 1;
    else if (p.gt_label === 'N' && p.pred_label === 'N') m.confusion.nn += 1;
    else if (p.gt_label === 'G') m.confusion.g_unknown += 1;
    else m.confusion.n_unknown += 1;
    if (p.gt_label === p.pred_label) m.correct += 1;
  }
  const c = m.confusion;
  const predG = c.gg + c.ng;
  const predN = c.nn + c.gn;
  const actualG = c.gg + c.gn + c.g_unknown;
  const actualN = c.nn + c.ng + c.n_unknown;
  const safe = (a, b) => (b > 0 ? a / b : null);
  m.accuracy = safe(m.correct, m.evaluated);
  m.grasp_precision = safe(c.gg, predG);
  m.grasp_recall = safe(c.gg, actualG);
  m.nograsp_precision = safe(c.nn, predN);
  m.nograsp_recall = safe(c.nn, actualN);
  m.actual_g = actualG;
  m.actual_n = actualN;
  return m;
}

// 计算总指标 + 按类别指标。
function computeAllMetrics(predictions) {
  const overall = computeMetrics(predictions);
  const byCat = {};
  const cats = Array.from(new Set(predictions.map((p) => p.object_category)));
  for (const cat of cats.sort()) {
    byCat[cat] = computeMetrics(predictions.filter((p) => p.object_category === cat));
  }
  return { overall, by_category: byCat };
}

function listModels() {
  return { ok: true, models: loadModels() };
}

// 启动一次 run（后台执行）。返回 run_id。
function startRun(opts = {}) {
  const bmId = sanitize(opts.bmId);
  const modelKey = opts.modelKey;
  if (!bmId) return { ok: false, message: '请选择 BM 快照' };
  const snap = bmSnapshot.getSnapshot(bmId);
  if (!snap.ok) return { ok: false, message: '快照不存在' };
  const modelCfg = applyEndpointOverride(getModel(modelKey), opts);
  if (!modelCfg) return { ok: false, message: '模型不存在，请检查 models.json' };
  if (!modelCfg.endpoint) return { ok: false, message: '模型 endpoint 无效，请检查 IP/端口或 models.json' };

  const runId = `run_${bmId}_${sanitize(modelKey)}_${stamp()}`;
  const dir = path.join(RUNS_DIR, runId);
  if (fs.existsSync(dir)) return { ok: false, message: 'run 已存在，请稍后重试' };

  const samples = snap.samples;
  const job = {
    run_id: runId, bm_id: bmId, model_key: modelKey, model: modelCfg.model,
    status: 'running', total: samples.length, done: 0, success: 0, failed: 0,
    started_at: nowIso(), updated_at: nowIso(), message: '准备中', current: '',
  };
  runJobs.set(runId, job);

  // 后台异步执行，不阻塞请求。
  (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const predPath = path.join(dir, 'predictions.jsonl');
    const stream = fs.createWriteStream(predPath, { flags: 'a' });
    const predictions = [];
    for (const s of samples) {
      job.current = s.sample_id;
      const { raw, pred, error } = await callModel(modelCfg, s.sample_id);
      const rec = {
        sample_id: s.sample_id,
        object_category: s.object_category,
        gt_label: s.label || '',
        gt_human_result: s.human_result || '',
        pred_label: pred,
        raw_output: raw,
        correct: (s.label === 'G' || s.label === 'N') ? (s.label === pred) : null,
        error: error || '',
      };
      predictions.push(rec);
      stream.write(JSON.stringify(rec) + '\n');
      job.done += 1;
      if (error) job.failed += 1; else job.success += 1;
      job.updated_at = nowIso();
      job.message = `已跑 ${job.done}/${job.total}`;
    }
    stream.end();

    const metrics = computeAllMetrics(predictions);
    const meta = {
      run_id: runId, bm_id: bmId, model_key: modelKey,
      model: modelCfg.model, endpoint: modelCfg.endpoint, prompt_version: modelCfg.prompt_version || '',
      created_at: job.started_at, finished_at: nowIso(),
      total: samples.length, success: job.success, failed: job.failed,
      metrics,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    job.status = 'completed';
    job.finished_at = meta.finished_at;
    job.message = `完成：${job.success} 成功 / ${job.failed} 失败`;
    job.metrics = metrics;
  })().catch((error) => {
    job.status = 'failed';
    job.message = `运行出错：${error.message || error}`;
    job.updated_at = nowIso();
  });

  return { ok: true, run_id: runId };
}

function getRunStatus(runId) {
  const job = runJobs.get(runId);
  if (job) return { ok: true, job };
  // 已结束、内存里没有了就读磁盘 meta。
  const metaPath = path.join(RUNS_DIR, sanitize(runId), 'meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ok: true, job: { ...meta, status: 'completed', done: meta.total } };
  }
  return { ok: false, message: 'run 不存在' };
}

function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return { ok: true, runs: [] };
  const runs = [];
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const metaPath = path.join(RUNS_DIR, name, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try { runs.push(JSON.parse(fs.readFileSync(metaPath, 'utf8'))); } catch (e) { /* skip */ }
    } else if (runJobs.has(name)) {
      runs.push(runJobs.get(name));
    }
  }
  runs.sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? 1 : -1));
  return { ok: true, runs };
}

function getRunDetail(runId) {
  const id = sanitize(runId);
  const dir = path.join(RUNS_DIR, id);
  const metaPath = path.join(dir, 'meta.json');
  const predPath = path.join(dir, 'predictions.jsonl');
  if (!fs.existsSync(metaPath)) return { ok: false, message: 'run 不存在或未完成' };
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const predictions = fs.existsSync(predPath)
    ? fs.readFileSync(predPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { ok: true, meta, predictions };
}

// 删除一次 run（仅删 eval_registry/runs/<run_id>/，不动原图、标注与 BM 快照）。
function deleteRun(runId) {
  const id = sanitize(runId);
  if (!id) return { ok: false, message: '缺少 run_id' };
  const dir = path.join(RUNS_DIR, id);
  const resolved = path.resolve(dir);
  const runsResolved = path.resolve(RUNS_DIR);
  if (!resolved.startsWith(runsResolved + path.sep)) {
    return { ok: false, message: '路径非法' };
  }
  const job = runJobs.get(id);
  if (job && job.status === 'running') {
    return { ok: false, message: 'run 仍在运行中，请等完成后再删除' };
  }
  runJobs.delete(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  } else if (!job) {
    return { ok: false, message: 'run 不存在' };
  }
  return { ok: true, run_id: id };
}

module.exports = {
  listModels,
  loadModels,
  getModel,
  buildEndpointFromHostPort,
  applyEndpointOverride,
  effectiveModelKey,
  callModel,
  startRun,
  getRunStatus,
  listRuns,
  getRunDetail,
  deleteRun,
  computeAllMetrics,
  parsePrediction,
  RUNS_DIR,
};
