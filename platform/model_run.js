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

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

function resolveConcurrency(opts = {}) {
  const n = parseInt(opts.concurrency ?? process.env.MODEL_RUN_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10);
  return Math.max(1, Math.min(MAX_CONCURRENCY, Number.isFinite(n) ? n : DEFAULT_CONCURRENCY));
}

// 串行化 WriteStream 写入，避免并发时 jsonl 行交错。
function chainStreamWrite(stream, chunk) {
  const prev = stream._writeChain || Promise.resolve();
  stream._writeChain = prev.then(() => new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  }));
  return stream._writeChain;
}

function buildPredictionRecord(sample, { raw, pred, error }) {
  return {
    sample_id: sample.sample_id,
    object_category: sample.object_category,
    gt_label: sample.label || '',
    gt_human_result: sample.human_result || '',
    pred_label: pred,
    raw_output: raw,
    correct: (sample.label === 'G' || sample.label === 'N') ? (sample.label === pred) : null,
    error: error || '',
  };
}

// 用固定并发数跑样本列表；cancelRequested 时不再领取新样本，已在飞的请求会跑完。
async function runSamplesConcurrent(samples, modelCfg, job, onRecord) {
  const concurrency = resolveConcurrency(job);
  job.concurrency = concurrency;
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, samples.length) }, async () => {
    while (true) {
      if (job.cancelRequested) return;
      const i = nextIndex;
      nextIndex += 1;
      if (i >= samples.length) return;
      const sample = samples[i];
      job.current = sample.sample_id;
      const result = await callModel(modelCfg, sample.sample_id);
      if (job.cancelRequested) return;
      const rec = buildPredictionRecord(sample, result);
      await onRecord(rec);
      job.done += 1;
      if (result.error) job.failed += 1; else job.success += 1;
      job.updated_at = nowIso();
      job.message = job.retry
        ? `重跑 ${job.done}/${job.total}`
        : `已跑 ${job.done}/${job.total}`;
    }
  });

  await Promise.all(workers);
}

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
    // 网络/连接层失败，区别于下方「无法识别输出」的解析失败：多为远端推理服务挂了/重启/过载，不是模型识别问题。
    const code = (error && error.cause && error.cause.code) || (error && error.code) || '';
    const netHints = {
      ECONNRESET: '远端重置了连接（端口在监听但推理服务异常/重启/过载）',
      ECONNREFUSED: '远端拒绝连接（端口未监听，服务可能没启动）',
      ETIMEDOUT: '连接超时（服务无响应或网络不通）',
      UND_ERR_CONNECT_TIMEOUT: '连接超时（服务无响应或网络不通）',
      ENOTFOUND: '主机无法解析（地址写错或 DNS 不通）',
      EHOSTUNREACH: '主机不可达（网络/路由问题）',
    };
    const hint = netHints[code] || (error && error.message) || '网络请求失败';
    return { raw: '', pred: 'Unknown', error: `模型服务连接失败：${hint}${code ? `（${code}）` : ''} —— 非模型识别问题，请检查推理服务 ${modelCfg.endpoint}` };
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
  const concurrency = resolveConcurrency(opts);
  const job = {
    run_id: runId, bm_id: bmId, model_key: modelKey, model: modelCfg.model,
    status: 'running', total: samples.length, done: 0, success: 0, failed: 0,
    concurrency,
    started_at: nowIso(), updated_at: nowIso(),
    message: `准备中（并发 ${concurrency}）`, current: '',
  };
  runJobs.set(runId, job);

  // 后台异步执行，不阻塞请求。
  (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const predPath = path.join(dir, 'predictions.jsonl');
    const stream = fs.createWriteStream(predPath, { flags: 'a' });
    const predictions = [];
    await runSamplesConcurrent(samples, modelCfg, job, async (rec) => {
      predictions.push(rec);
      await chainStreamWrite(stream, JSON.stringify(rec) + '\n');
    });
    if (job.cancelRequested) job.cancelled = true;
    await (stream._writeChain || Promise.resolve());
    stream.end();

    const cancelled = !!job.cancelled;
    const metrics = computeAllMetrics(predictions);
    const meta = {
      run_id: runId, bm_id: bmId, model_key: modelKey,
      model: modelCfg.model, endpoint: modelCfg.endpoint, prompt_version: modelCfg.prompt_version || '',
      concurrency: job.concurrency || concurrency,
      created_at: job.started_at, finished_at: nowIso(),
      // 中途停止时只统计已实际跑过的样本；planned_total 记录原计划张数。
      total: cancelled ? predictions.length : samples.length,
      planned_total: samples.length,
      success: job.success, failed: job.failed,
      cancelled,
      status: cancelled ? 'cancelled' : 'completed',
      metrics,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    job.status = cancelled ? 'cancelled' : 'completed';
    job.finished_at = meta.finished_at;
    job.message = cancelled
      ? `已停止：已跑 ${predictions.length}/${samples.length}（成功 ${job.success} / 失败 ${job.failed}）`
      : `完成：${job.success} 成功 / ${job.failed} 失败`;
    job.metrics = metrics;
  })().catch((error) => {
    job.status = 'failed';
    job.message = `运行出错：${error.message || error}`;
    job.updated_at = nowIso();
  });

  return { ok: true, run_id: runId };
}

// 只重跑某次 run 里「失败 / 无法识别」的样本，把新结果合并回原 run。
// 失败定义：有 error，或 pred_label === 'Unknown'（多为调用时网络抖动 fetch failed）。
// 只覆盖这些样本的预测，其余已正确的结果原样保留；完成后重写 predictions.jsonl 与 meta.json。
// 不动原图、标注与 BM 快照。
function retryRun(runId) {
  const id = sanitize(runId);
  if (!id) return { ok: false, message: '缺少 run_id' };
  const dir = path.join(RUNS_DIR, id);
  const metaPath = path.join(dir, 'meta.json');
  const predPath = path.join(dir, 'predictions.jsonl');
  if (!fs.existsSync(metaPath) || !fs.existsSync(predPath)) {
    return { ok: false, message: 'run 不存在或未完成' };
  }
  const existing = runJobs.get(id);
  if (existing && existing.status === 'running') {
    return { ok: false, message: 'run 正在运行/重跑中，请稍后再试' };
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const predictions = fs.readFileSync(predPath, 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const retryIdx = [];
  predictions.forEach((p, i) => {
    if ((p.error && String(p.error).length) || p.pred_label === 'Unknown') retryIdx.push(i);
  });
  if (!retryIdx.length) return { ok: false, message: '本次 run 没有失败/无法识别的样本' };

  // 复原当时用的模型配置：以注册表为基础，用 meta 里的 endpoint/model 覆盖，保证与原 run 一致。
  const base = getModel(meta.model_key) || {};
  const modelCfg = Object.assign({}, base, {
    model: meta.model || base.model,
    endpoint: meta.endpoint || base.endpoint,
    prompt_version: meta.prompt_version || base.prompt_version,
  });
  if (!modelCfg.endpoint) {
    return { ok: false, message: '无法确定模型 endpoint（models.json 缺该模型且 meta 无 endpoint）' };
  }

  const concurrency = resolveConcurrency({ concurrency: meta.concurrency });
  const job = {
    run_id: id, bm_id: meta.bm_id, model_key: meta.model_key, model: modelCfg.model,
    status: 'running', total: retryIdx.length, done: 0, success: 0, failed: 0,
    concurrency,
    started_at: nowIso(), updated_at: nowIso(),
    message: `重跑失败样本中（并发 ${concurrency}）`, current: '', retry: true,
  };
  runJobs.set(id, job);

  (async () => {
    const indexBySid = new Map(retryIdx.map((i) => [predictions[i].sample_id, i]));
    const retrySamples = retryIdx.map((i) => {
      const p = predictions[i];
      return {
        sample_id: p.sample_id,
        object_category: p.object_category,
        label: p.gt_label,
        human_result: p.gt_human_result,
      };
    });
    await runSamplesConcurrent(retrySamples, modelCfg, job, async (rec) => {
      const idx = indexBySid.get(rec.sample_id);
      if (idx === undefined) return;
      const p = predictions[idx];
      predictions[idx] = Object.assign({}, p, {
        pred_label: rec.pred_label,
        raw_output: rec.raw_output,
        correct: rec.correct,
        error: rec.error,
      });
    });

    fs.writeFileSync(predPath, predictions.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');

    const totalFailed = predictions.filter((p) => p.error && String(p.error).length).length;
    const totalSuccess = predictions.length - totalFailed;
    const metrics = computeAllMetrics(predictions);
    const newMeta = Object.assign({}, meta, {
      total: predictions.length, success: totalSuccess, failed: totalFailed,
      metrics, retried_at: nowIso(),
    });
    fs.writeFileSync(metaPath, JSON.stringify(newMeta, null, 2), 'utf8');

    job.status = 'completed';
    job.finished_at = nowIso();
    job.message = `重跑完成：本次成功 ${job.success} / 仍失败 ${job.failed}（剩余失败 ${totalFailed}）`;
    job.metrics = metrics;
  })().catch((error) => {
    job.status = 'failed';
    job.message = `重跑出错：${error.message || error}`;
    job.updated_at = nowIso();
  });

  return { ok: true, run_id: id, retry_count: retryIdx.length };
}

// 请求停止一次正在运行的 run：只置标志位，循环会在下一张前自然收尾并落盘。
function cancelRun(runId) {
  const id = sanitize(runId);
  const job = runJobs.get(id);
  if (!job) return { ok: false, message: 'run 不存在或已结束' };
  if (job.status !== 'running') return { ok: false, message: `run 当前状态：${job.status}，无法停止` };
  job.cancelRequested = true;
  job.message = '正在停止…';
  return { ok: true, run_id: id };
}

function getRunStatus(runId) {
  const job = runJobs.get(runId);
  if (job) return { ok: true, job };
  // 已结束、内存里没有了就读磁盘 meta。
  const metaPath = path.join(RUNS_DIR, sanitize(runId), 'meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ok: true, job: { ...meta, status: meta.status || 'completed', done: meta.total } };
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

// 同步某基准下所有已完成 run 的人工真值（gt）：按 gtMap（sample_id -> {label, human_result}）
// 更新每条预测的 gt_label / gt_human_result，重算 correct 与指标。pred 不变。
// 只改 gt 有变化的 run；每个被改的 run 先备份 predictions.jsonl / meta.json 到 _backups。
// 不新增/删除样本，不动原图与标注。
function resyncRunsGt(bmId, gtMap, backupRoot) {
  if (!fs.existsSync(RUNS_DIR)) return { updated: [] };
  const updated = [];
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const dir = path.join(RUNS_DIR, name);
    const metaPath = path.join(dir, 'meta.json');
    const predPath = path.join(dir, 'predictions.jsonl');
    if (!fs.existsSync(metaPath) || !fs.existsSync(predPath)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { continue; }
    if (meta.bm_id !== bmId) continue;

    const lines = fs.readFileSync(predPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length);
    let changed = 0;
    const predictions = lines.map((l) => JSON.parse(l));
    for (const p of predictions) {
      const gt = gtMap[p.sample_id];
      if (!gt) continue;
      const newLabel = gt.label || '';
      const newHuman = gt.human_result || '';
      if (p.gt_label !== newLabel || p.gt_human_result !== newHuman) {
        p.gt_label = newLabel;
        p.gt_human_result = newHuman;
        p.correct = (newLabel === 'G' || newLabel === 'N') ? (newLabel === p.pred_label) : null;
        changed += 1;
      }
    }
    if (!changed) continue;

    if (backupRoot) {
      const bdir = path.join(backupRoot, 'runs', name);
      fs.mkdirSync(bdir, { recursive: true });
      fs.copyFileSync(predPath, path.join(bdir, 'predictions.jsonl'));
      fs.copyFileSync(metaPath, path.join(bdir, 'meta.json'));
    }
    const metrics = computeAllMetrics(predictions);
    meta.metrics = metrics;
    meta.last_resync = { at: nowIso(), gt_changed: changed };
    fs.writeFileSync(predPath, predictions.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    updated.push({ run_id: name, gt_changed: changed, accuracy: metrics.overall.accuracy });
  }
  return { updated };
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
  retryRun,
  cancelRun,
  getRunStatus,
  listRuns,
  getRunDetail,
  deleteRun,
  computeAllMetrics,
  resyncRunsGt,
  parsePrediction,
  RUNS_DIR,
};
