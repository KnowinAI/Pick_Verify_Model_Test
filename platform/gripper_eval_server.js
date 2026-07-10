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
const zlib = require('zlib');
const samplePool = require('./sample_pool');
const bmSnapshot = require('./bm_snapshot');
const modelRun = require('./model_run');
const { ANNOTATION_SCHEMA } = require('./annotation_schema');

// 评测 run 图片可用的「标注项筛选」字段（与标注页一致：非系统的 select / multi 字段）。
// run 预测明细里默认没有标注属性，详情接口按 sample_id 关联补上这些字段，供前端按标注筛选评测图片。
const RUN_ANN_FILTER_KEYS = ANNOTATION_SCHEMA
  .filter((f) => !f.system && (f.type === 'select' || f.type === 'multi'))
  .map((f) => f.key);

// 给一组预测明细按 sample_id 关联标注，挂上 p.ann（只含可筛选字段，空值不带）。非破坏性，只读标注。
function attachAnnotationsToPredictions(predictions) {
  let annotations;
  try { annotations = samplePool.loadAnnotations(); } catch (e) { annotations = new Map(); }
  for (const p of predictions) {
    const ann = annotations.get(p.sample_id) || null;
    const out = {};
    if (ann) {
      for (const key of RUN_ANN_FILTER_KEYS) {
        const v = ann[key];
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) { if (v.length) out[key] = v; }
        else if (String(v) !== '') out[key] = v;
      }
    }
    p.ann = out;
  }
}

// 服务基础配置。大多数配置支持通过环境变量覆盖。
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 5034);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;
const SOURCE_BASE_URL = process.env.SOURCE_BASE_URL || 'http://101.132.143.105:5022';
const DEFAULT_REALTIME_BASE_URLS = [
  'http://192.168.127.10:9002',
  'http://127.0.0.1:5033',
  'http://192.168.78.168:5033',
  'http://192.168.78.168:9002',
];
const REALTIME_FETCH_TIMEOUT_MS = Number(process.env.REALTIME_FETCH_TIMEOUT_MS || 1500);
const REALTIME_FAILURE_COOLDOWN_MS = Number(process.env.REALTIME_FAILURE_COOLDOWN_MS || 15000);
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
const VLM_BATCH_MAX_IDS = Number(process.env.VLM_BATCH_MAX_IDS || 5000);
const VLM_BATCH_RECENT_RESULT_LIMIT = 80;
const DATA_PATH = path.join(__dirname, 'gripper_eval_data.json');
const SAMPLE_POOL_HTML_PATH = path.join(__dirname, 'sample_pool.html');
const LABEL_HTML_PATH = path.join(__dirname, 'gripper_label.html');
const BM_HTML_PATH = path.join(__dirname, 'gripper_bm.html');
const RUNS_HTML_PATH = path.join(__dirname, 'gripper_runs.html');
const ANNOTATION_SCHEMA_PATH = path.join(__dirname, 'annotation_schema.js');
const LOCAL_IMAGE_DIR = path.join(__dirname, '..', 'local_images');
const DEFAULT_RECORD_LIMIT = 5000;
const MAX_RECORD_LIMIT = 20000;
const IMAGE_CONTENT_TYPES = {
  '.bmp': 'image/bmp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const ANNOTATION_PACKAGE_MANIFEST = 'pick-verify-manifest.json';
const ANNOTATION_PACKAGE_VERSION = 1;
const MANUAL_ANNOTATION_FIELDS = [
  'human_result',
  'sample_validity',
  'object_tag',
  'object_tags',
  'gripper_orientation',
  'grasp_depth',
  'background_tag',
  'object_color',
  'attribution_branch',
  'attribution_reason',
  'note',
];

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
const realtimeBaseFailures = new Map();
let realtimeLastGoodBaseUrl = '';

// 给视觉语言模型的提示词。要求模型只输出 G 或 N。
const PROMPT = `判断机器人夹爪是否夹住了物体。只能输出下面一个字母，不要输出解释：
G：夹住，夹爪当前夹住了物体。
N：没夹住，夹爪当前没有夹住物体。`;

const vlmBatchJob = {
  running: false,
  started_at: '',
  updated_at: '',
  finished_at: '',
  total: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  current_id: '',
  message: '未运行批量 VLM 推理',
  results: [],
};

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

const DEFAULT_LABEL_OPTIONS = {
  gripper_orientation: ['正向', '侧向', '背向', '遮挡', '无法判断'],
  grasp_depth: ['浅', '中', '深', '无法判断'],
  background_tag: ['桌面', '料框', '输送线', '夹具', '混杂背景'],
  object_color: ['红', '橙', '黄', '绿', '蓝', '紫', '黑', '白', '透明', '金属', '多色'],
};

// 初始化本地数据结构。records 存图片和标注，custom_reason_options 存自定义归因原因。
function defaultData() {
  return {
    version: 1,
    records: {},
    custom_reason_options: {},
    label_options: DEFAULT_LABEL_OPTIONS,
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

function normalizeStringList(value, maxLength = 40, maxItems = 500) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[、,，|]/);
  const seen = new Set();
  const result = [];
  for (const rawItem of rawItems) {
    const item = String(rawItem || '').trim().slice(0, maxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeLabelOptions(value = {}) {
  const result = {};
  const merged = { ...DEFAULT_LABEL_OPTIONS, ...(value && typeof value === 'object' ? value : {}) };
  for (const key of Object.keys(DEFAULT_LABEL_OPTIONS)) {
    result[key] = normalizeStringList(merged[key], 40, 500);
  }
  return result;
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

function makeShortId() {
  return Math.random().toString(36).slice(2, 8);
}

function getUploadStoredFilename(body, fallbackFilename) {
  const metadata = body && body.source_metadata && typeof body.source_metadata === 'object'
    ? body.source_metadata
    : {};
  const filename = metadata.original_name || fallbackFilename || body.filename || body.source_id || 'image.jpg';
  return path.basename(String(filename).replace(/\\/g, '/')).trim();
}

function localImageFileMatches(filename, buffer) {
  const filepath = path.join(LOCAL_IMAGE_DIR, filename);
  if (!fs.existsSync(filepath)) return false;
  const existing = fs.readFileSync(filepath);
  return existing.length === buffer.length && existing.equals(buffer);
}

function findLocalImageDuplicate(buffer) {
  ensureLocalImageDir();
  const incomingDigest = crypto.createHash('sha1').update(buffer).digest('hex');
  const files = fs.readdirSync(LOCAL_IMAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_CONTENT_TYPES[path.extname(entry.name).toLowerCase()]);
  for (const entry of files) {
    const filepath = path.join(LOCAL_IMAGE_DIR, entry.name);
    try {
      const stat = fs.statSync(filepath);
      if (stat.size !== buffer.length) continue;
      const digest = crypto.createHash('sha1').update(fs.readFileSync(filepath)).digest('hex');
      if (digest === incomingDigest) return entry.name;
    } catch {
      // 跳过临时不可读文件，不阻断上传。
    }
  }
  return '';
}

function findMergedRecordByFilename(filename) {
  const data = syncLocalImagesToData(readData());
  const localRecord = Object.entries(data.records || {})
    .find(([, record]) => getRecordFilename(record) === filename);
  if (!localRecord) return null;
  const [id, local] = localRecord;
  return mergeRecord(local.local_source || {}, { id, ...local });
}

function buildUploadLocalSource(body, id, filename, contentType) {
  const localSource = makeLocalSourceRecord({
    id,
    filename,
    contentType,
    cameraId: body.camera_id ?? null,
    cameraLabel: body.camera_label || 'upload',
  });
  if (body.captured_at) {
    localSource.created_at = body.captured_at;
  }
  if (body.source_metadata && typeof body.source_metadata === 'object') {
    localSource.source_metadata = {
      ...localSource.source_metadata,
      ...body.source_metadata,
    };
  }
  applyRealtimeFilenameMetadata(localSource, [
    filename,
    body.filename,
    body.source_id,
    body.source_metadata && body.source_metadata.original_name,
    body.source_metadata && body.source_metadata.relative_path,
  ]);
  return localSource;
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
  const baseName = path.basename(String(filename || '').replace(/\\/g, '/'));
  const match = /(?:^|_)(realtime_)?cam([01])_(\d{14})(?:_([^.]+))?\.(?:jpe?g|png|webp|gif)$/i.exec(baseName);
  if (!match) return null;
  return {
    cameraId: Number(match[2]),
    timestamp: match[3],
    pairSuffix: match[4] || '',
    legacyRealtime: Boolean(match[1]),
  };
}

function applyRealtimeFilenameMetadata(localSource, filenames) {
  if (!localSource) return localSource;
  if (!localSource.source_metadata) localSource.source_metadata = {};
  const parsed = (Array.isArray(filenames) ? filenames : [filenames])
    .map(parseRealtimeFilename)
    .find(Boolean);
  if (!parsed) return localSource;

  const metadata = localSource.source_metadata;
  metadata.camera_id = parsed.cameraId;
  metadata.camera_label = parsed.cameraId === 1 ? 'left' : 'right';
  metadata.capture_timestamp = parsed.timestamp;
  metadata.evaluate = parsed.cameraId === 1;
  metadata.group_role = parsed.cameraId === 1 ? 'evaluation' : 'reference';
  return localSource;
}

// 对同一时间戳的 cam0 和 cam1 图片补充分组信息。cam1 参与评估，cam0 作为参考。
function updateRealtimePairMetadata(data) {
  const groups = new Map();
  const timestampGroups = new Map();
  const pushGroupItem = (map, key, item) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };

  for (const [id, record] of Object.entries(data.records || {})) {
    if (!record || record.deleted || !record.local_source) continue;
    const parsed = parseRealtimeFilename(getRecordFilename(record) || '');
    if (!parsed) continue;
    const metadata = record.local_source.source_metadata || {};
    const item = { id, record, ...parsed };
    if (metadata.capture_group_id) {
      pushGroupItem(groups, `group:${metadata.capture_group_id}`, item);
    } else {
      pushGroupItem(timestampGroups, parsed.timestamp, item);
    }
  }

  for (const [timestamp, items] of timestampGroups.entries()) {
    const cam0Count = items.filter((item) => item.cameraId === 0).length;
    const cam1Count = items.filter((item) => item.cameraId === 1).length;
    if (cam0Count <= 1 && cam1Count <= 1) {
      groups.set(`timestamp:${timestamp}`, items);
      continue;
    }
    const suffixGroups = new Map();
    for (const item of items) {
      const suffixKey = item.pairSuffix
        ? `timestamp_suffix:${timestamp}_${item.pairSuffix}`
        : `timestamp:${timestamp}`;
      pushGroupItem(suffixGroups, suffixKey, item);
    }
    for (const [suffixKey, suffixItems] of suffixGroups.entries()) {
      groups.set(suffixKey, suffixItems);
    }
  }

  let updated = 0;
  for (const items of groups.values()) {
    const cam0 = items.find((item) => item.cameraId === 0);
    const cam1 = items.find((item) => item.cameraId === 1);
    if (!cam0 || !cam1) continue;
    const sharedPairSuffix = items[0].pairSuffix
      && items.every((item) => item.pairSuffix === items[0].pairSuffix)
      ? items[0].pairSuffix
      : '';
    const captureGroupId = cam0.record.local_source.source_metadata?.capture_group_id
      || cam1.record.local_source.source_metadata?.capture_group_id
      || (sharedPairSuffix
        ? `capture_group_${items[0].timestamp}_${sharedPairSuffix}`
        : `capture_group_${items[0].timestamp}`);
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
        capture_timestamp: item.timestamp,
        group_record_ids: pairIds,
        paired_record_id: paired.id,
        evaluate: item.cameraId === 1,
        group_role: item.cameraId === 1 ? 'evaluation' : 'reference',
      };
      if (sharedPairSuffix || metadata.pair_suffix) {
        nextMetadata.pair_suffix = sharedPairSuffix || metadata.pair_suffix;
      }
      if (JSON.stringify(metadata) !== JSON.stringify(nextMetadata)) {
        source.source_metadata = nextMetadata;
        item.record.updated_at = new Date().toISOString();
        updated += 1;
      }
    }
  }
  return updated;
}

function updateRealtimePairMetadataOnDisk() {
  const data = readData();
  const updated = updateRealtimePairMetadata(data);
  if (updated) writeData(data);
  return updated;
}

function normalizeRealtimeFilenameMetadata(data) {
  let updated = 0;
  const updatedAt = new Date().toISOString();
  for (const record of Object.values(data.records || {})) {
    if (!record || record.deleted || !record.local_source) continue;
    const source = record.local_source;
    const before = JSON.stringify(source.source_metadata || {});
    applyRealtimeFilenameMetadata(source, [
      getRecordFilename(record),
      source.source_id,
      source.original_filename,
      source.stored_filename,
    ]);
    if (before !== JSON.stringify(source.source_metadata || {})) {
      record.updated_at = updatedAt;
      updated += 1;
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
  let normalizedMetadata = 0;
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
  normalizedMetadata = normalizeRealtimeFilenameMetadata(data);

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
    applyRealtimeFilenameMetadata(localSource, filename);
    data.records[id] = {
      local_source: localSource,
      updated_at: new Date().toISOString(),
    };
    knownFilenames.add(filename);
    added += 1;
  }
  const paired = updateRealtimePairMetadata(data);

  if (added || restored || removedDuplicates || normalizedMetadata || paired) {
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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function getZipDosDateTime(dateValue) {
  const date = dateValue instanceof Date && !Number.isNaN(dateValue.getTime()) ? dateValue : new Date();
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function makeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const dataBuffer = Buffer.isBuffer(entry.buffer) ? entry.buffer : Buffer.from(entry.buffer || '');
    const checksum = crc32(dataBuffer);
    const { time, date } = getZipDosDateTime(entry.mtime);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(entries.length, 8);
  endHeader.writeUInt16LE(entries.length, 10);
  endHeader.writeUInt32LE(centralSize, 12);
  endHeader.writeUInt32LE(centralOffset, 16);
  endHeader.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, endHeader]);
}

function getRecordDownloadFilename(record) {
  const metadata = (record && record.source_metadata) || {};
  const candidates = [
    record && record.stored_filename,
    record && record.original_filename,
    record && record.source_id,
    metadata.original_name,
    metadata.relative_path,
    record && record.image_url,
    record && record.id,
  ];
  for (const value of candidates) {
    const filename = path.basename(String(value || '').replace(/\\/g, '/').split(/[?#]/)[0]).trim();
    if (filename) return filename;
  }
  return 'image.jpg';
}

function sanitizeZipEntryName(filename) {
  const clean = path.basename(String(filename || '').replace(/\\/g, '/'))
    .replace(/[<>:"\\|?*\x00-\x1f]/g, '_')
    .trim();
  return clean || 'image.jpg';
}

function makeZipEntryName(filename, recordId, usedNames) {
  const clean = sanitizeZipEntryName(filename);
  let entryName = clean;
  if (usedNames.has(entryName.toLowerCase())) {
    const safeId = String(recordId || 'record').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96) || 'record';
    entryName = `${safeId}/${clean}`;
    let index = 2;
    while (usedNames.has(entryName.toLowerCase())) {
      entryName = `${safeId}_${index}/${clean}`;
      index += 1;
    }
  }
  usedNames.add(entryName.toLowerCase());
  return entryName;
}

function sha1Hex(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function normalizePackageString(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizePackageTags(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[、,，]/);
  const seen = new Set();
  const result = [];
  for (const rawItem of items) {
    const item = normalizePackageString(rawItem, 32);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= 32) break;
  }
  return result;
}

function pickManualAnnotation(annotation = {}, updatedAt = '') {
  const objectTags = normalizePackageTags(annotation.object_tags);
  const objectTag = normalizePackageString(annotation.object_tag || objectTags[0], 32);
  if (!objectTags.length && objectTag) objectTags.push(objectTag);
  const result = {
    human_result: normalizePackageString(annotation.human_result, 40),
    sample_validity: normalizePackageString(annotation.sample_validity || 'valid', 40),
    object_tag: objectTag,
    object_tags: objectTags,
    gripper_orientation: normalizePackageString(annotation.gripper_orientation, 40),
    grasp_depth: normalizePackageString(annotation.grasp_depth, 40),
    background_tag: normalizePackageString(annotation.background_tag, 40),
    object_color: normalizePackageString(annotation.object_color, 40),
    attribution_branch: normalizePackageString(annotation.attribution_branch, 40),
    attribution_reason: normalizePackageString(annotation.attribution_reason, 200),
    note: normalizePackageString(annotation.note, 1000),
  };
  if (updatedAt) result.updated_at = updatedAt;
  return result;
}

function getRecordPackagePairInfo(record) {
  const metadata = (record && record.source_metadata) || {};
  const parsed = parseRealtimeFilename(
    (record && (record.stored_filename || record.original_filename || record.source_id)) || '',
  );
  return {
    cameraId: metadata.camera_id === undefined || metadata.camera_id === null || metadata.camera_id === ''
      ? (parsed ? parsed.cameraId : null)
      : Number(metadata.camera_id),
    captureGroupId: normalizePackageString(metadata.capture_group_id, 120),
    captureTimestamp: normalizePackageString(metadata.capture_timestamp || (parsed && parsed.timestamp), 40),
    pairSuffix: normalizePackageString(metadata.pair_suffix || (parsed && parsed.pairSuffix), 80),
  };
}

function buildAnnotationPackageManifestRecord(record, entryName, buffer) {
  const metadata = (record && record.source_metadata) || {};
  const pairInfo = getRecordPackagePairInfo(record);
  return {
    id: normalizePackageString(record && record.id, 160),
    image_entry: entryName,
    filename: getRecordDownloadFilename(record),
    original_filename: normalizePackageString(record && record.original_filename, 260),
    stored_filename: normalizePackageString(record && record.stored_filename, 260),
    source_id: normalizePackageString(record && record.source_id, 260),
    relative_path: normalizePackageString(metadata.relative_path, 500),
    camera_id: pairInfo.cameraId,
    capture_group_id: pairInfo.captureGroupId,
    capture_timestamp: pairInfo.captureTimestamp,
    pair_suffix: pairInfo.pairSuffix,
    content_sha1: sha1Hex(buffer),
    annotation: pickManualAnnotation((record && record.annotation) || {}),
  };
}

function buildDownloadZip(data, ids) {
  const entries = [];
  const manifestRecords = [];
  const missing = [];
  const usedNames = new Set();
  const seenIds = new Set();
  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const local = data.records && data.records[id];
    if (!local) {
      missing.push(id);
      continue;
    }
    const record = mergeRecord(local.local_source || {}, { id, ...local });
    const localFilename = getLocalImageFilename(record.image_url);
    const filePath = path.resolve(LOCAL_IMAGE_DIR, localFilename);
    const imageDir = path.resolve(LOCAL_IMAGE_DIR);
    if (!localFilename || !filePath.startsWith(`${imageDir}${path.sep}`) || !fs.existsSync(filePath)) {
      missing.push(id);
      continue;
    }
    const stat = fs.statSync(filePath);
    const filename = getRecordDownloadFilename(record);
    const buffer = fs.readFileSync(filePath);
    const entryName = makeZipEntryName(filename, id, usedNames);
    entries.push({
      name: entryName,
      buffer,
      mtime: stat.mtime,
    });
    manifestRecords.push(buildAnnotationPackageManifestRecord(record, entryName, buffer));
  }
  if (entries.length) {
    const manifest = {
      schema: 'pick-verify-annotation-package',
      version: ANNOTATION_PACKAGE_VERSION,
      exported_at: new Date().toISOString(),
      record_count: manifestRecords.length,
      annotation_fields: MANUAL_ANNOTATION_FIELDS,
      records: manifestRecords,
    };
    entries.push({
      name: ANNOTATION_PACKAGE_MANIFEST,
      buffer: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      mtime: new Date(),
    });
  }
  return {
    zip: makeStoredZip(entries),
    entryCount: manifestRecords.length,
    zipEntryCount: entries.length,
    missingCount: missing.length,
  };
}

function findZipEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function normalizeZipEntryName(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized || normalized.endsWith('/') || normalized.includes('\0')) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..' || /^[A-Za-z]:$/.test(part))) return '';
  return parts.join('/');
}

function parseZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('ZIP 文件为空或格式无效');
  }
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error('未找到 ZIP 中央目录');
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 标注包');
    }
    const nameBuffer = buffer.subarray(offset + 46, offset + 46 + fileNameLength);
    const rawName = nameBuffer.toString(flags & 0x0800 ? 'utf8' : 'utf8');
    const name = normalizeZipEntryName(rawName);
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (!name) continue;
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头损坏：${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP 文件内容损坏：${name}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let entryBuffer;
    if (method === 0) {
      entryBuffer = Buffer.from(compressed);
    } else if (method === 8) {
      entryBuffer = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`暂不支持 ZIP 压缩方式 ${method}：${name}`);
    }
    if (uncompressedSize !== entryBuffer.length) {
      throw new Error(`ZIP 文件大小校验失败：${name}`);
    }
    entries.push({ name, buffer: entryBuffer });
  }
  return entries;
}

function getAnnotationPackageManifest(entries) {
  const manifestEntry = entries.find((entry) => path.basename(entry.name) === ANNOTATION_PACKAGE_MANIFEST);
  if (!manifestEntry) throw new Error(`ZIP 中缺少 ${ANNOTATION_PACKAGE_MANIFEST}`);
  const manifest = JSON.parse(manifestEntry.buffer.toString('utf8'));
  if (!manifest || manifest.schema !== 'pick-verify-annotation-package' || !Array.isArray(manifest.records)) {
    throw new Error('标注 manifest 格式无效');
  }
  return manifest;
}

function findLocalRecordIdByFilenameInData(data, filename) {
  const clean = path.basename(String(filename || '').replace(/\\/g, '/'));
  if (!clean) return '';
  for (const [id, record] of Object.entries(data.records || {})) {
    if (!record || record.deleted || !record.local_source) continue;
    if (path.basename(getRecordFilename(record) || '') === clean) return id;
  }
  return '';
}

function addPackageIndexEntry(index, id, record, contentSha1 = '') {
  if (!id || !record || !record.local_source) return;
  const source = record.local_source;
  const filename = path.basename(getRecordFilename(record) || '');
  const metadata = source.source_metadata || {};
  const parsed = parseRealtimeFilename(filename);
  const cameraId = metadata.camera_id === undefined || metadata.camera_id === null || metadata.camera_id === ''
    ? (parsed ? parsed.cameraId : null)
    : Number(metadata.camera_id);
  const captureTimestamp = metadata.capture_timestamp || (parsed && parsed.timestamp) || '';
  const pairSuffix = metadata.pair_suffix || (parsed && parsed.pairSuffix) || '';
  if (contentSha1) index.byHash.set(contentSha1, id);
  if (filename) index.byFilename.set(filename.toLowerCase(), id);
  if (metadata.capture_group_id) {
    const key = `${metadata.capture_group_id}::${cameraId === null ? '' : cameraId}`;
    if (!index.byGroup.has(key)) index.byGroup.set(key, id);
  }
  if (captureTimestamp && pairSuffix) {
    const key = `${captureTimestamp}_${pairSuffix}::${cameraId === null ? '' : cameraId}`;
    if (!index.byPairKey.has(key)) index.byPairKey.set(key, id);
  }
}

function buildPackageImportIndex(data) {
  const index = {
    byHash: new Map(),
    byFilename: new Map(),
    byGroup: new Map(),
    byPairKey: new Map(),
  };
  ensureLocalImageDir();
  for (const [id, record] of Object.entries(data.records || {})) {
    if (!record || record.deleted || !record.local_source) continue;
    const filename = path.basename(getRecordFilename(record) || '');
    let contentSha1 = '';
    if (filename) {
      const filepath = path.join(LOCAL_IMAGE_DIR, filename);
      try {
        if (fs.existsSync(filepath)) contentSha1 = sha1Hex(fs.readFileSync(filepath));
      } catch {
        contentSha1 = '';
      }
    }
    addPackageIndexEntry(index, id, record, contentSha1);
  }
  return index;
}

function getManifestCameraId(item) {
  const value = item && item.camera_id;
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  const filenameCandidates = [
    item && item.stored_filename,
    item && item.original_filename,
    item && item.filename,
    item && item.source_id,
    item && item.relative_path,
    item && item.image_entry,
  ];
  for (const filename of filenameCandidates) {
    const parsed = parseRealtimeFilename(filename);
    if (parsed) return parsed.cameraId;
  }
  return null;
}

function findPackageRecordByGroupOrPair(index, item, cameraId) {
  if (!index || !item) return '';
  const normalizedCameraId = cameraId === null || cameraId === undefined ? '' : Number(cameraId);
  const groupId = normalizePackageString(item.capture_group_id, 120);
  if (groupId) {
    const exact = index.byGroup.get(`${groupId}::${normalizedCameraId}`);
    if (exact) return exact;
  }
  const captureTimestamp = normalizePackageString(item.capture_timestamp, 40);
  const pairSuffix = normalizePackageString(item.pair_suffix, 80);
  if (captureTimestamp && pairSuffix) {
    const exact = index.byPairKey.get(`${captureTimestamp}_${pairSuffix}::${normalizedCameraId}`);
    if (exact) return exact;
  }
  return '';
}

function findPackageRecordMatch(data, index, item, contentSha1 = '') {
  if (contentSha1 && index.byHash.has(contentSha1)) return index.byHash.get(contentSha1);
  const filenames = [
    item && item.stored_filename,
    item && item.original_filename,
    item && item.filename,
    item && item.source_id,
    item && item.relative_path,
    item && item.image_entry,
  ];
  for (const rawFilename of filenames) {
    const filename = path.basename(String(rawFilename || '').replace(/\\/g, '/'));
    if (filename && index.byFilename.has(filename.toLowerCase())) return index.byFilename.get(filename.toLowerCase());
  }
  const cameraId = getManifestCameraId(item);
  const groupId = normalizePackageString(item && item.capture_group_id, 120);
  if (groupId) {
    const exact = index.byGroup.get(`${groupId}::${cameraId === null ? '' : cameraId}`);
    if (exact) return exact;
    for (const [key, id] of index.byGroup.entries()) {
      if (key.startsWith(`${groupId}::`)) return id;
    }
  }
  const captureTimestamp = normalizePackageString(item && item.capture_timestamp, 40);
  const pairSuffix = normalizePackageString(item && item.pair_suffix, 80);
  if (captureTimestamp && pairSuffix) {
    const exact = index.byPairKey.get(`${captureTimestamp}_${pairSuffix}::${cameraId === null ? '' : cameraId}`);
    if (exact) return exact;
    for (const [key, id] of index.byPairKey.entries()) {
      if (key.startsWith(`${captureTimestamp}_${pairSuffix}::`)) return id;
    }
  }
  return '';
}

function findPackageImageRecordMatch(index, item, contentSha1 = '') {
  if (contentSha1 && index.byHash.has(contentSha1)) return index.byHash.get(contentSha1);
  const filenames = [
    item && item.stored_filename,
    item && item.original_filename,
    item && item.filename,
    item && item.source_id,
    item && item.relative_path,
    item && item.image_entry,
  ];
  for (const rawFilename of filenames) {
    const filename = path.basename(String(rawFilename || '').replace(/\\/g, '/'));
    if (filename && index.byFilename.has(filename.toLowerCase())) return index.byFilename.get(filename.toLowerCase());
  }
  const cameraId = getManifestCameraId(item);
  return findPackageRecordByGroupOrPair(index, item, cameraId);
}

function getPackagePreferredFilename(item, imageEntryName) {
  const candidates = [
    item && item.stored_filename,
    item && item.original_filename,
    item && item.filename,
    item && item.source_id,
    imageEntryName,
  ];
  for (const candidate of candidates) {
    const filename = path.basename(String(candidate || '').replace(/\\/g, '/'))
      .replace(/[<>:"\\|?*\x00-\x1f]/g, '_')
      .trim();
    if (filename) return filename;
  }
  return 'image.jpg';
}

function makeUniquePackageRecordId(data, filename) {
  const base = `upload_${path.basename(filename, path.extname(filename)).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image'}`;
  let id = base;
  let suffix = 2;
  while (data.records[id]) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function mergePackageIdentityIntoLocalSource(localSource, item, contentSha1) {
  if (!localSource) return localSource;
  if (!localSource.source_metadata) localSource.source_metadata = {};
  const metadata = localSource.source_metadata;
  const cameraId = getManifestCameraId(item);
  if (cameraId !== null && (metadata.camera_id === undefined || metadata.camera_id === null || metadata.camera_id === '')) {
    metadata.camera_id = cameraId;
    metadata.camera_label = cameraId === 1 ? 'left' : 'right';
    metadata.evaluate = cameraId === 1;
    metadata.group_role = cameraId === 1 ? 'evaluation' : 'reference';
  }
  if (item.capture_group_id && !metadata.capture_group_id) metadata.capture_group_id = normalizePackageString(item.capture_group_id, 120);
  if (item.capture_timestamp && !metadata.capture_timestamp) metadata.capture_timestamp = normalizePackageString(item.capture_timestamp, 40);
  if (item.pair_suffix && !metadata.pair_suffix) metadata.pair_suffix = normalizePackageString(item.pair_suffix, 80);
  if (item.relative_path && !metadata.relative_path) metadata.relative_path = normalizePackageString(item.relative_path, 500);
  if (item.original_filename && !metadata.original_name) metadata.original_name = normalizePackageString(item.original_filename, 260);
  if (contentSha1 && !metadata.content_sha1) metadata.content_sha1 = contentSha1;
  metadata.source = metadata.source || 'annotation_package_import';
  return localSource;
}

function upsertPackageImageRecord(data, index, item, imageEntry) {
  const buffer = imageEntry && imageEntry.buffer;
  if (!buffer || !buffer.length) return { recordId: '', status: 'missing', message: '图片内容为空' };
  const contentSha1 = sha1Hex(buffer);
  if (item.content_sha1 && normalizePackageString(item.content_sha1, 80) !== contentSha1) {
    return { recordId: '', status: 'failed', message: '图片 SHA1 与 manifest 不一致' };
  }
  let recordId = findPackageImageRecordMatch(index, item, contentSha1);
  if (recordId) {
    const current = data.records[recordId];
    if (current && current.local_source) {
      const currentFilename = path.basename(getRecordFilename(current) || getPackagePreferredFilename(item, imageEntry.name));
      if (!currentFilename) {
        return { recordId: '', status: 'failed', message: 'Cannot determine image filename' };
      }
      const currentFilepath = path.join(LOCAL_IMAGE_DIR, currentFilename);
      const fileExisted = fs.existsSync(currentFilepath);
      if (fileExisted) {
        if (!localImageFileMatches(currentFilename, buffer)) {
          return { recordId: '', status: 'failed', message: `Existing image has different content: ${currentFilename}` };
        }
      } else {
        fs.writeFileSync(currentFilepath, buffer);
      }
      current.local_source = mergePackageIdentityIntoLocalSource(current.local_source, item, contentSha1);
      addPackageIndexEntry(index, recordId, current, contentSha1);
      return { recordId, status: fileExisted ? 'reused' : 'saved', message: '' };
    }
  }

  const storedFilename = getPackagePreferredFilename(item, imageEntry.name);
  const filepath = path.join(LOCAL_IMAGE_DIR, storedFilename);
  if (fs.existsSync(filepath) && !localImageFileMatches(storedFilename, buffer)) {
    return { recordId: '', status: 'failed', message: `同名图片已存在且内容不同：${storedFilename}` };
  }
  const savedNewImage = !fs.existsSync(filepath);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, buffer);
  }
  recordId = findLocalRecordIdByFilenameInData(data, storedFilename);
  if (!recordId) {
    recordId = makeUniquePackageRecordId(data, storedFilename);
    const localSource = buildUploadLocalSource({
      filename: storedFilename,
      content_type: getImageContentType(storedFilename),
      source_id: item.source_id || storedFilename,
      camera_id: getManifestCameraId(item),
      camera_label: getManifestCameraId(item) === 1 ? 'left' : getManifestCameraId(item) === 0 ? 'right' : 'package_upload',
      source_metadata: {
        source: 'annotation_package_import',
        original_name: item.original_filename || item.filename || storedFilename,
        relative_path: item.relative_path || item.image_entry || storedFilename,
        capture_group_id: item.capture_group_id || '',
        capture_timestamp: item.capture_timestamp || '',
        pair_suffix: item.pair_suffix || '',
        content_sha1: contentSha1,
      },
    }, recordId, storedFilename, getImageContentType(storedFilename));
    data.records[recordId] = {
      local_source: mergePackageIdentityIntoLocalSource(localSource, item, contentSha1),
      updated_at: new Date().toISOString(),
    };
    addPackageIndexEntry(index, recordId, data.records[recordId], contentSha1);
    return { recordId, status: savedNewImage ? 'saved' : 'reused', message: '' };
  }
  data.records[recordId].local_source = mergePackageIdentityIntoLocalSource(
    data.records[recordId].local_source,
    item,
    contentSha1,
  );
  addPackageIndexEntry(index, recordId, data.records[recordId], contentSha1);
  return { recordId, status: 'reused', message: '' };
}

function findPackageImageEntry(entriesByName, entriesByBasename, item) {
  const candidates = [
    item && item.image_entry,
    item && item.stored_filename,
    item && item.original_filename,
    item && item.filename,
    item && item.source_id,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeZipEntryName(candidate);
    if (normalized && entriesByName.has(normalized.toLowerCase())) {
      return entriesByName.get(normalized.toLowerCase());
    }
    const basename = path.basename(String(candidate || '').replace(/\\/g, '/')).toLowerCase();
    if (basename && entriesByBasename.has(basename)) {
      return entriesByBasename.get(basename);
    }
  }
  return null;
}

function replacePackageCameraName(value, targetCameraId) {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text) return '';
  if (/realtime_cam[01]_/i.test(text)) {
    return text.replace(/realtime_cam[01]_/i, `realtime_cam${targetCameraId}_`);
  }
  if (/cam[01]_/i.test(text)) {
    return text.replace(/cam[01]_/i, `cam${targetCameraId}_`);
  }
  return '';
}

function findPackageSiblingImageEntry(entriesByName, entriesByBasename, item, targetCameraId) {
  const candidates = [
    item && item.image_entry,
    item && item.stored_filename,
    item && item.original_filename,
    item && item.filename,
    item && item.source_id,
    item && item.relative_path,
  ];
  for (const candidate of candidates) {
    const siblingName = normalizeZipEntryName(replacePackageCameraName(candidate, targetCameraId));
    if (siblingName && entriesByName.has(siblingName.toLowerCase())) {
      return entriesByName.get(siblingName.toLowerCase());
    }
    const siblingBasename = path.basename(siblingName || '').toLowerCase();
    if (siblingBasename && entriesByBasename.has(siblingBasename)) {
      return entriesByBasename.get(siblingBasename);
    }
  }
  return null;
}

function makeSiblingPackageItem(item, imageEntry, targetCameraId) {
  const basename = path.basename(String((imageEntry && imageEntry.name) || '').replace(/\\/g, '/'));
  return {
    ...item,
    camera_id: targetCameraId,
    image_entry: imageEntry && imageEntry.name,
    filename: basename,
    original_filename: basename,
    stored_filename: basename,
    source_id: basename,
    content_sha1: '',
  };
}

function hasPackageManualAnnotation(item) {
  const annotation = (item && item.annotation) || {};
  return MANUAL_ANNOTATION_FIELDS.some((field) => {
    const value = annotation[field];
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

function findPackageEvaluationRecordId(data, index, item, ownRecordId = '') {
  const pairedEvaluationId = findPackageRecordByGroupOrPair(index, item, 1);
  if (pairedEvaluationId) return pairedEvaluationId;
  if (ownRecordId) {
    const ownRecord = data.records && data.records[ownRecordId];
    if (ownRecord && ownRecord.local_source && participatesInEvaluation(ownRecord.local_source)) {
      return ownRecordId;
    }
  }
  return '';
}

function applyPackageAnnotation(data, recordId, item, updatedAt) {
  if (!recordId || !data.records[recordId]) return false;
  const current = data.records[recordId];
  if (current.local_source && !participatesInEvaluation(current.local_source)) return false;
  const manual = pickManualAnnotation((item && item.annotation) || {}, updatedAt);
  const nextAnnotation = { ...(current.annotation || {}) };
  delete nextAnnotation.model_result;
  for (const field of MANUAL_ANNOTATION_FIELDS) {
    nextAnnotation[field] = manual[field];
  }
  nextAnnotation.updated_at = updatedAt;
  upsertLocalRecordInData(data, recordId, { annotation: nextAnnotation });
  return true;
}

function importAnnotationPackage(zipBuffer) {
  const entries = parseZipEntries(zipBuffer);
  const manifest = getAnnotationPackageManifest(entries);
  const data = syncLocalImagesToData(readData());
  data.records = data.records || {};
  ensureLocalImageDir();
  const index = buildPackageImportIndex(data);
  const entriesByName = new Map();
  const entriesByBasename = new Map();
  for (const entry of entries) {
    if (path.basename(entry.name) === ANNOTATION_PACKAGE_MANIFEST) continue;
    entriesByName.set(entry.name.toLowerCase(), entry);
    const basename = path.basename(entry.name).toLowerCase();
    if (basename && !entriesByBasename.has(basename)) entriesByBasename.set(basename, entry);
  }

  const result = {
    ok: true,
    total: manifest.records.length,
    saved_images: 0,
    reused_images: 0,
    restored_annotations: 0,
    unmatched_annotations: 0,
    failed: 0,
    failures: [],
    record_ids: [],
  };
  const updatedAt = new Date().toISOString();
  const importedRecordIds = new Set();
  const itemRecordIds = new Map();
  const failedItemIndexes = new Set();
  const restoredRecordIds = new Set();
  const rememberRecordId = (recordId) => {
    if (!recordId || importedRecordIds.has(recordId)) return;
    importedRecordIds.add(recordId);
    result.record_ids.push(recordId);
  };
  const countImageResult = (imageResult) => {
    if (imageResult.status === 'saved') result.saved_images += 1;
    if (imageResult.status === 'reused') result.reused_images += 1;
  };
  const rememberImageFailure = (item, imageResult, itemIndex) => {
    result.failed += 1;
    failedItemIndexes.add(itemIndex);
    if (result.failures.length < 100) {
      result.failures.push({ image: item.image_entry || item.filename || '', message: imageResult.message });
    }
  };

  manifest.records.forEach((item, itemIndex) => {
    const imageEntry = findPackageImageEntry(entriesByName, entriesByBasename, item);
    if (imageEntry) {
      const imageResult = upsertPackageImageRecord(data, index, item, imageEntry);
      countImageResult(imageResult);
      if (imageResult.status === 'failed') {
        rememberImageFailure(item, imageResult, itemIndex);
        return;
      }
      if (imageResult.recordId) {
        itemRecordIds.set(itemIndex, imageResult.recordId);
        rememberRecordId(imageResult.recordId);
      }
      return;
    }
    const recordId = findPackageRecordMatch(data, index, item, normalizePackageString(item.content_sha1, 80));
    if (recordId) {
      itemRecordIds.set(itemIndex, recordId);
      rememberRecordId(recordId);
    }
  });

  const annotationItems = manifest.records
    .map((item, itemIndex) => ({ item, itemIndex }))
    .sort((a, b) => (getManifestCameraId(b.item) === 1 ? 1 : 0) - (getManifestCameraId(a.item) === 1 ? 1 : 0));

  for (const { item, itemIndex } of annotationItems) {
    if (failedItemIndexes.has(itemIndex) || !hasPackageManualAnnotation(item)) continue;
    let recordId = findPackageEvaluationRecordId(data, index, item, itemRecordIds.get(itemIndex) || '');
    if (!recordId && getManifestCameraId(item) === 0) {
      const siblingEntry = findPackageSiblingImageEntry(entriesByName, entriesByBasename, item, 1);
      if (siblingEntry) {
        const siblingItem = makeSiblingPackageItem(item, siblingEntry, 1);
        const imageResult = upsertPackageImageRecord(data, index, siblingItem, siblingEntry);
        countImageResult(imageResult);
        if (imageResult.status === 'failed') {
          rememberImageFailure(siblingItem, imageResult, itemIndex);
          continue;
        }
        recordId = imageResult.recordId;
        rememberRecordId(recordId);
      }
    }
    if (!recordId) {
      result.unmatched_annotations += 1;
      continue;
    }
    if (restoredRecordIds.has(recordId)) continue;
    rememberRecordId(recordId);
    if (applyPackageAnnotation(data, recordId, item, updatedAt)) {
      result.restored_annotations += 1;
      restoredRecordIds.add(recordId);
    } else {
      result.unmatched_annotations += 1;
    }
  }

  updateRealtimePairMetadata(data);
  writeData(data);
  result.ok = result.failed === 0;
  return result;
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
  const parsed = parseRealtimeFilename(
    (record && (record.stored_filename || record.original_filename || record.source_id)) || '',
  );
  if (parsed) return parsed.cameraId === 1;
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
  if (!participatesInEvaluation(source)) {
    throw new Error('参考图不参与 VLM 推理，请选择同组 cam1 评估图');
  }
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

function getBatchStatusPayload() {
  return {
    running: vlmBatchJob.running,
    started_at: vlmBatchJob.started_at,
    updated_at: vlmBatchJob.updated_at,
    finished_at: vlmBatchJob.finished_at,
    total: vlmBatchJob.total,
    success: vlmBatchJob.success,
    failed: vlmBatchJob.failed,
    skipped: vlmBatchJob.skipped,
    current_id: vlmBatchJob.current_id,
    message: vlmBatchJob.message,
    results: vlmBatchJob.results.slice(-VLM_BATCH_RECENT_RESULT_LIMIT),
  };
}

function rememberBatchResult(result) {
  vlmBatchJob.results.push({
    ...result,
    updated_at: new Date().toISOString(),
  });
  if (vlmBatchJob.results.length > VLM_BATCH_RECENT_RESULT_LIMIT) {
    vlmBatchJob.results.splice(0, vlmBatchJob.results.length - VLM_BATCH_RECENT_RESULT_LIMIT);
  }
}

function isCompletedBatchVlm(record) {
  const vlm = normalizeStoredVlm(record && record.vlm || {});
  return vlm.status === 'completed' && Boolean(vlm.model_result || vlm.predicted_status);
}

function resolveBatchVlmTargetId(data, reviewId) {
  const record = data.records[reviewId] || {};
  const source = record.local_source;
  if (!source || participatesInEvaluation(source)) return reviewId;

  const metadata = source.source_metadata || {};
  if (metadata.paired_record_id) {
    const paired = data.records[metadata.paired_record_id] || {};
    if (!paired.local_source || participatesInEvaluation(paired.local_source)) {
      return metadata.paired_record_id;
    }
  }

  if (metadata.capture_group_id) {
    for (const [candidateId, candidate] of Object.entries(data.records || {})) {
      const candidateSource = candidate.local_source;
      const candidateMetadata = candidateSource && candidateSource.source_metadata || {};
      if (
        candidateId !== reviewId
        && candidateMetadata.capture_group_id === metadata.capture_group_id
        && participatesInEvaluation(candidateSource)
      ) {
        return candidateId;
      }
    }
  }

  return reviewId;
}

function setBatchMessage() {
  const done = vlmBatchJob.success + vlmBatchJob.failed + vlmBatchJob.skipped;
  vlmBatchJob.updated_at = new Date().toISOString();
  vlmBatchJob.message = vlmBatchJob.running
    ? `批量 VLM 推理中：${done}/${vlmBatchJob.total}`
    : `批量 VLM 推理完成：成功 ${vlmBatchJob.success}，失败 ${vlmBatchJob.failed}，跳过 ${vlmBatchJob.skipped}`;
}

async function runVlmBatchQueue(ids, options = {}) {
  const force = Boolean(options.force);
  try {
    const data = syncLocalImagesToData(readData());
    const queuedIds = [];
    const seenTargets = new Set();

    for (const rawId of ids) {
      const reviewId = String(rawId || '').trim();
      if (!reviewId) {
        vlmBatchJob.skipped += 1;
        rememberBatchResult({ ok: false, skipped: true, message: '缺少记录 ID' });
        continue;
      }

      const targetId = data.records[reviewId] ? resolveBatchVlmTargetId(data, reviewId) : reviewId;
      const targetRecord = data.records[targetId] || {};
      if (seenTargets.has(targetId)) {
        vlmBatchJob.skipped += 1;
        rememberBatchResult({ id: targetId, source_id: reviewId, ok: false, skipped: true, message: '重复记录已跳过' });
        continue;
      }
      seenTargets.add(targetId);

      if (targetRecord.local_source && !participatesInEvaluation(targetRecord.local_source)) {
        vlmBatchJob.skipped += 1;
        rememberBatchResult({ id: targetId, source_id: reviewId, ok: false, skipped: true, message: '参考图不参与 VLM 推理' });
        continue;
      }

      if (!force && isCompletedBatchVlm(targetRecord)) {
        vlmBatchJob.skipped += 1;
        rememberBatchResult({ id: targetId, source_id: reviewId, ok: true, skipped: true, message: '已有完成的 VLM 结果' });
        continue;
      }

      queuedIds.push(targetId);
    }

    for (const targetId of queuedIds) {
      vlmBatchJob.current_id = targetId;
      setBatchMessage();
      try {
        const vlm = await runVlm(targetId);
        upsertLocalRecord(targetId, { vlm });
        if (vlm.status === 'failed') {
          vlmBatchJob.failed += 1;
          rememberBatchResult({ id: targetId, ok: false, status: vlm.status, message: vlm.error || '模型输出无法识别' });
        } else {
          vlmBatchJob.success += 1;
          rememberBatchResult({ id: targetId, ok: true, status: vlm.status, model_result: vlm.model_result });
        }
      } catch (error) {
        const vlm = {
          status: 'failed',
          model: VLM_MODEL,
          endpoint: VLM_ENDPOINT,
          prompt_version: VLM_PROMPT_VERSION,
          error: error.message || String(error),
          updated_at: new Date().toISOString(),
        };
        upsertLocalRecord(targetId, { vlm });
        vlmBatchJob.failed += 1;
        rememberBatchResult({ id: targetId, ok: false, status: 'failed', message: vlm.error });
      }
      setBatchMessage();
    }
  } catch (error) {
    vlmBatchJob.failed += 1;
    rememberBatchResult({ ok: false, status: 'failed', message: error.message || String(error) });
  } finally {
    vlmBatchJob.running = false;
    vlmBatchJob.current_id = '';
    vlmBatchJob.finished_at = new Date().toISOString();
    setBatchMessage();
  }
}

function startVlmBatch(ids, options = {}) {
  const now = new Date().toISOString();
  Object.assign(vlmBatchJob, {
    running: true,
    started_at: now,
    updated_at: now,
    finished_at: '',
    total: ids.length,
    success: 0,
    failed: 0,
    skipped: 0,
    current_id: '',
    message: `批量 VLM 推理已启动：0/${ids.length}`,
    results: [],
  });
  setTimeout(() => {
    runVlmBatchQueue(ids, options).catch((error) => {
      vlmBatchJob.running = false;
      vlmBatchJob.current_id = '';
      vlmBatchJob.finished_at = new Date().toISOString();
      vlmBatchJob.failed += 1;
      rememberBatchResult({ ok: false, status: 'failed', message: error.message || String(error) });
      setBatchMessage();
    });
  }, 0);
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
    object_tags: Array.isArray(annotation.object_tags) ? annotation.object_tags : [],
    gripper_orientation: annotation.gripper_orientation || '',
    grasp_depth: annotation.grasp_depth || '',
    background_tag: annotation.background_tag || '',
    object_color: annotation.object_color || '',
    note: annotation.note || '',
  };
}

function buildAnnotationFromBody(existingAnnotation, body, updatedAt = new Date().toISOString()) {
  const objectTags = normalizeStringList(body.object_tags, 32, 80);
  const objectTag = String(body.object_tag || objectTags[0] || '').trim().slice(0, 32);
  return {
    ...existingAnnotation,
    human_result: body.human_result || '',
    model_result: body.model_result || '',
    sample_validity: body.sample_validity || 'valid',
    attribution_branch: body.attribution_branch || '',
    attribution_reason: body.attribution_reason || '',
    note: body.note || '',
    object_tag: objectTag,
    object_tags: objectTags.length ? objectTags : (objectTag ? [objectTag] : []),
    gripper_orientation: String(body.gripper_orientation || '').trim().slice(0, 40),
    grasp_depth: String(body.grasp_depth || '').trim().slice(0, 40),
    background_tag: String(body.background_tag || '').trim().slice(0, 40),
    object_color: String(body.object_color || '').trim().slice(0, 40),
    updated_at: updatedAt,
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
  if (port === '9002') return [frameUrl, snapshotUrl];
  return [proxyUrl, snapshotUrl, frameUrl];
}

function getOrderedRealtimeBaseUrls() {
  const urls = REALTIME_BASE_URLS.filter((baseUrl) => baseUrl && !isCurrentServerBase(baseUrl));
  if (!realtimeLastGoodBaseUrl || !urls.includes(realtimeLastGoodBaseUrl)) return urls;
  return [
    realtimeLastGoodBaseUrl,
    ...urls.filter((baseUrl) => baseUrl !== realtimeLastGoodBaseUrl),
  ];
}

function shouldDeferRealtimeBase(baseUrl) {
  const failure = realtimeBaseFailures.get(baseUrl);
  return failure && Date.now() < failure.retryAt;
}

function markRealtimeBaseSuccess(baseUrl) {
  realtimeLastGoodBaseUrl = baseUrl;
  realtimeBaseFailures.delete(baseUrl);
}

function markRealtimeBaseFailure(baseUrl, errorMessage) {
  if (realtimeLastGoodBaseUrl === baseUrl) realtimeLastGoodBaseUrl = '';
  realtimeBaseFailures.set(baseUrl, {
    retryAt: Date.now() + REALTIME_FAILURE_COOLDOWN_MS,
    errorMessage,
  });
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
  const deferredBaseUrls = [];
  let lastError = '';
  for (const baseUrl of getOrderedRealtimeBaseUrls()) {
    if (shouldDeferRealtimeBase(baseUrl)) {
      deferredBaseUrls.push(baseUrl);
      continue;
    }
    const response = await fetchRealtimeImageFromBase(baseUrl, cam);
    if (response.ok) return response.value;
    lastError = response.error || lastError;
  }
  for (const baseUrl of deferredBaseUrls) {
    const response = await fetchRealtimeImageFromBase(baseUrl, cam);
    if (response.ok) return response.value;
    lastError = response.error || lastError;
  }
  throw new Error(`cam${cam} 抓图失败：${lastError || '无可用实时图像接口'}`);
}

async function fetchRealtimeImageFromBase(baseUrl, cam) {
  const candidates = makeRealtimeFrameUrls(baseUrl, cam);
  let lastError = '';
  for (const imageUrl of candidates) {
    try {
      const response = await fetchWithRealtimeTimeout(imageUrl);
      if (response.ok) {
        markRealtimeBaseSuccess(baseUrl);
        return { ok: true, value: response };
      }
      lastError = `${imageUrl} HTTP ${response.status}`;
    } catch (error) {
      lastError = `${imageUrl} ${formatRealtimeFetchError(error)}`;
    }
  }
  markRealtimeBaseFailure(baseUrl, lastError);
  return { ok: false, error: lastError };
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
async function captureRealtimeSnapshot(cam, captureGroupId, captureTimestamp, pairSuffix) {
  const response = await fetchRealtimeImage(cam);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const buffer = Buffer.from(await response.arrayBuffer());
  ensureLocalImageDir();
  const timestamp = captureTimestamp || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = pairSuffix || makeShortId();
  const filename = `cam${cam}_${timestamp}_${suffix}.${ext}`;
  const filepath = path.join(LOCAL_IMAGE_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return {
    filename,
    contentType,
    cam,
    captureGroupId,
    captureTimestamp: timestamp,
    pairSuffix: suffix,
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
  localSource.source_metadata.capture_timestamp = snapshot.captureTimestamp;
  localSource.source_metadata.pair_suffix = snapshot.pairSuffix;
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

// 删除一条记录所属整组图片。本地图片记录会从 gripper_eval_data.json 中移除；
// 远程来源的占位记录仍保留 deleted 标记，避免刷新后又从远端出现。
function deleteRecordGroupAndLocalFiles(reviewId) {
  const data = readData();
  data.records = data.records || {};
  const ids = getLocalGroupRecordIds(data, reviewId);
  const now = new Date().toISOString();
  const deletedFiles = [];
  const missingFiles = [];
  const deletedJsonRecordIds = [];

  for (const id of ids) {
    const record = data.records[id];
    if (!record) {
      data.records[id] = {
        deleted: true,
        deleted_at: now,
        updated_at: now,
      };
      continue;
    }
    if (record.local_source) {
      const fileResult = deleteLocalImageFile(record);
      if (fileResult.deleted) deletedFiles.push(getRecordFilename(record));
      if (fileResult.missing) missingFiles.push(fileResult.missing);
      delete data.records[id];
      deletedJsonRecordIds.push(id);
      continue;
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
    record: data.records[reviewId] || null,
    deleted_record_ids: ids,
    deleted_json_record_ids: deletedJsonRecordIds,
    deleted_files: deletedFiles,
    missing_files: missingFiles,
  };
}

// 所有 /api/ 路由的主处理函数。根据 method 和 pathname 分发到不同功能。
async function handleApi(req, res, url) {
  // 样本池状态：样本池总量 + 各类别待入池数量。
  if (req.method === 'GET' && url.pathname === '/api/pool/status') {
    try {
      sendJson(res, 200, samplePool.getPoolStatus());
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 新建物品类别目录。
  if (req.method === 'POST' && url.pathname === '/api/pool/category') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = samplePool.createCategory(body.category);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 入池：单个类别或全部类别，支持 dry-run 预览。
  if (req.method === 'POST' && url.pathname === '/api/pool/ingest') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const dryRun = !!body.dry_run;
      let result;
      if (body.all) {
        result = samplePool.ingestAll({ dryRun });
      } else if (body.category) {
        result = samplePool.ingestCategory(body.category, { dryRun });
      } else {
        result = { ok: false, message: '缺少 category 或 all 参数' };
      }
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 坏组：列出某类别无法配对的原始图片组（删除前预览确认用）。
  if (req.method === 'GET' && url.pathname === '/api/pool/bad-groups') {
    try {
      const result = samplePool.listCategoryBadGroups(url.searchParams.get('category') || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 坏组：永久删除某类别的坏组原始图片（仅删 testCollection 内坏组文件，生成删除报告）。
  if (req.method === 'POST' && url.pathname === '/api/pool/bad-groups/delete') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = samplePool.deleteCategoryBadGroups(body.category || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：样本列表（支持类别/标注状态过滤、分页）。
  if (req.method === 'GET' && url.pathname === '/api/pool/samples') {
    try {
      const category = url.searchParams.get('category') || '';
      const annStatus = url.searchParams.get('ann_status') || 'all';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 500);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const date = url.searchParams.get('date') || '';
      let filters = {};
      const filtersRaw = url.searchParams.get('filters');
      if (filtersRaw) { try { filters = JSON.parse(filtersRaw); } catch (e) { filters = {}; } }
      const vlmModelKey = url.searchParams.get('vlm_model') || '';
      const vlmFilter = url.searchParams.get('vlm_filter') || '';
      const excludeInvalid = url.searchParams.get('exclude_invalid') === '1';
      sendJson(res, 200, samplePool.listSamples({ category, annStatus, limit, offset, filters, date, vlmModelKey, vlmFilter, excludeInvalid }));
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：返回物品标签字典（各类别物体级默认属性）。
  if (req.method === 'GET' && url.pathname === '/api/pool/dictionary') {
    try {
      const dict = samplePool.loadObjectDictionary();
      sendJson(res, 200, { ok: true, categories: dict.categories || {} });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 往字典新增一个采集类别（页面一步新增）。
  if (req.method === 'POST' && url.pathname === '/api/pool/dictionary/category') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = samplePool.addDictionaryCategory(body.category, { object_name: body.object_name });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：单样本详情（样本池条目 + 当前标注）。
  if (req.method === 'GET' && url.pathname === '/api/pool/sample') {
    try {
      const sampleId = url.searchParams.get('sample_id') || '';
      const result = samplePool.getSampleDetail(sampleId);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：硬删除一个样本（永久删除 cam0/cam1 原图 + 从样本池移除该条目，不可恢复）。
  if (req.method === 'POST' && url.pathname === '/api/pool/sample/delete') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = samplePool.deleteSample(body.sample_id || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：保存人工标注（追加写入，不动原图与平台 records）。
  if (req.method === 'POST' && url.pathname === '/api/pool/annotate') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = samplePool.saveAnnotation(body.sample_id, body.fields || {}, body.operator || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：对单个样本即时跑一次模型（标注时快速对照预测，不写入任何 run/记录）。
  if (req.method === 'POST' && url.pathname === '/api/pool/vlm') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sampleId = body.sample_id || '';
      if (!sampleId) { sendJson(res, 400, { ok: false, message: '缺少 sample_id' }); return; }
      const models = modelRun.loadModels();
      if (!models.length) { sendJson(res, 400, { ok: false, message: '未配置任何模型（models.json 为空）' }); return; }
      const baseCfg = body.model_key ? modelRun.getModel(body.model_key) : models[0];
      if (!baseCfg) { sendJson(res, 400, { ok: false, message: `未找到模型: ${body.model_key}` }); return; }
      const modelCfg = modelRun.applyEndpointOverride(baseCfg, body);
      if (!modelCfg || !modelCfg.endpoint) {
        sendJson(res, 400, { ok: false, message: '模型 endpoint 无效，请检查自定义 IP/端口或 models.json' });
        return;
      }
      const effectiveKey = modelRun.effectiveModelKey(baseCfg, body);
      const { raw, pred, error } = await modelRun.callModel(modelCfg, sampleId);
      // 成功的预测落盘，便于标注页持久显示与按模型结果筛选（失败不写盘）。
      if (!error) {
        try { samplePool.saveVlmResult(sampleId, effectiveKey, pred, raw); } catch (e) { /* 写盘失败不影响返回 */ }
      }
      sendJson(res, 200, {
        ok: !error, raw, pred, error: error || '',
        model: modelCfg.label || modelCfg.key || effectiveKey,
        model_key: effectiveKey,
        endpoint: modelCfg.endpoint,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 模型评测：模型注册表。
  if (req.method === 'GET' && url.pathname === '/api/models') {
    try { sendJson(res, 200, modelRun.listModels()); }
    catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：对某 BM 快照用某模型启动一次 run（后台执行）。
  if (req.method === 'POST' && url.pathname === '/api/run/start') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = modelRun.startRun({
        bmId: body.bm_id,
        modelKey: body.model_key,
        concurrency: body.concurrency,
        endpoint_host: body.endpoint_host,
        endpoint_port: body.endpoint_port,
        host: body.host,
        port: body.port,
        endpoint: body.endpoint,
        model: body.model,
      });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：停止一次正在运行的 run（已跑结果保留并落盘）。
  if (req.method === 'POST' && url.pathname === '/api/run/cancel') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = modelRun.cancelRun(body.run_id || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：run 进度。
  if (req.method === 'GET' && url.pathname === '/api/run/status') {
    try {
      const result = modelRun.getRunStatus(url.searchParams.get('run_id') || '');
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：run 列表。
  if (req.method === 'GET' && url.pathname === '/api/run/list') {
    try { sendJson(res, 200, modelRun.listRuns()); }
    catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：run 详情（meta + 预测明细）。
  if (req.method === 'GET' && url.pathname === '/api/run/detail') {
    try {
      const result = modelRun.getRunDetail(url.searchParams.get('run_id') || '');
      if (result.ok && Array.isArray(result.predictions)) attachAnnotationsToPredictions(result.predictions);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：删除一次 run（仅删 eval_registry/runs 下对应目录）。
  if (req.method === 'POST' && url.pathname === '/api/run/delete') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = modelRun.deleteRun(body.run_id || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：只重跑本次 run 里失败/无法识别的样本，结果合并回原 run。
  if (req.method === 'POST' && url.pathname === '/api/run/retry') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = modelRun.retryRun(body.run_id || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // 模型评测：同步标注——把标注页最新人工结论重灌进该 run 的 BM 快照，并刷新该基准所有 run 的 gt 与指标。
  if (req.method === 'POST' && url.pathname === '/api/run/resync') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      let bmId = body.bm_id || '';
      const runId = body.run_id || '';
      if (!bmId && runId) {
        const detail = modelRun.getRunDetail(runId);
        if (detail.ok && detail.meta) bmId = detail.meta.bm_id || '';
      }
      if (!bmId) { sendJson(res, 400, { ok: false, message: '缺少 bm_id / run_id' }); return; }
      const snapRes = bmSnapshot.resyncSnapshotFromAnnotations(bmId);
      if (!snapRes.ok) { sendJson(res, 400, snapRes); return; }
      const runRes = modelRun.resyncRunsGt(bmId, snapRes.gtMap || {}, snapRes.backup || null);
      sendJson(res, 200, {
        ok: true,
        bm_id: bmId,
        snapshot_changed: snapRes.changed,
        label_changes: snapRes.label_changes,
        runs_updated: runRes.updated,
        backup: snapRes.backup || null,
      });
    } catch (error) { sendJson(res, 500, { ok: false, message: error.message || String(error) }); }
    return;
  }

  // BM 快照：各类别标注进度统计。
  if (req.method === 'GET' && url.pathname === '/api/bm/stats') {
    try {
      sendJson(res, 200, bmSnapshot.getAnnotationStats());
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：创建一个固定版本。
  if (req.method === 'POST' && url.pathname === '/api/bm/create') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = bmSnapshot.createSnapshot(body);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：列出已有版本。
  if (req.method === 'GET' && url.pathname === '/api/bm/list') {
    try {
      sendJson(res, 200, bmSnapshot.listSnapshots());
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：版本详情（meta + 样本列表）。
  if (req.method === 'GET' && url.pathname === '/api/bm/detail') {
    try {
      const result = bmSnapshot.getSnapshot(url.searchParams.get('bm_id') || '');
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：下载 snapshot.jsonl。
  if (req.method === 'GET' && url.pathname === '/api/bm/download') {
    try {
      const bmId = url.searchParams.get('bm_id') || '';
      const filePath = bmSnapshot.snapshotFilePath(bmId);
      if (!filePath) {
        sendJson(res, 404, { ok: false, message: '快照不存在' });
        return;
      }
      const safeName = bmId.replace(/[^A-Za-z0-9_.-]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}_snapshot.jsonl"`,
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：锁定/解锁（锁定后禁止删除）。
  if (req.method === 'POST' && url.pathname === '/api/bm/lock') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = bmSnapshot.setSnapshotLock(body.bm_id || '', !!body.locked);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：向已有快照追加样本（已锁定的会被拒绝）。
  if (req.method === 'POST' && url.pathname === '/api/bm/add-samples') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = bmSnapshot.addSamplesToSnapshot(body.bm_id || '', body.sample_ids || []);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // BM 快照：删除（已锁定的会被拒绝）。
  if (req.method === 'POST' && url.pathname === '/api/bm/delete') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = bmSnapshot.deleteSnapshot(body.bm_id || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：批量把字段应用到多个样本（追加写入，不动原图与平台 records）。
  if (req.method === 'POST' && url.pathname === '/api/pool/annotate-batch') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = samplePool.saveAnnotationBatch(body.sample_ids || [], body.fields || {}, body.operator || '');
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 样本池标注：读取样本某一路相机图片（只读，限定 testCollection 目录内）。
  if (req.method === 'GET' && url.pathname === '/api/pool/image') {
    try {
      const sampleId = url.searchParams.get('sample_id') || '';
      const cam = url.searchParams.get('cam') || '1';
      const imgPath = samplePool.resolveImagePath(sampleId, cam);
      if (!imgPath) {
        sendJson(res, 404, { ok: false, message: '图片不存在或不可访问' });
        return;
      }
      const ext = path.extname(imgPath).toLowerCase();
      const ctype = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
      fs.createReadStream(imgPath).pipe(res);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

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

  if (req.method === 'GET' && url.pathname === '/api/label-options') {
    const data = readData();
    const labelOptions = normalizeLabelOptions(data.label_options);
    sendJson(res, 200, { ok: true, label_options: labelOptions });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/label-options') {
    const body = JSON.parse(await readBody(req) || '{}');
    const data = readData();
    const labelOptions = normalizeLabelOptions(data.label_options);
    const incoming = body.label_options && typeof body.label_options === 'object'
      ? body.label_options
      : body.options && typeof body.options === 'object'
        ? body.options
        : {};
    for (const key of Object.keys(DEFAULT_LABEL_OPTIONS)) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        labelOptions[key] = normalizeStringList(incoming[key], 40, 500);
      }
    }
    if (body.key && Object.prototype.hasOwnProperty.call(DEFAULT_LABEL_OPTIONS, body.key)) {
      labelOptions[body.key] = normalizeStringList(body.values, 40, 500);
    }
    data.label_options = labelOptions;
    writeData(data);
    sendJson(res, 200, { ok: true, label_options: labelOptions });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/download-images-zip') {
    const body = JSON.parse(await readBody(req) || '{}');
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 2000)
      : [];
    if (!ids.length) {
      sendJson(res, 400, { ok: false, message: '没有可下载的图片' });
      return;
    }
    const data = readData();
    const { zip, entryCount, zipEntryCount, missingCount } = buildDownloadZip(data, ids);
    if (!entryCount) {
      sendJson(res, 404, { ok: false, message: '没有找到可打包的本地图片' });
      return;
    }
    const filename = `pick-verify-images-labels-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Zip-Entry-Count': String(entryCount),
      'X-Zip-Total-Entry-Count': String(zipEntryCount),
      'X-Zip-Skipped-Count': String(missingCount),
      'X-Annotation-Manifest': ANNOTATION_PACKAGE_MANIFEST,
    });
    res.end(zip);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/import-annotation-package') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const base64 = String(body.zip_base64 || body.file_base64 || '').trim();
      if (!base64) {
        sendJson(res, 400, { ok: false, message: 'zip_base64 必填' });
        return;
      }
      const pureBase64 = base64.includes(',') ? base64.split(',').pop() : base64;
      const buffer = Buffer.from(pureBase64, 'base64');
      if (!buffer.length) {
        sendJson(res, 400, { ok: false, message: 'ZIP 文件内容为空' });
        return;
      }
      const result = importAnnotationPackage(buffer);
      sendJson(res, result.failed ? 207 : 200, {
        ...result,
        message: `图片+标注 ZIP 导入完成：新增图片 ${result.saved_images}，复用图片 ${result.reused_images}，恢复标注 ${result.restored_annotations}，未匹配 ${result.unmatched_annotations}，失败 ${result.failed}`,
      });
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

  // 保存一组实时相机快照；VLM 由前端显式按钮手动触发。
  if (req.method === 'POST' && url.pathname === '/api/realtime/save') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const objectCategory = String(
        body.object_category || (body.source_metadata && body.source_metadata.object_category) || '',
      ).trim();
      const rawShots = [];
      const captureTimestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const pairSuffix = makeShortId();
      const captureGroupId = `capture_group_${captureTimestamp}_${pairSuffix}`;
      for (const cam of [0, 1]) {
        try {
          const shot = await captureRealtimeSnapshot(cam, captureGroupId, captureTimestamp, pairSuffix);
          rawShots.push(shot);
          upsertLocalRealtimeRecord(shot);
        } catch {
          // 单路失败不阻断整体保存
        }
      }
      if (!rawShots.length) {
        sendJson(res, 502, { ok: false, message: '抓取实时画面失败，请检查实时服务或代理地址' });
        return;
      }
      const snapshots = rawShots.map((shot) => readData().records[`local_${shot.filename.replace(/\.[^.]+$/, '')}`])
        .filter(Boolean);
      // 采集时选定的类别写进 records 元数据，便于后续迁移与样本池归类。
      if (objectCategory) {
        for (const snap of snapshots) {
          if (!snap || !snap.local_source) continue;
          const ls = {
            ...snap.local_source,
            source_metadata: { ...(snap.local_source.source_metadata || {}), object_category: objectCategory },
          };
          upsertLocalRecord(snap.id, { local_source: ls });
        }
      }
      linkRealtimeGroup(snapshots);

      // 双写：把这组 cam0/cam1 登记进样本池（只登记原路径，失败不影响实时保存）。
      let poolSync = null;
      try {
        const cam0Shot = rawShots.find((s) => Number(s.cam) === 0);
        const cam1Shot = rawShots.find((s) => Number(s.cam) === 1);
        if (cam1Shot) {
          poolSync = samplePool.registerExternalPair({
            objectCategory,
            cam0Path: cam0Shot ? path.join(LOCAL_IMAGE_DIR, cam0Shot.filename) : '',
            cam1Path: path.join(LOCAL_IMAGE_DIR, cam1Shot.filename),
            captureGroupId,
            captureTimestamp,
            pairSuffix,
            sourceKind: 'realtime',
          });
        } else {
          poolSync = { ok: false, message: '缺少 cam1，未登记入池' };
        }
      } catch (error) {
        poolSync = { ok: false, message: error.message || String(error) };
      }

      sendJson(res, 200, {
        ok: true,
        message: `已保存 ${snapshots.length} 张实时图片为一组，cam1 参与统计，cam0 仅保存为参考；模型需要手动调用`,
        local_snapshots: snapshots,
        pool_sync: poolSync,
      });
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 上传一张 base64 图片到本地；VLM 由前端显式按钮手动触发。
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
      const duplicateFilename = findLocalImageDuplicate(buffer);
      if (duplicateFilename) {
        sendJson(res, 200, {
          ok: true,
          skipped_duplicate: true,
          message: `重复图片已跳过：${duplicateFilename}`,
          filename: duplicateFilename,
          record: findMergedRecordByFilename(duplicateFilename),
        });
        return;
      }
      const storedFilename = getUploadStoredFilename(body, filename);
      if (!storedFilename) {
        sendJson(res, 400, { ok: false, message: '原始文件名为空，无法保存' });
        return;
      }
      const filepath = path.join(LOCAL_IMAGE_DIR, storedFilename);
      if (fs.existsSync(filepath)) {
        if (localImageFileMatches(storedFilename, buffer)) {
          sendJson(res, 200, {
            ok: true,
            skipped_duplicate: true,
            message: `同名图片已存在：${storedFilename}`,
            filename: storedFilename,
            record: findMergedRecordByFilename(storedFilename),
          });
          return;
        }
        sendJson(res, 409, {
          ok: false,
          message: `同名图片已存在且内容不同：${storedFilename}。为保持原始文件名，未保存也未覆盖。`,
          filename: storedFilename,
        });
        return;
      }
      fs.writeFileSync(filepath, buffer);
      const id = `upload_${storedFilename.replace(/\.[^.]+$/, '')}`;
      const localSource = buildUploadLocalSource(body, id, storedFilename, contentType);
      const local = upsertLocalRecord(id, { local_source: localSource });
      updateRealtimePairMetadataOnDisk();
      const isEvaluationImage = participatesInEvaluation(localSource);
      const latestLocal = readData().records[id] || local;
      const latestSource = latestLocal.local_source || localSource;
      sendJson(res, 200, {
        ok: true,
        skipped_duplicate: false,
        filename: storedFilename,
        message: isEvaluationImage ? '图片已上传到本地记录，模型需要手动调用' : '参考图已上传到本地记录',
        record: mergeRecord(latestSource, latestLocal),
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
      const duplicateFilename = findLocalImageDuplicate(buffer);
      if (duplicateFilename) {
        sendJson(res, 200, {
          ok: true,
          skipped_duplicate: true,
          message: `重复图片已跳过：${duplicateFilename}`,
          filename: duplicateFilename,
          record: findMergedRecordByFilename(duplicateFilename),
        });
        return;
      }
      const storedFilename = getUploadStoredFilename(body, filename);
      if (!storedFilename) {
        sendJson(res, 400, { ok: false, message: '原始文件名为空，无法保存' });
        return;
      }
      const filepath = path.join(LOCAL_IMAGE_DIR, storedFilename);
      if (fs.existsSync(filepath)) {
        if (localImageFileMatches(storedFilename, buffer)) {
          sendJson(res, 200, {
            ok: true,
            skipped_duplicate: true,
            message: `同名图片已存在：${storedFilename}`,
            filename: storedFilename,
            record: findMergedRecordByFilename(storedFilename),
          });
          return;
        }
        sendJson(res, 409, {
          ok: false,
          message: `同名图片已存在且内容不同：${storedFilename}。为保持原始文件名，未保存也未覆盖。`,
          filename: storedFilename,
        });
        return;
      }
      fs.writeFileSync(filepath, buffer);
      const id = `review_${storedFilename.replace(/\.[^.]+$/, '')}`;
      const localSource = makeLocalSourceRecord({
        id,
        filename: storedFilename,
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
      applyRealtimeFilenameMetadata(localSource, [storedFilename, filename, body.source_id]);
      upsertLocalRecord(id, { local_source: localSource });
      updateRealtimePairMetadataOnDisk();
      const isEvaluationImage = participatesInEvaluation(localSource);
      sendJson(res, 200, {
        ok: true,
        message: isEvaluationImage ? '已写入本地 reviews，模型需要手动调用' : '已写入本地 reviews 参考图',
        id,
        review_path: `/review/${id}`,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/vlm/batch-status') {
    sendJson(res, 200, { ok: true, ...getBatchStatusPayload() });
    return;
  }

  // 对选中的评估图手动触发批量 VLM 推理；任务在后台逐条执行。
  if (req.method === 'POST' && url.pathname === '/api/vlm/batch-start') {
    if (req.headers['x-manual-vlm'] !== '1') {
      sendJson(res, 403, {
        ok: false,
        message: 'VLM 推理已关闭自动触发，请使用页面里的手动调用按钮。',
      });
      return;
    }
    if (vlmBatchJob.running) {
      sendJson(res, 409, {
        ok: false,
        message: '已有批量 VLM 推理任务正在运行，请稍后再试。',
        ...getBatchStatusPayload(),
      });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const uniqueIds = [];
      const seen = new Set();
      for (const rawId of Array.isArray(body.ids) ? body.ids : []) {
        const reviewId = String(rawId || '').trim();
        if (!reviewId || seen.has(reviewId)) continue;
        seen.add(reviewId);
        uniqueIds.push(reviewId);
        if (uniqueIds.length >= VLM_BATCH_MAX_IDS) break;
      }
      if (!uniqueIds.length) {
        sendJson(res, 400, { ok: false, message: '没有可批量推理的记录' });
        return;
      }
      startVlmBatch(uniqueIds, { force: Boolean(body.force) });
      sendJson(res, 202, { ok: true, ...getBatchStatusPayload() });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message || String(error) });
    }
    return;
  }

  // 对某条记录手动触发一次 VLM 推理。
  if (req.method === 'POST' && url.pathname.startsWith('/api/vlm/')) {
    const reviewId = decodeURIComponent(url.pathname.split('/').pop());
    if (req.headers['x-manual-vlm'] !== '1') {
      sendJson(res, 403, {
        ok: false,
        message: 'VLM 推理已关闭自动触发，请使用页面里的“人工调用模型”按钮。',
      });
      return;
    }
    try {
      const data = syncLocalImagesToData(readData());
      const localRecord = data.records[reviewId] || {};
      if (localRecord.local_source && !participatesInEvaluation(localRecord.local_source)) {
        sendJson(res, 400, {
          ok: false,
          message: '参考图不参与 VLM 推理，请选择同组 cam1 评估图',
          record: mergeRecord(localRecord.local_source, localRecord),
        });
        return;
      }
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

  // 批量保存人工标注：一次读写本地数据，避免几千张图片逐条请求造成卡顿。
  if (req.method === 'POST' && url.pathname === '/api/annotations/batch') {
    const body = JSON.parse(await readBody(req) || '{}');
    const entries = Array.isArray(body.annotations) ? body.annotations : [];
    if (!entries.length) {
      sendJson(res, 400, { ok: false, message: '没有需要批量保存的标注' });
      return;
    }

    const data = readData();
    data.records = data.records || {};
    const updatedAt = new Date().toISOString();
    const results = [];
    let success = 0;
    let failed = 0;

    for (const entry of entries) {
      const reviewId = String(entry.id || entry.review_id || '').trim();
      const entryBody = entry.body && typeof entry.body === 'object' ? entry.body : entry;
      if (!reviewId) {
        failed += 1;
        results.push({ ok: false, message: '缺少记录 ID' });
        continue;
      }
      const current = data.records[reviewId] || {};
      const requestHasVersion = Object.prototype.hasOwnProperty.call(entryBody, 'base_updated_at');
      const baseUpdatedAt = entryBody.base_updated_at || '';
      const currentUpdatedAt = current.updated_at || '';
      const force = Boolean(body.force || entryBody.force);
      if (!force && requestHasVersion && baseUpdatedAt !== currentUpdatedAt) {
        failed += 1;
        results.push({
          ok: false,
          id: reviewId,
          status: 409,
          message: '该图片已被其他人更新，请刷新后重试，或确认覆盖最新标注。',
        });
        continue;
      }
      const annotation = buildAnnotationFromBody(current.annotation || {}, entryBody, updatedAt);
      upsertLocalRecordInData(data, reviewId, { annotation });
      success += 1;
      if (results.length < 100) results.push({ ok: true, id: reviewId });
    }

    writeData(data);
    sendJson(res, failed ? 207 : 200, {
      ok: failed === 0,
      success,
      failed,
      total: entries.length,
      results,
      message: failed ? `批量保存完成：成功 ${success}，失败 ${failed}` : `批量保存完成：成功 ${success}`,
    });
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
    const annotation = buildAnnotationFromBody(existingAnnotation, body);
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

    // 旧标注/采集页已退役（采集并入 /pool，单图标注与跑模型并入 /label）。根路径重定向到新入池页。
    if (url.pathname === '/' || url.pathname === '/gripper_eval.html') {
      res.writeHead(302, { Location: '/pool' });
      res.end();
      return;
    }

    // 标注字段单一数据源：直接把 annotation_schema.js 提供给浏览器，作为全局 ANNOTATION_SCHEMA。
    if (url.pathname === '/annotation_schema.js') {
      sendText(res, 200, fs.readFileSync(ANNOTATION_SCHEMA_PATH, 'utf8'), 'application/javascript; charset=utf-8');
      return;
    }

    if (url.pathname === '/pool' || url.pathname === '/sample_pool.html') {
      sendText(res, 200, fs.readFileSync(SAMPLE_POOL_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/label' || url.pathname === '/gripper_label.html') {
      sendText(res, 200, fs.readFileSync(LABEL_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/bm' || url.pathname === '/gripper_bm.html') {
      sendText(res, 200, fs.readFileSync(BM_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/runs' || url.pathname === '/gripper_runs.html') {
      sendText(res, 200, fs.readFileSync(RUNS_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
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
  console.log(`Share URL: ${APP_BASE_URL}/`);
});
