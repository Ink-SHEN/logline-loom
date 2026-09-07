// agents/prompt-writer/index.js — 「③提示词」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent：人格(prompt) + 离线示例(sample) + 素材清单示例(sample_assets.json)
// + LLM 接口(llm) + 可执行管线(run) + 元信息(meta)。
// CLI：node agents/prompt-writer/run.js --shotlist artifacts/shotlist_xxx.json --assets ...（详见 run.js --help）
export { AGENT_VERSION, PROMPT_WRITER } from './prompt.js';
export { sampleGenRequest } from './sample.js';
export { chat, extractJson, llmConfig, LlmError } from './llm.js';
export { runPromptWriter } from './run.js';

export const meta = {
  name: '提示词',
  slug: 'prompt-writer',
  role: '消费 c03_shotlist，把每镜的景别/运镜/画面/声音描述译成英文提示词 + 时间码 + <Picture N> 引用，与节点 ID 映射（查 workflows/node_id_map.json）、seed、时长、画幅、megapixels、输出前缀、素材位一起，按镜头×候选逐份产出 c04_gen_request',
  promptExport: 'PROMPT_WRITER',
  sampleExport: 'sampleGenRequest',
  contract: 'c04_gen_request', // 产出契约（agents/README.md 第二节要求的新增字段）
};
