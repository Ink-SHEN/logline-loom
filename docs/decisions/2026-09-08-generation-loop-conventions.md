# 决策记录 · 2026-09-08：④⑤⑥ 生成回环的三项约定

> 决定人：本轮把 ④生成 / ⑤质检 / ⑥重试 三站落地的人（按 kickoff 第四节的分工，④⑥ 归 B、⑤ 归 C，
> 这一轮跨了两个工位）。三项约定都落在工位**之间**的边界上，且沿用了 A 在
> [`2026-09-07-editor-input-conventions.md`](2026-09-07-editor-input-conventions.md) 定的产物路径口径。
>
> 本条**没有改 Schema**（`--selftest` 7/7、`negative_test.py` 8/8 复跑通过，`git status contracts/` 为空），
> 所以不必走 `docs/agent_guide.md` 第八节那 5 步；但它给 ⑤ 与 ⑥ 各加了一条对方必须遵守的规矩
> （seed 分配权只归 ⑥、`patch` 的键各归一个 `action` 管），效力等同于跨工位的接口约定，
> 因此比照第八节「**三人一致同意**」的口径，此条需 B、C 追认（A 知情）。
>
> 09-07 那条留的尾巴（给 `output.path` / `source_path` 加 pattern）**仍然没提**，理由见第四节。

---

## 一、决定是什么

**1. 反缓存不变量：每个新候选必须同时换掉 `noise_seed` 与 `filename_prefix`，两者缺一即拒绝产出。
seed 的分配权只归 ⑥重试 一站。**

`filename_prefix` 的口径固定为 `shots/<candidate_id>`，与 09-07 定的扁平产物路径同一套。

**2. ⑥重试 是打补丁，不是重写：可改的字段只有 5 个，`workflow.node_ids` / `api_json` / `assets` 永不动。**

白名单 = `seed` / `duration_seconds` / `megapixels` / `prompt` / `turbo_enabled`。
**`steps` 不在白名单里**——它不是旋钮，是 `workflow.type` + `turbo_enabled` 的派生值，
④生成 会硬卡两者自洽（`agents/generator/graph.js:139-142`），单独打一个 `patch.steps`
只可能产出一份 ④ 当场拒收的 c04。要改步数就开 `enable_turbo`，步数由 ⑥ 按机型算。

**白名单里的每个键还各归一个动作管**（`seed` 除外，它是本站自己的账）：
`duration_seconds`→`change_duration`、`megapixels`→`raise_megapixels`、`prompt`→`rewrite_prompt`、
`turbo_enabled`→`enable_turbo`。c06 的 `action` 说的是意图、`patch` 说的是细节，两者打架时
⑥ 一律打回 ⑤质检 重开，不猜哪个算数——照 `action` 走就是悄悄丢掉 ⑤ 开的方子
（下一轮大概率照原样再失败），照 `patch` 走就是做一件 ⑤ 没声明要做的事，
而 `patch.duration_seconds` 还会绕过时间码等比重排，产出一份 `timecodes` 与 `duration_seconds` 对不上的 c04。

c06 的 8 个 `suggested_change.action` 里，有 4 个 ⑥ 整条打回上游，一个字都不改：

| action | ⑥ 怎么办 |
|---|---|
| `new_seed` / `raise_megapixels` / `enable_turbo` / `change_duration` | 执行 |
| `rewrite_prompt` **且 patch 里给了 prompt** | 执行（照抄 ③ 复核过的文本，⑥ 自己不写） |
| `rewrite_prompt` 而 patch 里没给 prompt | 打回 ③提示词 —— ⑥ 一行创意文本都不写 |
| `switch_workflow_type` | 打回 ②分镜 → ③提示词 → ④生成（换类型会连带换掉 api_json、node_ids 与 assets 的整套结构） |
| `change_reference_asset` | 打回 人工改素材清单 → ③提示词 → ④生成（素材位与 `<Picture N>` 一一绑定，且素材清单是人工侧输入） |
| `manual_intervention` | 写进 `needs_human.md` 转人工 |

**3. ⑤质检 的证据边界：客观 6 项只由 ffprobe 实测值 + 代码硬判，主观 7 项只认三个来源，
没人真看过画面就记「未复核」，不许伪装成 pass。**

三个来源的优先级：`--review` 人工侧清单 > `--vision` 抽帧 + 视觉模型 > `skipped`（未复核）。
未复核项按 `--on-unreviewed human|edit` 分流，默认 `human`。

---

## 二、当时的已知信息

- **ComfyUI 对完全相同的输入 0–1.4 秒返回旧文件**（README 第六节实测表最后一行，缓存命中 21–24 个节点）。
  这条实测数据是约定 1 的全部依据：重试要是没换干净，拿回来的就是同一个坏产物，
  而 GPU 排班表上它照样占一格。
- **换 seed 而不换 `filename_prefix` 会盖掉上一次的归档**：ComfyUI 按 prefix 命名输出文件，
  `shots/S002_c01` 跑两次就是两次写同一个路径。`shots/README.md` 第四节那条
  「候选目录 = candidate_id」的追溯链会当场断掉。
- **seed 若由 ⑤⑥ 两站都能填，迟早撞车**：⑤ 判定时看得见 c04，但它看不见 `shots/` 下
  已经跑出来的其它候选的实测快照（`meta.json` 的 `params_snapshot.seed`）。
  只有 ⑥ 会同时扫「上一批 c04 + `shots/<候选>/meta.json` + 本次运行已分配的」三处，
  所以避让逻辑只能有一份，放在 ⑥。
- **c06 的 `qc_check_name` enum 是 13 项**，其中 6 项（时长 / 帧率 / 有无视频流 / 有无音频流 /
  音频 32k 立体声 / 分辨率与画幅比）是 ffprobe 能直接测出来的数字，
  7 项（提示词遵循度 / 角色一致性 / 场景一致性 / 运动质量 / 音画匹配 / 画面崩坏 / 红线）必须有人看过画面。
  `agents/README.md` 第八节早就写了「不要用 LLM 判客观项」，约定 3 只是把这句话变成代码里的分界。
- **视觉模型看的是静帧不是视频**：ffmpeg 等间隔抽帧之后，`motion_quality`（运动是否平滑）
  与 `audio_matches_scene`（音画匹配）在物理上就判不了。让它输出这两项等于让它编。
- **时长与帧数天生对不齐**：`duration_seconds` 写 6 秒，下游 `ComfyMathExpression` 对齐到 17 的倍数
  （6s → 141 帧 = 5.875s）；而 ffprobe 的 `format.duration` 取的是各条流的最大值，音轨常比视频轨长几帧
  （实测容器报 6.083s）。所以「时长 × 24 = 帧数」这个等式在本项目**永远不成立**，
  容差取 0.75s ≈ 一个 17 帧对齐步长（17/24 = 0.708s）。
- **`retry_count` 有两个可能的来源**：c06 里 ⑤ 记的那个数，与 `shots/` + 上一批 c04 里
  实际存在的 `retry_of != null` 的份数。两者可能不一致（比如 ⑤ 拿到的是旧的 c06）。

---

## 三、备选方案与为什么不选

**约定 1（反缓存）**

| 方案 | 为什么不选 |
|---|---|
| 只换 seed，`filename_prefix` 保持 `shots/<shot_id>` | 新候选会盖掉旧候选的产物与 `meta.json`，⑤ 的复检、⑦ 的选候选、`shots/README.md` 的追溯链全部失去对象。省一个目录换不回这些 |
| 让 ④生成 在提交前自己去重（发现 seed 撞了就自己换一个） | 那会让 ④ 也变成 seed 的分配方，两站各有一套避让逻辑，且 ④ 看不到 ⑥ 本次运行已经分配出去的号。避让只能有一份 |
| seed 用随机数 | 「可复现」是本项目的明面目标之一。随机数出了问题查不回去；`上一个 seed + 质数步长` 是确定的、可复算的，且质数步长让多次重试不会落在等差数列上与别的镜头周期性相交 |
| 不拦，只在文档里写「记得换种子」 | README 第六节已经这么写了一轮，而 ⑥ 是自动跑的。约定要能被机器拦住才算约定（同 09-07 与第六节的口径） |

**约定 2（⑥ 的权限边界）**

| 方案 | 为什么不选 |
|---|---|
| 让 ⑥ 按 c06 的 `root_cause` 自己重写提示词 | ⑥ 拿不到 c03 分镜、拿不到素材清单、也没人复核它写的东西。它写出来的提示词会直接进 ④ 烧 GPU。写提示词是 ③ 的活，打回 ③ 只多一次调用，不多一轮 GPU |
| 把白名单放宽到整个 `payload.generation` | 里面躺着 `aspect_ratio` / `fps` / `sampler_name` / `scheduler` 四个**契约常量**，还有 `filename_prefix` 这个追溯锚点。放宽等于允许 ⑥ 产出结构合法但口径分叉的 c04 |
| 给 `negative_prompt` / `cfg` 留位置 | H3 用 `BasicGuider` 而非 `CFGGuider`，**这两项在本项目根本不存在**（README 第七节限制 1）。⑥ 收到就明确拒并说明为什么，而不是静默忽略——静默忽略会让 ⑤ 以为自己的建议被采纳了 |
| 越权时直接 exit 1 | 越权不是故障，是权限边界。exit 1 会让上游以为 ⑥ 坏了；实际发生的是「这张方子本站开不出来，得换个人开」。所以 exit 0 + `needs_human.md`，逐条注明转交谁、下一步命令是什么 |
| 从 refusal 文本里猜该转交哪一站 | 猜出来的路由不稳定也不可测。改成 `PATCH_OWNER` 查表：键 → 归属工位，写死在代码里 |
| `action` 与 `patch` 归属对不上时，照 `action` 走、把多余的键悄悄丢掉 | 初版就是这么写的，实测后果是 `action=new_seed` + `patch.megapixels` 会产出一份**分辨率没动过**的新 c04，⑤ 开的方子被静默吞掉，下一轮大概率照原样再失败一次，而控制台与 `envelope.notes` 里一个字都没提 |
| 反过来照 `patch` 走、白名单内的键一律照抄 | 那就是做一件 ⑤ 没声明要做的事。最坏的是 `patch.duration_seconds`：它绕过 `change_duration` 分支的时间码等比重排，产出一份 `duration_seconds=8` 而 `timecodes` 还收在 5s 的 c04——本站自检会拦下来，但拦下来的方式是**整批 throw**，同一批其它镜头的转交清单跟着一起丢 |
| 保留一个「其余白名单键照抄」的兜底循环 | 5 个键里 4 个各归一个动作分支处理、`seed` 归本站自己分配，兜底循环里跑得到的只剩归属对不上的那些。它既不是安全网也不是扩展点，只是把上面两条错误路径藏在代码里 |

**约定 3（⑤ 的证据边界）**

| 方案 | 为什么不选 |
|---|---|
| 没有 `--review` 也没有 `--vision` 时，让 LLM 读 c04 的提示词与 c05 的元数据「推断」画面质量 | 那就是伪造判决。c06 是下游决定要不要再烧一轮 GPU 的依据，一份没人看过画面的 pass 会让人白等一轮，一份没人看过画面的 fail 会让人白烧一轮 |
| 把 7 个主观项全交给视觉模型 | 它看的是静帧，`motion_quality` 与 `audio_matches_scene` 判不了。硬要它输出就是硬要它编，而且编出来的分数会进 `route_to` 的计算 |
| 未复核项默认放行进剪辑（`--on-unreviewed edit`） | 出片速度快，但等于把「没人看过」伪装成「看过了」。默认取 `human`，要快的人自己显式加 `--on-unreviewed edit`，这个选择会留在命令历史里 |
| 缺 ffprobe 时硬阻塞 | 那是 ④ 的语义（④ 要**产出**证据，编不出来就是不能出片）。⑤ 是在**采信** c05 记下的证据，而 c05 带着 sha256 与 size_bytes，采信是有担保的。所以 ⑤ 降级 + 大声告警，并在 c06 的 `envelope.notes` 里写清数据来源是「c05（已校 sha256，本机无 ffprobe 所以没重测）」。两站的失败语义相反，所以两份 ffprobe 代码故意不合并 |
| `retry_count` 只信 c06 记的那个数 | c06 可能是旧的。⑥ 取「c06 的值」与「实际数出来的 `retry_of != null` 份数」两者的较大值，并在不一致时告警——宁可早一次转人工，不可多烧一轮 GPU |

---

## 四、什么条件下该重新审视它

- **提 `output.path` / `source_path` 的 pattern 进契约时**（09-07 留的尾巴）：
  本轮没提，因为 ④ 刚落地、路径口径只在代码与文档里对齐了一轮，还没有真机产物验证过。
  等第一批真 mp4 落盘、确认 `shots/<candidate_id>/video.mp4` 这个口径在渲染侧也走得通，
  再按第八节的五步流程提 `^shots/S[0-9]{3}_c[0-9]{2}/video\.[a-z0-9]+$`。B 是同意的另一方。
- **若 ComfyUI 换了缓存策略**（比如开始把 `filename_prefix` 排除在缓存键之外）：
  约定 1 里「必须换 prefix」这一半可以放松成「建议换」，但 seed 那一半不放松——
  覆盖旧归档的问题与缓存无关。
- **若 H3-Regenerate-2K 发布**：`raise_megapixels` 的目标值不再固定是 1.0，
  ⑤ 的 `pickAction` 与 ⑥ 的 megapixels 上限都要跟着改；`steps` 与 `turbo_enabled` 的对应关系
  （turbo 下 R2V=4、其余=8，正常=20）也是按当前模板写死的，换模板要重新实测。
- **若一个镜头的候选数超过 99**：`candidate_id` 的契约 pattern 是 `_c[0-9]{2}`，只有两位。
  ⑥ 撞到 c99 会阻塞转人工而不是绕过去。真要出这么多候选，先改契约再改代码。
- **若主观项要加到 8 项以上**：`qc_check_name` enum 要扩，那是改 Schema，走第八节。
  同时 ⑤ 的 `VISION_SCOPE` / `TEXT_SCOPE` / `HARD_SUBJECTIVE` / `CHECK_ORDER` 四个集合都要跟着定，
  其中 `HARD_SUBJECTIVE`（fail 即整条 fail）的取舍最要慎重——它直接决定要不要再烧一轮 GPU。
