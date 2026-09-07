// agents/generator/sample.js — 「④生成」示例产物（最终 c05 形状的活文档）。
//
// ④生成 没有离线降级：它要么真的提交 ComfyUI 拿到产物，要么用 --dry-run 只出提交计划。
// 伪造一份 c05 等于伪造证据（sha256、prompt_id、ffprobe 全是编的），流水线会带着假数据一路走到成片。
// 所以本文件的作用是：
//   1. c05_gen_result 输出形状的活文档——与 contracts/examples.json 的 c05 逐字段一致；
//   2. ⑤质检 mock 上游时的现成输入：sampleGenResult 是 pass 形态（有原生音频），
//      sampleGenResultNoAudio 是 fail 形态（无音频流），与 agents/qa/sample.js 的
//      sampleQA / sampleQAFail 一一对应（同一个候选 S002_c01、同一个失败项 has_audio_stream）；
//   3. tools/samples.js 入库后由它再导出。
//
// 两份示例的数字都不是随手编的：848x480 是 megapixels=0.4 在 16:9 下的预期分辨率；
// unet_name 如实反映这次跑的是 FL2VA（T2V/I2V）还是 Ref2VA（R2V）。
//
// duration_seconds 与 frame_count_actual 对不齐是正常的，别去「修」它：
// 前者取容器时长（ffprobe 的 format.duration，是各条流的最大值，音轨常比视频轨长几帧），
// 后者取视频流自己的帧数，由下游 ComfyMathExpression 对齐到 17 的倍数（6 秒 → 141 帧 ≡ 5 mod 17）。
// 141 / 24 = 5.875s，容器报 6.083s，差的就是这段音频尾巴。
// 正因为如此，⑤质检 的 duration_in_range 只能用容差判（默认 ±0.75s ≈ 一个 17 帧对齐步长），
// 拿「时长×24」去要求精确帧数一定误判。

export const sampleGenResult = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "genres.S001_c01",
    "contract": "c05_gen_result",
    "created_at": "2026-09-08T09:14:00+08:00",
    "producer": { "kind": "agent", "name": "generation_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["genreq.S001_c01"],
    "notes": "④生成 Agent 自动落盘；实际提交的工作流图：artifacts/genplan_20260908T090500/S001_c01.graph.json"
  },
  "payload": {
    "shot_id": "S001",
    "candidate_id": "S001_c01",
    "comfy_prompt_id": "3f9c1a2e-0000-0000-0000-000000000000",
    "output": {
      "path": "shots/S001_c01/video.mp4",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size_bytes": 4823000
    },
    "ffprobe": {
      "duration_seconds": 6.083,
      "video_stream": {
        "codec_name": "h264",
        "width": 848,
        "height": 480,
        "avg_frame_rate": "24/1",
        "pix_fmt": "yuv420p"
      },
      "audio_stream": {
        "codec_name": "aac",
        "sample_rate": "32000",
        "channels": 2
      }
    },
    "timing": {
      "submitted_at": "2026-09-08T09:05:00+08:00",
      "finished_at": "2026-09-08T09:14:00+08:00",
      "elapsed_seconds": 540.0,
      "queue_position_at_submit": 0
    },
    "params_snapshot": {
      "prompt": "Realistic live-action cinematic look, cool blue instrument glow, shallow depth of field. [0s-3s] Wide establishing shot of an empty radio telescope array control room at night, banks of dark monitors, slow deliberate push-in. [3s-6s] The push-in continues toward the central console, a single amber standby light blinking. Audio: low electrical hum, distant cooling fans, no dialogue.",
      "seed": 1001,
      "duration_seconds": 6,
      "frame_count_actual": 141,
      "megapixels": 0.4,
      "width": 848,
      "height": 480,
      "steps": 20,
      "turbo_enabled": false,
      "filename_prefix": "shots/S001_c01"
    },
    "model_files": {
      "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      "weight_dtype": "default",
      "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      "clip_type": "minimax",
      "video_vae_name": "minimax_h3_video_vae_fp16.safetensors",
      "audio_vae_name": "minimax_h3_audio_vae_fp32.safetensors",
      "lora_name": null
    },
    "submitted_by": "组员B"
  }
}`;

// ⑤质检 的 fail 分支要有东西可判：这份没有音频流（audio_stream 为 null），
// 对应 agents/qa/sample.js 的 sampleQAFail（同一个候选 S002_c01、同一个失败项 has_audio_stream）。
// H3 是原生出声的，出不了声就是生成异常，不是「可选特性没开」。
export const sampleGenResultNoAudio = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "genres.S002_c01",
    "contract": "c05_gen_result",
    "created_at": "2026-09-08T09:58:00+08:00",
    "producer": { "kind": "agent", "name": "generation_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["genreq.S002_c01"],
    "notes": "④生成 Agent 自动落盘。警告：产物没有音频流，H3 原生出声，这一项 ⑤质检 会判 fail"
  },
  "payload": {
    "shot_id": "S002",
    "candidate_id": "S002_c01",
    "comfy_prompt_id": "77aa01cd-0000-0000-0000-000000000000",
    "output": {
      "path": "shots/S002_c01/video.mp4",
      "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "size_bytes": 3907000
    },
    "ffprobe": {
      "duration_seconds": 5.167,
      "video_stream": {
        "codec_name": "h264",
        "width": 848,
        "height": 480,
        "avg_frame_rate": "24/1",
        "pix_fmt": "yuv420p"
      },
      "audio_stream": null
    },
    "timing": {
      "submitted_at": "2026-09-08T09:55:00+08:00",
      "finished_at": "2026-09-08T09:58:00+08:00",
      "elapsed_seconds": 183.4,
      "queue_position_at_submit": 0
    },
    "params_snapshot": {
      "prompt": "Realistic live-action cinematic look, cool blue instrument glow. [0s-2s] Close-up shot, static locked-off camera, a weathered hand rests on a heavy brass knife-switch on the central console. [2s-5s] The hand throws the switch, amber light floods the panel. Audio: a solid mechanical clunk, then rising transformer whine.",
      "seed": 42,
      "duration_seconds": 5,
      "frame_count_actual": 124,
      "megapixels": 0.4,
      "width": 848,
      "height": 480,
      "steps": 20,
      "turbo_enabled": false,
      "filename_prefix": "shots/S002_c01"
    },
    "model_files": {
      "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      "weight_dtype": "default",
      "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      "clip_type": "minimax",
      "video_vae_name": "minimax_h3_video_vae_fp16.safetensors",
      "audio_vae_name": "minimax_h3_audio_vae_fp32.safetensors",
      "lora_name": null
    },
    "submitted_by": "组员B"
  }
}`;
