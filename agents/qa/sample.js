// agents/qa/sample.js — 「质检」离线降级示例产物。
// sampleQA       : 正常 pass_with_notes（有小瑕疵但可接受，进剪辑）。
// sampleQAFail   : 演示「打回重试」用——离线时设 FILM_DEMO_REJECT=1，第 1 轮质检用这条 fail，
//                  触发流水线回到生成工位重试（换种子），第 2 轮再 pass，用于现场展示质检闭环。
export const sampleQA = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "qc.S001_c01",
    "contract": "c06_qc_report",
    "created_at": "2026-09-06T09:30:00+08:00",
    "producer": { "kind": "agent", "name": "qc_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["gen.S001_c01"]
  },
  "payload": {
    "shot_id": "S001",
    "candidate_id": "S001_c01",
    "verdict": "pass_with_notes",
    "score": 7.5,
    "checks": [
      { "name": "duration_in_range", "status": "pass", "detail": "6.083s，落在 4-8s 目标区间", "measured": "6.083" },
      { "name": "fps_is_24", "status": "pass", "measured": "24/1" },
      { "name": "has_video_stream", "status": "pass", "measured": "h264 848x480" },
      { "name": "has_audio_stream", "status": "pass", "measured": "aac" },
      { "name": "audio_32k_stereo", "status": "pass", "detail": "符合 H3 标称", "measured": "32000Hz 2ch" },
      { "name": "resolution_matches_aspect_ratio", "status": "pass", "detail": "848x480 约 16:9，megapixels=0.4 的预期值", "measured": "848x480" },
      { "name": "prompt_adherence", "status": "pass", "detail": "空镜、冷蓝辉光、推镜均到位" },
      { "name": "scene_consistency", "status": "pass", "detail": "与 control_room 组一致" },
      { "name": "motion_quality", "status": "pass", "detail": "推镜平滑无抖动" },
      { "name": "audio_matches_scene", "status": "pass", "detail": "低频嗡鸣存在" },
      { "name": "no_visual_artifact", "status": "fail", "detail": "第4秒右下角屏幕出现轻微纹理撕裂，可接受但记录在案", "measured": "t=4.0s 右下角" },
      { "name": "no_red_line_violation", "status": "pass", "detail": "逐条比对 brief.red_lines 无命中" }
    ],
    "failed_items": ["no_visual_artifact"],
    "root_cause": "megapixels=0.4 分辨率偏低导致细小屏幕纹理不稳定，属预期范围",
    "suggested_change": {
      "action": "raise_megapixels",
      "patch": { "megapixels": 1.0 },
      "rationale": "成片批次统一提到 1.0，试错阶段保持 0.4 不动"
    },
    "retry_count": 0,
    "max_retries": 3,
    "route_to": "edit",
    "gate": { "required": false, "status": "not_required" }
  }
}`;

export const sampleQAFail = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "qc.S002_c01",
    "contract": "c06_qc_report",
    "created_at": "2026-09-06T10:00:00+08:00",
    "producer": { "kind": "agent", "name": "qc_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["gen.S002_c01"]
  },
  "payload": {
    "shot_id": "S002",
    "candidate_id": "S002_c01",
    "verdict": "fail",
    "score": 3.0,
    "checks": [
      { "name": "duration_in_range", "status": "pass", "measured": "5.2" },
      { "name": "fps_is_24", "status": "pass", "measured": "24/1" },
      { "name": "has_video_stream", "status": "pass", "measured": "h264 848x480" },
      { "name": "has_audio_stream", "status": "fail", "detail": "输出文件无音频流，H3 应原生生成音频", "measured": "no audio stream" },
      { "name": "audio_32k_stereo", "status": "skipped", "detail": "无音频流，跳过" },
      { "name": "resolution_matches_aspect_ratio", "status": "pass", "measured": "848x480" },
      { "name": "prompt_adherence", "status": "fail", "detail": "提示词要求'手合闸特写'，实际输出为远景房间全景" },
      { "name": "scene_consistency", "status": "pass", "detail": "色调与 S001 一致" },
      { "name": "motion_quality", "status": "pass", "detail": "无明显抖动" },
      { "name": "audio_matches_scene", "status": "skipped", "detail": "无音频流，跳过" },
      { "name": "no_visual_artifact", "status": "pass" },
      { "name": "no_red_line_violation", "status": "pass" }
    ],
    "failed_items": ["has_audio_stream", "prompt_adherence"],
    "root_cause": "种子 42 生成异常，音频流缺失且画面构图偏离提示词",
    "suggested_change": {
      "action": "new_seed",
      "patch": { "seed": 99 },
      "rationale": "音频缺失属生成异常，换种子重试；构图偏离可能随种子变化修复"
    },
    "retry_count": 0,
    "max_retries": 3,
    "route_to": "retry",
    "gate": { "required": false, "status": "not_required" }
  }
}`;
