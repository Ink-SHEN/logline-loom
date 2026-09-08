// tools/samples.js — 根聚合入口：所有 Agent 的离线示例产物（sample）都从这里再导出。
// agents/README.md 第三节「加一个新 Agent」第 3 步：建完 agents/<slug>/sample.js 后，
// 在这里加一行 `export { sampleXxx } from '../agents/<slug>/sample.js';`。
//
// 每个示例都是该 Agent 输出契约的**活文档**（同时是 SDK / 鉴权不可用时的离线降级物）。
// 需要 mock 某一道交接面 / 校验自己消费的形状时，从这里取，别去 agents/ 深处翻。
// 契约对应关系（导出名 → 契约）见 agents/*/index.js 的 meta.contract，本站不重复声明。

// ①编剧 c02_screenplay
export { sampleScript } from '../agents/screenwriter/sample.js';

// ②分镜 c03_shotlist
export { sampleShotList } from '../agents/storyboard/sample.js';

// ③提示词 c04_gen_request
export { sampleGenRequest } from '../agents/prompt-writer/sample.js';

// ④生成 c05_gen_result（有音轨 / 无音轨两个分支）
export { sampleGenResult, sampleGenResultNoAudio } from '../agents/generator/sample.js';

// ⑤质检 c06_qc_report（pass / fail 两个分支——⑥⑦ 都要 mock 这两种分支）
export { sampleQA, sampleQAFail } from '../agents/qa/sample.js';

// ⑥重试 新的 c04_gen_request（普通 / 提分辨率两个分支）
export { sampleRetryRequest, sampleRetryRequestRescale } from '../agents/retry/sample.js';

// ⑦剪辑 c07_edit_decision
export { sampleEditDecision } from '../agents/editor/sample.js';
