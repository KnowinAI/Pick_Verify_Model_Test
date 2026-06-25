# AGENTS.md

本文件用于指导 Agent 在 `D:\dev\Projects\pick-verify` 项目中工作。

## 核心原则

默认保护已有功能和已有数据。这个项目里包含真实评估记录、本地图片集、相机组对元数据、VLM 推理结果和 Windows 启动路径。修改时优先选择范围小、可回退、可验证的方案，避免大范围重构。

## 修改范围

- 每次只处理用户当前明确提出的问题，不顺手扩大范围。
- 除非用户明确要求，不要修改启动脚本、端口、局域网访问地址、VLM 接口、数据结构、图片目录或无关页面。
- 如果需求是 UI 或布局调整，优先限制在 `platform/gripper_eval.html` 或对应前端文件内，保留现有元素 ID、校验规则、保存逻辑、VLM 触发逻辑、导航、筛选、批量操作和导出行为。
- 不要因为做前端小改动就重启或打断正在运行的服务。优先使用非侵入式检查。

## 数据和图片安全

- 未经用户明确同意，不要删除、覆盖、重命名、移动、去重或合并原始图片、历史记录和评估结果。
- 批量处理图片或数据时，优先生成副本目录或输出目录，保留源目录不变。
- 任何可能删除、覆盖、重命名、合并、去重的操作前，都要先说明方案并确认目标路径。
- 合并多人或多台电脑采集的数据时，要保留来源信息，生成 `manifest.jsonl`、`report.json` 或类似报告文件。
- SHA1 等内容哈希只用于判断“文件字节完全相同”。不要把肉眼相似的图片当成重复，除非用户明确要求做视觉相似判断。

## 实时相机和图片组对

- `cam1` 是评估图，参与 VLM 和统计；`cam0` 是参考图。
- records 中稳定的组对字段是 `local_source.source_metadata.capture_group_id`。
- 保持 `participatesInEvaluation()` 的行为，不要因为命名或组对改动让 `cam0` 意外参与 VLM 或统计。
- 历史数据里可能有 `realtime_cam0_...` 和 `realtime_cam1_...` 文件名，解析逻辑要保持向后兼容。
- 新实时保存可能使用 `cam0_<timestamp>_<rand>` 和 `cam1_<timestamp>_<rand>` 格式。
- 源头修复原则：一次实时采集触发时，必须先生成一套共享身份，再分别保存两路图片。共享身份包括 `captureTimestamp`、`pairSuffix` 和 `captureGroupId`。
- `pairSuffix` 对应文件名最后一段后缀，例如 `cam0_20260611113026_di48cb.jpg` 里的 `di48cb`。同一组的 cam0/cam1 必须使用相同时间戳和相同后缀：
  - `cam0_20260611113026_di48cb.jpg`
  - `cam1_20260611113026_di48cb.jpg`
- 不要让 cam0 和 cam1 在各自保存时分别生成时间戳或随机后缀。两路相机实际抓取或落盘有时间差是正常现象，组对身份不能依赖各自的落盘时间。
- 系统内配对优先级应为：先用 `local_source.source_metadata.capture_group_id`，再用文件名中的 `timestamp + pairSuffix` 兜底；只有历史旧格式且同一秒内唯一一对时，才兼容按时间戳配对。
- 对混合来源的数据，不要用全局“最近时间”盲目配对。修复旧数据时，优先按来源目录内部顺序处理，生成副本和异常报告。
- 经验总结：如果当前系统还会产生新的 cam0/cam1 配对问题，优先检查实时采集源头有没有共享组身份，而不是先调大“最近时间匹配”窗口。昨天本地图片修复容易把注意力放在历史文件名和合并后的补救规则上；今天的系统修复要把规则前移到采集写入链路，避免以后继续生成需要修补的数据。
- 规范化副本中，一组图片可以使用相同时间戳和后缀，例如：
  - `realtime_cam0_20260611113026_di48cb.jpg`
  - `realtime_cam1_20260611113026_di48cb.jpg`

## VLM 和评估逻辑

- 主要后端文件是 `platform/gripper_eval_server.js`。
- VLM 相关逻辑包括 `parseVlmOutput`、`runVlm`、`hasLocalVlmResult`、`normalizeStoredVlm`、`mergeRecord`、`isRetryableFailedVlm` 和 `/api/vlm/:id`。
- 当前模型输出协议是二分类：`G -> Grasped`，`N -> Not_Grasped`，同时保留旧别名兼容。
- UI 上显示的 VLM 失败可能来自历史记录状态，不一定是当前网络请求失败。排查时优先查看 `status`、`raw_model_output`、`predicted_status`、`model_result`、`error`、`prompt_version` 等字段。
- 能用临时数据或 fake/local VLM 响应验证时，不要直接污染真实数据文件。

## 前端页面注意事项

- `platform/gripper_eval.html` 是主要标注和审核页面。
- `platform/gripper_overview.html` 通过 `/overview` 和 `/gripper_overview.html` 访问。
- 涉及总览页和标注页的筛选功能时，默认把两个页面当作一组配套体验处理，除非用户明确缩小范围。
- 用户非常重视首屏效率。人工结果、物体标签、归因控件、保存按钮和关键审核控件要尽量保持在容易操作的位置。
- 修改页面时注意保留这些关键 ID 和流程：`humanResult`、`objectTag`、`runVlmButton`、`classificationText`、`attributionBranch`、`attributionReasonToggle`、`note`、`autoNext`、`saveMessage`。

## Windows 工作习惯

- 用户主要在 Windows 上工作。命令要兼容 PowerShell，并正确处理带空格的路径。
- 搜索文件和文本时优先使用 `rg`。
- 手动修改代码时使用 `apply_patch`。
- 不要使用破坏性 git 命令，不要回退用户未要求回退的改动。
- 现有启动器和访问路径很重要。`start_lan_5034.bat` 和端口 `5034` 在项目中很关键，不要随意改动。

## 验证要求

根据修改内容选择针对性验证：

- 修改 Node 后端后，运行 `node --check platform\gripper_eval_server.js`。
- 只改前端 HTML/CSS 时，验证对应页面文件，不要无故重启服务。
- 图片组对、合并或去重工作完成后，报告组数、坏组数、重复文件名、重复图片内容、输出路径。
- VLM 解析问题要把“解析逻辑验证”和“远程网络可用性验证”分开。
- 最终回复中说明改了什么、保护了什么、做了哪些验证。
