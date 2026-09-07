# shots/

每个候选镜头一个目录。**视频文件不入库**，只留可复现的证据。

`.gitignore` 已经把 `shots/` 下的所有媒体格式排除，
但显式放行了四个文件：`meta.json`、`selected.txt`、`ffprobe.txt`、`README.md`。
所以往这里扔 mp4 不会污染仓库，但也不会被提交——**这是故意的**。

---

## 一、目录结构

```
shots/
  S001_c00/
    meta.json         ← c05_gen_result 契约实例，入库
    ffprobe.txt       ← ffprobe 原始输出，入库
    selected.txt      ← 人工筛选记录，入库
    video.mp4         ← 产物，不入库（本地 / 网盘留存）
  S001_c01/
    ...
  S001_c02/
    ...
```

命名规则来自契约，**不是建议**：

| 项 | 格式 | 校验正则 |
|---|---|---|
| 镜头号 `shot_id` | `S001` | `^S[0-9]{3}$` |
| 候选号 `candidate_id` | `S001_c00` | `^S[0-9]{3}_c[0-9]{2}$` |
| 目录名 | 与 `candidate_id` 相同 | |
| `filename_prefix` | `shots/S001_c00` | `^shots/S[0-9]{3}(_c[0-9]{2})?$` |

候选号从 `c00` 开始连续递增。**一个镜头默认出 3 个候选**，
质检不过由重试 Agent 追加 `c03`、`c04`，不要覆盖已有目录。

> 反面例子：节点上历史运行用过 `video/MiniMax_H3`、`test-shot`、`shot1`
> 这类默认前缀，结果两次运行指向同一个文件、互相覆盖。
> 见 `docs/task_registry.md` 第三节 ⑤。

---

## 二、`meta.json`

就是 **c05_gen_result 契约的一份实例**。模板见 `meta_template.json`。

填法：

```bash
cp shots/meta_template.json shots/S001_c00/meta.json
# 填完立刻校验
python contracts/validate_contract.py --contract c05_gen_result --file shots/S001_c00/meta.json
```

### 三个必须当场填、事后补不回来的字段

| 字段 | 为什么补不回来 |
|---|---|
| `payload.params_snapshot.seed` | 换一次种子就是另一个视频。事后猜不出来，猜对了也无法证明 |
| `payload.comfy_prompt_id` | 这是唯一能 `GET /history/<id>` 拿回当时整张图的钥匙。ComfyUI 重启后 history 可能清空 |
| `payload.output.sha256` | 文件被覆盖后再算就是另一个哈希，等于失去了「这就是当时那个产物」的证据 |

`params_snapshot` 记的是**实际写进工作流的最终值**，
重试时可能和 c04 请求的不一样，这里记真跑的那份。

`model_files.unet_name` 必须如实填 —— 它是判断「这次跑的是 FL2VA 还是 Ref2VA」
的唯一依据，也是复现时要不要换权重的依据。

### 自动化

不要手写。让生成 Agent 在拿到 `/history/<prompt_id>` 后直接生成，
所需字段全都能从返回里取到（时间戳、缓存节点数、产物文件名）。
`ffprobe` 部分单独跑一次命令填进去：

```bash
ffprobe -v error -print_format json -show_format -show_streams \
        shots/S001_c00/video.mp4 > shots/S001_c00/ffprobe.txt
```

---

## 三、`selected.txt`

人工筛选记录。一行一个决定，纯文本，方便 diff：

```
# S001 三个候选，2026-09-07 由 A 裁决
S001_c00  rejected  人物面部在第 3 秒崩了
S001_c01  SELECTED  构图与光线符合分镜，音频层次可用
S001_c02  rejected  镜头运动过猛，与前一镜接不上
```

为什么用 txt 不用 json：这个文件是**人的裁决**，
会被反复追加和修改，纯文本的 diff 在评审时最容易看懂，
也不需要 schema。`SELECTED` 大写，方便 `grep` 出全片选定的镜头：

```bash
grep -r "SELECTED" shots/*/selected.txt
```

---

## 四、成片阶段怎么用这个目录

剪辑 Agent 产 c07_edit_decision 时，
`timeline[]` 逐条引用这里的 `candidate_id`，`source_path` 原样取该候选 c05 的 `output.path`。
**目录名 = `candidate_id` 这一扁平形态是全片唯一的产物路径口径**（第一节表格里那三行），
谁也不要另拼一套。最终成片里每一个镜头都能反查到：

```
成片时间码 → c07.timeline[].source_path → shots/S001_c01/meta.json
                              → params_snapshot.prompt   （提示词）
                              → params_snapshot.seed     （种子）
                              → upstream_refs            （c04 → c03 → c02 → c01）
                              → comfy_prompt_id          （节点上的完整记录）
```

这条链是「可追溯」的实际含义，也是复现开源那 10 分的主要证据。
