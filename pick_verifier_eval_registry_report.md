# Pick Verifier 可追溯模型评测台账方案

> 目的：把“测试集、历史模型结果、人工标注、具体图片、粗颗粒度指标”串起来，支持回归测试、对比测试和历史追溯。

---

## 1. 先说结论

你现在要解决的已经不只是“怎么做一个测试集”，而是需要一套 **可追溯的模型评测台账**。

它需要回答这些问题：

- 某个历史模型版本，在某个 BM 版本上，具体测了哪些样本？
- 每个样本当时的人类标注是什么？
- 模型当时预测了什么？原始输出是什么？
- 准确率、召回率、漏判、误判这些数字是由哪些样本算出来的？
- 点开某个错误桶，能不能看到具体图片？
- 同一张样本，base、opt10、opt11 分别预测成什么？
- 新模型相比旧模型，是哪些样本变好了，哪些样本退化了？

所以核心不是只保存一个 `accuracy=86%`，而是要保存：

```text
BM 版本 + 样本清单 + 人工标注 + 模型运行记录 + 每张样本预测结果 + 指标计算明细
```

---

## 2. 总体结构

建议分成 4 层：

```text
1. 样本层：图片 + 人工标注
2. BM 层：某个 BM 版本包含哪些样本
3. 模型运行层：某个模型在某个 BM 上跑了一次
4. 预测结果层：这次运行中每个样本的模型输出和对错
```

最重要的原则：

```text
模型结果不要覆盖写回样本表。
每跑一次模型，就新增一次 run 记录和一份 predictions 明细。
```

这样历史结果不会丢，也不会被新模型覆盖。

---

## 3. 样本层：记录图片和人工标注

样本层负责回答：

```text
这张图是什么？
图片在哪里？
人工标准答案是什么？
它有什么标签？
```

一行对应一组样本：

```text
cam0 + cam1 = 一个样本
```

其中：

- `cam1` 是评估图，参与人工标注、VLM 和统计。
- `cam0` 是参考图，用于辅助判断，不参与统计。

建议字段：

```text
sample_id / group_id
capture_group_id
cam0_path
cam1_path
cam0_sha1
cam1_sha1
source_batch
object_category
object_name
label
human_result
sample_validity
geometry_tags
transparency
reflectiveness
deformability
material_tags
background_complexity
image_quality_tags
gripper_state
gripper_object_relation
gripper_table_relation
object_table_relation
grasp_depth
grasp_direction
bm_review_status
review_note
annotation_version
created_at
updated_at
```

和你现在表里的字段基本能对应上：

```text
group_id
cam0_path
cam1_path
source_batch
object_category
object_name
label
human_result
sample_validity
geometry_tags
transparency
reflectiveness
deformability
material_tags
background_complexity
image_quality_tags
gripper_state
gripper_object_relation
gripper_table_relation
object_table_relation
grasp_depth
grasp_direction
bm_review_status
review_note
```

### 关键点

样本表应该主要保存 **人工标注和样本属性**，不要把所有历史模型预测都堆在这张表里。

短期可以保留 `base_pred`、`trained_pred` 这类字段做临时分析，但长期建议迁移到单独的模型预测结果表。

---

## 4. BM 层：记录某个测试集版本包含哪些样本

BM 不应该只是一个名字，而应该是一份明确的样本清单。

例如：

```text
BM_v1.0 包含 sample_001、sample_002、sample_003 ...
```

BM 层负责回答：

```text
BM v1.0 到底有哪些样本？
这些样本当时使用的是哪个人工标注版本？
这些图片当时在哪里？
这些图片有没有被冻结保存？
```

建议字段：

```text
bm_id
bm_version
bm_name
sample_id
annotation_version
cam0_snapshot_path
cam1_snapshot_path
cam0_sha1
cam1_sha1
included_at
include_reason
```

### 建议做图片快照

正式 BM 冻结时，建议不仅记录原始图片路径，还复制一份图片到 BM 快照目录。

原因：

```text
以后原始图片目录可能改名、移动、清理。
如果 BM 只保存原始路径，历史评测可能打不开图片。
```

建议目录结构：

```text
eval_registry/
  benchmarks/
    BM_v1.0/
      manifest.jsonl
      images/
        cam0/
        cam1/
```

注意：这里是复制图片，不是移动原图。

---

## 5. 模型运行层：记录某个模型在某个 BM 上跑了一次

模型运行层负责回答：

```text
哪个模型？
什么时间跑的？
跑的是哪个 BM？
用的哪个 prompt？
用的哪个代码版本？
是否跑完？
```

一次模型评测就是一个 `run`。

建议字段：

```text
run_id
model_name
model_version
bm_id
bm_version
prompt_version
code_version
vlm_endpoint
run_status
started_at
finished_at
operator
note
```

示例：

```json
{
  "run_id": "run_20260620_opt10_BM_v1.0",
  "model_name": "qwen3vl",
  "model_version": "opt10_merged",
  "bm_id": "BM_v1.0",
  "prompt_version": "gripper_binary_v2",
  "run_status": "completed",
  "started_at": "2026-06-20T10:00:00+08:00",
  "finished_at": "2026-06-20T10:30:00+08:00"
}
```

---

## 6. 预测结果层：记录每张样本的模型输出

这是最关键的一层。

一行代表：

```text
某次 run 对某个 sample 的预测结果
```

它负责回答：

```text
这张图，某个历史模型当时预测成什么？
对还是错？
原始输出是什么？
失败原因是什么？
```

建议字段：

```text
run_id
sample_id
bm_id
human_label
predicted_label
correct
failure_direction
raw_model_output
normalized_output
status
error_message
latency_ms
created_at
```

示例：

```json
{
  "run_id": "run_20260620_opt10_BM_v1.0",
  "sample_id": "capture_group_20260608025526_ck0xyg",
  "human_label": "G",
  "predicted_label": "N",
  "correct": false,
  "failure_direction": "G_to_N",
  "raw_model_output": "N",
  "status": "ok",
  "latency_ms": 1420
}
```

### 错误方向建议

```text
G_to_N：真实是 G，模型预测 N，也就是漏判抓住。
N_to_G：真实是 N，模型预测 G，也就是误判抓住。
none：预测正确。
unknown：无法判断或模型失败。
```

---

## 7. 粗颗粒度指标如何追溯

你说的“粗颗粒度准召率也都能追溯”，本质上是：

```text
每个指标都必须能回到参与计算的 sample_id 列表。
```

不要只保存：

```text
accuracy = 86%
```

最好保存：

```text
accuracy = 258 / 300
分子样本：预测正确的 258 个 sample_id
分母样本：本次 run 的 300 个 sample_id
```

或者至少通过 `run_id + predictions.jsonl` 能重新计算出来。

### 常用指标

指标口径要和当前项目页面保持一致，按照“夹住 / 没夹住”分别计算精准率和召回率。

先定义混淆矩阵：

```text
TP：真实夹住，预测夹住
FN：真实夹住，预测没夹住，也就是漏判
FP：真实没夹住，预测夹住，也就是误判
TN：真实没夹住，预测没夹住
```

则现有项目应保存和展示这 5 个核心指标：

```text
总准确率 = (TP + TN) / 全部已计分样本
夹住精准率 = TP / (TP + FP)
夹住召回率 = TP / (TP + FN)
没夹住精准率 = TN / (TN + FN)
没夹住召回率 = TN / (TN + FP)
```

解释：

```text
夹住精准率：模型判为夹住的样本里，有多少真的夹住。
夹住召回率：真实夹住的样本里，有多少被模型识别为夹住。
没夹住精准率：模型判为没夹住的样本里，有多少真的没夹住。
没夹住召回率：真实没夹住的样本里，有多少被模型识别为没夹住。
```

### metrics.json 示例

```json
{
  "run_id": "run_20260620_opt10_BM_v1.0",
  "bm_id": "BM_v1.0",
  "sample_count": 300,
  "accuracy": {
    "value": 0.86,
    "numerator": 258,
    "denominator": 300
  },
  "grasped_precision": {
    "label": "夹住精准率",
    "value": 0.84,
    "numerator": 125,
    "denominator": 149
  },
  "grasped_recall": {
    "label": "夹住召回率",
    "value": 0.83,
    "numerator": 125,
    "denominator": 150
  },
  "not_grasped_precision": {
    "label": "没夹住精准率",
    "value": 0.88,
    "numerator": 133,
    "denominator": 151
  },
  "not_grasped_recall": {
    "label": "没夹住召回率",
    "value": 0.89,
    "numerator": 133,
    "denominator": 150
  },
  "error_buckets": {
    "G_to_N": [
      "sample_001",
      "sample_009"
    ],
    "N_to_G": [
      "sample_021",
      "sample_078"
    ]
  }
}
```

这样即使看到的是粗指标，也可以下钻到样本。

---

## 8. 你需要的查看方式

建议最终做成 4 类视图。

### 8.1 历史模型运行列表

这个页面展示所有历史 run：

```text
运行ID
模型版本
BM版本
样本数
总准确率
夹住精准率
夹住召回率
没夹住精准率
没夹住召回率
失败数
运行时间
```

示例：

| run_id | 模型版本 | BM版本 | 样本数 | 总准确率 | 夹住精准率 | 夹住召回率 | 没夹住精准率 | 没夹住召回率 | 失败数 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| run_001 | base | BM_v1.0 | 300 | 78% | 75% | 72% | 81% | 84% | 66 |
| run_002 | opt10 | BM_v1.0 | 300 | 86% | 84% | 83% | 88% | 89% | 42 |
| run_003 | opt11 | BM_v1.0 | 300 | 84% | 82% | 80% | 86% | 88% | 48 |

点击某个 run，进入这次评测详情。

---

### 8.2 单次评测详情页

展示：

```text
模型版本
BM版本
总体指标
混淆矩阵
按物体类别分组指标
按夹取关系分组指标
错误样本列表
```

示例：

| 分组 | 样本数 | 总准确率 | 夹住精准率 | 夹住召回率 | 没夹住精准率 | 没夹住召回率 | 错误数 |
|---|---:|---:|---:|---:|---:|---:|---:|
| PhoneCover | 60 | 82% | 80% | 78% | 84% | 86% | 11 |
| Container | 60 | 88% | 87% | 86% | 89% | 90% | 7 |
| SlenderItems | 60 | 75% | 72% | 70% | 78% | 80% | 15 |

关键要求：每个数字都能点开，看到对应样本。

比如点：

```text
SlenderItems 错误数 15
```

应该能看到这 15 张错误样本及其图片。

---

### 8.3 样本列表页：能展示图片

每条样本至少展示：

```text
cam0 参考图
cam1 评估图
人工标签
模型预测
是否正确
错误方向
物品类别
夹爪与物体关系
夹爪与桌面关系
夹取深度
备注
```

示例：

```text
sample_002
人工：N
opt10预测：G
错误方向：N_to_G
物体：筷子
夹爪与物体：对准未接触
夹爪与桌面：近桌未接触
```

旁边直接显示 cam0/cam1 图片。

---

### 8.4 样本详情页

点开某个样本后，看到：

```text
样本图片
人工标注
所有历史模型预测结果
这个样本在哪些 BM 中出现过
这个样本是否进入训练集
```

示例：

| 模型版本 | BM版本 | 预测 | 是否正确 | 原始输出 | 时间 |
|---|---|---|---|---|---|
| base | BM_v1.0 | N | 错 | raw... | 2026-06-19 |
| opt10 | BM_v1.0 | G | 对 | raw... | 2026-06-20 |
| opt11 | BM_v1.0 | G | 对 | raw... | 2026-06-21 |

这样可以回答：

```text
这个样本历史上哪些模型预测对？
哪些模型预测错？
是不是新模型真的学会了？
```

---

## 9. 不同模型版本怎么对比

对比两个 run：

```text
base on BM_v1.0
opt10 on BM_v1.0
```

系统可以把样本分成四类：

| 类型 | 含义 | 用途 |
|---|---|---|
| improved | base 错，opt10 对 | 模型提升样本 |
| regressed | base 对，opt10 错 | 模型退化样本 |
| still_wrong | base 错，opt10 也错 | 持续失败样本 |
| still_correct | base 对，opt10 也对 | 稳定正确样本 |

这个对比非常重要。

因为准确率从 78% 到 86% 只能说明整体变好了，但不能说明：

```text
哪些样本变好了？
哪些样本变差了？
新模型是不是只在 PhoneCover 上提升？
是不是牺牲了 SlenderItems？
```

---

## 10. 为什么不建议把所有模型预测都加到样本表里

短期你可以在样本标注总表里加：

```text
base_pred
trained_pred
candidate_type
failure_direction
```

你现在的模板里也有这些字段。

但长期不建议一直这么加，因为：

1. 模型版本越来越多，表会越来越宽。
2. 同一个模型可能用不同 prompt 跑多次。
3. 同一个模型可能分别跑 BM_v1、BM_v2。
4. 很难记录原始输出、错误信息、运行耗时。
5. 很难做 run 和 run 之间的对比。

更推荐：

```text
样本表：保存人工标准答案和样本属性。
模型结果表：保存每次模型运行的历史答题记录。
```

也就是：

```text
样本表 = 标准答案
模型结果表 = 历史答题记录
```

---

## 11. 文件级最小落地方案

如果现在不想上数据库，可以先用文件结构。

建议目录：

```text
eval_registry/
  samples/
    samples.jsonl
    annotations.jsonl

  benchmarks/
    BM_v1.0/
      manifest.jsonl
      metrics_baseline_note.json
      images/
        cam0/
        cam1/

    BM_v2.0/
      manifest.jsonl
      images/
        cam0/
        cam1/

  runs/
    run_20260619_base_BM_v1.0/
      run.json
      predictions.jsonl
      metrics.json

    run_20260620_opt10_BM_v1.0/
      run.json
      predictions.jsonl
      metrics.json

    run_20260621_opt11_BM_v1.0/
      run.json
      predictions.jsonl
      metrics.json
```

### BM manifest 示例

```json
{
  "bm_id": "BM_v1.0",
  "sample_id": "capture_group_20260608025526_ck0xyg",
  "cam0_path": "images/cam0/realtime_cam0_20260608025526_ck0xyg.jpg",
  "cam1_path": "images/cam1/realtime_cam1_20260608025526_ck0xyg.jpg",
  "cam1_sha1": "xxx",
  "human_label": "G",
  "object_category": "PhoneCover",
  "gripper_object_relation": "充分包围",
  "gripper_table_relation": "离桌",
  "grasp_depth": "中",
  "annotation_version": "label_v1"
}
```

### run.json 示例

```json
{
  "run_id": "run_20260620_opt10_BM_v1.0",
  "model_name": "qwen3vl",
  "model_version": "opt10_merged",
  "bm_id": "BM_v1.0",
  "prompt_version": "gripper_binary_v2",
  "run_status": "completed",
  "started_at": "2026-06-20T10:00:00+08:00",
  "finished_at": "2026-06-20T10:30:00+08:00"
}
```

### predictions.jsonl 示例

```json
{
  "run_id": "run_20260620_opt10_BM_v1.0",
  "sample_id": "capture_group_20260608025526_ck0xyg",
  "human_label": "G",
  "predicted_label": "N",
  "correct": false,
  "failure_direction": "G_to_N",
  "raw_model_output": "N",
  "status": "ok",
  "latency_ms": 1420
}
```

---

## 12. 图片资产、下载、导出和导入

除了能在页面里看到图片，还需要把图片作为评测资产管理。也就是说：

```text
样本图片不仅要能展示，还要能下载、导出、导入和复现。
```

### 12.1 为什么图片要支持下载、导出、导入

原因有几个：

- 给同事复核时，需要把某一批错例图片打包发出去。
- 训练新模型时，需要从 failure_pool 或 BM 候选池导出图片和标注。
- 换电脑、换服务器或归档历史实验时，需要完整迁移 BM 图片和结果。
- 历史模型评测结果必须能回到当时的具体图片，而不是只剩路径。
- 某个指标下钻出来的一组样本，应该可以直接批量下载。

所以系统里不仅要有“查看图片”，还要有这些能力：

```text
单张图片下载
单个样本 cam0/cam1 下载
某个错误桶批量下载
某个 run 的全部错例导出
某个 BM 版本完整导出
某个 BM 版本完整导入
```

### 12.2 推荐的导出包格式

建议导出为 zip 包。

一个完整 BM 导出包可以长这样：

```text
BM_v1.0_export.zip
  manifest.jsonl
  annotations.jsonl
  images/
    cam0/
      realtime_cam0_xxx.jpg
    cam1/
      realtime_cam1_xxx.jpg
  README.txt
```

一个模型 run 导出包可以长这样：

```text
run_20260620_opt10_BM_v1.0_export.zip
  run.json
  predictions.jsonl
  metrics.json
  manifest.jsonl
  images/
    cam0/
    cam1/
  error_buckets/
    G_to_N.jsonl
    N_to_G.jsonl
  README.txt
```

如果只导出某一类错例，例如 `N_to_G`，可以是：

```text
run_20260620_opt10_BM_v1.0_N_to_G.zip
  samples.jsonl
  images/
    cam0/
    cam1/
  README.txt
```

### 12.3 导出包里必须包含什么

只导出图片是不够的，必须一起带上标注和元数据。

最少需要：

```text
sample_id
group_id
cam0_path
cam1_path
cam0_sha1
cam1_sha1
human_label
object_category
object_name
关键人工标签
模型版本
模型预测
是否正确
错误方向
run_id
bm_version
```

这样别人拿到 zip 后，才能知道：

```text
这张图属于哪个样本？
人工真值是什么？
模型当时预测了什么？
为什么被导出来？
属于哪个 BM 或哪个 run？
```

### 12.4 导入时要做什么校验

导入不能只是解压图片，还要校验：

```text
manifest 是否存在
图片文件是否齐全
cam0/cam1 是否能按 sample_id 成对
sha1 是否匹配
sample_id 是否重复
BM 版本是否已经存在
run_id 是否已经存在
人工标签字段是否完整
```

如果发现问题，要生成导入报告：

```text
import_report.json
```

里面记录：

```text
导入样本数
成功样本数
失败样本数
缺失图片列表
sha1 不匹配列表
重复 sample_id 列表
跳过原因
```

### 12.5 页面上应该提供的下载入口

建议页面上至少有这些按钮：

| 页面位置 | 下载/导出能力 |
|---|---|
| 样本详情页 | 下载 cam0、下载 cam1、下载当前样本包 |
| 样本列表页 | 批量下载当前筛选结果 |
| 单次 run 详情页 | 导出本次 run 全量结果、导出错例图片、导出 predictions.jsonl |
| 错误桶页面 | 导出 G_to_N、导出 N_to_G、导出当前筛选图片 |
| BM 详情页 | 导出完整 BM 包、下载 manifest.jsonl |
| 历史 run 列表页 | 下载某次 run 的 metrics.json 和结果包 |

### 12.6 与现有平台的关系

你现在平台已经有图片、人工标注、VLM 结果和导入导出的一些基础能力。后续可以在此基础上扩展：

```text
先做 BM/run 文件级导出包
再做页面上的下载按钮
最后做导入校验和导入报告
```

重点是：

```text
导出必须带图片 + 标注 + 模型结果 + manifest。
导入必须校验图片完整性和 sample_id 对应关系。
```

---

## 13. 长期方案：SQLite 或轻量数据库

如果后续 BM 版本多、模型版本多、样本多，建议上 SQLite。

建议表：

```text
samples
annotations
bm_snapshots
bm_snapshot_samples
model_runs
model_predictions
metric_reports
```

关键关系：

```text
samples 1 --- N model_predictions
bm_snapshots 1 --- N bm_snapshot_samples
model_runs 1 --- N model_predictions
```

可以支持这些查询：

```text
查看 opt10 在 BM_v1.0 上所有错例
查看 sample_001 历史上所有模型预测
查看 PhoneCover 类别下 opt10 和 opt11 谁更好
查看所有 N_to_G 的误判图片
查看某次 accuracy 的分子分母样本
```

---

## 14. 结合当前 pick-verify 项目的建议

不建议一上来大改平台。

建议分三步：

### 第一步：先做文件级 registry

先保存：

```text
BM manifest
run.json
predictions.jsonl
metrics.json
```

优点：

```text
风险低
容易回滚
不影响现有标注页面
能先把历史结果记录起来
```

### 第二步：做评测历史查看页

新增一个页面，例如：

```text
/bm_runs
```

功能：

```text
查看所有历史 run
查看某个 run 的指标
查看错误样本列表
显示 cam0/cam1 图片
```

### 第三步：做模型对比页

例如：

```text
/bm_compare?base=run_base&target=run_opt10
```

展示：

```text
improved
regressed
still_wrong
still_correct
```

每个样本都能点开看图片和人工标注。

---

## 15. 几条重要规则

### 规则 1：BM 样本冻结

BM v1.0 冻结后：

```text
样本 ID 不变
图片不变
人工标签不变
```

如果修正标签，建议生成：

```text
BM_v1.1
```

---

### 规则 2：模型结果只追加，不覆盖

不要在样本表里反复覆盖：

```text
model_result
```

而是每次新增：

```text
run_id + sample_id + predicted_label
```

这样历史模型结果才不会丢。

---

### 规则 3：指标从样本结果计算出来

不要手填准确率。

准确率、召回率、混淆矩阵都应该从：

```text
predictions.jsonl
```

自动计算。

---

### 规则 4：每个指标都能点回样本

比如：

```text
PhoneCover 的没夹住召回率 = 76%
```

点开后应该看到：

```text
所有 PhoneCover 且 human_label=N 的样本
其中哪些预测对
哪些预测错
对应 cam0/cam1 图片
```

---

### 规则 5：训练集和 BM 要隔离

BM 不建议直接进入训练集。

如果某个 BM 样本后来被用于训练，要记录：

```text
training_leak = true
```

或者重新冻结一个不含训练泄漏样本的新 BM 版本。

---

## 16. 可以对同事这样描述

可以这样说：

> 我们需要的不只是一个测试集，而是一套可追溯的模型评测台账。每个 BM 版本固定一批样本和人工标签；每次模型评测都生成一个 run；run 里保存每个样本的预测结果、原始输出和对错。准确率、召回率这些指标不是孤立数字，而是可以下钻到具体样本和图片；这些图片还要能按单样本、筛选结果、错误桶、BM 版本或 run 结果进行下载、导出和导入。这样我们就能对比不同模型版本：哪些样本变好了，哪些样本退化了，哪些问题持续存在，并且历史数据可以迁移和复核。

---

## 17. 最终建议

最适合当前项目的最小版本：

```text
样本标注表
+
BM 快照 manifest
+
模型 run 记录
+
预测结果明细
+
本地查看页
```

最少需要三个查看页面：

```text
1. 历史模型运行列表
2. 单次运行详情和错误样本图片
3. 两个模型版本对比
```

这样就能满足：

```text
查看历史内容
查看不同模型版本
查看对应数据内容
查看具体图片
粗颗粒度准召率可追溯
模型提升/退化可追溯
```
