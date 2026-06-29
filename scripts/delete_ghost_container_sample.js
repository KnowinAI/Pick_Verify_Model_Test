// 一次性脚本：删除裂图幽灵样本 capture_group_20260603082935_vix9kz
// 该样本 cam1 已丢失、不在样本池，但被冻结在 BM_Container_V1 / BM-V1 两个快照里，
// 跑这些快照时以「无法识别(Unknown)」出现。
// 操作：从两个快照删除该行并同步 meta 计数；从指定 run 删除该预测并重算指标。
// 全部先备份 .bak.<ts>，可回退。
'use strict';
const fs = require('fs');
const path = require('path');
const { computeAllMetrics } = require('../platform/model_run.js');

const SAMPLE_ID = 'capture_group_20260603082935_vix9kz';
const ROOT = path.resolve(__dirname, '..');
const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);

function backup(file) {
  const bak = `${file}.bak.${ts}`;
  fs.copyFileSync(file, bak);
  return bak;
}
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim().length);
}

const report = { sample_id: SAMPLE_ID, ts, snapshots: [], run: null };

// ---- 1. 处理两个快照 ----
for (const bmId of ['BM_Container_V1', 'BM-V1']) {
  const dir = path.join(ROOT, 'eval_registry', 'bm', bmId);
  const snapFile = path.join(dir, 'snapshot.jsonl');
  const metaFile = path.join(dir, 'meta.json');

  const lines = readJsonl(snapFile);
  const removed = [];
  const kept = lines.filter((l) => {
    let e;
    try { e = JSON.parse(l); } catch (_) { return true; }
    if (e.sample_id === SAMPLE_ID) { removed.push(e); return false; }
    return true;
  });
  if (!removed.length) { report.snapshots.push({ bmId, skipped: 'not_found' }); continue; }

  const bakSnap = backup(snapFile);
  fs.writeFileSync(snapFile, kept.join('\n') + '\n');

  const bakMeta = backup(metaFile);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  for (const e of removed) {
    if (typeof meta.total === 'number') meta.total -= 1;
    const lbl = e.label || e.gt_label || e.human_label;
    if (lbl && meta.label_counts && typeof meta.label_counts[lbl] === 'number') meta.label_counts[lbl] -= 1;
    const cat = e.object_category || e.category;
    if (cat && meta.per_category_counts && typeof meta.per_category_counts[cat] === 'number') meta.per_category_counts[cat] -= 1;
    if (meta.criteria && typeof meta.criteria.picked === 'number') meta.criteria.picked -= 1;
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  report.snapshots.push({ bmId, removed: removed.length, new_total: meta.total, bakSnap, bakMeta });
}

// ---- 2. 处理 run ----
const runDir = path.join(ROOT, 'eval_registry', 'runs', 'run_BM_Container_V1_pick_verifier_1_20260629_151215');
const predFile = path.join(runDir, 'predictions.jsonl');
const runMetaFile = path.join(runDir, 'meta.json');

const predLines = readJsonl(predFile);
let removedPred = 0;
const keptPred = predLines.filter((l) => {
  let p;
  try { p = JSON.parse(l); } catch (_) { return true; }
  if (p.sample_id === SAMPLE_ID) { removedPred += 1; return false; }
  return true;
});

if (removedPred) {
  const bakPred = backup(predFile);
  fs.writeFileSync(predFile, keptPred.join('\n') + '\n');

  const predictions = keptPred.map((l) => JSON.parse(l));
  const metrics = computeAllMetrics(predictions);
  const failed = predictions.filter((p) => p.error && String(p.error).length).length;

  const bakMeta = backup(runMetaFile);
  const meta = JSON.parse(fs.readFileSync(runMetaFile, 'utf8'));
  meta.total = predictions.length;
  meta.failed = failed;
  meta.success = predictions.length - failed;
  meta.metrics = metrics;
  fs.writeFileSync(runMetaFile, JSON.stringify(meta, null, 1));
  report.run = { removed: removedPred, new_total: meta.total, failed: meta.failed, accuracy: metrics.overall.accuracy, bakPred, bakMeta };
} else {
  report.run = { skipped: 'not_found' };
}

const reportFile = path.join(runDir, `delete_ghost_report_${ts}.json`);
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
