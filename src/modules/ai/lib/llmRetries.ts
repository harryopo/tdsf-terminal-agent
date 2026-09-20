/**
 * #82：浏览器侧 LLM 调用的重试只有一个数字可写。
 *
 * AI SDK 的 `generateText` / `streamText` 不传 `maxRetries` 时默认 **2**
 * （已核对 node_modules/ai 的 `prepareRetries`：只看调用点参数，不看 provider 设置），
 * 于是"一次点击"在 429 / 网络抖动的页面上会静默连打 3 个 POST。叠在
 * `strands_backend/retry_policy.py`（P3 收口的后端唯一退避主人）之外，
 * 这是第二个主人——而它以前没人管。
 *
 * 一律 0 而不是 1：这 6 个调用点全是**人在等着看结果**的交互路径
 * （生成提交信息、翻译兜底、编辑器补全、子 agent、SDK 兜底流）。
 * 转 8 秒再失败，比立刻报"失败了，再点一次"更诚实，也更省 token。
 * 需要重试语义的地方自己写（例：提交信息那条已经有"格式不对就修一次"的显式第二轮）。
 */
export const BROWSER_LLM_MAX_RETRIES = 0;
