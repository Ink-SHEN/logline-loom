// agents/qa/index.js — 「质检」Agent 的自包含入口。
export { QA } from './prompt.js';
export { sampleQA, sampleQAFail } from './sample.js';

export const meta = {
  name: '质检',
  slug: 'qa',
  role: '审生成视频是否符合技术规格与提示词意图，pass/fail 并给出可执行修改意见',
  promptExport: 'QA',
  sampleExport: 'sampleQA',
  contract: 'c06_qc_report',
};
