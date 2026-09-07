// agents/editor/index.js — 「⑦剪辑」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent：人格(prompt) + 离线示例(sample) + 字幕侧清单示例(sample_subtitles.json)
// + LLM 接口(llm) + 可执行管线(run) + 元信息(meta)。
// CLI：node agents/editor/run.js --qc artifacts/qc_<时间戳>/ [选项]（详见 run.js --help）
export { AGENT_VERSION, EDITOR } from './prompt.js';
export { sampleEditDecision } from './sample.js';
export { chat, extractJson, llmConfig, LlmError } from './llm.js';
export { runEditor } from './run.js';

export const meta = {
  name: '剪辑',
  slug: 'editor',
  role: '消费 c06_qc_report(pass)，每镜按分数选定候选、原样取 c05 的 output.path 作 source_path、按 c03 顺序排时间线，配人工字幕侧清单，产出 c07_edit_decision（入出点/转场/混音/字幕/AI 标识/合规自查）；c07 是强制人工关口，gate 留 pending 不自批',
  promptExport: 'EDITOR',
  sampleExport: 'sampleEditDecision',
  contract: 'c07_edit_decision', // 产出契约（agents/README.md 第二节要求的新增字段）
};
