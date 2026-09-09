# 创作手记 · 09-09（Day 4 补记）渲染成片工具：tools/slideshow.mjs 入库——c07 决策单 → MP4 的「最后一米」（trim+concat/叠化/字幕/AI 标识/loudnorm/真实值回填）

> 衔接 09-08 剪辑手记第六节「下一步 2」与编排手记引言「slideshow 渲染工具先一步入库」：本段把它从「只存在于剪辑手记的下一步清单」变成入库代码（commit 348253e，与编排层同批 09-09 00:12 前落库），随后编排层 studio.mjs 才能在关口 2 停靠前调 `renderEdit()` 渲「审阅粗剪」。
> 范围：`tools/slideshow.mjs`（779 行，唯一新增真身）+ `agents/editor/prompt.js` 一行 dissolve 口径同步 + `package.json` 补 `studio` / `render` 直跑入口 + 剪辑手记同步说明。**没改契约 Schema**（渲染器是 c07 的下游执行者，不是新工位）。

---

## 〇、本段一句话

**渲染步骤是流水线最后一道物理工序：消费一份 `c07_edit_decision`（粗剪决策单），按 timeline 逐镜 trim（in/out 是源时间）→ 硬切段 concat 成「run」→ run 间按 dissolve 用 xfade/acrossfade 链起（offset 按各 run ffprobe 实测时长精确计算）→ 首尾淡入淡出 → 烧对白字幕 .ass + AI 生成标识 .ass → loudnorm 到目标响度 → 输出成片 MP4，并把渲染后才存在的真实值（sha256 / size_bytes / duration_seconds / 实测响度）回填进 c07 原文件。**渲染器不做创作决定**（转场节奏是 ⑦剪辑的事，它只按决策单执行），**也不假装知道未来**（回填前 c07 里那些字段是占位/投影，由它补成真值）。**

本段零契约改动；`--selftest` 7/7 复跑通过（没有碰 contracts/）。

---

## 一、为什么它是「先一步入库」的那一个

编排手记的引言说「slideshow 渲染工具先一步入库，本段（指编排层五件套）把剩的补齐」——不是随机顺序，是依赖倒逼的：

1. **主程序要调它**：studio.mjs 的关口 2 设计是「⑦出决策单 → 先渲一版审阅粗剪给人看 → 再停靠等批」。没有渲染器，关口 2 就无从「看片审批」。
2. **c07 的两头都是它**：剪辑手记设计 6 把 `final_output.sha256/size_bytes` 的「占位 + 投影」诚实标注了待回填，并点名「回填责任方是 tools/slideshow.mjs」——本段就是去把这个名字兑现。
3. **它只依赖 ffmpeg 与契约形状**，不依赖任何 Agent 站内代码，可以独立先验。

---

## 二、做了什么（文件级清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `tools/slideshow.mjs` | 新增（779 行） | 渲染工具：CLI（`--edit` 必填 + `--root/--ass/--out/--ai-label-text/--no-ai-label/--keep-temp/--dry-run/--no-validate`）+ 可编程入口 `renderEdit()`。文件头注释写满设计口径：逐条 trim → 按 dissolve 断 run → run 内 concat、run 间 xfade/acrossfade；`.ass` 字幕从 `compliance.evidence_paths` 找或 `--ass` 给；AI 标识卡按 `compliance.ai_label_position`；loudnorm 到 `loudness_target_lufs`（默认 −14）；渲染后回填真实哈希/大小/时长/实测响度，用 gate=approved 副本复跑权威校验（真产物 gate 不动仍 pending） |
| `agents/editor/prompt.js` | 改 1 行 | dissolve 语义钉死：**「本条自上一镜叠化入场，标在叠化两镜的后一条上（首条永远不要标 dissolve）」**——与 slideshow 的 run 切分（dissolve 标后一条 → 前一条段尾断开）同一口径，两处不许各改各的 |
| `package.json` | +2 行 | scripts 补 `"studio"` 与 `"render"` 直跑入口 |
| `docs/creation_notes/2026-09-08-editor-agent.md` | 同步 | 剪辑手记文件清单表补上 dissolve 口径同步说明（回填本段对 prompt.js 的改动，避免手记与代码脱节） |

---

## 三、关键设计决策（为什么这么做）

### 1. 转场物理化：dissolve 断 run，run 内全硬切

timeline 上任意两镜之间只能是「硬切」或「叠化」。硬切用 concat 一次拼完最稳，叠化要 xfade——所以 `planRuns()` 把 timeline 按 dissolve 切成若干「run」：**run 内全硬切**（逐镜 trim + 统一 scale/fps 后 concat 成中间 mkv），**run 与 run 之间最后用一条 xfade/acrossfade 命令链起来**。dissolve 语义在剪辑侧是「标在后一条上」，到渲染侧就等价于「该条作为新 run 的第一条，把 timeline 在这里断开」——两处同一个约定，没有第二套解释。

### 2. xfade 的 offset 不是猜的：按 run 实测时长累加，且是 `acc − t×D`

每条 xfade 的 offset = Σ(前 t 段实测时长) − t×叠化时长。代码注释里直记了这条教训：**每叠一次，输出时间线就少 DISSOLVE_SECONDS，所以是 `t×D` 而不是 `D`——一次只叠一个 run 的偏移是错的**。而 run 的时长来自 ffprobe 实测（`probeClip`），不是对 trim 帧对齐的猜测——ffmpeg 的 trim 有容器时长舍入，猜 offset 会在第 N 个叠化处逐级漂移。

### 3. concat 要求「所有输入同构」，缺音轨的素材垫静音而不是断链

质检可能放行过无音轨候选（H3 原生带 32kHz 立体声，但不是每条都保证）。concat 要求所有输入同构，所以 `encodeRun()` 给无音轨段用 `anullsrc` 垫静音：视频链统一 `scale=lanczos → fps=24 → setsar=1 → yuv420p`；音频链统一 `aresample=48000 → pan`（单声道复制成双声 `c0=FC|c1=FC`、立体声 `c0=FL|c1=FR`）`→ aformat=s16:stereo`。中间文件是无损级别的 x264(crf13)+pcm，双编码损失可忽略。

### 4. 一个下标坑：静音输入必须排在所有素材之后，边扫边插会顶漂

写滤镜链时最容易犯的错（代码注释如实留着）：如果边扫素材边发现「这条没音轨」就随手把 lavfi 静音输入插进参数表，**静音出现的位置会把后面素材的输入下标全部顶漂**，滤镜链引用全错。正确做法是两轮：先所有素材 `-i` 排前（0..nSegs−1），第二轮统一补静音输入排后（nSegs+k），音频链数组与素材一一对位。

### 5. 字幕与标识卡共用一套机制：两条 .ass 轨，同一个 subtitles 滤镜

对白字幕（剪辑 Agent 已把源时间平移到成片时间，路径在 evidence_paths）和 AI 生成标识卡都做成 .ass，与画面同 PlayRes，一起用 `subtitles=` 滤镜烧——**不引第三套字体/叠层机制**。两个工程细节：

- .ass 文件拷进 tmpDir 后用**固定文件名**（`subtitle_dialogue.ass` / `subtitle_label.ass`），躲开 filter 参数里冒号/逗号的转义地狱；
- 标识卡按 `ai_label_position` 四档生成：片头/片尾卡（停留 3.0s，起点 0.6s 避开 0.5s 淡入、片尾终点 offset 0.7 避开淡出但别盖住全黑）用 `\an5` 居中、字号 ≈ 画面短边 8%；`corner_persistent` 右上角常驻（`\an9`）小一号——对白 Default 贴底边，互不打架。

**AI 标识是主赛道硬要求**：默认 `opening_and_ending`，`--no-ai-label` 虽然存在但会把 `compliance.ai_label_present` 回填成 false——交上去就是自曝违规，正常流程不可用。

### 6. 参数分层：创作参数在剪辑侧，渲染器只持「定值」

叠化时长 0.5s、首尾淡入淡出 0.5s、AI 卡停留 3s 这些在渲染器里是常量（文件头注明「它们不是创作决定，要改节奏参数去 agents/editor/prompt.js 的规则 3 定口径，别在这里各改各的」）。同 ②③④⑤ 的纪律一脉相承：**节奏是 ⑦剪辑的创作决定，渲染器不替它发明**——所以中间片段误标 fade_in/fade_out 只告警忽略（只实现首淡入/尾淡出），首条误标 dissolve 按硬切处理并告警，绝不擅自改剪辑节奏。尾淡出起点还往左挪 0.1s（`FADE_START_MARGIN`），防容器时长舍入导致淡出不完整。

### 7. 回填：把「渲染后才存在的事实」写回决策单，但 gate 一个字节不动

渲染完成后用实测值回填 c07 原文件：`final_output.sha256`（真哈希）/`size_bytes`/`duration_seconds`、`deliverables.upload_file_path`（给了 `--out` 时连 `final_output.path` 一起同步）、`audio_mix.measured_loudness_lufs`（ffprobe ebur128 实测——这正是剪辑 LLM 被明令禁止输出的字段）。回填后用 **gate 临时改 approved 的副本**复跑权威校验——结构合不合规与关口批没批各判各的（与 07 剪辑手记设计 4 同一口径），真产物 gate 保持 pending 等人批。

### 8. 诚实标注：三路混音增益当前只能执行「可直接实现的部分」

c07 的 `audio_mix` 有 dialogue/music/sfx 三路增益，但它面向的是**分离音轨**；H3 原生输出是单条混合音轨（32kHz 立体声），timeline 也没给镜头标音轨角色——三路增益当前无法按轨施加。文件头如实写明本工具执行的是 `loudness_target_lufs` 归一（loudnorm 到目标响度，真峰值上限 −1.5 TP）与实测回填；将来素材升级成分轨再回这里按增益表调各轨。不假装实现了没实现的。

### 9. 边界硬限与 schema 对齐：早拦，别渲出注定不合法的成片

成片 60–300s / size ≤ 600MB / sha256 格式，全按 c07 schema 的硬约束对齐（常量 `DURATION_MIN/MAX`、`SIZE_LIMIT`、`SHA256_RE`）。每段素材先 ffprobe 预检（分辨率/帧率/时长/有无音轨/声道数），软告警不一致项；`--dry-run` 只出渲染计划（镜头/段/转场/预计时长）不写文件；编码进度从 `-progress pipe:1` 的 `out_time_us` 解析，同秒只打一次。

---

## 四、验证实录（端到端真跑，不是声称）

| 场景 | 结果 |
|---|---|
| 11 镜夹具端到端出片（含**无音轨垫静音**、**48kHz 单声道**素材、**双 dissolve**、中文字幕） | 出片 63s；抽帧核对叠化位置、字幕、AI 标识、时序**逐项吻合**（见 agents/README 第四节状态表末行的实测记录） |
| 回填 | 成片渲染后 sha256/size/duration/实测响度写回 c07；gate 保持 pending；回填副本过权威校验 |
| CLI 冒烟 | `node tools/slideshow.mjs --help`、`--dry-run`（只出计划）、`--no-ai-label` 合规自曝分支均按设计工作 |
| 契约自检 | `--selftest` 7/7（本段零 Schema 改动） |

未覆盖、留给真机联调的部分：真实 ④⑤⑥ 产出的 c05/c06 + 真实 c07 全链路（编排层 studio.mjs 的「审阅粗剪」分支在同一批已接线，但端到端要等真出片素材）；渲染机的**中文字体**是否存在只告警不阻塞——真烧出来人要亲眼复核（字体缺失就是豆腐块，`docs/decisions/2026-09-07-editor-input-conventions.md` 记的未实测项）。

---

## 五、写的时候踩的坑（本段素材，直接并入手记终稿）

| 现象 | 归因 | 修法 |
|---|---|---|
| 多叠化处画面时间线逐级漂移 | xfade offset 只减了一个叠化时长 | offset = Σ前 t 段实测时长 − **t×**叠化时长（每叠一次输出时间线少一段 D），见设计 2 |
| 某镜垫了静音后整条滤镜链报流不匹配 | 边扫素材边插静音输入，把后续素材的下标顶漂了 | 素材先全排（0..nSegs−1），静音第二轮追加（nSegs+k），音频链数组与素材一一对位，见设计 4 |
| filter 参数里写 .ass 路径被冒号/逗号坑 | ffmpeg filter 语法对路径里的特殊字符敏感 | .ass 拷进 tmpDir 用固定文件名，subtitles= 只传裸文件名，见设计 5 |
| 尾淡出偶尔缺最后一帧/淡不完 | 容器时长舍入使淡出起点偏后 | 起点往左挪 0.1s（FADE_START_MARGIN），见设计 6 |
| 中间片段误标 fade_in/out、首条误标 dissolve | 剪辑 LLM 偶发违背规则（规则 3） | 渲染器只实现首淡入/尾淡出；误标**告警忽略不阻塞**（不替剪辑发明节奏），见设计 6 |
| 进度日志刷屏 | out_time_us 高频刷新 | 同秒只打一次（_lastProgress 去重） |

---

## 六、边界与下一步

1. **主程序接线已在同批完成**：studio.mjs 在 ⑦ 出决策单后调 `renderEdit()` 渲审阅粗剪、关口 2 批准后 `--from render` 走「已回填则跳过」分支——本工具是那条链的地基，端到端真跑留待有真实素材的联调。
2. **成片交付物**落 `deliverables/final_<时间戳>.mp4`（c07 `final_output.path` 默认值），`.gitignore` 已忽略交付物。
3. 本段素材将与其余手记在 09-13 并入《魔搭开发者实践创作手记》（「失败与修正」章节）。

## 附：复现命令

```bash
node tools/slideshow.mjs --edit artifacts/edit_<时间戳>.json --dry-run   # 只看渲染计划（不写文件）
node tools/slideshow.mjs --edit artifacts/edit_<时间戳>.json             # 真渲染 + 回填
node tools/slideshow.mjs --edit artifacts/edit_<时间戳>.json --keep-temp # 失败排查：保留中间文件
# 前提：ffmpeg/ffprobe 在 PATH（或 LOOM_FFMPEG / LOOM_FFPROBE），且 ffmpeg 带 libass + 中文字体
# c07 未批也照渲（全组要先看到粗剪才能批）；批准走 node studio.mjs --approve artifacts/edit_*.json --reviewer <姓名>
```
