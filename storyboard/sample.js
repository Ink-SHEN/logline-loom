// agents/storyboard/sample.js — 「分镜」离线降级示例产物。
// 当 Qoder SDK / 鉴权不可用时使用；同时是分镜输出 JSON 格式的「活文档」。
export const sampleStoryboard = `{
  "shots": [
    { "id": 1, "frame": 1, "shotType": "大远景 · 缓推", "visual": "沉睡的空中都市，漆黑、寂静，雾气缓缓流动", "caption": "它已经很久没有醒来。", "sfx": "低频风声", "seconds": 4 },
    { "id": 2, "frame": 2, "shotType": "特写 · 固定", "visual": "戴手套的手握住总闸，缓缓向下合闸", "caption": "直到有人按下那个开关。", "sfx": "金属合闸 · 电流起", "seconds": 4 },
    { "id": 3, "frame": 3, "shotType": "大远景 · 升镜头", "visual": "城市骤然亮起，金光自塔楼间涌出，航道流光穿梭", "caption": "于是，整座城重新发光。", "sfx": "能量涌动渐强 → 定音", "seconds": 5 }
  ]
}`;
