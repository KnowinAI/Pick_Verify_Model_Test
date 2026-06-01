const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 5034);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;
const SOURCE_BASE_URL = process.env.SOURCE_BASE_URL || 'http://101.132.143.105:5022';
const REALTIME_BASE_URL = process.env.REALTIME_BASE_URL || 'http://192.168.78.168:5033';
const USE_SOURCE_5022 = process.env.USE_SOURCE_5022 === '1';
const VLM_ENDPOINT = process.env.VLM_CHAT_COMPLETIONS_URL
  || process.env.VLM_ENDPOINT
  || 'http://101.132.143.105:5087/v1/chat/completions';
const VLM_MODEL = process.env.VLM_MODEL || 'pick_verifier_1200_merged';
const DATA_PATH = path.join(__dirname, 'gripper_eval_data.json');
const HTML_PATH = path.join(__dirname, 'gripper_eval.html');
const LOCAL_IMAGE_DIR = path.join(__dirname, 'local_images');
const DEFAULT_RECORD_LIMIT = 5000;
const MAX_RECORD_LIMIT = 20000;
const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const PROMPT = `判断机器人夹爪的状态。只能从下面四个中文选项中选择一个输出：
闭合，已夹住：夹爪闭合，并且当前夹住了物体。
闭合，未夹住：夹爪闭合，但没有夹住物体。
张开，未夹住：夹爪张开，并且没有夹住物体。
无法判断：图片证据不足，无法确定夹爪状态。
只输出中文选项本身，不要输出解释。`;

const LETTER_TO_STATUS = {
  A: 'Closed_Empty',
  B: 'Closed_Grasped',
  C: 'Opened_Empty',
};

const STATUS_TO_CN = {
  Closed_Empty: '闭合，未夹住',
  Closed_Grasped: '闭合，已夹住',
  Opened_Empty: '张开，未夹住',
  Unknown: '无法判断',
};

const CN_TO_STATUS = {
  '未夹住（闭合）': 'Closed_Empty',
  '夹住（闭合）': 'Closed_Grasped',
  '未夹住（张开）': 'Opened_Empty',
  '闭合，未夹住': 'Closed_Empty',
  '闭合，已夹住': 'Closed_Grasped',
  '张开，未夹住': 'Opened_Empty',
  无法判断: 'Unknown',
  闭合空夹: 'Closed_Empty',
  已夹住物体: 'Closed_Grasped',
  张开空夹: 'Opened_Empty',
};

const autoVlmJob = {
  running: false,
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  current: '',
  message: '未启动',
  started_at: null,
  finished_at: null,
};

function defaultData() {
  return {
    version: 1,
    records: {},
  };
}

function readData() {
  if (!fs.existsSync(DATA_PATH)) {
    return defaultData();
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return defaultData();
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function ensureLocalImageDir() {
  if (!fs.existsSync(LOCAL_IMAGE_DIR)) {
    fs.mkdirSync(LOCAL_IMAGE_DIR, { recursive: true });
  }
}

function normalizeLimit(value, fallback = DEFAULT_RECORD_LIMIT) {
  if (String(value || '').toLowerCase() === 'all') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_RECORD_LIMIT);
}

function applyRecordLimit(records, limit) {
  return limit === null ? records : records.slice(0, limit);
}

function getImageContentType(filename) {
  return IMAGE_CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function makeLocalFileRecordId(filename) {
  const baseName = path.basename(filename, path.extname(filename)).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image';
  const hash = crypto.createHash('sha1').update(filename).digest('hex').slice(0, 12);
  return `local_file_${hash}_${baseName}`;
}

function getRecordFilename(record) {
  const source = record && record.local_source;
  return source && (source.stored_filename || source.original_filename || source.source_id);
}

function parseRealtimeFilename(filename) {
  const match = /^realtime_cam([01])_(\d{14})_[^.]+\.(?:jpe?g|png|webp|gif)$/i.exec(filename);
  if (!match) return null;
  return {
    cameraId: Number(match[1]),
    timestamp: match[2],
  };
}

function updateRealtimePairMetadata(data) {
  const groups = new Map();
  for (const [id, record] of Object.entries(data.records || {})) {
    if (!record || record.deleted || !record.local_source) continue;
    const parsed = parseRealtimeFilename(getRecordFilename(record) || '');
    if (!parsed) continue;
    if (!groups.has(parsed.timestamp)) groups.set(parsed.timestamp, []);
    groups.get(parsed.timestamp).push({ id, record, ...parsed });
  }

  let updated = 0;
  for (const [timestamp, items] of groups.entries()) {
    const cam0 = items.find((item) => item.cameraId === 0);
    const cam1 = items.find((item) => item.cameraId === 1);
    if (!cam0 || !cam1) continue;
    const captureGroupId = cam0.record.local_source.source_metadata?.capture_group_id
      || cam1.record.local_source.source_metadata?.capture_group_id
      || `realtime_group_${timestamp}`;
    const pairIds = items.map((item) => item.id);
    for (const item of [cam0, cam1]) {
      const paired = item.cameraId === 0 ? cam1 : cam0;
      const source = item.record.local_source;
      const metadata = source.source_metadata || {};
      const nextMetadata = {
        ...metadata,
        camera_id: item.cameraId,
        camera_label: item.cameraId === 1 ? 'left' : 'right',
        source: metadata.source || '9002_snapshot',
        capture_group_id: captureGroupId,
        group_record_ids: pairIds,
        paired_record_id: paired.id,
        evaluate: item.cameraId === 1,
        group_role: item.cameraId === 1 ? 'evaluation' : 'reference',
      };
      if (JSON.stringify(metadata) !== JSON.stringify(nextMetadata)) {
        source.source_metadata = nextMetadata;
        item.record.updated_at = new Date().toISOString();
        updated += 1;
      }
    }
  }
  return updated;
}

function syncLocalImagesToData(data = readData()) {
  ensureLocalImageDir();
  data.records = data.records || {};

  let added = 0;
  let restored = 0;
  let removedDuplicates = 0;
  const files = fs.readdirSync(LOCAL_IMAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_CONTENT_TYPES[path.extname(entry.name).toLowerCase()])
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const fileSet = new Set(files);
  const recordsByFilename = new Map();

  for (const [id, record] of Object.entries(data.records)) {
    const filename = getRecordFilename(record);
    if (!filename || !fileSet.has(filename)) continue;
    if (!recordsByFilename.has(filename)) recordsByFilename.set(filename, []);
    recordsByFilename.get(filename).push([id, record]);
  }

  for (const [filename, entries] of recordsByFilename.entries()) {
    const canonical = entries.find(([, record]) => record.local_source?.source_metadata?.source !== 'local_images_scan')
      || entries[0];
    const [canonicalId, canonicalRecord] = canonical;
    if (canonicalRecord.deleted) {
      delete canonicalRecord.deleted;
      delete canonicalRecord.deleted_at;
      canonicalRecord.restored_at = new Date().toISOString();
      canonicalRecord.updated_at = new Date().toISOString();
      restored += 1;
    }
    for (const [id, record] of entries) {
      if (id === canonicalId) continue;
      if (record.local_source?.source_metadata?.source === 'local_images_scan') {
        delete data.records[id];
        removedDuplicates += 1;
      }
    }
  }

  const knownFilenames = new Set(
    Object.values(data.records)
      .filter((record) => record && !record.deleted)
      .map(getRecordFilename)
      .filter(Boolean),
  );

  for (const filename of files) {
    if (knownFilenames.has(filename)) continue;
    let id = makeLocalFileRecordId(filename);
    let suffix = 1;
    while (data.records[id]) {
      id = `${makeLocalFileRecordId(filename)}_${suffix}`;
      suffix += 1;
    }
    const stat = fs.statSync(path.join(LOCAL_IMAGE_DIR, filename));
    const localSource = makeLocalSourceRecord({
      id,
      filename,
      contentType: getImageContentType(filename),
      createdAt: stat.mtime.toISOString(),
      source: 'local_images_scan',
    });
    data.records[id] = {
      local_source: localSource,
      updated_at: new Date().toISOString(),
    };
    knownFilenames.add(filename);
    added += 1;
  }
  const paired = updateRealtimePairMetadata(data);

  if (added || restored || removedDuplicates || paired) {
    writeData(data);
  }
  return data;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  if (text) {
    data = JSON.parse(text);
  }
  if (!response.ok) {
    throw new Error(data.detail || data.message || `HTTP ${response.status}`);
  }
  return data;
}

async function listSourceReviews(limit = 200) {
  if (!USE_SOURCE_5022) return [];
  const data = await fetchJson(`${SOURCE_BASE_URL}/api/reviews?limit=${encodeURIComponent(limit)}`);
  return Array.isArray(data.items) ? data.items : [];
}

async function getSourceReview(id) {
  if (!USE_SOURCE_5022) {
    throw new Error('5022 源服务已禁用');
  }
  return fetchJson(`${SOURCE_BASE_URL}/api/reviews/${encodeURIComponent(id)}`);
}

function getImageUrl(review) {
  if (!review.image_url) return null;
  if (review.image_url.startsWith('http')) return review.image_url;
  if (review.image_url.startsWith('/api/local-images/')) return `${APP_BASE_URL}${review.image_url}`;
  return `${SOURCE_BASE_URL}${review.image_url}`;
}

function mapVlmToModelResult(status) {
  if (status === 'Closed_Grasped') return 'grasped';
  if (status === 'Closed_Empty' || status === 'Opened_Empty') return 'not_grasped';
  return 'no_result';
}

function getCameraId(record) {
  const cameraId = record && record.source_metadata && record.source_metadata.camera_id;
  return cameraId === null || cameraId === undefined || cameraId === '' ? null : Number(cameraId);
}

function participatesInEvaluation(record) {
  const metadata = (record && record.source_metadata) || {};
  if (metadata.evaluate === false) return false;
  if (metadata.source === '9002_snapshot') return getCameraId(record) === 1;
  return true;
}

function parseVlmOutput(rawOutput) {
  const text = String(rawOutput || '').trim();
  for (const [label, status] of Object.entries(CN_TO_STATUS)) {
    if (text.includes(label)) {
      return { predictedStatus: status, predictedStatusCn: label };
    }
  }

  const letter = text.toUpperCase().slice(0, 1);
  const predictedStatus = LETTER_TO_STATUS[letter] || 'Unknown';
  return {
    predictedStatus,
    predictedStatusCn: STATUS_TO_CN[predictedStatus] || '未知',
  };
}

function classify(record) {
  if (!participatesInEvaluation(record)) return '参考图像';
  const human = record.annotation && record.annotation.human_result;
  const model = record.model_result || (record.vlm && record.vlm.model_result);
  const validity = record.annotation && record.annotation.sample_validity;
  const modelStatus = (record.vlm && record.vlm.predicted_status) || record.predicted_status || '';

  if (validity === 'invalid') return '无效样本';
  if (!human || human === 'not_grasped') return '待人工标注';
  if (human === 'unknown') return '无法判断';
  if (!model || model === 'no_result') return 'VLM 调用失败';
  const humanStatus = human === 'grasped'
    ? 'Closed_Grasped'
    : human === 'closed_not_grasped'
      ? 'Closed_Empty'
      : human === 'open_not_grasped'
        ? 'Opened_Empty'
        : '';
  if (humanStatus && modelStatus && humanStatus === modelStatus) {
    return humanStatus === 'Closed_Grasped' ? '正确识别夹住' : '正确识别未夹住';
  }
  const humanBinary = humanStatus === 'Closed_Grasped' ? 'grasped' : 'not_grasped';
  if (humanBinary === 'grasped' && model === 'grasped') return '正确识别夹住';
  if (humanBinary === 'grasped' && model === 'not_grasped') return '漏判';
  if (humanBinary === 'not_grasped' && model === 'grasped') return '误判';
  if (humanBinary === 'not_grasped' && model === 'not_grasped') return '正确识别未夹住';
  return '待人工标注';
}

function mergeRecord(source, local) {
  const vlm = local.vlm || {};
  const annotation = local.annotation || {};
  const modelResult = vlm.model_result || mapVlmToModelResult(source.predicted_status) || annotation.model_result;
  const evalRecord = {
    ...source,
    vlm,
    annotation,
    model_result: modelResult,
  };
  return {
    ...source,
    local_updated_at: local.updated_at || null,
    vlm,
    annotation,
    model_result: modelResult,
    eval_classification: classify(evalRecord),
    participates_in_evaluation: participatesInEvaluation(evalRecord),
  };
}

function listLocalOnlyRecords(data) {
  return Object.entries(data.records || {})
    .filter(([, local]) => local && local.local_source && !local.deleted)
    .map(([, local]) => mergeRecord(local.local_source, local));
}

function sortNewestFirst(records) {
  return records.sort((a, b) => {
    const aEval = participatesInEvaluation(a) ? 1 : 0;
    const bEval = participatesInEvaluation(b) ? 1 : 0;
    if (aEval !== bEval) return bEval - aEval;
    const aTime = new Date(a.created_at || a.local_updated_at || 0).getTime() || 0;
    const bTime = new Date(b.created_at || b.local_updated_at || 0).getTime() || 0;
    return bTime - aTime;
  });
}

function makeLocalSourceRecord({
  id,
  filename,
  contentType,
  cameraId = null,
  cameraLabel = 'upload',
  createdAt = new Date().toISOString(),
  source = 'local_upload',
}) {
  return {
    id,
    source_id: filename,
    original_filename: filename,
    stored_filename: filename,
    image_url: `/api/local-images/${encodeURIComponent(filename)}`,
    content_type: contentType || 'image/jpeg',
    created_at: createdAt,
    source_metadata: {
      camera_id: cameraId,
      camera_label: cameraLabel,
      source,
    },
    vlm_status: 'pending',
    predicted_status: null,
    review_path: '',
  };
}

async function getMergedRecords(limit) {
  const data = syncLocalImagesToData(readData());
  const normalizedLimit = normalizeLimit(limit);
  if (!USE_SOURCE_5022) {
    return applyRecordLimit(sortNewestFirst(listLocalOnlyRecords(data)), normalizedLimit);
  }
  try {
    const sourceItems = await listSourceReviews(normalizedLimit || MAX_RECORD_LIMIT);
    const mergedSource = sourceItems
      .filter((item) => !(data.records[item.id] && data.records[item.id].deleted))
      .map((item) => mergeRecord(item, data.records[item.id] || {}));
    const sourceIds = new Set(sourceItems.map((item) => item.id));
    const localOnly = listLocalOnlyRecords(data)
      .filter((record) => !sourceIds.has(record.id));
    return applyRecordLimit(sortNewestFirst([...localOnly, ...mergedSource]), normalizedLimit);
  } catch {
    return applyRecordLimit(sortNewestFirst(listLocalOnlyRecords(data)), normalizedLimit);
  }
}

function summarize(records) {
  const evaluationRecords = records.filter(participatesInEvaluation);
  const summary = {
    total: 0,
    evaluationTotal: evaluationRecords.length,
    savedTotal: records.length,
    referenceTotal: records.length - evaluationRecords.length,
    labeled: 0,
    pending: 0,
    valid: 0,
    vlmCompleted: 0,
    vlmFailed: 0,
    evaluable: 0,
    categories: {
      正确识别夹住: 0,
      漏判: 0,
      误判: 0,
      正确识别未夹住: 0,
      'VLM 调用失败': 0,
      待人工标注: 0,
      无效样本: 0,
      无法判断: 0,
    },
    attribution: {},
  };

  for (const record of evaluationRecords) {
    const annotation = record.annotation || {};
    const category = record.eval_classification || '待人工标注';
    summary.categories[category] = (summary.categories[category] || 0) + 1;
    if (annotation.human_result) summary.labeled += 1;
    if (!annotation.human_result) summary.pending += 1;
    if (annotation.sample_validity === 'valid') summary.valid += 1;
    if (record.vlm && record.vlm.status === 'completed') summary.vlmCompleted += 1;
    if ((record.vlm && record.vlm.status === 'failed') || record.vlm_status === 'failed') summary.vlmFailed += 1;
    if (['正确识别夹住', '漏判', '误判', '正确识别未夹住'].includes(category)) {
      summary.evaluable += 1;
    }
    if (annotation.attribution_branch) {
      summary.attribution[annotation.attribution_branch] = (summary.attribution[annotation.attribution_branch] || 0) + 1;
    }
  }

  const tp = summary.categories['正确识别夹住'] || 0;
  const fn = summary.categories['漏判'] || 0;
  const fp = summary.categories['误判'] || 0;
  const tn = summary.categories['正确识别未夹住'] || 0;
  const correct = tp + tn;
  summary.total = tp + fn + fp + tn;
  summary.evaluable = summary.total;

  summary.accuracy = summary.evaluable ? correct / summary.evaluable : null;
  summary.recall = tp + fn ? tp / (tp + fn) : null;
  summary.precision = tp + fp ? tp / (tp + fp) : null;
  summary.missRate = tp + fn ? fn / (tp + fn) : null;
  summary.falseAlarmRate = fp + tn ? fp / (fp + tn) : null;
  summary.labelCoverage = summary.evaluationTotal ? summary.labeled / summary.evaluationTotal : null;

  return summary;
}

async function runVlm(reviewId) {
  const local = readData().records[reviewId] || {};
  const source = local.local_source || await getSourceReview(reviewId);
  const imageUrl = getImageUrl(source);
  if (!imageUrl) {
    throw new Error('缺少图片地址');
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`下载图片失败：HTTP ${imageResponse.status}`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const imageBase64 = imageBuffer.toString('base64');

  const payload = {
    model: VLM_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${source.content_type || 'image/jpeg'};base64,${imageBase64}`,
            },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
    max_tokens: 16,
    temperature: 0,
  };

  const response = await fetch(VLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.VLM_API_KEY ? { Authorization: `Bearer ${process.env.VLM_API_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.detail || result.message || `VLM HTTP ${response.status}`);
  }

  const rawOutput = String(result.choices?.[0]?.message?.content || '').trim();
  const { predictedStatus, predictedStatusCn } = parseVlmOutput(rawOutput);
  return {
    status: predictedStatus === 'Unknown' ? 'failed' : 'completed',
    model: VLM_MODEL,
    endpoint: VLM_ENDPOINT,
    prompt_version: 'gripper_cn_v1',
    predicted_status: predictedStatus,
    predicted_status_cn: predictedStatusCn,
    model_result: mapVlmToModelResult(predictedStatus),
    raw_model_output: rawOutput,
    raw_response: result,
    updated_at: new Date().toISOString(),
  };
}

async function fetchRealtimeImage(cam) {
  const candidates = [
    `${REALTIME_BASE_URL}/api/realtime-proxy/frame?camera=${encodeURIComponent(cam)}&t=${Date.now()}`,
    `${REALTIME_BASE_URL}/snapshot?cam=${encodeURIComponent(cam)}&t=${Date.now()}`,
    `${REALTIME_BASE_URL}/frame?camera=${encodeURIComponent(cam)}&t=${Date.now()}`,
  ];
  let lastError = '';
  for (const imageUrl of candidates) {
    try {
      const response = await fetch(imageUrl);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  throw new Error(`cam${cam} 抓图失败：${lastError || '无可用实时图像接口'}`);
}

async function captureRealtimeSnapshot(cam, captureGroupId) {
  const response = await fetchRealtimeImage(cam);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const buffer = Buffer.from(await response.arrayBuffer());
  ensureLocalImageDir();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const filename = `realtime_cam${cam}_${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = path.join(LOCAL_IMAGE_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return {
    filename,
    contentType,
    cam,
    captureGroupId,
    image_url: `/api/local-images/${encodeURIComponent(filename)}`,
  };
}

function upsertLocalRealtimeRecord(snapshot) {
  const id = `local_${snapshot.filename.replace(/\.[^.]+$/, '')}`;
  const cameraId = Number(snapshot.cam);
  const cameraLabel = cameraId === 1 ? 'left' : cameraId === 0 ? 'right' : String(cameraId);
  const localSource = makeLocalSourceRecord({
    id,
    filename: snapshot.filename,
    contentType: snapshot.contentType,
    cameraId,
    cameraLabel,
  });
  localSource.source_metadata.source = '9002_snapshot';
  localSource.source_metadata.capture_group_id = snapshot.captureGroupId;
  localSource.source_metadata.evaluate = cameraId === 1;
  localSource.source_metadata.group_role = cameraId === 1 ? 'evaluation' : 'reference';
  const local = upsertLocalRecord(id, { local_source: localSource });
  return mergeRecord(localSource, local);
}

function linkRealtimeGroup(records) {
  const ids = records.map((record) => record.id);
  for (const record of records) {
    const local = readData().records[record.id];
    if (!local || !local.local_source) continue;
    const cameraId = getCameraId(local.local_source);
    const paired = records.find((item) => getCameraId(item) !== cameraId);
    const localSource = {
      ...local.local_source,
      source_metadata: {
        ...(local.local_source.source_metadata || {}),
        group_record_ids: ids,
        paired_record_id: paired ? paired.id : '',
      },
    };
    upsertLocalRecord(record.id, { local_source: localSource });
  }
}

async function runVlmAndPersist(reviewId) {
  try {
    const vlm = await runVlm(reviewId);
    const updated = upsertLocalRecord(reviewId, { vlm });
    return { ok: true, vlm: updated.vlm };
  } catch (error) {
    const vlm = {
      status: 'failed',
      error: error.message || String(error),
      updated_at: new Date().toISOString(),
    };
    upsertLocalRecord(reviewId, { vlm });
    return { ok: false, vlm };
  }
}

function triggerVlmInBackground(reviewId) {
  void runVlmAndPersist(reviewId);
}

function upsertLocalRecord(reviewId, patch) {
  const data = readData();
  const current = data.records[reviewId] || {};
  data.records[reviewId] = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeData(data);
  return data.records[reviewId];
}

function getLocalGroupRecordIds(data, reviewId) {
  const record = data.records[reviewId];
  if (!record || !record.local_source) return [reviewId];

  const metadata = record.local_source.source_metadata || {};
  const ids = new Set([reviewId]);
  if (Array.isArray(metadata.group_record_ids)) {
    metadata.group_record_ids.forEach((id) => ids.add(id));
  }
  if (metadata.paired_record_id) {
    ids.add(metadata.paired_record_id);
  }
  if (metadata.capture_group_id) {
    for (const [id, item] of Object.entries(data.records || {})) {
      if (item && item.local_source && item.local_source.source_metadata?.capture_group_id === metadata.capture_group_id) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids).filter((id) => data.records[id]);
}

function deleteLocalImageFile(record) {
  const filename = getRecordFilename(record);
  if (!filename) return { deleted: false, missing: '' };
  const filePath = path.join(LOCAL_IMAGE_DIR, path.basename(filename));
  if (!filePath.startsWith(LOCAL_IMAGE_DIR)) return { deleted: false, missing: filename };
  if (!fs.existsSync(filePath)) return { deleted: false, missing: filename };
  fs.unlinkSync(filePath);
  return { deleted: true, missing: '' };
}

function deleteRecordGroupAndLocalFiles(reviewId) {
  const data = readData();
  data.records = data.records || {};
  if (!data.records[reviewId]) {
    data.records[reviewId] = {};
  }
  const ids = getLocalGroupRecordIds(data, reviewId);
  const now = new Date().toISOString();
  const deletedFiles = [];
  const missingFiles = [];

  for (const id of ids) {
    const record = data.records[id];
    if (!record) continue;
    if (record.local_source) {
      const fileResult = deleteLocalImageFile(record);
      if (fileResult.deleted) deletedFiles.push(getRecordFilename(record));
      if (fileResult.missing) missingFiles.push(fileResult.missing);
    }
    data.records[id] = {
      ...record,
      deleted: true,
      deleted_at: now,
      updated_at: now,
    };
  }

  writeData(data);
  return {
    record: data.records[reviewId],
    deleted_record_ids: ids,
    deleted_files: deletedFiles,
    missing_files: missingFiles,
  };
}

function hasLocalVlmResult(localRecord) {
  if (!localRecord || !localRecord.vlm || !localRecord.vlm.status) return false;
  if (localRecord.vlm.status === 'failed') return true;
  return localRecord.vlm.prompt_version === 'gripper_cn_v1';
}

async function startAutoVlm(limit = 300, options = {}) {
  if (autoVlmJob.running) {
    return autoVlmJob;
  }

  const normalizedLimit = limit === null ? null : normalizeLimit(limit);
  const sourceItems = await getMergedRecords(normalizedLimit);
  const data = syncLocalImagesToData(readData());
  const pendingItems = sourceItems.filter((item) => {
    const localRecord = data.records[item.id];
    return participatesInEvaluation(item)
      && !(localRecord && localRecord.deleted)
      && (options.force || !hasLocalVlmResult(localRecord));
  });

  autoVlmJob.running = true;
  autoVlmJob.total = pendingItems.length;
  autoVlmJob.done = 0;
  autoVlmJob.success = 0;
  autoVlmJob.failed = 0;
  autoVlmJob.current = '';
  autoVlmJob.message = pendingItems.length ? '正在自动补齐 VLM 推理' : '没有需要补齐的 VLM 推理';
  autoVlmJob.started_at = new Date().toISOString();
  autoVlmJob.finished_at = null;

  void (async () => {
    for (const item of pendingItems) {
      autoVlmJob.current = item.source_id || item.original_filename || item.id;
      try {
        const vlm = await runVlm(item.id);
        upsertLocalRecord(item.id, { vlm });
        autoVlmJob.success += 1;
      } catch (error) {
        const vlm = {
          status: 'failed',
          error: error.message || String(error),
          updated_at: new Date().toISOString(),
        };
        upsertLocalRecord(item.id, { vlm });
        autoVlmJob.failed += 1;
      } finally {
        autoVlmJob.done += 1;
      }
    }
    autoVlmJob.running = false;
    autoVlmJob.current = '';
    autoVlmJob.message = '自动 VLM 推理已完成';
    autoVlmJob.finished_at = new Date().toISOString();
  })();

  return autoVlmJob;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/realtime-proxy/frame') {
    try {
      const camera = String(url.searchParams.get('camera') || url.searchParams.get('cam') || '1');
      const upstream = await fetchRealtimeImage(camera);
      if (!upstream.ok) {
        sendJson(res, upstream.status, { ok: false, message: `realtime frame failed: HTTP ${upstream.status}` });
        return;
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/realtime-proxy/snapshot') {
    try {
      const cam = String(url.searchParams.get('cam') || '1');
      const upstream = await fetchRealtimeImage(cam);
      if (!upstream.ok) {
        sendJson(res, upstream.status, { ok: false, message: `realtime snapshot failed: HTTP ${upstream.status}` });
        return;
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/reviews') {
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const records = await getMergedRecords(limit);
    sendJson(res, 200, { items: records, total: records.length });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/reviews/')) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    const data = readData();
    const local = data.records[reviewId] || {};
    if (local.local_source) {
      sendJson(res, 200, mergeRecord(local.local_source, local));
      return;
    }
    if (USE_SOURCE_5022) {
      const source = await getSourceReview(reviewId);
      sendJson(res, 200, mergeRecord(source, local));
      return;
    }
    sendJson(res, 404, { ok: false, message: '记录不存在' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/records') {
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const records = await getMergedRecords(limit);
    sendJson(res, 200, { items: records, summary: summarize(records) });
    return;
  }

  if (
    req.method === 'DELETE'
    && (url.pathname.startsWith('/api/records/') || url.pathname.startsWith('/api/annotations/'))
  ) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    const result = deleteRecordGroupAndLocalFiles(reviewId);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/vlm/auto-start') {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const job = await startAutoVlm(body.limit, { force: Boolean(body.force) });
    sendJson(res, 200, { ok: true, job });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/realtime/save') {
    try {
      const snapshots = [];
      const captureGroupId = `realtime_group_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
      for (const cam of [0, 1]) {
        try {
          const shot = await captureRealtimeSnapshot(cam, captureGroupId);
          snapshots.push(upsertLocalRealtimeRecord(shot));
        } catch {
          // 单路失败不阻断整体保存
        }
      }
      if (!snapshots.length) {
        sendJson(res, 502, { ok: false, message: '抓取实时画面失败，请检查 9002 服务' });
        return;
      }
      linkRealtimeGroup(snapshots);
      for (const snap of snapshots) {
        if (participatesInEvaluation(snap)) {
          triggerVlmInBackground(snap.id);
        }
      }
      sendJson(res, 200, {
        ok: true,
        message: `已保存 ${snapshots.length} 张实时图片为一组，cam1 正在后台推理并参与统计，cam0 仅保存为参考`,
        local_snapshots: snapshots,
      });
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload-image') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const filename = String(body.filename || '').trim();
      const contentType = String(body.content_type || '').trim() || 'image/jpeg';
      const base64 = String(body.image_base64 || '').trim();
      if (!filename || !base64) {
        sendJson(res, 400, { ok: false, message: 'filename 和 image_base64 必填' });
        return;
      }
      const pureBase64 = base64.includes(',') ? base64.split(',').pop() : base64;
      const buffer = Buffer.from(pureBase64, 'base64');
      if (!buffer.length) {
        sendJson(res, 400, { ok: false, message: '图片内容为空' });
        return;
      }
      ensureLocalImageDir();
      const safeName = filename.replace(/[^\w.\-]/g, '_');
      const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
      const filepath = path.join(LOCAL_IMAGE_DIR, unique);
      fs.writeFileSync(filepath, buffer);
      const id = `upload_${unique.replace(/\.[^.]+$/, '')}`;
      const localSource = makeLocalSourceRecord({
        id,
        filename: unique,
        contentType,
        cameraId: body.camera_id ?? null,
        cameraLabel: body.camera_label || 'upload',
      });
      const local = upsertLocalRecord(id, { local_source: localSource });
      triggerVlmInBackground(id);
      const latestLocal = readData().records[id] || local;
      sendJson(res, 200, {
        ok: true,
        message: '图片已上传到本地记录，VLM 正在后台推理',
        record: mergeRecord(localSource, latestLocal),
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reviews') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const filename = String(body.filename || body.source_id || '').trim();
      const contentType = String(body.content_type || '').trim() || 'image/jpeg';
      const base64 = String(body.image_base64 || '').trim();
      if (!filename || !base64) {
        sendJson(res, 400, { ok: false, message: 'filename/source_id 和 image_base64 必填' });
        return;
      }
      const pureBase64 = base64.includes(',') ? base64.split(',').pop() : base64;
      const buffer = Buffer.from(pureBase64, 'base64');
      if (!buffer.length) {
        sendJson(res, 400, { ok: false, message: '图片内容为空' });
        return;
      }
      ensureLocalImageDir();
      const safeName = filename.replace(/[^\w.\-]/g, '_');
      const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
      fs.writeFileSync(path.join(LOCAL_IMAGE_DIR, unique), buffer);
      const id = `review_${unique.replace(/\.[^.]+$/, '')}`;
      const localSource = makeLocalSourceRecord({
        id,
        filename: unique,
        contentType,
        cameraId: body.camera_id ?? null,
        cameraLabel: body.camera_label || 'upload',
      });
      localSource.source_id = body.source_id || filename;
      if (body.captured_at) {
        localSource.created_at = body.captured_at;
      }
      if (body.source_metadata && typeof body.source_metadata === 'object') {
        localSource.source_metadata = {
          ...localSource.source_metadata,
          ...body.source_metadata,
        };
      }
      upsertLocalRecord(id, { local_source: localSource });
      triggerVlmInBackground(id);
      sendJson(res, 200, { ok: true, message: '已写入本地 reviews 并触发 VLM', id, review_path: `/review/${id}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/vlm/auto-status') {
    sendJson(res, 200, { ok: true, job: autoVlmJob });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/vlm/')) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    try {
      const vlm = await runVlm(reviewId);
      const local = upsertLocalRecord(reviewId, { vlm });
      sendJson(res, 200, { ok: true, record: local, vlm });
    } catch (error) {
      const vlm = {
        status: 'failed',
        error: error.message || String(error),
        updated_at: new Date().toISOString(),
      };
      const local = upsertLocalRecord(reviewId, { vlm });
      sendJson(res, 500, { ok: false, record: local, vlm });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/annotations/')) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    const body = JSON.parse(await readBody(req) || '{}');
    const annotation = {
      human_result: body.human_result || '',
      model_result: body.model_result || '',
      sample_validity: body.sample_validity || 'valid',
      attribution_branch: body.attribution_branch || '',
      attribution_reason: body.attribution_reason || '',
      note: body.note || '',
      updated_at: new Date().toISOString(),
    };
    const local = upsertLocalRecord(reviewId, { annotation });
    sendJson(res, 200, { ok: true, record: local });
    return;
  }

  sendJson(res, 404, { ok: false, message: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname.startsWith('/api/local-images/')) {
        const name = decodeURIComponent(url.pathname.split('/').pop() || '');
        const filePath = path.join(LOCAL_IMAGE_DIR, name);
        if (!fs.existsSync(filePath)) {
          sendText(res, 404, 'Not Found');
          return;
        }
        const contentType = getImageContentType(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(filePath));
        return;
      }
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === '/realtime' || url.pathname === '/realtime/') {
      let upstream = await fetch(`${REALTIME_BASE_URL}/realtime/`);
      if (!upstream.ok) {
        upstream = await fetch(`${REALTIME_BASE_URL}/`);
      }
      if (!upstream.ok) {
        sendJson(res, upstream.status, { ok: false, message: `realtime page failed: HTTP ${upstream.status}` });
        return;
      }
      const html = (await upstream.text())
        .replaceAll('"/api/realtime-proxy/frame?camera=', '"/api/realtime-proxy/frame?camera=')
        .replaceAll('"/frame?camera=', '"/api/realtime-proxy/frame?camera=');
      sendText(res, 200, html, upstream.headers.get('content-type') || 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/gripper_eval.html') {
      sendText(res, 200, fs.readFileSync(HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`夹爪评估平台已启动：http://${HOST}:${PORT}`);
});
