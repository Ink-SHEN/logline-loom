// agents/screenwriter/sample.js — 「编剧」离线降级示例产物。
// 当 Qoder SDK / 鉴权不可用时，runAgent 返回它，保证流水线照常出片；
// 它同时是编剧输出 JSON 格式的「活文档」。
export const sampleScript = `{
  "title": "启明 / First Light",
  "logline": "一座沉睡的空中都市，在一次合闸之后重新亮起。",
  "scenes": [
    { "id": 1, "beat": "空域", "description": "夜色中，Nova Meridian 巨城彻底沉睡：摩天楼漆黑，空中航道空无一物，冷蓝雾气弥漫，静得能听见风。" },
    { "id": 2, "beat": "总开关", "description": "昏暗控制室内，一只戴手套的手握住巨大的总闸手柄，琥珀色指示灯闪烁，合闸前一刻屏住呼吸。" },
    { "id": 3, "beat": "亮灯", "description": "同一座城瞬间苏醒：万家灯火转为暖金，航道流光涌动，能量贯穿塔楼，壮阔而温暖。" }
  ]
}`;
