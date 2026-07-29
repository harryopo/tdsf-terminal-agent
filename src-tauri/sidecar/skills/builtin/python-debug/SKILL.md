---
name: python-debug
description: Python 调试 Skill，处理异常追踪、pdb 调试、性能分析、虚拟环境、依赖冲突等问题
version: 1.1.0
author: TDSF
tags: [python, debug, pdb, profiling, venv, pip]
# TDSF 魔改 (P0-2 修复 2026-07-28): 添加 executor 字段, 让 Skill 真正可执行
# 默认打印当前 Python 环境信息 (解释器路径/版本/sys.path/已安装的关键包).
# 用户在输入框可填模块名（如 requests）作为 input, 自动检测该模块是否安装及版本.
executor:
  type: python
  timeout: 10
  description: "诊断当前 Python 环境：解释器路径、版本、sys.path、pip list 摘要. 输入框填模块名（如 'requests'）可查询该模块版本."
  script: |
    import sys, os, json
    info = {
        "executable": sys.executable,
        "version": sys.version,
        "platform": sys.platform,
        "path_first_5": sys.path[:5],
    }
    if input_data:
        # 查询指定模块
        try:
            mod = __import__(input_data)
            info["query_module"] = input_data
            info["query_version"] = getattr(mod, "__version__", "unknown")
            info["query_file"] = getattr(mod, "__file__", "builtin")
        except Exception as e:
            info["query_module"] = input_data
            info["query_error"] = f"{type(e).__name__}: {e}"
    print(json.dumps(info, ensure_ascii=False, indent=2))
---

# Python 调试 Skill

## When to use

- 用户报告 Python 脚本抛出异常 / Traceback
- 用户需要使用 pdb / ipdb 断点调试
- 用户需要性能分析（ cProfile / timeit / py-spy ）
- 用户遇到 ModuleNotFoundError / ImportError 依赖问题
- 用户需要排查虚拟环境冲突 / 包版本不兼容
- 用户需要内存分析（ tracemalloc / objgraph ）

触发关键词：python / pip / venv / virtualenv / poetry / traceback / exception / pdb / ipdb / cProfile / profile / ModuleNotFoundError / ImportError

## Steps

1. **风险评估**：
   - `pip uninstall -y <pkg>` → L3（移除依赖可能影响其他包）
   - `pip install --upgrade` → L2（可能引入不兼容变更）
   - `python -m pip install <pkg>` → L1（仅安装）
   - `python <script>.py` / `python -c "..."` → L1（执行用户代码）
   - `python -m pdb` / `python -m cProfile` → L1（只读分析）

2. **Traceback 分析**：
   - 提取完整 Traceback（从 `Traceback (most recent call last):` 开始）
   - 定位最后一个 `File "xxx", line N, in <module>` 帧
   - 提取异常类型 + 消息（如 `ModuleNotFoundError: No module named 'requests'`）
   - 查询异常类型对应的常见原因 + 修复方案

3. **依赖诊断**：
   - `python -c "import sys; print(sys.executable)"` → 确认当前解释器
   - `python -c "import sys; print(sys.path)"` → 检查模块搜索路径
   - `pip list` / `pip show <pkg>` → 查看已安装包 + 版本
   - `pip check` → 检测依赖冲突
   - `python -m pipdeptree` → 包依赖树（需安装 pipdeptree）

4. **虚拟环境管理**：
   - `python -m venv .venv` → 创建虚拟环境
   - `source .venv/bin/activate`（Linux） / `.venv\Scripts\activate`（Windows）
   - `which python` / `where python` → 确认激活成功
   - `deactivate` → 退出虚拟环境
   - `pip install -r requirements.txt` → 安装依赖

5. **pdb 断点调试**：
   - 在代码中插入 `breakpoint()`（Python 3.7+）
   - `python -m pdb <script>.py` → 从头调试
   - 常用命令：`n`（next）、`s`（step）、`c`（continue）、`p <var>`（print）、`l`（list）、`b <line>`（break）、`q`（quit）
   - 事后调试：`python -m pdb -c continue <script>.py`（异常时进入 pdb）

6. **性能分析**：
   - `python -m cProfile -o profile.out <script>.py` → 生成 profile
   - `python -c "import pstats; pstats.Stats('profile.out').sort_stats('cumulative').print_stats(20)"` → 查看 top 20
   - `python -m timeit -n 1000 -r 5 "<code>"` → 微基准测试
   - `py-spy record -o profile.svg --pid <pid>` → 火焰图（需安装 py-spy）

7. **内存分析**：
   - 在代码中插入：
     ```python
     import tracemalloc
     tracemalloc.start()
     # ... 业务代码 ...
     snapshot = tracemalloc.take_snapshot()
     for stat in snapshot.statistics('lineno')[:10]:
         print(stat)
     ```
   - `python -c "import objgraph; objgraph.show_most_common_types()"` → 对象类型统计

## Examples

### 示例 1：ModuleNotFoundError

```
用户: 运行脚本报 ModuleNotFoundError: No module named 'requests'
Agent:
  1. python -c "import sys; print(sys.executable)" → "/usr/bin/python3"（非虚拟环境）
  2. pip list | grep requests → 无输出（未安装）
  3. risk: pip install requests → L1
  4. pip install requests
  5. python <script>.py → 运行成功
```

### 示例 2：依赖冲突

```
用户: pip install 包 A 后包 B 报 ImportError
Agent:
  1. pip check → "pkg-a 1.0 requires pkg-b>=2.0, but you have pkg-b 1.0"
  2. pip show pkg-a → "Requires: pkg-b (>=2.0)"
  3. pip show pkg-b → "Version: 1.0"
  4. risk: pip install --upgrade pkg-b → L2
  5. pip install --upgrade pkg-b
  6. pip check → "No broken requirements found"
  7. python <script>.py → 成功
```

### 示例 3：pdb 断点调试

```
用户: 脚本在第 50 行报错，需要查看变量值
Agent:
  1. 在第 50 行前插入 breakpoint()
  2. python <script>.py
  3. (Pdb) p user_data  → {'name': 'Alice', 'age': 30}
  4. (Pdb) p user_data['email']  → KeyError: 'email'  ← 找到根因
  5. 修复代码：user_data.get('email', 'unknown')
  6. (Pdb) c  → 继续执行
  7. 运行成功
```

### 示例 4：性能分析

```
用户: 脚本运行 30s 太慢，需要优化
Agent:
  1. python -m cProfile -o profile.out <script>.py
  2. python -c "import pstats; pstats.Stats('profile.out').sort_stats('cumulative').print_stats(10)"
  3. 输出 top 10 函数：
     - process_data: 25.2s (4000 次调用)
     - json.loads: 4.5s (50000 次调用)
     - re.match: 0.3s (50000 次调用)
  4. 分析：process_data 调用次数过多，需批处理
  5. 优化后重新 profile → 5.2s（5 倍加速）
```

### 示例 5：虚拟环境隔离

```
用户: 项目 A 依赖 Django 3，项目 B 依赖 Django 4，互相冲突
Agent:
  1. cd ~/project_a && python -m venv .venv
  2. source .venv/bin/activate
  3. pip install django==3.2
  4. cd ~/project_b && python -m venv .venv
  5. source .venv/bin/activate
  6. pip install django==4.2
  7. 两项目独立运行，互不影响
```
