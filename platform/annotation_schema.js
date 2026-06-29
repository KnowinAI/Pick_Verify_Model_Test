/**
 * 标注字段单一数据源（Single Source of Truth）。
 *
 * 以后新增 / 修改标签，只改这一个文件即可同时生效到：
 *   1) 后端存储白名单 ANNOTATION_FIELDS / 多选字段集 MULTI_FILTER_FIELDS（sample_pool.js）
 *   2) 标注页表单 /label（gripper_label.html）
 *   3) BM 页「快照内筛选」和「大水池挑选筛选」/bm（gripper_bm.html）
 *
 * 本文件同时被 Node（require）和浏览器（<script src="/annotation_schema.js">）加载：
 *   - Node 端通过 module.exports 取 ANNOTATION_SCHEMA。
 *   - 浏览器端因为是普通脚本，顶层 const ANNOTATION_SCHEMA 会成为后续内联脚本可见的全局绑定。
 *
 * 字段属性说明：
 *   key        存储字段名（英文，写入 annotations.jsonl 的键）。新增字段务必唯一、不要改已有 key。
 *   label      界面显示名。
 *   shortLabel 可选。BM 挑选筛选栏空间小，用更短的名；不填则用 label。
 *   group      标注表单分组标题（仅表单字段需要；system 字段可不填）。
 *   type       'select'（单选下拉）| 'multi'（多选标签）| 'text'（自由文本）。
 *   options    select / multi 的可选值数组。
 *   dict       true=物体级属性，可由物品字典按类别带默认值。
 *   required   true=必填（标注表单显示红星并在保存时校验）。
 *   filter     可选。强制让该字段出现在「BM 快照内筛选」（默认 select/multi 才出现；text 默认不出现）。
 *   system     true=系统/历史字段，仅保留存储白名单，不在表单和任何筛选里显示。
 *
 * 想加一个新标签，最常见就是复制一行 select 字段，改 key/label/options，并放到合适的 group 里。
 */
const ANNOTATION_SCHEMA = [
  // —— 结论（必填）——
  { key: 'human_result', label: '人工结果', group: '结论（必填）', type: 'select', required: true, options: ['夹住', '未夹住'] },

  // —— 夹取关系（每张都看）——
  { key: 'gripper_state', label: '夹爪状态', group: '夹取关系（每张都看）', type: 'select', options: ['张开', '闭合', '半闭合', '不清楚'] },
  { key: 'gripper_open_size', label: '夹爪张开大小', group: '夹取关系（每张都看）', type: 'select', options: ['张开大', '张开小'] },
  { key: 'gripper_object_relation', label: '夹爪-物体关系', shortLabel: '夹爪-物体', group: '夹取关系（每张都看）', type: 'select', options: ['错位空抓', '对准未接触', '对准接触', '部分包围', '充分包围', '看不清'] },
  { key: 'gripper_table_relation', label: '夹爪-桌面关系', shortLabel: '夹爪-桌面', group: '夹取关系（每张都看）', type: 'select', options: ['离桌', '近桌未接触', '接触桌面', '抵住桌面', '隔物支撑', '看不清'] },
  { key: 'grasp_depth', label: '夹取深度', group: '夹取关系（每张都看）', type: 'select', options: ['浅', '深', '未进入'] },
  { key: 'grasp_direction', label: '夹取角度', group: '夹取关系（每张都看）', type: 'select', options: ['正夹', '侧夹', '斜夹', '不清楚'] },
  { key: 'occlusion_level', label: '遮挡程度', group: '夹取关系（每张都看）', type: 'select', options: ['无遮挡', '部分遮挡', '严重遮挡'] },
  // —— 物体属性（字典默认 · 一般不用改）——
  { key: 'object_name', label: '物品名称', group: '物体属性（字典默认 · 一般不用改）', dict: true, type: 'text', filter: true },
  { key: 'transparency', label: '透明度', group: '物体属性（字典默认 · 一般不用改）', dict: true, type: 'select', options: ['透明', '半透明', '不透明', '不清楚'] },
  { key: 'reflectiveness', label: '反光程度', shortLabel: '反光', group: '物体属性（字典默认 · 一般不用改）', dict: true, type: 'select', options: ['低反光', '高反光', '不清楚'] },
  { key: 'deformability', label: '形变属性', shortLabel: '形变', group: '物体属性（字典默认 · 一般不用改）', dict: true, type: 'select', options: ['刚性', '柔性', '可形变', '不清楚'] },
  { key: 'geometry_tags', label: '几何结构', shortLabel: '几何', group: '物体属性（字典默认 · 一般不用改）', dict: true, type: 'multi', options: ['空心/开口', '细长', '块状', '薄片', '圆柱/圆形', '不规则', '小物体', '大物体'] },
  { key: 'material_tags', label: '材质', group: '物体属性（字典默认 · 一般不用改）', dict: true, type: 'multi', options: ['塑料', '纸质', '布料', '金属', '木质', '橡胶', '毛绒', '玻璃', '其他'] },

  // —— 场景（可选）——
  { key: 'background_complexity', label: '背景复杂度', shortLabel: '背景', group: '场景（可选）', type: 'select', options: ['干净', '复杂', '低对比', '反光背景', '杂乱', '不清楚'] },
  // 物品颜色：多选。前段=物体自身主色（影响可见性，深色/黑色尤其难分割）；
  // 后段=与桌面/夹爪/背景的低对比关系（同色相近会让模型分不清边界）。可同时勾选，如「黑色/深色」+「与桌面颜色相近」。
  { key: 'color_tags', label: '物品颜色', shortLabel: '颜色', group: '场景（可选）', type: 'multi', options: ['黑色/深色', '白色/浅色', '鲜艳彩色', '多色/杂色', '灰色/银色(金属)', '与桌面颜色相近', '与夹爪颜色相近', '与背景颜色相近'] },

  // —— 复核 ——
  { key: 'bm_review_status', label: '复核状态', shortLabel: '复核', group: '复核', type: 'select', options: ['pending', 'approved', 'rejected'] },
  { key: 'review_note', label: '备注', group: '复核', type: 'text' },

  // —— 系统 / 历史字段：仅保留存储白名单，不在表单和筛选里显示 ——
  { key: 'sample_validity', label: '样本有效性', type: 'select', options: ['valid', 'invalid'], system: true },
  { key: 'object_table_relation', label: '物体-桌面关系', type: 'select', options: [], system: true },
  { key: 'image_quality_tags', label: '图像质量标签', type: 'multi', options: [], system: true },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ANNOTATION_SCHEMA };
}
