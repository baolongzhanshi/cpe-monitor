# 0.3.2 交付状态

更新日期：2026-10-08（北京时间）。

- 本地0.3.2安装包已生成：桌面 `D:\Desktop\CPEMonitor_0.3.2_x64-setup.exe`，工作区 `installers/CPEMonitor_0.3.2_x64-setup.exe`，SHA256：`40C6CC2256FAE3BD13C04B6955EA3669CBE638FA96BF93BA198D635C3E3060EE`，70,239,121 字节。两处哈希已核对一致。
- 本轮新增通知出站队列：`notification_outbox` 表（schema v7），短信入库与待发送记录同流程落库，每渠道一行且去重键唯一；失败按 30 秒到 2 小时指数退避，超过 5 次进入 dead；后台每 30 秒处理一次，与短信同步间隔解耦。送达语义为“至少一次”，不承诺精确一次。
- 验证结果：类型检查通过；改动文件 lint 零问题；单元测试 76 项全部通过；Next 生产构建通过；真实 SQLite 上迁移验证为 `user_version=7` 且表结构与索引齐全；`scripts/test-native.ps1` 隔离后台验收通过；现代 UI 端到端验收 `success=true`，页面渲染、模拟速率每秒变化、最小化挂起、恢复全部通过。
- 未完成：真实 H153-381 的长期运行、PushPlus 实际送达延迟、长时间 CPU/内存与句柄增长趋势。不把本轮结果当作这些能力的证明。
- 备份：打包前 `backups/v0.3.1-before-change-20261008-184618-771`；发布后 `backups/v0.3.2-released-20261008-185059-627`，`manifest.status=complete`，源码384文件。
- 项目笔记已同步到 Notion：https://app.notion.com/p/3f3eb108f5ec8109bd57c260d5f713b3
- 本轮源码尚未提交到 Git。`origin` 指向原作者仓库，Fork 为 `baolongzhanshi/cpe-monitor`，推送前必须确认目标远程，禁止误推 `origin`。
- 用户数据、密钥、`.env`、备份与本地构建产物未上传。
