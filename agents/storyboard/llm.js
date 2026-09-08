// agents/storyboard/llm.js — 「②分镜」的 LLM 接口。
// 实现已并入 tools/agent.mjs（agents/README.md 第四节：共享调用管线落 tools/ 后去重）；
// 本文件保留为再导出薄壳，agents/storyboard/{run,index}.js 的既有 import 不用动，② 依旧自包含。
export { chat, extractJson, llmConfig, LlmError } from '../../tools/agent.mjs';
