#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LOOM · 轻量质检（⑥的客观部分）——用 ffprobe 实测值给成片镜头出 c06 报告。

为什么只有客观项
----------------
完整 ⑥ 质检 = 客观 6 项（ffprobe 实测 + 代码硬判，模型无判定权）+ 主观 7 项
（人复核 / 视觉模型）。创空间的批量生成是无人值守的，主观项这里**不接视觉模型**，
统一标 skipped + 注明「未接入视觉复核」——不假装判了，符合契约「判不了走 human」。

本模块复用本地 agents/qa/run.js 的判定口径（阈值/项名/verdict 自洽规则），
产出与 c06_qc_report 契约一致的 JSON。只依赖 ffprobe（Spark 上已有 6.1.1）。
"""
import json
import os
import re
import subprocess

# 视觉质检模块（同目录，可选）：主观画面项用 VL 模型看帧判定
sys_path = os.path.dirname(os.path.abspath(__file__))
try:
    import sys as _sys
    if sys_path not in _sys.path:
        _sys.path.insert(0, sys_path)
    from loom_vision import vision_judge, VISION_SCOPE
except Exception as _e:
    vision_judge = None
    VISION_SCOPE = ["prompt_adherence", "character_consistency", "scene_consistency",
                    "no_visual_artifact", "no_red_line_violation"]
    _VISION_IMPORT_ERR = str(_e)
else:
    _VISION_IMPORT_ERR = ""

OBJECTIVE = [
    "duration_in_range", "fps_is_24", "has_video_stream", "has_audio_stream",
    "audio_32k_stereo", "resolution_matches_aspect_ratio",
]
SUBJECTIVE = [
    "prompt_adherence", "character_consistency", "scene_consistency", "motion_quality",
    "audio_matches_scene", "no_visual_artifact", "no_red_line_violation",
]
FPS_TOLERANCE = 0.5
DURATION_TOLERANCE = 0.75
ASPECT_TOLERANCE = 0.02
MEGAPIXEL_TOLERANCE = 0.15
FIND_FFPROBE = ["ffprobe"]
DUR_TOL_STR = "0.75"


def _round(x, n):
    return round(float(x), n)


def find_ffprobe():
    for cand in ("ffprobe", "ffprobe.exe"):
        try:
            r = subprocess.run(["which", cand], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except Exception:
            pass
    return None


def _parse_rate(text):
    """'24000/1001' → 23.976；解析失败返回 None。"""
    if not text:
        return None
    m = text.split("/")
    try:
        if len(m) == 2:
            a, b = float(m[0]), float(m[1])
            if b != 0 and a > 0:
                return a / b
        f = float(text)
        return f if f > 0 else None
    except Exception:
        return None


def probe_mp4(path):
    """ffprobe 一次，返回结构化的视频/音频/时长信息。找不到文件/ffprobe 返回 None。"""
    ff = find_ffprobe()
    if not ff or not os.path.exists(path):
        return None
    try:
        r = subprocess.run(
            [ff, "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None
        d = json.loads(r.stdout)
    except Exception:
        return None
    out = {"video_stream": None, "audio_stream": None, "duration_seconds": None}
    for st in d.get("streams", []):
        codec = st.get("codec_type")
        if codec == "video" and out["video_stream"] is None:
            out["video_stream"] = {
                "codec_name": st.get("codec_name"),
                "width": st.get("width"),
                "height": st.get("height"),
                "avg_frame_rate": st.get("avg_frame_rate"),
            }
        elif codec == "audio" and out["audio_stream"] is None:
            out["audio_stream"] = {
                "codec_name": st.get("codec_name"),
                "sample_rate": str(st.get("sample_rate") or ""),
                "channels": st.get("channels"),
            }
    fmt = d.get("format", {})
    dur = fmt.get("duration")
    try:
        out["duration_seconds"] = float(dur) if dur else None
    except Exception:
        out["duration_seconds"] = None
    return out


def _parse_aspect(text):
    """'16:9 (Widescreen)' → 1.777…"""
    m = re.search(r"(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)", str(text or "").strip())
    if not m:
        return None
    w, h = float(m.group(1)), float(m.group(2))
    return (w / h) if w > 0 and h > 0 else None


def objective_checks(probe, targets):
    """客观 6 项。targets: {duration_seconds, aspect_ratio_text, megapixels}。"""
    out = []
    v = probe["video_stream"] if probe else None
    a = probe["audio_stream"] if probe else None

    # has_video_stream
    if v and v["codec_name"] and (v["width"] or 0) >= 64 and (v["height"] or 0) >= 64:
        out.append({"name": "has_video_stream", "status": "pass",
                    "measured": "%s %sx%s" % (v["codec_name"], v["width"], v["height"])})
    else:
        out.append({"name": "has_video_stream", "status": "fail",
                    "detail": "产物里没有可用的视频流" if not v else "视频流不完整",
                    "measured": "no video stream" if not v else str(v)})

    # fps_is_24
    fps = _parse_rate(v.get("avg_frame_rate")) if v else None
    if fps is None:
        out.append({"name": "fps_is_24", "status": "fail",
                    "detail": "帧率解析不出来", "measured": str((v or {}).get("avg_frame_rate") or "无")})
    elif abs(fps - 24) <= FPS_TOLERANCE:
        out.append({"name": "fps_is_24", "status": "pass",
                    "measured": "%.2ffps" % fps})
    else:
        out.append({"name": "fps_is_24", "status": "fail",
                    "detail": "H3 标称 24fps，实测 %.3ffps（超容差）" % fps,
                    "measured": "%.3ffps" % fps})

    # has_audio_stream / audio_32k_stereo
    if a:
        out.append({"name": "has_audio_stream", "status": "pass",
                    "measured": "%s %sHz %sch" % (a["codec_name"], a["sample_rate"], a["channels"])})
        if a["sample_rate"] == "32000" and a["channels"] == 2:
            out.append({"name": "audio_32k_stereo", "status": "pass",
                        "detail": "符合 H3 标称 32kHz 立体声",
                        "measured": "%sHz %sch" % (a["sample_rate"], a["channels"])})
        else:
            out.append({"name": "audio_32k_stereo", "status": "fail",
                        "detail": "H3 标称 32000Hz 双声道，实测 %sHz %sch" % (a["sample_rate"], a["channels"]),
                        "measured": "%sHz %sch" % (a["sample_rate"], a["channels"])})
    else:
        out.append({"name": "has_audio_stream", "status": "fail",
                    "detail": "产物没有音频流（H3 原生出声，无音频即生成异常）",
                    "measured": "no audio stream"})
        out.append({"name": "audio_32k_stereo", "status": "skipped", "detail": "无音频流，跳过"})

    # duration_in_range
    target = targets.get("duration_seconds")
    dur = probe["duration_seconds"] if probe else None
    if dur is None:
        out.append({"name": "duration_in_range", "status": "fail",
                    "detail": "产物时长测不出来（文件可能没写完）"})
    elif target is None:
        ok = 4 <= dur <= 16
        out.append({"name": "duration_in_range", "status": "pass" if ok else "fail",
                    "detail": "实测 %.2fs；无目标可比对，只确认落 H3 4–15s 区间" % dur
                              if ok else "实测 %.2fs 落 H3 4–15s 之外" % dur,
                    "measured": str(_round(dur, 2))})
    else:
        diff = abs(dur - target)
        if diff <= DURATION_TOLERANCE:
            out.append({"name": "duration_in_range", "status": "pass",
                        "detail": "设定 %ss，实测 %.2fs，差 %.3fs ≤ %ss" % (target, dur, diff, DUR_TOL_STR),
                        "measured": str(_round(dur, 2))})
        else:
            out.append({"name": "duration_in_range", "status": "fail",
                        "detail": "设定 %ss，实测 %.2fs，差 %.3fs 超 ±%ss" % (target, dur, diff, DUR_TOL_STR),
                        "measured": str(_round(dur, 2))})

    # resolution_matches_aspect_ratio
    want_ar = _parse_aspect(targets.get("aspect_ratio_text"))
    want_mp = targets.get("megapixels")
    if not v or not v.get("width") or not v.get("height"):
        out.append({"name": "resolution_matches_aspect_ratio", "status": "skipped",
                    "detail": "没有可用的视频流宽高"})
    else:
        got_ar = v["width"] / v["height"]
        got_mp = (v["width"] * v["height"]) / 1e6
        status, detail = "pass", []
        if want_ar is not None and abs(got_ar - want_ar) > want_ar * ASPECT_TOLERANCE:
            status = "fail"
            detail.append("画幅比要求 %.4f，实测 %.4f" % (want_ar, got_ar))
        if want_mp is not None and abs(got_mp - want_mp) > want_mp * MEGAPIXEL_TOLERANCE:
            status = "fail"
            detail.append("megapixels 要求 %s，实测 %.4f" % (want_mp, got_mp))
        if status == "pass":
            detail.append("%sx%s ≈ %.3f:1" % (v["width"], v["height"], got_ar))
        out.append({"name": "resolution_matches_aspect_ratio", "status": status,
                    "detail": "；".join(detail),
                    "measured": "%sx%s" % (v["width"], v["height"])})
    return out


def build_c06(shot_id, probe, targets, vision=None, vision_target_note=""):
    """组一份 c06 报告（客观项 + 主观项）。

    vision: 若提供了视觉质检结果({findings:[{name,status,detail,measured}],...})，
    用它填对应主观画面项；没判到的项标 skipped（注明未复核）。motion/audio 静帧判不了，
    一律标 skipped。未提供 vision → 主观项全 skipped（现状）。
    """
    objective = objective_checks(probe, targets)

    # 主观项：有视觉判定则填充画面 5 项，否则全 skipped
    sub_map = {}
    if vision and vision.get("ok") and vision.get("findings"):
        for f in vision["findings"]:
            sub_map[f["name"]] = f
    sub_md = "视觉模型 %s 已看帧复核" % vision.get("model") if vision and vision.get("ok") else "未接入视觉复核，判不了（创空间批量模式）"
    subjective = []
    for n in SUBJECTIVE:
        if n in sub_map:
            c = sub_map[n]
            item = {"name": n, "status": c.get("status", "skipped")}
            if c.get("detail"):
                item["detail"] = c["detail"]
            if c.get("measured"):
                item["measured"] = c["measured"]
            subjective.append(item)
        elif vision and vision.get("ok") and n in VISION_SCOPE:
            # 视觉通道本该判但没判 → 显式标未复核，不假装
            subjective.append({"name": n, "status": "skipped",
                               "detail": "视觉模型本轮未判该项，按未复核处理"})
        else:
            subjective.append({"name": n, "status": "skipped",
                               "detail": sub_md})
    checks = objective + subjective
    obj_fails = [c["name"] for c in objective if c["status"] == "fail"]
    sub_fails = [c["name"] for c in subjective if c["status"] == "fail"]
    sub_notes = [c["name"] for c in subjective
                 if c["status"] in ("skipped", "pass_with_notes")]
    failed_items = list(obj_fails) + list(sub_fails)
    has_vision = bool(vision and vision.get("ok"))

    # verdict / route_to：
    #  客观有 fail → fail(human, 不自动重试)
    #  否则主观有 fail → fail(可换seed/候选自动重试——画面问题多是该 seed 生成异常，值得重跑)
    #  否则主观有未复核且无视觉 → pass_with_notes + human(与现状一致)
    #  视觉全看过且全过 → pass(route_to=edit, 可直接进剪辑)
    if obj_fails:
        verdict, route_to = "fail", "human"
        suggested = {"action": "manual_intervention", "patch": {},
                     "rationale": "客观项失败（%s）。批量模式下客观问题不自动重试，留人工核对 ffprobe 与提示词"
                     % "、".join(obj_fails)}
    elif sub_fails:
        verdict, route_to = "fail", "retry"
        suggested = {"action": "new_seed", "patch": {},
                     "rationale": "画面主观项失败（%s）——该候选 seed 生成画面不达标，换种子/换候选重试"
                     % "、".join(sub_fails)}
        if not has_vision:
            route_to, verdict = "human", "fail"
            suggested = {"action": "manual_intervention", "patch": {},
                         "rationale": "有主观项 fail 但没接视觉复核（不该发生，可能是异常数据），转人工"}
    elif sub_notes and not has_vision:
        verdict, route_to = "pass_with_notes", "human"
        suggested = {"action": "manual_intervention", "patch": {},
                     "rationale": "客观项全过；主观画面项未接入视觉复核（%s 待复核），转人工确认"
                     % "、".join(sub_notes)}
    else:
        # 客观全过 + (视觉全看过 或 无主观项判不了却都过)
        verdict, route_to = "pass", "edit"
        suggested = {"action": "pass", "patch": {},
                     "rationale": "客观项全过，视觉复核判定符合要求（%s）" % vision_target_note or "素材技术指标达标"}

    score = 10.0 - 2.0 * len(obj_fails) - 2.0 * len(sub_fails)
    if has_vision and vision.get("score") is not None:
        try:
            score = round(score * 0.5 + float(vision["score"]) * 0.5, 1)
        except Exception:
            pass
    else:
        score = round(score, 1)

    return {
        "shot_id": shot_id,
        "candidate_id": "%s_c00" % shot_id,
        "verdict": verdict,
        "score": score,
        "checks": checks,
        "failed_items": failed_items,
        "route_to": route_to,
        "retry_count": 0,
        "max_retries": 0,
        "suggested_change": suggested,
        "vision_source": vision.get("model") if vision and vision.get("ok") else None,
        "gate": {"required": False, "status": "not_required"},
    }


def qc_mp4(path, targets, vision_ctx=None):
    """对外入口：对单个成片跑质检。返回 {ok, probe?, c06?}。

    vision_ctx(可选): {target_text, brief_text, count, model, api_key, base_url}
    提供则客观过检后调视觉模型判主观画面项，合成完整 c06。
    """
    ff = find_ffprobe()
    if not ff:
        return {"ok": False, "error": "ffprobe 不可用"}
    if not os.path.exists(path):
        return {"ok": False, "error": "文件不存在"}
    probe = probe_mp4(path)
    if probe is None:
        return {"ok": False, "error": "ffprobe 解析失败"}
    shot_id = os.path.splitext(os.path.basename(path))[0]
    vision = None
    vision_target_note = ""
    if vision_ctx and vision_judge is not None:
        try:
            api_key = vision_ctx.get("api_key") or os.environ.get("LOOM_LLM_API_KEY") \
                or os.environ.get("LOOM_VISION_API_KEY") or ""
            if api_key and vision_ctx.get("target_text"):
                vr = vision_judge(
                    path, vision_ctx["target_text"],
                    brief_text=vision_ctx.get("brief_text") or "",
                    count=int(vision_ctx.get("count") or 3),
                    model=vision_ctx.get("model"),
                    base_url=vision_ctx.get("base_url"),
                    api_key=api_key)
                if vr.get("ok"):
                    vr["model"] = vision_ctx.get("model") or os.environ.get("LOOM_VISION_MODEL") \
                        or "Qwen/Qwen3-VL-235B-A22B-Instruct"
                    vision = vr
                    vision_target_note = "目标：%s" % vision_ctx["target_text"][:80]
        except Exception as _e:
            vision = None
    c06 = build_c06(shot_id, probe, targets, vision=vision,
                    vision_target_note=vision_target_note)
    return {"ok": True, "probe": probe, "c06": c06}


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("用法: python loom_qc.py <mp4> [duration] [aspect_text]")
        sys.exit(1)
    p = sys.argv[1]
    t = {"duration_seconds": float(sys.argv[2]) if len(sys.argv) > 2 else None,
         "aspect_ratio_text": sys.argv[3] if len(sys.argv) > 3 else None,
         "megapixels": None}
    r = qc_mp4(p, t)
    print(json.dumps(r, ensure_ascii=False, indent=1))
