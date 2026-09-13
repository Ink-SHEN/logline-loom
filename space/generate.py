# -*- coding: utf-8 -*-
"""⑤ 生成站 —— 一层可插拔的「生成模型 API」接口。

为什么是接口，而不是内置模型
----------------------------
本创空间**不内置、也不绑定任何具体的视频生成模型**，也不依赖仓库外的私有节点。
⑤ 生成站只做两件事：

  1. 把 ④ 产出的 c04 生成请求，翻译成一次**标准化 API 调用**；
  2. 把结果（任务 ID / 进度 / 成片地址）**原样如实**带回界面。

换模型 = 配几个环境变量，Agent 代码一行都不用改。

接口契约 v1（REST + JSON）
--------------------------
提交任务
    POST  {LOOM_GEN_API_URL}/generations
    Authorization: Bearer {LOOM_GEN_API_KEY}        # Key 为空则不发送该头
    {
      "model": "…",               # LOOM_GEN_API_MODEL，可省略
      "prompt": "…",              # 必填，取自 c04 payload.generation.prompt
      "duration_seconds": 5.0,    # 3–8 秒（单镜演示时长）
      "seed": 12345,              # 可选
      "prefix": "loom/S001",      # 可选，产物归档前缀
      "aspect_ratio": "16:9 (Widescreen)"
    }
    → 200 / 201 / 202
    { "task_id": "…", "status": "queued", "eta_seconds": 300 }

    * 同步后端可以在提交响应里直接给 `video_url`，本层自动判为已完成。

查询任务
    GET   {LOOM_GEN_API_URL}/generations/{task_id}
    Authorization: Bearer {LOOM_GEN_API_KEY}
    → 200
    { "task_id": "…",
      "status": "queued | running | succeeded | failed",
      "progress": 0.42,              # 可选
      "video_url": "https://…",      # succeeded 时必给
      "detail": "…" }                # 可选，任意补充说明

对模型侧的唯一硬要求：**能返回一个可播放的 mp4 URL**。
异步还是同步、有没有进度、支不支持 seed，全都是可选的。

三种状态（界面上如实显示，不伪装）
----------------------------------
  已接入      LOOM_GEN_API_URL 已配置 → 真提交，拿任务 ID
  接口就绪    未配置 URL → 明说「等待接入模型」，不拿示例素材冒充本次生成
  参考回放    LOOM_GEN_BACKEND=replay → 播放 space/fallback 的往期成片，恒标注
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config

SPEC_VERSION = "v1"

INTERFACE_TITLE = "⑤ 生成站：一层可插拔的模型 API 接口"


# ---------------------------------------------------------------- 界面文案

NOT_CONNECTED_NOTE = (
    "**⑤ 生成接口已就绪，等待接入模型。**\n\n"
    "本创空间不内置视频生成模型——⑤ 站对外只暴露**一层标准化的模型 API 接口**："
    "把 ④ 产出的生成请求发出去、把任务状态取回来。接入任意满足该契约的生成服务"
    "（配 `LOOM_GEN_API_URL` / `LOOM_GEN_API_KEY` / `LOOM_GEN_API_MODEL` 三个环境变量）"
    "即可端到端出片，**Agent 代码无需改动**。\n\n"
    "④ 站已按契约产出该镜头的完整生成请求（英文提示词 + 时长 + 画幅），接口一通即可下发。"
    "下方播放的是 `space/fallback/` 里的**往期示例成片**，仅用于展示 ⑤ 站的产物形态，"
    "**不是本次生成的结果**。"
)

REPLAY_NOTE = (
    "**⑤ 生成站当前为「参考回放」模式**（`LOOM_GEN_BACKEND=replay`）。\n\n"
    "不调用任何模型，播放 `space/fallback/` 里的往期成片，用于展示 ⑤ 站接上模型后的产物形态。"
    "**这不是本次生成的结果**，也不代表当前有任何模型在跑。"
)


def interface_markdown():
    """给界面用的接口说明（与模块头部的契约同源，改代码时一并改）。"""
    return """#### 一句话

创空间**不内置视频生成模型**，⑤ 站对外只有一层**标准化的模型 API 接口**：
把 ④ 的生成请求发出去、把任务状态取回来。**换模型 = 改环境变量，不改 Agent 代码。**

#### 接口契约（%s）

| 动作 | 请求 | 期望响应 |
|---|---|---|
| 提交 | `POST {LOOM_GEN_API_URL}/generations` | `{"task_id": "…", "status": "queued", "eta_seconds": 300}` |
| 查询 | `GET {LOOM_GEN_API_URL}/generations/{task_id}` | `{"status": "succeeded", "video_url": "https://….mp4"}` |

提交体（由 ④ 的 c04 产物直接映射，无需人填）：

```json
{
  "model": "<LOOM_GEN_API_MODEL，可省>",
  "prompt": "<c04 payload.generation.prompt，英文提示词>",
  "duration_seconds": 5.0,
  "seed": 12345,
  "prefix": "loom/S001",
  "aspect_ratio": "16:9 (Widescreen)"
}
```

鉴权：`Authorization: Bearer <LOOM_GEN_API_KEY>`（Key 为空时不发送，便于内网/本地服务）。
**对模型侧唯一的硬要求是能返回一个可播放的 mp4 URL**——同步还是异步、有没有进度条、
支不支持 seed，全都是可选的；同步后端在提交响应里直接给 `video_url` 也会被自动识别。

#### 接入方式（创空间 secrets）

| 变量 | 用途 |
|---|---|
| `LOOM_GEN_API_URL` | 模型服务基址，如 `https://<host>/v1`。**不配 = 接口就绪但未接入模型** |
| `LOOM_GEN_API_KEY` | 鉴权 Key（敏感，配成 secret） |
| `LOOM_GEN_API_MODEL` | 模型名，随请求发送；服务端不需要就留空 |
| `LOOM_GEN_BACKEND` | `http`（默认）/ `replay`（内置参考回放） |
| `LOOM_GEN_TIMEOUT` | 单次 HTTP 超时秒数，默认 30 |

> 接不上的时候界面**只会说真话**：明示「等待接入模型」，而不是拿示例素材冒充本次生成。
""" % SPEC_VERSION


# ---------------------------------------------------------------- 后端接口

class GenerationBackend(object):
    """生成后端统一接口。实现下面三个方法，即可接入任意模型服务。"""

    slug = "base"
    title = "接口基类"

    def describe(self):
        """一句话说明这个后端是什么。"""
        return ""

    def available(self):
        """返回 (是否可用, 说明文字)。

        不可用**不等于抛错**——界面要如实显示「为什么没接上」，
        而不是安静地换素材糊弄过去。
        """
        return False, "未实现"

    def submit(self, request):
        """提交一次生成，返回统一任务 dict（见 _normalize_task）。"""
        raise NotImplementedError

    def query(self, task_id):
        """查一次任务状态，返回统一任务 dict。"""
        raise NotImplementedError


class HttpModelAPI(GenerationBackend):
    """通用模型 API：任何实现上面契约的生成服务都能接。"""

    slug = "http"
    title = "通用模型 API（HTTP + JSON）"

    def describe(self):
        return ("把 c04 的生成请求按契约 POST 给外部模型服务，再轮询任务状态取回成片。"
                "换模型只改环境变量。")

    def available(self):
        url = config.gen_api_url()
        if not url:
            return False, "未接入：未配置 LOOM_GEN_API_URL"
        model = config.gen_api_model()
        return True, "已接入：%s%s" % (url, ("（模型 %s）" % model) if model else "")

    def _headers(self):
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        key = config.gen_api_key()
        if key:
            h["Authorization"] = "Bearer %s" % key
        return h

    def submit(self, request):
        url = config.gen_api_url()
        if not url:
            raise RuntimeError("未配置 LOOM_GEN_API_URL：生成接口已就绪，但还没有接入模型")
        body = dict(request)
        model = config.gen_api_model()
        if model:
            body["model"] = model
        data = _http_json(url + "/generations", headers=self._headers(),
                          payload=body, timeout=config.gen_timeout())
        return _normalize_task(data, fallback_id=None)

    def query(self, task_id):
        url = config.gen_api_url()
        if not url:
            raise RuntimeError("未配置 LOOM_GEN_API_URL：生成接口已就绪，但还没有接入模型")
        endpoint = "%s/generations/%s" % (url, urllib.parse.quote(str(task_id), safe=""))
        data = _http_json(endpoint, headers=self._headers(), timeout=config.gen_timeout())
        return _normalize_task(data, fallback_id=task_id)


class ReplayBackend(GenerationBackend):
    """内置参考回放：不调模型，播放 space/fallback 的往期成片。"""

    slug = "replay"
    title = "参考回放（内置示例素材，非模型生成）"

    def describe(self):
        return ("不调用任何模型，播放 space/fallback 里的往期成片，"
                "用于展示 ⑤ 站接上模型后的产物形态；界面恒标注「参考回放」。")

    def available(self):
        n = len(clips())
        if n:
            return True, "内置示例素材 %d 段（往期成片，非本次生成）" % n
        return False, "space/fallback/ 里没有可用素材"

    def submit(self, request):
        items = clips(limit=1)
        if not items:
            raise RuntimeError("space/fallback/ 里没有可用素材")
        return {"task_id": "replay-%s" % time.strftime("%Y%m%d-%H%M%S"),
                "status": "succeeded", "video_url": "", "video_path": items[0],
                "progress": 1.0, "replay": True, "detail": "参考回放（非模型生成）"}

    def query(self, task_id):
        return {"task_id": task_id, "status": "succeeded", "progress": 1.0,
                "detail": "参考回放（非模型生成）", "video_url": ""}


_BACKENDS = {"http": HttpModelAPI(), "replay": ReplayBackend()}


def backends():
    return dict(_BACKENDS)


def active():
    """当前后端。未识别的取值回退到 http（宁可不接，也不悄悄回放）。"""
    return _BACKENDS.get(config.gen_backend()) or _BACKENDS["http"]


def available():
    """返回 (是否可用, 说明)。探的是「接口有没有接上模型」，不发真实生成请求。"""
    b = active()
    return b.available()


def status_lines():
    """自检/状态区用的一行文字。"""
    b = active()
    ok, detail = b.available()
    label = {True: "已接入", False: "未接入"}[bool(ok)]
    extra = "" if b.slug == "http" else "（后端：%s）" % b.title
    return "⑤ 生成接口 · %s —— %s%s" % (label, detail, extra)


# ---------------------------------------------------------------- HTTP 细节

def _http_json(url, headers, payload=None, timeout=30):
    """一次 JSON 往返。错误一律转成可读文本往上抛（界面会如实显示）。"""
    data = None
    method = "GET"
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        method = "POST"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("模型接口 HTTP %s：%s" % (e.code, detail or e.reason))
    except Exception as e:
        raise RuntimeError("模型接口请求失败（%s）：%s" % (url, e))
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        raise RuntimeError("模型接口返回的不是 JSON：%s" % raw[:200])


_PENDING = ("queued", "pending", "submitted", "created")
_RUNNING = ("running", "processing", "in_progress", "generating")
_OK = ("succeeded", "success", "done", "completed", "finished")
_FAIL = ("failed", "error", "canceled", "cancelled")


def _norm_status(value):
    s = str(value or "").strip().lower()
    if s in _OK:
        return "succeeded"
    if s in _FAIL:
        return "failed"
    if s in _RUNNING:
        return "running"
    if s in _PENDING:
        return "queued"
    return s or "queued"


def _normalize_task(data, fallback_id=None):
    """把各家模型服务的响应收成统一形状。

    只认「任务 ID + 状态 + 成片 URL」这三件必要信息，其余原样塞进 raw 供排查。
    同步后端（提交响应里直接带 video_url）会被自动判为已完成。
    """
    if not isinstance(data, dict):
        raise RuntimeError("模型接口响应不是对象：%s" % str(data)[:200])

    # 常见的包一层：{"data": {...}} / {"result": {...}}
    for key in ("data", "result", "output"):
        inner = data.get(key)
        if isinstance(inner, dict) and any(
                k in inner for k in ("task_id", "id", "status", "video_url")):
            data = dict(data, **inner)
            break

    task_id = None
    for k in ("task_id", "id", "request_id", "prompt_id"):
        if data.get(k):
            task_id = str(data[k])
            break
    task_id = task_id or fallback_id

    status = _norm_status(data.get("status") or data.get("state"))
    video = ""
    for k in ("video_url", "url", "output_url", "video"):
        v = data.get(k)
        if isinstance(v, str) and v.startswith(("http://", "https://")):
            video = v
            break
        if isinstance(v, dict) and isinstance(v.get("url"), str):
            video = v["url"]
            break
    # 提交响应里直接给了成片地址 → 同步后端，判为已完成
    if video and status in ("queued", "running"):
        status = "succeeded"

    eta = data.get("eta_seconds") or data.get("eta") or 0
    try:
        eta = int(float(eta))
    except Exception:
        eta = 0

    return {
        "task_id": task_id,
        "status": status,
        "progress": data.get("progress"),
        "video_url": video,
        "video_path": "",
        "eta_seconds": eta,
        "detail": str(data.get("detail") or data.get("message") or ""),
        "raw": data,
    }


# ---------------------------------------------------------------- 本地任务表

TASKS_FILE = os.path.join(config.OUT_DIR, "gen_tasks.json")


def _load_tasks():
    if os.path.exists(TASKS_FILE):
        try:
            return json.load(open(TASKS_FILE, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_tasks(tasks):
    try:
        json.dump(tasks, open(TASKS_FILE, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    except Exception:
        pass


def list_tasks(limit=8):
    rows = sorted(_load_tasks().values(),
                  key=lambda x: x.get("submitted_at", 0), reverse=True)
    return rows[:limit]


# ---------------------------------------------------------------- 对外动作

def prompt_from_c04(gen_request):
    """从 c04 里取出要送进模型的提示词与时长。

    c04_gen_request 契约的 payload 是**单个镜头**的请求（required 是 shot_id /
    candidate_id，不是数组），所以正路是读 payload.generation；
    数组形态只是给旧输出留的退路。
    """
    payload = (gen_request or {}).get("payload") or {}

    gen = payload.get("generation")
    if isinstance(gen, dict) and gen.get("prompt"):
        return _clip(gen.get("prompt"), gen.get("duration_seconds"))

    shots = payload.get("shots") or payload.get("requests") or []
    if isinstance(shots, dict):
        shots = list(shots.values())
    for s in shots:
        if not isinstance(s, dict):
            continue
        text = s.get("prompt") or s.get("prompt_text")
        if text:
            return _clip(text, s.get("duration_seconds") or s.get("seconds"))
    return "", 0.0


def _clip(text, seconds):
    try:
        secs = float(seconds or 5)
    except Exception:
        secs = 5.0
    # 单镜演示取 3–8 秒：短到等得起，长到看得出画面。
    return text, max(3.0, min(secs, 8.0))


def submit(prompt, seconds=5.0, seed=None, prefix="loom/S001", aspect_ratio=""):
    """提交一次生成，记进本地任务表并返回统一任务 dict。"""
    b = active()
    ok, detail = b.available()
    if not ok:
        raise RuntimeError(detail)
    request = {
        "prompt": prompt,
        "duration_seconds": float(seconds),
        "prefix": prefix,
    }
    if seed is not None:
        request["seed"] = int(seed)
    if aspect_ratio:
        request["aspect_ratio"] = aspect_ratio

    task = b.submit(request)
    if not task.get("task_id"):
        raise RuntimeError("模型接口没有返回 task_id：%s" % json.dumps(
            task.get("raw") or {}, ensure_ascii=False)[:200])
    task = dict(task)
    task.update({
        "backend": b.slug,
        "submitted_at": time.time(),
        "prompt_text": (prompt or "")[:200],
        "seconds": float(seconds),
    })
    tasks = _load_tasks()
    tasks[task["task_id"]] = task
    _save_tasks(tasks)
    return task


def query(task_id):
    """查一次任务状态；拿到成片就下载到本地并返回路径。"""
    tasks = _load_tasks()
    t = tasks.get(task_id)
    b = active()
    if t and t.get("video_path") and os.path.exists(t["video_path"]):
        return {"status": "succeeded", "detail": "生成完成（本地已归档）",
                "path": t["video_path"], "elapsed": _elapsed(t)}

    try:
        fresh = b.query(task_id)
    except Exception as e:
        if t:
            return {"status": t.get("status") or "queued",
                    "detail": "查询失败：%s" % e, "elapsed": _elapsed(t)}
        return {"status": "unknown", "detail": "查询失败：%s" % e}

    if t:
        preview_kept = {k: t[k] for k in ("submitted_at", "prompt_text", "seconds", "backend")
                        if k in t}
        t.update(fresh)
        t.update(preview_kept)
    else:
        t = fresh
        t.setdefault("submitted_at", time.time())
    t["backend"] = t.get("backend") or b.slug

    if t.get("status") == "succeeded":
        if t.get("video_url") and not t.get("video_path"):
            try:
                t["video_path"] = _download(t["video_url"], t.get("task_id") or task_id)
            except Exception as e:
                t["detail"] = (t.get("detail") or "") + "；下载成片失败：%s" % e
        tasks[t.get("task_id") or task_id] = t
        _save_tasks(tasks)
        return {"status": "succeeded",
                "detail": t.get("detail") or "生成完成",
                "path": t.get("video_path") or "",
                "elapsed": _elapsed(t)}

    tasks[t.get("task_id") or task_id] = t
    _save_tasks(tasks)
    return {"status": t.get("status") or "queued",
            "detail": t.get("detail") or _progress_text(t),
            "path": "", "elapsed": _elapsed(t)}


def _elapsed(t):
    try:
        return int(time.time() - float(t.get("submitted_at") or time.time()))
    except Exception:
        return 0


def _progress_text(t):
    p = t.get("progress")
    if isinstance(p, (int, float)):
        return "生成中，进度约 %d%%" % round(float(p) * 100)
    eta = t.get("eta_seconds") or 0
    if eta:
        return "生成中（服务端预计 %d 秒）" % eta
    return "任务已受理，等待服务端返回结果"


def _download(url, task_id):
    """把成片拉到本地，界面才能稳定播放（外部 URL 可能有时效）。"""
    safe = "".join(c for c in str(task_id) if c.isalnum() or c in "-_")[:48] or "task"
    path = os.path.join(config.OUT_DIR, "gen_%s_%s.mp4" % (int(time.time()), safe))
    req = urllib.request.Request(url, headers={"User-Agent": "LOOM/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read()
    open(path, "wb").write(raw)
    return path


# ---------------------------------------------------------------- ⑤ 编排入口

def run_c05(gen_request, offline=False, seed=None, aspect_ratio="", prefix="loom/S001"):
    """⑤ 生成站的统一入口，返回给界面用的结果 dict。

    无论走哪条路都**如实**说明发生了什么，并统一带上示例素材做预览：
      mode=api            提交成功 → 带任务 ID
      mode=not_connected  接口就绪但没接模型 → 明说，不冒充
      mode=replay         参考回放模式
      mode=offline        演示/离线模式，不发起任何外部调用
    """
    b = active()
    ok, detail = b.available()
    sample = clips()

    base = {"backend": b.slug, "backend_title": b.title, "detail": detail,
            "shots": sample, "task": None, "prompt": "", "seconds": 0.0}

    if offline:
        base.update({"mode": "not_connected",
                     "note": NOT_CONNECTED_NOTE + "\n\n（离线模式：本次未发起任何外部调用）"})
        return base

    if b.slug == "replay":
        try:
            task = submit(*prompt_from_c04(gen_request), seed=seed, prefix=prefix,
                          aspect_ratio=aspect_ratio)
            base.update({"mode": "replay", "task": task, "note": REPLAY_NOTE})
        except Exception as e:
            base.update({"mode": "not_connected",
                         "note": "参考回放不可用：%s\n\n%s" % (e, NOT_CONNECTED_NOTE)})
        return base

    if not ok:
        base.update({"mode": "not_connected", "note": NOT_CONNECTED_NOTE})
        return base

    prompt, seconds = prompt_from_c04(gen_request)
    if not prompt:
        base.update({"mode": "not_connected",
                     "note": "④ 的 c04 产物里没取到 `payload.generation.prompt`，"
                             "无法组装生成请求。请先重跑 ④ 提示词站。"})
        return base

    base.update({"prompt": prompt, "seconds": seconds})
    try:
        task = submit(prompt, seconds, seed=seed, prefix=prefix, aspect_ratio=aspect_ratio)
    except Exception as e:
        base.update({"mode": "not_connected",
                     "note": "提交生成请求失败：%s\n\n%s" % (e, NOT_CONNECTED_NOTE)})
        return base

    eta = task.get("eta_seconds") or 0
    if task.get("status") == "succeeded" and task.get("video_url"):
        base.update({"mode": "api", "task": task,
                     "note": "已提交并**同步返回成片**：用任务 ID `%s` 在下方「查询生成任务」取回。"
                             % task["task_id"]})
        return base
    base.update({
        "mode": "api", "task": task,
        "note": ("已向生成接口提交任务（ID `%s`%s）。接口返回的是异步任务，"
                 "用任务 ID 在下方「查询生成任务」取回成片。\n\n"
                 "下方播放的是示例素材（非本次生成）。"
                 % (task["task_id"],
                    "，服务端预计 %d 秒" % eta if eta else "")),
    })
    return base


# ---------------------------------------------------------------- 示例素材

def clips(limit=6):
    """space/fallback 里的往期成片列表（界面预览用）。顺序按 index.json。"""
    idx_path = os.path.join(config.FALLBACK_DIR, "index.json")
    names = []
    if os.path.exists(idx_path):
        try:
            idx = json.load(open(idx_path, encoding="utf-8"))
            names = [s["file"] for s in idx.get("shots", [])]
        except Exception:
            names = []
    if not names:
        try:
            names = sorted(f for f in os.listdir(config.FALLBACK_DIR)
                           if f.lower().endswith(".mp4"))
        except Exception:
            names = []
    paths = [os.path.join(config.FALLBACK_DIR, n) for n in names]
    return [p for p in paths if os.path.exists(p)][:limit]


def sample_note():
    idx_path = os.path.join(config.FALLBACK_DIR, "index.json")
    if os.path.exists(idx_path):
        try:
            return json.load(open(idx_path, encoding="utf-8")).get("note", "")
        except Exception:
            return ""
    return ""
