// agents/qa/index.js — 「质检」Agent 的自包含入口。
export { QA } from './prompt.js';
export { sampleQA, sampleQAReject } from './sample.js';

export const meta = {
  name: '质检',
  slug: 'qa',
  role: '审分镜是否忠实剧本/有电影感，PASS 或 REJECT(带可执行修改意见)',
  promptExport: 'QA',
  sampleExport: 'sampleQA',
};
