# -*- coding: utf-8 -*-
"""LOOM · 电影 Agent —— 魔搭创空间入口。

创空间要求入口文件在仓库根目录，所以 app.py 放在这里，
它只是界面壳：真正的编排在 space/pipeline.py，契约校验复用 contracts/，
Agent 的人格（system prompt）运行时从 agents/*/prompt.js 读——三处都只有一份。

用法（本地）：  pip install -r requirements.txt && python app.py
"""
import copy
import json
import os

import gradio as gr

from space import config, generate, pipeline, prompts, tunnel, validate

TITLE = "LOOM · 一句话生成 AI 短片的电影 Agent"
INTRO = """
**输入一句 logline，看 7 个 Agent 是怎么把它变成一部片子的。**

LOOM = **L**ogline-**O**riented **O**rchestration **M**achine。7 个 Agent 之间只通过**版本化的 JSON 契约**交接，
每一步的产物都留在界面上可查、可反查，并且**每一步都要过 contracts/ 里那份权威校验器**。
"""


def self_check():
    lines = []
    ok, problems = _selftest()
    lines.append("- 契约自检（`--selftest`，7 份示例）：%s" % ("**7/7 通过**" if ok else "不通过：%s" % "; ".join(problems[:3])))
    lines.append("- LLM：%s（模型 `%s`）" % ("已配置" if config.llm_api_key() else "**未配置** LOOM_LLM_API_KEY", config.llm_model()))
    reachable, detail = generate.probe_live()
    lines.append("- 真生成后端（方案 A）：%s —— %s" % ("已连通" if reachable else "未连通，将走回放", detail))
    lines.append("- 回放素材（方案 B）：%d 段" % len(generate.replay_shots()))
    return "\n".join(lines)


def tunnel_status(force=False):
    """隧道地址状态。force=True 会重新探一遍所有候选地址。"""
    if force:
        tunnel.current(force=True)
    return tunnel.status_lines()


def _mount_tunnel_api(demo):
    """挂两个 HTTP 端点，让 Spark 能把「当前隧道地址」主动报过来。

    natapp 免费隧道的域名可能变。变的时候如果只能靠人去改 secrets，
    评审那几天就是个定时炸弹——所以让 Spark 自己把新地址送上门。
    鉴权用和代理同一个 token：token 对不上，谁也别想把我指到别的机器上。
    """
    app = getattr(demo, "app", None) or getattr(demo, "fastapi", None)
    if app is None:
        return False
    try:
        from fastapi import Request
        from fastapi.responses import JSONResponse
    except Exception:
        return False

    @app.post("/loom/tunnel/report")
    async def _report(req: Request):
        try:
            body = await req.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "请求体不是 JSON"}, status_code=400)
        ok, msg = tunnel.save_reported(body.get("url", ""), body.get("token", ""))
        return JSONResponse({"ok": ok, "detail": msg}, status_code=200 if ok else 403)

    @app.post("/loom/tunnel/current")
    async def _current():
        url, detail = tunnel.current(force=True)
        return {"url": url, "detail": detail, "candidates": [u for u, _ in tunnel.candidates()]}

    return True


def _selftest():
    examples = json.load(open(os.path.join(config.CONTRACTS_DIR, "examples.json"), encoding="utf-8"))
    problems = []
    for name, inst in examples.items():
        if not str(name).startswith("c0"):  # 跳过 examples.json 里的 _说明 等元数据键
            continue
        ok, p = validate.validate(name, inst, check_gates=False)
        if not ok:
            problems.append("%s: %s" % (name, p[0]))
    return (not problems), problems


def _fmt(doc):
    return json.dumps(doc, ensure_ascii=False, indent=2)


def run_pipeline(logline, duration, aspect, visual_style, audio_style, auto_gate, offline):
    """主流程。逐段 yield，界面上能看到 Agent 一个个往下走。"""
    if not logline or len(logline.strip()) < 20:
        yield "**请至少输入 20 个字的一句话故事**（契约 c01_brief 对 logline 的硬性要求）。", None, None, None, None, None
        return
    if len(logline.strip()) > 400:
        yield "**logline 超过 400 字**，契约 c01_brief 上限是 400。", None, None, None, None, None
        return

    logs = []

    def emit(status):
        return "\n\n".join(logs) + "\n\n" + status,

    # ① 片约
    brief = pipeline.build_brief(logline, duration=duration, aspect_ratio=aspect,
                                 visual_style=visual_style, audio_style=audio_style)
    ok, problems = validate.validate("c01_brief", brief, check_gates=True)
    logs.append("**① 片约 c01_brief**：%s" % ("通过契约校验" if ok else "不通过：%s" % "; ".join(problems[:3])))
    yield "\n\n".join(logs), brief, None, None, None, None

    # ② 编剧
    logs.append("**② 编剧 Agent**：正在生成剧本…")
    yield "\n\n".join(logs), brief, None, None, None, None
    screenplay, note, degraded = pipeline.call_agent(
        "screenwriter", brief,
        "片约（c01_brief，artifact_id=%s）：\n%s\n\n"
        "请把它展开成完整剧本，**3–5 个场景**（太少撑不起叙事，太多后续生成不切实际），"
        "按契约只输出一个 JSON 代码块。"
        % (brief["envelope"]["artifact_id"], json.dumps(brief["payload"], ensure_ascii=False, indent=2)),
        offline=offline)
    logs[-1] = "**② 编剧 Agent**：%s" % note

    gate_note = ""
    if auto_gate:
        screenplay = validate.approve_gate(screenplay, "创空间自动批准（演示模式）", "评审演示：一句 logline 全自动跑通")
        gate_note = "> ⚠️ 剧本关口已由界面【自动批准】。默认 `gate.status` 是 `pending`，未批准时下游必须阻塞。"
    else:
        gate_note = "> ⛔ 剧本关口保持 `pending`，下游已阻塞。勾选「自动批准」后重跑才能继续。"
    yield "\n\n".join(logs) + "\n\n" + gate_note, brief, screenplay, None, None, None
    if not auto_gate:
        logs.append("**流程在人工关口处停止**（这是设计意图，见 `agents/README.md` 第六节）。")
        yield "\n\n".join(logs), brief, screenplay, None, None, None
        return

    # ③ 分镜
    logs.append("**③ 分镜 Agent**：正在拆镜头…")
    yield "\n\n".join(logs), brief, screenplay, None, None, None
    shotlist, note, _ = pipeline.call_agent(
        "storyboard", screenplay,
        "剧本（c02_screenplay，artifact_id=%s，剧本确认关口已批准）：\n%s\n\n"
        "画幅锁定 %s。请把它拆成镜头清单，**6–8 个镜头**（每个镜头后续都要送 MiniMax-H3 真生成，"
        "单镜头约 6–12 分钟，镜头过多整条管线跑不完），按契约只输出一个 JSON 代码块。"
        % (screenplay["envelope"]["artifact_id"], json.dumps(screenplay["payload"], ensure_ascii=False, indent=2), aspect),
        offline=offline)
    logs[-1] = "**③ 分镜 Agent**：%s" % note
    yield "\n\n".join(logs), brief, screenplay, shotlist, None, None

    # ④ 提示词
    logs.append("**④ 提示词 Agent**：正在写英文提示词…")
    yield "\n\n".join(logs), brief, screenplay, shotlist, None, None
    # c03 已经给首镜定了 workflow_type，c04 必须沿用——分镜说 T2V 就不能自己改成 R2V，
    # 否则参考图那一串字段会跟着错。
    shots_c03 = (shotlist.get("payload") or {}).get("shots") or []
    first_type = "T2V"
    if shots_c03 and isinstance(shots_c03[0], dict):
        first_type = shots_c03[0].get("workflow_type") or "T2V"

    genreq, note, _ = pipeline.call_agent(
        "prompt_writer", shotlist,
        "镜头清单（c03_shotlist，artifact_id=%s）：\n%s\n\n"
        "请为**第一个镜头（S001）**生成生成请求：英文提示词 + 时间码 + 节点 ID 映射。\n"
        "⚠️ c04 契约的 payload 是**单个镜头对象**（required: shot_id / candidate_id / "
        "workflow / generation / assets），**不是数组**——只输出这一个镜头的 JSON 代码块。\n"
        "⚠️ 该镜头在 c03 里标注的 workflow_type 是 **%s**，必须沿用，不要改。"
        % (shotlist["envelope"]["artifact_id"], json.dumps(shotlist["payload"], ensure_ascii=False, indent=2), first_type),
        offline=offline)
    logs[-1] = "**④ 提示词 Agent**：%s" % note
    yield "\n\n".join(logs), brief, screenplay, shotlist, genreq, None

    # ⑤ 生成
    logs.append("**⑤ 生成 Agent**：正在探测 Spark 上的 ComfyUI…")
    yield "\n\n".join(logs), brief, screenplay, shotlist, genreq, None
    res = pipeline.generation_step(genreq)
    gallery = [(p, os.path.basename(p)) for p in res["shots"]]
    if res["mode"] == "live":
        tail = "**⑤ 生成 Agent**：真生成完成（%s，prompt_id=%s）" % (res["note"], res.get("prompt_id", "-"))
    elif res["mode"] == "live_async":
        tail = ("**⑤ 生成 Agent**：已向 Spark 提交真生成任务\n\n"
                "- %s\n- 探针：%s" % (res["note"], res["detail"]))
    else:
        tail = ("**⑤ 生成 Agent**：⚠️ **本次为预生成回放**，不是实时生成。\n\n"
                "- 原因：%s\n- 探针：%s" % (res["note"] or "隧道不可达", res["detail"]))
    logs[-1] = tail
    yield "\n\n".join(logs), brief, screenplay, shotlist, genreq, gallery


def query_generation(prompt_id):
    """取回已提交的真生成任务结果。"""
    pid = (prompt_id or "").strip()
    if not pid:
        return "请填任务 ID（提交真生成后，状态栏会给出）。", None
    r = generate.query_task(pid)
    if r["status"] == "done":
        return ("**真生成完成**（用时 %d 秒）：%s" % (r.get("elapsed", 0), r["detail"]),
                [(r["path"], os.path.basename(r["path"]))])
    label = {"queued": "排队中", "running": "生成中", "unknown": "未找到"}.get(r["status"], r["status"])
    return "任务状态：**%s** — %s" % (label, r["detail"]), None


def build_ui():
    with gr.Blocks(title=TITLE) as demo:
        gr.Markdown("# " + TITLE)
        gr.Markdown(INTRO)
        gr.Markdown(self_check())

        with gr.Row():
            with gr.Column(scale=3):
                logline = gr.Textbox(
                    label="一句话故事（logline，20–400 字）",
                    placeholder="例：一位独自值守射电望远镜阵列的夜班技师，在最后一个班次里收到一段来自自己未来的信号。",
                    lines=3)
                with gr.Row():
                    duration = gr.Slider(60, 300, value=150, step=10, label="目标时长（秒）")
                    aspect = gr.Dropdown(["16:9 (Widescreen)", "1:1 (Square)", "9:16 (Portrait)"],
                                         value="16:9 (Widescreen)", label="画幅")
                with gr.Row():
                    visual_style = gr.Textbox(label="视觉风格（可留空用默认）", lines=2)
                    audio_style = gr.Textbox(label="声音风格（可留空）", lines=2)
                with gr.Row():
                    auto_gate = gr.Checkbox(value=True, label="自动批准人工关口（演示模式）")
                    offline = gr.Checkbox(value=False, label="离线模式（不调 LLM，只看管线形状）")
                run_btn = gr.Button("开始生成", variant="primary")

            with gr.Column(scale=4):
                status = gr.Markdown("等待输入…")

        with gr.Tabs():
            with gr.Tab("① 片约 c01"):
                c01 = gr.JSON(label="c01_brief")
            with gr.Tab("② 剧本 c02"):
                c02 = gr.JSON(label="c02_screenplay")
            with gr.Tab("③ 分镜 c03"):
                c03 = gr.JSON(label="c03_shotlist")
            with gr.Tab("④ 提示词 c04"):
                c04 = gr.JSON(label="c04_gen_request")
            with gr.Tab("⑤ 生成结果"):
                gallery = gr.Gallery(label="镜头（真生成 / 预生成回放）", columns=3, height=320)

        run_btn.click(run_pipeline,
                      inputs=[logline, duration, aspect, visual_style, audio_style, auto_gate, offline],
                      outputs=[status, c01, c02, c03, c04, gallery])

        with gr.Accordion("隧道状态（创空间 ↔ DGX Spark 回源链路）", open=False):
            gr.Markdown(
                "真生成跑在本地 DGX Spark 的 ComfyUI 上。Spark 没有公网入口，"
                "由它上面的 natapp 客户端主动外拨、在云端换一个公网地址，创空间访问这个地址回源。"
                "natapp 免费隧道的地址**可能变**，所以这里不写死一个地址："
                "Spark 每 5 分钟把当前地址报过来，用时再逐个探活。")
            tunnel_md = gr.Markdown(tunnel_status())
            with gr.Row():
                refresh_tunnel_btn = gr.Button("重新解析隧道地址", scale=1)
            refresh_tunnel_btn.click(lambda: tunnel_status(force=True), outputs=[tunnel_md])

        with gr.Accordion("查询生成任务（取回真生成视频）", open=False):
            gr.Markdown(
                "真生成跑在本地 DGX Spark 的 ComfyUI 上，MiniMax-H3 一个镜头要 6–12 分钟，"
                "**不会同步等出片**——提交后立刻返回任务 ID，界面先给参考预览。"
                "把任务 ID 粘进来就能查进度、取回成片。（容器重启会清空任务记录）")
            with gr.Row():
                task_id = gr.Textbox(label="任务 ID（prompt_id）", scale=3, placeholder="例：a1b2c3d4-...")
                query_btn = gr.Button("查询", scale=1)
            task_status = gr.Markdown("")
            task_video = gr.Gallery(label="真生成结果", columns=2, height=260)
            query_btn.click(query_generation, inputs=[task_id], outputs=[task_status, task_video])

        # 生成器逐段 yield 依赖队列；不开队列时界面会停在「等待输入…」不更新
        demo.queue(default_concurrency_limit=4)
        _mount_tunnel_api(demo)

        gr.Markdown("""
---
### 七站是怎么分的（创空间里跑 ①–⑤，⑥⑦ 仍在本地节点）

| 站 | 契约 | 职责 | 本次运行 |
|---|---|---|---|
| ① 片约 | c01 | 人写一句话，定死后面不能改的东西 | 界面输入 |
| ② 编剧 | c02 | 展开成带场景编号的剧本（**强制人工关口**） | 真跑 |
| ③ 分镜 | c03 | 拆镜头，逐镜标注 T2V / I2V / R2V | 真跑 |
| ④ 提示词 | c04 | 英文提示词 + 时间码 + 节点 ID 映射 | 真跑 |
| ⑤ 生成 | c05 | POST 到 Spark 上的 ComfyUI（MiniMax-H3） | 隧道可达则真跑，否则标注回放 |
| ⑥ 质检 | c06 | ffprobe 硬指标 + 提示词遵循度 | 本地节点 |
| ⑦ 剪辑 | c07 | 剪辑决策单（**强制人工关口**） | 本地节点 |

代码与全部契约：<https://github.com/Ink-SHEN/logline-loom>
""")
    return demo


if __name__ == "__main__":
    demo = build_ui()
    demo.launch(server_name="0.0.0.0", server_port=7860)
