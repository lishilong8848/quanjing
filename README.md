## 南通机房值班管理系统

这是一个 NestJS + React/Rspack 的排班管理项目。迁移到新电脑后，先安装依赖并验证：

```bash
npm install
npm run type:check
npm run lint
npm run build:prod
```

本项目已改为跨平台 npm 脚本，可在 Windows PowerShell、macOS 和 Linux 中直接运行：

```bash
npm run dev
```

## 环境变量

复制 `.env.example` 中的字段到 `.env`，不要提交 `.env`。核心配置包括数据库、飞书开放平台应用凭据、各多维表的 `APP_TOKEN` / `TABLE_ID`。本地启动时 `FORCE_AUTHN_INNERAPI_DOMAIN` 可指向本机服务，例如 `http://localhost:3000`；`FORCE_FRAMEWORK_DOMAIN_MAIN` 用于本地前端容器通信，默认可设为 `http://localhost:8080`。

如果开发环境暂时没有 `SUDA_DATABASE_URL`，服务会进入本地无数据库检查模式：页面和静态接口可以启动，读取类排班接口返回空数据，写入/同步类操作仍会明确提示需要配置数据库。生产模式仍要求真实数据库连接。

后续拿到飞书多维表链接后，可以从链接中提取：

- `/base/<APP_TOKEN>` 对应 `FEISHU_MAIN_APP_TOKEN` 或独立表的 `*_APP_TOKEN`
- `table=<TABLE_ID>` 对应具体表的 `*_TABLE_ID`

同步接口缺少飞书配置时会返回明确错误，页面和本地构建不会因此崩溃。
