// agents/screenwriter/sample.js — 「编剧」离线降级示例产物。
// LLM / 鉴权不可用时 runAgent 返回它，保证流水线照常出片；
// 它同时是 c02_screenplay 输出形状的「活文档」，与 prompt.js 的模板逐字段一致。
// 故事沿用演示片「启明 / First Light」，与 storyboard/sample.js 的三幕一一对应。
// 注意 gate.status 保持 pending：剧本确认是强制人工关口，示例也不许自我批准。
export const sampleScript = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "screenplay.sample.v1",
    "contract": "c02_screenplay",
    "created_at": "2026-09-06T12:00:00+08:00",
    "producer": { "kind": "agent", "name": "screenwriter_agent", "agent_version": "0.2.0" },
    "upstream_refs": ["brief.sample.v1"],
    "notes": "离线降级示例：LLM 不可用时返回，形状即 c02_screenplay 契约"
  },
  "payload": {
    "scenes": [
      {
        "scene_id": "SC01",
        "location": "空中都市 Nova Meridian 上空",
        "time_of_day": "night",
        "summary": "沉睡的空中巨城漆黑寂静，唯有城市中枢还亮着一点琥珀色光",
        "characters": [],
        "beats": [
          { "order": 1, "action": "大远景：夜色中空中巨城的剪影，摩天楼漆黑无灯，冷蓝雾气在塔楼间缓缓流动", "dialogue": "", "emotion": "孤寂、静谧", "estimated_seconds": 6 },
          { "order": 2, "action": "航道空镜：空中航道空无一物，只有航标灯在雾里明灭", "dialogue": "", "emotion": "压抑", "estimated_seconds": 6 },
          { "order": 3, "action": "镜头缓缓推向城市中枢唯一亮着的那点琥珀色光", "dialogue": "（画外音）它已经很久没有醒来。", "emotion": "静中微动", "estimated_seconds": 7 }
        ]
      },
      {
        "scene_id": "SC02",
        "location": "空中都市中枢控制室",
        "time_of_day": "night",
        "summary": "独自值守的人在琥珀色指示灯下完成最后核对，握住总闸手柄合闸",
        "characters": [
          { "name": "值守者", "appearance": "四十岁上下，深色工装，鬓角花白，戴绝缘手套，脸被琥珀色指示灯照亮" }
        ],
        "beats": [
          { "order": 1, "action": "昏暗控制室内，值守者从一排仪表间走过，指针全部静止", "dialogue": "", "emotion": "凝重", "estimated_seconds": 6 },
          { "order": 2, "action": "特写：戴手套的手握住巨大的总闸手柄，指节微微收紧", "dialogue": "", "emotion": "紧张", "estimated_seconds": 6 },
          { "order": 3, "action": "琥珀色指示灯闪烁三下后定格，值守者深吸一口气", "dialogue": "（画外音）直到有人合上那个开关。", "emotion": "屏息", "estimated_seconds": 7 },
          { "order": 4, "action": "手柄被果断压下，机械咬合，电流沿导管奔涌而上，指示灯逐一亮起", "dialogue": "", "emotion": "决断", "estimated_seconds": 8 }
        ]
      },
      {
        "scene_id": "SC03",
        "location": "空中都市 Nova Meridian 上空",
        "time_of_day": "night",
        "summary": "能量贯通的瞬间万家灯火转为暖金，航道流光涌动，整座城市重新发光",
        "characters": [],
        "beats": [
          { "order": 1, "action": "能量从中枢塔尖向外涌出，漆黑楼面逐层亮起", "dialogue": "", "emotion": "点燃", "estimated_seconds": 5 },
          { "order": 2, "action": "大远景：万家灯火转为暖金，冷蓝雾气被染成暖色", "dialogue": "", "emotion": "澎湃", "estimated_seconds": 7 },
          { "order": 3, "action": "航道流光穿梭夜空，镜头缓缓拉升，发光的城市全貌尽收眼底", "dialogue": "（画外音）于是，整座城重新发光。", "emotion": "壮阔、温暖", "estimated_seconds": 8 }
        ]
      }
    ],
    "emotion_curve": [
      { "beat": "建立", "intensity": 0.2 },
      { "beat": "打破", "intensity": 0.45 },
      { "beat": "最低点", "intensity": 0.3 },
      { "beat": "转折", "intensity": 0.6 },
      { "beat": "收束", "intensity": 0.9 }
    ],
    "dialogue_language": "zh",
    "total_estimated_seconds": 66,
    "gate": { "required": true, "status": "pending", "reviewer": null, "reviewed_at": null, "reason": "剧本确认——强制人工关口，批准后分镜 Agent 方可开工" }
  }
}`;
