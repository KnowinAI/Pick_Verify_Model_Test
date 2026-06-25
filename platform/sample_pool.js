/**
 * 样本池入池模块（自带实现，不依赖外部 python）。
 *
 * 职责：
 * - 只读扫描 testCollection 下的类别目录，统计 cam0/cam1 配对和待入池数量。
 * - 把新样本增量写入长期样本池 eval_registry/samples/pool_manifest.jsonl。
 * - 每次入池生成一个导入批次，保留来源、配对结果和异常报告。
 *
 * 严格保护原图：只读取，不删除、不移动、不重命名、不覆盖任何源图片。
 *
 * 与 scripts/build_sample_pool.py 使用同一套规则和同一个 pool_manifest.jsonl，
 * 两边可以混用：命令行批量 + 页面交互。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ANNOTATION_SCHEMA } = require('./annotation_schema');

const PROJECT_ROOT = path.join(__dirname, '..');
const TESTCOLLECTION_DIR = path.join(PROJECT_ROOT, 'testCollection');
const LOCAL_IMAGE_DIR = path.join(PROJECT_ROOT, 'local_images');
const REGISTRY_DIR = path.join(PROJECT_ROOT, 'eval_registry');
const SAMPLES_DIR = path.join(REGISTRY_DIR, 'samples');
const BATCHES_DIR = path.join(SAMPLES_DIR, 'import_batches');
const POOL_MANIFEST_PATH = path.join(SAMPLES_DIR, 'pool_manifest.jsonl');
const POOL_REPORT_PATH = path.join(SAMPLES_DIR, 'pool_report.json');
const ANNOTATIONS_PATH = path.join(SAMPLES_DIR, 'annotations.jsonl');
// 样本级模型结果（标注页直接跑模型的预测落盘，按 sample_id + model_key 取最新一条）。
const POOL_VLM_PATH = path.join(SAMPLES_DIR, 'pool_vlm.jsonl');
const ANNOTATION_VERSION = 'label_v1';
const OBJECT_DICT_PATH = path.join(REGISTRY_DIR, 'object_dictionary.json');

// 往物品标签字典里新增一个类别（占位条目，属性后续可在 JSON 里补全）。
// 不覆盖已有类别；保留原文件其它字段。
function addDictionaryCategory(category, options = {}) {
  const name = String(category || '').trim();
  if (!isValidCategoryName(name)) {
    return { ok: false, message: `非法类别名称: ${category}` };
  }
  let raw = { _version: 'dict_v1', _object_level_fields: [], categories: {} };
  if (fs.existsSync(OBJECT_DICT_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(OBJECT_DICT_PATH, 'utf8'));
    } catch (error) {
      return { ok: false, message: `字典文件解析失败，未改动: ${error.message || error}` };
    }
  }
  if (!raw.categories || typeof raw.categories !== 'object') raw.categories = {};
  if (raw.categories[name]) {
    return { ok: false, message: `类别已存在: ${name}` };
  }
  const entry = {};
  const objectName = String(options.object_name || '').trim();
  if (objectName) entry.object_name = objectName;
  raw.categories[name] = entry;
  fs.writeFileSync(OBJECT_DICT_PATH, JSON.stringify(raw, null, 2), 'utf8');
  return { ok: true, category: name, entry };
}

// 读取物品标签字典：按 object_category 返回物体级属性默认值。
function loadObjectDictionary() {
  if (!fs.existsSync(OBJECT_DICT_PATH)) return { categories: {}, objectLevelFields: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(OBJECT_DICT_PATH, 'utf8'));
    return {
      categories: raw.categories || {},
      objectLevelFields: raw._object_level_fields || [],
      version: raw._version || '',
    };
  } catch (error) {
    return { categories: {}, objectLevelFields: [] };
  }
}

// 由人工结果推导 G/N 标签：夹住->G，未夹住->N，其它情况留空交由 sample_validity 处理。
function deriveLabel(humanResult) {
  if (humanResult === '夹住') return 'G';
  if (humanResult === '未夹住') return 'N';
  return '';
}

// 取某类别的物体级默认属性（不含下划线开头的元字段）。
function getCategoryDefaults(category) {
  const dict = loadObjectDictionary();
  const entry = dict.categories[category];
  if (!entry) return {};
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

// 人工标注字段白名单：由单一数据源 annotation_schema.js 自动派生。
// 'label'（G/N）由 human_result 推导，不在 schema 里，单独置顶保留。
// 新增标签只改 annotation_schema.js，这里无需改动。
const ANNOTATION_FIELDS = ['label', ...ANNOTATION_SCHEMA.map((f) => f.key)];

const FILENAME_RE = /^(?:realtime_)?cam([01])_(\d{14})(?:_([^.]+))?(\.[^.]+)$/i;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);
const CATEGORY_NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_.\- \u4e00-\u9fa5]{0,63}$/;

function nowIso() {
  return new Date().toISOString();
}

function dateTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function sha1File(filePath) {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function parseFilename(name) {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  return {
    cam: Number(m[1]),
    timestamp: m[2],
    suffix: m[3] || '',
    ext: m[4],
  };
}

function makeSampleId(timestamp, suffix) {
  return suffix ? `capture_group_${timestamp}_${suffix}` : `capture_group_${timestamp}`;
}

function safeLabel(label) {
  const cleaned = String(label || '').replace(/[^A-Za-z0-9_.\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'batch';
}

function isValidCategoryName(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  if (text.includes('..') || text.includes('/') || text.includes('\\')) return false;
  return CATEGORY_NAME_RE.test(text);
}

// 递归列出目录下的图片文件（绝对路径）。
function walkImages(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out;
}

function relSubdir(dirPath) {
  const rel = path.relative(TESTCOLLECTION_DIR, dirPath).split(path.sep).join('/');
  return rel === '' ? '' : rel;
}

// 在单个叶子目录内部配对 cam0/cam1。
function pairWithinDir(items, leafDir, category) {
  const pairs = [];
  const anomalies = [];
  const groups = new Map();
  for (const it of items) {
    const key = it.suffix ? `${it.timestamp}_${it.suffix}` : `${it.timestamp}_`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const key of Array.from(groups.keys()).sort()) {
    const members = groups.get(key);
    const cam0 = members.filter((m) => m.cam === 0);
    const cam1 = members.filter((m) => m.cam === 1);
    if (cam0.length === 1 && cam1.length === 1 && members.length === 2) {
      pairs.push({
        cam0: cam0[0],
        cam1: cam1[0],
        timestamp: cam0[0].timestamp,
        suffix: cam0[0].suffix,
        pairMethod: cam0[0].suffix ? 'timestamp_suffix' : 'timestamp_unique',
      });
      continue;
    }
    let status;
    if (cam0.length >= 1 && cam1.length === 0) status = 'missing_cam1';
    else if (cam1.length >= 1 && cam0.length === 0) status = 'missing_cam0';
    else status = 'duplicate_pair';
    anomalies.push({
      source_subdir: relSubdir(leafDir),
      object_category: category,
      pair_key: key,
      pair_status: status,
      cam0_count: cam0.length,
      cam1_count: cam1.length,
      files: members.map((m) => path.basename(m.path)).sort(),
      file_paths: members.map((m) => m.path),
    });
  }
  return { pairs, anomalies };
}

// 扫描一个类别目录，返回所有配对（不计算 sha1，保证快）。
function scanCategoryPairs(category) {
  const categoryDir = path.join(TESTCOLLECTION_DIR, category);
  const files = walkImages(categoryDir);
  const byDir = new Map();
  let matched = 0;
  let skipped = 0;
  for (const filePath of files) {
    const parsed = parseFilename(path.basename(filePath));
    if (!parsed) {
      skipped += 1;
      continue;
    }
    matched += 1;
    parsed.path = filePath;
    parsed.dir = path.dirname(filePath);
    if (!byDir.has(parsed.dir)) byDir.set(parsed.dir, []);
    byDir.get(parsed.dir).push(parsed);
  }
  const pairs = [];
  const anomalies = [];
  for (const leafDir of Array.from(byDir.keys()).sort()) {
    const result = pairWithinDir(byDir.get(leafDir), leafDir, category);
    pairs.push(...result.pairs);
    anomalies.push(...result.anomalies);
  }
  return { pairs, anomalies, matched, skipped, scanned: files.length };
}

// 读取样本池，返回 sample_id 集合、cam1_sha1 映射、分类统计等。
function loadPool() {
  const sampleIds = new Set();
  const cam1Sha1 = new Map();
  const perCategory = new Map();
  const perBatch = new Map();
  let total = 0;
  if (!fs.existsSync(POOL_MANIFEST_PATH)) {
    return { sampleIds, cam1Sha1, perCategory, perBatch, total };
  }
  const lines = fs.readFileSync(POOL_MANIFEST_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    total += 1;
    if (obj.sample_id) sampleIds.add(obj.sample_id);
    if (obj.cam1_sha1 && !cam1Sha1.has(obj.cam1_sha1)) cam1Sha1.set(obj.cam1_sha1, obj.sample_id);
    const cat = obj.object_category || '';
    perCategory.set(cat, (perCategory.get(cat) || 0) + 1);
    const batch = obj.source_batch || '';
    perBatch.set(batch, (perBatch.get(batch) || 0) + 1);
  }
  return { sampleIds, cam1Sha1, perCategory, perBatch, total };
}

function listCategories() {
  if (!fs.existsSync(TESTCOLLECTION_DIR)) return [];
  return fs.readdirSync(TESTCOLLECTION_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// 页面状态：样本池总量 + 各类别待入池数量（只按 sample_id 估算，速度快）。
function getPoolStatus() {
  const pool = loadPool();
  const categories = listCategories();
  const categoryRows = [];
  for (const category of categories) {
    const { pairs, anomalies, matched, scanned } = scanCategoryPairs(category);
    let pending = 0;
    for (const p of pairs) {
      const sid = makeSampleId(p.timestamp, p.suffix);
      if (!pool.sampleIds.has(sid)) pending += 1;
    }
    categoryRows.push({
      category,
      scanned_files: scanned,
      matched_files: matched,
      pairs: pairs.length,
      in_pool_or_pending: pairs.length,
      pending,
      already_in_pool: pairs.length - pending,
      anomalies: anomalies.length,
    });
  }
  return {
    ok: true,
    testcollection_dir: TESTCOLLECTION_DIR,
    pool_exists: fs.existsSync(POOL_MANIFEST_PATH),
    total_samples: pool.total,
    samples_per_category: Object.fromEntries(Array.from(pool.perCategory.entries()).sort()),
    samples_per_batch: Object.fromEntries(Array.from(pool.perBatch.entries()).sort()),
    categories: categoryRows,
    updated_at: nowIso(),
  };
}

// 把一个类别目录里的新样本入池。dryRun=true 时只统计不写。
function ingestCategory(category, options = {}) {
  const dryRun = !!options.dryRun;
  if (!isValidCategoryName(category)) {
    return { ok: false, message: `非法类别名称: ${category}` };
  }
  const categoryDir = path.join(TESTCOLLECTION_DIR, category);
  if (!fs.existsSync(categoryDir) || !fs.statSync(categoryDir).isDirectory()) {
    return { ok: false, message: `类别目录不存在: ${categoryDir}` };
  }

  const pool = loadPool();
  const { pairs, anomalies, matched, skipped, scanned } = scanCategoryPairs(category);

  const newEntries = [];
  const contentDuplicates = [];
  let alreadyInPool = 0;
  const batchSha1Seen = new Map();

  const sortedPairs = pairs.slice().sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0;
  });

  const labelBase = `import_${dateTag()}_${safeLabel(options.batchLabel || `ui_${category}`)}`;
  let batchId = labelBase;
  if (!dryRun) {
    let attempt = 2;
    while (fs.existsSync(path.join(BATCHES_DIR, batchId))) {
      batchId = `${labelBase}__r${attempt}`;
      attempt += 1;
    }
  }

  for (const p of sortedPairs) {
    const sampleId = makeSampleId(p.timestamp, p.suffix);
    if (pool.sampleIds.has(sampleId)) {
      alreadyInPool += 1;
      continue;
    }
    const cam0Sha1 = sha1File(p.cam0.path);
    const cam1Sha1 = sha1File(p.cam1.path);
    const dupOf = pool.cam1Sha1.get(cam1Sha1) || batchSha1Seen.get(cam1Sha1);
    if (dupOf) {
      contentDuplicates.push({ sample_id: sampleId, duplicate_content_of: dupOf, cam1_sha1: cam1Sha1 });
      continue;
    }
    batchSha1Seen.set(cam1Sha1, sampleId);
    newEntries.push({
      sample_id: sampleId,
      object_category: category,
      source_batch: batchId,
      source_root: TESTCOLLECTION_DIR,
      source_subdir: relSubdir(p.cam0.dir),
      capture_timestamp: p.timestamp,
      pair_suffix: p.suffix,
      pair_method: p.pairMethod,
      pair_status: 'ok',
      cam0_path: p.cam0.path,
      cam1_path: p.cam1.path,
      cam0_sha1: cam0Sha1,
      cam1_sha1: cam1Sha1,
      first_seen_batch: batchId,
      created_at: nowIso(),
    });
  }

  const report = {
    batch_id: batchId,
    created_at: nowIso(),
    dry_run: dryRun,
    object_category: category,
    source_root: categoryDir,
    scanned_image_files: scanned,
    matched_filename_files: matched,
    skipped_non_matching_files: skipped,
    pairs_found: pairs.length,
    new_samples_added: newEntries.length,
    already_in_pool: alreadyInPool,
    content_duplicates: contentDuplicates.length,
    anomalies_total: anomalies.length,
  };

  if (dryRun) {
    return { ok: true, dry_run: true, report };
  }

  fs.mkdirSync(path.join(BATCHES_DIR, batchId), { recursive: true });
  const batchDir = path.join(BATCHES_DIR, batchId);
  fs.writeFileSync(
    path.join(batchDir, 'import_manifest.jsonl'),
    newEntries.map((e) => JSON.stringify(e)).join('\n') + (newEntries.length ? '\n' : ''),
    'utf8',
  );
  fs.writeFileSync(path.join(batchDir, 'import_anomalies.json'), JSON.stringify(anomalies, null, 2), 'utf8');
  fs.writeFileSync(path.join(batchDir, 'import_report.json'), JSON.stringify(report, null, 2), 'utf8');
  if (contentDuplicates.length) {
    fs.writeFileSync(path.join(batchDir, 'content_duplicates.json'), JSON.stringify(contentDuplicates, null, 2), 'utf8');
  }

  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  fs.appendFileSync(
    POOL_MANIFEST_PATH,
    newEntries.map((e) => JSON.stringify(e)).join('\n') + (newEntries.length ? '\n' : ''),
    'utf8',
  );

  writePoolReport(report);

  return { ok: true, dry_run: false, report, batch_dir: batchDir };
}

function writePoolReport(lastBatch) {
  const pool = loadPool();
  const poolReport = {
    updated_at: nowIso(),
    pool_manifest: POOL_MANIFEST_PATH,
    total_samples: pool.total,
    unique_sample_ids: pool.sampleIds.size,
    samples_per_category: Object.fromEntries(Array.from(pool.perCategory.entries()).sort()),
    samples_per_batch: Object.fromEntries(Array.from(pool.perBatch.entries()).sort()),
    last_batch: lastBatch || null,
  };
  fs.writeFileSync(POOL_REPORT_PATH, JSON.stringify(poolReport, null, 2), 'utf8');
}

// 文件名时间戳（用于报告文件名）：YYYYMMDD_HHMMSS。
function fileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 列出某类别的「坏组」（无法正常配对的原始图片组）及其文件绝对路径，供删除前预览确认。
function listCategoryBadGroups(category) {
  if (!isValidCategoryName(category)) {
    return { ok: false, message: `非法类别名称: ${category}` };
  }
  const { anomalies } = scanCategoryPairs(category);
  const groups = anomalies.map((a) => ({
    source_subdir: a.source_subdir,
    pair_key: a.pair_key,
    pair_status: a.pair_status,
    files: (a.file_paths || []).map((p) => ({ name: path.basename(p), path: p })),
  }));
  const fileCount = groups.reduce((s, g) => s + g.files.length, 0);
  return { ok: true, category, group_count: groups.length, file_count: fileCount, groups };
}

// 永久删除某类别的坏组原始图片文件。
// 安全约束：只删 testCollection 内部、且确实属于坏组的图片文件；删除前后生成报告，绝不碰已配对样本或样本池登记。
function deleteCategoryBadGroups(category) {
  if (!isValidCategoryName(category)) {
    return { ok: false, message: `非法类别名称: ${category}` };
  }
  const { anomalies } = scanCategoryPairs(category);
  const tcRoot = path.resolve(TESTCOLLECTION_DIR);
  const deleted = [];
  const failed = [];
  const skipped = [];
  for (const a of anomalies) {
    for (const filePath of (a.file_paths || [])) {
      const resolved = path.resolve(filePath);
      const inside = resolved === tcRoot || resolved.startsWith(tcRoot + path.sep);
      if (!inside) { skipped.push({ path: resolved, reason: '不在 testCollection 内' }); continue; }
      if (!IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) { skipped.push({ path: resolved, reason: '非图片文件' }); continue; }
      if (!fs.existsSync(resolved)) { skipped.push({ path: resolved, reason: '文件不存在' }); continue; }
      try {
        fs.unlinkSync(resolved);
        deleted.push({ path: resolved, pair_status: a.pair_status, source_subdir: a.source_subdir, pair_key: a.pair_key });
      } catch (error) {
        failed.push({ path: resolved, error: error.message || String(error) });
      }
    }
  }
  const reportDir = path.join(SAMPLES_DIR, 'deleted_bad_groups');
  fs.mkdirSync(reportDir, { recursive: true });
  const report = {
    category,
    deleted_at: nowIso(),
    group_count: anomalies.length,
    deleted_count: deleted.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
    deleted,
    failed,
    skipped,
  };
  const reportPath = path.join(reportDir, `${safeLabel(category)}_${fileStamp()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return {
    ok: true,
    category,
    group_count: anomalies.length,
    deleted_count: deleted.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
    report: reportPath,
  };
}

// 入池所有类别（逐类执行）。
function ingestAll(options = {}) {
  const categories = listCategories();
  const results = [];
  let totalNew = 0;
  for (const category of categories) {
    const result = ingestCategory(category, options);
    if (result.ok && result.report) totalNew += result.report.new_samples_added || 0;
    results.push({ category, ...result });
  }
  return { ok: true, dry_run: !!options.dryRun, total_new_samples: totalNew, results };
}

// 读取样本池全部条目，返回数组和按 sample_id 索引的 Map。
function loadPoolEntries() {
  const entries = [];
  const byId = new Map();
  if (!fs.existsSync(POOL_MANIFEST_PATH)) return { entries, byId };
  const lines = fs.readFileSync(POOL_MANIFEST_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    entries.push(obj);
    if (obj.sample_id) byId.set(obj.sample_id, obj);
  }
  return { entries, byId };
}

// 读取人工标注，按 sample_id 取最新一条（文件按追加写入）。
function loadAnnotations() {
  const byId = new Map();
  if (!fs.existsSync(ANNOTATIONS_PATH)) return byId;
  const lines = fs.readFileSync(ANNOTATIONS_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    if (obj.sample_id) byId.set(obj.sample_id, obj);
  }
  return byId;
}

// 标注页/挑选页样本列表：支持按类别、标注状态、标注字段过滤和分页。
// options.filters: { 字段名: 值 }，标量按相等匹配，多选字段（geometry_tags/material_tags）按“包含”匹配。
// 多选字段集（按“包含”匹配筛选）：由 schema 里 type==='multi' 自动派生。
const MULTI_FILTER_FIELDS = new Set(ANNOTATION_SCHEMA.filter((f) => f.type === 'multi').map((f) => f.key));
// 标注项筛选的「未填写」特殊值：筛出该字段为空（未标注）的样本。需与前端 EMPTY_FILTER 保持一致。
const EMPTY_FILTER_VALUE = '__empty__';

// 缩略图标签摘要：把已保存标注里“非空”的展示字段压成 [{l,v}]，供左侧缩略图紧凑显示。
// 排除：系统字段、人工结论(缩略图单独显示)、备注(可能很长)、样本有效性/复核状态(内部状态)。
const SUMMARY_EXCLUDE = new Set(['label', 'human_result', 'review_note', 'sample_validity', 'bm_review_status']);
const SUMMARY_FIELDS = ANNOTATION_SCHEMA.filter((f) => !f.system && !SUMMARY_EXCLUDE.has(f.key));
function annotationSummary(ann) {
  if (!ann) return [];
  const out = [];
  for (const f of SUMMARY_FIELDS) {
    const v = ann[f.key];
    if (Array.isArray(v)) { if (v.length) out.push({ l: f.shortLabel || f.label, v: v.join('/') }); }
    else if (v !== undefined && v !== null && v !== '') out.push({ l: f.shortLabel || f.label, v: String(v) });
  }
  return out;
}

// 由样本池条目推导采集日期（YYYY-MM-DD）：优先 capture_timestamp，其次 created_at。
function sampleDate(entry) {
  const ts = String((entry && entry.capture_timestamp) || '');
  if (/^\d{8}/.test(ts)) return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const created = String((entry && entry.created_at) || '');
  if (created.length >= 10) return created.slice(0, 10);
  return '';
}

// cam1 评估图存在性缓存（短 TTL）：避免列表翻页/筛选时对同一路径反复 stat。
const CAM1_EXISTS_CACHE = new Map();
const CAM1_EXISTS_TTL_MS = 15000;
function cam1Exists(p) {
  if (!p) return false;
  const now = Date.now();
  const hit = CAM1_EXISTS_CACHE.get(p);
  if (hit && now - hit.ts < CAM1_EXISTS_TTL_MS) return hit.exists;
  let exists = false;
  try { exists = fs.existsSync(p); } catch (e) { exists = false; }
  CAM1_EXISTS_CACHE.set(p, { exists, ts: now });
  return exists;
}

function listSamples(options = {}) {
  const { category = '', annStatus = 'all', limit = 60, offset = 0, filters = {}, date = '' } = options;
  // 模型结果范围与筛选：vlmModelKey 指定看哪个模型版本（空=最新）；
  // vlmFilter ∈ '', 'G', 'N', 'Unknown', 'none'(没有结果) / 'any'(有结果)。
  const vlmModelKey = options.vlmModelKey || '';
  const vlmFilter = options.vlmFilter || '';
  // 排除被标为「无效」的样本（sample_validity === 'invalid'）。仅当调用方明确要求时生效，
  // 默认不排除，保持标注页等其它入口的原有行为。
  const excludeInvalid = options.excludeInvalid || false;
  const { entries } = loadPoolEntries();
  const annotations = loadAnnotations();
  const vlmResults = loadVlmResults();

  let filtered = entries;
  if (category) filtered = filtered.filter((e) => e.object_category === category);
  // 自动跳过 cam1 评估图本地已删除的样本：删图后列表里不再出现裂图幽灵样本。
  // 非破坏性——不改 pool_manifest.jsonl，也不动标注；图片若恢复，样本会自动重新出现。
  filtered = filtered.filter((e) => cam1Exists(e.cam1_path));

  // 当前类别范围内可选的采集日期（供下拉），按日期倒序。
  const dateCounts = new Map();
  for (const e of filtered) {
    const d = sampleDate(e);
    if (d) dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
  }
  const availableDates = Array.from(dateCounts.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([d, count]) => ({ date: d, count }));

  const filterKeys = Object.keys(filters || {}).filter((k) => filters[k] !== '' && filters[k] !== undefined && filters[k] !== null);

  const withAnn = filtered.map((e) => {
    const ann = annotations.get(e.sample_id) || null;
    const labeled = !!(ann && (ann.human_result || ann.label));
    return { entry: e, ann, labeled };
  });

  let scoped = withAnn;
  if (annStatus === 'labeled') scoped = withAnn.filter((x) => x.labeled);
  else if (annStatus === 'unlabeled') scoped = withAnn.filter((x) => !x.labeled);

  if (date) scoped = scoped.filter((x) => sampleDate(x.entry) === date);

  if (excludeInvalid) scoped = scoped.filter((x) => !(x.ann && x.ann.sample_validity === 'invalid'));

  if (filterKeys.length) {
    scoped = scoped.filter((x) => {
      const ann = x.ann || {};
      for (const key of filterKeys) {
        const want = filters[key];
        if (MULTI_FILTER_FIELDS.has(key)) {
          const arr = Array.isArray(ann[key]) ? ann[key] : [];
          if (want === EMPTY_FILTER_VALUE) {
            if (arr.length) return false;
          } else if (!arr.includes(want)) {
            return false;
          }
        } else if (want === EMPTY_FILTER_VALUE) {
          if ((ann[key] || '') !== '') return false;
        } else if ((ann[key] || '') !== want) {
          return false;
        }
      }
      return true;
    });
  }

  // 模型结果筛选（按所选模型版本，空=最新一条）。
  // G/N：按模型预测类别；fn 漏判=人工夹住(G)但模型未夹住(N)；fp 误判=人工未夹住(N)但模型夹住(G)。
  if (vlmFilter) {
    scoped = scoped.filter((x) => {
      const rec = pickVlm(vlmResults.get(x.entry.sample_id), vlmModelKey);
      const pred = rec ? rec.pred : '';
      const humanLabel = x.ann ? (x.ann.label || deriveLabel(x.ann.human_result)) : '';
      if (vlmFilter === 'fn') return pred === 'N' && humanLabel === 'G';
      if (vlmFilter === 'fp') return pred === 'G' && humanLabel === 'N';
      if (vlmFilter === 'none') return !rec;
      if (vlmFilter === 'any') return !!rec;
      return pred === vlmFilter;
    });
  }

  const total = scoped.length;
  const page = scoped.slice(offset, offset + limit).map((x) => {
    const rec = pickVlm(vlmResults.get(x.entry.sample_id), vlmModelKey);
    return {
      sample_id: x.entry.sample_id,
      object_category: x.entry.object_category,
      source_subdir: x.entry.source_subdir,
      source_batch: x.entry.source_batch,
      cam1_name: x.entry.cam1_path ? path.basename(x.entry.cam1_path) : '',
      labeled: x.labeled,
      label: x.ann ? x.ann.label || '' : '',
      human_result: x.ann ? x.ann.human_result || '' : '',
      sample_validity: x.ann ? x.ann.sample_validity || '' : '',
      bm_review_status: x.ann ? x.ann.bm_review_status || '' : '',
      vlm_pred: rec ? rec.pred : '',
      vlm_raw: rec ? rec.raw : '',
      vlm_model_key: rec ? (rec.model_key || '') : '',
      ann_tags: annotationSummary(x.ann),
    };
  });

  const labeledCount = withAnn.filter((x) => x.labeled).length;
  return {
    ok: true,
    total,
    offset,
    limit,
    returned: page.length,
    category_total: filtered.length,
    labeled_in_category: labeledCount,
    available_dates: availableDates,
    samples: page,
  };
}

// 单个样本详情：样本池条目 + 当前标注。
function getSampleDetail(sampleId) {
  const { byId } = loadPoolEntries();
  const entry = byId.get(sampleId);
  if (!entry) return { ok: false, message: `样本不存在: ${sampleId}` };
  const ann = loadAnnotations().get(sampleId) || null;
  const defaults = getCategoryDefaults(entry.object_category);
  return { ok: true, entry, annotation: ann, defaults, annotation_fields: ANNOTATION_FIELDS };
}

// 保存人工标注：按字段合并后追加写入 annotations.jsonl。
// 以该样本上一次标注为基础，只用本次“非空”的字段覆盖；留空/未勾的字段保留上次的值，
// 使每个标签的保存相互独立、不会被同次表单里的空字段清掉（与批量保存一致）。
function saveAnnotation(sampleId, fields, operator) {
  const { byId } = loadPoolEntries();
  if (!byId.has(sampleId)) return { ok: false, message: `样本不存在: ${sampleId}` };

  // 本次提交里“非空”的字段（label 由 human_result 推导，不直接收）。
  const provided = {};
  for (const key of ANNOTATION_FIELDS) {
    if (key === 'label') continue;
    if (!Object.prototype.hasOwnProperty.call(fields || {}, key)) continue;
    const v = fields[key];
    const empty = Array.isArray(v) ? v.length === 0 : v === undefined || v === null || v === '';
    if (!empty) provided[key] = v;
  }

  // 以上一次标注为底叠加本次非空字段。
  const prev = loadAnnotations().get(sampleId) || {};
  const merged = {};
  for (const key of ANNOTATION_FIELDS) {
    if (prev[key] !== undefined) merged[key] = prev[key];
  }
  Object.assign(merged, provided);
  // 由人工结果自动推导 G/N 标签，保持与模型输出协议一致，供下游准召率统计使用。
  merged.label = deriveLabel(merged.human_result);

  const record = {
    sample_id: sampleId,
    ...merged,
    annotation_version: ANNOTATION_VERSION,
    operator: operator || '',
    updated_at: nowIso(),
  };
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  fs.appendFileSync(ANNOTATIONS_PATH, JSON.stringify(record) + '\n', 'utf8');
  return { ok: true, annotation: record };
}

// 批量保存标注：把 fields 中“非空”的字段一次性应用到多个样本。
// 每个样本以其已有标注为基础叠加（留空字段不改动），并重新推导 G/N。
function saveAnnotationBatch(sampleIds, fields, operator) {
  if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
    return { ok: false, message: '未选择样本' };
  }
  const { byId } = loadPoolEntries();
  const annotations = loadAnnotations();

  const provided = {};
  for (const key of ANNOTATION_FIELDS) {
    if (key === 'label') continue;
    if (!Object.prototype.hasOwnProperty.call(fields || {}, key)) continue;
    const v = fields[key];
    const empty = Array.isArray(v) ? v.length === 0 : v === undefined || v === null || v === '';
    if (!empty) provided[key] = v;
  }
  if (Object.keys(provided).length === 0) {
    return { ok: false, message: '没有要应用的字段（全部为空）' };
  }

  const lines = [];
  const missing = [];
  let applied = 0;
  for (const sid of sampleIds) {
    if (!byId.has(sid)) { missing.push(sid); continue; }
    const prev = annotations.get(sid) || {};
    const merged = {};
    for (const key of ANNOTATION_FIELDS) {
      if (prev[key] !== undefined) merged[key] = prev[key];
    }
    Object.assign(merged, provided);
    merged.label = deriveLabel(merged.human_result);
    lines.push(JSON.stringify({
      sample_id: sid,
      ...merged,
      annotation_version: ANNOTATION_VERSION,
      operator: operator || '',
      updated_at: nowIso(),
    }));
    applied += 1;
  }
  if (lines.length) {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    fs.appendFileSync(ANNOTATIONS_PATH, lines.join('\n') + '\n', 'utf8');
  }
  return { ok: true, applied, missing, applied_fields: Object.keys(provided) };
}

// 落盘一条样本级模型结果（追加写入，读取时按 sample_id + model_key 取最新）。
// pred 期望为 G / N / Unknown；raw 为模型原始输出。
function saveVlmResult(sampleId, modelKey, pred, raw) {
  if (!sampleId) return { ok: false, message: '缺少 sample_id' };
  const record = {
    sample_id: sampleId,
    model_key: modelKey || '',
    pred: pred || 'Unknown',
    raw: raw == null ? '' : String(raw),
    updated_at: nowIso(),
  };
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  fs.appendFileSync(POOL_VLM_PATH, JSON.stringify(record) + '\n', 'utf8');
  return { ok: true, record };
}

// 读取样本级模型结果。返回 Map：sample_id -> { byModel: {model_key: rec}, latest: rec }。
// 同一 (sample_id, model_key) 以文件中最后一条为准（追加写入，后写覆盖）。
function loadVlmResults() {
  const byId = new Map();
  if (!fs.existsSync(POOL_VLM_PATH)) return byId;
  const lines = fs.readFileSync(POOL_VLM_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (error) { continue; }
    if (!obj || !obj.sample_id) continue;
    let slot = byId.get(obj.sample_id);
    if (!slot) { slot = { byModel: {}, latest: null }; byId.set(obj.sample_id, slot); }
    slot.byModel[obj.model_key || ''] = obj;
    slot.latest = obj;
  }
  return byId;
}

// 取某样本在指定模型版本下的模型结果；未指定 model_key 时取最新一条。
function pickVlm(slot, modelKey) {
  if (!slot) return null;
  if (modelKey) return slot.byModel[modelKey] || null;
  return slot.latest || null;
}

// 硬删除一个样本：永久删除其 cam0/cam1 原图，并从样本池登记表移除该条目。
// 安全限制：只删除位于 testCollection / local_images 内的图片，防目录穿越；不写删除报告。
// 标注/模型结果等追加日志保持不动（样本已不在池中，不会再显示，历史也无需改写）。
function deleteSample(sampleId) {
  const sid = String(sampleId || '').trim();
  if (!sid) return { ok: false, message: '缺少 sample_id' };
  const { entries, byId } = loadPoolEntries();
  const entry = byId.get(sid);
  if (!entry) return { ok: false, message: `样本不存在: ${sid}` };

  const roots = [path.resolve(TESTCOLLECTION_DIR), path.resolve(LOCAL_IMAGE_DIR)];
  const insideAllowed = (resolved) => roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));

  const deletedFiles = [];
  const failed = [];
  for (const camKey of ['cam0_path', 'cam1_path']) {
    const p = entry[camKey];
    if (!p) continue;
    const resolved = path.resolve(p);
    if (!insideAllowed(resolved)) { failed.push({ path: resolved, reason: '不在允许目录内，已跳过' }); continue; }
    if (!fs.existsSync(resolved)) continue; // 文件本就不存在，视为已删除
    try { fs.unlinkSync(resolved); deletedFiles.push(resolved); }
    catch (error) { failed.push({ path: resolved, reason: error.message || String(error) }); }
  }

  // 重写 pool_manifest.jsonl，去掉该 sample_id 的所有行（manifest 可能有重复行）。
  const kept = entries.filter((e) => e.sample_id !== sid);
  const out = kept.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(POOL_MANIFEST_PATH, kept.length ? out + '\n' : '', 'utf8');

  return { ok: true, sample_id: sid, deleted_files: deletedFiles, failed, removed_from_pool: true };
}

// 解析样本某一路相机图片的真实路径，限制在 testCollection 内部，防目录穿越。
function resolveImagePath(sampleId, cam) {
  const { byId } = loadPoolEntries();
  const entry = byId.get(sampleId);
  if (!entry) return null;
  const target = String(cam) === '0' ? entry.cam0_path : entry.cam1_path;
  if (!target) return null;
  const resolved = path.resolve(target);
  // 允许两个根目录：testCollection（大水池原图）和 local_images（实时/上传登记入池）。
  const roots = [path.resolve(TESTCOLLECTION_DIR), path.resolve(LOCAL_IMAGE_DIR)];
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

// 把一组外部来源（实时抓拍 / 上传）已落盘的 cam0/cam1 登记进样本池。
// 只登记原路径，不复制、不移动图片。按 sample_id 与 cam1 内容 sha1 去重。
// 组对身份优先用 capture_group_id，其次 timestamp+pairSuffix。任何失败都返回结果，不抛异常。
function registerExternalPair(opts = {}) {
  try {
    const cam1Path = opts.cam1Path;
    if (!cam1Path || !fs.existsSync(cam1Path)) {
      return { ok: false, message: 'cam1 图片不存在，未登记入池' };
    }
    const category = isValidCategoryName(opts.objectCategory) ? String(opts.objectCategory).trim() : '未分类';
    const captureGroupId = opts.captureGroupId || '';
    const captureTimestamp = opts.captureTimestamp || '';
    const pairSuffix = opts.pairSuffix || '';
    const sampleId = captureGroupId
      || (captureTimestamp ? makeSampleId(captureTimestamp, pairSuffix) : `capture_group_${Date.now()}_${safeLabel(makeSampleId('', ''))}`);

    const pool = loadPool();
    if (pool.sampleIds.has(sampleId)) {
      return { ok: true, status: 'already_in_pool', sample_id: sampleId, object_category: category };
    }
    const cam1Sha1 = sha1File(cam1Path);
    const dupOf = pool.cam1Sha1.get(cam1Sha1);
    if (dupOf) {
      return { ok: true, status: 'content_duplicate', duplicate_of: dupOf, sample_id: sampleId };
    }
    const hasCam0 = opts.cam0Path && fs.existsSync(opts.cam0Path);
    const cam0Sha1 = hasCam0 ? sha1File(opts.cam0Path) : '';
    const sourceKind = opts.sourceKind || 'realtime';
    const batchId = opts.sourceBatch || `${sourceKind}_${dateTag()}`;
    const entry = {
      sample_id: sampleId,
      object_category: category,
      source_batch: batchId,
      source_root: path.dirname(cam1Path),
      source_subdir: '',
      capture_timestamp: captureTimestamp,
      pair_suffix: pairSuffix,
      pair_method: captureGroupId ? 'capture_group_id' : (pairSuffix ? 'timestamp_suffix' : 'timestamp_unique'),
      pair_status: hasCam0 ? 'ok' : 'missing_cam0',
      capture_group_id: captureGroupId,
      cam0_path: hasCam0 ? opts.cam0Path : '',
      cam1_path: cam1Path,
      cam0_sha1: cam0Sha1,
      cam1_sha1: cam1Sha1,
      source_kind: sourceKind,
      first_seen_batch: batchId,
      created_at: nowIso(),
    };
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    fs.appendFileSync(POOL_MANIFEST_PATH, JSON.stringify(entry) + '\n', 'utf8');
    return { ok: true, status: 'added', sample_id: sampleId, object_category: category, entry };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
}

// 新建一个物品类别目录（空目录），方便后续往里放图片。
function createCategory(category) {
  if (!isValidCategoryName(category)) {
    return { ok: false, message: `非法类别名称: ${category}` };
  }
  const categoryDir = path.join(TESTCOLLECTION_DIR, category);
  if (fs.existsSync(categoryDir)) {
    return { ok: false, message: `类别已存在: ${category}` };
  }
  fs.mkdirSync(categoryDir, { recursive: true });
  return { ok: true, category, dir: categoryDir };
}

module.exports = {
  getPoolStatus,
  ingestCategory,
  ingestAll,
  listCategoryBadGroups,
  deleteCategoryBadGroups,
  createCategory,
  listSamples,
  getSampleDetail,
  saveAnnotation,
  saveAnnotationBatch,
  deleteSample,
  resolveImagePath,
  saveVlmResult,
  loadVlmResults,
  registerExternalPair,
  loadObjectDictionary,
  addDictionaryCategory,
  getCategoryDefaults,
  deriveLabel,
  loadPoolEntries,
  loadAnnotations,
  TESTCOLLECTION_DIR,
  ANNOTATION_FIELDS,
};
