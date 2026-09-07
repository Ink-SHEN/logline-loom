// agents/qa/index.js — 「⑤质检」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent：人格(prompt) + 示例产物(sample) + 复核侧清单示例(sample_review.json)
// + LLM 接口(llm) + 抽帧视觉通道(vision) + 可执行管线(run) + 元信息(meta)。
// 本站没有 ffprobe.js：重测只需要一次 spawnSync + 一次 JSON.parse，写在 run.js 里就够了。
// 与 agents/generator/ffprobe.js 的重复是故意的——那份要负责「没装 ffprobe 怎么把话说清楚」并硬阻塞，
// 这份要在缺 ffprobe 时降级采信 c05 并大声告警，两者的失败语义相反，合不成一个模块。
// CLI：node agents/qa/run.js --candidates S001_c01,S001_c02 [选项]（详见 run.js --help）
export { AGENT_VERSION, QA, QA_TEXT_ONLY_ADDENDUM, QA_VISION_ADDENDUM } from './prompt.js';
export { sampleQA, sampleQAFail } from './sample.js';
export { chat, extractJson, llmConfig, LlmError } from './llm.js';
export { describeFrames, extractFrames, findFfmpeg, framesToContent, VisionError } from './vision.js';
export { AGENT_NAME, runQa } from './run.js';

export const meta = {
  name: '质检',
  slug: 'qa',
  role: '消费 c05_gen_result（+ c04 作比对基准），逐候选产出 c06_qc_report。客观 6 项由 ffprobe 实测值 + 代码硬判，模型不参与；主观 7 项只认三个来源（--review 侧清单 > --vision 抽帧 + 视觉模型 > skipped 未复核），判不了的按 --on-unreviewed 转人工而不是伪装成 pass。先按 c05.output.path 原样定位产物、校 sha256、有 ffprobe 就重测对账，证据链断了拒绝出结论。route_to 决定分流：retry 回 ⑥、edit 进 ⑦、human 转人工',
  promptExport: 'QA',
  sampleExport: 'sampleQA',
  contract: 'c06_qc_report', // 产出契约（agents/README.md 第二节要求的新增字段）
};
