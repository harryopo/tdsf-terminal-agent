# 远程桌面调研

先读[ROOT来源初核与待证事项](2026-11-17-ROOT-来源初核与待证事项.md)，再按[正式方案](../../plans/remote-desktop/README.md)完成深入开源代码/构建/可行性研究。后续按日期/主题新增报告，写清具体commit、证据、实测与未知，不把源码自述当本项目实现。

## 报告索引

- 2026-11-18 [Yan-0914：远程桌面开源调研与可行性初核](2026-11-18-Yan-0914-远程桌面开源调研与可行性初核.md)：IronRDP/noVNC 静态核验（HEAD/许可/MSRV/接入点）。
- 2026-11-18 [Yan-0914：G1 服务端实测与环境问题](2026-11-18-Yan-0914-G1-服务端实测与环境问题.md)：CentOS 8.5 + xrdp/xorgxrdp 经 SSH 隧道由 mstsc 看到 GNOME Classic 桌面；IronRDP 客户端已实测连接并解出桌面帧；1 vCPU soft lockup、加速检查 segfault、版本不匹配待处理。