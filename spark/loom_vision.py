#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LOOM · 视觉质检（主观项的可看得见通道）——抽帧交给视觉模型判。

复刻本地 agents/qa/vision.js + judgeByVision 的口径：等间隔抽帧（取每段中点）→
jpg base64 → 组 OpenAI 视觉请求 → 让 VL 模型输出结构化 findings（只判 in-scope 的主观画面项）。

只依赖 ffmpeg + 魔搭 api-inference 的 VL 模型（Qwen3-VL 系列）。纯标准库。
"""
import base64
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

# 视觉通道能判的 5 项（motion_quality / audio_matches_scene 静帧判不了，不放进 scope）
VISION_SCOPE = [
    "prompt_adherence", "character_consistency", "scene_consistency",
    "no_visual_artifact", "no_red_line_violation",
]

VISION_PROMPT = """你是一名成片质检员，任务是对一个 AI 生成的镜头做「画面内容」核对。
给你的是从产物视频里等间隔抽出的若干静帧（每帧注明时间 t=...）。这是静帧不是视频：
- motion_quality（运动是否平滑）、audio_matches_scene（音画匹配）你判不了，不要输出。
- 你必须对下面 5 项【逐项】给出判断，每一项都要有明确的 pass 或 fail，不许跳过、不许漏项：
  prompt_adherence（画面是否符合提交给模型的英文提示词）
  character_consistency（人物/角色是否一致；无明确角色或空镜就判 pass 并注明"无可见人物/空镜"）
  scene_consistency（场景是否与描述相符、前后是否一致；相符就 pass）
  no_visual_artifact（画面是否无崩坏、形变、穿模等伪影；干净就 pass）
  no_red_line_violation（画面是否命中红线条款；未提供红线段落则判 pass 并注明"未提供红线，默认无违规"）
判定原则：只有看到确凿问题才判 fail 并写清具体时刻/位置；正常情况下各主观项应多为 pass。
请严格输出一个 JSON 对象（不要任何解释），形如：
{"findings":[{"name":"...","status":"pass|fail","detail":"具体到哪一秒、画面哪个位置..."}, ...5项全列},"root_cause":"若有fail写根因否则null","score":0到10的整数,
"rewrite_suggestion":"仅当 prompt_adherence 或 scene_consistency 判 fail 时必须给：一段可直接替换进英文提示词的改写(用英文，指出画面差在哪、该怎么改，让重跑能贴近期望；若画面偏差是内容无关的崩坏则给null)"}
判 fail 必须在 detail 里写清具体位置/时刻（至少8个字符）。"""


def _parse_model_output(raw):
    """从模型回复抽 JSON；若整段不是 JSON，尝试逐项提取。"""
    data = _extract_json(raw)
    if data and isinstance(data.get("findings"), list):
        return data
    return None


def find_ffmpeg():
    for cand in ("ffmpeg", "ffmpeg.exe"):
        try:
            r = subprocess.run(["which", cand], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except Exception:
            pass
    return None


def extract_frames(video_path, count=4):
    """等间隔抽帧（取各段中点），返回 [{at_seconds, base64, bytes}]。失败抛异常。"""
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("本机没有 ffmpeg，无法抽帧")
    if not os.path.exists(video_path):
        raise RuntimeError("视频不存在: %s" % video_path)
    # 先取时长
    try:
        r = subprocess.run([find_ffprobe() or "ffprobe", "-v", "error",
                            "-show_entries", "format=duration", "-of", "json", video_path],
                           capture_output=True, text=True, timeout=30)
        dur = float(json.loads(r.stdout or "{}").get("format", {}).get("duration", 0) or 0)
    except Exception:
        dur = 0.0
    if dur <= 0:
        dur = 8.0
    frames = []
    tmp = tempfile.mkdtemp(prefix="loom_vframes_")
    try:
        for i in range(count):
            at = round(dur * ((i + 0.5) / count), 3)
            out = os.path.join(tmp, "f%02d.jpg" % i)
            rr = subprocess.run([ff, "-v", "error", "-y", "-ss", str(at), "-i", video_path,
                                 "-frames:v", "1", "-q:v", "3", out],
                                capture_output=True, text=True, timeout=120)
            if rr.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
                raise RuntimeError("第 %d 帧(t=%ss)抽取失败" % (i + 1, at))
            with open(out, "rb") as f:
                b = f.read()
            frames.append({"at_seconds": at, "base64": base64.b64encode(b).decode(), "bytes": len(b)})
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    return frames


def find_ffprobe():
    for cand in ("ffprobe", "ffprobe.exe"):
        try:
            r = subprocess.run(["which", cand], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except Exception:
            pass
    return None


def _extract_json(text):
    """从模型回复里抽第一个 { ... } JSON 块。"""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _chat_vision(base_url, api_key, model, user_text, frames):
    """调一次 VL 多模态 chat，返回 assistant 文本。"""
    content = [{"type": "text", "text": user_text}]
    for fr in frames:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64,%s" % fr["base64"]}})
    body = {
        "model": model,
        "messages": [{"role": "system", "content": VISION_PROMPT},
                     {"role": "user", "content": content}],
        "max_tokens": 400,
    }
    url = (base_url or "https://api-inference.modelscope.cn/v1").rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"Authorization": "Bearer %s" % api_key,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode("utf-8"))
    choices = d.get("choices") or []
    if not choices:
        raise RuntimeError("VL 模型未返回 choices（token 是否支持该模型？）")
    return (choices[0].get("message") or {}).get("content") or ""


def vision_judge(video_path, target_text, brief_text="",
                 count=4, model=None, base_url=None, api_key=None):
    """对单个成片跑视觉质检。

    返回 {ok, findings?, score?, root_cause?, frames_t?} 或 {ok:False, error}。
    target_text: 该镜英文 prompt + 分镜描述（比对的基准）。brief_text: 片约 red_lines（可选）。
    """
    if not api_key:
        api_key = os.environ.get("LOOM_LLM_API_KEY") or os.environ.get("LOOM_VISION_API_KEY") or ""
    if not api_key:
        return {"ok": False, "error": "未配置视觉模型 API key（LOOM_LLM_API_KEY / LOOM_VISION_API_KEY）"}
    if not model:
        model = os.environ.get("LOOM_VISION_MODEL") or "Qwen/Qwen3-VL-235B-A22B-Instruct"
    try:
        frames = extract_frames(video_path, count=count)
    except Exception as e:
        return {"ok": False, "error": "抽帧失败: %s" % e}
    at_txt = "、".join("t=%ss" % f["at_seconds"] for f in frames)
    user_text = target_text + "\n\n附：%d 张等间隔静帧（%s）。" % (len(frames), at_txt)
    if brief_text:
        user_text += "\n片约 red_lines 段：\n%s" % brief_text
    try:
        raw = _chat_vision(base_url, api_key, model, user_text, frames)
    except Exception as e:
        return {"ok": False, "error": "调视觉模型失败: %s" % e}
    data = _extract_json(raw)
    if not data:
        return {"ok": False, "error": "视觉模型未返回结构化 JSON: %s" % str(raw)[:200]}
    findings = data.get("findings") or []
    # 只收 in-scope 且 pass/fail 的条目；detail 检查
    clean = []
    for f in findings:
        name = f.get("name")
        status = f.get("status")
        if name not in VISION_SCOPE:
            continue
        if status not in ("pass", "fail"):
            continue
        item = {"name": name, "status": status}
        if isinstance(f.get("detail"), str) and f["detail"]:
            item["detail"] = f["detail"]
        if isinstance(f.get("measured"), str) and f["measured"]:
            item["measured"] = f["measured"]
        clean.append(item)
    # 补齐 scope 里没判到的项为 skipped（避免检查项缺失）
    judged = {c["name"] for c in clean}
    for name in VISION_SCOPE:
        if name not in judged:
            clean.append({"name": name, "status": "skipped",
                          "detail": "模型本轮未判（可能无明确依据），按未复核处理"})
    score = data.get("score")
    try:
        score = float(score) if score is not None else None
    except Exception:
        score = None
    root = data.get("root_cause") if isinstance(data.get("root_cause"), str) else None
    rs = data.get("rewrite_suggestion")
    rewrite_suggestion = rs if isinstance(rs, str) and rs.strip() else None
    return {"ok": True, "findings": clean, "score": score, "root_cause": root,
            "rewrite_suggestion": rewrite_suggestion,
            "frames_t": [f["at_seconds"] for f in frames]}


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("用法: python loom_vision.py <mp4> <target_text> [count]")
        sys.exit(1)
    p = sys.argv[1]
    tgt = sys.argv[2]
    cnt = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    r = vision_judge(p, tgt, count=cnt,
                     model=os.environ.get("LOOM_VISION_MODEL") or "Qwen/Qwen3-VL-8B-Instruct",
                     api_key=os.environ.get("LOOM_LLM_API_KEY") or os.environ.get("LOOM_VISION_API_KEY"))
    print(json.dumps(r, ensure_ascii=False, indent=1))
