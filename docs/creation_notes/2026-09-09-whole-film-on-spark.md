# 创作手记 · 09-09（Day 5）整片生成线：创空间只编排、Spark 常驻生成——评审期自愈 + loom_batch 整片调度器 + c01「特定镜头设计」+ 首镜即时/整片下发 UI + 双端使用指南

> ⚠️ 后续变更：本文所述 **natapp 隧道已于 09-13 换成 cloudflared**（根因与收口见
> `2026-09-13-tunnel-switch.md`）。文中所有 `natapp` 字样均为当日实况，保留不改。

> 衔接 Day 4 的「创空间部署」（app.py + space/ 包入库 6c0ce27、隧道/鉴权代理 b171a2d）与 09-08 空间部署决策记录。09-13 提交与 09.15–09.18 评审期临近，创空间「只能生成第一镜、且容器会休眠」的问题必须解决，本段把生成调度搬到常驻的 Spark，并按设计稿分 4 次提交逐步落地（2e6759d → c301fbd → 8d41218 → 0dba399 → 9f129a2 + 未提交的本地指南）。
> 范围：Spark 侧自愈三件套与链路脚本（install_autostart/loom_health/loom_up/loom_status）、整片调度器 `spark/loom_batch.py`（新，389 行）、代理 `/batch/*` 分流、c01 契约可选字段 `requested_shots`（含编剧规则 8）、创空间侧逐镜 c04 + 首镜即时 + 整片下发（space/pipeline.py、space/generate.py、app.py）、设计稿与两份使用指南。

---

## 〇、本段一句话

**评审期要让创空间能「跑完整片」：创空间（云端无状态，2v-cpu-16g 无 GPU、会休眠）只负责 ①→④ 的编排与提示词，把 N 份 c04 打包成一张镜头清单下发给常驻 DGX Spark 上的新调度器 `loom_batch.py`，由它按 FIFO 逐镜真生成、落盘、持久化进度（创空间随时可查），同时保留「首镜即时真生成」让评审立刻有画面看；链路用 crontab 自愈（@reboot + 每 2 分钟健康检查）保证评审期间 Spark 重启/掉线自己恢复。c01 新增可选「特定镜头设计」输入，编剧把每条指定镜头写成剧本 beat，保证它真的进成片。**契约零破坏（requested_shots 是 additive 可选字段），自愈与调度器全部纯标准库/零依赖。**

---

## 一、起点：评审期三个硬事实逼出的分工

| 事实 | 结论 |
|---|---|
| 创空间 `2v-cpu-16g-mem` **无 GPU**，且容器会休眠、重启丢本地状态 | 生成不能发生在创空间进程内——隧道打通后 Spark 才是生成端 |
| Spark 上 ComfyUI 三工作流齐全 + 隧道稳定 + loom_watch/cron 自愈已就位（Day 4） | **调度放 Spark 最稳**：连续跑 20–35 分钟的活不能交给会断的容器 |
| 已有能力只能生成「第一镜」（⑤ 单镜 generation_step），评审想看到的是一部片 | 需要把「逐镜 c04 → 打包 → 下发 → 逐镜生成 → 可查进度」做成一条新链路 |

分工随之定死：**创空间（云端）管「懂」的部分**（编剧/分镜/提示词/契约校验），**Spark 管「跑」的部分**（拿现成提示词逐镜真生成）——调度器不造镜头、不写提示词，这既是实现边界也是赛道叙事（「Agent 在云端编排」）。

---

## 二、推进时间线（分 4+1 次提交，每步独立可验证）

| # | 提交 | 内容 | 验证口径 |
|---|---|---|---|
| 1 | `2e6759d`（00:12） | **评审期自愈先入库**：install_autostart.sh（crontab @reboot + 每 2 分钟 loom_health）+ loom_health.sh（逐环节探活补拉） | 脚本自带自测：`bash loom_health.sh; echo 退出码` |
| 2 | `c301fbd`（02:49） | c01 加可选 `requested_shots` + 编剧规则 8（指定镜头必须写成 beat）；app.py 加「特定镜头设计」输入框与示例文案；UI 三个可选框补浅色 placeholder | commit 内自述：**先试了「按全镜头思路新增多镜头遍历函数」一版，发现与④⑤单镜结构冲突，回退**，只保留 requested_shots 收口（见第八节失败表） |
| 3 | `8d41218`（12:04） | **第一批，Spark 端**：loom_batch.py 整片调度器（新）+ loom_proxy 加 `/batch/*` 白名单与 DELETE 特赦 + health/up/status 三脚本纳入 batch 环节 | 第一批只交付 Spark 端，curl 建批次观察逐镜出片的真机验证留到与创空间联调 |
| 4 | `0dba399`（12:07） | **创空间侧**：pipeline 重引 `build_all_gen_requests`（逐镜 c04）+ `batch_plan_to_workflows`（c04 → 完整 T2V workflow 清单）；generate 重构 `build_t2v_workflow` + submit/query/delete_batch 客户端；app.py ⑤ 拆「首镜即时 + 整片下发」+ UI「整片任务」面板 | 冒烟全过：py_compile / build_ui / **offline 9 段 yield 全通过**；逐镜计划单测 3 镜 T2V workflow 通过 |
| 5 | `9f129a2`（12:33） | 设计稿 `docs/whole_film_on_spark_design.md` 与《创空间使用指南》HTML 入库（设计稿实际是先行讨论稿，文档与实现一起收尾入库） | 文档与实现逐条对齐（见第六节比对） |

> 设计稿头部自称「讨论稿（未动任何代码）」、末尾列了三个「待你拍板」——实况是：**网络走方案 B**（复用 loom_proxy 加 `/batch/*` 分流，不新增隧道）；**分多次提交逐步验证**（实际走了 4 次，比建议的 3 次多一次「特定镜头」）；**不含最后合成一部 mp4**（交付物是逐镜成片文件，与设计稿风险 3 的承诺一致）。

---

## 三、Spark 侧：链路拓扑与自愈

```
ComfyUI(8288, 回环) ← loom_proxy(8188, 鉴权+白名单) ← natapp 公网隧道 ← 创空间
                        └→ loom_batch(8388, 回环, /batch/* 分流)   （本段新增）
```
全链路：ComfyUI → loom_proxy → loom_batch → natapp → loom_watch（地址上报）。**ComfyUI 无鉴权**，所以只监听回环 8288 永不直接见公网；natapp 转发目标恒为 8188（代理端口），改端口不用动 natapp 官网配置。`loom.env` 管 token（代理与调度器共享同一 `LOOM_PROXY_TOKEN`，创空间 secrets 必须一致，留空拒绝启动）。

**自愈三件套**（全部 bash + crontab，无 sudo——对无 sudo 账号最可靠的做法）：
- `install_autostart.sh`：一次性安装——清旧 cron 条目防重复 → 写 `@reboot bash loom_up.sh`（开机全链路按序拉起）+ `*/2 * * * * bash loom_health.sh`（每 2 分钟自愈）→ 立即自测一次；
- `loom_up.sh`：一键启动，顺序有讲究——ComfyUI 先起（代理/调度器要转发给它）、natapp 最后起（它一起来公网就能访问，代理必须已在端口等着）；检测到 ComfyUI 以旧参数跑在 8188 会拦下并指路 `comfy_switch.sh`（旧脚本占住 8188 时代理起不来）；
- `loom_health.sh`：哪个环节断了补拉哪个——探活判定都是「进程在 + 本地可达」双保险（如 proxy 探 8188 返回 401/403/200/500 都算活，401=token 校验拦截也算活着）；无 token 时调度器期望 401 而非 200，探活逻辑按这个语义写；
- `loom_status.sh`：评审期间每天瞄一眼的「一眼清」——每环进程 + 接口 HTTP 码 + natapp 地址 + 上报状态。

---

## 四、Spark 侧：loom_batch.py 整片调度器（第一批）

纯 Python 标准库 HTTP 服务（与 loom_proxy 同风格，不往 h3-comfy 环境装任何东西），监听 `127.0.0.1:8388`。**只做四件事**：接收已填好的工作流清单 → FIFO 逐镜提交 ComfyUI → 轮询 `/history` → 从 `/view` 下载成片落盘。设计决策：

1. **批次对象即进度**：状态落 `batches/<film_id>.json`（Spark 本地盘，原子写 tmp+rename），每镜 `pending → running → done/error`，带 `prompt_id/started_at/finished_at/result/error`。进度在 Spark 不在创空间——**容器重启与进度无关**是这条链的核心赌注。
2. **断点续跑的口径备好了，但没接线**（第一批的诚实差距）：`_pick_next_pending()` 能拾起「上次进程崩在 running 且无 result」的镜头，但 `main()` 只 `serve_forever`，没有任何入口在重启后重新触发 `_run_batch`——health/up 拉起进程后不会自动续跑，重 POST 同 film_id 会被 409 拒掉。**UI 文案却写了「Spark 重启后仍会从断点续跑」**（app.py 面板说明），这是文案走在了实现前面，第二批要接线（启动时扫描 batches/ 对 running/未完成批次重放 `_run_batch`）。
3. **分批顺序尊重 GPU 协议**：T2V/I2V（FL2VA）镜头排前连续跑、R2V（Ref2VA）最后单独跑，避免来回重载 21GB+ 权重——与 docs/gpu_protocol.md 同口径。
4. **一镜失败不坏整片**：单镜 error 记原因后继续下一镜；单镜最长等 20 分钟（STATUS_BUDGET，ComfyUI 报 error/cancelled 立即失败，不空等），超时标 error 跳过，结尾留日志「finished=x/y」。
5. **409 重名保护**：同 film_id 批次已存在直接拒绝覆盖（防评审误操作冲掉进行中任务）；DELETE /batch 才是清理通道。
6. **对外只吐只读视图**：`_public()` 剥掉内部 workflow dict（防大 payload），只给 shot_id/status/result/error/prompt_id。
7. 鉴权复用共享 token（常量时间比较 `_cmp`，避免时序侧信道）；HTTP 接口按 `_handle` 统一进（未验 token 一律 401）。

**代理侧配套**（8d41218 同批）：白名单加 `/batch/` 前缀；`DELETE` 是全代理唯一的破坏性放行方法（仅 `/batch/*`，ComfyUI 的 /queue、/history DELETE 依旧一律拦）；分流 `path.startswith("/batch/") → 8388`，转发时**主动补上鉴权头**（proxy 已验 incoming 与 TOKEN 一致，而调度器与 proxy 共享同一 token，内网段主动带即可）。

---

## 五、契约与 Agent 侧：c01「特定镜头设计」（additive，零破坏）

- `contracts/film_agent_contracts.json`：c01 payload 新增可选 `requested_shots: array<string>`（「使用者特别想看到的镜头设计。编剧必须把它们作为剧本 beats 的一环写进去」）。**纯 additive**——既有 c01 产物不含该字段仍然合法，不动 examples.json 也不破坏任何已冻结契约。
- `agents/screenwriter/prompt.js` 新规则 8：payload 里每条 requested_shots **必须**作为一条 beat 写进剧本（保留景别/动作/画面要素），不能只当氛围暗示——配套的机制是 c02 beats → ②分镜拆镜头 → 镜头进 c03 → 真生成，链路保证「特定镜头」真的出现在成片里（若落在首镜则即时生成，落在后续则由整片调度器按序生成）。
- `space/pipeline.py` `build_brief()`：按行透传，空行不写入 payload。
- 实现过程踩了一版：先按「全镜头思路」新增多镜头遍历函数，发现与 ④⑤ 的**单镜** generation_step 结构冲突（⑤ 一次只消费一份 c04），回退，只保留 requested_shots 收口。

---

## 六、创空间侧：逐镜 c04 + 首镜即时 + 整片下发

- **`build_all_gen_requests(shotlist_doc)`**（pipeline.py）：逐镜调一次 prompt_writer（④ Agent），产出每镜一份独立 c04——每份各自过契约校验；**T2V 收敛**：创空间当前只有 T2V 工作流，即使某镜 c03 标了 I2V/R2V 也统一按 T2V 生成提示词、assets 留空，并在 summary 里诚实标注「含非 T2V 镜头降级为 T2V」（degraded 位随返回）。
- **`batch_plan_to_workflows(gen_items)`**：把每镜 c04 的 generation 转成给调度器的完整 T2V workflow dict——seed 缺省时间派生随机种子、时长夹在 3–8s（H3 单次上限 15s，演示档兼顾等待与画面完整度）、`prefix = film/S<镜号数字>` 便于 Spark 侧归档；没产出可用提示词的镜头直接跳过（兜底不送废单）。
- **`generate.py` 重构**：原 `submit_live` 的填图逻辑抽成 `build_t2v_workflow()`——单镜提交与整片下发两条路复用同一份「填好的 T2V workflow」，不会两处各拼一套；新增 `submit_batch/query_batch/delete_batch` 三个隧道客户端（同一入口 `/batch/*`）。
- **app.py ⑤ 拆两段**：隧道可达 → ① 首镜 `submit_async` 即时真生成（秒返任务 ID + 预计分钟数，评审立刻有画面可追）+ ② 其余镜头（`gen_items[1:]`）打包 POST 给 Spark（film_id 由 c01 artifact_id 改写 `brief.` → `film_`，天然唯一）；隧道不可达 → 回放预览 + 大红字「本次为预生成回放」；离线模式明确提示只展示管线形状。整片下发失败**不影响首镜**（try 分开）。
- **UI「整片任务」面板**：折叠区填 film_id 查逐镜进度，状态中文化（排队中/生成中/✅ 完成/❌ 失败），只读 Spark 的持久进度——容器醒了接着查，与重启无关。
- 9f129a2 起双端配套文档：《整片生成设计稿》+《创空间使用指南》（HTML，面向评审的「三步上手 + 真生成/回放诚实标注 + 整片任务面板」），本日另补《本地使用指南》HTML（仓库侧完整版，未提交）。

---

## 七、设计稿「待拍板」三问的落地比对

| 待拍板问题 | 落地 | 备注 |
|---|---|---|
| 方案整体认可 / 分工 / 是否含合成一部 mp4 | 认可；**不含合成**——交付逐镜成片文件 | 与设计稿风险 3 完全一致；「合成一部」留在本地 studio.mjs 侧（tools/slideshow.mjs 的活） |
| 网络用 B（复用 loom_proxy 加 /batch 转发，不新增隧道） | **B**，8d41218 实现 | 白名单 + DELETE 特赦 + 内网补鉴权头 |
| 分 3 次提交逐步验证 | 实际 4 次（自愈 / 特定镜头 / Spark 端 / 空间端），外加第 5 次文档收尾 | 比建议多一次，因为「特定镜头」在整片设计之前独立成题（c301fbd 02:49 早于设计稿落库） |

---

## 八、失败与修正（本段素材，直接并入手记终稿）

| 现象 | 归因 | 修正 |
|---|---|---|
| 按全镜头思路加多镜头遍历函数，④⑤ 段跑不通 | ④⑤ 结构是**单镜**的：⑤ 一次消费一份 c04，⑤ 的 generation_step 不接受多镜数组 | 回退多镜头函数，④⑤ 恢复单镜 generation_step；整片能力改由「逐镜循环调 prompt_writer + 清单打包下发」在外围实现（c301fbd 内自述） |
| 同一填图逻辑存在两条路（单镜提交/整片下发各拼一遍 workflow） | 会分叉 | 抽 `build_t2v_workflow()` 单点持有，两路复用（0dba399） |
| UI 文案承诺「Spark 重启后从断点续跑」，而第一批调度器重启后无入口重放批次 | 续跑拾起逻辑（_pick_next_pending 对 running 无 result）备好但 main() 未接线 | **如实记录为第一批差距**，第二批在 loom_batch 启动时扫描 batches/ 重放未完成批次 |
| 探活判定「无 token 期望 401」与「探活成功」容易混淆 | 代理/调度器无 token 时的合法响应就是 401 | health/status 探活把 401/403/200/500 都算「活着」，语义写进注释 |

---

## 九、边界与风险（如实）

1. **第一批 ≠ 全链路**：Spark 端 loom_batch 的真机验证（curl 建批次 → 逐镜出片）与创空间端到端（跑一句话 → 首镜秒现 → Spark 后台跑完 → 面板查到 N 镜成片）留待部署后联调，本段只完成到「冒烟 + 单测」。
2. **整片耗时**：热态 2–4 分钟/镜 × N 镜仍要几十分钟，评审想看全片需提前或预生成——设计稿风险 2 原样保留。
3. **只承诺逐镜真生成 + 落盘**：不含质检回环（⑥ 在本地 studio.mjs 侧）、不含剪辑合成——赛道叙事锚定「云端编排 + Spark 常驻生成 + 异步可观测」。
4. **断点续跑未接线**（见第八节）——重启后进行中批次会停在 running 等人工重发或第二批补上。
5. requested_shots 是**单方加的 additive 可选字段**：未走 agent_guide 第八节「三人一致」流程（字段可选、向后兼容、不触既有校验），是否补一条决策记录留给团队——此处如实记录。
6. 隧道仍是单点：natapp 地址变化由 loom_watch 动态上报解决（Day 4），自愈覆盖进程层，网络层故障靠退避重试。

## 附：复现 / 操作命令

```bash
# Spark 侧（部署目录 ~/loom = 本仓库 spark/ 的落点）
bash ~/loom/install_autostart.sh     # 一次性：装 crontab(@reboot + */2) 并自测 health
bash ~/loom/loom_status.sh           # 评审期每日一眼：全链路进程 + 接口码 + 隧道 + 上报
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8188/batch/nonexistent   # 经代理探调度器（期望 404/401）

# 建一个批次（调度器侧直连；创空间侧由 app.py 整片任务自动完成）
curl -X POST http://127.0.0.1:8388/batch/film_test -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"shots":[{"shot_id":"S001","workflow_type":"T2V","workflow":{...}}]}'
curl http://127.0.0.1:8388/batch/film_test -H "Authorization: Bearer $TOKEN"   # 查逐镜进度
curl -X DELETE http://127.0.0.1:8388/batch/film_test -H "Authorization: Bearer $TOKEN"  # 评审后清理
```

本段素材将与其余手记在 09-13 并入《魔搭开发者实践创作手记》。
