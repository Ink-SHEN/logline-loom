# logline-loom

> **LOOM** is a film agent, which means **L**ogline-**O**riented **O**rchestration **M**achine.

从一句 logline 出发，经编剧 → 分镜 → 提示词 → 视频生成 → 质检 → 重试 → 剪辑，产出一部带原生音频的 AI 科幻短片。生成后端是本地部署的 **MiniMax-H3**（跑在 NVIDIA DGX Spark 上），不是云端计费 API。

本项目为魔搭社区「AI+∞ 开发者创作大赛」第二期参赛作品，同时投主赛道（原创 AI 科幻短片）与补充赛道（进阶创作｜电影 Agent）。

---

## 一、它解决什么问题

AI 视频生成现在的常见用法是：人写提示词 → 出片 → 人看 → 不满意再改提示词。这条路在做一个 3 分钟短片（约 25–30 个镜头、每镜头若干候选）时会崩，因为**人变成了流水线上的瓶颈**，而且每次生成的参数、素材、结果都没有留下可复现的记录。

LOOM 的做法是把这条流水线拆成 **7 个各有明确输入输出的 Agent**，Agent 之间**只通过版本化的 JSON 契约交接**，人只在两个关键点上做裁决。这样带来三件事：

1. **可并行** —— 契约冻结后三个人各写一段管线，用假数据 mock 上下游，不必互相等待
2. **可追溯** —— 成片里任何一个镜头都能反查到它的提示词、种子、分镜、剧本、片约
3. **可复现** —— 每次生成都留下完整参数快照与产物哈希，事后能原样重跑

## 二、架构

```
   ┌─────────┐
   │ 人：片约 │  c01_brief
   └────┬────┘
        ▼
   ┌─────────┐
   │ 编剧 A. │  c02_screenplay
   └────┬────┘
        ▼
   ★ 人工关口 1：剧本确认（阻塞）
        ▼
   ┌─────────┐
   │ 分镜 A. │  c03_shotlist          ← 在这里标注每个镜头走 T2V / I2V / R2V
   └────┬────┘                          并给出 GPU 分批计划
        ▼
   ┌──────────┐
   │ 提示词 A. │  c04_gen_request      ← 英文提示词 + 时间码 + <Picture N>
   └────┬─────┘                          + 节点 ID 映射（不许硬编码）
        ▼
   ┌─────────┐        ┌──────────────────────────────┐
   │ 生成 A. │───────▶│ ComfyUI HTTP API (单例 FIFO) │
   └────┬────┘        │  MiniMax-H3 on DGX Spark     │
        │  c05        └──────────────────────────────┘
        ▼
   ┌─────────┐
   │ 质检 A. │  c06_qc_report         ← ffprobe 硬指标 + 提示词遵循度
   └────┬────┘
        │
        ├── fail ──▶ ┌─────────┐
        │            │ 重试 A. │──▶ 生成新的 c04（主要靠换种子）
        │            └─────────┘        有 max_retries 防止无限烧 GPU
        │
        └── pass ──▶ ┌─────────┐
                     │ 剪辑 A. │  c07_edit_decision
                     └────┬────┘
                          ▼
                  ★ 人工关口 2：粗剪确认（阻塞）
                          ▼
                     ┌────────┐
                     │ 成片   │ MP4 + 字幕 + 混音 + AI 生成标识
                     └────────┘
```

**两处人工关口是数据，不是口头约定。** 契约里的 `gate.required = true` 且 `status != approved` 时，校验器会直接判不通过，下游 Agent 拿不到放行的产物。人机边界因此是机器会拦的东西。

## 三、目录

| 路径 | 内容 |
|---|---|
| `contracts/` | **7 道接口契约**（JSON Schema draft 2020-12）+ 示例产物 + 校验器 + 反向测试 |
| `workflows/` | ComfyUI **API 格式**工作流三份（T2V / I2V / R2V）+ 节点 ID 映射表 + 两个校验脚本 |
| `agents/` | 7 个 Agent 的实现，**一个 Agent 一个文件夹**（`prompt.js` / `sample.js` / `index.js`）。见 `agents/README.md` 的边界、归属与当前差距 |
| `docs/agent_guide.md` | **Agent 开发指南**：照着哪几个文件写、输出形状的五条铁律、提交前的自检命令 |
| `docs/decisions/` | 决策记录。每条决定连同它的依据与当时的已知信息一起存档 |
| `docs/gpu_protocol.md` | GPU 排队协议与**实测性能基线** |
| `docs/node_baseline.md` | 节点环境快照（复现用） |
| `docs/task_registry.md` | 生成任务登记表 |
| `shots/` | 每镜头一个目录：`meta.json` + ffprobe 输出 + 人工筛选记录（视频文件不入库） |
| `space/` | 魔搭创空间部署（Agent 赛道提交项） |

## 四、环境与权重

### 硬件与软件（实测值，非配置目标）

| 项 | 值 |
|---|---|
| 机器 | NVIDIA DGX Spark，GB10 Grace Blackwell，20 核 ARM64（aarch64） |
| 内存 | **128 GB LPDDR5x 统一内存**，CPU 与 GPU 共享同一个物理池 |
| Python | 3.10.21（conda-forge，conda 环境名 `h3-comfy`） |
| PyTorch | 2.13.0+cu130 |
| ComfyUI | 0.34.0（frontend 1.51.9，templates 0.11.50） |
| 启动参数 | `main.py --listen 127.0.0.1 --port 8188 --highvram --preview-method auto` |

> **注意 `vram_total` 与 `ram_total` 报的是同一个数**（128501485568）。这台机器上 `nvidia-smi` 看不到独立显存，要看 `free -h`。

### 权重（约 63 GB，**不在本仓库内**）

从 [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) 拉取部署用量化权重，官方模型卡见 [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)，魔搭镜像见 [MiniMax/MiniMax-H3](https://modelscope.cn/models/MiniMax/MiniMax-H3)。放进 ComfyUI 对应目录后，应能看到这 7 个文件：

```
diffusion_models/  minimax_h3_fl2va_pruned_int8_convrot.safetensors     # T2V + I2V
                   minimax_h3_ref2va_pruned_int8_convrot.safetensors     # R2V
text_encoders/     qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
vae/               minimax_h3_video_vae_fp16.safetensors
                   minimax_h3_audio_vae_fp32.safetensors
loras/             minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors    # 20→8 步
                   minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors   # 20→4 步
```

ComfyUI **原生支持 MiniMax-H3，不需要装任何自定义节点**。

## 五、快速开始

### 1. 校验契约（不需要 GPU，任何机器都能跑）

```bash
pip install jsonschema

python contracts/validate_contract.py --list        # 列出 7 道交接面
python contracts/validate_contract.py --selftest    # 校验 7 份示例产物
python contracts/negative_test.py                   # 反向测试：8 种真实错误能否被抓到
```

交接自己产出的文件给下游前：

```bash
python contracts/validate_contract.py --contract c04_gen_request --file artifacts/xxx.json
python contracts/validate_contract.py --dir artifacts/     # 批量，自动认类型
```

退出码 `0` 通过 / `1` 有不通过 / `2` 用法错误，可直接挂进 pre-commit 或 CI。

### 2. 校验工作流（需要能访问 ComfyUI）

```bash
ssh -L 8188:127.0.0.1:8188 <你的节点>        # ComfyUI 无鉴权，只能用隧道，不要暴露公网

python workflows/preflight.py      # 逐节点比对 /api/object_info：必填输入、链接指向、枚举取值
python workflows/verify_map.py     # 节点 ID 映射表与工作流是否一致，枚举取值是否合法
```

### 3. 提交一次生成

工作流是 **API 格式**（扁平的 `{节点ID: {class_type, inputs}}`），可以直接 POST：

```python
import json, urllib.request
wf = json.load(open("workflows/workflow_api_t2v.json", encoding="utf-8"))
wf["140:131"]["inputs"]["prompt"] = "your prompt here"   # 节点 ID 从 node_id_map.json 查，勿硬编码
wf["140:129"]["inputs"]["noise_seed"] = 12345
req = urllib.request.Request("http://127.0.0.1:8188/prompt",
                             data=json.dumps({"prompt": wf}).encode(),
                             headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())       # 返回 prompt_id
```

之后 `GET /history/<prompt_id>` 取结果，`GET /queue` 看排队状态。

## 六、实测性能基线

来自 ComfyUI `/history` 的 `execution_start` / `execution_success` 时间戳，`megapixels=0.4`（16:9 约 848×480）：

| 场景 | 时长设定 | 实测耗时 | 缓存命中节点 |
|---|---|---|---|
| T2V **冷启动**（首次，含权重加载） | 5 s | **636.5 s** | 0 / 23 |
| I2V 热态 | 5 s | **217.6 s** | 9 / 24 |
| I2V 热态 | 4 s | **126.6 s** | 15 / 24 |
| 输入完全相同（命中缓存） | — | **0–1.4 s** | 21–24 |

由此得到两条必须遵守的规则：

- **热态单镜头量级为 2–4 分钟**；冷启动额外多花约 7 分钟（估算值，两次运行不完全同工作流）。所以任务必须**按工作流类型分批入队**，避免反复重载权重，详见 `docs/gpu_protocol.md`
- **ComfyUI 会缓存完全相同的输入**，0 秒返回旧文件。所以「一个镜头出多个候选」必须**换种子**，否则拿回的是同一个视频

## 七、已知限制

诚实列出，避免复现时踩坑：

1. **MiniMax-H3 没有 `negative_prompt`，也没有 CFG**（用 `BasicGuider` 而非 `CFGGuider`）。这两项设不了
2. **单次生成 4–15 秒**。时长输入是**秒（浮点）**，下游 `ComfyMathExpression` 自动换算成帧并对齐到 17 的倍数（5 秒 → 124 帧）。不要直接写帧数
3. **标称 768p / 24 FPS**，原生输出 32 kHz 立体声音频。2K 需要尚未发布的 H3-Regenerate-2K
4. **FL2VA 与 Ref2VA 不能同时常驻**，切换要重载 21 GB+ 权重
5. **T2V / I2V 的节点 ID 是子图摊平后的复合编号**（形如 `140:131`）。代码里写 `workflow["131"]` 取不到，必须用完整字符串索引
6. **`LoadImage.image` 只能填节点上真实存在的文件**，否则报 `Value not in list: image`。素材要先 `POST /upload/image`
7. **ComfyUI 完全没有鉴权**。必须 `--listen 127.0.0.1` + SSH 隧道
8. 本仓库 `workflows/` 里的三份 JSON 是 **2026-09-04 导出并实测校验修补过的版本**。ComfyUI 升级或重新导出模板后节点 ID 可能变化，**必须重跑 `preflight.py` 与 `verify_map.py` 再使用**

## 八、给复现者的最短路径

1. 拉权重（第四节），装 ComfyUI 0.34.0，**不装任何自定义节点**
2. 把 `workflows/` 里三份 JSON 通过 `POST /userdata/<文件名>?overwrite=true` 传到节点
3. 跑 `workflows/preflight.py`，确认 0 问题
4. 跑一次第五节第 3 步的 T2V，等 10 分钟（冷启动），拿到第一个 mp4
5. 用 `ffprobe` 确认有 24 fps 视频流 **和** 32 kHz 双声道音频流
6. 之后按 `contracts/examples.json` 的结构组织你自己的产物

## 九、许可

MIT，见 [LICENSE](LICENSE)。

模型权重各有其自身许可，请遵循 MiniMax 与 Comfy-Org 的原始条款，本仓库不分发任何权重文件。
