export const meta = {
  name: 'dev-loop',
  description: '自主开发循环：规划→开发→验收，持续推进 backlog',
  phases: [
    { title: '规划', detail: '确认本轮任务' },
    { title: '开发', detail: '实施代码改动' },
    { title: '验收', detail: '门禁验证' },
  ],
}

const root = args.projectRoot
const MAX_ROUNDS = args.maxRounds ?? 1

for (let round = 1; round <= MAX_ROUNDS; round++) {
  log(`=== 第 ${round} 轮 ===`)
  phase('规划')
  let plan
  if (args.firstTask) {
    plan = `本轮任务（主 agent 指定）：${args.firstTask}`
  } else {
    plan = await agent(
      `你是规划 agent。项目根: ${root}。\n` +
      `读 docs/dev-state.md 末尾 backlog，选 1 个范围清晰的小任务（排除大特性：Headroom/OPENDEV/compaction/asciicast）。` +
      `输出格式：任务名 | 目标文件 | 实施要点(3-5条) | 验收标准。不要写代码。`,
      { label: `规划-${round}`, phase: '规划' }
    )
  }
  log(plan)

  phase('开发')
  const impl = await agent(
    `你是开发 agent。项目根: ${root}。\n任务：\n${plan}\n` +
    `高效执行规则（避免浪费时间）：\n` +
    `- 直接读任务指定的目标文件（先 Read 再看是否需改），不要全局探索代码库\n` +
    `- 改动最小化，遵循现有代码风格与注释习惯\n` +
    `- 改完跑针对性验证：cd ${root}/src-tauri/sidecar && python -m pytest strands_backend/tests/test_tools.py -q\n` +
    `- 不要跑全量门禁，不要 git commit\n` +
    `- 输出：改动文件清单 + 摘要 + 针对性验证结果`,
    { label: `开发-${round}`, phase: '开发' }
  )
  log(impl)

  phase('验收')
  const verdict = await agent(
    `你是验收 agent。项目根: ${root}。\n开发 agent 报告：\n${impl}\n` +
    `独立验收：\n` +
    `1) cd ${root}/src-tauri/sidecar && python -m pytest -q\n` +
    `2) cd ${root} && pnpm typecheck\n` +
    `如实逐项报告通过/失败+错误摘要；失败给修复建议。不要改代码、不要 commit。`,
    { label: `验收-${round}`, phase: '验收' }
  )
  log(verdict)
}
