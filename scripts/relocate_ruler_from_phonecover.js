'use strict';

/**
 * 一次性脚本：把 PhoneCover/20260616 里被误放的「尺子/三角板/量角器」图组
 * 复制到 testCollection/Ruler/，校验一致后再删除 PhoneCover 源文件。
 *
 * 数据安全约定：
 * - 先复制 + SHA1 校验，只有复制成功且字节一致的组才允许删除源。
 * - 目标已存在且 SHA1 相同 -> 视为已复制，跳过复制、继续删源。
 * - 目标已存在但 SHA1 不同 -> 该组中止（绝不覆盖），并计入异常，不删源。
 * - 全程生成 manifest.jsonl + report.json，记录来源/目标/SHA1。
 * - 仅处理下面明确列出的 39 组（人工逐张确认过是尺子），不扩大范围。
 *
 * 用法：
 *   node scripts\relocate_ruler_from_phonecover.js            # 演练（dry-run，只复制+校验+出报告，不删源）
 *   node scripts\relocate_ruler_from_phonecover.js --apply    # 实际执行：复制 + 校验 + 删源
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'testCollection', 'PhoneCover', '20260616');
const DEST_DIR = path.join(PROJECT_ROOT, 'testCollection', 'Ruler');
const REPORT_ROOT = path.join(PROJECT_ROOT, 'reports');

const APPLY = process.argv.includes('--apply');

// 人工逐张确认为尺子的组：<timestamp>_<suffix>
// 第 2 批：10:00 窗口（首批 39 组已迁移完毕，见 reports/ruler_relocation_20260629_122444）。
const GROUPS = [
  '20260617100006_90slof', '20260617100008_ovxsm6', '20260617100011_uxtkqm', '20260617100014_iudol9',
  '20260617100017_x7p4xf', '20260617100019_rtkvdi', '20260617100023_mekrql', '20260617100027_tz818r',
  '20260617100030_xo8r3k', '20260617100036_nvycj8', '20260617100041_kgme3x',
];

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  if (!fs.existsSync(SRC_DIR)) throw new Error(`源目录不存在: ${SRC_DIR}`);
  if (!fs.existsSync(DEST_DIR)) throw new Error(`目标目录不存在: ${DEST_DIR}`);

  const reportDir = path.join(REPORT_ROOT, `ruler_relocation_${stamp()}`);
  fs.mkdirSync(reportDir, { recursive: true });

  const manifest = [];
  const report = {
    created_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    src_dir: SRC_DIR,
    dest_dir: DEST_DIR,
    total_groups: GROUPS.length,
    copied_files: 0,
    already_present: 0,
    deleted_files: 0,
    anomalies: [],
  };

  // 先做一轮复制 + 校验；每组的 cam0/cam1 都通过才允许删源。
  for (const group of GROUPS) {
    const entry = { group, sample_id: `capture_group_${group}`, files: [], copy_ok: true };
    for (const cam of ['cam0', 'cam1']) {
      const name = `${cam}_${group}.jpg`;
      const src = path.join(SRC_DIR, name);
      const dest = path.join(DEST_DIR, name);
      const fileRec = { cam, name, src, dest };

      if (!fs.existsSync(src)) {
        fileRec.status = 'src_missing';
        entry.copy_ok = false;
        report.anomalies.push({ group, cam, reason: 'src_missing', src });
        entry.files.push(fileRec);
        continue;
      }
      const srcSha = sha1(src);
      fileRec.src_sha1 = srcSha;

      if (fs.existsSync(dest)) {
        const destSha = sha1(dest);
        fileRec.dest_sha1 = destSha;
        if (destSha === srcSha) {
          fileRec.status = 'already_present_same';
          report.already_present += 1;
        } else {
          fileRec.status = 'dest_conflict_diff';
          entry.copy_ok = false;
          report.anomalies.push({ group, cam, reason: 'dest_exists_different_sha1', dest });
        }
        entry.files.push(fileRec);
        continue;
      }

      if (APPLY) {
        fs.copyFileSync(src, dest);
        const destSha = sha1(dest);
        fileRec.dest_sha1 = destSha;
        if (destSha !== srcSha) {
          fileRec.status = 'copy_verify_failed';
          entry.copy_ok = false;
          report.anomalies.push({ group, cam, reason: 'copy_verify_failed', dest });
        } else {
          fileRec.status = 'copied';
          report.copied_files += 1;
        }
      } else {
        fileRec.status = 'would_copy';
      }
      entry.files.push(fileRec);
    }
    manifest.push(entry);
  }

  // 第二轮：仅对“两路都复制成功/已存在一致”的组删除源（--apply 时）。
  for (const entry of manifest) {
    entry.deleted = false;
    if (!entry.copy_ok) continue;
    if (!APPLY) continue;
    for (const cam of ['cam0', 'cam1']) {
      const name = `${cam}_${entry.group}.jpg`;
      const src = path.join(SRC_DIR, name);
      if (fs.existsSync(src)) {
        fs.unlinkSync(src);
        report.deleted_files += 1;
      }
    }
    entry.deleted = true;
  }

  fs.writeFileSync(path.join(reportDir, 'manifest.jsonl'),
    manifest.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(reportDir, 'report.json'),
    JSON.stringify(report, null, 2), 'utf8');

  const okGroups = manifest.filter((m) => m.copy_ok).length;
  console.log(`模式: ${report.mode}`);
  console.log(`组数: ${report.total_groups}，可处理(两路就绪): ${okGroups}，异常组: ${report.total_groups - okGroups}`);
  console.log(`复制文件: ${report.copied_files}，已存在一致: ${report.already_present}，删除源文件: ${report.deleted_files}`);
  if (report.anomalies.length) console.log(`异常: ${report.anomalies.length} 条，详见 report.json`);
  console.log(`报告目录: ${reportDir}`);
}

main();
