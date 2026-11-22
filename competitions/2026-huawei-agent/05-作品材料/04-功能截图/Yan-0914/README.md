# Yan-0914：功能截图

本目录接收 Yan-0914 负责任务的可公开真实截图和 Markdown 索引，随本人任务分支/PR 提交，无需另行私发。

1. 阶段实际完成时截图，检查隐私，必要时脱敏。
2. 命名为 `YYYY-MM-DD_Yan-0914_任务编号_两位序号_场景.png`（小写 png/jpg/jpeg/webp）。
3. 同目录索引记录图片链接、实际完整源码 SHA、真实环境/工具版本、结果与 SHA256。
4. 推当前 Draft PR；未实测写未测，敏感原件留 private，不伪造补图。

## 索引（TEAM-DESKTOP-01）

| 图片 | 场景 | 真实性 | 完整源码 SHA | 环境/工具版本 | 结果 | SHA256 |
|---|---|---|---|---|---|---|
| [01](2026-11-18_Yan-0914_TEAM-DESKTOP-01_01_ironrdp_gnome_classic_desktop.png) | IronRDP 解码的 GNOME Classic 桌面（1280×720） | 独立 IronRDP PoC 的真实帧；**不是 TDSF 内嵌窗口** | IronRDP `abfc97b299f04622cb7860f344a35bbea9bd4361`；TDSF PR58 `b681629` | Windows 11；rustc/cargo 1.100.0；MSVC 14.44.35207；CentOS 8.5 + xrdp 0.10.6.1 / xorgxrdp 0.10.5 | 顶栏、菜单、桌面图标、壁纸正常；无黑屏/花屏/偏色 | `486fa66fe0d05ad78bd98166d350f19cc96eef122c8687cdd27e5e9fc149f2b8` |
| [02](2026-11-18_Yan-0914_TEAM-DESKTOP-01_02_ironrdp_login_window.png) | xrdp 登录窗口（1280×720，Session=Xorg，用户名已填） | 独立 IronRDP PoC 的真实帧；**不是 TDSF 内嵌窗口** | 同上 | 同上 | 登录窗口正常；经 RDP 键盘注入后进入桌面 | `f80fe0754a400c8f82ac3a07b33c61df5843aecbe1f7c60b730d10629ee467a0` |

## 未测/待补

- TDSF 应用内嵌远程桌面窗口截图：`cargo build` 在本机 rustc 1.100 崩 `0xC0000409`，改用 1.94.0 构建中；未成功运行前**不补造**。
- 原生键鼠/中文输入、缩放/全屏、断线恢复未验证。

> 截图不是测试全绿的证明；功能截图与码道过程不重复放同一张图。