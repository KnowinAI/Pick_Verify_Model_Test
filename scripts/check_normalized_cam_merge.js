const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const base = path.resolve(__dirname, '..', 'platform', 'normalized-cam');
const dirs = process.argv.slice(2).map((dir) => path.resolve(dir));

if (!dirs.length) {
  console.error('Usage: node scripts/check_normalized_cam_merge.js <dir> [dir...]');
  process.exit(1);
}

const realtimePattern = /^realtime_cam([01])_(\d{14})(?:_([^.]+))?\.(?:jpg|jpeg|png|webp|gif)$/i;

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function sha1(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

const items = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Directory not found: ${dir}`);
  }
  const label = path.relative(base, dir).replaceAll(path.sep, '/');
  for (const name of fs.readdirSync(dir)) {
    if (name === 'manifest.jsonl' || name === 'report.json') continue;
    const match = realtimePattern.exec(name);
    if (!match) continue;
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    items.push({
      dir: label,
      fullPath,
      name,
      cam: match[1],
      key: `${match[2]}_${match[3] || ''}`,
      length: stat.size,
    });
  }
}

const dirKeyGroups = Array.from(groupBy(items, (item) => `${item.dir}\0${item.key}`), ([compound, group]) => {
  const [dir, key] = compound.split('\0');
  const cam0 = group.filter((item) => item.cam === '0').length;
  const cam1 = group.filter((item) => item.cam === '1').length;
  return {
    dir,
    key,
    cam0,
    cam1,
    complete: cam0 === 1 && cam1 === 1,
    files: group.length,
  };
});

const keyGroups = Array.from(groupBy(items, (item) => item.key), ([key, group]) => {
  const dirsSeen = Array.from(new Set(group.map((item) => item.dir))).sort();
  const cam0 = group.filter((item) => item.cam === '0').length;
  const cam1 = group.filter((item) => item.cam === '1').length;
  return {
    key,
    dirs: dirsSeen.join(';'),
    dirCount: dirsSeen.length,
    cam0,
    cam1,
    complete: cam0 > 0 && cam1 > 0,
    physicalPairs: Math.min(cam0, cam1),
    files: group.length,
  };
});

const duplicateFileNames = Array.from(groupBy(items, (item) => item.name), ([name, group]) => ({
  name,
  count: group.length,
  dirs: Array.from(new Set(group.map((item) => item.dir))).sort().join(';'),
})).filter((entry) => entry.count > 1);

const hashRows = items.map((item) => ({
  ...item,
  hash: sha1(item.fullPath),
}));

const duplicateImageContents = Array.from(groupBy(hashRows, (item) => item.hash), ([hash, group]) => ({
  hash,
  count: group.length,
  dirs: Array.from(new Set(group.map((item) => item.dir))).sort().join(';'),
  names: group.slice(0, 8).map((item) => item.name).join(';'),
})).filter((entry) => entry.count > 1);

const pairContentRows = [];
for (const group of dirKeyGroups.filter((entry) => entry.complete)) {
  const pair = hashRows
    .filter((item) => item.dir === group.dir && item.key === group.key)
    .sort((a, b) => a.cam.localeCompare(b.cam));
  pairContentRows.push({
    dir: group.dir,
    key: group.key,
    pairHash: `${pair[0].hash}_${pair[1].hash}`,
  });
}

const duplicatePairContents = Array.from(groupBy(pairContentRows, (item) => item.pairHash), ([, group]) => ({
  count: group.length,
  dirs: Array.from(new Set(group.map((item) => item.dir))).sort().join(';'),
  keys: group.slice(0, 10).map((item) => item.key).join(';'),
})).filter((entry) => entry.count > 1);

const duplicateGroupKeys = keyGroups.filter((group) => group.dirCount > 1);
const perDir = Array.from(groupBy(dirKeyGroups, (group) => group.dir), ([dir, groups]) => ({
  dir,
  groups: groups.length,
  files: items.filter((item) => item.dir === dir).length,
  badGroups: groups.filter((group) => !group.complete).length,
}));

const summary = {
  totalFiles: items.length,
  physicalCompleteGroupsByDir: dirKeyGroups.length,
  badDirGroups: dirKeyGroups.filter((group) => !group.complete).length,
  uniqueGroupsByNormalizedName: keyGroups.length,
  duplicateGroupKeysAcrossDirs: duplicateGroupKeys.length,
  duplicateFileNamesAcrossDirs: duplicateFileNames.length,
  duplicateImageContentHashes: duplicateImageContents.length,
  duplicatePairContents: duplicatePairContents.length,
  perDir,
  duplicateGroupKeysFirst30: duplicateGroupKeys
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 30),
  duplicateFileNamesFirst30: duplicateFileNames
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30),
  duplicatePairContentFirst20: duplicatePairContents.slice(0, 20),
};

console.log(JSON.stringify(summary, null, 2));
