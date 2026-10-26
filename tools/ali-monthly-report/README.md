# 阿里月报生成逻辑独立包

这个目录是从现有控制台中抽出的独立月报逻辑包，不依赖 Flask `app.py`，适合复制到其他程序中调用。

## 包含能力

- `alarm_analysis`：从告警源生成 EA118 月度告警分析 Excel，并同步到资料管理告警分析表。
- `over_power`：从高功率月报表下载指定年月的超功率/超功耗附件，自动排除 TOP5。
- `high_power_top5`：从高功率月报表下载指定年月的 TOP5 附件。
- `staff_roster`：从人员管理多维表导出在职人员基础信息和本月新增/离职人员 Excel。

## 安装依赖

```powershell
python -m pip install -r requirements.txt
```

## 配置

复制 `config.example.json` 为你的业务配置文件，填写：

- `feishu_app_id`
- `feishu_app_secret`
- `feishu_app_token`：告警分析上传及高功率附件下载需要。
- `download_folder`
- `ali_alarm_source_url`
- `ali_alarm_template_path`
- `ali_staff_source_url`
- `alarm_report_table_id`
- `alarm_report_view_id`
- `high_power_table_id`
- `high_power_view_id`

不要把真实密钥提交到代码仓库。

## CLI 调用

```powershell
python monthly_report_runner.py --type alarm_analysis --year 2026 --month 5 --config config.json
python monthly_report_runner.py --type over_power --year 2026 --month 5 --config config.json
python monthly_report_runner.py --type high_power_top5 --year 2026 --month 5 --config config.json
python monthly_report_runner.py --type staff_roster --year 2026 --month 5 --config config.json
```

也可以用环境变量，不传 `--config`：

```powershell
$env:FEISHU_APP_ID="cli_xxx"
$env:FEISHU_APP_SECRET="xxx"
$env:FEISHU_APP_TOKEN="xxx"
python -m ali_monthly_reports --type staff_roster --year 2026 --month 5
```

## 代码调用

```python
from ali_monthly_reports import ReportConfig, generate_monthly_report

config = ReportConfig.from_file("config.json")
result = generate_monthly_report("staff_roster", "2026", 5, config)
print(result["files"])
```

返回结果中的 `files` 会包含生成/下载文件的 `name`、`path` 和 `size`。

## 部署说明

- `resources/EA118机房2026年3月告警分析表.xlsx` 是告警分析模板，默认配置会引用它。
- `ali_monthly_reports/alarm_report_generator.py` 是告警分析生成器副本，独立包不需要访问原控制台目录。
- 当前包负责生成或下载文件；告警分析生成成功后会同步目标多维表。它不做邮件发送，也不启动 Web 服务。
