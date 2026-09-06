// agents/screenwriter/index.js — 「①编剧」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent：人格(prompt) + 离线示例(sample) + LLM 接口(llm) + 可执行管线(run) + 元信息(meta)。
// CLI：node agents/screenwriter/run.js --logline "..."（详见 run.js --help）
export { AGENT_VERSION, SCREENWRITER } from './prompt.js';
export { sampleScript } from './sample.js';
export { chat, extractJson, llmConfig, LlmError } from './llm.js';
export { runScreenwriter } from './run.js';

export const meta = {
  name: '编剧',
  slug: 'screenwriter',
  role: '消费 c01_brief（logline 必填 + 主题/时长/画幅/视听风格/人物形象可选），产出 c02_screenplay：含场次（地点/时间/人物/beats）、情绪曲线、台词语言的完整剧本',
  promptExport: 'SCREENWRITER',
  sampleExport: 'sampleScript',
  contract: 'c02_screenplay', // 产出契约（agents/README.md 第二节要求的新增字段）
};
