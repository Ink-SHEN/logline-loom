# 创作手记 · 09-13（Day 9·下午）⑤ 生成站改为「可插拔模型 API 接口」——创空间自包含化，Spark 侧隧道一并退役

> 衔接同日上午那篇《隧道供应商替换》（`2026-09-13-tunnel-switch.md`）。上午刚把 natapp 换成
> cloudflared、把「真打公网」的探活补上；**下午架构就变得更简单了**——决定创空间不再远程回源
> 本机生成，⑤ 站改成一层可插拔的模型 API 接口。这篇记的是为什么改、改成什么样、怎么验证的。

## 一、为什么改

上午的方案有一个绕不开的前提：**Spark 上必须常驻一个公网入口**。而这个前提有三个坑：

| 坑 | 具体表现 |
|---|---|
| 节点不是我们的 | `106.13.186.155` 是比赛侧托管的云节点，安全组改不了；Spark 本身无公网入向 |
| 入口不稳定 | quick tunnel 无 SLA（Cloudflare 自己声明 account-less tunnel 无可用性保证） |
| 节点存续不可控 | 这台 Spark 09-15→09-18 评审期内是否仍归我们使用，**没有技术手段能兜底** |

也就是说：**评审期一旦节点被回收或断网，创空间就退化成「只能放示例素材」**。
把出片能力绑在一台不归自己管的机器上，是整条链路上最大的单点。

于是改设计：**创空间自己把「生成」这件事抽象成一个接口**，谁来实现接口都行——
今天可以是任意第三方视频生成 API，明天可以换另一个模型，后端换了创空间一行代码都不用动。

## 二、改成了什么：接口契约 v1

`space/generate.py` 现在只有两件事：把 ④ 的 c04 生成请求 POST 出去、把任务状态 GET 回来。

| 动作 | 请求 | 期望响应 |
|---|---|---|
| 提交 | `POST {LOOM_GEN_API_URL}/generations` | `{"task_id": "…", "status": "queued", "eta_seconds": 300}` |
| 查询 | `GET {LOOM_GEN_API_URL}/generations/{task_id}` | `{"status": "succeeded", "video_url": "https://….mp4"}` |

设计上刻意只提**一条硬要求**：模型侧能返回一个可播放的 mp4 URL。同步还是异步、有没有进度、
支不支持 seed，全是可选的——同步后端在提交响应里直接给 `video_url` 会被自动识别为已完成。
这样接入门槛足够低，任何一家视频生成 API 都能接。

**三种状态，界面永远说真话**（这是这条设计的核心，不是补丁）：

| 状态 | 条件 | 界面表现 |
|---|---|---|
| 已接入 | 配了 `LOOM_GEN_API_URL` | 真提交，给任务 ID，可查、可取回成片 |
| 接口就绪 | 没配 URL | 明说「等待接入模型」；④ 的生成请求照常产出；**不拿示例素材冒充本次生成** |
| 参考回放 | `LOOM_GEN_BACKEND=replay` | 播放 `space/fallback/` 往期成片，恒标注「非模型生成」 |

这条「宁可说没接上，也不假装生成了」的口径，和上午那篇的结论是同一条：
**界面上说的必须和实际发生的一致。**

## 三、动了哪些文件

| 文件 | 变更 |
|---|---|
| `space/generate.py` | **整体重写**：后端基类 `GenerationBackend` + `HttpModelAPI` + `ReplayBackend` + 统一任务形状归一化 + 本地任务表 |
| `space/config.py` | 删掉 `comfy_url/proxy_token/auth_headers/probe_timeout/generation_mode`；换成 `gen_backend/gen_api_url/gen_api_key/gen_api_model/gen_timeout` |
| `space/tunnel.py` | **删除**（隧道概念整体退役） |
| `space/pipeline.py` | 摘掉 `generation_step` / `batch_plan_to_workflows` / ComfyUI workflow 构造；编排层现在只负责 ①–④ |
| `app.py` | ⑤ 段重写为调用接口；新增「⑤ 生成接口」标签页（把契约与当前状态写成文字放出来）；删掉隧道状态区、`/loom/tunnel/*` 路由、整片任务区；首屏 INTRO 增加接口说明 |
| `space/README.md` | 重写环境变量表与 ⑤ 站说明，加架构演进表 |

⑤ 站的代码里现在**不再出现任何 `tunnel` / `natapp` / `ComfyUI` 字样**（写成断言进了测试）。

## 四、验证证据

**1）接口真能插：起一个假模型服务走完整契约**（`tmp/test_gen_api.py`）

用一个 120 行的 stdlib HTTP 服务实现上面两个端点（含 Bearer 鉴权、先 `running` 后 `succeeded`、
返回 mp4 字节流），然后跑 **22 项断言，全部 PASS**：

```
PASS 1b 未配置 URL 时判为未接入        PASS 3a 首次查询 running
PASS 1c 返回 not_connected            PASS 3b 再次查询 succeeded
PASS 1d 文案明说「等待接入模型」        PASS 3c 成片已下载到本地（2060 bytes）
PASS 2a 配置后判为已接入               PASS 4a 错误 key → 401 如实报错、不冒充成功
PASS 2b 返回 mode=api                 PASS 5c replay 文案标注非模型生成
PASS 2c 拿到 task_id（task-01）       PASS 6a ⑤ 站不再出现隧道/ComfyUI 字样
PASS 2e prompt 正确透传               PASS 6b tunnel.py 已退役
PASS 2f 时长按 3–8 秒收敛（7.5）        PASS 6c 编排层只剩 ①②③④
```

**2）界面真的起得来**（`tmp/smoke_space.py`，本地 gradio 6.26.0）

```
GET / -> HTTP 200, 67844 bytes
首屏含「可插拔的模型 API 接口」：True
首屏含「不内置」：True   ·   首屏含「等待接入模型」：True
接口契约文本 1152 字符（含 /generations / LOOM_GEN_API_URL / video_url / mp4）
```

**3）八个改动文件全部编译通过**（`py_compile`），契约自检仍是 **7/7 通过**。

## 五、Spark 侧同步退役（本机不再有任何公网入口）

⑤ 站不再回源本机，那条隧道就没有存在理由了——**留着一个暴露 ComfyUI 的公网地址反而更危险**。
所以本机侧一并收掉：

| 动作 | 结果 |
|---|---|
| 停 `cloudflared`（PID 1522004）/ `loom_watch`（1527888）/ 我们自己的 frpc（1482443） | 三个进程均已停止，复查为空 |
| 停止 natapp | 早已停止 ✅ |
| `loom_watch.py` 退役 | 备份后移出（`~/loom/backup_20260913/loom_watch.py.retired`） |
| `loom_up.sh` / `loom_health.sh` / `loom_status.sh` 改版 | 去掉隧道与上报两步；cron 每 2 分钟跑的自愈**不会再把它们拉回来**（实测 `tunnel=retired watch=retired`，复查进程为空） |
| 确认 SSH 未受影响 | xsuper 的 frpc（PID 3306）不动——**我们的 SSH 就走它** |
| 旧公网地址 | `https://prevention-previous-intro-worldcat.trycloudflare.com/system_stats` → **HTTP 530**（隧道已失效） |

本机现在只剩三个**内部**服务：ComfyUI `127.0.0.1:8288`、代理 `8188`、调度器 `127.0.0.1:8388`，
无公网入向。保留它们是为了本地 `studio.mjs` 那条 ⑥⑦ 线（质检/剪辑）还能跑。

## 六、代价与遗留（如实记）

1. **现在创空间里出不了片**：⑤ 站界面会诚实地显示「等待接入模型」。这是这次改动的**已知代价**，
   换来的是一条不会因外部节点失效而崩掉的链路。要让它出片，两条路：
   - 接一个满足契约的视频生成 API（配 3 个环境变量，**不改代码**）；
   - 或临时用 `LOOM_GEN_BACKEND=replay` 展示产物形态（界面会标注是参考回放，不是本次生成）。
2. **`space/fallback/` 的 4 段素材仍留在仓库**：它们现在的定位是「⑤ 站产物形态预览」，
   不再是「后端不可达时的替代品」。`index.json` 的 note 措辞已同步。
3. **`workflows/node_id_map.json` 与 T2V workflow 仍在**：它们服务于 c04 契约里的
   `workflow.node_ids` 字段（契约本身没改），只是 ⑤ 站不再拿它去拼 ComfyUI 图。

## 七、这次改动的自我复核

| 我做的判断 | 依据 | 有没有可能是错的 |
|---|---|---|
| 创空间不该依赖本机节点 | 节点归属、评审期存续都不可控；无技术兜底 | 若评审期节点稳定且允许常驻服务，这条架构其实也能用——但那是「赌」，不是「设计」 |
| 接口最小硬要求定为「返回可播放 mp4 URL」 | 这是唯一所有视频生成服务都能满足的共性 | 若某服务只返回裸字节流或需要轮询文件系统，得再加一个适配层 |
| 删掉 `tunnel.py` 而不是留着 | 留着会被误读为「还有隧道这条路」，且 `generate.py` 的冒烟断言会失败 | 若明天又要恢复隧道，从 git 历史取回即可（09-13 上午那篇手记里有完整设计与实测数据） |
