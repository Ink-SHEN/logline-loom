# 节点环境快照

采集时间：2026-09-04。用于复现与排错对照。
所有数值来自节点上的真实接口返回或 `pip list`，不是配置目标。

---

## 一、硬件

| 项 | 值 |
|---|---|
| 机器 | NVIDIA DGX Spark |
| 芯片 | GB10 Grace Blackwell |
| CPU | 20 核 ARM64（`aarch64`） |
| 内存 | 128 GB LPDDR5x，**CPU / GPU 统一内存** |

> 统一内存意味着 `nvidia-smi` 看不到独立显存，`/system_stats` 里
> `vram_total == ram_total == 128501485568`。查内存要用 `free -h`。

### `/system_stats` 原始值

```
ram_total          128501485568
ram_free            50752606208
vram_total         128501485568
vram_free           13753201847
torch_vram_total    66068676608
torch_vram_free      2706539703
device              cuda:0  NVIDIA GB10 : cudaMallocAsync
```

`vram_free` 只剩 12.8 GiB 是 `--highvram` 让模型常驻的正常结果，
不是泄漏。这一点直接导致了 FL2VA 与 Ref2VA 不能共存，
详见 `docs/gpu_protocol.md` 第二节。

---

## 二、软件

| 组件 | 版本 |
|---|---|
| ComfyUI | 0.34.0 |
| ComfyUI frontend | 1.51.9 |
| ComfyUI templates | 0.11.50 |
| ComfyUI embedded-docs | 0.5.10 |
| comfy-kitchen | 0.2.31 |
| comfy-aimdo | 0.4.15 |
| Python | 3.10.21（conda-forge，环境名 `h3-comfy`） |
| PyTorch | 2.13.0+cu130 |

**自定义节点：无。** ComfyUI 0.34.0 原生支持 MiniMax-H3，
装任何第三方节点都只会增加变量，不要装。

### 启动命令

```bash
python main.py --listen 127.0.0.1 --port 8188 --highvram --preview-method auto
```

| 参数 | 为什么这么设 |
|---|---|
| `--listen 127.0.0.1` | **ComfyUI 完全没有鉴权**。绑公网等于把节点交出去，必须只监听回环 + SSH 隧道 |
| `--highvram` | 模型常驻不卸载。热态生成 2–4 分钟，代价是 R2V 换权重要重载 |
| `--preview-method auto` | 生成中能看到预览，便于判断是否卡死 |

访问方式：

```bash
ssh -L 8188:127.0.0.1:8188 <节点>
```

隧道断了的表现是本地 `curl` 返回 HTTP 000、`netstat` 里 8188 无监听，
此时可能还残留一个不转发的 `ssh.exe` 进程，要先杀掉再重连。

---

## 三、权重清单

约 63 GB，**不在本仓库内**（`.gitignore` 明确排除所有权重格式）。

来源：[Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)（部署用量化权重）；
官方模型卡 [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)；
魔搭镜像 [MiniMax/MiniMax-H3](https://modelscope.cn/models/MiniMax/MiniMax-H3)。

放进 ComfyUI 对应目录后，加载器里应能看到这些文件：

```
diffusion_models/
  minimax_h3_fl2va_pruned_int8_convrot.safetensors      # T2V + I2V
  minimax_h3_ref2va_pruned_int8_convrot.safetensors     # R2V

text_encoders/
  qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors          # 唯一可选

vae/
  minimax_h3_video_vae_fp16.safetensors
  minimax_h3_audio_vae_fp32.safetensors
  pixel_space                                            # 模板自带，本项目不用

loras/
  minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors    # T2V/I2V 20→8 步
  minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors   # R2V 20→4 步
```

---

## 四、一个重要事实：节点上没有别的模型

曾经假设「文字模型和生图模型也部署在节点上，所以别人也要排队用 GPU」。
**实测否掉了这个假设。** 查各加载器的枚举可选值：

| 加载器 | 可选项 |
|---|---|
| `UNETLoader` | 只有上面 2 个 H3 diffusion model |
| `CLIPLoader` | 只有 `qwen3vl_32b_minimax_h3_nvfp4_awq` |
| `VAELoader` | 2 个 H3 VAE + `pixel_space` |
| `LoadImage` | 初始只有 `example.png` |

也就是说：**这台节点上唯一能跑的模型就是 MiniMax-H3，它只做视频。**
没有独立的文生图模型，也没有可供调用的对话模型。

两个直接影响：

1. **R2V 的参考图不是在节点上生成的。** 实测节点上跑过的任务引用了
   `03-lights-on.png` 这类文件，说明素材是在外部生成后经
   `POST /upload/image` 传上去的。c04 契约里的
   `assets.ref_images[].node_filename` 就是为登记这一步而设。
2. **编剧 / 分镜 / 提示词三个 Agent 的 LLM 不能放在节点上。**
   节点没有文本模型。这三个 Agent 走云端 API 或本地开发机，
   **完全不占 GPU**，因此它们可以和生成任务并行推进，不受排班约束。

---

## 五、模型能力边界

复现时最容易撞墙的四条：

| 项 | 事实 |
|---|---|
| 分辨率 / 帧率 | 标称 **768p / 24 FPS**。工作流里通过 `ResolutionSelector` 选画幅与 `megapixels` |
| 画幅 | 本项目统一 **`16:9 (Widescreen)`**（比赛要求）。注意枚举值**带括号后缀**，写 `16:9` 会报 `Value not in list` |
| 音频 | **原生 32 kHz 立体声**，随视频一起生成，不是后配的 |
| 单次时长 | **4–15 秒**。输入是**秒（浮点）** |
| `negative_prompt` | **不存在**。H3 没有这个输入 |
| CFG | **不存在**。工作流用 `BasicGuider` 而非 `CFGGuider`，所以 CFG scale 无处可设 |
| 2K | 需要尚未发布的 H3-Regenerate-2K，**当前做不到** |

### 时长换算

时长节点是 `ComfyMathExpression`，公式：

```
max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
```

`a` 是**秒**，输出是帧数，且结果恒满足 `≡ 5 (mod 17)`：

| 输入秒数 | 输出帧数 |
|---|---|
| 4 | 107 |
| 5 | 124 |
| 6 | 141 |

**不要绕过这个节点直接写帧数**，对齐到 17 的倍数是模型的要求。

---

## 六、`/history` 记录结构

取产物时会用到，实测结构（不是文档抄来的）：

```python
record = {
    "prompt":  {...},          # 提交时的完整图
    "outputs": {
        "92": {                # 节点 ID，随工作流变化，不要硬编码
            "images": [        # ← 注意：视频也叫 "images"，而且是【列表】
                {"filename": "shot1_00001_.mp4", "subfolder": "", "type": "output"}
            ],
            "animated": [True]
        }
    },
    "status": {
        "status_str": "success",
        "completed": True,
        "messages": [
            ["execution_start",   {"prompt_id": "...", "timestamp": 1788521042367}],
            ["execution_cached",  {"nodes": ["114", "115", "105:11", ...],
                                   "prompt_id": "...", "timestamp": 1788521042371}],
            ["execution_success", {"prompt_id": "...", "timestamp": 1788521168946}],
        ],
    },
    "meta": {...},
}
```

三个坑：

1. **视频产物在 `images` 键下**，不在 `videos` 或 `gifs` 下
2. **`images` 是列表套字典**，不是单个字典。按 `isinstance(v, dict)` 判断会全部漏掉
3. **`execution_cached.nodes` 里会出现 `"105:11"` 这种复合 ID**，
   是子图摊平后的编号，和 `workflows/node_id_map.json` 对得上

耗时统计用 `execution_success.timestamp - execution_start.timestamp`，
单位毫秒，与时区无关。

---

## 七、常用接口

ComfyUI HTTP API，**全部无鉴权**：

| 方法与路径 | 用途 |
|---|---|
| `GET /system_stats` | 上面第一节的数值来源 |
| `GET /api/object_info/<class>` | 查某个节点的输入定义与枚举可选值 |
| `GET /userdata/<file>` | 读回节点上存的工作流 |
| `POST /userdata/<file>?overwrite=true` | 把工作流写回节点 |
| `GET /templates/<name>.json` | 取官方模板 |
| `POST /upload/image` | 上传素材（R2V 参考图必经） |
| `POST /prompt` | 提交生成。**图是内联发送的**，所以有任务在跑不代表节点上存的文件被改过 |
| `GET /queue` | `queue_running` / `queue_pending` |
| `GET /history` | 全部历史 |
| `GET /history/<prompt_id>` | 单条记录（含产物与时间戳） |

---

## 八、复现前置检查

在任何机器上重新部署后，按顺序确认：

```bash
# 1. 权重是否齐（见第三节）
ls ComfyUI/models/{diffusion_models,text_encoders,vae,loras}

# 2. 起服务，确认只监听回环
python main.py --listen 127.0.0.1 --port 8188 --highvram --preview-method auto

# 3. 隧道
ssh -L 8188:127.0.0.1:8188 <节点>

# 4. 枚举取值是否与本文档一致（画幅、模型名、VAE 名）
python workflows/verify_map.py

# 5. 三份工作流逐节点校验
python workflows/preflight.py
```

第 4、5 步**必须跑**。`workflows/` 里的 JSON 是 2026-09-04 从节点导出后
实测修补过的版本，ComfyUI 升级或重新导出模板都可能让节点 ID 与枚举值变化。
