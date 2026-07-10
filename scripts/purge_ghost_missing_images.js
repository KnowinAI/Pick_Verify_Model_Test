// 清理「缺图幽灵样本」：cam1 图片文件已从磁盘丢失、无法再评测的样本。
// 从所有 BM 快照 + 所有 run 的预测里按 sample_id 一并移除，并重算 meta / 指标，
// 让本次与历史 run 在同一份样本集上可比。全程备份到 _backups，可回退。
//
// 幽灵集合 = 以下并集：
//   A) 各快照里 cam1_path 指向的文件不存在的样本；
//   B) 各 run 预测里 error 含「找不到 cam1」的样本（跑测时图已缺失）。
//
// 用法：node scripts/purge_ghost_missing_images.js --dry-run   # 只统计不改动
//       node scripts/purge_ghost_missing_images.js             # 实际执行
'use strict';
const fs = require('fs');
const path = require('path');
const { computeAllMetrics } = require('../platform/model_run.js');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.resolve(__dirname, '..');
const BM_DIR = path.join(ROOT, 'eval_registry', 'bm');
const RUNS_DIR = path.join(ROOT, 'eval_registry', 'runs');
const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
const backupRoot = path.join(ROOT, 'eval_registry', '_backups', `purge_ghost_missing_${ts}`);

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim().length);
const nowIso = () => new Date().toISOString();

// ---- Pass 1：构建幽灵集合 ----
const ghost = new Set();
const cam1MissRe = /找不到\s*cam1|cam1\s*图片/;

for (const bm of fs.readdirSync(BM_DIR)) {
  const snap = path.join(BM_DIR, bm, 'snapshot.jsonl');
  if (!fs.existsSync(snap)) continue;
  for (const l of readJsonl(snap)) {
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.cam1_path && !fs.existsSync(o.cam1_path)) ghost.add(o.sample_id);
  }
}
for (const run of fs.readdirSync(RUNS_DIR)) {
  const pred = path.join(RUNS_DIR, run, 'predictions.jsonl');
  if (!fs.existsSync(pred)) continue;
  for (const l of readJsonl(pred)) {
    let p; try { p = JSON.parse(l); } catch (_) { continue; }
    if (p.error && cam1MissRe.test(String(p.error))) ghost.add(p.sample_id);
  }
}

const report = { ts, dry_run: DRY, ghost_count: ghost.size, ghost_ids: Array.from(ghost).sort(), snapshots: [], runs: [] };

if (!DRY && ghost.size) fs.mkdirSync(backupRoot, { recursive: true });

// ---- Pass 2：清理快照 ----
for (const bm of fs.readdirSync(BM_DIR)) {
  const dir = path.join(BM_DIR, bm);
  const snap = path.join(dir, 'snapshot.jsonl');
  const metaF = path.join(dir, 'meta.json');
  if (!fs.existsSync(snap)) continue;
  const lines = readJsonl(snap);
  const kept = [];
  let removed = 0;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (_) { kept.push(l); continue; }
    if (ghost.has(o.sample_id)) removed += 1; else kept.push(l);
  }
  if (!removed) { report.snapshots.push({ bm, removed: 0 }); continue; }

  let g = 0; let n = 0; let unlab = 0; const perCat = {};
  for (const l of kept) { const o = JSON.parse(l); if (o.label === 'G') g += 1; else if (o.label === 'N') n += 1; else unlab += 1; perCat[o.object_category] = (perCat[o.object_category] || 0) + 1; }

  if (!DRY) {
    const bdir = path.join(backupRoot, 'bm', bm);
    fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(snap, path.join(bdir, 'snapshot.jsonl'));
    if (fs.existsSync(metaF)) fs.copyFileSync(metaF, path.join(bdir, 'meta.json'));
    fs.writeFileSync(snap, kept.join('\n') + '\n');
    if (fs.existsSync(metaF)) {
      const m = JSON.parse(fs.readFileSync(metaF, 'utf8'));
      m.total = kept.length;
      m.label_counts = { G: g, N: n };
      m.unlabeled_count = unlab;
      m.per_category_counts = perCat;
      if (m.criteria && typeof m.criteria.picked === 'number') m.criteria.picked = kept.length;
      m.updated_at = nowIso();
      m.ghost_purge = { at: nowIso(), removed };
      fs.writeFileSync(metaF, JSON.stringify(m, null, 2));
    }
  }
  report.snapshots.push({ bm, removed, new_total: kept.length });
}

// ---- Pass 3：清理 run ----
for (const run of fs.readdirSync(RUNS_DIR)) {
  const dir = path.join(RUNS_DIR, run);
  const pred = path.join(dir, 'predictions.jsonl');
  const metaF = path.join(dir, 'meta.json');
  if (!fs.existsSync(pred)) continue;
  const lines = readJsonl(pred);
  const kept = [];
  let removed = 0;
  for (const l of lines) {
    let p; try { p = JSON.parse(l); } catch (_) { kept.push(l); continue; }
    if (ghost.has(p.sample_id)) removed += 1; else kept.push(l);
  }
  if (!removed) { report.runs.push({ run, removed: 0 }); continue; }

  const predictions = kept.map((l) => JSON.parse(l));
  const metrics = computeAllMetrics(predictions);
  const failed = predictions.filter((p) => p.error && String(p.error).length).length;

  if (!DRY) {
    const bdir = path.join(backupRoot, 'runs', run);
    fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(pred, path.join(bdir, 'predictions.jsonl'));
    if (fs.existsSync(metaF)) fs.copyFileSync(metaF, path.join(bdir, 'meta.json'));
    fs.writeFileSync(pred, kept.join('\n') + '\n');
    if (fs.existsSync(metaF)) {
      const m = JSON.parse(fs.readFileSync(metaF, 'utf8'));
      m.total = predictions.length;
      m.failed = failed;
      m.success = predictions.length - failed;
      m.metrics = metrics;
      m.ghost_purge = { at: nowIso(), removed };
      fs.writeFileSync(metaF, JSON.stringify(m, null, 2));
    }
  }
  report.runs.push({ run, removed, new_total: predictions.length, accuracy: metrics.overall.accuracy });
}

if (!DRY && ghost.size) fs.writeFileSync(path.join(backupRoot, 'report.json'), JSON.stringify(report, null, 2));

// ---- 输出摘要 ----
console.log('=== 缺图幽灵样本清理', DRY ? '(DRY-RUN 预览)' : '(已执行)', '===');
console.log('幽灵样本数:', ghost.size);
console.log('\n受影响快照:');
for (const s of report.snapshots.filter((x) => x.removed)) console.log(`  ${s.bm}: -${s.removed} -> ${s.new_total}`);
console.log('\n受影响 run:');
for (const r of report.runs.filter((x) => x.removed)) console.log(`  ${r.run}: -${r.removed} -> ${r.new_total} (acc ${r.accuracy != null ? (r.accuracy * 100).toFixed(2) + '%' : '—'})`);
if (!DRY && ghost.size) console.log('\n备份+报告:', backupRoot);
