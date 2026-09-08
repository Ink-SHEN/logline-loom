// agents/qa/llm.js — 「⑤质检」的 LLM 接口。
// 实现已并入 tools/agent.mjs（agents/README.md 第四节：共享调用管线落 tools/ 后去重）；
// 本文件保留为再导出薄壳，agents/qa/{run,index,vision}.js 的既有 import 不用动，⑤ 依旧自包含。
// 视觉通道用法：chat() 把 messages 原样 JSON 序列化后发出去，content 既可以是字符串
// （纯文本比对片约 red_lines），也可以是 OpenAI 视觉格式的分段数组
// （[{type:'text'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,...'}}]）——
// agents/qa/vision.js 抽帧后走后者，不需要为视觉另开一套客户端（说明在 tools/agent.mjs 的 chat() 注释里）。
export { chat, extractJson, llmConfig, LlmError } from '../../tools/agent.mjs';
