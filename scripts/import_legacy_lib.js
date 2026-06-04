/**
 * 旧版平台数据导入工具库
 *
 * 作用：
 * 1. 找到旧版 platform 目录。
 * 2. 读取旧平台和当前平台的 gripper_eval_data.json。
 * 3. 合并 records，尽量避免重复导入。
 * 4. 复制被接受导入的本地图片。
 * 5. 在真正写入前备份当前平台的数据文件。
 *
 * 注意：
 * 这个文件只导出 importLegacyPlatform 函数。
 * 命令行入口一般会在 import_legacy_platform.js 里调用它。
 */

// Node.js 文件系统模块，用于判断文件是否存在、读写 JSON、复制图片。
const fs = require('fs');

// Node.js 路径模块，用于拼接和规范化路径。
const path = require('path');

// Node.js 加密模块，这里用 sha1 计算文件内容哈希，主要用于判断图片是否重复。
const crypto = require('crypto');

/**
 * 根据用户传入的路径，定位真正的 platform 目录。
 *
 * 支持两种输入：
 * 1. 直接传入 platform 目录，目录下有 gripper_eval_data.json。
 * 2. 传入 gripper-eval 根目录，里面有 platform/gripper_eval_data.json。
 *
 * 找不到时会抛出错误。
 */
function resolvePlatformDir(input) {
  const resolved = path.resolve(input);

  // 情况一：传入的就是 platform 目录。
  if (fs.existsSync(path.join(resolved, 'gripper_eval_data.json'))) {
    return resolved;
  }

  // 情况二：传入的是上一级目录，真正的数据在 platform 子目录里。
  const nested = path.join(resolved, 'platform');
  if (fs.existsSync(path.join(nested, 'gripper_eval_data.json'))) {
    return nested;
  }

  throw new Error(`Cannot find gripper_eval_data.json under: ${resolved}`);
}

/**
 * 读取 JSON 文件。
 *
 * 如果文件不存在，返回 fallback。
 * 如果文件存在但内容不是合法 JSON，这里会直接抛错。
 */
function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 确保目录存在。
 *
 * recursive 为 true 表示上级目录不存在时也会一起创建。
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 计算文件内容的 sha1 哈希。
 *
 * 这里不是为了安全加密，而是为了快速判断两张图片内容是否相同。
 */
function fileHash(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 从 record 中取出图片文件名。
 *
 * 优先级：
 * 1. stored_filename，导入后实际保存的文件名。
 * 2. original_filename，原始文件名。
 * 3. source_id，来源记录里的文件标识。
 */
function getRecordFilename(record) {
  const source = record && record.local_source;
  return source && (source.stored_filename || source.original_filename || source.source_id);
}

/**
 * 为目标平台已有图片建立索引。
 *
 * byName 用来按文件名查重。
 * byHash 用来按文件内容查重。
 */
function buildTargetImageIndex(targetImagesDir) {
  const byName = new Set();
  const byHash = new Map();

  // 目标图片目录不存在时，返回空索引。
  if (!fs.existsSync(targetImagesDir)) return { byName, byHash };

  for (const entry of fs.readdirSync(targetImagesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(targetImagesDir, entry.name);

    // 记录已有文件名。
    byName.add(entry.name);

    // 记录已有图片的内容哈希。
    byHash.set(fileHash(filePath), entry.name);
  }
  return { byName, byHash };
}

/**
 * 为源平台图片建立文件名到哈希的索引。
 *
 * 后续判断某条 sourceRecord 是否重复时，需要用文件名找到它的图片哈希。
 */
function buildSourceHashIndex(sourceImagesDir) {
  const byName = new Map();

  // 源图片目录不存在时，返回空索引。
  if (!fs.existsSync(sourceImagesDir)) return byName;

  for (const entry of fs.readdirSync(sourceImagesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    byName.set(entry.name, fileHash(path.join(sourceImagesDir, entry.name)));
  }
  return byName;
}

/**
 * 把任意时间字段转成可比较的毫秒时间戳。
 *
 * 无效时间会变成 0，避免比较时报 NaN。
 */
function timestampValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * 取一条记录里最晚的更新时间。
 *
 * 会综合记录更新时间、删除时间、人工标注更新时间、VLM 更新时间和本地来源创建时间。
 * 这样可以尽量保留较新的版本。
 */
function latestRecordTime(record) {
  if (!record) return 0;
  return Math.max(
    timestampValue(record.updated_at),
    timestampValue(record.local_updated_at),
    timestampValue(record.deleted_at),
    timestampValue(record.annotation && record.annotation.updated_at),
    timestampValue(record.vlm && record.vlm.updated_at),
    timestampValue(record.local_source && record.local_source.created_at),
  );
}

/**
 * 为目标平台已有记录建立查重索引。
 *
 * byFilename 用文件名判断重复。
 * byImageHash 用图片内容判断重复。
 * byTimestampCamera 用拍摄时间加相机 ID 判断重复。
 */
function buildTargetRecordIndex(targetData, targetImagesDir) {
  const byFilename = new Set();
  const byImageHash = new Map();
  const byTimestampCamera = new Set();

  for (const record of Object.values(targetData.records || {})) {
    const filename = getRecordFilename(record);
    if (filename) {
      byFilename.add(filename);

      // 如果目标图片文件存在，就把图片内容哈希也加入索引。
      const imagePath = path.join(targetImagesDir, path.basename(filename));
      if (fs.existsSync(imagePath)) byImageHash.set(fileHash(imagePath), record);
    }

    // 对实时抓图一类记录，可以用 created_at 和 camera_id 判断是否已经导入过。
    const metadata = (record.local_source && record.local_source.source_metadata) || {};
    const createdAt = record.local_source && record.local_source.created_at;
    const cameraId = metadata.camera_id;
    if (createdAt && cameraId !== undefined && cameraId !== null) {
      byTimestampCamera.add(`${createdAt}|${cameraId}`);
    }
  }
  return { byFilename, byImageHash, byTimestampCamera };
}

/**
 * 判断源记录是否和目标平台已有记录重复。
 *
 * 返回值：
 * filename 表示文件名重复。
 * hash 表示图片内容重复。
 * timestampCamera 表示拍摄时间加相机 ID 重复。
 * 空字符串表示没有发现重复。
 */
function getDuplicateReason(sourceRecord, recordIndex, sourceHashByName) {
  const filename = getRecordFilename(sourceRecord);
  const sourceHash = filename ? sourceHashByName.get(filename) : '';
  const metadata = (sourceRecord.local_source && sourceRecord.local_source.source_metadata) || {};
  const createdAt = sourceRecord.local_source && sourceRecord.local_source.created_at;
  const duplicateKey = createdAt && metadata.camera_id !== undefined && metadata.camera_id !== null
    ? `${createdAt}|${metadata.camera_id}`
    : '';

  if (filename && recordIndex.byFilename.has(filename)) return 'filename';
  if (sourceHash && recordIndex.byImageHash.has(sourceHash)) return 'hash';
  if (duplicateKey && recordIndex.byTimestampCamera.has(duplicateKey)) return 'timestampCamera';
  return '';
}

/**
 * 把需要复制的图片文件名加入集合。
 *
 * 已删除记录不会加入，因为不需要复制图片。
 */
function addAcceptedFilename(acceptedFilenames, record) {
  if (record && !record.deleted) {
    const filename = getRecordFilename(record);
    if (filename) acceptedFilenames.add(path.basename(filename));
  }
}

/**
 * 合并源平台记录到目标平台记录。
 *
 * 规则：
 * 1. 目标里没有同 ID 记录时，先做重复检查，没重复就新增。
 * 2. 目标记录已经被删除，而源记录没删除时，不恢复，直接跳过。
 * 3. 同 ID 都存在时，比较最新时间，保留较新的记录。
 * 4. 同时收集最终需要复制的图片文件名。
 */
function mergeRecords(sourceData, targetData, recordIndex, sourceHashByName) {
  targetData.records = targetData.records || {};
  const sourceRecords = sourceData.records || {};
  const acceptedFilenames = new Set();

  // 统计导入过程中的各种结果，供调用方展示。
  const stats = {
    added: 0,
    updated: 0,
    kept: 0,
    skippedDeleted: 0,
    skippedDuplicate: 0,
    duplicateReasons: {
      filename: 0,
      hash: 0,
      timestampCamera: 0,
    },
  };

  for (const [id, sourceRecord] of Object.entries(sourceRecords)) {
    const targetRecord = targetData.records[id];

    // 目标数据中没有同 ID 记录时，先检查是否是另一种形式的重复记录。
    if (!targetRecord) {
      const duplicateReason = getDuplicateReason(sourceRecord, recordIndex, sourceHashByName);
      if (duplicateReason) {
        stats.skippedDuplicate += 1;
        stats.duplicateReasons[duplicateReason] += 1;
        continue;
      }

      targetData.records[id] = sourceRecord;
      addAcceptedFilename(acceptedFilenames, sourceRecord);
      stats.added += 1;
      continue;
    }

    // 如果目标记录已经被用户删除，源记录没有删除，就尊重目标平台的删除状态。
    if (targetRecord.deleted && !sourceRecord.deleted) {
      stats.skippedDeleted += 1;
      continue;
    }

    // 同 ID 记录都存在时，保留更新时间更晚的那条。
    if (latestRecordTime(sourceRecord) >= latestRecordTime(targetRecord)) {
      targetData.records[id] = sourceRecord;
      addAcceptedFilename(acceptedFilenames, sourceRecord);
      stats.updated += 1;
    } else {
      addAcceptedFilename(acceptedFilenames, targetRecord);
      stats.kept += 1;
    }
  }

  return { stats, acceptedFilenames };
}

/**
 * 复制合并后需要保留的图片。
 *
 * 会继续做两层保护：
 * 1. 目标目录已有同名文件时不复制。
 * 2. 目标目录已有同内容图片时不复制。
 *
 * 注意：当前实现里，只要 acceptedFilenames 非空，就会调用 ensureDir。
 * 所以 dryRun 为 true 时，也可能创建目标图片目录。
 */
function copyAcceptedImages(sourceImagesDir, targetImagesDir, imageIndex, acceptedFilenames, dryRun) {
  const stats = { copied: 0, skippedByName: 0, skippedByHash: 0, missingSource: 0 };
  if (!acceptedFilenames.size) return stats;

  // 为后续复制准备目标图片目录。
  ensureDir(targetImagesDir);

  for (const filename of acceptedFilenames) {
    const sourceFile = path.join(sourceImagesDir, filename);

    // 记录里有图片名，但源图片文件不存在。
    if (!fs.existsSync(sourceFile)) {
      stats.missingSource += 1;
      continue;
    }

    // 同名图片已经存在，跳过复制。
    if (imageIndex.byName.has(filename)) {
      stats.skippedByName += 1;
      continue;
    }

    // 同内容图片已经存在，跳过复制。
    const hash = fileHash(sourceFile);
    if (imageIndex.byHash.has(hash)) {
      stats.skippedByHash += 1;
      continue;
    }

    // dryRun 只统计，不真正复制文件。
    if (!dryRun) fs.copyFileSync(sourceFile, path.join(targetImagesDir, filename));

    // 即使 dryRun，也更新内存索引，避免同一次运行里重复统计。
    imageIndex.byName.add(filename);
    imageIndex.byHash.set(hash, filename);
    stats.copied += 1;
  }
  return stats;
}

/**
 * 备份目标平台的 gripper_eval_data.json。
 *
 * 备份文件名会带上时间戳，例如：
 * gripper_eval_data.import-backup-20260603125000.json
 */
function backupFile(filePath) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = filePath.replace(/\.json$/i, `.import-backup-${stamp}.json`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * 导入旧版 platform 数据的主函数。
 *
 * 参数：
 * sourceArg 是旧版 platform 目录，或旧版 gripper-eval 根目录。
 * options.dryRun 为 true 时，只统计结果，不写入 JSON，不复制图片。
 * options.targetPlatformDir 可以指定目标 platform 目录。
 *
 * 返回：
 * 导入来源、目标目录、备份路径、图片统计、记录统计。
 */
function importLegacyPlatform(sourceArg, options = {}) {
  const dryRun = Boolean(options.dryRun);

  // 定位源 platform 目录。
  const sourcePlatformDir = resolvePlatformDir(sourceArg);

  // 默认目标目录是当前脚本上一级的 platform。
  const targetPlatformDir = path.resolve(options.targetPlatformDir || path.join(__dirname, '..', 'platform'));

  // 数据文件和图片目录路径。
  const sourceDataPath = path.join(sourcePlatformDir, 'gripper_eval_data.json');
  const targetDataPath = path.join(targetPlatformDir, 'gripper_eval_data.json');
  const sourceImagesDir = path.join(sourcePlatformDir, 'local_images');
  const targetImagesDir = path.join(targetPlatformDir, 'local_images');

  // 读取源数据和目标数据。如果目标数据不存在，就从空数据开始。
  const sourceData = readJson(sourceDataPath, { version: 1, records: {} });
  const targetData = readJson(targetDataPath, { version: 1, records: {} });

  // 建立查重用的索引。
  const imageIndex = buildTargetImageIndex(targetImagesDir);
  const sourceHashByName = buildSourceHashIndex(sourceImagesDir);
  const recordIndex = buildTargetRecordIndex(targetData, targetImagesDir);

  // 先合并记录，再根据合并结果复制图片。
  const { stats: recordStats, acceptedFilenames } = mergeRecords(
    sourceData,
    targetData,
    recordIndex,
    sourceHashByName,
  );
  const imageStats = copyAcceptedImages(sourceImagesDir, targetImagesDir, imageIndex, acceptedFilenames, dryRun);

  let backupPath = '';

  // dryRun 为 false 时，才真正备份并写入目标 JSON。
  if (!dryRun) {
    ensureDir(targetPlatformDir);
    if (fs.existsSync(targetDataPath)) backupPath = backupFile(targetDataPath);
    fs.writeFileSync(targetDataPath, JSON.stringify(targetData, null, 2), 'utf8');
  }

  return {
    dryRun,
    sourcePlatformDir,
    targetPlatformDir,
    backupPath,
    images: imageStats,
    records: recordStats,
  };
}

// 导出主函数，供命令行脚本或后端接口调用。
module.exports = {
  importLegacyPlatform,
};
