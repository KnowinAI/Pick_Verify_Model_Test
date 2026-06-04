/**
 * 这个文件是一个 Node.js HTTP 服务，用来做机器人夹爪图片评估。
 * 主要功能包括本地图片管理、实时相机抓图、调用 VLM 判断是否夹住物体、人工标注、统计准确率，以及把人工反馈回传给 pick-verifier 服务。
 * 注释只解释代码意图，不改变原有逻辑。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { importLegacyPlatform } = require('../scripts/import_legacy_lib');

// 服务基础配置。大多数配置支持通过环境变量覆盖。
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 5034);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;
const SOURCE_BASE_URL = process.env.SOURCE_BASE_URL || 'http://101.132.143.105:5022';
const DEFAULT_REALTIME_BASE_URLS = [
  'http://127.0.0.1:5033',
  'http://192.168.78.168:5033',
  'http://192.168.78.168:9002',
  'http://192.168.127.10:9002',
];
const REALTIME_FETCH_TIMEOUT_MS = Number(process.env.REALTIME_FETCH_TIMEOUT_MS || 1500);
const USE_SOURCE_5022 = process.env.USE_SOURCE_5022 === '1';
const VLM_ENDPOINT = process.env.VLM_CHAT_COMPLETIONS_URL
  || process.env.VLM_ENDPOINT
  || 'http://101.132.143.105:5087/v1/chat/completions';
const PICK_VERIFIER_FEEDBACK_ENDPOINT = process.env.PICK_VERIFIER_FEEDBACK_ENDPOINT
  || VLM_ENDPOINT.replace(/\/v1\/chat\/completions\/?$/, '/api/pick-verifier/feedback');
const VLM_MODEL = process.env.VLM_MODEL || 'pick_verifier_1200_merged';
const VLM_PROMPT_VERSION = 'gripper_gn_binary_v1';
const VLM_COMPATIBLE_PROMPT_VERSIONS = new Set([
  VLM_PROMPT_VERSION,
  'gripper_cn_binary_v1',
  'gripper_cn_v1',
]);
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

// 解析实时图像服务地址。支持逗号、空格和分号分隔。
function parseRealtimeBaseUrls(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s;]+/)
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// 合并环境变量里的实时服务地址和默认地址，并去重。
function getRealtimeBaseUrls() {
  return Array.from(new Set([
    ...parseRealtimeBaseUrls(process.env.REALTIME_BASE_URLS),
    ...parseRealtimeBaseUrls(process.env.REALTIME_BASE_URL),
    ...DEFAULT_REALTIME_BASE_URLS,
  ]));
}

const REALTIME_BASE_URLS = getRealtimeBaseUrls();

// 给视觉语言模型的提示词。要求模型只输出 G 或 N。
const PROMPT = `判断机器人夹爪是否夹住了物体。只能输出下面一个字母，不要输出解释：
G：夹住，夹爪当前夹住了物体。
N：没夹住，夹爪当前没有夹住物体。`;

// 把模型可能输出的字母映射成内部状态。兼容旧版 A/B/C/Y 等输出。
const LETTER_TO_STATUS = {
  A: 'Not_Grasped',
  B: 'Grasped',
  C: 'Not_Grasped',
  G: 'Grasped',
  N: 'Not_Grasped',
  Y: 'Grasped',
};

// 内部状态对应的中文展示文案。
const STATUS_TO_CN = {
  Grasped: '夹住',
  Not_Grasped: '没夹住',
  Closed_Empty: '闭合，未夹住',
  Closed_Grasped: '闭合，已夹住',
  Opened_Empty: '张开，未夹住',
  Unknown: '无法判断',
};

// 把中文、英文、布尔字符串等人工或模型输出统一成内部状态。
const CN_TO_STATUS = {
  无法判断: 'Unknown',
  没夹住: 'Not_Grasped',
  未夹住: 'Not_Grasped',
  没有夹住: 'Not_Grasped',
  没抓住: 'Not_Grasped',
  未抓住: 'Not_Grasped',
  not_grasped: 'Not_Grasped',
  'not grasped': 'Not_Grasped',
  no: 'Not_Grasped',
  false: 'Not_Grasped',
  夹住: 'Grasped',
  grasped: 'Grasped',
  yes: 'Grasped',
  true: 'Grasped',
  '未夹住（闭合）': 'Not_Grasped',
  '夹住（闭合）': 'Grasped',
  '未夹住（张开）': 'Not_Grasped',
  '闭合，未夹住': 'Not_Grasped',
  '闭合，已夹住': 'Grasped',
  '张开，未夹住': 'Not_Grasped',
  闭合空夹: 'Closed_Empty',
  已夹住物体: 'Grasped',
  张开空夹: 'Opened_Empty',
};

// 自动批量调用 VLM 的任务状态。前端可以查询这个对象了解进度。
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

// 初始化本地数据结构。records 存图片和标注，custom_reason_options 存自定义归因原因。
function defaultData() {
  return {
    version: 1,
    records: {},
    custom_reason_options: {},
  };
}

// 从 gripper_eval_data.json 读取数据。文件不存在或解析失败时返回空结构。
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

// 把数据写回 gripper_eval_data.json。
function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// 清洗自定义归因原因，去掉空值和重复项。
function normalizeCustomReasonOptions(value = {}) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [branchKey, rawEntries] of Object.entries(value)) {
    const branch = String(branchKey || '').trim();
    if (!branch || !Array.isArray(rawEntries)) continue;
    const entries = [];
    for (const rawEntry of rawEntries) {
      const reason = String(
        typeof rawEntry === 'string' ? rawEntry : rawEntry && rawEntry.reason,
      ).trim();
      if (!reason) continue;
      const humanResult = typeof rawEntry === 'object'
        ? String(rawEntry.human_result || '').trim()
        : '';
      if (!entries.some((entry) => entry.reason === reason && entry.human_result === humanResult)) {
        entries.push({ reason, human_result: humanResult });
      }
    }
    if (entries.length) result[branch] = entries;
  }
  return result;
}

// 把归因原因统一成数组。支持数组，也支持用中文顿号或竖线分隔的字符串。
function normalizeAttributionReasons(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (!value) return [];
  return String(value).split(/[、|]/).map((item) => item.trim()).filter(Boolean);
}

// 统计某类归因原因出现次数。没有填写时归到“未填写原因”。
function addReasonCounts(target, value) {
  const reasons = normalizeAttributionReasons(value);
  const normalizedReasons = reasons.length ? reasons : ['未填写原因'];
  for (const reason of normalizedReasons) {
    target[reason] = (target[reason] || 0) + 1;
  }
}

// 把原因计数转成列表，并计算占比，再按次数排序。
function formatReasonStats(counts, total) {
  return Object.entries(counts || {})
    .map(([reason, count]) => ({
      reason,
      count,
      rate: total ? count / total : null,
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.reason.localeCompare(b.reason, 'zh-Hans-CN');
    });
}

// 确保本地图片目录存在。
function ensureLocalImageDir() {
  if (!fs.existsSync(LOCAL_IMAGE_DIR)) {
    fs.mkdirSync(LOCAL_IMAGE_DIR, { recursive: true });
  }
}

// 规范化 limit 参数。all 表示不限制，其它非法值用默认值。
function normalizeLimit(value, fallback = DEFAULT_RECORD_LIMIT) {
  if (String(value || '').toLowerCase() === 'all') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_RECORD_LIMIT);
}

// 按 limit 截断记录列表。limit 为 null 时不截断。
function applyRecordLimit(records, limit) {
  return limit === null ? records : records.slice(0, limit);
}

// 根据文件后缀返回图片 Content-Type。
function getImageContentType(filename) {
  return IMAGE_CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

// 根据本地文件名生成稳定的记录 ID，带哈希是为了减少重名冲突。
function makeLocalFileRecordId(filename) {
  const baseName = path.basename(filename, path.extname(filename)).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image';
  const hash = crypto.createHash('sha1').update(filename).digest('hex').slice(0, 12);
  return `local_file_${hash}_${baseName}`;
}

// 从记录中取出真实存储的文件名。
function getRecordFilename(record) {
  const source = record && record.local_source;
  return source && (source.stored_filename || source.original_filename || source.source_id);
}

// 解析实时抓图文件名，提取相机编号和时间戳。
function parseRealtimeFilename(filename) {
  const match = /^realtime_cam([01])_(\d{14})_[^.]+\.(?:jpe?g|png|webp|gif)$/i.exec(filename);
  if (!match) return null;
  return {
    cameraId: Number(match[1]),
    timestamp: match[2],
  };
}

// 对同一时间戳的 cam0 和 cam1 图片补充分组信息。cam1 参与评估，cam0 作为参考。
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

// 扫描 local_images 目录，把图片同步进本地 records，并处理重复和恢复删除。
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

// 返回 JSON 响应，并禁止缓存。
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 返回文本或 HTML 响应，并禁止缓存。
function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 读取请求体。这里把所有 chunk 拼成字符串。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 请求外部接口并解析 JSON。非 2xx 会抛错。
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

// 从 5022 源服务拉取评估记录列表。开关 USE_SOURCE_5022 关闭时直接返回空数组。
async function listSourceReviews(limit = 200) {
  if (!USE_SOURCE_5022) return [];
  const data = await fetchJson(`${SOURCE_BASE_URL}/api/reviews?limit=${encodeURIComponent(limit)}`);
  return Array.isArray(data.items) ? data.items : [];
}

// 从 5022 源服务获取单条评估记录。
async function getSourceReview(id) {
  if (!USE_SOURCE_5022) {
    throw new Error('5022 源服务已禁用');
  }
  return fetchJson(`${SOURCE_BASE_URL}/api/reviews/${encodeURIComponent(id)}`);
}

// 把记录里的图片地址转成可访问的完整 URL。
function getImageUrl(review) {
  if (!review.image_url) return null;
  if (review.image_url.startsWith('http')) return review.image_url;
  if (review.image_url.startsWith('/api/local-images/')) return `${APP_BASE_URL}${review.image_url}`;
  return `${SOURCE_BASE_URL}${review.image_url}`;
}

// 整理网络错误信息，便于前端显示。
function formatFetchError(error) {
  const messages = [];
  if (error && error.message) messages.push(error.message);
  const cause = error && error.cause;
  if (cause && cause.code) messages.push(cause.code);
  if (cause && cause.address) messages.push(cause.port ? `${cause.address}:${cause.port}` : cause.address);
  if (cause && cause.message && !messages.includes(cause.message)) messages.push(cause.message);
  return messages.filter(Boolean).join('；') || String(error || '未知错误');
}

// 从 /api/local-images/xxx 形式的地址中取出本地文件名。
function getLocalImageFilename(imagePath) {
  const raw = String(imagePath || '').split(/[?#]/, 1)[0];
  const prefix = '/api/local-images/';
  if (!raw.startsWith(prefix)) return '';
  try {
    return path.basename(decodeURIComponent(raw.slice(prefix.length)));
  } catch {
    return path.basename(raw.slice(prefix.length));
  }
}

// 读取本地图片二进制，并做路径校验，防止越权读取。
function readLocalImageBuffer(imagePath) {
  const filename = getLocalImageFilename(imagePath);
  if (!filename) {
    throw new Error(`本地图片地址无效：${imagePath || '-'}`);
  }
  const imagePathOnDisk = path.resolve(LOCAL_IMAGE_DIR, filename);
  const imageDir = path.resolve(LOCAL_IMAGE_DIR);
  if (!imagePathOnDisk.startsWith(`${imageDir}${path.sep}`)) {
    throw new Error(`本地图片路径非法：${filename}`);
  }
  if (!fs.existsSync(imagePathOnDisk)) {
    throw new Error(`本地图片不存在：${filename}`);
  }
  return fs.readFileSync(imagePathOnDisk);
}

// 找到同一抓图组里的另一张图片，通常是参考视角。
function getPairedLocalSource(data, reviewId, source) {
  const metadata = (source && source.source_metadata) || {};
  if (metadata.paired_record_id && data.records[metadata.paired_record_id]?.local_source) {
    return data.records[metadata.paired_record_id].local_source;
  }
  if (metadata.capture_group_id) {
    for (const [id, item] of Object.entries(data.records || {})) {
      if (id === reviewId || !item?.local_source) continue;
      if (item.local_source.source_metadata?.capture_group_id === metadata.capture_group_id) {
        return item.local_source;
      }
    }
  }
  return null;
}

// 把图片转成 VLM chat-completions 接口需要的 image_url 内容块。
async function makeImageContentBlock(source) {
  if (!source || !source.image_url) throw new Error('缺少图片地址');
  let imageBuffer;
  if (source.image_url.startsWith('/api/local-images/')) {
    imageBuffer = readLocalImageBuffer(source.image_url);
  } else {
    const imageUrl = getImageUrl(source);
    if (!imageUrl) throw new Error('缺少图片地址');
    let imageResponse;
    try {
      imageResponse = await fetch(imageUrl);
    } catch (error) {
      throw new Error(`下载图片失败：${imageUrl}；${formatFetchError(error)}`);
    }
    if (!imageResponse.ok) {
      throw new Error(`下载图片失败：${imageUrl}；HTTP ${imageResponse.status}`);
    }
    imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  }
  return {
    type: 'image_url',
    image_url: {
      url: `data:${source.content_type || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`,
    },
  };
}

// 把细分状态压成二分类结果。grasped、not_grasped 或 no_result。
function mapVlmToModelResult(status) {
  if (status === 'Grasped' || status === 'Closed_Grasped') return 'grasped';
  if (status === 'Not_Grasped' || status === 'Closed_Empty' || status === 'Opened_Empty') return 'not_grasped';
  return 'no_result';
}

// 读取相机编号。空值返回 null。
function getCameraId(record) {
  const cameraId = record && record.source_metadata && record.source_metadata.camera_id;
  return cameraId === null || cameraId === undefined || cameraId === '' ? null : Number(cameraId);
}

// 判断某条记录是否参与统计。实时抓图中 cam1 参与评估，cam0 默认只做参考。
function participatesInEvaluation(record) {
  const metadata = (record && record.source_metadata) || {};
  if (metadata.evaluate === false) return false;
  if (metadata.source === '9002_snapshot') return getCameraId(record) === 1;
  return true;
}

// 解析 VLM 原始输出。兼容中文、英文、字母和布尔值。
function parseVlmOutput(rawOutput) {
  const text = String(rawOutput || '').trim();
  const normalizedText = text.toLowerCase().replace(/^["'`]+|["'`.,，。；;:：\s]+$/g, '');
  if (CN_TO_STATUS[normalizedText]) {
    const predictedStatus = CN_TO_STATUS[normalizedText];
    return { predictedStatus, predictedStatusCn: STATUS_TO_CN[predictedStatus] || normalizedText };
  }
  for (const [label, status] of Object.entries(CN_TO_STATUS)) {
    if (text.includes(label) || normalizedText.includes(label)) {
      return { predictedStatus: status, predictedStatusCn: label };
    }
  }

  const letter = normalizedText.toUpperCase().slice(0, 1);
  const predictedStatus = LETTER_TO_STATUS[letter] || 'Unknown';
  return {
    predictedStatus,
    predictedStatusCn: STATUS_TO_CN[predictedStatus] || '未知',
  };
}

// 修复历史 VLM 结果。有些失败记录其实含有可解析输出，这里会转成 completed。
function normalizeStoredVlm(vlm) {
  if (!vlm || typeof vlm !== 'object') return {};
  if (vlm.status !== 'failed') return vlm;

  const rawOutput = String(vlm.raw_model_output || '').trim();
  if (!rawOutput) return vlm;

  const { predictedStatus, predictedStatusCn } = parseVlmOutput(rawOutput);
  if (predictedStatus === 'Unknown') return vlm;

  return {
    ...vlm,
    status: 'completed',
    predicted_status: predictedStatus,
    predicted_status_cn: predictedStatusCn,
    model_result: mapVlmToModelResult(predictedStatus),
    error: '',
  };
}

// 判断失败的 VLM 结果是否值得重试。旧提示词版本或图片下载失败一般可以重试。
function isRetryableFailedVlm(vlm) {
  if (!vlm || vlm.status !== 'failed') return false;
  const rawOutput = String(vlm.raw_model_output || '').trim();
  if (rawOutput && parseVlmOutput(rawOutput).predictedStatus !== 'Unknown') {
    return true;
  }
  const error = String(vlm.error || '');
  if (vlm.prompt_version && !VLM_COMPATIBLE_PROMPT_VERSIONS.has(vlm.prompt_version)) {
    return true;
  }
  return !vlm.prompt_version && (error === 'fetch failed' || error.includes('下载图片失败'));
}

// 根据人工标注和模型结果给记录分类，如正确、漏判、误判、无效样本等。
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

// 合并源服务记录和本地标注/VLM 结果，形成前端使用的完整记录。
function mergeRecord(source, local) {
  const vlm = normalizeStoredVlm(local.vlm || {});
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

// 列出只存在于本地的记录。
function listLocalOnlyRecords(data) {
  return Object.entries(data.records || {})
    .filter(([, local]) => local && local.local_source && !local.deleted)
    .map(([, local]) => mergeRecord(local.local_source, local));
}

// 排序规则。参与评估的排前面，再按创建或更新时间倒序。
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

// 构造一条本地图片记录，供上传、扫描、实时抓图统一使用。
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

// 获取最终展示的记录列表。优先合并源服务数据，失败时退回本地数据。
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

// 计算统计指标，包括准确率、召回率、精确率、漏判率、误判率和按物体标签分组的统计。
function summarize(records) {
  const evaluationRecords = records.filter(participatesInEvaluation);
  const matrixCategories = ['正确识别夹住', '漏判', '误判', '正确识别未夹住'];
  const objectTagStats = new Map();
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
    objectTagStats: [],
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
    if (matrixCategories.includes(category)) {
      summary.evaluable += 1;
      const objectTag = String(annotation.object_tag || '').trim();
      if (objectTag) {
        const stat = objectTagStats.get(objectTag) || {
          tag: objectTag,
          total: 0,
          tp: 0,
          fn: 0,
          fp: 0,
          tn: 0,
          correct: 0,
          accuracy: null,
          missRate: null,
          falseAlarmRate: null,
          fnReasons: {},
          fpReasons: {},
        };
        stat.total += 1;
        if (category === '正确识别夹住') {
          stat.tp += 1;
          stat.correct += 1;
        } else if (category === '漏判') {
          stat.fn += 1;
          addReasonCounts(stat.fnReasons, annotation.attribution_reason);
        } else if (category === '误判') {
          stat.fp += 1;
          addReasonCounts(stat.fpReasons, annotation.attribution_reason);
        } else if (category === '正确识别未夹住') {
          stat.tn += 1;
          stat.correct += 1;
        }
        objectTagStats.set(objectTag, stat);
      }
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
  summary.objectTagStats = Array.from(objectTagStats.values())
    .map((stat) => ({
      ...stat,
      accuracy: stat.total ? stat.correct / stat.total : null,
      missRate: stat.tp + stat.fn ? stat.fn / (stat.tp + stat.fn) : null,
      falseAlarmRate: stat.fp + stat.tn ? stat.fp / (stat.fp + stat.tn) : null,
      fnReasons: formatReasonStats(stat.fnReasons, stat.fn),
      fpReasons: formatReasonStats(stat.fpReasons, stat.fp),
    }))
    .sort((a, b) => {
      const aErrors = a.fn + a.fp;
      const bErrors = b.fn + b.fp;
      if (aErrors !== bErrors) return bErrors - aErrors;
      if (a.accuracy !== b.accuracy) return (a.accuracy ?? 1) - (b.accuracy ?? 1);
      if (a.total !== b.total) return b.total - a.total;
      return a.tag.localeCompare(b.tag, 'zh-Hans-CN');
    });

  return summary;
}

// 调用视觉语言模型判断某张图片是否夹住物体，并返回标准化结果。
async function runVlm(reviewId) {
  const data = readData();
  const local = data.records[reviewId] || {};
  const source = local.local_source || await getSourceReview(reviewId);
  const pairedSource = local.local_source ? getPairedLocalSource(data, reviewId, source) : null;
  const imageBlocks = [await makeImageContentBlock(source)];
  if (pairedSource) {
    imageBlocks.push(await makeImageContentBlock(pairedSource));
  }

  const payload = {
    model: VLM_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: PROMPT },
        ],
      },
    ],
    max_tokens: 16,
    temperature: 0,
  };

  let response;
  try {
    response = await fetch(VLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.VLM_API_KEY ? { Authorization: `Bearer ${process.env.VLM_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`VLM 调用失败：${VLM_ENDPOINT}；${formatFetchError(error)}`);
  }
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
    prompt_version: VLM_PROMPT_VERSION,
    predicted_status: predictedStatus,
    predicted_status_cn: predictedStatusCn,
    model_result: mapVlmToModelResult(predictedStatus),
    raw_model_output: rawOutput,
    raw_response: result,
    pick_verifier_prediction_id: result.pick_verifier?.prediction_id || '',
    pick_verifier_request_id: result.pick_verifier?.request_id || '',
    error: predictedStatus === 'Unknown' ? `模型输出无法识别：${rawOutput || '空'}` : '',
    updated_at: new Date().toISOString(),
  };
}

// 把本地人工标注转换成 pick-verifier 反馈接口需要的格式。
function humanReviewFromAnnotation(annotation) {
  const humanResult = annotation.human_result || '';
  const state = humanResult === 'grasped'
    ? 'object_grasped'
    : humanResult === 'closed_not_grasped'
      ? 'closed_empty'
      : humanResult === 'open_not_grasped'
        ? 'opened_empty'
        : humanResult;
  return {
    state,
    label: state === 'closed_empty' ? 'A' : state === 'object_grasped' ? 'B' : state === 'opened_empty' ? 'C' : '',
    sample_validity: annotation.sample_validity || '',
    attribution_branch: annotation.attribution_branch || '',
    attribution_reason: annotation.attribution_reason || '',
    object_tag: annotation.object_tag || '',
    note: annotation.note || '',
  };
}

// 把人工标注回传给 pick-verifier，方便后续改进模型或分析。
async function syncPickVerifierFeedback(reviewId, record, annotation) {
  const vlm = normalizeStoredVlm(record.vlm || {});
  const predictionId = vlm.pick_verifier_prediction_id || vlm.raw_response?.pick_verifier?.prediction_id || '';
  const requestId = vlm.pick_verifier_request_id || vlm.raw_response?.pick_verifier?.request_id || '';
  if (!predictionId) {
    return { status: 'skipped', reason: 'missing_prediction_id', updated_at: new Date().toISOString() };
  }
  const response = await fetch(PICK_VERIFIER_FEEDBACK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prediction_id: predictionId,
      request_id: requestId,
      metadata: { source_app: 'pick-verify', review_id: reviewId },
      model_prediction: {
        label: vlm.raw_response?.pick_verifier?.label || '',
        state: vlm.raw_response?.pick_verifier?.state || '',
        model_result: vlm.model_result || '',
      },
      human_review: humanReviewFromAnnotation(annotation),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: 'failed',
      error: result.error?.message || result.message || `HTTP ${response.status}`,
      updated_at: new Date().toISOString(),
    };
  }
  return {
    status: 'completed',
    feedback_id: result.id || '',
    endpoint: PICK_VERIFIER_FEEDBACK_ENDPOINT,
    updated_at: new Date().toISOString(),
  };
}

// 获取 URL 端口。没有显式端口时，根据协议补默认端口。
function getUrlPort(url) {
  if (url.port) return url.port;
  if (url.protocol === 'https:') return '443';
  if (url.protocol === 'http:') return '80';
  return '';
}

// 收集本机所有可用地址，用来判断某个实时服务地址是不是当前服务自身。
function getLocalHostnames() {
  const hosts = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '::', '::1']);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address?.address) hosts.add(address.address);
    }
  }
  return hosts;
}

const LOCAL_HOSTNAMES = getLocalHostnames();

// 判断目标 baseUrl 是否指向当前服务，避免代理请求打到自己造成循环请求。
function isCurrentServerBase(baseUrl) {
  try {
    const target = new URL(baseUrl);
    const app = new URL(APP_BASE_URL);
    return getUrlPort(target) === String(PORT)
      && (
        LOCAL_HOSTNAMES.has(target.hostname)
        || (target.hostname === app.hostname && getUrlPort(target) === getUrlPort(app))
      );
  } catch {
    return false;
  }
}

// 根据实时服务类型生成可能的抓图接口地址。5033 和 9002 的路径不一样。
function makeRealtimeFrameUrls(baseUrl, cam) {
  if (!baseUrl || isCurrentServerBase(baseUrl)) return [];
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [];
  }
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  const camera = encodeURIComponent(cam);
  const tick = Date.now();
  const proxyUrl = `${normalized}/api/realtime-proxy/frame?camera=${camera}&t=${tick}`;
  const snapshotUrl = `${normalized}/snapshot?cam=${camera}&t=${tick}`;
  const frameUrl = `${normalized}/frame?camera=${camera}&t=${tick}`;
  const port = getUrlPort(parsed);
  if (port === '5033') return [proxyUrl];
  if (port === '9002') return [snapshotUrl, frameUrl];
  return [proxyUrl, snapshotUrl, frameUrl];
}

// 带超时地请求实时图像，避免一个不可用地址长时间卡住。
async function fetchWithRealtimeTimeout(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REALTIME_FETCH_TIMEOUT_MS);
  try {
    return await fetch(targetUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// 整理实时图像抓取错误。超时时给出明确提示。
function formatRealtimeFetchError(error) {
  return error.name === 'AbortError'
    ? `超时 ${REALTIME_FETCH_TIMEOUT_MS}ms`
    : error.message || String(error);
}

// 依次尝试多个实时图像地址，直到成功拿到一张图。
async function fetchRealtimeImage(cam) {
  const candidates = REALTIME_BASE_URLS.flatMap((baseUrl) => makeRealtimeFrameUrls(baseUrl, cam));
  let lastError = '';
  for (const imageUrl of candidates) {
    try {
      const response = await fetchWithRealtimeTimeout(imageUrl);
      if (response.ok) return response;
      lastError = `${imageUrl} HTTP ${response.status}`;
    } catch (error) {
      lastError = `${imageUrl} ${formatRealtimeFetchError(error)}`;
    }
  }
  throw new Error(`cam${cam} 抓图失败：${lastError || '无可用实时图像接口'}`);
}

// 代理实时页面。会尝试 /realtime/ 和根路径。
async function fetchRealtimePage() {
  let lastError = '';
  for (const baseUrl of REALTIME_BASE_URLS) {
    if (!baseUrl || isCurrentServerBase(baseUrl)) continue;
    const normalized = baseUrl.replace(/\/+$/, '');
    for (const pageUrl of [`${normalized}/realtime/`, `${normalized}/`]) {
      try {
        const response = await fetchWithRealtimeTimeout(pageUrl);
        if (response.ok) return response;
        lastError = `${pageUrl} HTTP ${response.status}`;
      } catch (error) {
        lastError = `${pageUrl} ${formatRealtimeFetchError(error)}`;
      }
    }
  }
  throw new Error(lastError || '无可用实时页面');
}

// 从实时相机保存一张快照到 local_images，并返回快照元数据。
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

// 把实时快照写入本地 records。cam1 标为评估图，cam0 标为参考图。
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

// 把同一组实时快照互相绑定，方便 VLM 同时使用评估图和参考图。
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

// 调用 VLM 并把结果写入本地数据。失败也会保存失败原因。
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

// 异步触发 VLM，不阻塞当前 API 响应。
function triggerVlmInBackground(reviewId) {
  void runVlmAndPersist(reviewId);
}

// 更新或新增一条本地记录，并立即落盘。
function upsertLocalRecord(reviewId, patch) {
  const data = readData();
  upsertLocalRecordInData(data, reviewId, patch);
  writeData(data);
  return data.records[reviewId];
}

// 在内存中的 data 对象里更新或新增记录。调用者决定何时 writeData。
function upsertLocalRecordInData(data, reviewId, patch) {
  const current = data.records[reviewId] || {};
  data.records[reviewId] = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  return data.records[reviewId];
}

// 根据分组信息找出同一组记录，用于整组删除。
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

// 删除记录对应的本地图片文件。
function deleteLocalImageFile(record) {
  const filename = getRecordFilename(record);
  if (!filename) return { deleted: false, missing: '' };
  const filePath = path.join(LOCAL_IMAGE_DIR, path.basename(filename));
  if (!filePath.startsWith(LOCAL_IMAGE_DIR)) return { deleted: false, missing: filename };
  if (!fs.existsSync(filePath)) return { deleted: false, missing: filename };
  fs.unlinkSync(filePath);
  return { deleted: true, missing: '' };
}

// 删除一条记录所属整组图片，并把 records 标记为 deleted。
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

// 判断本地是否已经有可用的 VLM 结果，避免重复推理。
function hasLocalVlmResult(localRecord) {
  if (!localRecord || !localRecord.vlm || !localRecord.vlm.status) return false;
  if (localRecord.vlm.status === 'failed') return !isRetryableFailedVlm(localRecord.vlm);
  return VLM_COMPATIBLE_PROMPT_VERSIONS.has(localRecord.vlm.prompt_version);
}

// 启动自动补齐 VLM 结果任务。任务用立即执行的异步函数在后台跑。
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

// 所有 /api/ 路由的主处理函数。根据 method 和 pathname 分发到不同功能。
async function handleApi(req, res, url) {
  // 代理实时画面帧，前端可以通过本服务拿相机图片。
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

  // 代理实时快照接口。
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

  // 获取评估记录列表。
  if (req.method === 'GET' && url.pathname === '/api/reviews') {
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const records = await getMergedRecords(limit);
    sendJson(res, 200, { items: records, total: records.length });
    return;
  }

  // 获取单条评估记录。
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

  // 获取记录列表和统计摘要，是前端主页常用的数据接口。
  if (req.method === 'GET' && url.pathname === '/api/records') {
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const records = await getMergedRecords(limit);
    sendJson(res, 200, { items: records, summary: summarize(records) });
    return;
  }

  // 获取自定义归因原因列表。
  if (req.method === 'GET' && url.pathname === '/api/custom-reasons') {
    const data = readData();
    sendJson(res, 200, { ok: true, custom_reasons: normalizeCustomReasonOptions(data.custom_reason_options) });
    return;
  }

  // 新增一条自定义归因原因。
  if (req.method === 'POST' && url.pathname === '/api/custom-reasons') {
    const body = JSON.parse(await readBody(req) || '{}');
    const branch = String(body.branch || '').trim().slice(0, 40);
    const reason = String(body.reason || '').trim().slice(0, 80);
    const humanResult = String(body.human_result || '').trim().slice(0, 40);
    if (!branch || !reason) {
      sendJson(res, 400, { ok: false, message: '请填写归因分支和具体原因' });
      return;
    }
    const data = readData();
    const customReasons = normalizeCustomReasonOptions(data.custom_reason_options);
    if (!customReasons[branch]) customReasons[branch] = [];
    if (!customReasons[branch].some((entry) => entry.reason === reason && entry.human_result === humanResult)) {
      customReasons[branch].push({ reason, human_result: humanResult });
    }
    data.custom_reason_options = customReasons;
    writeData(data);
    sendJson(res, 200, { ok: true, custom_reasons: customReasons, reason: { branch, reason, human_result: humanResult } });
    return;
  }

  // 删除一条自定义归因原因。
  if (req.method === 'DELETE' && url.pathname === '/api/custom-reasons') {
    const body = JSON.parse(await readBody(req) || '{}');
    const branch = String(body.branch || '').trim().slice(0, 40);
    const reason = String(body.reason || '').trim().slice(0, 80);
    const humanResult = String(body.human_result || '').trim().slice(0, 40);
    if (!branch || !reason) {
      sendJson(res, 400, { ok: false, message: '请填写归因分支和具体原因' });
      return;
    }
    const data = readData();
    const customReasons = normalizeCustomReasonOptions(data.custom_reason_options);
    const current = customReasons[branch] || [];
    customReasons[branch] = current.filter((entry) => !(entry.reason === reason && entry.human_result === humanResult));
    if (!customReasons[branch].length) delete customReasons[branch];
    data.custom_reason_options = customReasons;
    writeData(data);
    sendJson(res, 200, { ok: true, custom_reasons: customReasons, reason: { branch, reason, human_result: humanResult } });
    return;
  }

  // 导入旧版 platform 目录中的历史图片和数据。
  if (req.method === 'POST' && url.pathname === '/api/import-legacy') {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const sourcePath = String(body.sourcePath || process.env.LEGACY_IMPORT_DIR || '').trim();
    if (!sourcePath) {
      sendJson(res, 400, { ok: false, message: '请填写同事拷贝过来的 platform 路径' });
      return;
    }
    try {
      const result = importLegacyPlatform(sourcePath, {
        dryRun: Boolean(body.dryRun),
        targetPlatformDir: __dirname,
      });
      if (!body.dryRun) syncLocalImagesToData(readData());
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message || String(error) });
    }
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

  // 启动批量 VLM 推理任务。
  if (req.method === 'POST' && url.pathname === '/api/vlm/auto-start') {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const job = await startAutoVlm(body.limit, { force: Boolean(body.force) });
    sendJson(res, 200, { ok: true, job });
    return;
  }

  // 保存一组实时相机快照，并对参与评估的图片触发 VLM。
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
        sendJson(res, 502, { ok: false, message: '抓取实时画面失败，请检查实时服务或代理地址' });
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

  // 上传一张 base64 图片到本地，并触发 VLM。
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

  // 兼容 reviews 形式的图片上传接口。
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

  // 查询批量 VLM 任务状态。
  if (req.method === 'GET' && url.pathname === '/api/vlm/auto-status') {
    sendJson(res, 200, { ok: true, job: autoVlmJob });
    return;
  }

  // 对某条记录手动触发一次 VLM 推理。
  if (req.method === 'POST' && url.pathname.startsWith('/api/vlm/')) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    try {
      const vlm = await runVlm(reviewId);
      const local = upsertLocalRecord(reviewId, { vlm });
      const ok = vlm.status !== 'failed';
      sendJson(res, ok ? 200 : 422, { ok, record: local, vlm });
    } catch (error) {
      const vlm = {
        status: 'failed',
        model: VLM_MODEL,
        endpoint: VLM_ENDPOINT,
        prompt_version: VLM_PROMPT_VERSION,
        error: error.message || String(error),
        updated_at: new Date().toISOString(),
      };
      const local = upsertLocalRecord(reviewId, { vlm });
      sendJson(res, 500, { ok: false, record: local, vlm });
    }
    return;
  }

  // 保存人工标注，并尝试同步人工反馈。
  if (req.method === 'POST' && url.pathname.startsWith('/api/annotations/')) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    const body = JSON.parse(await readBody(req) || '{}');
    const data = readData();
    data.records = data.records || {};
    const current = data.records[reviewId] || {};
    const requestHasVersion = Object.prototype.hasOwnProperty.call(body, 'base_updated_at');
    const baseUpdatedAt = body.base_updated_at || '';
    const currentUpdatedAt = current.updated_at || '';
    if (!body.force && requestHasVersion && baseUpdatedAt !== currentUpdatedAt) {
      sendJson(res, 409, {
        ok: false,
        message: '该图片已被其他人更新，请刷新后重试，或确认覆盖最新标注。',
        record: current,
      });
      return;
    }
    const existingAnnotation = current.annotation || {};
    const annotation = {
      ...existingAnnotation,
      human_result: body.human_result || '',
      model_result: body.model_result || '',
      sample_validity: body.sample_validity || 'valid',
      attribution_branch: body.attribution_branch || '',
      attribution_reason: body.attribution_reason || '',
      note: body.note || '',
      object_tag: String(body.object_tag || '').trim().slice(0, 32),
      updated_at: new Date().toISOString(),
    };
    const local = upsertLocalRecordInData(data, reviewId, { annotation });
    writeData(data);
    try {
      const feedbackSync = await syncPickVerifierFeedback(reviewId, local, annotation);
      const latest = readData();
      upsertLocalRecordInData(latest, reviewId, { feedback_sync: feedbackSync });
      writeData(latest);
      local.feedback_sync = feedbackSync;
    } catch (error) {
      const feedbackSync = {
        status: 'failed',
        error: error.message || String(error),
        updated_at: new Date().toISOString(),
      };
      const latest = readData();
      upsertLocalRecordInData(latest, reviewId, { feedback_sync: feedbackSync });
      writeData(latest);
      local.feedback_sync = feedbackSync;
    }
    sendJson(res, 200, { ok: true, record: local });
    return;
  }

  sendJson(res, 404, { ok: false, message: '接口不存在' });
}

// 创建 HTTP 服务。API、实时页面、静态 HTML 和本地图片都由这个服务提供。
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      // 读取 local_images 目录下的图片文件。
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

    // 代理实时页面，并把页面里的图片地址改成本服务代理地址。
    if (url.pathname === '/realtime' || url.pathname === '/realtime/') {
      const upstream = await fetchRealtimePage();
      const html = (await upstream.text())
        .replaceAll('"/api/realtime-proxy/frame?camera=', '"/api/realtime-proxy/frame?camera=')
        .replaceAll('"/frame?camera=', '"/api/realtime-proxy/frame?camera=');
      sendText(res, 200, html, upstream.headers.get('content-type') || 'text/html; charset=utf-8');
      return;
    }

    // 返回评估平台前端 HTML。
    if (url.pathname === '/' || url.pathname === '/gripper_eval.html') {
      sendText(res, 200, fs.readFileSync(HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message || String(error) });
  }
});

// 启动服务。默认监听 0.0.0.0:5034。
server.listen(PORT, HOST, () => {
  console.log(`夹爪评估平台已启动：http://${HOST}:${PORT}`);
});
