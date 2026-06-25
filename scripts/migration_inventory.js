'use strict';

// Phase 0 只读盘点：统计 records / annotations / 样本池 / 图片目录现状，生成迁移前基线。
// 严格只读：不写、不改、不删任何数据或图片。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'platform', 'gripper_eval_data.json');
const POOL_MANIFEST = path.join(ROOT, 'eval_registry', 'samples', 'pool_manifest.jsonl');
const ANNOTATIONS = path.join(ROOT, 'eval_registry', 'samples', 'annotations.jsonl');
const LOCAL_IMAGE_DIR = path.join(ROOT, 'local_images');
const TESTCOLLECTION = path.join(ROOT, 'testCollection');
const BM_DIR = path.join(ROOT, 'eval_registry', 'bm');
const RUNS_DIR = path.join(ROOT, 'eval_registry', 'runs');

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function countDir(dir, exts) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.isFile() && (!exts || exts.includes(path.extname(name).toLowerCase()))) n += 1;
  }
  return n;
}

const IMG = ['.jpg', '.jpeg', '.png', '.webp'];
const report = { generated_at: new Date().toISOString() };

// ---- records ----
if (fs.existsSync(DATA_PATH)) {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const records = data.records || {};
  const ids = Object.keys(records);
  let withLocalSource = 0, labeled = 0, withVlm = 0;
  const catDist = {};
  for (const id of ids) {
    const r = records[id] || {};
    if (r.local_source) withLocalSource += 1;
    const ann = r.annotation || {};
    if (ann.human_result || r.human_result) labeled += 1;
    if (r.vlm || r.model_result || (ann && ann.model_result)) withVlm += 1;
    const cat = (r.local_source && r.local_source.source_metadata && r.local_source.source_metadata.object_category)
      || ann.object_tag || r.object_tag || '(无类别)';
    catDist[cat] = (catDist[cat] || 0) + 1;
  }
  report.records = { total: ids.length, with_local_source: withLocalSource, labeled, with_vlm: withVlm, category_distribution: catDist };
} else {
  report.records = { error: 'records 文件不存在', path: DATA_PATH };
}

// ---- 样本池 ----
const pool = readJsonl(POOL_MANIFEST);
const poolCat = {};
for (const e of pool) poolCat[e.object_category || '(无类别)'] = (poolCat[e.object_category || '(无类别)'] || 0) + 1;
report.pool = { total: pool.length, category_distribution: poolCat };

// ---- 标注 ----
const anns = readJsonl(ANNOTATIONS);
const annIds = new Set(anns.map((a) => a.sample_id));
report.annotations = { total_lines: anns.length, unique_samples: annIds.size };

// ---- 图片目录 ----
report.local_images = { count: countDir(LOCAL_IMAGE_DIR, IMG), path: LOCAL_IMAGE_DIR };
const tcCat = {};
if (fs.existsSync(TESTCOLLECTION)) {
  for (const name of fs.readdirSync(TESTCOLLECTION)) {
    const full = path.join(TESTCOLLECTION, name);
    if (fs.statSync(full).isDirectory()) tcCat[name] = countDir(full, IMG);
  }
}
report.testCollection = { category_image_counts: tcCat, total: Object.values(tcCat).reduce((a, b) => a + b, 0) };

// ---- BM 快照 / runs ----
report.bm_snapshots = fs.existsSync(BM_DIR) ? fs.readdirSync(BM_DIR).filter((n) => fs.statSync(path.join(BM_DIR, n)).isDirectory()).length : 0;
report.runs = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).filter((n) => fs.statSync(path.join(RUNS_DIR, n)).isDirectory()).length : 0;

console.log(JSON.stringify(report, null, 2));
