'use strict';

/**
 * 精准清理：只移除本次「PhoneCover -> Ruler」迁移涉及的 39 条 PhoneCover 失效条目。
 *
 * 安全规则：
 *   - 只处理下面写死的 39 个 sample_id，不碰池里其它任何条目（包括其它历史幽灵条目）。
 *   - 每条只有在「确属 PhoneCover」且「cam1_path 文件确实已不存在」时才移除（双保险，防误删）。
 *   - 移除前整文件备份到 eval_registry/_backups/pool_purge_relocated_<时间戳>/。
 *   - 不改 annotations.jsonl，不碰任何图片，不碰 BM 快照。
 *   - 生成 report.json。
 *
 * 用法：
 *   node scripts\purge_relocated_phonecover_rulers.js            # 演练
 *   node scripts\purge_relocated_phonecover_rulers.js --apply    # 实际清理
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SAMPLES_DIR = path.join(PROJECT_ROOT, 'eval_registry', 'samples');
const MANIFEST_PATH = path.join(SAMPLES_DIR, 'pool_manifest.jsonl');
const BACKUPS_DIR = path.join(PROJECT_ROOT, 'eval_registry', '_backups');

const APPLY = process.argv.includes('--apply');

// 第 2 批：10:00 窗口（首批 39 组已清理，见 eval_registry/_backups/pool_purge_relocated_20260629_123752）。
const GROUPS = [
  '20260617100006_90slof', '20260617100008_ovxsm6', '20260617100011_uxtkqm', '20260617100014_iudol9',
  '20260617100017_x7p4xf', '20260617100019_rtkvdi', '20260617100023_mekrql', '20260617100027_tz818r',
  '20260617100030_xo8r3k', '20260617100036_nvycj8', '20260617100041_kgme3x',
];
const TARGET_IDS = new Set(GROUPS.map((g) => `capture_group_${g}`));

function tsTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`找不到 ${MANIFEST_PATH}`);
  const lines = fs.readFileSync(MANIFEST_PATH, 'utf8').split(/\r?\n/);

  const keep = [];
  const removed = [];
  const skipped = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (_) { keep.push(line); continue; }
    if (!TARGET_IDS.has(e.sample_id)) { keep.push(line); continue; }

    const isPhoneCover = e.object_category === 'PhoneCover';
    const cam1Missing = !(e.cam1_path && fs.existsSync(e.cam1_path));
    if (isPhoneCover && cam1Missing) {
      removed.push({ sample_id: e.sample_id, object_category: e.object_category, cam1_path: e.cam1_path });
    } else {
      // 安全兜底：不符合“PhoneCover 且 cam1 已删”的目标条目，保留并记录，绝不误删。
      keep.push(line);
      skipped.push({ sample_id: e.sample_id, object_category: e.object_category, reason: isPhoneCover ? 'cam1_still_exists' : 'not_phonecover' });
    }
  }

  console.log(`模式: ${APPLY ? 'apply' : 'dry-run'}`);
  console.log(`目标 sample_id: ${TARGET_IDS.size}，将移除: ${removed.length}，跳过(不符合条件): ${skipped.length}`);
  if (skipped.length) console.log('跳过明细:', JSON.stringify(skipped));

  if (!removed.length) { console.log('没有符合条件的目标条目，无需清理。'); return; }

  if (!APPLY) {
    console.log('前 5 条将移除:');
    removed.slice(0, 5).forEach((r) => console.log(`  ${r.sample_id} | ${r.object_category}`));
    console.log('确认后加 --apply 实际执行。');
    return;
  }

  const backupDir = path.join(BACKUPS_DIR, `pool_purge_relocated_${tsTag()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(backupDir, 'pool_manifest.jsonl'));
  const report = {
    purged_at: new Date().toISOString(),
    scope: 'relocated_phonecover_rulers_only',
    target_ids: TARGET_IDS.size,
    removed_count: removed.length,
    skipped_count: skipped.length,
    removed_samples: removed,
    skipped_samples: skipped,
    note: 'annotations.jsonl / 图片 / BM 快照均未改动。',
  };
  fs.writeFileSync(path.join(backupDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(MANIFEST_PATH, keep.join('\n') + '\n', 'utf8');

  console.log('已备份到:', backupDir);
  console.log('清理后剩余条目:', keep.length);
}

main();
