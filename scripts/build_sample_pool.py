# -*- coding: utf-8 -*-
"""
增量样本池构建工具（只读）。

设计目标：
- 只读扫描图片目录，绝不删除、移动、重命名、覆盖原图。
- 把 cam0/cam1 组成稳定样本，写入长期样本池 pool_manifest.jsonl。
- 每次扫描生成一个导入批次 import_batch，保留来源、配对结果和异常报告。
- 后续新增图片时，作为新的 import_batch 继续追加，不推翻已有结构。

配对优先级（仅在同一来源叶子目录内部配对，避免跨目录乱配）：
1. capture_group_id（若提供 records 元数据且能匹配文件名）
2. 时间戳 + 文件名后缀（pair_suffix）
3. 同一目录同一秒内唯一一对 cam0/cam1（兜底）

sample_id 规则：
- 有后缀：capture_group_<timestamp>_<suffix>
- 无后缀：capture_group_<timestamp>
- 与现有平台 capture_group_id 命名保持一致。

用法示例：
  python scripts/build_sample_pool.py --source testCollection --batch-label testCollection --dry-run
  python scripts/build_sample_pool.py --source testCollection --batch-label testCollection
"""

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

FILENAME_RE = re.compile(r'^(?:realtime_)?cam([01])_(\d{14})(?:_([^.]+))?(\.[^.]+)$', re.IGNORECASE)
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}


def now_iso():
    return datetime.now(timezone.utc).astimezone().replace(microsecond=0).isoformat()


def sha1_file(path, chunk=1 << 20):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def parse_filename(name):
    m = FILENAME_RE.match(name)
    if not m:
        return None
    cam = int(m.group(1))
    timestamp = m.group(2)
    suffix = m.group(3) or ''
    ext = m.group(4)
    return {'cam': cam, 'timestamp': timestamp, 'suffix': suffix, 'ext': ext}


def derive_category(file_path: Path, source_root: Path, category_mode: str):
    if category_mode.startswith('fixed:'):
        return category_mode.split(':', 1)[1]
    try:
        rel = file_path.relative_to(source_root)
    except ValueError:
        return ''
    parts = rel.parts
    if len(parts) >= 2:
        return parts[0]
    return ''


def rel_subdir(dir_path: Path, source_root: Path):
    try:
        rel = dir_path.relative_to(source_root)
    except ValueError:
        return str(dir_path)
    text = str(rel).replace('\\', '/')
    return '' if text == '.' else text


def make_sample_id(timestamp, suffix):
    if suffix:
        return f'capture_group_{timestamp}_{suffix}'
    return f'capture_group_{timestamp}'


def scan_files(source_root: Path):
    """返回 (matched, skipped_non_matching)。matched 按叶子目录分组。"""
    matched = []
    skipped = []
    for path in sorted(source_root.rglob('*')):
        if not path.is_file():
            continue
        if path.suffix.lower() not in IMAGE_EXTS:
            continue
        parsed = parse_filename(path.name)
        if not parsed:
            skipped.append(path)
            continue
        parsed['path'] = path
        parsed['dir'] = path.parent
        matched.append(parsed)
    return matched, skipped


def pair_within_dir(items, leaf_dir, source_root, category_mode):
    """在单个叶子目录内部配对，返回 (pairs, anomalies)。"""
    pairs = []
    anomalies = []

    groups = defaultdict(list)
    for it in items:
        key = f"{it['timestamp']}_{it['suffix']}" if it['suffix'] else f"{it['timestamp']}_"
        groups[key].append(it)

    for key in sorted(groups.keys()):
        members = groups[key]
        cam0 = [m for m in members if m['cam'] == 0]
        cam1 = [m for m in members if m['cam'] == 1]

        if len(cam0) == 1 and len(cam1) == 1 and len(members) == 2:
            c0, c1 = cam0[0], cam1[0]
            pairs.append({
                'cam0': c0,
                'cam1': c1,
                'timestamp': c0['timestamp'],
                'suffix': c0['suffix'],
                'pair_method': 'timestamp_suffix' if c0['suffix'] else 'timestamp_unique',
            })
            continue

        if len(cam0) >= 1 and len(cam1) == 0:
            status = 'missing_cam1'
        elif len(cam1) >= 1 and len(cam0) == 0:
            status = 'missing_cam0'
        else:
            status = 'duplicate_pair'

        anomalies.append({
            'source_subdir': rel_subdir(leaf_dir, source_root),
            'object_category': derive_category(leaf_dir / 'x', source_root, category_mode),
            'pair_key': key,
            'pair_status': status,
            'cam0_count': len(cam0),
            'cam1_count': len(cam1),
            'files': sorted(m['path'].name for m in members),
        })

    return pairs, anomalies


def load_pool(pool_manifest_path: Path):
    sample_ids = {}
    cam1_sha1 = {}
    rows = 0
    if not pool_manifest_path.exists():
        return sample_ids, cam1_sha1, rows
    with open(pool_manifest_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows += 1
            sid = obj.get('sample_id')
            if sid:
                sample_ids[sid] = obj
            s = obj.get('cam1_sha1')
            if s:
                cam1_sha1.setdefault(s, sid)
    return sample_ids, cam1_sha1, rows


def main():
    ap = argparse.ArgumentParser(description='增量样本池构建工具（只读扫描）')
    ap.add_argument('--source', required=True, help='要扫描的图片根目录')
    ap.add_argument('--registry', default='eval_registry', help='样本池注册表目录（默认 eval_registry）')
    ap.add_argument('--batch-label', default='', help='本次导入批次标签，例如 testCollection')
    ap.add_argument('--category-mode', default='toplevel',
                    help='物体类别来源：toplevel=源目录下一级子目录名；fixed:<名称>=固定类别')
    ap.add_argument('--dry-run', action='store_true', help='只生成报告，不写入样本池')
    args = ap.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    source_root = Path(args.source)
    if not source_root.is_absolute():
        source_root = (project_root / source_root).resolve()
    else:
        source_root = source_root.resolve()

    if not source_root.exists():
        print(f'ERROR: source not found: {source_root}', file=sys.stderr)
        return 2

    registry_root = Path(args.registry)
    if not registry_root.is_absolute():
        registry_root = (project_root / registry_root).resolve()

    samples_dir = registry_root / 'samples'
    batches_dir = samples_dir / 'import_batches'
    pool_manifest_path = samples_dir / 'pool_manifest.jsonl'
    pool_report_path = samples_dir / 'pool_report.json'

    date_tag = datetime.now().strftime('%Y%m%d')
    label = args.batch_label.strip() or source_root.name
    safe_label = re.sub(r'[^A-Za-z0-9_.-]+', '-', label).strip('-') or 'batch'
    base_batch_id = f'import_{date_tag}_{safe_label}'
    batch_id = base_batch_id
    if not args.dry_run:
        attempt = 2
        while (batches_dir / batch_id).exists():
            batch_id = f'{base_batch_id}__r{attempt}'
            attempt += 1
    batch_dir = batches_dir / batch_id

    print(f'扫描源目录: {source_root}')
    print(f'样本池目录: {samples_dir}')
    print(f'导入批次:   {batch_id}{"  [dry-run]" if args.dry_run else ""}')

    matched, skipped = scan_files(source_root)

    by_dir = defaultdict(list)
    for it in matched:
        by_dir[it['dir']].append(it)

    all_pairs = []
    all_anomalies = []
    for leaf_dir in sorted(by_dir.keys()):
        pairs, anomalies = pair_within_dir(by_dir[leaf_dir], leaf_dir, source_root, args.category_mode)
        for p in pairs:
            p['dir'] = leaf_dir
        all_pairs.extend(pairs)
        all_anomalies.extend(anomalies)

    existing_ids, existing_cam1_sha1, existing_rows = load_pool(pool_manifest_path)

    new_entries = []
    already_in_pool = []
    content_duplicates = []
    batch_sha1_seen = {}
    per_category_new = Counter()
    per_category_pairs = Counter()

    for p in sorted(all_pairs, key=lambda x: (x['cam0']['timestamp'], x['cam0']['suffix'])):
        c0 = p['cam0']
        c1 = p['cam1']
        category = derive_category(c0['path'], source_root, args.category_mode)
        per_category_pairs[category] += 1
        sample_id = make_sample_id(p['timestamp'], p['suffix'])

        cam0_sha1 = sha1_file(c0['path'])
        cam1_sha1 = sha1_file(c1['path'])

        entry = {
            'sample_id': sample_id,
            'object_category': category,
            'source_batch': batch_id,
            'source_root': str(source_root),
            'source_subdir': rel_subdir(c0['dir'], source_root),
            'capture_timestamp': p['timestamp'],
            'pair_suffix': p['suffix'],
            'pair_method': p['pair_method'],
            'pair_status': 'ok',
            'cam0_path': str(c0['path']),
            'cam1_path': str(c1['path']),
            'cam0_sha1': cam0_sha1,
            'cam1_sha1': cam1_sha1,
            'first_seen_batch': batch_id,
            'created_at': now_iso(),
        }

        if sample_id in existing_ids:
            already_in_pool.append({'sample_id': sample_id, 'reason': 'sample_id_already_in_pool'})
            continue

        dup_of = existing_cam1_sha1.get(cam1_sha1) or batch_sha1_seen.get(cam1_sha1)
        if dup_of:
            entry['pair_status'] = 'duplicate_content'
            entry['duplicate_content_of'] = dup_of
            content_duplicates.append({'sample_id': sample_id, 'duplicate_content_of': dup_of, 'cam1_sha1': cam1_sha1})
            continue

        batch_sha1_seen[cam1_sha1] = sample_id
        new_entries.append(entry)
        per_category_new[category] += 1

    anomaly_status_counts = Counter(a['pair_status'] for a in all_anomalies)

    import_report = {
        'batch_id': batch_id,
        'created_at': now_iso(),
        'dry_run': bool(args.dry_run),
        'source_root': str(source_root),
        'category_mode': args.category_mode,
        'scanned_image_files': len(matched) + len(skipped),
        'matched_filename_files': len(matched),
        'skipped_non_matching_files': len(skipped),
        'leaf_directories': len(by_dir),
        'pairs_found': len(all_pairs),
        'new_samples_added': len(new_entries),
        'already_in_pool': len(already_in_pool),
        'content_duplicates': len(content_duplicates),
        'anomalies_total': len(all_anomalies),
        'anomaly_status_counts': dict(anomaly_status_counts),
        'pairs_per_category': dict(sorted(per_category_pairs.items())),
        'new_samples_per_category': dict(sorted(per_category_new.items())),
        'pool_manifest': str(pool_manifest_path),
    }

    if not args.dry_run:
        batch_dir.mkdir(parents=True, exist_ok=True)
        with open(batch_dir / 'import_manifest.jsonl', 'w', encoding='utf-8') as f:
            for e in new_entries:
                f.write(json.dumps(e, ensure_ascii=False) + '\n')
        with open(batch_dir / 'import_anomalies.json', 'w', encoding='utf-8') as f:
            json.dump(all_anomalies, f, ensure_ascii=False, indent=2)
        with open(batch_dir / 'import_report.json', 'w', encoding='utf-8') as f:
            json.dump(import_report, f, ensure_ascii=False, indent=2)
        if skipped:
            with open(batch_dir / 'skipped_files.json', 'w', encoding='utf-8') as f:
                json.dump([str(p) for p in skipped], f, ensure_ascii=False, indent=2)

        samples_dir.mkdir(parents=True, exist_ok=True)
        with open(pool_manifest_path, 'a', encoding='utf-8') as f:
            for e in new_entries:
                f.write(json.dumps(e, ensure_ascii=False) + '\n')

        pool_ids, pool_cam1_sha1, pool_rows = load_pool(pool_manifest_path)
        pool_category_counts = Counter()
        pool_batch_counts = Counter()
        with open(pool_manifest_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                pool_category_counts[obj.get('object_category', '')] += 1
                pool_batch_counts[obj.get('source_batch', '')] += 1

        pool_report = {
            'updated_at': now_iso(),
            'pool_manifest': str(pool_manifest_path),
            'total_samples': pool_rows,
            'unique_sample_ids': len(pool_ids),
            'samples_per_category': dict(sorted(pool_category_counts.items())),
            'samples_per_batch': dict(sorted(pool_batch_counts.items())),
            'last_batch': import_report,
        }
        with open(pool_report_path, 'w', encoding='utf-8') as f:
            json.dump(pool_report, f, ensure_ascii=False, indent=2)

    print('---- 本次扫描结果 ----')
    print(json.dumps(import_report, ensure_ascii=False, indent=2))
    if args.dry_run:
        print('（dry-run：未写入样本池，未生成批次文件）')
    else:
        print(f'已写入: {batch_dir}')
        print(f'已更新: {pool_manifest_path}')
        print(f'已更新: {pool_report_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
