# 创作手记 · 09-08（Day 4）剪辑 Agent：对齐 c07_edit_decision 契约 + LLM API 接入，LLM 只定剪辑节奏、可追溯字段全部代码组装

> 本段素材最终并入 09-13 提交用的《魔搭开发者实践创作手记》（衔接 09-07《⑦剪辑的两项输入约定》决策记录：产物路径口径与字幕侧清单已定，本段把 ⑦剪辑 Agent 按这两项约定从零建起来；对应 kickoff 第六节 A「owns 编剧 Agent、剪辑 Agent」，日程表 09-10 用本 Agent 出粗剪）。
> 范围：剪辑 Agent（⑦）从零新建 `agents/editor/` 的全过程——输入 ⑤质检产出的 `c06_qc_report`（通过的那些）+ 各候选的 `c05_gen_result`（取 source_path）+ ②分镜的 `c03_shotlist`（取播放顺序）+ 人工字幕侧清单，输出一份能过校验、含时间线 / 混音 / 成片元数据 / 合规自查的 `c07_edit_decision`（粗剪决策单）。

---

## 〇、本段一句话

**把「已通过质检的候选素材」变成「一条有节奏的粗剪决策单 c07_edit_decision：每镜选定哪条候选 + 入点 / 出点 / 转场 + 全片混音 + 字幕（.ass）+ 成片元数据 + 合规自查与证据路径」，剪辑节奏（入出点 / 转场 / 混音）交给 LLM（与 ①②③ 同一套 OpenAI 兼容 API），候选选择 / source_path / order / subtitle / final_output / compliance / gate 等确定性与可追溯字段全部由代码组装，每份产物过契约校验，c07 的粗剪确认关口一律留 pending 由人批。**

本段（⑦剪辑 Agent 代码）**没有改契约 Schema**；配套的输入约定（产物路径口径、字幕侧清单）在 09-07 已单独立为决策记录 [`2026-09-07-editor-input-conventions.md`](../decisions/2026-09-07-editor-input-conventions.md)，那次只动了 `contracts/` 两个文件的**描述与示例值**、未动任何 Schema 约束。`--selftest` 7/7、`negative_test.py` 8/8 复跑通过。

---

## 一、起点：c07 是流水线最后一道、也是「决策单」不是「产物」，两个先天矛盾

写 ①②③ 时，产物都是「生成出来就完整」的（剧本 / 镜头清单 / 生成请求）。⑦剪辑不一样，它一上来就撞两个矛盾：

1. **c07 要 `final_output.sha256`（64 位十六进制）与 `size_bytes`（1–600MB），但剪辑 Agent 跑在渲染之前**——真成片是 `tools/slideshow.mjs` / ffmpeg 按 timeline 渲出来的，那一刻才有真实哈希与字节数。让剪辑 Agent 填这两个字段，等于让它填一个**还没发生的事实**。
2. **c07 是两处强制人工关口之二（粗剪确认），但校验器 `--file` 模式会把 `gate.status != approved` 直接判为不通过**（`validate_contract.py` 的 `BLOCKING_GATES`）。也就是说：一份**结构完全正确、只是等人批**的 c07，用 `--file` 校验必然 exit 1。这两件事（结构对不对、关口批没批）得拆开看。

还有个现实约束：**⑦ 是在 ④生成 / ⑤质检 / ⑥重试 之前建的**（kickoff 日程把「剪辑 Agent 粗剪」排在 09-10，但 Agent 代码得先于它要消费的上游就绪）。所以本段拿不到真实的 c05/c06，只能按契约形状造夹具 + 本地 mock 验证，真机联调留给 ④⑤⑥ 落地后（见第六节）。

**决定：延续 ②③ 的「LLM 中间形状 + 代码组装」两段式，并额外把 c07 的两个先天矛盾各自显式化解**——渲染前不可知的字段用**占位 + 投影**并在 notes/gate 里诚实标注待回填（设计 6）；结构校验用一份 **gate 临时改 approved 的副本**跑，真产物 gate 不动仍是 pending（设计 4）。

---

## 二、做了什么（文件级清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `agents/editor/prompt.js` | 新增 | 剪辑师人格 + **中间形状**输出模板（不是完整 c07——见设计 1）。脾气写进人格：靠镜头长短与接点控制呼吸、能硬切就硬切、转场只用在段落起止与情绪转折；**明确列出「你不做的事」**（不选候选 / 不填路径 / 不写字幕 / 不发明不重排），把可追溯字段挡在 LLM 之外。硬规则：in/out 是**源视频时间**且 `0 ≤ in < out ≤ source_duration`、最多一位小数、默认用满整段；transition 枚举 `cut/dissolve/fade_in/fade_out/none`（首 fade_in、尾 fade_out、中间默认 cut；dissolve = 本条自上一镜叠化入场，标在叠化两镜的**后一条**上——渲染工具 tools/slideshow.mjs 的 run 切分按同一口径，两处不许各改各的）；audio_mix 四值给数字、`loudness_target_lufs=-14`；**禁止输出 `measured_loudness_lufs`**（那是渲染后实测值） |
| `agents/editor/sample.js` | 新增 | **最终 c07 形状的活文档**（离线降级不用它——见设计 8）：11 镜、每镜用满 6s、`final_output.duration_seconds=66` 恰为各片段 (out−in) 之和，内部自洽可直验；`sha256` 全 0 占位、`size_bytes` 为投影值，文件头注明渲染后回填；`gate` 有意留 pending。兼作下游（渲染 / 人工粗剪确认）mock 上游的现成输入 |
| `agents/editor/sample_subtitles.json` | 复用（09-07 已在） | 字幕侧清单格式示例：键 = `shot_id`，值 = 字符串（整镜一条）或数组（多行逐条给 `at_seconds`）；`_默认` 带渲染样式（字体 / 字号 / 底边距 / 每行字数上限），`_` 前缀键当注释跳过；时间一律**源视频时间**，不是成片时间（理由见设计 5） |
| `agents/editor/llm.js` | 新增 | **LLM API 接入**：第四份共享客户端副本（screenwriter / storyboard / prompt-writer / editor 各一份，README 约定共享管线最终落 `tools/` 时去重）。OpenAI Chat Completions 兼容、原生 fetch、零依赖；`LOOM_LLM_BASE_URL/API_KEY/MODEL` 配置，Key 回退识别 `MODELSCOPE_API_KEY/DASHSCOPE_API_KEY/OPENAI_API_KEY`，默认魔搭 API-Inference；只对 429/5xx/网络错误退避重试 |
| `agents/editor/run.js` | 新增 | 可执行管线（CLI + 可编程双入口）：`--qc` 必填（单文件 / 数组 / `{reports:[]}` / 目录递归，自动认 c06）→ 规范化并**结构不合法当场报错** → 取 c03 order（缺省按 shot_id 升序推断 + 告警）→ **每镜按 c06.score 选定候选**（无通过候选则阻塞）→ 读选定候选 c05 取 source_path（缺 c05 阻塞）→ 逐份过上游 c06 python 校验 → 解析字幕侧清单 → LLM 定节奏（结构不过回灌纠错一轮）→ **成片时长硬闸门** → 代码组装 c07 → JS 自检 + gate=approved 副本 python 校验 → 渲染 .ass（源时间→成片时间平移）→ 失败降级组装粗剪 |
| `agents/editor/index.js` | 新增 | `meta` 带 `contract: 'c07_edit_decision'`，导出 `EDITOR` / `sampleEditDecision` / `runEditor` / LLM 四件套 |
| `agents/README.md` | 更新 | 状态表 ⑦ 行：`⬜ 待建` → `✅ 初稿已入库`（注明对齐 c07 并过校验、接入 LLM API、附 run.js 管线；消费 c06(pass)+c05+c03，字幕走侧清单，指向 09-07 决策记录） |

---

## 三、关键设计决策（为什么这么做）

### 1. 两段式：LLM 只定「怎么剪」，可追溯字段全部代码持有

模型只输出中间形状 `{ timeline:[{candidate_id, in_point_seconds, out_point_seconds, transition}], audio_mix:{...} }`，run.js 的 `assembleDoc()` 接管其余全部：`envelope`（`artifact_id=edit.roughcut.<时间戳>`、`producer=editing_agent`、`upstream_refs=` 选定候选的 c06 artifact_id）、`source_path`（取 c05）、`order`（取 c03）、`subtitle`（侧清单）、`final_output`、`compliance`、`gate`。与 ②③ 同一条纪律：**能确定性判定 / 追溯的事不交给概率模型**——剪辑节奏是创作，交给 LLM；「用了哪条素材、素材在哪、成片多长、合不合规、批没批」是事实与裁决，交给代码。

### 2. 候选选择是代码按 c06 分数定的，不是 LLM 挑的

每个镜头用哪条候选，是 ⑤质检**已经给出的客观结论**（`verdict` + `score` + `route_to`），不是创作决定。所以 run.js 按确定性规则选：`verdict ∈ {pass, pass_with_notes}` 且 `route_to=edit` 的候选里，按 `(score 降序, candidate_id 升序)` 取第一条——同分用 candidate_id 兜底保证**可复现**（换个时间跑结果一样）。把选候选交给 LLM，等于把一条可追溯的裁决变成概率的，将来反查「为什么用了 S005_c02 而不是 c01」就答不上来。**任何一个成片镜头没有通过质检的候选，开工前 exit 1 阻塞**——成片不能缺镜，缺了就该回 ⑤/⑥ 把那条链路跑完。

### 3. source_path 只读不猜：唯一来源是 c05 的 output.path

按 09-07 决策，产物路径只有一个口径 `shots/<candidate_id>/video.mp4`，且 `shots/<cid>/meta.json` 本身就是 c05 实例。所以选定候选后，run.js 直接读它的 `payload.output.path` 原样填进 timeline，**剪辑侧绝不自己拼路径**。理由写在那条决策里：路径约定同时管着 `.gitignore` 放行规则、`filename_prefix` 正则和人工 `selected.txt` 落点，一旦让每个 Agent 各拼一套，目录约定一改就全部分叉，`shots/README.md` 第四节那条「成片时间码 → source_path → meta.json → seed/prompt → c04→c03→c02→c01」的追溯链就断了。选定候选读不到 c05 同样 exit 1 阻塞。

### 4. c07 是强制人工关口之二：gate 一律 pending，且把「结构校验」与「关口状态」拆开

剪辑 Agent 产出的 gate 恒为 `{required:true, status:"pending", reviewer:null, ...}`，**绝不自批**——粗剪要全组人看过才放行，这是机器拦的人机边界（`docs/agent_guide.md` 第七 / 九节）。难点在第 1 节说的矛盾 2：`validate_contract.py --file` 会把 pending 关口判为不通过。解法是 `validateC07Structure()`——把产物深拷贝一份、只把副本的 `gate.status` 改成 `approved`、拿副本去跑权威 python 校验、跑完删副本。这样**结构合不合规**（副本 exit 0）与**关口批没批**（真产物仍 pending）各判各的，口径与 `--selftest`（`check_gates=False`）一致。真产物的 gate 一个字节都不动。

### 5. 字幕走人工侧清单 + .ass「源时间→成片时间」平移

字幕不进契约、不走 LLM 推断，走一份人工撰写的侧清单（09-07 决策，理由：c02 的 `beats[].dialogue` 与 c03 的 `shots[]` 之间没有外键，推断出来的对应关系是概率的，字幕错了要重烧全片；而人工写一份十分钟就好）。两个实现细节值得记：

- **清单里的时间是「源视频时间」不是「成片时间」**：人对着一句话标时间，看的是手头这条素材（0 = 该候选 mp4 第一帧），不是全片。这样剪辑改入出点、换候选时，不必重标全片字幕——这是 09-07 决策里唯一有远见的一处。
- **c07 只有一个 `subtitle` 字符串位，装不下逐行时序**：所以该镜多行文本按 `\n` 连接进 c07（作为「这一镜挂了哪些字」的记录），**精确逐行时序落在渲染出的 `.ass`**。`buildAss()` 做平移：`filmStart` 按时间线累计每段 `(out−in)`，一条字幕的成片起点 `= filmStart + (at_seconds − in_point_seconds)`，落在所用片段 `[in, out)` 之外的 cue 直接跳过并告警。`.ass` 路径进 `compliance.evidence_paths`。

### 6. 渲染前不可知的字段：sha256 占位、size_bytes 按源码率投影

化解第 1 节矛盾 1。`final_output.sha256` 填全 0 占位（`'0'.repeat(64)`，契约只要求 64 位小写十六进制，占位合法），`size_bytes` 用**选定候选的源码率 × 成片时长**投影（`bps = Σ源字节 / Σ源时长`，`projected = round(filmDur × bps)`，夹在 1–600MB）。两者都在 `envelope.notes` 与 `main()` 的完成提示里**诚实标注「渲染前占位 / 投影，真渲染后须回填真实哈希与大小」**，并在下一步里点名回填责任方是 `tools/slideshow.mjs` / ffmpeg。不假装知道未来的值，但也不让契约因为缺字段而校验不过——这是「决策单」类产物的通用处理法。

### 7. 成片时长硬闸门在落盘**之前**拦

c07 的 `final_output.duration_seconds` 契约硬约束 60–300s（主赛道要求 1–5 分钟）。run.js 在组装完、落盘**之前**先算 `Σ(out−in)`，不在区间就 exit 1，并给**可执行诊断**：列出选定镜数与各镜源时长，时长不足就指「回 ②分镜 补镜头 / 放宽入出点用满整段」，过长就指「回 ②/⑤ 精简 / 收紧入出点」。放在落盘前，是为了不产出一份注定不合法的 c07 再报错——早拦、早给方向。另有软告警（不拦）：成片时长偏离 c01 `target_duration_seconds` 超 ±20%、选定候选源分辨率 / 帧率不一致（成片需统一缩放 / 重定时）。

### 8. 离线降级不整份返回 sample——和 ③ 同构的取舍

编剧 / 分镜的离线兜底是整份返回 sample，但 c07 的内容必须对应**真实选定的素材**：拿固定 sample 广播，形状合规、时间线却指向一批不存在的候选，等于把废品送进渲染。所以降级改成 `paceOffline()`——按每条选定候选的**真实源时长**用满整段（`in=0, out=源时长`）、首尾淡入淡出 / 中间硬切、配默认混音。内容对应真实输入，只是未经 LLM 调节奏；`envelope.notes` 与终端日志都标明「离线组装粗剪，交渲染前建议人工复核节奏或配好 LLM 重跑」。sample.js 因此专职当「形状活文档 + 下游 mock 输入」两用。

### 9. 合规自查不是填个 true：每条都能反查到证据文件

`compliance` 由代码据实推导，不是拍脑袋：`red_line_self_check = 所有选定候选的 c06 都含 {name:'no_red_line_violation', status:'pass'}`（有一条不满足就记 false 并在 notes 里点名要人工复核）；`evidence_paths = 每条选定候选的 c06 文件 + c05 meta.json + .ass + shotlist + brief 路径`（去重）；`ai_label_position` 默认 `opening_and_ending`（主赛道硬要求视频须标注 AI 生成）；`duration_in_range` / `size_under_limit` 按第 6、7 节的值据实填。给了 `--brief` 还会把 c01 的 `red_lines` 条数记进 notes、交叉核对 `target_duration_seconds`。合规的意义是「可反查」，evidence_paths 就是反查的落点。

---

## 四、验证（全部实测，不是声称）

用契约形状造的夹具（11 镜 × 每镜 6s = 66s，落在 60–300）+ 真实 `sample_subtitles.json`，全程在**仓库外的临时目录**跑，跑完即删（`artifacts/` 不被 gitignore，绝不留残渣）。

| 场景 | 结果 |
|---|---|
| sample.js 活文档直验 | gate=approved 副本过 `c07_edit_decision`，exit 0 |
| `--offline` 全流程（11 镜夹具 + 字幕侧清单） | exit 0；**候选选择全对**：S002 取高分 c02（c01=6.0/c02=9.0）、S005 跳过 fail 的 c01 取 c02、S009 同分（8.0/8.0）取 candidate_id 较小的 c01；成片 66s；转场首 fade_in / 尾 fade_out / 中间 cut；`timeline.order` 连续 1..11；`source_path` 原样 = `shots/<cid>/video.mp4`；`gate={required:true,pending}`；c07 gate=approved 副本结构校验 exit 0；`red_line_self_check=true` |
| 字幕挂载 + .ass 时间平移 | S003（字符串形式）挂上、S007（3 行数组）按 `\n` 连接进 c07；.ass 里 **S003（order 3）平移到成片 12.00s**、**S007 首行（order 7）平移到 36.00s**，与手算（前 N−1 镜各 6s 累计）一致；清单里不在本片的 S012 被忽略并告警 |
| **LLM API 路径（本地 mock OpenAI 兼容端点）** | mock 第 1 把返回坏 JSON（缺 S011_c01 + 非法转场 `wipe` + 一处 `in>out`）→ run.js 检出并把问题清单回灌纠错 → 第 2 把通过。日志「LLM 生成成功（model=Mock-1，含一轮纠正重试）」，**端点被调用恰 2 次**，`usedFallback=false`（用的是 LLM 结果不是降级），11 条时间线、c07 结构校验 exit 0——**API 接入与纠错轮真实走通** |
| 阻塞：某镜无通过候选（S006 只剩 fail/retry） | **exit 1**，点名 S006，给「回 ⑤/⑥ 跑完拿 pass 的 c06 / 确认 --qc 含该镜」指引 |
| 阻塞：选定候选缺 c05（删 S003_c01/meta.json） | **exit 1**，点名 S003_c01，指向「④生成 落盘 meta.json 或 --shots-dir 指对目录」 |
| 阻塞：成片时长 < 60s（5 镜 × 6s = 30s） | **exit 1**，诊断「成片时长 30s 不在 60–300s」并列各镜源时长 + 「回 ②补镜 / 放宽入出点」 |
| 契约自检 / 反向测试 | `--selftest` 7/7、`negative_test.py` 8/8，`contracts/` **Schema 零改动** |

注：真实 provider（魔搭 / DashScope）、真实上游 c05/c06（④⑤⑥ 未建）、渲染（`tools/slideshow.mjs`）三处**未实测**——本机没配 Key、上游 Agent 尚未落地、渲染工具未入库。`final_output` 的 sha256/size 是占位 / 投影，真值待渲染回填。这三段留给 ④⑤⑥ 落地后的联调覆盖（第六节）。

---

## 五、失败与修正（本段素材，直接并入手记对应章节）

| 现象 | 归因 | 修正 |
|---|---|---|
| 一份结构正确、只是等人批的 c07，`validate_contract.py --file` 判它不通过（exit 1） | c07 是 `BLOCKING_GATES`，`--file` 模式把 `gate.status != approved` 算作不通过 | `validateC07Structure()` 用 gate 临时改 approved 的**副本**跑权威校验，真产物 gate 不动仍 pending；把「结构」与「关口状态」拆开判（见设计 4） |
| c07 要 sha256/size_bytes，但剪辑跑在渲染之前，这两个值还不存在 | 「决策单」类产物要填一个尚未发生的事实 | sha256 全 0 占位、size_bytes 按源码率投影，notes/gate/完成提示三处标注「渲染后回填」，点名责任方 tools/slideshow.mjs（见设计 6） |
| 时长硬闸门一开始想放在落盘后（产出再校验） | 会先写出一份注定不合法的 c07 再报错 | 移到组装完、落盘**之前**算 Σ(out−in)，不在 60–300 直接 exit 1 并给可执行诊断（见设计 7） |
| 入出点四舍五入到一位小数后可能出现 `in == out`（源时长极短或裁得太细） | `round1` 后区间塌缩 | `checkCreative()` 加兜底：`b<=a` 时把 out 抬到 `min(a+0.1, 源时长)`，仍不合法才报错「源时长太短无法裁出合法入出点」 |
| 命令行内联 JS 里写 `//` 注释被 shell 工具误判为 UNC 路径拒执行 | 工具的安全启发式把行首 `//` 当网络路径 | mock 端点与夹具脚本落成临时 `.mjs` 文件再跑，用后即删（沿用 09-07 分镜手记同一教训） |
| 内联 `node -e` 里用 `require` 报 `require is not defined` | 仓库 `package.json` 是 `"type":"module"`，`-e` 也走 ESM | 改用 `import { ... } from 'node:fs'`；跑夹具统一用 `.mjs` + 动态 `import()` |
| 每跑一次校验都覆盖 git 已跟踪的 `contracts/validate_report.txt` | 校验器默认把报告写在契约目录 | 代码内一律 `--report` 重定向临时文件、跑完即删（沿用 09-06 / 09-07 教训） |

---

## 六、下一步

1. **④生成 / ⑤质检 / ⑥重试 待建**：⑦ 现在拿的是夹具 c05/c06。真实 `c05_gen_result`（尤其 `output.path/sha256/size_bytes`、`ffprobe.duration_seconds/video_stream`）由 ④ 落盘、真实 `c06_qc_report`（`verdict/score/route_to/checks`）由 ⑤ 产出，⑦ 只读不改。这三家落地后要把本段用夹具跑通的路径拿真实上游再联调一遍
2. **渲染步骤 `tools/slideshow.mjs` / ffmpeg 未入库**：c07 只是决策单，真成片由它按 timeline 逐条 trim+concat、烧 `.ass` 字幕、加 AI 生成标识卡、按 audio_mix 混音并 loudnorm 到 −14 LUFS；渲染后**回填** `final_output` 的真实 sha256/size_bytes/duration，再复跑一次 `validate_contract.py --contract c07_edit_decision`
3. **关口 2（粗剪确认）人工批准流程**：全组看过粗剪 → 人工把 gate 改成 `{status:"approved",reviewer,reviewed_at,reason}` → 才算放行成片。这一步是机器拦的（设计 4），不能自动流转
4. **给 `output.path` / `source_path` 加 pattern 强约束**（09-07 决策留的尾巴）：④生成开工前把 `^shots/S[0-9]{3}_c[0-9]{2}/video\.[a-z0-9]+$` 一并提进契约变更，让校验器拦而不是靠文档——B 是同意的另一方（他就是写路径的人），按 `docs/agent_guide.md` 第八节走 5 步
5. **共享 `llm.js` 去重**：现在 4 个 Agent 各自一份自包含副本，`tools/agent.mjs` 入库后归位
6. 本段素材将在 09-13 并入创作手记终稿（「团队与流程」「失败与修正」章节）

## 附：复现命令

```bash
# 剪辑 Agent（LLM 走 LOOM_LLM_* 环境变量；没配 Key 自动降级组装粗剪）
node agents/editor/run.js --qc artifacts/qc_<时间戳>/ --shotlist artifacts/shotlist_*.json \
     --subtitles agents/editor/sample_subtitles.json --offline          # 离线直出，先看形状
node agents/editor/run.js --qc artifacts/qc_<时间戳>/ --shotlist artifacts/shotlist_*.json \
     --subtitles agents/editor/sample_subtitles.json                    # 配好 Key 后走 LLM API

# 字幕侧清单格式示例（键 = shot_id，值 = 字符串或逐行数组；时间为源视频时间）
#   agents/editor/sample_subtitles.json

# 最终产物关卡——注意 c07 的 gate 有意留 pending，--file 模式会把「关口未批」判为不通过：
#   run.js 内部已用 gate=approved 副本做过结构校验（见设计 4）；手动只查结构可比照该口径，
#   真产物要等人工粗剪确认（关口 2）把 gate 改成 approved 后，--file 才会 exit 0。
python contracts/validate_contract.py --contract c07_edit_decision --file artifacts/edit_<时间戳>.json
```
