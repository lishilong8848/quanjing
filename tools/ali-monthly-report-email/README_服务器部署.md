# Windows Server 2022 部署说明

## 交付内容

运行根目录的 `打包为exe.bat` 后，会生成：

- `dist\monthly-report-server\monthly-report-server.exe`
- `dist\monthly-report-server\config.json`
- `dist\monthly-report-server\config.example.json`
- `dist\monthly-report-server\start_server.bat`
- `dist\monthly-report-server\start_server_helper.ps1`
- `dist\monthly-report-server\stop_server.bat`
- `dist\monthly-report-server\stop_server_helper.ps1`
- `dist\monthly-report-server\README_服务器部署.md`
- `dist\monthly-report-server\_internal\` 依赖目录
- `dist\monthly-report-server-winserver2022.zip`

这是一个适合 Windows Server 2022 64 位直接迁移的 `onedir` 包。服务器上不需要再安装 Python，也不需要再下载依赖。

## 如何部署

1. 在打包机上先执行 `python -m pip install -r requirements-build.txt`。
2. 运行 `打包为exe.bat`。
3. 将整个 `dist\monthly-report-server\` 目录，或 `dist\monthly-report-server-winserver2022.zip`，复制到服务器。
4. 如果复制的是 zip，在服务器上完整解压。
5. 双击 `start_server.bat` 启动。
6. 需要停止时，双击 `stop_server.bat`。

## 启动与停止

- `start_server.bat`
  - 后台启动程序
  - 调用 `start_server_helper.ps1`
  - 自动创建 `run\`、`logs\`、`downloads\`、`temp\`
  - 记录 PID 到 `run\monthly-report-server.pid`
  - 输出日志到 `logs\monthly-report-server.out.log` 和 `logs\monthly-report-server.err.log`

- `stop_server.bat`
  - 调用 `stop_server_helper.ps1`
  - 优先按 PID 停止
  - PID 不存在时，会尝试停止 `monthly-report-server.exe`

## 默认运行参数

- 默认监听地址：`127.0.0.1`
- 默认端口：`5011`
- 默认不自动打开浏览器

如需让局域网其它机器访问，可在启动前设置：

```bat
set APP_HOST=0.0.0.0
set APP_PORT=5011
start_server.bat
```

如果改成 `0.0.0.0`，请同时确认服务器防火墙已放行对应端口，并确认你接受局域网访问带来的风险。

## 配置文件

- 打包时会尝试把当前机器上解析后的真实配置写入 `dist\monthly-report-server\config.json`
- 同时也会保留 `config.example.json` 作为备份模板
- 为了适配服务器，打包生成的 `config.json` 会把 `download_folder` 固定为相对路径 `downloads`
- “阿里月报生成”中的月度告警分析会读取 `ali_alarm_source_url` 指向的告警源多维表，并使用 `ali_alarm_template_path` 指向的 Excel 模板生成新表
- 月度告警分析只纳入 `紧急`、`严重`、`重要`、`次要` 四类等级，其它等级不导出也不参与统计
- 默认告警分析模板随程序放在 `resources\EA118机房2026年3月告警分析表.xlsx`，打包时会一并带入 `_internal\resources`

## 注意事项

- 请复制整个 `monthly-report-server` 文件夹，不要只复制单个 `.exe`
- `downloads` 和 `temp` 都会在程序目录下生成
- “浏览选择文件”和“打开下载目录”依赖 Windows 桌面会话，建议通过 RDP 登录服务器桌面后使用
- 飞书轮询和 QQ SMTP 发信都要求服务器能访问对应外网服务
