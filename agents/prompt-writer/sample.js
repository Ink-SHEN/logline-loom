// agents/prompt-writer/sample.js — 「③提示词」离线降级示例产物（最终 c04 形状的活文档）。
//
// 与 ①② 不同，本 Agent 的离线降级不是「整份返回 sample」：run.js 在 LLM 不可用时按输入镜头
// 机械拼装英文提示词骨架（内容对应真实输入，仅未经 LLM 润色），保证流水线照常出片。
// 本文件的作用是：
//   1. c04_gen_request 输出形状的活文档——与 prompt.js 的口径、contracts/examples.json 逐字段一致；
//   2. 下游（④生成 / ⑥重试）mock 上游时的现成输入；
//   3. tools/samples.js 入库后由它再导出 sampleGenRequest。
//
// 示例选 R2V 镜头（对应 agents/storyboard/sample.js 的 S004 值守者镜头），因为它同时演示
// <Picture N> 引用与 assets.ref_images 素材位；T2V 的更简形态见 contracts/examples.json 的 c04_gen_request。
// 节点 ID 全部抄自 workflows/node_id_map.json 的 r2v.fields，禁止写死进 system prompt。
export const sampleGenRequest = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "genreq.S004_c01.sample",
    "contract": "c04_gen_request",
    "created_at": "2026-09-07T12:00:00+08:00",
    "producer": { "kind": "agent", "name": "prompt_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["shotlist.sample.v1"],
    "notes": "离线示例：R2V 镜头（storyboard sample 的 S004）。素材清单见 sample_assets.json；node_filename 必须先 POST /upload/image 上传并确认出现在 LoadImage.image 枚举里"
  },
  "payload": {
    "shot_id": "S004",
    "candidate_id": "S004_c01",
    "retry_of": null,
    "workflow": {
      "type": "R2V",
      "api_json": "workflow_api_r2v.json",
      "node_ids": {
        "source": "workflows/node_id_map.json@2026-09-04",
        "prompt": ["138", "value"],
        "seed": ["129", "noise_seed"],
        "duration_seconds": ["132", "value"],
        "aspect_ratio": ["115", "aspect_ratio"],
        "megapixels": ["115", "megapixels"],
        "filename_prefix": ["92", "filename_prefix"],
        "fps": ["130", "fps"],
        "turbo_enabled": ["146", "value"],
        "steps_normal": ["143", "value"],
        "steps_turbo": ["144", "value"]
      },
      "turbo_enabled": false
    },
    "generation": {
      "prompt": "Realistic live-action cinematic look, cold blue darkness with a single amber practical light. <Picture 1> locks the watchman's face, graying short hair and dark workwear; <Picture 2> locks the dim control room set with rows of dead analog gauges. [0s-3s] Medium tracking shot following the watchman as he walks slowly past a row of motionless instrument panels, every needle frozen at zero, the amber indicator light sweeping across his profile. [3s-6s] The camera keeps drifting with him past the last panel, his breath faintly visible in the cold air, the amber glow pulsing once on his cheekbone. Audio: boot steps echoing in the control room, low-frequency machine hum underneath, no music, no dialogue.",
      "prompt_language": "en",
      "timecodes": ["[0s-3s]", "[3s-6s]"],
      "duration_seconds": 6,
      "seed": 4001,
      "aspect_ratio": "16:9 (Widescreen)",
      "megapixels": 0.4,
      "multiple": 32,
      "fps": 24,
      "bit_depth": 8,
      "color_space": "sRGB",
      "steps": 20,
      "sampler_name": "res_multistep",
      "scheduler": "simple",
      "filename_prefix": "shots/S004_c01"
    },
    "assets": {
      "ref_images": [
        {
          "node_filename": "example.png",
          "source_path": "comfyui/input/example.png",
          "license": "self_generated",
          "generated_by": "占位：正式跑时换成值守者正面定妆图（MiniMax-H3 T2V 预生成，watchman 组内复用）"
        },
        {
          "node_filename": "example.png",
          "source_path": "comfyui/input/example.png",
          "license": "self_generated",
          "generated_by": "占位：正式跑时换成控制室场景参考图"
        }
      ],
      "ref_image_size": "match"
    }
  }
}`;
