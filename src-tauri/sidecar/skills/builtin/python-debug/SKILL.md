---
name: python-debug
description: Python 调试 Skill，覆盖 Traceback 阅读、pdb 断点、logging 规范、虚拟环境与 pip 依赖冲突排查
version: 2.0.0
author: TDSF
tags: [python, debug, pdb, logging, venv, pip]
# TDSF 魔改 (P0-2 修复 2026-07-28): executor 让 Skill 真正可执行
# python -c 打印解释器路径与版本 = Python 环境排障第一命令:
# 确认"跑的是哪个 Python"是 ModuleNotFoundError / 依赖错乱排查的起点.
executor:
  type: shell
  command: 'python -c "import sys; print(sys.executable); print(sys.version)"'
  timeout: 10
  description: "打印当前解释器路径与版本. venv 问题先看这条: 路径不在项目 .venv 内说明虚拟环境没激活."
---

# Python 调试 Skill

## When to use

- 用户报告 Python 脚本抛异常 / 打印 **Traceback** 需要定位原因
- 用户遇到 ModuleNotFoundError / ImportError 依赖问题
- 用户需要 pdb 断点调试（单步/查变量/事后调试）
- 用户需要排查虚拟环境未激活 / 包版本冲突
- 用户需要用 logging 替代 print 做规范日志
- 需要快速性能分析（cProfile / timeit）

触发关键词：python / pip / venv / virtualenv / traceback / exception / pdb / breakpoint / ModuleNotFoundError / ImportError / logging / 依赖冲突 / 虚拟环境

## 核心概念

- **Traceback 结构**：从 `Traceback (most recent call last):` 开始向下读，**最下面一帧就是出错点**——每帧一行 `File "文件", line 行号, in 函数`，最后异常类型 + 消息（如 `KeyError: 'email'`）。
- **虚拟环境（venv）**：每项目独立一套 site-packages，避免"项目 A 要 Django 3、项目 B 要 Django 4"的冲突；激活后 `python`/`pip` 都指向 `.venv` 内的解释器。
- **sys.path**：模块搜索路径列表；`import` 找不到包 99% 是"装到了另一个解释器"或"跑的不是你以为的那个解释器"——一切从 `sys.executable` 确认起。
- **pdb 断点**：Python 3.7+ 内置 `breakpoint()` 一行插入断点；`python -m pdb script.py` 从头单步调试。
- **logging**：标准库日志框架，五级 DEBUG/INFO/WARNING/ERROR/CRITICAL，可输出到文件/控制台并带时间戳——比 print 的优势：可分级开关、可落盘、可带调用位置。
- **pip 的解释器绑定**：`pip install` 装进"当前 python 对应的环境"；venv 未激活时容易装到全局——用 `python -m pip install` 显式绑定更稳。

## 常用命令速查

### 环境确认与依赖管理

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `python -c "import sys; print(sys.executable)"` | 确认当前解释器路径 | 排障第一步 |
| `python -m pip list` | 列出已装包及版本 | `\| grep requests` 过滤 |
| `python -m pip show <pkg>` | 查看包版本/位置/依赖 | `-f` 列出文件 |
| `python -m pip check` | 检测依赖版本冲突 | 无输出=健康 |
| `python -m pip install requests==2.32.3` | 安装并固定版本 | `-U` 升级、`-r requirements.txt` 批量 |
| `python -m pip freeze > requirements.txt` | 导出依赖清单 | 配合 venv 复现环境 |
| `python -m venv .venv` | 创建虚拟环境 | `--clear` 重置 |
| `source .venv/bin/activate` | 激活（Linux/macOS） | Windows: `.venv\Scripts\activate` |

### 调试与日志

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `python -i script.py` | 运行后进入交互 REPL（变量还在） | 脚本崩了也能查现场 |
| `python -m pdb script.py` | 从头单步调试 | `-c continue` 直接跑到首个异常 |
| `breakpoint()` | 代码内插断点（3.7+） | 环境变量 PYTHONBREAKPOINT=0 可全局禁用 |
| `python -m cProfile -o prof.out script.py` | 性能采样 | 配合 pstats 分析 |
| `python -m timeit -n 1000 "sum(range(100))"` | 微基准测耗时 | `-r 5` 重复轮次 |
| `logging.basicConfig(level=logging.DEBUG, filename="app.log")` | 最小日志配置 | `format=` 定制格式 |

## Steps

**场景 1：Traceback 分析与定位（标准动作）**

```
1. 从异常行往回读: 最后一帧 File/line/in 就是出错点
2. 读异常类型+消息:
   - ModuleNotFoundError: No module named 'x' → 转场景 2
   - KeyError/AttributeError → 对象内容与预期不符 → pdb 查现场
   - TypeError: ... missing 1 required positional argument → 调用签名不匹配
3. 需要看现场变量: 在出错行前插 breakpoint() → python script.py
4. (Pdb) p <变量> / p locals().keys() / l 看上下文代码 → 找出根因 → 修复
```

**场景 2：ModuleNotFoundError（依赖问题，最高频）**

```
1. python -c "import sys; print(sys.executable)" → 确认跑的是哪个解释器
2. 路径不在项目 .venv 内 → 虚拟环境没激活 → source .venv/bin/activate 后重跑
3. python -m pip list | grep <pkg> → 装没装; 不在 → python -m pip install <pkg>
4. 装了仍报错 → python -m pip show <pkg> 看 Location 是否与 sys.executable 同环境
5. 版本冲突 → python -m pip check → 按输出升级/固定冲突包版本
```

**场景 3：用 logging 替代 print（脚本要长期跑时）**

```
1. 脚本头部:
   import logging
   logging.basicConfig(level=logging.DEBUG,
       format="%(asctime)s %(levelname)s %(name)s %(message)s")
2. 分级打点: logging.debug(变量细节) / .info(流程) / .warning(可恢复异常, 附原因) / .error(失败)
3. 落盘: basicConfig(filename="app.log") → tail -f app.log 实时观察
4. 禁 print 调试残留: grep -n "print(" script.py 逐个替换或删除
```

## Examples

### 示例 1：ModuleNotFoundError（venv 未激活）

```
用户: 运行脚本报 ModuleNotFoundError: No module named 'requests'
Agent:
  1. python -c "import sys; print(sys.executable)" → "/usr/bin/python3"（系统解释器, 非 .venv）
  2. source .venv/bin/activate → which python → ".venv/bin/python"
  3. python -m pip list | grep requests → 已装 → 重跑脚本成功
```

### 示例 2：pdb 定位 KeyError

```
用户: 脚本第 50 行附近莫名报错，要看变量
Agent:
  1. 在第 49 行插入 breakpoint()
  2. python script.py → (Pdb) p user_data → {'name': 'Alice'}
  3. (Pdb) p user_data.get('email') → None → 根因: 数据缺 email 字段
  4. (Pdb) c 继续退出 → 改用 user_data.get('email', '未知') → 重跑成功
```

### 示例 3：依赖冲突

```
用户: pip install 包 A 后包 B 报 ImportError
Agent:
  1. python -m pip check → "pkg-a 2.0 requires pkg-b>=3.0, but you have pkg-b 2.1"
  2. python -m pip show pkg-a → Requires: pkg-b (>=3.0)
  3. risk: python -m pip install "pkg-b>=3.0" → L2 → 执行
  4. python -m pip check → 无输出（健康）→ 脚本重跑通过
```

## 易错点

- **pip 装错环境**：venv 未激活时 `pip install` 装进全局 Python——一律用 `python -m pip install`（跟随当前 python），装前先 `sys.executable` 确认。
- **print 调试残留**：临时代码进生产既刷屏又无时间戳——长期运行的脚本用 logging（可分级、可落盘、可关闭）。
- **`except: pass` 吞异常**：错误被静默吃掉，故障无从排查——至少 `except Exception as e: logging.warning(f"... fallback: {e}")`。
- **不固定版本**：`pip install requests` 拉最新版，半年后重装环境行为变了——用 `pip freeze > requirements.txt` 锁定，装时带 `==` 版本号。
- **Windows/Linux 激活路径不同**：Windows 是 `.venv\Scripts\activate`（PowerShell 用 `Activate.ps1`），Linux 是 `source .venv/bin/activate`——教学环境两套都要会。
- **事后调试姿势**：脚本崩了想进 pdb 查现场，用 `python -m pdb -c continue script.py`（跑到首个未捕获异常停住），而不是靠改代码打 print。

## 验证方法

- 环境：`python -c "import sys; print(sys.executable)"` 指向预期解释器；`python -m pip check` 无冲突输出。
- 脚本：`python script.py` 退出码 0（`echo $?`）且输出符合预期。
- pdb：断点处 `p <var>` 取到的值与预期一致，`c` 后流程按修复后逻辑走完。
- 日志：`tail -f app.log` 能看到分级日志且格式含时间戳；重放故障场景日志中留下 WARNING/ERROR 及原因。

## 参考

- pdb 官方文档：https://docs.python.org/3/library/pdb.html
- logging 官方教程（Logging HOWTO）：https://docs.python.org/3/howto/logging.html
- venv 官方文档：https://docs.python.org/3/library/venv.html
- pip 官方文档：https://pip.pypa.io/en/stable/
- cProfile 性能分析官方文档：https://docs.python.org/3/library/profile.html
