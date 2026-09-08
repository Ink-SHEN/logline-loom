# -*- coding: utf-8 -*-
"""创空间里的编排：①片约 → ②编剧 → ③分镜 → ④提示词 → ⑤生成（真跑 / 回放）。

与 Node 版 run.js 的三个约定保持一致，改一处就得改另一处：
  1. envelope 由程序覆盖（artifact_id / created_at / upstream_refs / producer），模型填的只是占位
  2. 结构校验用「gate 置为 approved 的副本」做，真实产物的 gate 恒为 pending
  3. LLM 失败不静默：降级到 contracts/examples.json 的示例产物，并把降级原因写进 notes 与界面
"""
import copy
import json
import os
import random
import re
import time

from . import config, generate, llm, prompts, validate

AGENTS = {
    "screenwriter": {
        "contract": "c02_screenplay",
        "title": "② 编剧",
        "producer": "screenwriter_agent",
        "prefix": "screenplay",
        "fallback": "c02_screenplay",
    },
    "storyboard": {
        "contract": "c03_shotlist",
        "title": "③ 分镜",
        "producer": "storyboard_agent",
        "prefix": "shotlist",
        "fallback": "c03_shotlist",
    },
    "prompt_writer": {
        "contract": "c04_gen_request",
        "title": "④ 提示词",
        "producer": "prompt_writer_agent",
        "prefix": "genreq",
        "fallback": "c04_gen_request",
    },
}

DEFAULT_RED_LINES = [
    "不得出现《黑客帝国》《银翼杀手2049》《2001太空漫游》《星际穿越》的角色、台词、造型、剧照与片名",
    "不得出现真实企业或机构的标识",
    "不得出现未成年人",
    "不得使用未授权的第三方素材",
]


def _now_iso():
    import datetime
    return datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()


def _stamp():
    return time.strftime("%Y%m%d-%H%M%S")


def _agent_version(slug):
    rel, _ = prompts.AGENT_PROMPTS[slug]
    path = os.path.join(config.ROOT, rel.replace("/", os.sep))
    src = open(path, encoding="utf-8").read()
    m = re.search(r"AGENT_VERSION\s*=\s*'([^']+)'", src)
    return m.group(1) if m else "0.0.0"


def build_brief(logline, duration=150, aspect_ratio="16:9 (Widescreen)",
                visual_style="", audio_style="", theme="", character=None):
    payload = {
        "logline": logline.strip(),
        "theme": (theme or "").strip() or "用 AI，提前看见未来",
        "target_duration_seconds": int(duration),
        "aspect_ratio": aspect_ratio,
        "visual_style": (visual_style or "").strip() or "冷色调电影质感，单一空间叙事，以屏幕辉光与光影变化为主要光源，特写与空镜为主",
        "red_lines": DEFAULT_RED_LINES,
        "gate": {
            "required": True,
            "status": "approved",
            "reviewer": "创空间访问者（提交 logline 的人）",
            "reviewed_at": _now_iso(),
            "reason": "c01 由人撰写，撰写者即审批者",
        },
    }
    if (audio_style or "").strip():
        payload["audio_style"] = audio_style.strip()
    if character:
        payload["main_character"] = character
    return {
        "envelope": {
            "schema_version": "1.0",
            "artifact_id": "brief.%s" % _stamp(),
            "contract": "c01_brief",
            "created_at": _now_iso(),
            "producer": {"kind": "human", "name": "创空间访问者"},
            "upstream_refs": [],
            "notes": "由创空间界面输入组装，未填项按契约默认值补齐",
        },
        "payload": payload,
    }


def _normalize(raw, spec, upstream_id, notes=""):
    """把模型输出套进契约外壳。payload 缺失直接抛——形状错了不能蒙混过关。"""
    payload = None
    if isinstance(raw, dict):
        if isinstance(raw.get("payload"), dict):
            payload = raw["payload"]
        elif isinstance(raw.get("scenes"), list):
            payload = raw
    if payload is None:
        raise llm.LlmError("输出缺少 payload（或顶层 scenes），无法规范化")
    return {
        "envelope": {
            "schema_version": "1.0",
            "artifact_id": "%s.%s" % (spec["prefix"], _stamp()),
            "contract": spec["contract"],
            "created_at": _now_iso(),
            "producer": {
                "kind": "agent",
                "name": spec["producer"],
                "agent_version": _agent_version(spec["_slug"]),
            },
            "upstream_refs": [upstream_id] if upstream_id else [],
            "notes": notes,
        },
        "payload": payload,
    }


def shape_problems(doc, contract):
    """结构校验：用 gate=approved 的副本，真实产物保留 pending。"""
    probe = copy.deepcopy(doc)
    gate = (probe.get("payload") or {}).get("gate")
    if isinstance(gate, dict):
        gate["status"] = "approved"
    ok, problems = validate.validate(contract, probe, check_gates=True)
    return problems


def call_agent(slug, upstream_doc, user_message, offline=False):
    """跑一个 LLM Agent。返回 (产物, 说明, 是否降级)。"""
    spec = dict(AGENTS[slug])
    spec["_slug"] = slug
    stamp = _stamp()
    upstream_id = (upstream_doc.get("envelope") or {}).get("artifact_id")

    if offline or not config.llm_api_key():
        doc = _fallback(slug, upstream_id, "未配置 LLM API Key" if not offline else "按离线模式要求不调用 LLM")
        return doc, "已降级为示例产物（形状合规，内容与本次 logline 无关）", True

    system = prompts.load_prompt(slug)
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_message},
    ]
    try:
        text = llm.chat(messages)
        doc = _normalize(llm.extract_json(text), spec, upstream_id, "LLM 生成")
        problems = shape_problems(doc, spec["contract"])
        if not problems:
            return doc, "LLM 生成并通过契约结构校验", False
        # 纠正一轮：把问题清单回灌给模型
        messages += [
            {"role": "assistant", "content": text},
            {"role": "user", "content": "上一轮输出未通过结构校验：\n- %s\n请按契约重新输出修正后的完整 JSON（仍只输出一个 JSON 代码块）。"
             % "\n- ".join(problems[:12])},
        ]
        text2 = llm.chat(messages)
        doc2 = _normalize(llm.extract_json(text2), spec, upstream_id, "LLM 生成（含一轮纠正重试）")
        problems2 = shape_problems(doc2, spec["contract"])
        if not problems2:
            return doc2, "LLM 生成并通过契约结构校验（含一轮纠正重试）", False
        raise llm.LlmError("纠正一轮后仍未通过结构校验：\n- " + "\n- ".join(problems2[:12]))
    except Exception as e:
        doc = _fallback(slug, upstream_id, "LLM 调用失败：%s" % e)
        return doc, "LLM 调用失败，已降级为示例产物：%s" % e, True


def _fallback(slug, upstream_id, reason):
    """降级：用 contracts/examples.json 里那份过检的示例产物，原因写进 notes。"""
    spec = dict(AGENTS[slug])
    spec["_slug"] = slug
    examples = json.load(open(os.path.join(config.CONTRACTS_DIR, "examples.json"), encoding="utf-8"))
    raw = copy.deepcopy(examples[spec["fallback"]])
    doc = _normalize(raw, spec, upstream_id, "%s；降级使用 examples.json 示例产物（形状合规，内容与本次 logline 无关）" % reason)
    payload = doc["payload"]
    if isinstance(payload.get("gate"), dict):
        payload["gate"].update({
            "required": True, "status": "pending", "reviewer": None, "reviewed_at": None,
            "reason": "剧本确认——强制人工关口，批准前下游 Agent 必须阻塞",
        })
    return doc


def generation_step(gen_request):
    """④生成：先探测隧道，可达就真生成，否则回放（回放一定标注）。"""
    reachable, detail = generate.probe_live()
    if not reachable:
        shots = generate.replay_shots()
        return {
            "mode": "replay",
            "detail": detail,
            "shots": shots,
            "note": generate.replay_note(),
        }

    prompt_text, seconds = _first_prompt(gen_request)
    try:
        pid = generate.submit_live(prompt_text, seconds, seed=random.randint(1, 2 ** 31 - 1))
        path, status = generate.poll_live(pid)
        if path:
            return {"mode": "live", "detail": detail, "shots": [path], "note": status, "prompt_id": pid}
        shots = generate.replay_shots()
        return {"mode": "replay", "detail": detail, "shots": shots,
                "note": "%s（本次为预生成回放）" % status, "prompt_id": pid}
    except Exception as e:
        shots = generate.replay_shots()
        return {"mode": "replay", "detail": detail, "shots": shots,
                "note": "真生成提交失败：%s。当前展示预生成回放" % e}


def _first_prompt(gen_request):
    """从 c04 里取第一个镜头的第一条提示词与时长。"""
    payload = gen_request.get("payload") or {}
    shots = payload.get("shots") or payload.get("requests") or []
    if isinstance(shots, dict):
        shots = list(shots.values())
    for s in shots:
        if not isinstance(s, dict):
            continue
        text = s.get("prompt") or s.get("prompt_text") or (s.get("workflow") or {}).get("prompt")
        if text:
            secs = s.get("duration_seconds") or s.get("seconds") or 5
            try:
                secs = float(secs)
            except Exception:
                secs = 5.0
            return text, max(3.0, min(secs, 8.0))
    return "cinematic science fiction shot, atmospheric, shallow depth of field", 5.0
