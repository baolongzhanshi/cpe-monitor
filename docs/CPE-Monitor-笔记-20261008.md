# CPE Monitor 项目笔记（2026-10-08）

> 用途：可直接粘贴进 Notion 的项目记录。当前应用版本 `0.3.1`，本轮另含尚未打包的通知出站队列改动。

## 项目概览

- 产品名：CPE Monitor。设备：H153-381（5G CPE）。
- 工作区：`D:\Desktop\CPE`。Fork：`baolongzhanshi/cpe-monitor`；`origin` 是原作者仓库，禁止误推。
- 目标：小白双击安装包即可运行、短信实时推送、低资源占用、界面美观、数据实时刷新。

## 架构决策

- 正式界面是 .NET 10 WinForms 宿主内嵌 WebView2，页面由随包分发的本机 Next.js 后台提供，不打开外部浏览器。
- 0.2.0 的纯原生控件界面已被用户否决，源码保留作参考，不是当前入口。
- 后台实时采集目标：速率 1 秒、信号 2 秒、终端 5 秒、慢字段 60 秒；无页面订阅时降到 15 秒。
- 短信独立同步默认 15 秒，PushPlus 转发 CPE 收到的短信，不是运营商付费短信。

## 本轮改动（0.3.1 及之后）

1. 后台进程生命周期：宿主崩溃或被强制结束会遗留 node 进程并占住 3210 端口。现在后台绑定作业对象，宿主消失即回收；启动时清理无人管理的遗留后台并记录 `host-events.log`。
2. WebView2 内存：不可见时先设低内存目标再挂起渲染进程，恢复时还原；关窗时主动停止页面再释放。
3. 可见性竞态：更新期间的窗口可见性请求由“丢弃”改为“合并重放”，避免快速最小化再恢复后页面误判不可见而停止刷新。
4. 仪表盘渲染结构：秒级状态集中到 `LiveMetricsProvider` 并按频率切成速率/概览/曲线/元信息/慢速五个切片；页面外壳与静态区块只创建一次元素，不再随每秒数据重渲染；慢速卡片保留 `memo`。
5. `RefreshIndicator` 的常驻每秒定时器改为按失效边界单次调度。
6. UI 验收脚本增加失败诊断字段（页面文本、可见性来源、事件源数量）。
7. 通知出站队列（尚未打包）：新增 `notification_outbox` 表（schema v7），短信入库与待发送记录同流程落库，每渠道一行、(渠道,类型,去重键) 唯一；失败按 30 秒→2 小时指数退避重试，超过 5 次进入 dead；后台每 30 秒处理一次，与短信同步间隔解耦。送达语义是“至少一次”，不承诺精确一次。

## 验证证据

- 类型检查通过；改动文件 lint 零问题；单元测试 76 项全部通过（含新增出站队列策略测试）。
- Next 生产构建通过，所有路由正常编译。
- 真实 SQLite 验证迁移：`user_version=7`，`notification_outbox` 表 11 个字段齐全，索引已建。
- 隔离后台验收（`scripts/test-native.ps1`）通过。
- 现代 UI 端到端验收 `success=true`：页面渲染、模拟速率每秒变化、最小化隐藏、渲染进程挂起、恢复五项全绿，五张页面截图已生成。

## 交付与备份

- 安装包：`D:\Desktop\CPEMonitor_0.3.1_x64-setup.exe`，70,247,716 字节，SHA256 `B19778A0D59F5A2018E560CEE07CDB623CFCF564B974E90CE012699C8E666EBD`。
- 发布后备份：`backups/v0.3.1-released-20261008-175900-125`，`status=complete`，源码 380 文件。
- 改版前备份：`backups/v0.3.0-before-change-20261008-173417-221`。
- 通知出站队列这一轮的代码尚未打包，回退点是上面的 0.3.1 发布备份。

## 未完成与风险

- 真实 H153-381 长期运行、PushPlus 实际送达延迟、长时间 CPU/内存与句柄增长趋势都未验证。
- 出站队列的发送成功与标记成功之间若进程崩溃，仍可能重发一次（上游无幂等键）。
- 运行中的 SQLite 不是整库加密，短信正文是普通列；只有完整备份里的 `user-data.dpapi` 是整体加密。
- 安装包未做代码签名，首次安装会出现 SmartScreen 未知发布者提示。
- 全仓仍有 7 处旧 lint 问题集中在 logs 页面、CommandPalette、useAlertHistory、PeriodReportsView 等处。
- 本轮源码尚未提交 Git，推送前必须确认目标是 Fork 而非 origin。

## 关键路径

| 用途 | 路径 |
|---|---|
| 宿主入口 | `desktop-native/Program.cs`、`NativeApplicationContext.cs` |
| 正式窗口 | `desktop-native/ModernMainForm.cs` |
| 后台进程管理 | `desktop-native/ServerHost.cs`、`ProcessJob.cs` |
| 仪表盘实时上下文 | `src/components/dashboard/live-metrics-context.tsx` |
| 仪表盘外壳与分区 | `src/components/dashboard/DashboardBody.tsx` |
| 通知出站队列 | `src/lib/notification-outbox.ts`、`notification-outbox-policy.ts` |
| 短信同步与通知 | `src/lib/sms-sync-scheduler.ts` |
| 数据库迁移 | `src/lib/db.ts`（当前 schema v7） |
| 交接文档 | `docs/AI_HANDOFF.md`、`docs/DELIVERY_STATUS.md` |
