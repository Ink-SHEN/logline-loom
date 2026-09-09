# 设计稿 · 创空间"完整复刻本地 agent"落地路线图

> 状态：讨论稿（未动任何生产代码）
> 日期：2026-09-09（Day 5）
> 决策依据：用户多次澄清后定案 —— **强化现有 Spark loom_batch.py 调度器**（不引入 studio.mjs 主程序整套搬 Spark），
> 在「逐镜生成 + loom_qc 客观质检 + 换 seed 打回 + loom_edit 拼接」基础上逐块补本地缺失项；**截止 09-15 前稳扎稳打**，
> 每块独立可验证。视觉质检复用魔搭 api-inference 的 VL 模型（Qwen2.5-VL-72B 已下线，改用 Qwen3-VL）。

---

## 一、复刻目标与边界

| 项 | 内容 |
|---|---|
| 复刻对象 | 本地 `studio.mjs` 完整工作流（每镜多候选 → 全质检 → retry 回环 → LLM 剪辑决策 → 带字幕/转场渲染成片） |
| 落地形态 | **强化 Spark 端 Python 调度器**（loom_batch/loom_qc/loom_edit），创空间触发 + 展示 |
| 不做的 | 不把 studio.mjs 整套 Node 工程搬上 Spark（避免 Spark 装 node + 两套执行体并存） |
| 环境事实 | Spark 有 ffmpeg6.1.1+ffprobe+中文字体+ComfyUI；魔搭 api-inference 有 Qwen3-VL-8B/235B 等 VL 模型可复用 LLM key |

## 二、六块缺失项 → 补强方案（按依赖排序）

### 第 1 块 · 每镜多候选 + 择优（P0，最基础）
本地：c03 `batch_plan.candidates_per_shot`(默认3) → ③ 逐镜×每候选产多份 c04(不同 seed/candidate_id) → ⑦ 按质检 score 取最高。
现有：Spark 每镜只产 1 份(单 seed)，剪辑无选择。
补强：
- 创空间 `space/pipeline.py`：`build_all_gen_requests` 每镜产 **candidates_per_shot 份** c04（调 prompt_writer 时让它为每候选出不同 prompt/seed）；`batch_plan_to_workflows` 每镜转 N 个 workflow，`candidate_id` 用 `S00X_c0Y`，`prefix=film/S00X_c0Y`。
- Spark `loom_batch.py`：shot 记录改为存 N 个 candidate workflow，逐个生成；`_pick_next_pending` 按 candidate 粒度推进。
- Spark `loom_edit.py`：拼接前对每镜从过检候选里按 qc.score 取最高（先做 score 排序，LLM 决策单放第 4 块）。
验证：单测——N 镜×3 候选 → 调度器逐候选出片落盘 → 剪辑取每镜最高分候选拼接。

### 第 2 块 · 视觉质检(主观项)（P0）
本地：`--vision` 抽帧交视觉模型看画面判 prompt 遵循/角色场景一致/无伪影/红线，逐项评分。
现有：loom_qc 只客观 6 项，主观 7 项全 skipped。
补强：
- 新增 Spark `spark/loom_vision.py`：ffmpeg 抽帧(N 帧) → 组多模态请求(图 base64 + 提示词) → 调魔搭 api-inference VL 模型 → 得主观项评分。模型默认 `Qwen/Qwen3-VL-235B-A22B-Instruct`，LLM key 复用 loom_batch 的（创空间 secrets 注入或 Spark loom.env 补）。
- `loom_qc.py`：客观项过检后，若配了 vision key，则追加主观项评分，合成完整 c06（verdict/score 综合）。
验证：Spark 真实 mp4 → 抽帧 → 视觉模型返回主观项分数 → c06 含主观项。

### 第 3 块 · retry 回环重写 c04（P1）
本地：质检 fail→retry Agent 读失败原因**重写 c04**(改描述/参数)→换候选多轮回环收敛(默认3轮)。
现有：只"换 seed 重跑同一份 c04"。
补强：
- 打回时不再只换 seed，而是**回到创空间侧 ④ 重新调 prompt_writer**，把该镜质检失败原因(failed_items+详情)作为用户消息，让它重写一版 c04 → 重新生成。
- 因创空间会休眠，回环起点放 Spark：Spark 收到"需重写"信号后，经隧道回调创空间 ④？——这引入反向调用，复杂。
  **更稳替代**：把"重写 c04"也做成 Spark 可调——但 ④ 是创空间 Agent。
  现实折中：**回环在创空间发起时就在单次会话内做**（④为每镜首先生成 N 候选；质检 fail 的镜，创空间再次调 ④ 重写，最多3轮，全部在用户点"开始"的那一次 run_pipeline 内完成，然后才下发 Spark 生成）——把"重写收敛"从生成期挪到提交前的准备期，规避休眠。这条需在第 1 块落地后重新审视时序。
验证：offline 跑 run_pipeline，构造一个必然 fail 的镜，确认 ④ 收到失败原因重写 c04。

### 第 4 块 · LLM 剪辑决策单择优（P1）
本地：editor LLM 读 c03+各镜 c06 → 出 c07 决策单(每镜选候选/时间线/字幕/叠化/AI标识)。
现有：loom_edit 按 shot 序直拼、无选择。
补强：
- Spark 侧新增 `spark/loom_editor.py`（或并入 loom_edit）：收集各镜过检候选 + 其 c06/score + c03 描述 → 调 LLM(文本) 出简化 c07(每镜选最优候选 + 顺序 + 是否叠化) → 自动批(gate=approved, reviewer=auto)。
- loom_edit 渲染时按 c07 选中的候选列表拼，而非"所有 done"。
验证：Spark 造多候选批次 → editor LLM 出 c07 → 渲染取正确候选。

### 第 5 块 · 字幕/AI 标识/叠化（P2）
本地：slideshow.mjs 用 .ass 字幕 + AI 标识卡 + xfade/acrossfade 叠化 + 首末淡入淡出 + loudnorm。
现有：loom_edit 硬切直拼。
补强：
- loom_edit.py 渲染加：AI 生成标识卡(片头/片尾，opening_and_ending)、镜头间叠化(xfade 0.5s)、首镜淡入/末镜淡出、loudnorm。字幕需字幕内容(来自 c02 对白/editor) 若第 4 块 editor 没产字幕则跳过字幕只做标识+过渡。
验证：Spark 拼 2 镜真实片 → 检查成片含 AI 标识卡、镜头间叠化过渡、时长正确。

### 第 6 块 · 人工关口自动批（随各块）
本地：②c02 剧本批、⑦c07 决策单批(强制人工)。
现有：创空间 auto_gate 已自动批②(c02)。c07 走 LLM(第4块) 后同样 gate=approved reviewer=auto。
补强：c07 决策单 gate 设 auto-approve，串成整链无人值守。**这是策略，随第 4 块落地。**

## 三、建议分批与验证节奏（09-15 前）

| 批 | 内容 | 部署 | 截止目标 |
|---|---|---|---|
| A | 第1块 多候选+择优 | Spark+创空间 | 9-10 |
| B | 第2块 视觉质检 | Spark(+创空间secrets) | 9-11 |
| C | 第3块 retry回环(挪到准备期收敛) | 创空间为主 | 9-12 |
| D | 第4+5块 剪辑决策+渲染增强 | Spark | 9-13 |
| E | 第6块 收尾 + 端到端真机验证 | 双端 | 9-13/14 |

> 每批独立冒烟 + 单测 + 局部真机，不一次大改 Spark 生产。评审前一天(09-14) loom_status 全绿。
> 所有改动不碰已跑的 ComfyUI/隧道；loom_batch 重启窗口短，避开真实生成任务。

## 四、诚实风险
1. **视觉质检**：依赖魔搭 VL 模型对 H3 抽帧画面判得准不准（主观项本就有主观性）；抽帧+VL 增加每镜耗时与调用成本。
2. **retry 回环挪到准备期**：改变了"生成后才发现问题再修"的语义——只在"提交前把提示词收敛好"，生成期仍只靠换 seed/候选兜底。这与本地"生成后质检打回重写"有本质差别，需如实告知评审。
3. **第4块 LLM 出 c07**：editor 逻辑 887 行，Spark 端只做"选最优候选+顺序"的简化版，不含本地那套字幕/红线自检的完整推理。
4. 改动频繁重启 Spark 调度器：窗口避开真实生成，用 loom_health 兜底。
