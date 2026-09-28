# CNC 刀具寿命与工件质量追踪后端（虚构数据）

本机可运行的纯后端系统：TypeScript + Node.js + SQLite（better-sqlite3）。
只提供 **API、CLI、虚构机床事件生成器与自动化测试** —— 不包含网页，也不连接真实机床。
所有演示/测试数据均为虚构。

## 功能概览

- 主数据：机床、刀具序列号与刃口、加工程序版本、工单、检具及其校准历史
- 切削事件归属：切削时长精确归属到**当时安装的刃口**与**工单对应的程序版本**
- 刀具寿命：按刃口累计切削秒数、计算剩余寿命、超限预警
- 健壮性：事件乱序 / 重复 / 时钟偏差 / 换刀期间重叠加工均不会重复累计寿命
- 质量：量测登记（原始记录不可覆盖）、慢性漂移预警、尺寸超差追溯可疑工件
  （区分 `recheck` 仅需复检 与 `reject` 确定不合格）、报废与返工登记
- 审计：更正检具校准或报废阈值后重新评估，**旧判定保留**（superseded 而非删除）
- 并发：同一刃口不能同时在两台机床上有效使用（事务 + 部分唯一索引保证）
- 原始事件与量测记录均为 append-only，永不覆盖

## 安装与测试

```bash
npm install
npm test          # vitest：累计规则 / 追溯范围 / 审计 / 重启恢复 / 并发占用 / API 校验与分页
npm run build     # 仅类型检查编译（可选）
```

## 启动与停止 API 服务

```bash
npm start                 # 默认 DB_PATH=cnc.db，端口 0 = 本机自动分配空闲端口
# 或自定义：
$env:DB_PATH="my.db"; $env:PORT="8080"; npm start
```

启动后控制台会打印实际端口，如 `http://127.0.0.1:64609`。
停止：在服务终端按 `Ctrl+C`（收到 SIGINT/SIGTERM 后优雅关闭并关闭数据库）。

## 端到端演示（可重复）

```bash
npm run demo
```

使用固定种子与固定时钟，删除并重建 `demo.db`，依次演示：主数据建档 →
装刀 → 含重复事件且乱序的加工事件摄取 → 量测登记 → 换刀 → 慢性漂移预警 →
突然崩刃（超差）→ 可疑批次圈定 → 报废/返工 → 导出 `demo-report.json` 质量追溯报告。

## CLI

CLI 直接操作同一个 SQLite 数据库文件（`--db` 指定，默认 `cnc.db`），
关键操作（换刀、量测）会打印操作前后的状态。

```bash
npm run cli -- --db cnc.db machine add MC-01 "Mill 1"
npm run cli -- --db cnc.db tool add TOOL-001 "EndMill" 2 600
npm run cli -- --db cnc.db gauge add GAUGE-1 30
npm run cli -- --db cnc.db workorder create WO-1 PART-1 PROG-A v1 100
npm run cli -- --db cnc.db tool-change install TOOL-001 1 MC-01
npm run cli -- --db cnc.db event import events.json     # 导入加工事件（JSON 数组）
npm run cli -- --db cnc.db measure '{"measurementId":"m1","workorderCode":"WO-1","workpieceSn":"WP-1","feature":"diameter","value":10.01,"nominal":10,"tolPlus":0.02,"tolMinus":0.02,"gaugeCode":"GAUGE-1","measuredAt":1700000000000}'
npm run cli -- --db cnc.db life TOOL-001                # 计算/查看各刃口剩余寿命
npm run cli -- --db cnc.db suspects                     # 圈定的可疑批次
npm run cli -- --db cnc.db report WO-1 report.json      # 导出质量追溯报告
npm run cli -- --db cnc.db scrap-threshold 1.5          # 修改报废阈值并重新评估（保留旧判定）
npm run cli -- --db cnc.db gauge correct GAUGE-1 <calibratedAtMs> 30 "found cert"
```

## 虚构事件生成器

```bash
npm run generate -- events.json 10 42    # 输出文件 [件数] [随机种子]
```

完全确定性（mulberry32 种子随机、显式时间戳），可注入重复事件与乱序，
不依赖真实等待与真实随机。

## API 摘要

所有错误返回 `{ "error": { "code", "message" } }`，错误码稳定：
`VALIDATION_ERROR`(422/400)、`NOT_FOUND`(404)、`CONFLICT`(409)、
`EDGE_IN_USE`(409)、`EDGE_NOT_INSTALLED`(409)、`WORKORDER_CLOSED`(409)、
`INTERNAL_ERROR`(500)。列表端点支持 `?limit=&offset=` 分页并返回 `total`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/machines` `/tools` `/programs` `/workorders` `/gauges` | 主数据建档 |
| POST | `/tool-changes/install` `/tool-changes/remove` | 换刀（事务内占用检查） |
| POST | `/events` | 摄取机床事件（单个或数组，`eventId` 幂等） |
| POST | `/measurements` | 登记量测（`measurementId` 幂等，自动判定/预警/追溯） |
| POST | `/quality-actions` | 报废 / 返工（`actionId` 幂等） |
| POST | `/gauges/:code/calibrations` | 校准登记；`correct:true` 时更正并重新评估 |
| POST | `/settings/scrap-threshold` | 修改报废阈值并重新评估全部判定 |
| GET | `/tools/:serial/life` | 各刃口寿命与剩余量 |
| GET | `/workorders/:code/traceability` | 质量追溯报告 |
| GET | `/events` `/measurements` `/suspect-batches` `/alerts` `/segments` … | 分页查询 |

## 设计要点

- **时间与时钟**：所有写路径经过可注入 `Clock`（`src/clock.ts`），测试用
  `FixedClock`，不依赖真实等待；随机性用 `SeededRng` 注入。
- **寿命归属**：原始事件 append-only 存入 `events`；每次摄取后对单台机床做
  幂等的"对账"（按 `ts,seq,id` 排序配对 start/stop），段以开始事件
  `event_id` 为唯一键，重复/乱序/重启后重放都不会重复累计；跨换刀的切削
  在拆卸时刻截断，只计入实际切削的刃口。
- **并发**：多步写入均包裹在 SQLite 事务中；`installations` 上的部分唯一索引
  `uq_active_install_per_edge` 保证同一刃口全库最多一条有效装机记录。
- **迁移**：`schema_version` 表记录版本，迁移幂等，每次启动自动执行。

## 目录结构

```
src/
  clock.ts       可注入时钟与种子随机数
  db.ts          SQLite 连接与幂等迁移
  errors.ts      稳定错误码
  domain/        core（主数据）/ events（事件与寿命）/ quality（量测与追溯）
  app.ts         Express API（zod 校验、分页、错误码）
  server.ts      服务入口（自动端口、优雅停止）
  cli.ts         命令行
  generator.ts   虚构事件生成器
  demo.ts        端到端演示
tests/           vitest 自动化测试
```
