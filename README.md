# 夹爪识别人工标注工作台

本仓库是从 `D:\fuwu\gripper-eval\platform` 迁移出的独立评估工作台副本，默认运行在 `5034` 端口，不会修改原项目目录。

## 启动

```powershell
npm start
```

也可以双击 `start_5034.bat`。

打开：

```text
http://127.0.0.1:5034/
```

## 配置

可通过环境变量覆盖默认地址：

```powershell
$env:PORT="5034"
$env:REALTIME_BASE_URL="http://192.168.78.168:5033"
$env:VLM_CHAT_COMPLETIONS_URL="http://101.132.143.105:5087/v1/chat/completions"
$env:VLM_MODEL="pick_verifier_1200_merged"
npm start
```

`cam1` 是唯一参与评估和 VLM 推理的图片，`cam0` 作为参考图保存、展示并随同组记录一起删除。
