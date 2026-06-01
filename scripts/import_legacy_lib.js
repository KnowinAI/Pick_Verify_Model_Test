const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolvePlatformDir(input) {
  const resolved = path.resolve(input);
  if (fs.existsSync(path.join(resolved, 'gripper_eval_data.json'))) {
    return resolved;
  }
  const nested = path.join(resolved, 'platform');
  if (fs.existsSync(path.join(nested, 'gripper_eval_data.json'))) {
    return nested;
  }
  throw new Error(`Cannot find gripper_eval_data.json under: ${resolved}`);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function fileHash(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function getRecordFilename(record) {
  const source = record && record.local_source;
  return source && (source.stored_filename || source.original_filename || source.source_id);
}

function buildTargetImageIndex(targetImagesDir) {
  const byName = new Set();
  const byHash = new Map();
  if (!fs.existsSync(targetImagesDir)) return { byName, byHash };

  for (const entry of fs.readdirSync(targetImagesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(targetImagesDir, entry.name);
    byName.add(entry.name);
    byHash.set(fileHash(filePath), entry.name);
  }
  return { byName, byHash };
}

function buildSourceHashIndex(sourceImagesDir) {
  const byName = new Map();
  if (!fs.existsSync(sourceImagesDir)) return byName;

  for (const entry of fs.readdirSync(sourceImagesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    byName.set(entry.name, fileHash(path.join(sourceImagesDir, entry.name)));
  }
  return byName;
}

function timestampValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

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

function buildTargetRecordIndex(targetData, targetImagesDir) {
  const byFilename = new Set();
  const byImageHash = new Map();
  const byTimestampCamera = new Set();
  for (const record of Object.values(targetData.records || {})) {
    const filename = getRecordFilename(record);
    if (filename) {
      byFilename.add(filename);
      const imagePath = path.join(targetImagesDir, path.basename(filename));
      if (fs.existsSync(imagePath)) byImageHash.set(fileHash(imagePath), record);
    }
    const metadata = (record.local_source && record.local_source.source_metadata) || {};
    const createdAt = record.local_source && record.local_source.created_at;
    const cameraId = metadata.camera_id;
    if (createdAt && cameraId !== undefined && cameraId !== null) {
      byTimestampCamera.add(`${createdAt}|${cameraId}`);
    }
  }
  return { byFilename, byImageHash, byTimestampCamera };
}

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

function addAcceptedFilename(acceptedFilenames, record) {
  if (record && !record.deleted) {
    const filename = getRecordFilename(record);
    if (filename) acceptedFilenames.add(path.basename(filename));
  }
}

function mergeRecords(sourceData, targetData, recordIndex, sourceHashByName) {
  targetData.records = targetData.records || {};
  const sourceRecords = sourceData.records || {};
  const acceptedFilenames = new Set();
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

    if (targetRecord.deleted && !sourceRecord.deleted) {
      stats.skippedDeleted += 1;
      continue;
    }

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

function copyAcceptedImages(sourceImagesDir, targetImagesDir, imageIndex, acceptedFilenames, dryRun) {
  const stats = { copied: 0, skippedByName: 0, skippedByHash: 0, missingSource: 0 };
  if (!acceptedFilenames.size) return stats;
  ensureDir(targetImagesDir);

  for (const filename of acceptedFilenames) {
    const sourceFile = path.join(sourceImagesDir, filename);
    if (!fs.existsSync(sourceFile)) {
      stats.missingSource += 1;
      continue;
    }
    if (imageIndex.byName.has(filename)) {
      stats.skippedByName += 1;
      continue;
    }
    const hash = fileHash(sourceFile);
    if (imageIndex.byHash.has(hash)) {
      stats.skippedByHash += 1;
      continue;
    }
    if (!dryRun) fs.copyFileSync(sourceFile, path.join(targetImagesDir, filename));
    imageIndex.byName.add(filename);
    imageIndex.byHash.set(hash, filename);
    stats.copied += 1;
  }
  return stats;
}

function backupFile(filePath) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = filePath.replace(/\.json$/i, `.import-backup-${stamp}.json`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function importLegacyPlatform(sourceArg, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const sourcePlatformDir = resolvePlatformDir(sourceArg);
  const targetPlatformDir = path.resolve(options.targetPlatformDir || path.join(__dirname, '..', 'platform'));
  const sourceDataPath = path.join(sourcePlatformDir, 'gripper_eval_data.json');
  const targetDataPath = path.join(targetPlatformDir, 'gripper_eval_data.json');
  const sourceImagesDir = path.join(sourcePlatformDir, 'local_images');
  const targetImagesDir = path.join(targetPlatformDir, 'local_images');

  const sourceData = readJson(sourceDataPath, { version: 1, records: {} });
  const targetData = readJson(targetDataPath, { version: 1, records: {} });
  const imageIndex = buildTargetImageIndex(targetImagesDir);
  const sourceHashByName = buildSourceHashIndex(sourceImagesDir);
  const recordIndex = buildTargetRecordIndex(targetData, targetImagesDir);
  const { stats: recordStats, acceptedFilenames } = mergeRecords(
    sourceData,
    targetData,
    recordIndex,
    sourceHashByName,
  );
  const imageStats = copyAcceptedImages(sourceImagesDir, targetImagesDir, imageIndex, acceptedFilenames, dryRun);

  let backupPath = '';
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

module.exports = {
  importLegacyPlatform,
};
