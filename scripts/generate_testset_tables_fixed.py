# -*- coding: utf-8 -*-
from pathlib import Path
import zipfile
import html
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
xlsx_out = root / 'pick_verifier_testset_tables_fixed.xlsx'
html_out = root / 'pick_verifier_testset_tables_fixed.html'

object_rows = [
    ['物品名称', '物体大类', '几何结构', '透明度', '反光程度', '形变属性', '材质', '是否建议进入BM', '备注'],
    ['手机（iPhone/Android）', 'Other', '薄片/块状', '不透明', '高反光', '刚性', '金属/玻璃/塑料', '是', '屏幕反光明显，注意背景低对比和误识别'],
    ['手机壳（硬壳）', 'PhoneCover', '薄片/空心开口', '透明/半透明/不透明', '中等反光', '刚性', '塑料', '是', '重点类别；同一物品可覆盖正夹/侧夹/斜夹'],
    ['平板电脑', 'Other', '薄片', '不透明', '高反光', '刚性', '金属/玻璃', '可选', '尺寸较大，注意是否超出夹爪能力'],
    ['电脑鼠标', 'Other', '块状/不规则', '不透明', '中等反光', '刚性', '塑料', '是', '形状容易造成侧夹、斜夹和浅夹'],
    ['U盘', 'Other', '小物体/块状', '不透明', '中等反光', '刚性', '金属/塑料', '是', '小目标，注意遮挡、对焦和夹爪是否挡住主体'],
    ['充电头', 'Other', '块状/小物体', '不透明', '低反光', '刚性', '塑料/金属', '是', '适合补充小块状刚性物体'],
    ['金属夹子', 'Other', '细长/薄片', '不透明', '高反光', '可形变', '金属', '是', '反光+可形变，容易形成模型难例'],
    ['金属支架', 'Other', '细长/不规则', '不透明', '高反光', '刚性', '金属', '可选', '结构复杂时可作为 hard case'],
    ['乐高积木', 'BuildingBlocks', '块状/小物体', '不透明', '低反光', '刚性', '塑料', '是', '积木类主类别，可做基础稳定样本'],
    ['塑料盒', 'Container', '空心开口/块状', '半透明/不透明', '中等反光', '刚性', '塑料', '是', '容器类，注意空心结构导致的边缘夹'],
    ['塑料收纳盒', 'Container', '空心开口/块状', '半透明/不透明', '中等反光', '刚性', '塑料', '是', '容器类，尺寸变化可形成覆盖'],
    ['杯子（陶瓷）', 'Container', '空心开口/圆柱', '不透明', '低反光', '刚性', '陶瓷', '是', '典型容器，注意杯口/杯壁的夹取状态'],
    ['玻璃杯', 'Container', '空心开口/圆柱', '透明', '高反光', '刚性', '玻璃', '是', '透明+反光重点难例'],
    ['笔', 'SlenderItems', '细长/小物体', '不透明', '中等反光', '刚性', '塑料/金属', '是', '细长类主类别，注意对准未接触和浅夹'],
    ['格子桌布', 'Background', '纹理背景', '不透明', '低反光', '柔性', '布料', '否', '建议作为背景条件，不作为被抓物体进入BM'],
    ['印花塑料袋', 'Other/Background', '薄片/不规则', '半透明/不透明', '中等反光', '可形变', '塑料', '可选', '可作为柔性物体，也可作为复杂背景干扰'],
    ['图案手机壳', 'PhoneCover', '薄片/空心开口/纹理', '不透明/半透明', '中等反光', '刚性', '塑料', '是', '图案会干扰模型判断，可作为手机壳难例'],
    ['标有刻度的尺子', 'SlenderItems', '细长/薄片/文字密集', '透明/不透明', '中等反光', '刚性', '塑料/金属', '是', '刻度和文字密集，容易形成视觉干扰'],
    ['条纹衣服', 'Background', '纹理背景/柔性', '不透明', '低反光', '柔性', '布料', '否', '建议作为复杂背景条件'],
    ['标签贴纸（文字密集）', 'Other/Background', '薄片/文字密集', '不透明', '低反光', '可形变', '纸质', '可选', '文字密集干扰，可少量进入难例池'],
]

sample_rows = [
    ['group_id', 'cam0_path', 'cam1_path', 'source_batch', '物品名称', '物体大类', 'G/N标签', '细分抓取状态', '样本有效性', '背景', '夹爪状态', '夹爪与物体', '夹爪与桌面', '物体与桌面', '夹取深度', '夹取角度', '几何结构', '透明度', '反光程度', '形变属性', '材质', 'base模型版本', 'base预测', '当前模型版本', '当前模型预测', '候选类型', '失败方向', '复核状态', '拒绝原因', '备注'],
    ['capture_group_20260608025526_ck0xyg', 'realtime_cam0_20260608025526_ck0xyg.jpg', 'realtime_cam1_20260608025526_ck0xyg.jpg', 'testCollection/PhoneCover', '手机壳（硬壳）', 'PhoneCover', 'G', '已夹住', 'valid', '干净', '闭合', '充分包围', '离桌', '离桌', '中', '正夹', '薄片/空心开口', '透明', '中等反光', '刚性', '塑料', 'base_qwen3vl_4b', 'N', 'opt10_merged', 'G', 'model_improvement', 'none', 'pending', '', '示例：base错、当前模型对，可作为提升样本候选'],
    ['capture_group_20260603112843_tqbd9a', 'realtime_cam0_20260603112843_tqbd9a.jpg', 'realtime_cam1_20260603112843_tqbd9a.jpg', 'testCollection/SlenderItems', '笔', 'SlenderItems', 'N', '闭合未夹住', 'valid', '低对比', '闭合', '对准未接触', '近桌未接触', '在桌', '浅', '斜夹', '细长/小物体', '不透明', '中等反光', '刚性', '塑料/金属', 'base_qwen3vl_4b', 'N', 'opt10_merged', 'G', 'model_failure', 'N_to_G', 'pending', '', '示例：当前模型误判为抓住，进入失败样本候选'],
    ['capture_group_20260605041831_c4nzqn', 'realtime_cam0_20260605041831_c4nzqn.jpg', 'realtime_cam1_20260605041831_c4nzqn.jpg', 'testCollection/PlushToy', '毛绒玩具', 'PlushToy', 'unknown', '无法判断', 'unknown', '复杂', '不清楚', '看不清', '看不清', '看不清', '不清楚', '不清楚', '不规则', '不透明', '低反光', '柔性', '毛绒', 'base_qwen3vl_4b', 'failed', 'opt10_merged', 'failed', 'exclude', 'unknown', 'rejected', 'ambiguous', '遮挡太重或无法判断，不进入正式BM'],
]

value_rows = [
    ['分类维度', '字段名', '推荐取值', '是否硬配额', '用法说明'],
    ['主标签', 'G/N标签', 'G / N / unknown / invalid', '是', '正式BM只统计G和N；unknown/invalid不进入正式BM'],
    ['细分抓取状态', '细分抓取状态', '已夹住 / 闭合未夹住 / 张开未夹住 / 无法判断 / 无效样本', '是', '用于把人工判断映射成G/N，同时保留失败类型'],
    ['样本有效性', '样本有效性', 'valid / invalid / unknown', '是', '只有valid样本可进入冻结BM'],
    ['物体类别', '物体大类', 'BuildingBlocks / Container / PhoneCover / PlushToy / SlenderItems / Other / Background', '是', '主类别建议做均衡抽样；Background一般不作为被抓物体'],
    ['背景', '背景', '干净 / 复杂 / 低对比 / 反光背景 / 杂乱 / 不清楚', '软覆盖', '用于解释背景干扰，不建议和物体类别交叉做硬配额'],
    ['夹爪状态', '夹爪状态', '张开 / 闭合 / 半闭合 / 不清楚', '分析字段', '只描述夹爪开合，不要混入是否夹住'],
    ['夹爪与物体', '夹爪与物体', '错位空抓 / 对准未接触 / 部分包围 / 充分包围 / 看不清', '软覆盖', '解释G/N判断和模型错误的关键空间关系'],
    ['夹爪与桌面', '夹爪与桌面', '离桌 / 近桌未接触 / 接触桌面 / 抵住桌面 / 隔物支撑 / 看不清', '软覆盖', '抵住桌面、隔物支撑容易造成误判'],
    ['物体与桌面', '物体与桌面', '在桌 / 半离桌 / 离桌 / 压桌 / 看不清', '软覆盖', '用于判断物体是否真的被夹起'],
    ['夹取深度', '夹取深度', '浅 / 中 / 深 / 未进入 / 不清楚', '软覆盖', '浅夹和边缘夹容易耦合，但不建议合并字段'],
    ['夹取角度', '夹取角度', '正夹 / 侧夹 / 斜夹 / 不清楚', '软覆盖', '只描述方向，不放“浅夹/边缘夹”'],
    ['几何结构', '几何结构', '空心开口 / 细长 / 块状 / 薄片 / 圆柱 / 不规则 / 小物体 / 大物体 / 纹理背景 / 文字密集', '软覆盖', '可多选，建议用“/”分隔'],
    ['物理属性', '透明度', '透明 / 半透明 / 不透明 / 不清楚', '软覆盖', '不要与反光程度混成一个字段'],
    ['物理属性', '反光程度', '低反光 / 中等反光 / 高反光 / 不清楚', '软覆盖', '不透明物体也可能高反光'],
    ['物理属性', '形变属性', '刚性 / 柔性 / 可形变 / 不清楚', '软覆盖', '软袋、毛绒、夹子等可重点观察'],
    ['模型结果', '候选类型', 'model_improvement / model_failure / ordinary / exclude', '是', 'model_improvement=base错当前对；model_failure=当前模型错'],
    ['复核', '复核状态', 'pending / approved / rejected', '是', '只有approved样本进入最终冻结BM'],
]

instruction_rows = [
    ['说明项', '内容'],
    ['推荐使用方式', '这个文件分成三张表：物品标签字典、样本标注表、字段取值说明。'],
    ['物品标签字典', '一行一个物品或背景元素，只记录物体固有属性，例如几何结构、透明度、反光程度、材质。'],
    ['样本标注表', '一行一个cam0/cam1图片组，记录这一次抓取里的背景、夹取角度、夹取深度、空间关系和模型结果。'],
    ['关键原则', '不要把“背景、夹取角度、夹取深度、夹爪与物体、夹爪与桌面、模型版本”固定到物品名称上，因为同一物体每次拍摄状态可能不同。'],
    ['正式BM筛选', '建议只选择：样本有效性=valid，复核状态=approved，G/N标签明确为G或N的样本。'],
    ['cam0/cam1约定', 'cam1是评估图，参与人工标注、VLM和统计；cam0是参考图。'],
    ['防乱码', '本文件由UTF-8源码直接生成xlsx，不经过PowerShell管道转码。'],
]

sheets = [
    ('填写说明', instruction_rows),
    ('物品标签字典', object_rows),
    ('样本标注表', sample_rows),
    ('字段取值说明', value_rows),
]

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'


def esc(value):
    return html.escape('' if value is None else str(value), quote=False)


def col_name(n):
    name = ''
    while n:
        n, r = divmod(n - 1, 26)
        name = chr(65 + r) + name
    return name


def worksheet_xml(rows):
    max_rows = len(rows)
    max_cols = max(len(row) for row in rows)
    ref = f'A1:{col_name(max_cols)}{max_rows}'
    col_xml = []
    for c in range(1, max_cols + 1):
        values = [str(row[c - 1]) for row in rows if c - 1 < len(row)]
        width = max(min(max(len(v) for v in values) * 1.6, 48), 10)
        col_xml.append(f'<col min="{c}" max="{c}" width="{width:.1f}" customWidth="1"/>')
    rows_xml = []
    for r_idx, row in enumerate(rows, start=1):
        cells_xml = []
        for c_idx in range(1, max_cols + 1):
            value = row[c_idx - 1] if c_idx - 1 < len(row) else ''
            cell_ref = f'{col_name(c_idx)}{r_idx}'
            style = '1' if r_idx == 1 else '2'
            if value == '':
                cells_xml.append(f'<c r="{cell_ref}" s="{style}"/>')
            else:
                cells_xml.append(f'<c r="{cell_ref}" t="inlineStr" s="{style}"><is><t>{esc(value)}</t></is></c>')
        row_height = ' ht="24" customHeight="1"' if r_idx == 1 else ''
        rows_xml.append(f'<row r="{r_idx}"{row_height}>' + ''.join(cells_xml) + '</row>')
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{NS}" xmlns:r="{REL_NS}">
  <dimension ref="{ref}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>{''.join(col_xml)}</cols>
  <sheetData>{''.join(rows_xml)}</sheetData>
  <autoFilter ref="{ref}"/>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>'''


def build_xlsx():
    styles_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00A651"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E2EC"/></left><right style="thin"><color rgb="FFD9E2EC"/></right><top style="thin"><color rgb="FFD9E2EC"/></top><bottom style="thin"><color rgb="FFD9E2EC"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>'''
    workbook_sheets = []
    workbook_rels = []
    content_overrides = []
    for idx, (sheet_name, _) in enumerate(sheets, start=1):
        workbook_sheets.append(f'<sheet name="{esc(sheet_name)}" sheetId="{idx}" r:id="rId{idx}"/>')
        workbook_rels.append(f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>')
        content_overrides.append(f'<Override PartName="/xl/worksheets/sheet{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    workbook_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="{NS}" xmlns:r="{REL_NS}"><sheets>{''.join(workbook_sheets)}</sheets></workbook>'''
    workbook_rels_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG_REL_NS}">{''.join(workbook_rels)}<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'''
    content_types_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{''.join(content_overrides)}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'''
    rels_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG_REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'''
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    core_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Pick Verifier 测试集标注表</dc:title><dc:creator>Cursor</dc:creator><cp:lastModifiedBy>Cursor</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>'''
    app_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Cursor</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>{len(sheets)}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="{len(sheets)}" baseType="lpstr">{''.join(f'<vt:lpstr>{esc(name)}</vt:lpstr>' for name, _ in sheets)}</vt:vector></TitlesOfParts><AppVersion>16.0300</AppVersion></Properties>'''
    with zipfile.ZipFile(xlsx_out, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types_xml.encode('utf-8'))
        z.writestr('_rels/.rels', rels_xml.encode('utf-8'))
        z.writestr('xl/workbook.xml', workbook_xml.encode('utf-8'))
        z.writestr('xl/_rels/workbook.xml.rels', workbook_rels_xml.encode('utf-8'))
        z.writestr('xl/styles.xml', styles_xml.encode('utf-8'))
        z.writestr('docProps/core.xml', core_xml.encode('utf-8'))
        z.writestr('docProps/app.xml', app_xml.encode('utf-8'))
        for idx, (_, rows) in enumerate(sheets, start=1):
            z.writestr(f'xl/worksheets/sheet{idx}.xml', worksheet_xml(rows).encode('utf-8'))


def build_html():
    parts = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<title>Pick Verifier 测试集标注表</title>',
        '<style>body{font-family:Microsoft YaHei,Arial,sans-serif;margin:24px;color:#17202a}h1{font-size:24px}h2{margin-top:28px}.sheet{overflow:auto;margin-bottom:28px}table{border-collapse:collapse;min-width:980px}th,td{border:1px solid #d9e2ec;padding:8px 10px;vertical-align:top;white-space:nowrap}th{background:#00a651;color:white;position:sticky;top:0}tr:nth-child(even) td{background:#f8fafc}</style>',
        '</head><body><h1>Pick Verifier 测试集标注表</h1><p>如果 Excel 打开异常，可以先用浏览器打开这个 HTML 版本查看内容。</p>',
    ]
    for sheet_name, rows in sheets:
        parts.append(f'<h2>{esc(sheet_name)}</h2><div class="sheet"><table>')
        for r_idx, row in enumerate(rows):
            tag = 'th' if r_idx == 0 else 'td'
            parts.append('<tr>' + ''.join(f'<{tag}>{esc(cell)}</{tag}>' for cell in row) + '</tr>')
        parts.append('</table></div>')
    parts.append('</body></html>')
    html_out.write_text('\n'.join(parts), encoding='utf-8-sig')


def verify_xlsx():
    with zipfile.ZipFile(xlsx_out, 'r') as z:
        bad_entry = z.testzip()
        if bad_entry:
            raise RuntimeError(f'bad zip entry: {bad_entry}')
        for part in ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml'] + [f'xl/worksheets/sheet{i}.xml' for i in range(1, len(sheets) + 1)]:
            ET.fromstring(z.read(part))
        sheet2 = z.read('xl/worksheets/sheet2.xml').decode('utf-8')
        for text in ['物品名称', '手机壳（硬壳）', '玻璃杯', '标签贴纸（文字密集）']:
            if text not in sheet2:
                raise RuntimeError(f'missing expected text: {text}')
        sheet3 = z.read('xl/worksheets/sheet3.xml').decode('utf-8')
        for text in ['细分抓取状态', '当前模型预测', '示例：当前模型误判为抓住']:
            if text not in sheet3:
                raise RuntimeError(f'missing expected text: {text}')
    return '物品名称 手机壳（硬壳） 细分抓取状态'.encode('unicode_escape').decode('ascii')


if __name__ == '__main__':
    build_xlsx()
    build_html()
    marker = verify_xlsx()
    print(f'created_xlsx={xlsx_out}')
    print(f'created_html={html_out}')
    print(f'xlsx_size={xlsx_out.stat().st_size}')
    print(f'html_size={html_out.stat().st_size}')
    print(f'unicode_check={marker}')
