// agents/retry/index.js — 「⑥重试」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent。这一站不调 LLM（promptExport: null），也没有 prompt.js：
// ⑥ 的活儿是把上一份 c04 深拷贝、按 c06 的判定打一个白名单补丁，一行创意文本都不写，
// 没有「人格」可言。是否调用模型是实现细节，不是判断「算不算一个 Agent」的依据
//（见 agents/README.md 第一节）。
// 本站只有一个模块 run.js——不像 ④ 要分 ComfyUI 客户端 / 填图 / ffprobe，
// 也不像 ⑤ 要分 LLM 接口 / 抽帧通道：⑥ 全部的工作就是读 JSON、改 JSON、写 JSON、校验 JSON。
// CLI：node agents/retry/run.js --qc <c06 目录> --requests <上一批 c04 目录> [选项]（详见 run.js --help）
export { AGENT_VERSION, AGENT_NAME, runRetry } from './run.js';
export { sampleRetryRequest, sampleRetryRequestRescale } from './sample.js';

export const meta = {
  name: '重试',
  slug: 'retry',
  role: '消费 c06_qc_report 的 fail 分支（route_to="retry"），把上一份 c04 深拷贝后打白名单补丁，逐份产出新的 c04_gen_request 交回 ④生成。是打补丁不是重写：workflow.node_ids、api_json、assets 素材位与提示词正文原样沿用。三条铁律——不覆盖（候选号取已有最大号 +1）、不重样（seed 与 filename_prefix 必须同时换掉，否则 ComfyUI 直接返回缓存的旧产物、还会盖掉旧归档）、不越权（可改的只有 seed / duration_seconds / megapixels / prompt / turbo_enabled；steps 不在其中，它由 turbo_enabled 派生，④生成 会硬卡两者自洽）。白名单里的键还各归一个动作管，action 与 patch 归属对不上就打回 ⑤质检 重开。越权的动作按 PATCH_OWNER 打回上游工位或写进 needs_human.md 转人工；retry_count 达 max_retries 就停手，防无限烧 GPU',
  promptExport: null, // ⑥重试 不调 LLM，没有人格可导出
  sampleExport: 'sampleRetryRequest',
  contract: 'c04_gen_request', // 与 ③提示词 同一道契约：⑥ 是把流程退回 ④，不是新开一道交接面
};
