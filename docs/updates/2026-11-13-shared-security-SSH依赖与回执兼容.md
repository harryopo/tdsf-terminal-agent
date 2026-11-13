# 共享候选：SSH 安全依赖与回执兼容

日期：2026-11-13。范围仅本次审查分支，尚未合并 main，不是安装包验收记录。

复核此前独立安全候选后，将 russh 0.64.1 更新至 0.65.1、Pageant 0.2.4 更新至 0.2.5，保留 ring 和原 feature 边界。只移植这份候选的两项依赖及必要锁边，不覆盖其原工作区，也不以依赖图通过冒称编译/真实SSH已验收。[russh 上游发布说明](https://github.com/Eugeny/russh/releases/tag/v0.65.1)

ZIP 告警按实际目标核对：当前 Windows MSVC、Linux GNU、macOS ARM 的锁定依赖图均无 zip 反向链；全 target 合并图仍能显示可选依赖，不可混为实际构建。告警继续保留。CI 增加 Windows normal/build 图检查，防止重新启用已禁用的 ZIP 更新路径；明确开启可选 zip 的对照应被检查拒绝。

上游 updater 2.14.1 可升级 zip，但要求 Tauri ^2.12 并连带更新桌面运行时；已保存试算候选另做兼容专项，不混入本次窄补丁，不声称锁文件告警已经消失。[updater 发布说明](https://github.com/tauri-apps/plugins-workspace/releases/tag/updater-v2.14.1)

首轮远端 macOS CI 发现旧 Bash 的高位字节可能按有符号整数格式化，导致中文目录 URI 错误。编码前将字节归一到0–255，新增可注入有符号序数的实际 Bash 回归，并先验证模拟确实产生负值。数组 PROMPT_COMMAND 的用例按既有实现要求使用 GNU Bash 5.1+，macOS CI 显式安装对应 Bash；原顺序断言不删、不跳过，不宣称旧 Bash 新增了数组提示符能力。

本地 Git Bash 启动受宿主权限错误阻断，不能把该探针失败当作功能RED，亦未据此改权限；Rust编译、回环及上述新用例以本次提交的后续 CI 为准。没有连接真实服务器、调用付费模型或改变安全审批策略。
