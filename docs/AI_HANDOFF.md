# CPE Monitor 项目交接：功能、改动和后续维护

更新日期：2026-10-08（北京时间）。当前应用版本：`0.3.0`。

这份文档供后续开发者及其他 AI 工具接手使用。源码是依据原项目继续改造的，不是将参考项目整体搬过来。以下严格区分现有能力、已完成改动、隔离验证与尚未验收的能力。

## 1. 当前目标与用户已确认的选择

- 产品名称统一为 **CPE Monitor**，使用设备为 **H153-381**。
- 普通用户双击 Windows x64 安装包即可安装运行，不要求用户安装开发环境或填写应用管理员密码。
- 用户曾使用过参考项目 CPE++ 的 Windows 版，希望界面美观、同步及时、资源占用较低。
- 最终选择：**软件窗口内嵌现代页面**。`0.2.0` 的传统 WinForms 控件界面曾降低资源占用，但用户不满意外观，`0.3.0` 恢复现代网页界面。
- 可见窗口希望秒级更新；窗口失焦继续刷新；最小化、关闭页面后优先节省资源；短信后台独立运行。
- 用户明确要求每次改版前备份、发布后再备份，旧备份不覆盖、不清理。
- 上传目标是用户 Fork `https://github.com/baolongzhanshi/cpe-monitor`。`origin` 指向原作者，不能误推送到 `origin`。
- 此聊天已授权 Fork 上传、Actions 打包、桌面交付及隔离安装验收。不得把这种授权扩大为停止用户正在运行的应用、连接真实设备测试或发送测试通知。

## 2. 已有功能与本轮贡献

| 功能 | 当前能力 | 本轮处理 |
|---|---|---|
| 网络仪表盘 | 速率、流量、套餐、信号、终端、小区信息及图表 | 加统一实时采集器，SSE 直接更新数值和实时曲线，显示真实采集时间 |
| 设备页 | 设备型号/版本、蜂窝信号、能力、在线终端 | 信号和小区使用实时事件，终端列表约 5 秒读取，身份等慢字段低频读取 |
| 短信收件箱 | 从 CPE 读取并保存短信、会话及未读状态 | 默认独立每 15 秒同步、秒数设置、轻量检查、完整性保护、重复记录去重 |
| PushPlus | 新增入站短信同步转发 | 接入通知配置/设置/测试接口；Token 加密保存，公开接口隐藏 Token |
| 告警与报告 | 告警规则、日志、日报/周期报告 | 保留原有业务，适配桌面宿主和事件连接；未重写全部告警/报告逻辑 |
| 主题和现代 UI | 主题色、浅色/深色、卡片和图表 | 名称统一，现代页面内嵌；高频图表取消逐帧动画 |
| 安装和托盘 | Windows 用户级安装、快捷方式、托盘后台 | 自带 Node/.NET 运行时，WebView2 自动检测/补齐，单实例、页面关闭释放 |
| 备份和回退 | 完整源码/历史/安装包/用户数据备份 | 新增在线 SQLite、配对密钥、DPAPI 加密归档、哈希清单与导出工具 |

原仓库已具备相当多监控、告警、设备和报告功能，不应把整套功能都归为本轮新增。参考项目只用于架构评估；分析记录见 `docs/cpeplusplus-architecture-review.md`。

### 0.1.1 阶段

- 基于既有 Next.js 后台制作 Windows 安装/托盘宿主，加入 PushPlus 短信转发。
- 桌面本机模式免应用管理员登录；远程/Web 模式认证仍保留。
- 修复首次设置引导“下一步无反应”相关逻辑、设备地址规范化、已存设备密码解密测试。
- 敏感 API 不进入 Service Worker 离线缓存，避免缓存短信/登录/配置数据。
- 新安装短信默认 15 秒，历史用户配置不被默认值覆盖。

### 0.2.0 阶段

- 增加 .NET 10 WinForms 原生六页 UI、图表、托盘生命周期和单实例。
- 保留 Node/Next 后台；**没有把设备通信、SQLite、短信和 PushPlus 全部重写为 C#**。
- 优化 live 接口共享请求、短信摘要检查、重复写库、SSE 清理和窗口控件释放。
- 界面最终被用户否决，但旧原生代码保留作回退/参考，不能误认它是当前正式主界面。

### 0.3.0 阶段（当前）

- 正式窗口改为 `ModernMainForm` 的 WebView2，显示随安装包提供的本机 Next 页面，**不会打开外部浏览器**。
- 新增共享持续实时采集器；页面由完整事件负载更新，不在每个事件后再 GET 一次。
- 可见性通过宿主事件与浏览器可见性联合管理；失焦不停刷，最小化挂起，关闭释放页面。
- 增加真实采集时间、字段采样时间、过期/失败状态、离线退避和有界实时曲线。
- 检测并修复了本机两份运行密钥不匹配问题；异常原数据已加密保留。宿主现在会拒绝静默混用不一致的密钥。
- 统一版本元数据、安装包和 Actions 输出到 `0.3.0`。

## 3. 当前架构与启动链路

```text
CPEMonitor.exe（.NET 10 WinForms 托盘宿主）
  ├─ ServerHost → 内置 runtime/node.exe
  │                └─ resources/server/server.js（Next.js 16.2.6）
  │                     ├─ SQLite + 加密配置 + CPE 会话
  │                     ├─ 实时采集器 → /api/dashboard/live、SSE
  │                     ├─ 短信同步 → SQLite → PushPlus/邮件/企业微信
  │                     └─ 历史采集、告警、日报/周期报告
  └─ ModernMainForm → WebView2 → http://127.0.0.1:3210/dashboard
```

默认后端仅监听 `127.0.0.1:3210`。开发命令 `npm run dev` 当前是 **8010**，不要按旧文档的 3000 端口排查。安装目录默认 `%LOCALAPPDATA%\CPE Monitor`；兼容数据目录保留 `%APPDATA%\com.cpeye.monitor`，不能为了改品牌直接改掉它。

入口为 `Program.cs → NativeApplicationContext → ServerHost → ModernMainForm`。重复启动通过命名 mutex/EventWaitHandle 显示已有窗口。关闭主窗保留托盘和后端，从托盘“退出并停止同步”才结束宿主所拥有的后台进程。

页面由本地后台提供，包含 React/Next 渲染；不是无需渲染的静态图片，也不是“完全原生化”。WebView2 打开时仍有内存/CPU 开销。

## 4. 实时采集规则和接口契约

| 条件/字段 | 目标周期 |
|---|---:|
| 有可见的指标订阅：流量速率 | 1 秒 |
| 信号/连接/小区快照 | 2 秒 |
| 在线终端数量 | 5 秒 |
| 月统计、升级等慢字段 | 60 秒 |
| 没有指标订阅：后台实时采集 | 15 秒 |
| 设备页终端列表 | 5 秒 |
| 设备身份/能力等页面详情 | 5 分钟 |
| 短信独立同步 | 新安装默认 15 秒，保留用户设置 |

这些是**目标周期**，不是保证零延迟。CPE 接口采用轮询，没有发现可直接使用的设备主动推送协议；请求锁、设备响应、登录、网络和通知队列都会影响实际速度。耗时计入下一轮周期，在途调用共享 Promise，慢请求不堆成并行任务。失败按 5–60 秒指数退避。

- `GET /api/dashboard/live`：读取共享最近快照；未取得快照时允许按需读取。
- `GET /api/dashboard/stream?metrics=1`：取得实时订阅租约；初始发送已有快照，之后接收 `metrics`。
- `GET /api/dashboard/stream?metrics=0`：告警连接，不提速、不发送每秒指标。顶栏使用此参数。
- `metrics.payload` 为 `{ overview, trafficStats, collectedAt, stale, fieldCollectedAt, fieldErrors, realtime }`。
- `collectedAt` 为流量接口实际响应时间；缓存读取/失败不得更新这个时间。
- `realtime` 含订阅数、周期、递增序号、尝试/成功时间、数据年龄和失败信息。
- SSE 正常时前端直接应用负载；断线时 2 秒轮询兜底；隐藏时断开订阅并取消读取。
- 图表最多追加最近 180 条实时点，重复/迟到/失败样本不产生假点；修复了 ISO 时间重复拼接 `Z` 的问题。
- 绿色时效标记与新数据相关，不能仅靠 SSE 连接成功显示“实时正常”。

历史数据库采集仍是原有 5/15/30/60 分钟任务，用于历史、告警和报告；**本轮没有将每秒实时点全部写入 SQLite**。实时曲线与持久化历史是两条链路，重启会失去内存中的实时点。

## 5. 短信与 PushPlus 的实际行为

- 独立后台调度，不依赖页面打开。界面输入秒，现有 API/数据库配置单位是分钟，15 秒对应 `0.25` 分钟。
- 自动先读取短信计数/联系人摘要，无变化跳过逐号码历史，每 60 秒做一次完整兜底。
- 首次、手动、有变化、换设备、恢复失败等情况强制完整读取。
- XML 错误、部分读取失败、截断/满页上限、正计数但正文为空等情况不能登记为完整成功快照。
- 指纹去重，未变化记录不执行 SQLite UPDATE；首次导入旧短信默认不批量推送。
- 新增入站短信调用已配置的 PushPlus/邮件/企业微信通知。
- PushPlus 在这里转发的是 CPE 收到的短信内容；**不能声称已实现向手机号码直接发送运营商付费短信**。
- 用户曾确认旧版本短信与推送可用；0.3.0 实际 H153-381 的持续同步和微信到达延迟未由本轮隔离测试证明。

已知重要限制：当前没有持久化可靠通知队列。失败消息已经入库后不会自动再次通知；推送完成但入库前崩溃也可能导致重复通知。`notified` 是当前聚合结果，不等于每个渠道分别有完整送达状态。后续应引入带渠道状态、重试退避、幂等策略的 outbox，不能宣传“保证送达”。

## 6. 核心文件导航

| 路径 | 作用 |
|---|---|
| `AGENTS.md` | 项目语言、备份、隐私、Context7 协作规则 |
| `desktop-native/Program.cs` | 单实例、应用/验收入口 |
| `desktop-native/NativeApplicationContext.cs` | 托盘、窗口创建/释放、后端寿命 |
| `desktop-native/ModernMainForm.cs` | 正式 WebView2 主窗、导航限制、可见性与挂起 |
| `desktop-native/ServerHost.cs`、`Dpapi.cs` | 本机 Node、端口、密钥生成/迁移、DPAPI |
| `desktop-native/MainForm.cs`、`Views/`、`UiSmokeTest.cs` | 旧 0.2.0 原生界面和测试，当前不是默认主窗 |
| `desktop-native/ModernUiSmokeTest.cs` | WebView2 模拟事件与截图验收 |
| `src/lib/cpe-*` | 设备客户端、协议/会话/认证/短信解析；改频率不得绕过请求锁 |
| `src/lib/realtime-collector-core.ts` | 可注入时钟的采集循环、租约、退避、在途去重 |
| `src/lib/realtime-collector.ts`、`realtime-collector-state.ts` | 业务绑定与 globalThis 单例 |
| `src/lib/dashboard-live-reader.ts`、`dashboard-live-service.ts` | 字段分级缓存、实际采样时间与完整响应 |
| `src/lib/event-bus.ts`、`sse-stream.ts` | 全局事件和连接独立清理/背压 |
| `src/lib/scheduler.ts`、`traffic-scheduler-status.ts` | 历史任务与启动实时任务，拆分依赖防止循环引用 |
| `src/lib/sms-lightweight-sync.ts`、`sms-sync-scheduler.ts` | 短信摘要/完整同步、持久化和通知 |
| `src/lib/notifiers/pushplus.ts`、`notification-config.ts` | PushPlus 发送及凭据保护 |
| `src/hooks/useLiveMetrics.ts`、`useSSE.ts` | 事件直推与断线兜底 |
| `src/hooks/usePageVisibility.ts`、`useDevicePage.ts` | 宿主可见性、设备页分级读取 |
| `src/lib/live-view-model.ts` | 采样去重、有界历史、数据新鲜度纯函数 |
| `scripts/build-desktop.mjs`、`build-native.ps1` | Next standalone、ABI/SQLite 检查、自包含宿主、NSIS |
| `scripts/native-installer.nsi` | 当前用户安装、占用检测、WebView2 引导、保留用户数据的卸载 |
| `scripts/backup-version*.ps1`、`backup-version-db.mjs` | 完整备份、在线 SQLite、DPAPI 导出 |
| `.github/workflows/windows-installer.yml` | Windows 构建/离线验证/上传安装器 artifact |

`src-tauri/` 仍保存早期 Tauri 宿主代码，并承担 `resources/server`、内置 Node 暂存和图标位置。当前正式安装路径是 .NET + NSIS，不能贸然删掉整个目录。`desktop-native` 和工作流仍使用部分“native/原生”历史命名。

## 7. 安全、数据与备份约束

- 桌面免管理员密码仅适用于显式桌面模式及本机同源访问，保留设备本身的账号/密码。它不是取消所有认证。
- 宿主清理继承的设备/通知环境变量，运行密钥从本机数据目录载入；不要沿用 CI 的 build-only 密钥。
- `runtime-secrets.dpapi` 由 DPAPI CurrentUser 保护；遗留 JSON 完成一致性验证后迁移/删除。发现两份不一致必须停下来修复，不能随机重建密钥。
- 设备/通知敏感字段使用 AES-256-GCM；**运行中的 SQLite 不是整库加密，短信正文等仍是普通数据库字段**。完整备份中的 `user-data.dpapi` 才是整体 DPAPI 加密归档。
- 整体用户数据的保护标准必须按 `AGENTS.md` 继续落实，不要把上述现状说成所有数据都已加密。
- 数据库、短信、密码、Token、`.env`、运行密钥、备份和本地测试用户数据绝不上传 GitHub；`.env.example` 可上传。
- SQLite 正在运行时必须在线备份以包含 WAL；禁止仅复制主文件。备份不得停止用户的现用程序。
- 回退先备份当前状态；数据库与密钥成对恢复，应用退出后清除目标旧 WAL/SHM，使用创建 DPAPI 备份的同一 Windows 用户。
- `manifest.json.status=complete` 才能标为完整可回退备份；失败目录不能改名冒充成功。

参考命令（在项目根目录执行；改版前填当前版本及真实安装包）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\backup-version.ps1 -Version 0.3.0 -InstallerPath 'D:\Desktop\CPE\installers\CPEMonitor_0.3.0_x64-setup.exe'
# 发布并交付后再次保存，保留原目录
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\backup-version.ps1 -Version 0.3.0 -Phase released -InstallerPath 'D:\Desktop\CPEMonitor_0.3.0_x64-setup.exe'
```

中文 `.ps1` 和 `.nsi` 注意保留 UTF-8 BOM，兼容 Windows PowerShell 5.1。`tools/`、`backups/`、`installers/`、`native-dist/`、`bin/obj` 均是本机产物，不属于 GitHub 源码。

## 8. 构建与验证方式

构建机：Windows x64、Node **24.14.0**、.NET **10** SDK、NSIS。安装用户无需这些开发工具；安装器包含自包含 .NET 和匹配 ABI 的 Node，WebView2 引导安装器来自微软并在构建时验证签名。缺少 WebView2 的首次安装需要联网；本轮未在无运行时的干净离线系统验收。

```powershell
npm ci
npm run typecheck
npm test
$env:CPE_NODE_RUNTIME = 'C:\path\to\node.exe'
# 构建环境须提供 JWT_SECRET、CPE_SESSION_SECRET、CPE_CONFIG_SECRET 等 build-only 值，参照工作流。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-native.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-native.ps1
```

单独原生编译可用 `dotnet build desktop-native\CpeMonitor.Native.csproj -c Release`。脚本优先查找本机 `tools/dotnet/dotnet.exe`；`npm run check` 包括全仓 lint，当前仍可能被旧 lint 问题阻断。

隔离环境：独立端口 `13210`、全新空数据目录，使用 `CPE_MONITOR_SMOKE_REPORT`、`CPE_MONITOR_DATA_DIR`、`CPE_MONITOR_PORT`。宿主会设置 `CPE_ISOLATED_TEST=true` 禁止设备任务。不能把 `--web-ui-smoke` 或 `--smoke-test` 指向现用数据/端口。

CI 在 `main`、`v*` 标签推送或手动 dispatch 后构建，artifact 名 `CPEMonitor-Windows-installer`。它只上传构建 artifact，**没有自动创建 GitHub Release 的步骤**。工作流权限 `contents: read` 与插件上传源码所需的写权限是两回事。

## 9. 已完成验证及证据边界

- 0.3.0 全部 **74 项离线测试通过**；包括实时频率/退避/无重叠/未配置保护/SSE租约释放、前端去重和180点上限、短信完整性及去重、敏感通知配置等。
- TypeScript 检查通过；生产后台构建、自包含宿主编译/发布与 NSIS 生成通过，最后宿主编译 0 警告、0 错误。
- 现代 WebView2 验收：独立端口、空数据、**浏览器内模拟 EventSource**；数值变化、页面渲染、截图、最小化挂起和恢复通过。
- 最终安装包：安装文件哈希、隔离后台、卸载、恢复快捷方式/注册表、未触碰用户数据均通过。
- 0.2.0 曾有六页两尺寸共26张原生UI截图验收；它们不能代替0.3.0所有页面真实交互验收。
- 备份隔离回归包括 WAL 已提交数据、JSON/DPAPI/双格式/不一致拒绝/旧format=1导出；保留已有证据。
- 本次前端修改文件 lint 通过；全仓曾有旧问题 7 errors/3 warnings，集中 logs、CommandPalette、TrafficCompareCard、useAlertHistory、PeriodReportsView 等，接手时再复核。
- **没有完成0.3.0真实H153-381、真实PushPlus送达、长时间CPU/内存、完整生产数据回退演练。**
- 旧0.2.0约133MiB工作集是空配置短时快照，不是0.3.0性能数字，也不是无内存泄漏证据。工作集合计含共享页，私有提交不是物理RAM。

本机交付与证据（不上传真实数据/备份）：

| 项目 | 本机路径 |
|---|---|
| 最终0.3.0安装包 | `D:\Desktop\CPEMonitor_0.3.0_x64-setup.exe` |
| 工作区安装包 | `installers/CPEMonitor_0.3.0_x64-setup.exe` |
| 最终安装包SHA256 | `77D2D9F945CCC06FA2D4537E3F63B4D44085AFBB59B393FA6B039D68B16190D8` |
| 现代UI最终证据 | `tools/modern-ui-final-af04dd08966c45b8825ee0d06f4da318/report.json` |
| 最终安装证据 | `tools/native-install-final-4d934f1fdb674d6f9ef0dc67888ce8f3/install-result.json` |
| 原生改版前稳定备份 | `backups/v0.1.1-before-change-20261007-191048-413` |
| 0.3.0改版前0.2.0备份 | `backups/v0.2.0-before-change-20261008-002922-706` |
| 最终0.3.0发布备份 | `backups/v0.3.0-released-20261008-114352-460` |
| 写本交接前备份 | `backups/v0.3.0-before-change-20261008-121846-306` |
| 异常密钥加密保留 | `backups/key-pair-recovery-20261008-002921-824` |

不要把早期失败备份、仅自包含程序的开发快照或旧构建误当最终正式回退包。实际恢复以 manifest 和 SHA256 为准。

## 10. 后续工作优先级

1. 取得并验证 Fork 写入权限，推送安全源码，观察 Actions；若HTTP403，报告真实失败，不声称已经上传。禁止重建密钥或上传数据来解决发布问题。
2. 用户配合下验收真实H153-381：观察实际采样间隔、故障恢复、短信去重与PushPlus到达；明确允许通知后才发测试消息。
3. 实测0.3.0前台/最小化/关闭后的整个进程树CPU和内存，长窗口检查句柄/线程增长。页面打开更美观但不等于占用必然更低。
4. 实现短信持久化outbox、每渠道状态、退避重试及崩溃幂等，补充有意义的离线故障测试。
5. 检查敏感数据整体保护、迁移、回退和安装器缺WebView2/断网场景。
6. 清理旧lint和文档/命名残留：health版本仍是旧固定字符串、`needsSetup`存在过时原生窗体注释；正式安装器名称仍含“原生”。README开发端口已在本次交接中修正为8010。未使用的原生页面先确认依赖后再删。
7. 若要减少Node常驻负担，单独规划轻后台替换；先保留协议/会话/SQLite/加密与短信行为兼容，不能用未经验证的改写破坏已可用功能。

## 11. 可直接复制给下一位 AI 的接手提示

> 请接手 CPE Monitor 0.3.0。先读 AGENTS.md 和 docs/AI_HANDOFF.md，再检查当前源码、Git远程、安装包SHA256和备份manifest。正式界面是desktop-native/ModernMainForm.cs内嵌WebView2，本机Node/Next提供页面和后台；不是旧MainForm原生控件版。后台实时采集目标1秒速率/2秒信号/5秒终端，无页面时15秒；短信独立默认15秒，PushPlus通知没有可靠失败补发队列。每次改版前完整备份并确认complete，发布后再备份，禁止上传数据库/短信/密码/Token/运行密钥/.env/备份。离线测试及模拟WebView2验收已通过，但真实H153-381和长期资源占用未验收。不要自动停止现用程序、连接设备或发通知。修改前先明确本次目标，优先解决交接文档待办；查库/SDK文档用Context7。最后如实报告修改、验证、未完成部分和备份位置。

推送和本轮文档发布结果记录在同目录 `DELIVERY_STATUS.md`；应用安装包不会因本次仅新增文档而变更。
