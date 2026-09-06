// agents/storyboard/index.js — 「②分镜」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent：人格(prompt) + 离线示例(sample) + LLM 接口(llm) + 可执行管线(run) + 元信息(meta)。
// CLI：node agents/storyboard/run.js --screenplay artifacts/screenplay_xxx.json（详见 run.js --help）
export { AGENT_VERSION, STORYBOARD } from './prompt.js';
export { sampleShotList } from './sample.js';
export { chat, extractJson, llmConfig, LlmError } from './llm.js';
export { runStoryboard } from './run.js';

export const meta = {
  name: '分镜',
  slug: 'storyboard',
  role: '消费 c02_screenplay（剧本确认关口 approved 后才开工），把 beats 拆成 c03_shotlist：镜号/秒数/画幅/景别/运镜/画面描述/声音描述/工作流类型(T2V|I2V|R2V)，并按 FL2VA / Ref2VA 分批生成 GPU 排班计划',
  promptExport: 'STORYBOARD',
  sampleExport: 'sampleShotList',
  contract: 'c03_shotlist', // 产出契约（agents/README.md 第二节要求的新增字段）
};
