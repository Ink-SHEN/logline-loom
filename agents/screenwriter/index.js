// agents/screenwriter/index.js — 「编剧」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent：人格(prompt) + 离线示例(sample) + 元信息(meta)。
export { SCREENWRITER } from './prompt.js';
export { sampleScript } from './sample.js';

export const meta = {
  name: '编剧',
  slug: 'screenwriter',
  role: '把一句话前提(premise)扩写成 3 幕科幻短片剧本 JSON',
  promptExport: 'SCREENWRITER',
  sampleExport: 'sampleScript',
};
