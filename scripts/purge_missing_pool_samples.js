/**
 * 清理样本池里「cam1 评估图本地已删除」的失效条目。
 *
 * 背景：本地手动删除图片后，pool_manifest.jsonl 仍引用这些图片，标注页会显示一堆裂图幽灵样本。
 * 本脚本只处理 pool_manifest.jsonl，安全规则：
 *   - 只移除 cam1_path 指向的文件已不存在的条目（cam0 不存在不算，cam0 只是参考图）。
 *   - 移除前整文件备份到 eval_registry/_backups/pool_purge_<时间戳>/。
 *   - 不删除、不修改 annotations.jsonl：保留标注历史，图片若恢复重新入池可自动对回。
 *   - 不触碰任何图片文件。
 *   - 生成 report.json，记录被移除的 sample_id / 类别 / 路径 / 是否已标注 / 是否在 BM 快照里。
 *
 * 用法（在项目根目录）：
 *   node scripts/purge_missing_pool_samples.js --dry-run   # 只看会删哪些，不写盘
 *   node scripts/purge_missing_pool_samples.js             # 实际清理（自动备份）
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(PROJECT_ROOT, 'eval_registry', 'samples');
const MANIFEST_PATH = path.join(SAMPLES_DIR, 'pool_manifest.jsonl');
const ANNOTATIONS_PATH = path.join(SAMPLES_DIR, 'annotations.jsonl');
const BM_DIR = path.join(PROJECT_ROOT, 'eval_registry', 'bm');
const BACKUPS_DIR = path.join(PROJECT_ROOT, 'eval_registry', '_backups');

const DRY_RUN = process.argv.includes('--dry-run');

function tsTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function loadLabeledSet() {
  const set = new Set();
  if (!fs.existsSync(ANNOTATIONS_PATH)) return set;
  for (const line of fs.readFileSync(ANNOTATIONS_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const a = JSON.parse(t);
      if (a.sample_id && (a.human_result || a.label)) set.add(a.sample_id);
    } catch (e) { /* skip */ }
  }
  return set;
}

function loadBmSampleMap() {
  // sample_id -> [bm_id...]，用于提示失效样本是否已被冻结进 BM 快照。
  const map = new Map();
  if (!fs.existsSync(BM_DIR)) return map;
  for (const bmId of fs.readdirSync(BM_DIR)) {
    const snap = path.join(BM_DIR, bmId, 'snapshot.jsonl');
    if (!fs.existsSync(snap)) continue;
    for (const line of fs.readFileSync(snap, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (r.sample_id) {
          if (!map.has(r.sample_id)) map.set(r.sample_id, []);
          map.get(r.sample_id).push(bmId);
        }
      } catch (e) { /* skip */ }
    }
  }
  return map;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('找不到 pool_manifest.jsonl：', MANIFEST_PATH);
    process.exit(1);
  }
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);
  const labeled = loadLabeledSet();
  const bmMap = loadBmSampleMap();

  const keepLines = [];
  const removed = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (err) { keepLines.push(line); continue; }
    const cam1 = e.cam1_path || '';
    const alive = cam1 && fs.existsSync(cam1);
    if (alive) {
      keepLines.push(line);
    } else {
      removed.push({
        sample_id: e.sample_id || '',
        object_category: e.object_category || '',
        cam1_path: cam1,
        labeled: labeled.has(e.sample_id),
        in_bm: bmMap.get(e.sample_id) || [],
      });
    }
  }

  const total = keepLines.length + removed.length;
  const removedLabeled = removed.filter((r) => r.labeled).length;
  const removedInBm = removed.filter((r) => r.in_bm.length).length;
  const byCat = {};
  for (const r of removed) byCat[r.object_category] = (byCat[r.object_category] || 0) + 1;

  console.log(DRY_RUN ? '[DRY-RUN] 仅预览，不写盘' : '[执行清理]');
  console.log('样本池总条目:', total);
  console.log('保留:', keepLines.length);
  console.log('将移除(cam1 图片已删除):', removed.length);
  console.log('  其中已标注:', removedLabeled);
  console.log('  其中已进入 BM 快照:', removedInBm, removedInBm ? '(BM 快照为独立冻结副本，不受影响)' : '');
  console.log('  按类别:', JSON.stringify(byCat));

  if (removed.length === 0) {
    console.log('没有失效样本，无需清理。');
    return;
  }

  if (DRY_RUN) {
    console.log('\n前 10 条将被移除：');
    removed.slice(0, 10).forEach((r) => console.log(`  ${r.sample_id} | ${r.object_category} | labeled=${r.labeled} | ${r.cam1_path}`));
    console.log('\n确认无误后去掉 --dry-run 再次运行即可实际清理。');
    return;
  }

  // 备份 + 写盘 + 报告
  const backupDir = path.join(BACKUPS_DIR, `pool_purge_${tsTag()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(backupDir, 'pool_manifest.jsonl'));

  const report = {
    purged_at: new Date().toISOString(),
    manifest: MANIFEST_PATH,
    total_before: total,
    kept: keepLines.length,
    removed_count: removed.length,
    removed_labeled: removedLabeled,
    removed_in_bm: removedInBm,
    removed_by_category: byCat,
    removed_samples: removed,
    note: 'annotations.jsonl 未改动；图片文件未改动；BM 快照为独立副本未改动。',
  };
  fs.writeFileSync(path.join(backupDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  fs.writeFileSync(MANIFEST_PATH, keepLines.join('\n') + '\n', 'utf8');

  console.log('\n已备份原清单到:', backupDir);
  console.log('已写出清理后清单，剩余条目:', keepLines.length);
  console.log('报告:', path.join(backupDir, 'report.json'));
}

main();
