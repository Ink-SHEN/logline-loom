# 设计稿：让创空间能"跑完整片"——调度放 DGX Spark 的轻量整片调度器

> 状态：讨论稿（未动任何代码）
> 日期：2026-09-09
> 目标：创空间 agent 具备"生成一部完整短片所有镜头"的能力，同时首镜即时可看；生成调度落在常驻的 DGX Spark，不依赖会休眠的创空间容器。

---

## 一、为什么这样设计（决策依据）

| 事实 | 结论 |
|---|---|
| 创空间 `2v-cpu-16g-mem` 无 GPU | 生成必须发生在 Spark；但隧道打通后这不是障碍 |
| Spark 上 ComfyUI 三工作流齐全 + 隧道稳定 | 生成能力够，链路通 |
| 创空间容器会休眠 / 重启丢本地 tmp | **调度不能放创空间后台线程**（会断） |
| Spark 有 loom_watch 守护 + cron 自愈、常驻 | **调度放 Spark 最稳** |

分工变成：
- **创空间（云端，无状态）**：负责 ①编剧→②分镜 的编排 + ③④ 生成提示词，把首镜提交给 Spark 立即生成（评审即时可见），并把**全片镜头清单**打包下发给 Spark。
- **Spark（本地常驻）**：一个轻量 HTTP 调度服务接收清单，按 ComfyUI FIFO 队列**逐个镜头自动生成**，轮询完成、落盘每镜成片，进度可被创空间随时查询。

---

## 二、新组件：Spark 侧 `loom_batch.py`（整片调度器）

一个纯 Python、零第三方依赖（同 loom_proxy 风格）的 HTTP 服务，监听一个新端口（如 8388，另开一条隧道或复用——见"网络"节）。

### 职责
1. **接收整片任务**：POST /batch { film_id, shots: [...] } 建一个批次任务，逐个镜头入队。
2. **自动续跑**：后台线程按 shot 顺序，等上一个完成后提交下一个；每镜调 ComfyUI /prompt → 轮询 /history → 命中 /view 下载到本地落盘。
3. **遵守分批**：按 gpu_protocol，把 T2V/I2V 镜头排前连续跑，R2V 单独后跑，避免反复重载权重。
4. **进度持久化**：批次状态写在 `~/loom/batches/<film_id>.json`（Spark 本地盘，不受创空间重启影响）。崩溃后重启从断点续跑。
5. **进度查询**：GET /batch/<film_id> 返回每镜状态（排队/生成中/完成/失败+路径）。

### 接口契约（草案）
```
POST /batch/{film_id}
  body: { "shots": [ { shot_id, workflow_type, prompt_en, duration_seconds, seed, prefix, assets? } ] }
  鉴权: Bearer <token>（复用 LOOM_PROXY_TOKEN）
  → 202 { film_id, accepted_shots }

GET /batch/{film_id}
  → 200 { film_id, status, shots:[{shot_id,status,mp4_path?,error?}], updated_at }

DELETE /batch/{film_id}      # 清空队列（评审后清理）
```

> 关键：**创空间下发的是"已经写好的英文提示词"**（每个镜头一份 c04 级内容），不是镜头描述——Spark 调度器**不做编剧/提示词**，只负责"拿提示词逐镜真生成"。提示词生成仍在创空间 ④（Agent 能力留在创空间，符合赛道"Agent 在云端编排"叙事）。

---

## 三、创空间侧改动（app.py / generate.py / pipeline.py）

### 3.1 ④ 从"只 S001"改为"为每镜生成一份 c04"
- 遍历 c03 的每个 shot，逐镜调一次 prompt_writer → 得到 N 份 c04。
- （上一轮已实现的 `build_all_gen_requests` 思路可复用，当时回退了，现在按需重新引入并收敛为 T2V。）

### 3.2 ⑤ 拆成"首镜即时 + 全片下发"
- **首镜**：仍走现有 submit_async → 秒返任务 ID，界面放预览/进度（评审即时看到）。
- **全片**：把 N 份 c04 的提示词打包成清单，POST 到 Spark 调度器（经隧道），返回 film_id。
- 界面新增"整片任务"展示：film_id + 每镜进度（轮询 Spark GET /batch）。

### 3.3 编排注释
- c01 里已有的 requested_shots 会进入编剧→剧本→分镜；"特定镜头"若落在首镜就能真生成，落在后续则会被调度器按序真生成——**这一版能真正兑现"特定镜头进成片"**（不依赖只生成 S001）。

---

## 四、网络：调度器走哪条隧道

现有 natapp 单条隧道转发 → 8188（loom_proxy → ComfyUI 8288）。调度器要新暴露给创空间，两条路：
- **A. 同一条隧道多转发**：natapp 免费版一般一条隧道一个本地端口，需另购/另建一条隧道 → 8388（费用/复杂度）。
- **B. 复用 loom_proxy 加一条路径**：让 loom_proxy 把 /batch/* 代理到调度器进程（调度器监听 127.0.0.1:8388，loom_proxy 加白名单路径转发）——**不新增隧道**，推荐。调度器不直接对公网，仍由 loom_proxy 做鉴权+白名单。

---

## 五、失败处理与恢复

| 故障 | 机制 |
|---|---|
| 单个镜头失败 | 标记 error + 记录原因，调度器继续下一个（不因一镜坏整片）；留 human 复查清单 |
| 隧道中断 | 提交/轮询失败 → 调度器退避重试；loom_watch 自愈重连后恢复 |
| Spark 崩溃/重启 | 批次状态已在 ~/loom/batches 落盘，loom_up/health 拉起调度器后从断点续跑未完成镜头 |
| 评审中途打开创空间 | GET /batch 读到 Spark 持久进度，与容器重启无关 |

---

## 六、改动清单（按顺序，每步可验证）

| # | 文件 | 改动 | 验证 |
|---|---|---|---|
| 1 | `spark/loom_batch.py`（新） | 整片调度服务：接收清单/串行逐镜/轮询/落盘/断点续跑 | Spark 本地起服务，curl 建批次→观察逐镜出片 |
| 2 | `spark/loom_proxy.py` | 白名单加 /batch/*，转发到调度器 | 经代理 curl /batch 通 |
| 3 | `spark/loom_up.sh` + `install_autostart.sh` | 拉起 loom_batch + cron 守护含它 | reboot/health 全绿 |
| 4 | `space/pipeline.py` | 重新引入 `build_all_gen_requests`（收敛 T2V）+ 新增"打包下发清单"函数 | 单测：N 镜 → 生成 N 份 c04 + 合法 payload |
| 5 | `space/generate.py` / `space/batch_client.py` | 新增 POST /batch + GET /batch 的隧道客户端 | 单测打包/下发/查询 |
| 6 | `app.py` | ⑤拆首镜即时+整片下发；UI 加整片任务面板（film_id+逐镜进度） | build_ui + offline 冒烟 |
| 7 | 推送创空间 + 部署 Spark | 双端上线 | 端到端：创空间跑一句→首镜秒现→Spark 后台跑完全片→创空间查到 N 镜成片 |

---

## 七、诚实风险与边界

1. **改动量大**：跨双端 7 个文件，含新子系统。建议分 3 次提交逐步验证，不要一次全上 Spark 生产。
2. **全片耗时**：即便热态 2–4 分钟/镜，8 镜仍约 20–35 分钟（T2V，单候选）。评审想看到全片需等待或提前预生成。
3. **只承诺"逐镜真生成 + 落盘"**，不含质检回环（⑥，在本地 studio.mjs 侧），也不含剪辑成片（⑦）。本方案交付的是"整部片所有镜头的成片文件"，不是"合成好的一部 mp4"。若要"合成一部"，需再加一步 Spark 端 ffmpeg 拼接（可用 tools/slideshow.mjs 的思路，单独一小步）。
4. **赛道匹配**：你报"进阶创作｜电影 Agent"，赛制评系统能力，本方案把"云端编排 + Spark 常驻生成 + 异步可观测"做成可展示系统——契合。

---

## 待你拍板
1. 方案整体认可？还是要调整分工 / 是否含"最后合成一部 mp4"？
2. 网络用 B（复用 loom_proxy 加 /batch 转发，不新增隧道）OK？
3. 分 3 次提交逐步验证可以吗（不想一次大改 Spark 生产）？
