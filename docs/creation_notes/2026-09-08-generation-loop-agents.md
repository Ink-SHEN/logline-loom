# 创作手记 · 09-08（Day 4）生成回环三站：④生成 / ⑤质检 / ⑥重试 从零建起来，把「烧 GPU → 判 → 再烧」闭成一个机器拦得住的环

> 本段素材最终并入 09-13 提交用的《魔搭开发者实践创作手记》（衔接 09-08《生成回环的三项约定》决策记录：反缓存不变量、⑥ 的权限边界、⑤ 的证据边界，本段是把那三项约定落成三个可执行的 Agent；对应 kickoff [`2026-09-04-kickoff.md`](../decisions/2026-09-04-kickoff.md) 第四节 B「owns **生成 Agent**、**重试 Agent**」与 C「owns 分镜 Agent、提示词 Agent、**质检 Agent**」——这三站跨了两个人的分工，边界正好是 `c05`/`c06` 两道契约；日程表把 B 的「生成 Agent 打通 ComfyUI API」排在 Day 2 · 09-06、C 的「质检 Agent + 重试闭环」排在 Day 3 · 09-07，B 的 FL2VA 批次批量生成也在 Day 3 开工）。
> 范围：④生成 从零新建 `agents/generator/`（自包含 ComfyUI 客户端 + 填图 + ffprobe 硬指标测量）、⑤质检 推倒重写 `agents/qa/`（审查对象从「审分镜」改回「审产物视频」）、⑥重试 从零新建 `agents/retry/`（打补丁产出新的 c04，把流程退回 ④）。三家串起来是流水线里唯一的一个**回环**，也是唯一碰 GPU 的一段。

---

## 〇、本段一句话

**把「上一批 c04 → 烧 GPU → 逐候选判 13 项 → 判不过就照着 ⑤ 的方子打一份新 c04 → 回 ④ 重烧」这个环闭合起来：④ 只填图提交与实测落盘、⑤ 只判不修、⑥ 只修不判，`verdict` / `route_to` / `retry_count` / `suggested_change` / 新 `seed` / 新 `candidate_id` 全部由代码算，一行都不交给概率模型；三站的每一次「做不了」都落成一份带转交对象与可复制命令行的阻塞记录，而不是一个 exit 1。**

本段（三站代码）**没有改契约 Schema**；配套的三项约定单独立为决策记录 [`2026-09-08-generation-loop-conventions.md`](../decisions/2026-09-08-generation-loop-conventions.md)。`--selftest` 7/7、`negative_test.py` 8/8 复跑通过，`git status contracts/` 为空。

---

## 一、起点：三家各撞一个先天矛盾，且互相都拿不到真材料

①②③⑦ 是「一份进、一份出」的直线工位，写它们的时候只要管好契约形状。④⑤⑥ 不一样，这三家一上来各撞一个矛盾，而且它们串起来是**环**不是线：

1. **④ 是七站里唯一碰 GPU 的一站，而 ComfyUI 没有鉴权**。节点地址一旦写进仓库就等于把一个无鉴权的 GPU 入口公开出去（`docs/node_baseline.md`：`--listen 127.0.0.1`「**ComfyUI 完全没有鉴权**。绑公网等于把节点交出去，必须只监听回环 + SSH 隧道」）。所以地址必须走环境变量、`.gitignore` 里预留位置，代码一行都不能读死。同时 `tools/comfyui.mjs` 在组员本地没上传——④ 不能等它，得自带一份客户端。
2. **⑤ 的初稿在审错对象**。仓库里原有的 `agents/qa/` 审的是 c03 分镜文本，但 c06 的 13 项检查里有 6 项是产物视频的硬指标（时长 / 帧率 / 分辨率 / 有无视频流 / 有无音频流 / 音频规格），**只有真产物能判**，读分镜文本永远判不出来。而另外 7 项主观项（提示词遵循度、角色一致性、画面崩坏…）反过来只有人或视觉模型能判，代码判不了。一份 c06 里同时躺着「必须机器判」和「机器判不了」两类项，这就是 ⑤ 的全部难点。
3. **⑥ 产出的契约与 ③ 是同一道（c04_gen_request），但它不是 ③**。它不写提示词、不选素材、不定工作流类型，它只是把上一份 c04 复制过来改几个字段。更要命的是 **ComfyUI 对完全相同的输入 0–1.4 秒返回旧文件**（README 第六节实测：缓存命中 21–24 个节点），所以「重试」这个动作如果只换 seed 不换 `filename_prefix`，拿回来的就是同一个坏产物、还会盖掉上一次的归档——白烧一轮 GPU，追溯链当场断掉。

外加一个共同的现实约束：**三家都拿不到真材料**。本机没有渲染节点（DGX Spark 在另一台 ARM64 机器上）、没有真产物视频、没有真 ffprobe 输出。所以三站都必须能在「上游全是夹具」的条件下自检到能自证的程度，真机联调留给素材到位之后（见第六节）。

**决定：把三站的权限切成互不重叠的三块——④ 只执行与实测、⑤ 只判定、⑥ 只打补丁**，谁都不许替谁做决定；三个先天矛盾各自显式化解（④ 地址三级回退 + 自带客户端 + 全节点缓存命中判失败，设计 1–2；⑤ 13 项按证据来源拆成两堆、判不了的老实记 `skipped`，设计 3–6；⑥ 5 键白名单 + seed 独占 + 做不了就转交而不是报错，设计 7–10）。

---

## 二、做了什么（文件级清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `agents/generator/comfyui.js` | 新增（282 行） | **自包含 ComfyUI 客户端**，零依赖原生 fetch：上传素材到 `/upload/image`、POST `/prompt`、轮询 `/history/<id>`、下载产物、读 `/queue`。地址三级回退 `--endpoint` > `LOOM_COMFY_URL` > `http://127.0.0.1:8188`，**代码不读 `comfy_endpoint.txt`**（那个文件在 `.gitignore` 里，要用就自己从里面导出环境变量）。`parseHistory()` 顺带数出 `cachedNodes`，那是反缓存判定的唯一依据 |
| `agents/generator/graph.js` | 新增（240 行） | 把 c04 填进工作流图。节点 ID **一律从 `workflows/node_id_map.json` 现查**，从不硬编码；按语义键落值（`steps_normal` / `steps_turbo` 二选一，跟着 `turbo_enabled` 走）；**硬卡 `steps` 与 `turbo_enabled` 自洽**（R2V turbo 4 / 其余 turbo 8 / 不开 turbo 20），不自洽就拒——手动改步数只改一半画面会崩（`docs/gpu_protocol.md` 第六节）；素材位按映射表 `image_inputs` 的 role 顺序接，序号即提示词里 `<Picture N>` 的 N |
| `agents/generator/ffprobe.js` | 新增（166 行） | 硬指标测量：时长 / 平均帧率 / 宽高 / 有无视频流 / 有无音频流 / 音频采样率与声道数。**没有 ffprobe 就明确报「测不了」**，不猜、不编、不静默降级成 c05 里的转述值 |
| `agents/generator/run.js` | 新增（919 行） | 可执行管线（CLI + 可编程双入口）：收 c04 → 逐份过 python 契约校验（**一份不合格整批拒收**）→ 按 `WEIGHT_FAMILY` 排序提交（FL2VA 批 = T2V+I2V 连跑，Ref2VA 批 = R2V 单独时段，两套权重不能同时常驻）→ POST → 轮询 → **全节点缓存命中判失败**（部分命中才警告）→ 下载产物到 `shots/<候选>/` → ffprobe 实测 → 写 `meta.json`（就是 c05 实例）→ 追加 `docs/task_registry.md`。`--dry-run` 只出提交计划与填好的图，不 POST、不碰 GPU，是这一站唯一的离线自检方式 |
| `agents/generator/sample.js` | 新增（149 行） | c05 形状的活文档 + 下游 mock 上游的现成输入。`params_snapshot` 带实测的 seed / steps / 帧数，`ffprobe` 段带六项硬指标的实测值——⑤ 就是靠读它判客观项的 |
| `agents/generator/index.js` | 新增（27 行） | `meta` 带 `contract: 'c05_gen_result'`、`promptExport: null`（**④ 不调 LLM**：它是执行站，没有一处需要判断；且渲染节点上本来也没有文本模型，见 `agents/README.md` 第八节） |
| `agents/qa/run.js` | 新增（1023 行） | ⑤ 推倒重写后的主体。**审查对象是产物视频不是分镜文本**：客观 6 项由 ffprobe 实测值 + 代码硬判、模型全程不参与；主观 7 项只认三个来源（`--review` 人工侧清单 > `--vision` 抽帧 + 视觉模型 > `skipped` 未复核）；`verdict` / `route_to` / `retry_count` / `suggested_change` 全由代码算（`score` 例外：它只认证据来源给的值，代码只在有客观硬伤时把它压到 3.0，见设计 6）。产物不在本地就明说「只按 c05 记下的实测值判，且无法重测对账」，不假装重测过 |
| `agents/qa/vision.js` | 新增（106 行） | 抽帧 + 视觉通道。`VISION_SCOPE` 写死它**能判哪几项**：静帧看得出构图 / 一致性 / 崩坏，看不出运动是否平滑、也听不到声音，所以 `motion_quality` 与 `audio_matches_scene` 永不走这条通道 |
| `agents/qa/llm.js` | 新增（118 行） | 第五份共享客户端副本（①②③⑤⑦ 各一份，`tools/agent.mjs` 入库后去重）。OpenAI Chat Completions 兼容、原生 fetch、零依赖 |
| `agents/qa/prompt.js` | 重写 | 质检员人格 + **只输出 7 个主观项判定**的中间形状模板（另带 `root_cause` 与一个 `score`）。人格里明确写「你不做的事」：客观项（时长 / 帧率 / 分辨率 / 有无音轨）一律不判，`verdict` / `route_to` / `suggested_change` / `retry_count` 一律不定，没看过的项不许发明。`score` 是 0–10 一位小数、**只用于同一镜头多候选排序**，prompt 里原话「它是参考不是决定，别为了排序好看而抬分」，缺失就由代码省略该字段、不许编。纯文本通道（无抽帧）的 `TEXT_SCOPE` 只有一项 `no_red_line_violation`——只有它比的是文字 |
| `agents/qa/sample.js` | 重写 | c06 形状的活文档，13 项 `checks` 按 `CHECK_ORDER` 固定次序排；**两份都是 `runQa` 真跑出来的**，只把 `created_at` 钉成固定值。`sampleQA`（S001_c01）= `pass_with_notes` / 转 `edit`，带一处主观软伤 `no_visual_artifact`，`action=raise_megapixels` + `patch:{megapixels:1}`（那正是 `megapixels` 的归属动作，合法）；`sampleQAFail`（S002_c01）= `fail` / 转 `retry`，客观硬伤 `has_audio_stream` + 主观硬伤 `prompt_adherence`，`action=new_seed` 且 **`patch` 是空对象**（seed 分配权归 ⑥，见设计 8）。文件头另记三处容易被当成 bug 的地方（notes 里的「未校 sha256」、`score` 是 `3` 不是 `3.0`、`created_at` 用 UTC 的 `Z`） |
| `agents/qa/sample_review.json` | 新增（90 行） | 人工复核侧清单格式示例：键 = `candidate_id`，值 = 逐项判定 + 谁看的 + 什么时候看的。与 ③ 的 `sample_assets.json`、⑦ 的 `sample_subtitles.json` 同一处理方式（人工维护的侧输入，不走契约） |
| `agents/qa/index.js` | 更新 | `meta.role` 改成「审产物视频」；导出 `runQa`、`sampleQA` + `sampleQAFail`、视觉与 LLM 两套工具。**本站故意不带 `ffprobe.js`**：④ 那份的语义是「没装 ffprobe 就硬阻塞」，⑤ 要的是「缺了就降级采信 c05 并大声告警」，失败语义相反，合不成一个模块 |
| `agents/retry/run.js` | 新增（927 行） | ⑥ 主体，**一行 LLM 都不调**。收 c06 的 fail 分支（`route_to=retry`）→ 逐份过 python 契约校验 → 深拷贝上一份 c04 → 按白名单打补丁 → 分配新 `candidate_id`（已有最大号 +1，扫 `--requests` 与 `shots/` 两处取最大值，再确认目录不存在）与新 `seed`（上一次的 + 1000003，再对着这个镜头用过的每一个 seed 查重）→ JS 结构自检 + python 契约校验 → 落盘。做不了的写 `needs_human.md`，逐条注明转交哪一站、下一步命令是什么 |
| `agents/retry/sample.js` | 新增（166 行） | **两份都是 `runRetry` 的实跑输出**，只钉住 `created_at` 与 `artifact_id` 时间戳，其余逐字段相同（有 deep-diff 脚本为证）。一份 T2V + `new_seed`（patch 为空），一份 R2V + `change_duration`（时间码等比重排 4s→8s、提示词里的 `[Xs-Ys]` 标记同步重排、`assets.ref_images` 与 `workflow.node_ids` 逐字节原样沿用）。文件头记了完整输入来历与复现命令，另附**五处容易被当成 bug 的地方**逐条说明为什么不是 |
| `agents/retry/index.js` | 新增（19 行） | `meta` 带 `contract: 'c04_gen_request'`（与 ③ 同一道契约：⑥ 是把流程退回 ④，不是新开一道交接面）、`promptExport: null` |
| `docs/decisions/2026-09-08-generation-loop-conventions.md` | 新增（135 行） | 三项约定的 ADR：反缓存不变量、⑥ 的权限边界、⑤ 的证据边界。含当时的已知信息、备选方案与否决理由、五条重新审视的触发条件。跨 B 的 ④⑥ 与 C 的 ⑤；不改 Schema 所以 `docs/agent_guide.md` 第八节那 5 步不适用，但它给两站各加了一条对方必须遵守的规矩，比照第八节「三人一致同意」的口径需 B、C 追认 |
| `docs/decisions/README.md` | 更新 | 追加索引行 |
| `agents/README.md` | 更新 | 状态表 ④⑤⑥ 三行 `⬜ 待建` → `✅`；第五节整节改标「**已全部解决**，保留作对照」（表格留着是因为它解释了当前代码为什么长这样）；第五节 ⑤ 小节补一张**四层 `route_to` 分流表**；「对象错位」小节记「**已裁定：走 (a)**」；第八节改成「五个站调 LLM（①②③⑤⑦）」并划清视觉 / 纯文本通道的边界；**新增第九节「七站怎么跑」**——逐站带注释的 ①→⑦ CLI 走查 + 四条提醒 |
| `README.md` | 更新 | 第五节第 3 条从「手抄 workflow JSON 再 POST」改成指向 `node agents/generator/run.js --requests … [--dry-run]`；订正节点地址的来源口径 |

---

## 三、关键设计决策（为什么这么做）

### 1. ④ 自带 ComfyUI 客户端，地址三级回退，代码绝不读那个存地址的文件

`tools/comfyui.mjs` 在组员本地没上传，等它 ④ 就动不了。所以 `agents/generator/comfyui.js` 自带一份零依赖客户端（原生 fetch，不引包）。地址口径是 `--endpoint` > `LOOM_COMFY_URL` > `http://127.0.0.1:8188`——**代码不读 `comfy_endpoint.txt`**：那个文件在 `.gitignore` 里预留着，谁要用就自己从里面 `export` 环境变量。让代码去读一个「可能存有真实地址」的文件，等于把一次误提交的后果从「泄露一个字符串」升级成「仓库里的代码指着那个字符串跑」。默认值取回环地址，是因为按 `docs/gpu_protocol.md` 唯一合法的访问方式就是 SSH 隧道，隧道口本来就在 127.0.0.1。

### 2. 全节点缓存命中判**失败**，不是警告

ComfyUI 对完全相同的输入 0–1.4 秒返回旧文件。④ 从 `/history` 里数出 `cachedNodes`，`cachedNodes.length >= job.nodeCount` 就直接抛错，`--allow-cached` 才放行；部分命中只记警告（那很正常，VAE 与文本编码器本来就该被缓存）。理由：全命中意味着**这一轮根本没生成新东西**，拿回来的 mp4 是上一次的旧文件。要是放它过去，⑤ 会对着一个旧产物判一轮、⑥ 会再开一张方子、⑦ 可能把它剪进成片——而 GPU 排班表上这一格已经烧掉了。宁可在这里硬停。

### 3. ⑤ 的 13 项按「谁能拿出证据」拆成两堆，而不是按「重要不重要」

客观 6 项（时长 / 帧率 / 有无视频流 / 有无音频流 / 音频规格 / 分辨率与宽高比）由 ffprobe 实测值 + 代码硬判，**LLM 全程不参与**——`docs/agent_guide.md` 第七节 ⑤质检 那行的坑「能确定性判定的事**不要交给 LLM**」，`agents/README.md` 第八节说得更狠：「**永远不要交给 LLM**——能确定性判定的事不要交给概率模型」。主观 7 项反过来，代码判不了，只认三个来源，优先级 `--review` 人工侧清单 > `--vision` 抽帧 + 视觉模型 > `skipped`（未复核）。这条分界线不是审美选择：它决定了 c06 里哪些字段是**测量结果**、哪些是**判断**，而下游 ⑥ 要照着 c06 打补丁、⑦ 要照着 c06 选候选，两类东西混在一起就没法追责。

### 4. 判不了的项老实记 `skipped`，绝不伪装成 pass

没有 `--review` 也没有 `--vision` 时，让 LLM 读 c04 的提示词与 c05 的元数据「推断」画面质量，技术上做得到——那就是伪造判决。c06 是下游决定要不要再烧一轮 GPU 的依据：一份没人看过画面的 pass 会让人白等一轮，一份没人看过画面的 fail 会让人白烧一轮。所以 ⑤ 把没人真看过的主观项记成 `status: 'skipped'`，再按 `--on-unreviewed human|edit`（默认 `human`，与契约「判不了的走 human」一致）分流。**`skipped` 的项算「已覆盖」不算「缺失」**——13 项一项都不能少，但少的是证据，不是条目。同理，`VISION_SCOPE` 之外的项（`motion_quality` / `audio_matches_scene`）即使给了 `--vision` 也记 `skipped`：静帧看不出运动是否平滑，也听不到声音。

### 5. 容差是实测倒推出来的，不是拍的

`DURATION_TOLERANCE = 0.75` 秒，是两件事叠出来的：① H3 的 `ComfyMathExpression` 把帧数对齐到 `≡5 mod 17`——写 6 秒出 141 帧（= 5.875s）、写 5 秒出 124 帧（= 5.167s），24fps 下一个对齐步长就是 17/24 ≈ 0.708s；② `duration_seconds` 取的是**容器**时长（ffprobe 的 `format.duration`，各条流的最大值），音轨常比视频轨长几帧，所以 S001 的容器是 6.083s 而视频流只有 141 帧。「时长 × 24 = 帧数」这个等式在本项目根本不成立，拿它做精确判定一定误判。容差取 0.75 就是「一个对齐步长」：比它严会把正常对齐判成失败，比它松就抓不到真的时长错。`FPS_TOLERANCE = 0.5`：fps 是模板常量 24，测出别的值说明图没填对或产物被转码过，0.5 只是给容器封装的舍入留余地。两个数都写在代码常量上并在 `detail` 里说出依据，判 fail 时人能看到「差多少、超了多少、为什么这个阈值」。

### 6. 判定与路由全部代码算，LLM 只管主观项

⑤ 是唯一一个「LLM 参与判定」的站，但它的 LLM 只被允许输出三样东西：7 个主观项各自的 pass/fail 与理由、一句 `root_cause`、一个 `score`（`score` 见下）。其余全部由代码按确定性规则算：

- `verdict`：有客观 fail 或主观硬伤就是 `fail`（`HARD_SUBJECTIVE = {prompt_adherence, character_consistency, no_red_line_violation}`，这三项任一 fail 不给 `pass_with_notes` 的余地）；只剩观感类软伤是 `pass_with_notes`；13 项一项都没 fail 才是 `pass`。
- `route_to`：`decide()` 四层分流——① fail → `retry`，但 `retryCount >= maxRetries` 时改判 `human` 且 `suggested_change` 换成 `manual_intervention`（这道闸就是防无限烧 GPU 的）；② 只剩软伤 → 有未复核项就看 `--on-unreviewed`，否则 `edit`；③ 只有未复核项 → 看 `--on-unreviewed`；④ 全过 → `edit`。`suggested_change` 由 `pickAction()` 按失败项挑动作，**只是建议，不参与路由**。
- `retry_count`：`--retry-count` 手工值 ?? 数 `--requests` 里同镜头 `retry_of` 非空的 c04 份数 ?? 0，两者都拿不到就大声告警「无法数出本镜头已重试几次」。
- `score`：**本站不算它**。只认证据来源给的值（人工侧清单的 `score`，或 LLM 中间形状的 `score`），两边都没给就整个字段不写。代码对它只做一件事——有客观硬伤时压到 `SCORE_CAP_ON_OBJECTIVE_FAIL = 3.0` 并告警，因为 `score` 只用于多候选排序，客观硬伤不该被主观高分掩盖。

把 `verdict` / `route_to` 交给 LLM，等于让下游的 GPU 排班由一个概率数决定。

### 7. ⑥ 是打补丁不是重写：5 键白名单，且每个键各归一个动作管

⑥ 深拷贝上一份 c04，只改 `PATCH_TARGETS` 里的 5 个键（`seed` / `duration_seconds` / `megapixels` / `prompt` / `turbo_enabled`），`workflow.node_ids`、`api_json`、`assets` 素材位与提示词正文原样沿用。白名单之外的键一律拒并说明归谁管（`PATCH_REFUSALS` + `PATCH_OWNER` 查表，不从拒绝文本里猜路由）。

两处是复核之后才定下来的：

- **`steps` 不在白名单里**。它不是旋钮，是 `workflow.type` + `turbo_enabled` 的派生值，④ 的 `graph.js` 会硬卡两者自洽——单独打一个 `patch.steps` 只可能产出一份 ④ 当场拒收的 c04。初版把它列进白名单，实测 `action=new_seed` + `patch.steps:12` 会让整批 throw。要改步数就开 `enable_turbo`，步数由 ⑥ 按机型算。
- **白名单里的键还各归一个动作管**（`PATCH_ACTION`，`seed` 除外——它是本站自己的账）。c06 的 `action` 说的是意图、`patch` 说的是细节，两者打架时 ⑥ 一律打回 ⑤质检 重开，不猜哪个算数。初版是「照 action 走、把多余的键悄悄丢掉」，实测 `action=new_seed` + `patch.megapixels:1.0` 会产出一份**分辨率没动过**的新 c04：⑤ 开的方子被静默吞掉，下一轮大概率照原样再失败，而控制台与 `envelope.notes` 里一个字都没提。反过来「白名单内一律照抄」也不行，最坏的是 `patch.duration_seconds`——它绕过 `change_duration` 分支的时间码重排，产出一份 `duration_seconds` 与 `timecodes` 对不上的 c04。

### 8. seed 的分配权只归 ⑥ 一站，步长取质数

「换 seed」听起来谁都能填，但**只有 ⑥ 同时看得见三处 seed 来源**：上一批 c04 里的、`shots/<候选>/meta.json` 的 `params_snapshot.seed`（实测快照，产物不入库时它就在别人机器上）、以及本次运行已经分配出去的。⑤ 判定时看得见 c04，但看不见 `shots/`。避让逻辑只能有一份，所以放在 ⑥；⑤ 的 `sampleQAFail`（`action=new_seed`）里 `suggested_change.patch` 因此是**空对象**——那是有意的，不是漏写（另一份 `sampleQA` 是 `action=raise_megapixels` 带 `patch:{megapixels:1}`，那正是 `megapixels` 的归属动作，合法）。步长取 `1_000_003`（质数）而不是 +1：等差递增的 seed 在扩散不好的采样器上会呈现可见的规律，取质数让相邻重试落到不相关的区域。撞车就按同样步长继续跳，跳 1000 次还撞就报错请人工指定。

这条规矩 ⑤ 的 `pickAction()` 每个分支都守着：`change_duration` 只带 `duration_seconds`、`raise_megapixels` 只带 `megapixels`，`new_seed` / `manual_intervention` / `change_reference_asset` / `rewrite_prompt` 一律 `patch:{}`（`rewrite_prompt` 故意不代填 `patch.prompt`——写提示词是 ③ 的活，⑥ 拿到空 patch 就打回 ③）。所以 **⑤ 正常开出来的方子永远撞不上 ⑥ 的归属检查**，会撞上的只有人手改过的 c06；两站的边界因此是可测的，不是靠自觉。

### 9. ⑥ 的「做不了」是 exit 0 + `needs_human.md`，不是 exit 1

越权不是故障，是权限边界。exit 1 会让上游以为 ⑥ 坏了；实际发生的是「这张方子本站开不出来，得换个人开」。所以 ⑥ 把这些落成 `needs_human.md`：逐条记原始候选、action、拒绝理由、**转交哪一站**、以及一条可直接复制的下一步命令行。c06 的 8 个 action 里有 4 个整条打回（`switch_workflow_type` → ②分镜；`change_reference_asset` → 人工改素材清单 → ③提示词；`rewrite_prompt` 而 patch 里没给 prompt → ③提示词；`manual_intervention` → 人工），加上白名单外的键、归属对不上的键、`retry_count` 达上限。

**`needs_human.md` 是每阻塞一次就重写一遍的，不是循环结束后写一次**：⑥ 后面还有几处是整批 throw 的硬错误（自检不过、契约校验不过、盘上材料互相矛盾），真炸的时候这一批已经攒下的转交事项不能跟着一起丢。同理，**契约校验不过的那份 c04 会先删掉再抛**——④ 扫 `--requests` 下的每个 `*.json`，一份不合格就让整批被拒，留在盘上等于给下一轮埋雷。

### 10. 时间码等比重排是机械的，装不下就打回

`change_duration` 要把 `timecodes` 与提示词里的 `[Xs-Ys]` 标记一起按新时长重排（首尾相接、从 0 开始、收在 `ceil(新时长)`、每段至少 1 秒）。这是机械重排不是创意重写：每一段演什么没变，只是节奏被拉长或压短，所以 ⑥ 做。但两件事 ⑥ 不做——**原件时间码不是首尾相接**就打回 ③（不猜中间那段空档是什么），**新时长装不下原有分段数**也打回 ③（合并分段或删段是重写节奏）。后者是复核时补的：初版硬压下去会让「每段至少 1 秒」的下限被「给后面留出空间」的上限反压过来，5 段压进 4 秒吐出 `[0s-0s]`（合契约 pattern、过得了本站自检、白烧一轮 GPU），6 段压进 4 秒吐出 `[0s--1s]`（整批 throw）。

`rewrite_prompt` 分支同理要**逐一比对标记值**，不能只数个数：新提示词写 `[0s-3s][3s-6s]` 而 `timecodes` 还是 `[0s-2s][2s-5s]` 时，个数一样、自检也只数个数，于是一份「模型看到的分段与契约记录的分段分家」的 c04 就混过去了——那正是 `change_duration` 分支宁可打回也不肯造的东西。

---

## 四、验证（全部实测，不是声称）

夹具全部按契约形状造，跑在 `tmp/`（`.gitignore` 里）与仓库外的临时目录，跑完即删——`artifacts/` **没有**被 gitignore，绝不留残渣（④ 的 `--dry-run` 照样会写一个计划目录，试跑一律 `--plan-dir tmp/…`）。

| 场景 | 结果 |
|---|---|
| 契约自检 / 反向测试 | `--selftest` **7/7**、`negative_test.py` **8/8**，`git status contracts/` 为空（**Schema 零改动**） |
| 七站示例产物 | 全部过自己 `meta.contract` 声明的那道契约，`envelope.contract` 与 `meta.contract` 逐个核对一致。只有 c02 / c07 在 `--file` 模式下判「关口未批」——那是强制人工关口的机器拦截（`gate.status` 有意留 `pending`），不是结构缺陷 |
| 七站 CLI 口径 | `--help` 全部 exit 0，无参数全部 exit 2（`UsageError`），无一例外 |
| **④ `--dry-run` 吃 ⑥ 的产物** | `1 份 c04 全部通过契约结构校验` → `节点 ID 映射与工作流模板已就位（T2V / I2V / R2V）` → `本批 1 个候选：T2V 1（按 FL2VA→Ref2VA 排序提交）` → `dry-run 完成：1 个候选的图已填好，未提交`。**未 POST、未碰 GPU** |
| **⑤ 无侧清单（`--offline`）** | S001_c01 → `pass_with_notes` / 转 `human`（7 项未复核）；S002_c01 → `fail` / 转 `retry`（失败 `has_audio_stream`，6 项未复核）。并老实告警「本机没有 ffprobe，降级采信 c05 里记下的实测值。**这不是等价替代：c05 可能是手改的，重测才是对账**」+「产物不在本地 `shots/<cid>/video.mp4`，无法重测对账」 |
| **⑤ 有人工侧清单（`--review`）** | 同一批输入：S001_c01 → `pass_with_notes` / **转 `edit`**（`no_visual_artifact` 软伤，`suggested_change` 只作建议不触发路由）；S002_c01 → `fail` / 转 `retry`（`has_audio_stream` + `prompt_adherence`，后者属 `HARD_SUBJECTIVE` 所以是 fail 不是软伤）。汇总 `转 ⑥重试 1 ｜ 转 ⑦剪辑 1 ｜ 转人工 0` |
| **⑤ → ⑥ → ④ 闭环（全新产物，非样例）** | ⑤ 新出的 c06 → ⑥ 产出 `S002_c02.json`（`action=new_seed`，`seed=1000045`）→ ④ `--dry-run` 收它、图填好。⑤ 的两份 c06 与 ⑥ 的一份 c04 事后单独跑 `validate_contract.py --file`，**全部 exit 0** |
| **⑥ 用例集（14 例）** | 5 例产出新 c04（`change_duration` / `enable_turbo_r2v` / `enable_turbo_t2v` / `raise_megapixels` / `rewrite_prompt_given`）、7 例正确阻塞（`change_reference_asset` / `exhausted` / `manual_intervention` / `patch_out_of_whitelist` / `rewrite_prompt_nopatch` / `switch_workflow_type` / `switch_no_patch`）、1 例同批两份 fail 顺序分配候选号（`S002_c01→c03`、`S002_c02→c04`，seed `1000045` / `1000046`，**不撞号不撞 seed**）、1 例上游 c06 本身违反契约 → exit 1 拒绝照着它开工（`action='pray_harder'` 被 python 校验器当场抓出）。**异常 0 处** |
| **⑥ 样例保真** | `sampleRetryRequest` / `sampleRetryRequestRescale` 与 `runRetry` 实跑输出**逐字段相同**（deep-diff，只放过 `created_at` 与 `artifact_id` 时间戳）。R2V 那份的 `assets.ref_images` 与 `workflow.node_ids` 逐字节原样沿用，时间码 `[0s-4s],[4s-8s]` 与提示词里的标记同步 |
| **⑦ 拒绝不完整材料** | 拿 ⑤ 新出的 c06（只有 S001 通过）喂 ⑦：**exit 1**，逐条点名缺哪些镜头（S003…S010），给三条下一步（多半还在 ⑤/⑥ 环节 / 确认 `--qc` 含这些镜头 / 补齐后重跑），**不产出一份缺镜的 c07** |

注：真实 ComfyUI 节点、真实产物视频、真实 ffprobe、真实 LLM provider（魔搭 / DashScope）**四处未实测**——本机没有渲染节点、没有产物、没装 ffprobe、没配 Key。④ 的提交 / 轮询 / 下载路径、⑤ 的 ffprobe 重测对账与 `--vision` 抽帧通道、⑤ 的 LLM 主观判定路径都只走到「代码就位 + 离线自检 + 夹具联调」，真机联调见第六节。

---

## 五、失败与修正（本段素材，直接并入手记对应章节）

写完三站之后按「检查一遍，有问题就改好」做了一轮复核（含一次只读代码审查 + 七个专门造的畸形输入探针）。下面每条都是**实测复现过的**，不是推测：

| 现象 | 归因 | 修正 |
|---|---|---|
| 5 段时间码压进 4 秒，产出的 c04 里第一段是 `[0s-0s]`；6 段压进 4 秒产出 `[0s--1s]`，整批 throw | 重排循环里「每段至少 1 秒」的 `Math.max` 下限被「给后面几段留空间」的 `Math.min` 上限反压。零长分段合契约 pattern、过得了本站自检，于是**静默白烧一轮 GPU** | 重排前先判 `ceil(新时长) < 段数` 就 throw，落进既有 catch 变成打回 ③提示词 的阻塞（合并 / 删段是重写节奏，属创意决定）。探针复测：两例都 exit 0 + `needs_human.md`（见设计 10） |
| `action=new_seed` 带 `patch.megapixels:1.0`，产出的新 c04 **分辨率一个字节没动**，控制台与 notes 里也没提 | 兜底循环里 `['seed','megapixels','duration_seconds','prompt']` 是无条件跳过的，但这四个键只在各自的动作分支里被处理——白名单内的键被静默丢弃 | 加 `PATCH_ACTION` 归属表，归属与 `action` 对不上就打回 ⑤质检 重开；**删掉整个兜底循环**（5 个键里 4 个各归一个动作、`seed` 归本站，循环里跑得到的只剩归属不对的那些）。探针复测：exit 0 + 转交 ⑤质检（见设计 7） |
| `action=new_seed` 带 `patch.steps:12` → 整批 throw，同批其它镜头的转交清单跟着一起丢 | `steps` 被当自由旋钮收进白名单，但 ④ 硬卡它与 `turbo_enabled` 自洽，本站自检也卡，于是**先照抄再自爆** | `steps` 移出白名单，写进 `PATCH_REFUSALS`（说明它由 `turbo_enabled` 派生、④ 会硬卡）+ `PATCH_OWNER` 路由到 ⑤质检（见设计 7） |
| `rewrite_prompt` 给的新提示词标记是 `[0s-3s][3s-6s]`、`timecodes` 还是 `[0s-2s][2s-5s]`，**照样落盘** | 只比了标记**个数**，没比值；本站自检也只数个数 | 逐一比对标记值与对应 `timecodes` 项，报出是第几处对不上；并把校验挪到 `change()` 之前（原来是先改再判，改了又丢）。探针复测：exit 0 + 打回 ③提示词（见设计 10） |
| 原件 c04 缺 `payload.workflow` → `Cannot read properties of undefined (reading 'type')`；`generation.prompt` 不是字符串 → `g.prompt.match is not a function` | `--requests` 只按「有 `envelope` 与 `payload.generation`」收文件，不跑契约校验；残缺原件一路读到自检里才崩，**崩的是整批** | 动手之前先查原件的三个必需字段（`workflow.type` / `generation.prompt` / `generation.seed`），缺就阻塞打回 ③提示词。这条同时吞掉了原先那处「seed 不是整数」的重复检查。探针复测：两例都 exit 0 + 转交（见设计 9） |
| 契约校验不过的那份 c04 **留在盘上** | `writeFileSync` 在校验之前，throw 之后没人删 | 抛之前 `rmSync`，错误信息里明说「已删除该文件」——④ 扫目录下每个 `*.json`，一份不合格整批被拒（见设计 9） |
| 整批 throw 时 `needs_human.md` 没写出来 | 它原本在循环结束后写一次 | 改成每阻塞一次就重写一遍，无论这一批怎么收尾清单都在盘上（见设计 9） |
| `node agents/qa/run.js --help` 打的是用法错误、exit 2（七站里只有 ⑤ 这样） | `parseArgs` 里有一条必填检查，跑在 `main()` 的 `args.help` 判断之前 | 删掉那处重复检查（`runQa()` 开头已有一模一样的一条）。复测：七站 `--help` 全 exit 0、无参数全 exit 2 |
| `envelope.notes` 里塞了**两条七百字符的英文提示词**（旧值 + 新值），一行一千四百字没人读得下去 | `change_duration` 把整段提示词的 before/after 原样记进 notes | 加 `forNotes()`：超过 120 字符只留开头 60 个 + 「原 N 字符，全文见 payload，逐字段对照在控制台」。控制台那行**故意保留全量**，`root_cause` 也不截断 |
| `usedWhere.filter(w => w.startsWith(String(seed)))` 在 seed=42 时把 423、4245 的来源也列了出来 | 来源存成了预拼好的字符串 `${seed}（${from}）`，只能靠前缀匹配捞回来 | 改存 `{seed, from}` 结构，调用方精确比对再自己拼消息 |
| 三处自检分支永远打不着（`candidate_id !== newCid`、`seed === 上一次 seed`、`filename_prefix === 上一次 prefix`） | 这三个值都在几行之前被无条件赋成新值；上一个 seed 本来就一定在 `usedSeeds` 里，会先被前一条抓住 | 删掉。连带 `structuralCheck` 的 `prevDoc` 参数与 `triagePatch` 的 `cid` 参数一起清掉（都没人读了） |
| `--qc` 目录里混进 `{"payload":"x"}` 这种 JSON → `TypeError: Cannot use 'in' operator` | 代码明说容忍「目录里混了别的 JSON」，但 `in` 对原始值会抛 | 用 `in` 之前先判 `typeof pl === 'object'` |
| 我在 `README.md` 与 `agents/README.md` 两处写下「④ 从 `comfy_endpoint.txt` 读节点地址」 | 想当然。grep `agents/generator/comfyui.js` 才知道 `comfyEndpoint()` 只用 `--endpoint` / `LOOM_COMFY_URL` / 默认回环，**代码根本不读那个文件** | 两处订正，并在 `agents/README.md` 第九节把「那个文件在 `.gitignore` 里预留着，要用就自己导出环境变量」写明白（见设计 1） |
| 我给 `agents/README.md` 第五节写的 `route_to` 规则第一版是错的（「只剩主观软伤 → 看能不能打补丁，能则 retry」） | 凭印象写的，没读代码 | 回去读 `agents/qa/run.js` 的 `decide()`，改成四层分流表（fail → retry/human；soft-fail → pass_with_notes/edit；有未复核项 → 看 `--on-unreviewed`；全过 → pass/edit），并补一句 `pass_with_notes` 仍带 `suggested_change` 但那是**建议不是路由触发器** |
| ④ 的 `--dry-run` 把计划写进了 `artifacts/genplan_…/`，而 `artifacts/` 没被 gitignore | 默认输出目录就在 `artifacts/` 下，`--dry-run` 只是不碰 GPU、照样落盘 | 删掉 `artifacts/`；在 `agents/README.md` 第九节加一条提醒：试跑请把 ④ 的 `--plan-dir`、⑥ 的 `--out-dir` 指到 `tmp/` |
| 校验器每跑一次就在 `contracts/` 下写一份 `validate_report.txt` | 校验器默认把报告写在契约目录 | 代码内与所有临时脚本一律 `--report` 指到临时文件、跑完即删（沿用 09-06 / 09-07 / 09-08 剪辑三段同一教训）。两个报告文件本身也在 `.gitignore` 里，`git status contracts/` 复跑为空 |

---

## 六、下一步

1. **真机联调四处未实测**：真实 ComfyUI 节点（④ 的上传 / POST / 轮询 / 下载 / 缓存判定）、真实产物视频 + ffprobe（⑤ 的六项客观重测与对账）、`--vision` 抽帧通道、真实 LLM provider（⑤ 的七项主观判定）。素材到位后要把本段用夹具跑通的路径原样再跑一遍，特别是 ④ 的**全节点缓存命中判失败**这条——它只在真节点上才验得出来
2. **给 `output.path` / `source_path` 加 pattern 强约束**（09-07 决策留的尾巴，本轮**仍未提**）：`^shots/S[0-9]{3}_c[0-9]{2}/video\.[a-z0-9]+$`，让校验器拦而不是靠文档。④ 已经开工，这条现在是「口径统一」而不是「预防分叉」了，按 `docs/agent_guide.md` 第八节走 5 步、需三人一致同意
3. **c03 补 `beat_ref`**（09-07 决策留的另一条尾巴）：补上之后 ⑦ 的字幕侧清单可以降级成「只标注需要字幕的镜头」的覆盖表。同样是改 Schema，与第 2 条并一批提
4. **本条 ADR 需 B、C 追认**：`docs/decisions/2026-09-08-generation-loop-conventions.md` 跨 B 的 ④⑥ 与 C 的 ⑤。它不改 Schema，第八节那 5 步并不适用，但两条约定是跨工位的规矩——「seed 分配权只归 ⑥」直接约束 ⑤ 不能再往 `patch.seed` 里填值，「`patch` 的键各归一个 `action` 管」直接约束 ⑤ 的 `pickAction()` 怎么写，所以比照第八节「三人一致同意」的口径办
5. **共享 `llm.js` 去重**：现在 5 个 Agent 各自一份自包含副本（①②③⑤⑦），`tools/agent.mjs` 入库后归位
6. **渲染步骤 `tools/slideshow.mjs` 仍缺**：⑦ 产出的是决策单不是成片，`final_output` 的 sha256 / size_bytes 要等渲染后回填
7. **渲染机中文字体未实测**：⑦ 的字幕是中文，DGX Spark（ARM64）上缺字体就是豆腐块，只能等真渲染时验
8. 本段素材将在 09-13 并入创作手记终稿（「团队与流程」「失败与修正」章节）

## 附：复现命令

```bash
# ④ 生成（**这一步才烧 GPU**；地址走 --endpoint 或 LOOM_COMFY_URL，绝不写进仓库）
node agents/generator/run.js --requests artifacts/genreq_<时间戳>/ --dry-run \
     --plan-dir tmp/genplan              # 只出提交计划与填好的图，不 POST、不碰 GPU
node agents/generator/run.js --requests artifacts/genreq_<时间戳>/
#   默认输出目录在 artifacts/ 下，而 artifacts/ 没有被 .gitignore 排除；
#   试跑请用 --plan-dir tmp/…，或提交前 rm -rf artifacts/

# ⑤ 质检（主观项三个来源：--review 人工侧清单 > --vision 抽帧 + 视觉模型 > skipped 未复核）
node agents/qa/run.js --candidates S001_c01,S002_c01 --shots-root shots/ \
     --requests artifacts/genreq_<时间戳>/ --shotlist artifacts/shotlist_<时间戳>.json \
     --review agents/qa/sample_review.json --offline --out-dir tmp/qc
#   --offline 不调 LLM；没看过的主观项老实记 skipped，按 --on-unreviewed human|edit 分流（默认 human）

# ⑥ 重试（消费 c06 的 fail 分支，产出**新的 c04**，交回 ④）
node agents/retry/run.js --qc tmp/qc --requests artifacts/genreq_<时间戳>/ \
     --shots-root shots/ --dry-run --out-dir tmp/genreq_retry   # 逐字段打印 旧值 → 新值，不写文件
node agents/retry/run.js --qc tmp/qc --requests artifacts/genreq_<时间戳>/ \
     --shots-root shots/ --out-dir tmp/genreq_retry
#   做不了的那些不是错误：写进 <输出目录>/needs_human.md，逐条注明转交哪一站、下一步命令是什么

# ⑥ 的两份样例是实跑输出。夹具在 tmp/retry_sample/——那是 .gitignore 里的目录，**没有入库**
# （放这里是为了 envelope.notes 里的 rel(qcFile) 是一条干净的仓库相对路径，不是 C:/Users/... 绝对路径）。
# 新 clone 上这条命令跑不了，得先照 agents/retry/sample.js 文件头重建 5 个输入文件（目录里另外两个
# out/S002_c02.json、out/S004_c02.json 是跑出来的产物，不用建），输入一个数字都不用手写：
#   genreq/S002_c01.json  ← ③提示词 --offline 的产物骨架，generation 对齐 sampleGenResultNoAudio.params_snapshot
#   genreq/S004_c01.json  ← agents/prompt-writer/sample.js 的 sampleGenRequest 原文（R2V）
#   qc/S002_c01.json      ← agents/qa/sample.js 的 sampleQAFail 原文（fail/retry/new_seed）
#   qc/S004_c01.json      ← 一份 change_duration 的 c06，patch 只有 duration_seconds: 8
#   shots/S002_c01/meta.json ← agents/generator/sample.js 的 sampleGenResultNoAudio 原文
node agents/retry/run.js --qc tmp/retry_sample/qc --requests tmp/retry_sample/genreq \
     --shots-root tmp/retry_sample/shots --out-dir tmp/retry_sample/out

# 契约关卡（报告一律重定向到临时文件，别覆盖 contracts/ 下的东西）
python contracts/validate_contract.py --contract c05_gen_result --file shots/<候选>/meta.json --report "$TEMP/vr.txt"
python contracts/validate_contract.py --contract c06_qc_report --file tmp/qc/<候选>.json     --report "$TEMP/vr.txt"
python contracts/validate_contract.py --contract c04_gen_request --file tmp/genreq_retry/<新候选>.json --report "$TEMP/vr.txt"
python contracts/validate_contract.py --selftest          # 7/7
python contracts/negative_test.py                          # 8/8
```
