// agents/editor/sample.js — 「⑦剪辑」离线降级示例产物（最终 c07_edit_decision 形状的活文档）。
//
// 与 ①②（离线直接返回整份 sample）不同，本 Agent 的离线降级是「按输入素材确定性拼一条组装粗剪」：
// run.js 在 LLM 不可用时用满整段入出点 + 首尾淡入淡出/中间硬切 + 默认混音，内容对应真实输入，仅未经 LLM 调节奏。
// 本文件的作用是：
//   1. c07_edit_decision 输出形状的活文档——与 prompt.js 的口径、contracts/examples.json 逐字段一致；
//   2. 下游（渲染 tools/slideshow.mjs、人工粗剪确认关口）mock 上游时的现成输入；
//   3. tools/samples.js 入库后由它再导出 sampleEditDecision。
//
// 与 examples.json 的 c07 一样，本示例是**渲染前的决策单**：final_output.sha256 用全 0 占位、size_bytes 为按选定
// 候选源码率投影的估计值——二者在真渲染（tools/slideshow.mjs 或 ffmpeg）后必须回填真实值，见 notes。
// gate.status 有意留 "pending"：c07 是两处强制人工关口之二（粗剪确认），剪辑 Agent 不自批（docs/agent_guide.md 第七/九节）。
// 时间线取 11 镜、每镜用满 6s，final_output.duration_seconds = 66 恰为各片段 (out-in) 之和，内部自洽可直接过校验。
export const sampleEditDecision = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "edit.roughcut.sample",
    "contract": "c07_edit_decision",
    "created_at": "2026-09-11T20:00:00+08:00",
    "producer": { "kind": "agent", "name": "editing_agent", "agent_version": "0.1.0" },
    "upstream_refs": [
      "qc.S001_c01", "qc.S002_c02", "qc.S003_c01", "qc.S004_c03", "qc.S005_c01", "qc.S006_c02",
      "qc.S007_c01", "qc.S008_c01", "qc.S009_c02", "qc.S010_c01", "qc.S011_c01"
    ],
    "notes": "离线示例：11 镜组装粗剪。每镜候选按 c06 分数在 verdict=pass/pass_with_notes 且 route_to=edit 的候选里选定；source_path 原样取自各候选 c05 的 output.path。final_output.sha256 为渲染前全 0 占位、size_bytes 为按源码率投影的估计值，真渲染后须回填。gate 有意留 pending，等人工粗剪确认（关口 2）。"
  },
  "payload": {
    "timeline": [
      { "order": 1, "shot_id": "S001", "candidate_id": "S001_c01", "source_path": "shots/S001_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "fade_in", "subtitle": null },
      { "order": 2, "shot_id": "S002", "candidate_id": "S002_c02", "source_path": "shots/S002_c02/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": null },
      { "order": 3, "shot_id": "S003", "candidate_id": "S003_c01", "source_path": "shots/S003_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": "复核需要两个人。" },
      { "order": 4, "shot_id": "S004", "candidate_id": "S004_c03", "source_path": "shots/S004_c03/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "dissolve", "subtitle": null },
      { "order": 5, "shot_id": "S005", "candidate_id": "S005_c01", "source_path": "shots/S005_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": null },
      { "order": 6, "shot_id": "S006", "candidate_id": "S006_c02", "source_path": "shots/S006_c02/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": null },
      { "order": 7, "shot_id": "S007", "candidate_id": "S007_c01", "source_path": "shots/S007_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": "第一批播种，成功。\\n第二批——失败。\\n那就再来一次。" },
      { "order": 8, "shot_id": "S008", "candidate_id": "S008_c01", "source_path": "shots/S008_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": null },
      { "order": 9, "shot_id": "S009", "candidate_id": "S009_c02", "source_path": "shots/S009_c02/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "dissolve", "subtitle": null },
      { "order": 10, "shot_id": "S010", "candidate_id": "S010_c01", "source_path": "shots/S010_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "cut", "subtitle": null },
      { "order": 11, "shot_id": "S011", "candidate_id": "S011_c01", "source_path": "shots/S011_c01/video.mp4", "in_point_seconds": 0, "out_point_seconds": 6, "transition": "fade_out", "subtitle": null }
    ],
    "audio_mix": {
      "dialogue_gain_db": 0,
      "music_gain_db": -6,
      "sfx_gain_db": -3,
      "loudness_target_lufs": -14
    },
    "final_output": {
      "path": "deliverables/final.sample.mp4",
      "container": "mp4",
      "duration_seconds": 66,
      "resolution": "1344x768",
      "fps": 24,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size_bytes": 82000000
    },
    "compliance": {
      "ai_label_present": true,
      "ai_label_position": "opening_and_ending",
      "red_line_self_check": true,
      "duration_in_range": true,
      "size_under_limit": true,
      "asset_licenses_cleared": true,
      "evidence_paths": [
        "artifacts/qc/S001_c01.json",
        "shots/S001_c01/meta.json",
        "deliverables/subtitles.sample.ass",
        "docs/compliance/ai_label_screenshot.png",
        "docs/compliance/red_line_checklist.md"
      ]
    },
    "deliverables": {
      "platform_url": "",
      "studio_url": "",
      "blog_url": "",
      "upload_file_path": "deliverables/final.sample.mp4"
    },
    "gate": {
      "required": true,
      "status": "pending",
      "reviewer": null,
      "reviewed_at": null,
      "reason": "粗剪确认——两处强制人工关口之二，剪辑 Agent 不自批，待全组看过粗剪后人工填写 status/reviewer/reviewed_at"
    }
  }
}`;
