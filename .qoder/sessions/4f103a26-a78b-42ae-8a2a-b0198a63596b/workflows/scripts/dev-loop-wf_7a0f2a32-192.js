export const meta = {
  name: 'dev-loop',
  description: '自主开发循环：规划→开发→验收，持续推进 backlog',
  phases: [
    { title: '规划', detail: '分析 backlog 确定本轮任务' },
    { title: '开发', detail: '实施代码改动' },
    { title: '验收', detail: '门禁验证' },
  ],
}

const root = args.projectRoot
const MAX_ROUNDS = args.maxRounds ?? 2

for (let round = 1; round <= MAX_ROUNDS; round++) {
  log(`=== 第 ${round} 轮 ===`)
  phase('规划')
  let plan
  if (round === 1 && args.firstTask) {
    plan = `本轮任务（由主 agent 指定）：${args.firstTask}\n实施要点：读评估报告确认 yaml 模板；对照现有 ci.yml 风格合并；Python 作业需 pip install -r requirements.txt + pytest -q；注意 Windows 环境 vs CI ubuntu 差异。`
  } else {
    plan = await agent(
      `你是规划 agent。项目根: ${root}。\n` +
      `读 docs/dev-state.md 末尾 §37 的下一步 backlog（及 §35.3 任务表），` +
      `从剩余待办中选出 1 个适合本轮实施的、范围清晰的任务（避开需要用户决策的大特性）。` +
      `输出格式：任务名 | 目标文件 | 实施要点(3-5条) | 验收标准。不要写代码。`,
      { label: `规划-${round}`, phase: '规划' }
    )
  }
  log(plan)

  phase('开发')
  const impl = await agent(
    `你是开发 agent。项目根: ${root}。\n规划结论：\n${plan}\n` +
    `实施该任务。硬性规则：\n` +
    `- 先读项目 CLAUDE.md 了解规范（五绿门禁/防污染红线），再动手\n` +
    `- 只改任务相关文件；改动要最小、专业\n` +
    `- 涉及 Python 时：cd ${root}/src-tauri/sidecar 跑 python -m pytest tests/test_xxx.py 针对性验证\n` +
    `- 涉及前端时：cd ${root} 跑 pnpm typecheck\n` +
    `- 不要跑全量门禁（验收 agent 负责），不要 git commit\n` +
    `- 结束时输出：改动文件清单 + 每个文件的改动摘要 + 针对性验证结果`,
    { label: `开发-${round}`, phase: '开发' }
  )
  log(impl)

  phase('验收')
  const verdict = await agent(
    `你是验收 agent。项目根: ${root}。\n开发 agent 报告：\n${impl}\n` +
    `独立运行验收（按改动涉及面选择，涉及就跑）：\n` +
    `1) cd ${root}/src-tauri/sidecar && python -m pytest -q\n` +
    `2) cd ${root} && pnpm typecheck\n` +
    `3) cd ${root} && pnpm lint\n` +
    `4) cd ${root} && pnpm test（vitest）\n` +
    `5) cd ${root}/src-tauri && cargo check（若涉及 Rust）\n` +
    `如实逐项报告：通过/失败 + 失败的错误摘要。失败时给出具体修复建议（文件+原因）。` +
    `不要修改代码，不要 git commit。`,
    { label: `验收-${round}`, phase: '验收' }
  )
  log(verdict)
}
