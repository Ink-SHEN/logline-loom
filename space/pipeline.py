# -*- coding: utf-8 -*-
"""创空间里的编排：①片约 → ②编剧 → ③分镜 → ④提示词。

⑤ 生成站不在这里：它是一层可插拔的模型 API 接口，见 space/generate.py。
本模块只负责 Agent 之间的契约交接与闸门。

与 Node 版 run.js 的三个约定保持一致，改一处就得改另一处：
  1. envelope 由程序覆盖（artifact_id / created_at / upstream_refs / producer），模型填的只是占位
  2. 结构校验用「gate 置为 approved 的副本」做，真实产物的 gate 恒为 pending
  3. LLM 失败不静默：降级到 contracts/examples.json 的示例产物，并把降级原因写进 notes 与界面
"""
import copy
import json
import os
import re
import time

from . import config, llm, prompts, validate

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
                visual_style="", audio_style="", theme="", character=None,
                requested_shots=None):
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
    if requested_shots:
        reqs = [s.strip() for s in requested_shots if s and s.strip()]
        if reqs:
            payload["requested_shots"] = reqs
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
        else:
            # 模型经常直接吐 payload 本体而不套 `payload` 键（c03 是 {shots:[...]}，
            # c02 是 {scenes:[...]}）。这里按契约统一收：除 envelope/payload 外
            # 剩下的就是 payload。形状对不对交给后面的契约校验去判，不要在这里误杀。
            body = {k: v for k, v in raw.items() if k not in ("envelope", "payload")}
            if body:
                payload = body
    if payload is None:
        raise llm.LlmError("输出缺少 payload，无法规范化")
    doc = {
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
    if spec["contract"] == "c04_gen_request":
        doc = _inject_node_ids(doc)
    return doc


def shape_problems(doc, contract):
    """结构校验：用 gate=approved 的副本，真实产物保留 pending。"""
    probe = copy.deepcopy(doc)
    gate = (probe.get("payload") or {}).get("gate")
    if isinstance(gate, dict):
        gate["status"] = "approved"
    ok, problems = validate.validate(contract, probe, check_gates=True)
    return problems


def contract_skeleton(contract, max_depth=3):
    """从契约 schema 生成「最小必填结构」骨架，用来喂给模型。

    之前模型三次都没按契约输出（c04 只给了 shot_id/prompt/timecodes 三个字段），
    根因是提示词里只有自然语言描述、没有结构。这里直接从 contracts/ 那份权威
    schema 推导骨架：契约一改，提示自动跟着改，不用再维护第二份描述。
    """
    path = os.path.join(config.CONTRACTS_DIR, "film_agent_contracts.json")
    spec = json.load(open(path, encoding="utf-8"))
    defs = spec.get("$defs", {})

    def resolve(s):
        if isinstance(s, dict) and "$ref" in s:
            ref = s["$ref"].split("/")[-1]
            merged = dict(defs.get(ref, {}))
            merged.update({k: v for k, v in s.items() if k != "$ref"})
            return merged
        return s or {}

    def build(s, depth):
        s = resolve(s)
        if "const" in s:
            return s["const"]
        if "enum" in s and s["enum"]:
            return s["enum"][0]
        props, req = s.get("properties") or {}, s.get("required") or []
        if s.get("type") == "object" or props:
            out = {}
            for k in req:
                if k not in props:
                    out[k] = "<?>"
                elif depth <= 0:
                    out[k] = "<%s>" % (resolve(props[k]).get("type", "any"))
                else:
                    out[k] = build(props[k], depth - 1)
            return out
        if s.get("type") == "array":
            # 给空数组而不是占位符：占位符会被模型当成示例值照抄
            # （实测把 ref_images 填成了 "<Picture 1>" 这种说明文字）。
            # 空数组既表明类型，又让模型按语义决定填不填。
            return []
        hint = s.get("type") or "any"
        # 把 pattern 写进占位符。只说「string」模型会填成 'c01'，
        # 而契约要的是 'S001_c01'——格式约束必须让模型看得见。
        if s.get("pattern"):
            hint = "%s，必须匹配正则 %s" % (hint, s["pattern"])
        lo, hi = s.get("minimum"), s.get("maximum")
        if lo is not None or hi is not None:
            hint = "%s，取值 %s~%s" % (hint, lo if lo is not None else "-∞", hi if hi is not None else "+∞")
        return "<%s>" % hint

    node = defs.get(contract) or {}
    sk = build((node.get("properties") or {}).get("payload") or {}, max_depth)
    # node_ids 是工程常量，由 _inject_node_ids 从 node_id_map.json 注入，
    # 不给模型填——让它猜节点 ID 既违反契约（明写「禁止硬编码」）又必然出错。
    if contract == "c04_gen_request" and isinstance(sk.get("workflow"), dict):
        sk["workflow"].pop("node_ids", None)
    return sk


def _clean_assets(assets):
    """参考素材数组里只保留形状合法的 asset_ref（object），其余丢掉。

    asset_ref 要求 node_filename / source_path / license 三个字段，而模型
    常常直接填文件名字符串（'watchman_character_sheet.png'）——留着必然过不了校验，
    丢掉反而能保住这一轮的输出。
    """
    if not isinstance(assets, dict):
        return {}
    out = {}
    for key, value in assets.items():
        if key in ("ref_images", "ref_videos", "ref_audios"):
            if isinstance(value, list):
                keep = [x for x in value if isinstance(x, dict)]
                if keep:
                    out[key] = keep
            elif isinstance(value, dict):
                out[key] = value
        else:
            out[key] = value
    return out


def _inject_node_ids(doc):
    """c04 的 workflow.node_ids 由程序从 workflows/node_id_map.json 注入。

    契约写得很死：「从 node_id_map.json 抄来的 {语义: [节点ID, 键名]}，禁止硬编码节点 ID，
    T2V/I2V 的 ID 是子图摊平后的复合编号如 '140:131'」。这类确定性映射让 LLM 生成
    只会出错，和 envelope 一样属于程序该覆盖的部分。
    """
    payload = doc.get("payload")
    workflow = payload.get("workflow") if isinstance(payload, dict) else None
    if not isinstance(workflow, dict):
        return doc

    # 契约对 assets 有三条条件规则（T2V 不得带素材 / I2V 必须有 first_frame /
    # R2V 必须有非空 ref_images）。asset_ref 要 node_filename + source_path + license
    # 三个字段，模型十次有九次填不出来——选了 R2V 就等于必然过不了校验。
    # 素材填不合规时统一回退 T2V：首镜用文生视频本来就是最合理的默认，
    # 也比让整轮产物降级成示例更贴近真实内容。
    wtype = str(workflow.get("type") or "").upper()
    assets = _clean_assets(payload.get("assets")) if wtype != "T2V" else {}
    if wtype == "I2V" and not isinstance(assets.get("first_frame"), dict):
        wtype = "T2V"
        assets = {}
    elif wtype == "R2V" and not assets.get("ref_images"):
        wtype = "T2V"
        assets = {}
    workflow["type"] = wtype
    payload["assets"] = assets

    api = str(workflow.get("api_json") or "")
    kind = wtype.lower() if wtype.lower() in ("t2v", "i2v", "r2v") else "t2v"
    if kind not in api:
        workflow["api_json"] = "workflow_api_%s.json" % kind
    try:
        mapping = json.load(open(os.path.join(config.WORKFLOWS_DIR, "node_id_map.json"), encoding="utf-8"))
        fields = (mapping.get(kind) or {}).get("fields") or {}
    except Exception:
        return doc
    node_ids = {"source": "workflows/node_id_map.json"}
    for semantic, spec in fields.items():
        if isinstance(spec, dict) and spec.get("node") and spec.get("key"):
            node_ids[semantic] = [spec["node"], spec["key"]]
    if len(node_ids) > 1:
        workflow["node_ids"] = node_ids
    return doc


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
    # 按站取模型：允许创意环节（编剧）上更强的大模型，结构化环节走快的。
    model = config.llm_model(slug)
    skeleton = json.dumps(contract_skeleton(spec["contract"]), ensure_ascii=False, indent=2)
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content":
            "%s\n\n下面是 `%s` 契约要求的最小结构（由 contracts/ 里的 schema 自动生成）。"
            "照它填充，必填字段一个都不能少，也不要在 payload 里多加字段：\n```json\n%s\n```"
            % (user_message, spec["contract"], skeleton)},
    ]
    try:
        # 纠正闭环：把校验器报出的问题清单回灌给模型重生成。
        # 一轮不够（实测 c04 只有 1/3 一次过），放到 3 轮——这本身就是
        # 「反馈闭环、重试和可观测性 6%」要展示的东西，重试次数也如实写进 notes。
        fix_rounds = config.llm_fix_rounds()
        text = llm.chat(messages, model=model)
        for attempt in range(fix_rounds + 1):
            doc = _normalize(
                llm.extract_json(text), spec, upstream_id,
                "LLM 生成" + ("（含 %d 轮纠正重试）" % attempt if attempt else ""))
            problems = shape_problems(doc, spec["contract"])
            if not problems:
                return doc, ("LLM 生成并通过契约结构校验"
                             + ("（含 %d 轮纠正重试）" % attempt if attempt else "")), False
            if attempt >= fix_rounds:
                raise llm.LlmError("纠正 %d 轮后仍未通过结构校验：\n- " % fix_rounds
                                   + "\n- ".join(problems[:12]))
            messages += [
                {"role": "assistant", "content": text},
                {"role": "user", "content":
                    "上一轮输出未通过结构校验：\n- %s\n"
                    "请逐条修正后重新输出完整的 JSON（仍只输出一个 JSON 代码块，不要省略字段）。"
                    % "\n- ".join(problems[:12])},
            ]
            text = llm.chat(messages, model=model)
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
