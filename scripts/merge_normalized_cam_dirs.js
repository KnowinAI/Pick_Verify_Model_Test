const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1]) {
  console.error('Usage: node scripts/merge_normalized_cam_dirs.js --out <outputDir> <inputDir> [inputDir...]');
  process.exit(1);
}

const outputDir = path.resolve(args[outIndex + 1]);
const inputDirs = args
  .filter((_, index) => index !== outIndex && index !== outIndex + 1)
  .map((dir) => path.resolve(dir));

if (!inputDirs.length) {
  console.error('At least one input directory is required.');
  process.exit(1);
}

const realtimePattern = /^realtime_cam([01])_(\d{14})(?:_([^.]+))?\.(?:jpg|jpeg|png|webp|gif)$/i;

function sha1(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function relativeLabel(dir) {
  const normalized = dir.replaceAll('\\', '/');
  const marker = '/normalized-cam/';
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : path.basename(dir);
}

if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) {
  throw new Error(`Output directory already exists and is not empty: ${outputDir}`);
}
fs.mkdirSync(outputDir, { recursive: true });

const sourceSummaries = [];
const keptByPairHash = new Map();
const outputNames = new Map();
const manifest = [];
let sourcePairs = 0;
let skippedDuplicatePairs = 0;

for (const inputDir of inputDirs) {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const label = relativeLabel(inputDir);
  const items = [];
  for (const name of fs.readdirSync(inputDir)) {
    const match = realtimePattern.exec(name);
    if (!match) continue;
    items.push({
      source_dir: label,
      source_path: path.join(inputDir, name),
      name,
      cam: match[1],
      key: `${match[2]}_${match[3] || ''}`,
    });
  }

  const keyGroups = Array.from(groupBy(items, (item) => item.key).entries());
  let copiedFromSource = 0;
  let skippedFromSource = 0;
  let badGroups = 0;

  for (const [key, group] of keyGroups) {
    const cam0 = group.filter((item) => item.cam === '0');
    const cam1 = group.filter((item) => item.cam === '1');
    if (cam0.length !== 1 || cam1.length !== 1) {
      badGroups += 1;
      continue;
    }

    sourcePairs += 1;
    const pairHash = `${sha1(cam0[0].source_path)}_${sha1(cam1[0].source_path)}`;
    const outputCam0 = cam0[0].name;
    const outputCam1 = cam1[0].name;
    const outputKey = `${outputCam0}\0${outputCam1}`;

    if (keptByPairHash.has(pairHash)) {
      skippedDuplicatePairs += 1;
      skippedFromSource += 1;
      manifest.push({
        status: 'skipped_duplicate',
        duplicate_of: keptByPairHash.get(pairHash).key,
        key,
        source_dir: label,
        cam0_source: cam0[0].name,
        cam1_source: cam1[0].name,
      });
      continue;
    }

    if (outputNames.has(outputCam0) || outputNames.has(outputCam1)) {
      throw new Error(`Filename collision with different content: ${outputNames.has(outputCam0) ? outputCam0 : outputCam1}`);
    }

    fs.copyFileSync(cam0[0].source_path, path.join(outputDir, outputCam0));
    fs.copyFileSync(cam1[0].source_path, path.join(outputDir, outputCam1));

    outputNames.set(outputCam0, pairHash);
    outputNames.set(outputCam1, pairHash);
    keptByPairHash.set(pairHash, { key, source_dir: label });
    copiedFromSource += 1;

    manifest.push({
      status: 'copied',
      key,
      source_dir: label,
      cam0_output: outputCam0,
      cam1_output: outputCam1,
      cam0_source: cam0[0].name,
      cam1_source: cam1[0].name,
    });
  }

  sourceSummaries.push({
    source_dir: label,
    files: items.length,
    pairs: keyGroups.length,
    copied_pairs: copiedFromSource,
    skipped_duplicate_pairs: skippedFromSource,
    bad_groups: badGroups,
  });
}

const manifestPath = path.join(outputDir, 'manifest.jsonl');
fs.writeFileSync(manifestPath, manifest.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

const report = {
  output_dir: outputDir,
  source_pairs: sourcePairs,
  copied_pairs: keptByPairHash.size,
  copied_files: keptByPairHash.size * 2,
  skipped_duplicate_pairs: skippedDuplicatePairs,
  source_summaries: sourceSummaries,
  manifest: manifestPath,
};

fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
