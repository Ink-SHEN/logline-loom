# -*- coding: utf-8 -*-
"""LOOM · 电影 Agent —— 魔搭创空间入口。

创空间要求入口文件在仓库根目录，所以 app.py 放在这里，
它只是界面壳：真正的编排在 space/pipeline.py，契约校验复用 contracts/，
Agent 的人格（system prompt）运行时从 agents/*/prompt.js 读——三处都只有一份。

⑤ 生成站：创空间**不内置视频生成模型**，它是一层可插拔的模型 API 接口
（契约见 space/generate.py 头部）。界面会把这一点直接写出来。

用法（本地）：  pip install -r requirements.txt && python app.py
"""
import json
import os
import random

import gradio as gr

from space import config, generate, pipeline, theme, validate

TITLE = "LOOM · 一句话生成 AI 短片的电影 Agent"
INTRO = """
**输入一句 logline，看 7 个 Agent 是怎么把它变成一部片子的。**

LOOM = **L**ogline-**O**riented **O**rchestration **M**achine。7 个 Agent 之间只通过**版本化的 JSON 契约**交接，
每一步的产物都留在界面上可查、可反查，并且**每一步都要过 contracts/ 里那份权威校验器**。

> ### ⑤ 生成站是一层可插拔的模型 API 接口
> 本创空间**不内置、也不绑定任何具体的视频生成模型**。①–④ 站把一句话拆成**逐镜头的标准化生成请求**（英文提示词 + 时长 + 画幅），
> ⑤ 站对外只暴露**一个模型 API 接口**：把请求发出去、把成片取回来。
> 接入任意满足该契约的生成服务只需配 3 个环境变量，**Agent 代码一行都不用改**；当前状态与完整契约见 **「⑤ 生成接口」** 标签页。
"""


def self_check():
    lines = []
    ok, problems = _selftest()
    lines.append("- 契约自检（`--selftest`，7 份示例）：%s"
                 % ("**7/7 通过**" if ok else "不通过：%s" % "; ".join(problems[:3])))
    lines.append("- LLM：%s（模型 `%s`）"
                 % ("已配置" if config.llm_api_key() else "**未配置** LOOM_LLM_API_KEY",
                    config.llm_model()))
    lines.append("- " + generate.status_lines())
    lines.append("- 示例素材：%d 段（`space/fallback/`，仅作产物形态预览，不代表有模型在跑）"
                 % len(generate.clips()))
    return "\n".join(lines)


def gen_interface_status():
    """⑤ 生成接口的当前状态（界面用，永远说真话）。"""
    b = generate.active()
    ok, detail = b.available()
    return ("**当前后端**：%s —— %s\n\n%s\n\n> 状态取值：**已接入** = 配好模型服务，⑤ 站会真提交；"
            "**未接入** = 接口已就绪但没有模型，④ 的生成请求会照常产出，⑤ 站如实显示「等待接入模型」。"
            % (b.title, detail, b.describe()))


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


def _st(done=0, running=None, blocked=None):
    """构造七站进度状态列表。

    前 done 站标 done；running / blocked 用站序号（1–7）指定；
    ⑥质检 ⑦剪辑 恒为 local——它们跑在创空间之外的本地节点上，这里永远不点亮。
    """
    s = ["pending"] * 7
    for i in range(min(done, 5)):
        s[i] = "done"
    if running:
        s[running - 1] = "running"
    if blocked:
        s[blocked - 1] = "blocked"
    s[5] = "local"
    s[6] = "local"
    return s


def run_pipeline(logline, duration, aspect, visual_style, audio_style, requested_shots, auto_gate, offline):
    """主流程。逐段 yield，界面上能看到 Agent 一个个往下走。

    输出共 7 个：[status, c01, c02, c03, c04, gallery, progress]。
    第 7 个（七站进度条）刻意**追加在末尾**——这样前 6 个的索引不变，
    外部按位置取值的调用方（含线上验证脚本 /gradio_api/call/run_pipeline）不受影响。
    所有 yield 一律走 emit()，避免漏改某一个导致解包报错。
    """
    def emit(text, states, brief=None, screenplay=None, shotlist=None, genreq=None, gallery=None):
        return (text, brief, screenplay, shotlist, genreq, gallery, theme.progress_html(states))

    if not logline or len(logline.strip()) < 20:
        yield emit("**请至少输入 20 个字的一句话故事**（契约 c01_brief 对 logline 的硬性要求）。", _st())
        return
    if len(logline.strip()) > 400:
        yield emit("**logline 超过 400 字**，契约 c01_brief 上限是 400。", _st())
        return

    logs = []

    # ① 片约
    reqs = []
    if requested_shots:
        reqs = [s for s in requested_shots.splitlines() if s and s.strip()]
    brief = pipeline.build_brief(logline, duration=duration, aspect_ratio=aspect,
                                 visual_style=visual_style, audio_style=audio_style,
                                 requested_shots=reqs)
    ok, problems = validate.validate("c01_brief", brief, check_gates=True)
    logs.append("**① 片约 c01_brief**：%s" % ("通过契约校验" if ok else "不通过：%s" % "; ".join(problems[:3])))
    yield emit("\n\n".join(logs), _st(done=1), brief=brief)

    # ② 编剧
    logs.append("**② 编剧 Agent**：正在生成剧本…")
    yield emit("\n\n".join(logs), _st(done=1, running=2), brief=brief)
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
    yield emit("\n\n".join(logs) + "\n\n" + gate_note,
               _st(done=2) if auto_gate else _st(done=1, blocked=2),
               brief=brief, screenplay=screenplay)
    if not auto_gate:
        logs.append("**流程在人工关口处停止**（这是设计意图，见 `agents/README.md` 第六节）。")
        yield emit("\n\n".join(logs), _st(done=1, blocked=2), brief=brief, screenplay=screenplay)
        return

    # ③ 分镜
    logs.append("**③ 分镜 Agent**：正在拆镜头…")
    yield emit("\n\n".join(logs), _st(done=2, running=3), brief=brief, screenplay=screenplay)
    shotlist, note, _ = pipeline.call_agent(
        "storyboard", screenplay,
        "剧本（c02_screenplay，artifact_id=%s，剧本确认关口已批准）：\n%s\n\n"
        "画幅锁定 %s。请把它拆成镜头清单，**6–8 个镜头**（每个镜头都要产出一份独立的生成请求），"
        "按契约只输出一个 JSON 代码块。"
        % (screenplay["envelope"]["artifact_id"], json.dumps(screenplay["payload"], ensure_ascii=False, indent=2), aspect),
        offline=offline)
    logs[-1] = "**③ 分镜 Agent**：%s" % note
    yield emit("\n\n".join(logs), _st(done=3), brief=brief, screenplay=screenplay, shotlist=shotlist)

    # ④ 提示词：为分镜表里每个镜头各生成一份 c04（逐镜头生成请求）
    shots_n = len(((shotlist.get("payload") or {}).get("shots")) or [])
    logs.append("**④ 提示词 Agent**：正在为每个镜头写英文提示词…（%d 个镜头逐个生成）" % shots_n)
    yield emit("\n\n".join(logs), _st(done=3, running=4), brief=brief, screenplay=screenplay, shotlist=shotlist)
    gen_items, gen_note, gen_degraded = pipeline.build_all_gen_requests(shotlist, offline=offline)
    genreq_first = gen_items[0]["c04"] if gen_items else None
    logs[-1] = "**④ 提示词 Agent**：%s" % gen_note
    yield emit("\n\n".join(logs), _st(done=4), brief=brief, screenplay=screenplay, shotlist=shotlist, genreq=genreq_first)

    # ⑤ 生成：不内置模型，把 ④ 的生成请求交给可插拔的模型 API 接口
    logs.append("**⑤ 生成站**：正在把逐镜生成请求交给模型 API 接口…")
    yield emit("\n\n".join(logs), _st(done=4, running=5), brief=brief, screenplay=screenplay,
               shotlist=shotlist, genreq=genreq_first)

    result = generate.run_c05(genreq_first, offline=offline,
                              seed=random.randint(1, 2 ** 31 - 1),
                              aspect_ratio=aspect, prefix="loom/S001")
    gallery = [(p, os.path.basename(p)) for p in result.get("shots") or []]

    if result["mode"] == "api":
        task = result["task"] or {}
        logs[-1] = (
            "**⑤ 生成站** ✅ 生成请求已提交到模型接口（后端 `%s`）\n\n"
            "- 任务 ID：`%s`\n- 接口状态：%s\n- 本次下发：S001（④ 共产出 %d 份同形状的逐镜请求，"
            "接口接通后按同一入口逐个下发即可）\n\n%s\n\n下方播放的是示例素材，**不是本次生成的结果**。"
            % (result["backend"], task.get("task_id", "-"), result["detail"],
               len(gen_items), result["note"]))
    else:
        logs[-1] = (
            "**⑤ 生成站**：%s\n\n- 接口状态：%s（后端 `%s`）\n- 逐镜生成请求：④ 已产出 %d 份"
            % (result["note"], result["detail"], result["backend"], len(gen_items)))

    yield emit("\n\n".join(logs), _st(done=5), brief=brief, screenplay=screenplay,
               shotlist=shotlist, genreq=genreq_first, gallery=gallery)


def query_generation(task_id):
    """取回 ⑤ 站提交给模型接口的生成任务结果。"""
    tid = (task_id or "").strip()
    if not tid:
        return ("请填任务 ID（提交成功后状态栏会给出，形如 `a1b2c3d4-…`）。", None)
    r = generate.query(tid)
    if r["status"] == "succeeded":
        path = r.get("path") or ""
        msg = "**生成完成**（用时 %d 秒）：%s" % (r.get("elapsed", 0), r["detail"])
        return (msg, [(path, os.path.basename(path))] if path else None)
    label = {"queued": "排队中", "running": "生成中", "failed": "失败",
             "unknown": "未找到"}.get(r["status"], r["status"])
    return "任务状态：**%s** — %s" % (label, r["detail"]), None


def build_ui():
    with gr.Blocks(title=TITLE) as demo:
        gr.Markdown("# " + TITLE)
        gr.Markdown(INTRO)

        with gr.Row():
            with gr.Column(scale=3):
                logline = gr.Textbox(
                    label="一句话故事（logline，20–400 字）",
                    placeholder="用一句话讲完整个故事：谁 + 在什么场景 + 遇到什么 → 结局怎样。越具体越好，但别展开成段落。例：一位独自值守射电望远镜阵列的夜班技师，在最后一个班次收到一段来自自己未来的信号。",
                    lines=3)
                with gr.Row():
                    duration = gr.Slider(60, 300, value=150, step=10, label="目标时长（秒）")
                    aspect = gr.Dropdown(["16:9 (Widescreen)", "1:1 (Square)", "9:16 (Portrait)"],
                                         value="16:9 (Widescreen)", label="画幅")
                with gr.Row():
                    visual_style = gr.Textbox(
                        label="视觉风格（可选，留空则 AI 自定）",
                        placeholder="例：冷蓝调赛博朋克夜景；低饱和胶片颗粒；水墨风留白",
                        lines=2)
                    audio_style = gr.Textbox(
                        label="声音风格（可选，留空则 AI 自定）",
                        placeholder="例：低沉环境音 + 心跳节拍；空灵合成器；雨声与无线电杂音",
                        lines=2)
                requested_shots = gr.Textbox(
                    label="特定镜头设计（可选）",
                    placeholder="你想在片子里一定要看到的镜头，每行一个，最好写清景别 / 动作 / 画面。例：\n一个主角逆光回头的正面特写，身后屏幕全亮\n俯拍主角走过空无一人的城市广场，只有路灯依次亮起",
                    lines=3)
                with gr.Row():
                    auto_gate = gr.Checkbox(value=True, label="自动批准人工关口（演示模式）")
                    offline = gr.Checkbox(value=False, label="离线模式（不调 LLM，只看管线形状）")
                run_btn = gr.Button("开始生成", variant="primary")

            with gr.Column(scale=4):
                # 七站进度条。它显示在 status 上方，但在 outputs 里排在**末尾**——
                # 组件位置与数据流顺序解耦，这样前 6 个输出的索引不受影响。
                progress = gr.HTML(theme.progress_html(), padding=False)
                status = gr.Markdown("等待输入…", elem_classes=["loom-status"])

        with gr.Tabs(elem_classes=["loom-tabs"]):
            with gr.Tab("① 片约 c01"):
                c01 = gr.JSON(label="c01_brief")
            with gr.Tab("② 剧本 c02"):
                c02 = gr.JSON(label="c02_screenplay")
            with gr.Tab("③ 分镜 c03"):
                c03 = gr.JSON(label="c03_shotlist")
            with gr.Tab("④ 提示词 c04"):
                c04 = gr.JSON(label="c04_gen_request")
            with gr.Tab("⑤ 生成接口"):
                # 这一页是「设计说明书」本身：⑤ 站接什么、怎么接、现在接没接，
                # 全部写成文字放在这里，评审不用读代码就能判断。
                gr.Markdown(generate.interface_markdown())
                gr.Markdown(gen_interface_status())
                gallery = gr.Gallery(label="产物形态预览（示例素材 / 接口返回的成片）",
                                     columns=3, height=320)

        run_btn.click(run_pipeline,
                      inputs=[logline, duration, aspect, visual_style, audio_style,
                              requested_shots, auto_gate, offline],
                      outputs=[status, c01, c02, c03, c04, gallery, progress])

        # 自检是运维信息（LLM 配置 / 生成接口状态 / 示例素材数），放在契约产物之后：
        # 它不该占首屏——评审一进来先看到「未配置」「未接入」会直接扣分。
        # 折叠且默认关闭，想确认系统状态的人自然会找到它。
        with gr.Accordion("运行状态自检", open=False):
            gr.Markdown(self_check())

        with gr.Accordion("查询生成任务（取回模型接口产出的视频）", open=False):
            gr.Markdown(
                "⑤ 站把生成请求提交给模型接口后，会拿到一个**任务 ID**。"
                "把任务 ID 粘进来即可查询进度、取回成片（容器重启会清空任务记录）。")
            with gr.Row():
                task_id = gr.Textbox(label="任务 ID（task_id）", scale=3, placeholder="例：a1b2c3d4-...")
                query_btn = gr.Button("查询", scale=1)
            task_status = gr.Markdown("")
            task_video = gr.Gallery(label="生成结果", columns=2, height=260)
            query_btn.click(query_generation, inputs=[task_id], outputs=[task_status, task_video])

        # 生成器逐段 yield 依赖队列；不开队列时界面会停在「等待输入…」不更新
        demo.queue(default_concurrency_limit=4)

        gr.Markdown("""
---
### 七站是怎么分的（创空间里跑 ①–⑤，⑥⑦ 在创空间之外的本地节点）

| 站 | 契约 | 职责 | 本次运行 |
|---|---|---|---|
| ① 片约 | c01 | 人写一句话，定死后面不能改的东西 | 界面输入 |
| ② 编剧 | c02 | 展开成带场景编号的剧本（**强制人工关口**） | 真跑 |
| ③ 分镜 | c03 | 拆镜头，逐镜标注 T2V / I2V / R2V | 真跑 |
| ④ 提示词 | c04 | 逐镜头产出标准化生成请求（英文提示词 + 时间码 + 画幅） | 真跑 |
| ⑤ 生成 | c05 | **可插拔的模型 API 接口**：把请求发出去、把成片取回来 | 接口就绪（未绑定模型） |
| ⑥ 质检 | c06 | ffprobe 硬指标 + 提示词遵循度 | 本地节点 |
| ⑦ 剪辑 | c07 | 剪辑决策单（**强制人工关口**） | 本地节点 |

代码与全部契约：<https://github.com/Ink-SHEN/logline-loom>
""")
    return demo


if __name__ == "__main__":
    demo = build_ui()
    # Gradio 6 关键：theme / css 是**应用级**参数，必须传给 launch()。
    # 写成 gr.Blocks(theme=..., css=...) 不会报错，只发一条 UserWarning，样式被静默忽略。
    demo.launch(server_name="0.0.0.0", server_port=7860,
                theme=theme.build_theme(), css=theme.CUSTOM_CSS)
