// agents/storyboard/index.js — 「分镜」Agent 的自包含入口。
export { STORYBOARD } from './prompt.js';
export { sampleStoryboard } from './sample.js';

export const meta = {
  name: '分镜',
  slug: 'storyboard',
  role: '把剧本拆成可拍摄镜头 JSON；可依据质检意见重拍',
  promptExport: 'STORYBOARD',
  sampleExport: 'sampleStoryboard',
};
