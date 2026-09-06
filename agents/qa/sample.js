// agents/qa/sample.js — 「质检」离线降级示例产物。
// sampleQA      : 正常 PASS。
// sampleQAReject: 演示「打回重拍」用——离线时设 FILM_DEMO_REJECT=1，第 1 轮质检用这条 REJECT，
//                 触发流水线回到分镜工位重拍，第 2 轮再 PASS，用于现场展示质检闭环。
export const sampleQA = `{
  "verdict": "PASS",
  "reasons": ["三幕齐全，与剧本一一对应", "frame 映射正确(1/2/3)", "沉睡→合闸→苏醒，情绪落点清晰"],
  "fixes": []
}`;

export const sampleQAReject = `{
  "verdict": "REJECT",
  "reasons": ["第2镜(总开关)缺少合闸前的张力铺垫，情绪转折太硬"],
  "fixes": ["给第2镜加一个更明确的动作节拍：手先停顿、再用力合闸", "把第2镜 seconds 从 4 提到 5，给合闸留呼吸"]
}`;
