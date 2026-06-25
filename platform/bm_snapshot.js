'use strict';

// BM 快照模块：从已标注样本中冻结一个固定测试集版本，作为回归/对比基准。
// 只读样本池与标注，产物写到 eval_registry/bm/<bm_id>/，不动原图与平台 records。

const fs = require('fs');
const path = require('path');
const samplePool = require('./sample_pool');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REGISTRY_DIR = path.join(PROJECT_ROOT, 'eval_registry');
const BM_DIR = path.join(REGISTRY_DIR, 'bm');

function nowIso() {
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(tz / 60)}:${pad(tz % 60)}`;
}

// 可复现的伪随机数发生器（同一 seed 得到同一抽样结果）。
function mulberry32(a) {
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isAnnotated(ann) {
  return !!(ann && ann.human_result);
}

function sanitizeBmId(name) {
  return String(name || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

// 各类别标注进度统计：总数 / 已标注 / G / N / 复核通过。
function getAnnotationStats() {
  const { entries } = samplePool.loadPoolEntries();
  const annotations = samplePool.loadAnnotations();
  const byCat = new Map();
  for (const e of entries) {
    const ann = annotations.get(e.sample_id);
    const cat = e.object_category;
    if (!byCat.has(cat)) byCat.set(cat, { category: cat, total: 0, annotated: 0, g: 0, n: 0, approved: 0 });
    const row = byCat.get(cat);
    row.total += 1;
    if (isAnnotated(ann)) {
      row.annotated += 1;
      if (ann.label === 'G') row.g += 1;
      else if (ann.label === 'N') row.n += 1;
      if (ann.bm_review_status === 'approved') row.approved += 1;
    }
  }
  const rows = Array.from(byCat.values()).sort((a, b) => (a.category < b.category ? -1 : 1));
  const totals = rows.reduce(
    (acc, r) => {
      acc.total += r.total; acc.annotated += r.annotated; acc.g += r.g; acc.n += r.n; acc.approved += r.approved;
      return acc;
    },
    { total: 0, annotated: 0, g: 0, n: 0, approved: 0 },
  );
  return { ok: true, rows, totals };
}

// 创建一个 BM 快照版本。
// 两种模式：
//   1) 手动挑选：opts.sampleIds = [...] 时，直接用这批样本（保留挑选顺序，去重）。
//   2) 自动配额：opts.perCategory / balanceLabel / onlyApproved / seed。
// opts: { bmId, note, sampleIds?, perCategory(number|null=全部), balanceLabel, onlyApproved, seed }
function createSnapshot(opts = {}) {
  const bmId = sanitizeBmId(opts.bmId);
  if (!bmId) return { ok: false, message: '请填写 BM 版本名称' };

  const manualIds = Array.isArray(opts.sampleIds) ? opts.sampleIds.filter(Boolean) : null;

  // ---- 手动挑选模式 ----
  if (manualIds && manualIds.length) {
    const dir0 = path.join(BM_DIR, bmId);
    if (fs.existsSync(dir0)) return { ok: false, message: `版本已存在：${bmId}（请换个名字）` };
    const { byId } = samplePool.loadPoolEntries();
    const annotations = samplePool.loadAnnotations();
    const ANN0 = samplePool.ANNOTATION_FIELDS;
    const seen = new Set();
    const lines0 = [];
    const perCat0 = {};
    const missing0 = [];
    let g0 = 0;
    let n0 = 0;
    let unlabeled0 = 0;
    for (const sid of manualIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const entry = byId.get(sid);
      if (!entry) { missing0.push(sid); continue; }
      const ann = annotations.get(sid) || {};
      const frozenAnn = {};
      for (const k of ANN0) { if (ann[k] !== undefined) frozenAnn[k] = ann[k]; }
      if (ann.label === 'G') g0 += 1; else if (ann.label === 'N') n0 += 1; else unlabeled0 += 1;
      perCat0[entry.object_category] = (perCat0[entry.object_category] || 0) + 1;
      lines0.push(JSON.stringify({
        sample_id: entry.sample_id,
        object_category: entry.object_category,
        cam0_path: entry.cam0_path,
        cam1_path: entry.cam1_path,
        cam1_sha1: entry.cam1_sha1,
        source_batch: entry.source_batch,
        ...frozenAnn,
        annotation_operator: ann.operator || '',
        annotation_updated_at: ann.updated_at || '',
        frozen_at: nowIso(),
      }));
    }
    if (lines0.length === 0) return { ok: false, message: '选中的样本在样本池中都找不到' };
    const meta0 = {
      bm_id: bmId,
      created_at: nowIso(),
      note: opts.note || '',
      criteria: { mode: 'manual', picked: manualIds.length },
      total: lines0.length,
      label_counts: { G: g0, N: n0 },
      unlabeled_count: unlabeled0,
      per_category_counts: perCat0,
      missing: missing0,
    };
    fs.mkdirSync(dir0, { recursive: true });
    fs.writeFileSync(path.join(dir0, 'snapshot.jsonl'), lines0.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(dir0, 'meta.json'), JSON.stringify(meta0, null, 2), 'utf8');
    return { ok: true, meta: meta0, dir: dir0 };
  }

  let perCategory = null;
  if (opts.perCategory !== null && opts.perCategory !== undefined && opts.perCategory !== '') {
    perCategory = parseInt(opts.perCategory, 10);
    if (!Number.isFinite(perCategory) || perCategory <= 0) {
      return { ok: false, message: '每类数量必须为正整数，或留空表示全部' };
    }
  }
  const balanceLabel = !!opts.balanceLabel;
  const onlyApproved = !!opts.onlyApproved;
  const seed = Number.isFinite(parseInt(opts.seed, 10)) ? parseInt(opts.seed, 10) : (Date.now() % 2147483647);

  const dir = path.join(BM_DIR, bmId);
  if (fs.existsSync(dir)) return { ok: false, message: `版本已存在：${bmId}（请换个名字）` };

  const { entries } = samplePool.loadPoolEntries();
  const annotations = samplePool.loadAnnotations();
  const ANN = samplePool.ANNOTATION_FIELDS;

  const byCat = new Map();
  for (const e of entries) {
    const ann = annotations.get(e.sample_id);
    if (!isAnnotated(ann)) continue;
    if (onlyApproved && ann.bm_review_status !== 'approved') continue;
    if (!byCat.has(e.object_category)) byCat.set(e.object_category, []);
    byCat.get(e.object_category).push({ entry: e, ann });
  }

  const rng = mulberry32(seed);
  const chosen = [];
  const perCatCounts = {};
  for (const [cat, list] of Array.from(byCat.entries()).sort()) {
    let pick;
    if (perCategory === null) {
      pick = list;
    } else if (balanceLabel) {
      const gs = shuffle(list.filter((x) => x.ann.label === 'G'), rng);
      const ns = shuffle(list.filter((x) => x.ann.label === 'N'), rng);
      const half = Math.floor(perCategory / 2);
      const takeG = gs.slice(0, half);
      const takeN = ns.slice(0, perCategory - half);
      pick = takeG.concat(takeN);
      if (pick.length < perCategory) {
        const rest = shuffle(gs.slice(takeG.length).concat(ns.slice(takeN.length)), rng);
        pick = pick.concat(rest.slice(0, perCategory - pick.length));
      }
    } else {
      pick = shuffle(list, rng).slice(0, perCategory);
    }
    perCatCounts[cat] = pick.length;
    for (const x of pick) chosen.push(x);
  }

  if (chosen.length === 0) return { ok: false, message: '没有符合条件的已标注样本' };

  const lines = [];
  let gCount = 0;
  let nCount = 0;
  for (const { entry, ann } of chosen) {
    const frozenAnn = {};
    for (const k of ANN) {
      if (ann[k] !== undefined) frozenAnn[k] = ann[k];
    }
    if (ann.label === 'G') gCount += 1;
    else if (ann.label === 'N') nCount += 1;
    lines.push(JSON.stringify({
      sample_id: entry.sample_id,
      object_category: entry.object_category,
      cam0_path: entry.cam0_path,
      cam1_path: entry.cam1_path,
      cam1_sha1: entry.cam1_sha1,
      source_batch: entry.source_batch,
      ...frozenAnn,
      annotation_operator: ann.operator || '',
      annotation_updated_at: ann.updated_at || '',
      frozen_at: nowIso(),
    }));
  }

  const meta = {
    bm_id: bmId,
    created_at: nowIso(),
    note: opts.note || '',
    criteria: { per_category: perCategory, balance_label: balanceLabel, only_approved: onlyApproved, seed },
    total: chosen.length,
    label_counts: { G: gCount, N: nCount },
    per_category_counts: perCatCounts,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshot.jsonl'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, meta, dir };
}

function listSnapshots() {
  if (!fs.existsSync(BM_DIR)) return { ok: true, snapshots: [] };
  const items = [];
  for (const name of fs.readdirSync(BM_DIR)) {
    const metaPath = path.join(BM_DIR, name, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try { items.push(JSON.parse(fs.readFileSync(metaPath, 'utf8'))); } catch (e) { /* skip */ }
    }
  }
  items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { ok: true, snapshots: items };
}

function getSnapshot(bmId) {
  const id = sanitizeBmId(bmId);
  const dir = path.join(BM_DIR, id);
  const metaPath = path.join(dir, 'meta.json');
  const snapPath = path.join(dir, 'snapshot.jsonl');
  if (!fs.existsSync(metaPath)) return { ok: false, message: '快照不存在' };
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const samples = fs.existsSync(snapPath)
    ? fs.readFileSync(snapPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { ok: true, meta, samples };
}

function snapshotFilePath(bmId) {
  const id = sanitizeBmId(bmId);
  const p = path.join(BM_DIR, id, 'snapshot.jsonl');
  return fs.existsSync(p) ? p : null;
}

// 向已有快照追加样本：把选中的样本（连同当时标注）冻结追加到 snapshot.jsonl，并重算 meta 计数。
// 已锁定的快照拒绝追加；已在快照中的样本按 sample_id 去重跳过；池中找不到的记入 missing。
function addSamplesToSnapshot(bmId, sampleIds) {
  const id = sanitizeBmId(bmId);
  const dir = path.join(BM_DIR, id);
  const metaPath = path.join(dir, 'meta.json');
  const snapPath = path.join(dir, 'snapshot.jsonl');
  if (!fs.existsSync(metaPath)) return { ok: false, message: '快照不存在' };
  const ids = Array.isArray(sampleIds) ? sampleIds.filter(Boolean) : [];
  if (!ids.length) return { ok: false, message: '未选择要追加的样本' };

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch (error) { return { ok: false, message: `meta.json 解析失败，未改动: ${error.message || error}` }; }
  if (meta.locked) return { ok: false, message: '该快照已锁定，请先解锁再追加样本' };

  const existingLines = fs.existsSync(snapPath)
    ? fs.readFileSync(snapPath, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const existingObjs = existingLines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const existingIds = new Set(existingObjs.map((o) => o.sample_id));

  const { byId } = samplePool.loadPoolEntries();
  const annotations = samplePool.loadAnnotations();
  const ANN = samplePool.ANNOTATION_FIELDS;

  const newObjs = [];
  const missing = [];
  let skippedExisting = 0;
  const seen = new Set();
  for (const sid of ids) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    if (existingIds.has(sid)) { skippedExisting += 1; continue; }
    const entry = byId.get(sid);
    if (!entry) { missing.push(sid); continue; }
    const ann = annotations.get(sid) || {};
    const frozenAnn = {};
    for (const k of ANN) { if (ann[k] !== undefined) frozenAnn[k] = ann[k]; }
    newObjs.push({
      sample_id: entry.sample_id,
      object_category: entry.object_category,
      cam0_path: entry.cam0_path,
      cam1_path: entry.cam1_path,
      cam1_sha1: entry.cam1_sha1,
      source_batch: entry.source_batch,
      ...frozenAnn,
      annotation_operator: ann.operator || '',
      annotation_updated_at: ann.updated_at || '',
      frozen_at: nowIso(),
    });
  }

  if (!newObjs.length) {
    return { ok: false, message: `没有可追加的新样本（已存在 ${skippedExisting} 张，找不到 ${missing.length} 张）`, added: 0, skipped_existing: skippedExisting, missing };
  }

  // 追加写入，并基于“已有 + 新增”整体重算计数。
  fs.appendFileSync(snapPath, newObjs.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  const all = existingObjs.concat(newObjs);
  let g = 0; let n = 0; let unlabeled = 0;
  const perCat = {};
  for (const o of all) {
    if (o.label === 'G') g += 1; else if (o.label === 'N') n += 1; else unlabeled += 1;
    perCat[o.object_category] = (perCat[o.object_category] || 0) + 1;
  }
  meta.total = all.length;
  meta.label_counts = { G: g, N: n };
  meta.unlabeled_count = unlabeled;
  meta.per_category_counts = perCat;
  meta.updated_at = nowIso();
  meta.last_added = { at: nowIso(), added: newObjs.length, skipped_existing: skippedExisting, missing_count: missing.length };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, bm_id: id, added: newObjs.length, skipped_existing: skippedExisting, missing, meta };
}

// 锁定/解锁某个快照：在 meta.json 写入 locked 标记。锁定后禁止删除（防误删基准）。
function setSnapshotLock(bmId, locked) {
  const id = sanitizeBmId(bmId);
  const metaPath = path.join(BM_DIR, id, 'meta.json');
  if (!fs.existsSync(metaPath)) return { ok: false, message: '快照不存在' };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch (error) { return { ok: false, message: `meta.json 解析失败，未改动: ${error.message || error}` }; }
  meta.locked = !!locked;
  meta.lock_updated_at = nowIso();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, bm_id: id, locked: meta.locked };
}

// 删除某个快照目录。已锁定的拒绝删除（需先解锁）。整目录移除，不影响其它快照与原图。
function deleteSnapshot(bmId) {
  const id = sanitizeBmId(bmId);
  const dir = path.join(BM_DIR, id);
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(dir)) return { ok: false, message: '快照不存在' };
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.locked) return { ok: false, message: '该快照已锁定，请先解锁再删除' };
    } catch (error) { /* meta 损坏时仍允许删除目录 */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, bm_id: id, deleted: true };
}

module.exports = {
  getAnnotationStats,
  createSnapshot,
  listSnapshots,
  getSnapshot,
  snapshotFilePath,
  setSnapshotLock,
  deleteSnapshot,
  addSamplesToSnapshot,
  BM_DIR,
};
