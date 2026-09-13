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

配置从哪来（2026-09-13 起支持界面运行时填）
-------------------------------------------
  界面填入的地址 / Key / 模型名  >  环境变量（创空间 secrets）

使用者可以完全不动环境变量，在自己的浏览器里填一次就把 ①→⑤ 跑通。
界面填的 Key **只活在这一次请求里**：不落盘、不进日志（GenSettings.__repr__ 已掩码）。
另外地址会过一遍 check_endpoint() 的 SSRF 校验——创空间是公网服务，
不能让人借它去探内网或云元数据端点；本地调试用 LOOM_GEN_ALLOW_PRIVATE=1 放行。
"""
import ipaddress
import itertools
import json
import os
import socket
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
    "把 ④ 产出的生成请求发出去、把任务状态取回来。\n\n"
    "**两种接入方式任选其一，即可端到端出片，Agent 代码无需改动：**\n"
    "1. 在**「⑤ 生成接口」页签顶部的「接入你自己的生成模型」**里填地址 / Key / 模型名"
    "（临时，不落盘，只活在这一个浏览器会话里）；\n"
    "2. 或配环境变量 `LOOM_GEN_API_URL` / `LOOM_GEN_API_KEY` / `LOOM_GEN_API_MODEL`。\n\n"
    "④ 站已按契约产出**逐镜头**的完整生成请求（英文提示词 + 时长 + 画幅），接口一通即可逐镜下。"
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

#### 接入方式（两种，任选其一）

**① 在本页顶部直接填**（推荐试用）：地址 / Key / 模型名填好点「开始生成」，①→⑤ 当场跑通，不用碰环境变量。
填进去的 Key **不落盘、不进日志**，只活在你这一次请求里，刷新页面即失效。

**② 配环境变量**（创空间 secrets，适合长期接入）：

| 变量 | 用途 |
|---|---|
| `LOOM_GEN_API_URL` | 模型服务基址，如 `https://<host>/v1`。**不配 = 接口就绪但未接入模型** |
| `LOOM_GEN_API_KEY` | 鉴权 Key（敏感，配成 secret） |
| `LOOM_GEN_API_MODEL` | 模型名，随请求发送；服务端不需要就留空 |
| `LOOM_GEN_BACKEND` | `http`（默认）/ `replay`（内置参考回放） |
| `LOOM_GEN_TIMEOUT` | 单次 HTTP 超时秒数，默认 30 |
| `LOOM_GEN_WAIT_SECONDS` | ⑤ 等待成片的秒数上限，默认 300（`0` = 只提交不等待） |
| `LOOM_GEN_MAX_SHOTS` | 本次最多下发几个镜头，默认 8 |

界面上填的值**优先于**环境变量。

> 地址只允许公网 `http/https`：创空间是公开服务，不能借它去探内网或云元数据端点（SSRF）。
> 本地调试跑在 `127.0.0.1` 时，设 `LOOM_GEN_ALLOW_PRIVATE=1` 放行。

> 接不上的时候界面**只会说真话**：明示「等待接入模型」，而不是拿示例素材冒充本次生成。
""" % SPEC_VERSION


# ---------------------------------------------------------------- 地址安全校验

# 创空间是公网服务、接口地址由任意访客填 —— 不能让它替调用方去探内网或云元数据
# 端点（SSRF）。下面这份是「拒答名单」：环回、私网、链路本地、CGNAT、IPv6 本地。
_BLOCKED_NETS = tuple(ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
    "::1/128", "fc00::/7", "fe80::/10",
))
_BLOCKED_HOSTS = ("localhost", "metadata.google.internal", "metadata")


def _allow_private():
    """本地调试逃生口：测试里的假模型服务跑在 127.0.0.1。生产不开。"""
    return (os.environ.get("LOOM_GEN_ALLOW_PRIVATE") or "").strip().lower() in (
        "1", "true", "yes", "on")


def _as_ip(s):
    try:
        return ipaddress.ip_address(str(s).split("%")[0])
    except ValueError:
        return None


def _blocked_ip(s):
    ip = _as_ip(s)
    return bool(ip) and any(ip in net for net in _BLOCKED_NETS)


def check_endpoint(url):
    """校验使用者填的接口地址，返回 (ok, 说明)。两层：字面 IP 先判，域名再解析判。"""
    u = (url or "").strip()
    if not u:
        return False, "未填写接口地址"
    try:
        parts = urllib.parse.urlsplit(u)
    except Exception as e:
        return False, "地址无法解析：%s" % e
    if parts.scheme not in ("http", "https"):
        return False, "只支持 http/https，当前是 `%s`" % (parts.scheme or "（空）")
    host = parts.hostname or ""
    if not host:
        return False, "地址里缺主机名"
    low = host.lower().rstrip(".")
    if low in _BLOCKED_HOSTS or low.endswith((".localhost", ".internal", ".local")):
        return False, "出于安全考虑，不允许访问本机/内网地址（`%s`）" % host
    if _allow_private():
        return True, "地址可用（已放行内网：LOOM_GEN_ALLOW_PRIVATE=1）"
    if _blocked_ip(low):
        return False, "出于安全考虑，不允许访问内网/环回地址（`%s`）" % host
    if _as_ip(low) is None:  # 域名 → 解析一次，防 DNS 指向内网
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
            for info in socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP):
                if _blocked_ip(info[4][0]):
                    return False, "域名 `%s` 解析到内网地址（%s），已拒绝" % (host, info[4][0])
        except Exception:
            pass  # 解析不了就交给实际请求报真实错误，别用它挡住使用者
    return True, "地址可用"


def _resolve(settings):
    """把「界面传的 dict」「GenSettings」或 None 统一成 GenSettings。"""
    if isinstance(settings, config.GenSettings):
        return settings
    return config.gen_settings(settings or {})


# ---------------------------------------------------------------- 后端接口

class GenerationBackend(object):
    """生成后端统一接口。实现下面三个方法，即可接入任意模型服务。

    settings 一律是「本次调用的配置」（界面传入的 dict 或环境变量快照）。
    后端实例**自己不持有任何配置**——同一个进程里多个使用者的 Key 不会互相串。
    """

    slug = "base"
    title = "接口基类"

    def describe(self):
        """一句话说明这个后端是什么。"""
        return ""

    def available(self, settings=None):
        """返回 (是否可用, 说明文字)。

        不可用**不等于抛错**——界面要如实显示「为什么没接上」，
        而不是安静地换素材糊弄过去。
        """
        return False, "未实现"

    def submit(self, request, settings=None):
        """提交一次生成，返回统一任务 dict（见 _normalize_task）。"""
        raise NotImplementedError

    def query(self, task_id, settings=None):
        """查一次任务状态，返回统一任务 dict。"""
        raise NotImplementedError


class HttpModelAPI(GenerationBackend):
    """通用模型 API：任何实现上面契约的生成服务都能接。"""

    slug = "http"
    title = "通用模型 API（HTTP + JSON）"

    def describe(self):
        return ("把 c04 的生成请求按契约 POST 给外部模型服务，再轮询任务状态取回成片。"
                "地址 / Key / 模型名可在界面顶部临时填，也可配环境变量。")

    def available(self, settings=None):
        s = _resolve(settings)
        if not s.configured:
            return False, "未接入：未配置生成接口地址（可在本页顶部填写）"
        ok, why = check_endpoint(s.url)
        if not ok:
            return False, "地址不可用：%s" % why
        where = "界面填写" if s.source == "ui" else "环境变量"
        return True, "已接入（%s）：%s%s" % (
            where, s.url, ("（模型 %s）" % s.model) if s.model else "")

    def _headers(self, s):
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if s.key:
            h["Authorization"] = "Bearer %s" % s.key
        return h

    def submit(self, request, settings=None):
        s = _resolve(settings)
        if not s.configured:
            raise RuntimeError("未配置生成接口地址：⑤ 站接口已就绪，但还没有接入模型")
        ok, why = check_endpoint(s.url)
        if not ok:
            raise RuntimeError(why)
        body = dict(request)
        if s.model:
            body["model"] = s.model
        data = _http_json(s.url + "/generations", headers=self._headers(s),
                          payload=body, timeout=s.timeout)
        return _normalize_task(data, fallback_id=None)

    def query(self, task_id, settings=None):
        s = _resolve(settings)
        if not s.configured:
            raise RuntimeError("未配置生成接口地址：⑤ 站接口已就绪，但还没有接入模型")
        # 与 submit 同一道校验：query 也会对外发请求，漏了它就是一个可被利用的 SSRF 通道
        # （错误信息会把内网服务的响应带回界面）。实测线上确实能打到 127.0.0.1。
        ok, why = check_endpoint(s.url)
        if not ok:
            raise RuntimeError(why)
        endpoint = "%s/generations/%s" % (s.url, urllib.parse.quote(str(task_id), safe=""))
        data = _http_json(endpoint, headers=self._headers(s), timeout=s.timeout)
        return _normalize_task(data, fallback_id=task_id)


class ReplayBackend(GenerationBackend):
    """内置参考回放：不调模型，播放 space/fallback 的往期成片。"""

    slug = "replay"
    title = "参考回放（内置示例素材，非模型生成）"

    def describe(self):
        return ("不调用任何模型，播放 space/fallback 里的往期成片，"
                "用于展示 ⑤ 站接上模型后的产物形态；界面恒标注「参考回放」。")

    def available(self, settings=None):
        n = len(clips())
        if n:
            return True, "内置示例素材 %d 段（往期成片，非本次生成）" % n
        return False, "space/fallback/ 里没有可用素材"

    def submit(self, request, settings=None):
        items = clips(limit=1)
        if not items:
            raise RuntimeError("space/fallback/ 里没有可用素材")
        # task_id 必须逐镜唯一：用秒级时间戳会在同一秒内撞车（实测 8 镜只出 2 个 ID），
        # 任务表会互相覆盖。这里用「镜头分区 + 单调序号」保证唯一且可读。
        tag = str(request.get("prefix") or "replay").replace("/", "-")
        return {"task_id": "replay-%s-%03d" % (tag, next(_REPLAY_SEQ)),
                "status": "succeeded", "video_url": "", "video_path": items[0],
                "progress": 1.0, "replay": True, "detail": "参考回放（非模型生成）"}

    def query(self, task_id, settings=None):
        return {"task_id": task_id, "status": "succeeded", "progress": 1.0,
                "detail": "参考回放（非模型生成）", "video_url": ""}


_BACKENDS = {"http": HttpModelAPI(), "replay": ReplayBackend()}

# 参考回放的 task_id 序号（保证逐镜唯一，见 ReplayBackend.submit）
_REPLAY_SEQ = itertools.count(1)


def backends():
    return dict(_BACKENDS)


def active(settings=None):
    """当前后端。未识别的取值回退到 http（宁可不接，也不悄悄回放）。"""
    return _BACKENDS.get(_resolve(settings).backend) or _BACKENDS["http"]


def available(settings=None):
    """返回 (是否可用, 说明)。探的是「接口有没有接上模型」，不发真实生成请求。"""
    return active(settings).available(settings)


def status_lines(settings=None):
    """自检/状态区用的一行文字。"""
    b = active(settings)
    ok, detail = b.available(settings)
    label = {True: "已接入", False: "未接入"}[bool(ok)]
    extra = "" if b.slug == "http" else "（后端：%s）" % b.title
    return "⑤ 生成接口 · %s —— %s%s" % (label, detail, extra)


def _unavailable_note(b, s, detail):
    """接口不可用时该说什么 —— **填错了**和**没填**必须分开说。

    否则使用者填了个内网地址，界面却回他「等待接入模型」，
    把「你的地址有问题」误报成「还没接模型」，等于在骗人（实测踩过）。
    """
    if b.slug == "http" and s.configured:
        return ("**⑤ 生成站无法下发：你把生成接口地址填上了，但它不可用。**\n\n"
                "%s\n\n改掉「⑤ 生成接口」页签顶部面板里的地址后重跑；"
                "把那栏清空则会回到「等待接入模型」。" % detail)
    return NOT_CONNECTED_NOTE


def probe(settings=None):
    """「测试连通性」按钮：只探端点可达性，**不发真实生成请求**。

    分三态如实回报：地址不合法 / 连不上 / 连上了（HTTP 码一并给出——
    401、404、405 都说明网络是通的，只是鉴权或路径不对）。
    """
    s = _resolve(settings)
    if not s.configured:
        return False, "**没填地址**。在上面填一个形如 `https://<host>/v1` 的模型接口地址再测。"
    ok, why = check_endpoint(s.url)
    if not ok:
        return False, "**地址不可用**：%s" % why
    req = urllib.request.Request(s.url, method="GET", headers={
        "User-Agent": "LOOM/1.0", "Accept": "application/json"})
    if s.key:
        req.add_header("Authorization", "Bearer %s" % s.key)
    try:
        with urllib.request.urlopen(req, timeout=min(s.timeout, 15)) as r:
            return True, ("**连上了**：`%s` 返回 HTTP %s。地址可达，可以点「开始生成」跑全链。"
                          % (s.label(), r.status))
    except urllib.error.HTTPError as e:
        # 4xx/5xx 都说明 TCP 与 HTTP 层是通的，只是这个根路径不对——这不算失败
        return True, ("**端点可达**：`%s` 返回 HTTP %s（根路径没有内容很正常，"
                      "只要不是连不上就行）。%s"
                      % (s.label(), e.code,
                         "注意 HTTP 401/403 说明鉴权没过，检查 Key。" if e.code in (401, 403) else ""))
    except Exception as e:
        return False, "**连不上**：`%s` —— %s" % (s.label(), e)


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


def submit(prompt, seconds=5.0, seed=None, prefix="loom/S001", aspect_ratio="", settings=None):
    """提交一次生成，记进本地任务表并返回统一任务 dict。"""
    s = _resolve(settings)
    b = active(s)
    ok, detail = b.available(s)
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

    task = b.submit(request, s)
    if not task.get("task_id"):
        raise RuntimeError("模型接口没有返回 task_id：%s" % json.dumps(
            task.get("raw") or {}, ensure_ascii=False)[:200])
    task = dict(task)
    task.update({
        "backend": b.slug,
        # 只留主机名，**绝不落盘地址里的凭据或 Key**（GenSettings.label 已剥掉 path/query）
        "endpoint": s.label(),
        "submitted_at": time.time(),
        "prompt_text": (prompt or "")[:200],
        "seconds": float(seconds),
    })
    tasks = _load_tasks()
    tasks[task["task_id"]] = task
    _save_tasks(tasks)
    return task


def query(task_id, settings=None):
    """查一次任务状态；拿到成片就下载到本地并返回路径。"""
    s = _resolve(settings)
    tasks = _load_tasks()
    t = tasks.get(task_id)
    b = active(s)
    if t and t.get("video_path") and os.path.exists(t["video_path"]):
        return {"status": "succeeded", "detail": "生成完成（本地已归档）",
                "path": t["video_path"], "elapsed": _elapsed(t)}

    try:
        fresh = b.query(task_id, s)
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

def run_c05(gen_request, offline=False, seed=None, aspect_ratio="", prefix="loom/S001",
            settings=None):
    """⑤ 的**单镜**入口（留给「只下发一个镜头」的调用方）。

    整片的多镜链路见 run_all_iter()——界面走的是后者。
    无论走哪条路都**如实**说明发生了什么：
      mode=api            提交成功 → 带任务 ID
      mode=not_connected  接口就绪但没接模型 → 明说，不冒充
      mode=replay         参考回放模式
      mode=offline        演示/离线模式，不发起任何外部调用
    """
    s = _resolve(settings)
    b = active(s)
    ok, detail = b.available(s)
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
                          aspect_ratio=aspect_ratio, settings=s)
            base.update({"mode": "replay", "task": task, "note": REPLAY_NOTE})
        except Exception as e:
            base.update({"mode": "not_connected",
                         "note": "参考回放不可用：%s\n\n%s" % (e, NOT_CONNECTED_NOTE)})
        return base

    if not ok:
        base.update({"mode": "not_connected", "note": _unavailable_note(b, s, detail)})
        return base

    prompt, seconds = prompt_from_c04(gen_request)
    if not prompt:
        base.update({"mode": "not_connected",
                     "note": "④ 的 c04 产物里没取到 `payload.generation.prompt`，"
                             "无法组装生成请求。请先重跑 ④ 提示词站。"})
        return base

    base.update({"prompt": prompt, "seconds": seconds})
    try:
        task = submit(prompt, seconds, seed=seed, prefix=prefix,
                      aspect_ratio=aspect_ratio, settings=s)
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


# ---------------------------------------------------------------- 整片链路

_TERMINAL = ("succeeded", "failed", "skipped")


def _shot_seed(seed, idx):
    """每个镜头给一个相邻但不相同的 seed，保证同一次运行里各镜不撞。"""
    if seed is None:
        return None
    return int(seed) + int(idx)


def _tally(shots):
    return {
        "n": len(shots),
        "submitted": sum(1 for x in shots if x.get("task_id")),
        "succeeded": sum(1 for x in shots if x.get("status") == "succeeded"),
        "failed": sum(1 for x in shots if x.get("status") in ("failed", "skipped")),
        "pending": sum(1 for x in shots if x.get("status") not in _TERMINAL),
    }


def _snapshot(state):
    """yield 出去的必须是**副本**。

    生成器里反复 update 同一个 dict，直接 yield 引用的话，
    调用方 list(...) 收下来的 N 个快照会全部指向最终态（实测踩过）。
    """
    snap = dict(state)
    snap["shots"] = [dict(x) for x in state.get("shots") or []]
    snap["videos"] = list(state.get("videos") or [])
    return snap


def run_all_iter(gen_items, settings=None, aspect_ratio="", prefix_base="loom",
                 seed=None, wait_seconds=0, offline=False):
    """⑤ 的**整片**入口：逐镜提交 + 有界轮询，用生成器把进度 yield 给界面。

    每次 yield 一个状态快照：
      {"phase": preparing|submitting|waiting|done, "i", "n", "shots": [...],
       "submitted", "succeeded", "failed", "pending",
       "backend", "endpoint", "available", "status_detail", "note", "videos"}

    shots[] 每项：
      {"shot_id", "prompt", "seconds", "status", "task_id",
       "video_path", "detail", "error"}
      status ∈ pending|queued|running|succeeded|failed|skipped

    wait_seconds=0 → 只提交不等待（长任务场景：先把任务全下发，之后再按任务 ID 取回）。
    """
    s = _resolve(settings)
    b = active(s)
    ok, detail = b.available(s)
    items = list(gen_items or [])

    shots = []
    for it in items:
        p, secs = prompt_from_c04(it.get("c04"))
        if not p:  # ④ 没给整份 c04 时退回它算好的 gen 字段
            gen = it.get("gen") or {}
            p = gen.get("prompt") or ""
            try:
                secs = float(gen.get("duration_seconds") or 5)
            except Exception:
                secs = 5.0
        shots.append({"shot_id": it.get("shot_id") or "?", "prompt": p,
                      "seconds": secs, "status": "pending", "task_id": "",
                      "video_path": "", "detail": "", "error": ""})

    state = {"phase": "preparing", "i": 0, "shots": shots,
             "backend": b.slug, "backend_title": b.title,
             "endpoint": s.label(), "available": bool(ok),
             # replay 后端出的不是模型产物，界面据此换一套标注措辞（绝不能写「本次生成」）
             "replay": b.slug == "replay",
             "status_detail": detail, "note": "", "videos": [],
             "wait_seconds": int(wait_seconds or 0)}
    state.update(_tally(shots))

    if offline:
        state.update({"phase": "done", "note": NOT_CONNECTED_NOTE
                      + "\n\n（离线模式：本次未发起任何外部调用）"})
        yield _snapshot(state)
        return

    if not ok:
        state.update({"phase": "done",
                      "note": _unavailable_note(b, s, detail)})
        yield _snapshot(state)
        return

    if not shots:
        state.update({"phase": "done", "note": "④ 没有产出任何生成请求，⑤ 站无可下发。"})
        yield _snapshot(state)
        return

    # ---- 1) 逐镜提交 ----
    for idx, sh in enumerate(shots):
        state["i"] = idx + 1
        state["phase"] = "submitting"
        if not sh["prompt"]:
            sh.update({"status": "skipped",
                       "error": "④ 的 c04 里没取到 payload.generation.prompt"})
            state.update(_tally(shots))
            yield _snapshot(state)
            continue
        try:
            task = submit(sh["prompt"], sh["seconds"], seed=_shot_seed(seed, idx),
                          prefix="%s/%s" % (prefix_base, sh["shot_id"]),
                          aspect_ratio=aspect_ratio, settings=s)
            sh.update({"task_id": task.get("task_id") or "",
                       "status": task.get("status") or "queued",
                       "video_path": task.get("video_path") or "",
                       "detail": task.get("detail") or "",
                       "replay": bool(task.get("replay"))})
        except Exception as e:
            sh.update({"status": "failed", "error": str(e)})
        state.update(_tally(shots))
        yield _snapshot(state)

    # ---- 2) 有界轮询（只对还没出结果的镜头）----
    if state["pending"] and state["wait_seconds"] > 0:
        state["phase"] = "waiting"
        deadline = time.time() + float(state["wait_seconds"])
        while True:
            for sh in shots:
                if sh["status"] in _TERMINAL:
                    continue
                r = query(sh["task_id"], settings=s)
                st = r.get("status") or "queued"
                if st == "succeeded":
                    sh.update({"status": "succeeded", "video_path": r.get("path") or "",
                               "detail": r.get("detail") or "", "error": ""})
                elif st in ("failed", "unknown"):
                    sh.update({"status": "failed",
                               "error": r.get("detail") or "服务端查询失败"})
                else:  # queued / running
                    sh.update({"status": st, "detail": r.get("detail") or ""})
            state.update(_tally(shots))
            yield _snapshot(state)
            if state["pending"] == 0 or time.time() >= deadline:
                break
            time.sleep(3.0)

    # ---- 3) 收尾：如实说明哪些没等到 ----
    for sh in shots:
        if sh["status"] not in _TERMINAL:
            sh["detail"] = (sh["detail"] + "；本次等待已超时，任务仍在服务端跑，"
                            "可用任务 ID 稍后在下方查询").strip("；")

    state["videos"] = [sh["video_path"] for sh in shots
                       if sh["status"] == "succeeded" and sh["video_path"]]
    state["phase"] = "done"
    state.update(_tally(shots))
    yield _snapshot(state)


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
