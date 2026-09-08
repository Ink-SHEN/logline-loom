// prompts.js — 根聚合入口：所有 Agent 人格（system prompt）都从这里再导出。
// agents/README.md 第三节「加一个新 Agent」第 2 步：建完 agents/<slug>/prompt.js 后，
// 在这里加一行 `export { XXX } from './agents/<slug>/prompt.js';`。
//
// 各文件的 AGENT_VERSION 常量同名，聚合时必须别名，否则后导入的会盖掉先导入的。
// ④生成 / ⑥重试 不调 LLM，没有 prompt.js（见 agents/README.md 第一节），故不在此列。
//
// 想改某个工位的脾气 / 风格：改 agents/<slug>/prompt.js（人格只归工位自己管），
// 根入口只是转发，别在这里改文案。每个导出都带该工位的产出契约，方便对照。

// ①编剧 —— 产出 c02_screenplay（强制人工关口之一）
export { AGENT_VERSION as SCREENWRITER_AGENT_VERSION, SCREENWRITER } from './agents/screenwriter/prompt.js';

// ②分镜 —— 产出 c03_shotlist
export { AGENT_VERSION as STORYBOARD_AGENT_VERSION, STORYBOARD } from './agents/storyboard/prompt.js';

// ③提示词 —— 产出 c04_gen_request
export { AGENT_VERSION as PROMPT_WRITER_AGENT_VERSION, PROMPT_WRITER } from './agents/prompt-writer/prompt.js';

// ⑤质检 —— 产出 c06_qc_report（另有两个按需追加的通道附录：纯文本比对红线 / 抽帧视觉复核）
export {
  AGENT_VERSION as QA_AGENT_VERSION,
  QA,
  QA_TEXT_ONLY_ADDENDUM,
  QA_VISION_ADDENDUM,
} from './agents/qa/prompt.js';

// ⑦剪辑 —— 产出 c07_edit_decision（强制人工关口之二）
export { AGENT_VERSION as EDITOR_AGENT_VERSION, EDITOR } from './agents/editor/prompt.js';
