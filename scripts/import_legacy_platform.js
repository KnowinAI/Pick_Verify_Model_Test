const { importLegacyPlatform } = require('./import_legacy_lib');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceArg = args.find((arg) => arg !== '--dry-run');

if (!sourceArg) {
  console.error('Usage: node scripts/import_legacy_platform.js <legacy platform dir or gripper-eval dir> [--dry-run]');
  process.exit(1);
}

try {
  const result = importLegacyPlatform(sourceArg, { dryRun });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
