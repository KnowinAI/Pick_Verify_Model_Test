# 夹爪识别人工标注工作台

本仓库是从 `D:\fuwu\gripper-eval\platform` 迁移出的独立评估工作台副本，默认运行在 `5034` 端口，不会修改原项目目录。

## 项目结构

```text
.
├─ package.json                 # npm 启动和导入脚本入口
├─ start_lan_5034.bat           # 局域网部署启动器
├─ scripts/                     # 旧平台数据导入工具
└─ platform/
   ├─ gripper_eval.html         # 前端标注工作台
   ├─ gripper_eval_server.js    # Node.js 服务端
   ├─ gripper_eval_data.json    # 当前标注/VLM 数据
   └─ local_images/             # 当前数据引用的本地图片
```

`platform/local_images` 里的图片会被 `gripper_eval_data.json` 引用，不能按“临时文件”批量删除。可清理的通常是日志、导入备份、HTML 临时备份等已在 `.gitignore` 中列出的运行产物。

## 启动

```powershell
npm start
```

部署到能直连板子的同事电脑时，推荐双击 `start_lan_5034.bat`。

本机调试可打开：

```text
http://127.0.0.1:5034/
```

局域网部署时，`start_lan_5034.bat` 会自动打开并打印可分享地址，例如：

```text
http://192.168.x.x:5034/
```

## 局域网多人访问

部署到能直连板子的同事电脑时，推荐双击 `start_lan_5034.bat`，它会把实时画面源固定为板端 `http://192.168.127.10:9002`，并继续使用 `5034` 端口。

同事电脑需要放行 Windows 防火墙入站 TCP `5034`。其他同事不要使用 `127.0.0.1`，统一访问：

```text
http://同事电脑IPv4:5034/
```

多人可以同时标注。若两个人同时编辑同一张图片，后保存的人会收到冲突提示，可刷新查看最新标注，或确认覆盖。

## 配置

可通过环境变量覆盖默认地址：

```powershell
$env:PORT="5034"
$env:REALTIME_BASE_URLS="http://192.168.127.10:9002"
$env:VLM_CHAT_COMPLETIONS_URL="http://101.132.143.105:5087/v1/chat/completions"
$env:VLM_MODEL="pick_verifier_1200_merged"
npm start
```

`cam1` 是唯一参与评估和 VLM 推理的图片，`cam0` 作为参考图保存、展示并随同组记录一起删除。

## 导入旧平台数据

如果同事在旧项目里又采集并标注了图片，先把同事电脑上的 `D:\fuwu\gripper-eval\platform` 整个目录拷到本机任意位置，然后在本仓库运行：

推荐方式是在网页里导入：打开 `http://127.0.0.1:5034/`，在“图片记录”里的“同事数据同步”填入拷贝来的 `platform` 路径，先点“预览导入”，确认统计无误后点“正式导入并刷新”。路径会记在浏览器本地，下次只需要点按钮。

仍然可以使用命令行：

```powershell
npm run import:legacy -- "D:\path\to\copied\platform"
```

也可以直接传旧项目根目录，脚本会自动寻找里面的 `platform`：

```powershell
npm run import:legacy -- "D:\path\to\copied\gripper-eval"
```

导入前可先 dry-run 查看会复制和合并多少内容：

```powershell
npm run import:legacy -- "D:\path\to\copied\platform" --dry-run
```

脚本会合并 `gripper_eval_data.json`，复制缺失的 `local_images` 图片，并在写入前备份当前数据。
导入时会查重：同名图片、内容完全相同的图片，以及同一时间戳/相机的记录会跳过，避免重复显示。
