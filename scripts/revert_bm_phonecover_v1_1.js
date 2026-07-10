// 一次性：将 BM-PhoneCover-v1.1 恢复到创建时 51 张（去掉 2026-06-30 追加的 295 张）
'use strict';
const fs = require('fs');
const path = require('path');

const bmId = 'BM-PhoneCover-v1.1';
const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'eval_registry', 'bm', bmId);
const snapPath = path.join(dir, 'snapshot.jsonl');
const metaPath = path.join(dir, 'meta.json');
const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
const bakDir = path.join(ROOT, 'eval_registry', '_backups', `revert_${bmId}_${ts}`);

fs.mkdirSync(bakDir, { recursive: true });
fs.copyFileSync(snapPath, path.join(bakDir, 'snapshot.jsonl'));
fs.copyFileSync(metaPath, path.join(bakDir, 'meta.json'));

const lines = fs.readFileSync(snapPath, 'utf8').split(/\r?\n/).filter(Boolean);
const kept = lines.filter((l) => {
  try {
    const o = JSON.parse(l);
    return o.frozen_at && o.frozen_at.startsWith('2026-06-29');
  } catch (_) {
    return false;
  }
});

if (kept.length !== 51) {
  console.error(`预期保留 51 张，实际 ${kept.length}，已中止（备份在 ${bakDir}）`);
  process.exit(1);
}

let g = 0;
let n = 0;
let unlabeled = 0;
const perCat = {};
for (const l of kept) {
  const o = JSON.parse(l);
  if (o.label === 'G') g += 1;
  else if (o.label === 'N') n += 1;
  else unlabeled += 1;
  perCat[o.object_category] = (perCat[o.object_category] || 0) + 1;
}

const oldMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const meta = {
  bm_id: bmId,
  created_at: oldMeta.created_at || '2026-06-29T17:33:38+08:00',
  note: oldMeta.note || '',
  criteria: { mode: 'manual', picked: kept.length },
  total: kept.length,
  label_counts: { G: g, N: n },
  unlabeled_count: unlabeled,
  per_category_counts: perCat,
  missing: [],
};

fs.writeFileSync(snapPath, kept.join('\n') + '\n');
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

const report = {
  bm_id: bmId,
  ts,
  action: 'revert_to_creation_51',
  before_total: lines.length,
  after_total: kept.length,
  removed: lines.length - kept.length,
  label_counts: meta.label_counts,
  backup: bakDir,
};
fs.writeFileSync(path.join(bakDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
