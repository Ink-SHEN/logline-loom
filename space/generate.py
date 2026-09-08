# -*- coding: utf-8 -*-
"""④生成：真生成（方案 A）与预生成回放（方案 B）的同一个入口。

方案 A：创空间经【带 token 的反向代理】回源 Spark 上的 ComfyUI。
        ComfyUI 本身没有任何鉴权，绝不能直接暴露公网——所以代理层必须校验 token，
        且只在评审期开放。地址与 token 都从环境变量读，不进仓库。
方案 B：隧道不可达（或超时）时播放预生成结果，并且【必须在界面上标清楚是回放】。
        悄悄放旧视频冒充实时生成，一旦被看出来丢的不只是那几分。
"""
import json
import os
import time
import urllib.error
import urllib.request

from . import config, tunnel

T2V_PROMPT_NODE = "140:131"
T2V_DURATION_NODE = "140:133"
T2V_SEED_NODE = "140:129"
T2V_PREFIX_NODE = "92"


def _auth_headers():
    return config.auth_headers()


def _base():
    """取当前可用的后端地址。

    natapp 域名会变，所以不能把地址写死在配置里用完就算——每次调用前都要
    重新探一次，探不到就抛错，由上层决定走回放还是报错。
    """
    url, detail = tunnel.current()
    if not url:
        raise RuntimeError(detail or "后端地址不可用")
    return url


def _get(url, timeout=10):
    req = urllib.request.Request(url, headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post(url, payload, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=_auth_headers(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def probe_live(force=True):
    """探测 Spark 是否可达。返回 (是否可达, 说明文字)。

    会逐个试候选地址（secrets 硬地址 → Spark 上报 → 上次可用），
    所以 natapp 换了域名也能自己找到新地址。
    """
    if config.generation_mode() == "replay":
        return False, "运行模式被设为 replay，跳过探测"
    url, detail = tunnel.current(force=force)
    return bool(url), detail


def submit_live(prompt_text, seconds=5.0, seed=None, prefix="loom/space"):
    """POST 一次 T2V 生成。返回 prompt_id。"""
    base = _base()
    wf_path = os.path.join(config.WORKFLOWS_DIR, "workflow_api_t2v.json")
    wf = json.load(open(wf_path, encoding="utf-8"))
    if T2V_PROMPT_NODE in wf:
        wf[T2V_PROMPT_NODE]["inputs"]["prompt"] = prompt_text
    if T2V_DURATION_NODE in wf:
        wf[T2V_DURATION_NODE]["inputs"]["value"] = float(seconds)
    if T2V_SEED_NODE in wf and seed is not None:
        wf[T2V_SEED_NODE]["inputs"]["noise_seed"] = int(seed)
    if T2V_PREFIX_NODE in wf:
        wf[T2V_PREFIX_NODE]["inputs"]["filename_prefix"] = prefix
    res = _post(base + "/prompt", {"prompt": wf})
    return res.get("prompt_id")


def poll_live(prompt_id, budget=None):
    """轮询直到出片或超过预算。返回 (本地视频路径 or None, 状态说明)。"""
    base = _base()
    budget = budget or config.generate_budget()
    deadline = time.time() + budget
    while time.time() < deadline:
        try:
            hist = _get("%s/history/%s" % (base, prompt_id), timeout=10)
        except Exception as e:
            return None, "轮询失败：%s" % e
        entry = (hist or {}).get(prompt_id)
        if entry:
            for node_out in (entry.get("outputs") or {}).values():
                for key in ("images", "gifs", "videos"):
                    for item in (node_out.get(key) or []):
                        if str(item.get("filename", "")).lower().endswith((".mp4", ".webm")):
                            return _download(base, item), "真生成完成"
        time.sleep(5)
    return None, "真生成在 %s 秒内未完成（prompt_id=%s），改用回放" % (budget, prompt_id)


def _download(base, item):
    import urllib.parse
    q = urllib.parse.urlencode({
        "filename": item.get("filename"),
        "subfolder": item.get("subfolder", ""),
        "type": item.get("type", "output"),
    })
    url = "%s/view?%s" % (base, q)
    req = urllib.request.Request(url, headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    name = "live_%s_%s" % (int(time.time()), os.path.basename(item.get("filename", "out.mp4")))
    path = os.path.join(config.OUT_DIR, name)
    open(path, "wb").write(raw)
    return path


TASKS_FILE = os.path.join(config.OUT_DIR, "tasks.json")

# MiniMax-H3 在 DGX Spark 上的实测吞吐：15 秒片 ≈ 731 秒 → 约 48 秒出 1 秒片。
# 用来给评委一个诚实的等待预期，而不是让他干等一个没有反馈的界面。
SECONDS_PER_VIDEO_SECOND = float(os.environ.get("LOOM_SEC_PER_VID_SEC") or 48)


def _load_tasks():
    if os.path.exists(TASKS_FILE):
        try:
            return json.load(open(TASKS_FILE, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_tasks(tasks):
    try:
        json.dump(tasks, open(TASKS_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception:
        pass


def submit_async(prompt_text, seconds=5.0, seed=None, prefix="loom/space"):
    """提交一次真生成，立刻返回（不等待出片）。

    H3 在 Spark 上一个 5 秒镜头要 6 分钟左右，一句 logline 五六个镜头就是半小时以上。
    同步等出片在评审场景里不成立——评委不会等，HTTP 请求也会先超时。
    所以改成：提交 → 拿 prompt_id → 界面先给参考预览 → 评委回头再查结果。
    """
    pid = submit_live(prompt_text, seconds, seed, prefix)
    tasks = _load_tasks()
    tasks[pid] = {
        "prompt_id": pid,
        "submitted_at": time.time(),
        "status": "queued",
        "prompt_text": prompt_text[:200],
        "seconds": seconds,
        "eta_seconds": int(seconds * SECONDS_PER_VIDEO_SECOND),
        "result": None,
    }
    _save_tasks(tasks)
    return tasks[pid]


def query_task(prompt_id):
    """查一次任务状态；若已出片就下载到本地并返回路径。"""
    tasks = _load_tasks()
    t = tasks.get(prompt_id)
    if not t:
        return {"status": "unknown",
                "detail": "没有这个任务 ID。容器重启会清空任务记录，请重新提交。"}
    elapsed = int(time.time() - t.get("submitted_at", time.time()))

    if t.get("result") and os.path.exists(t["result"]):
        return {"status": "done", "detail": "真生成完成", "path": t["result"], "elapsed": elapsed}

    try:
        hist = _get("%s/history/%s" % (_base(), prompt_id), timeout=10)
    except Exception as e:
        return {"status": t.get("status", "queued"),
                "detail": "查询后端失败：%s（隧道可能已断开）" % e, "elapsed": elapsed}

    entry = (hist or {}).get(prompt_id)
    if entry:
        for node_out in (entry.get("outputs") or {}).values():
            for key in ("images", "gifs", "videos"):
                    for item in (node_out.get(key) or []):
                        if str(item.get("filename", "")).lower().endswith((".mp4", ".webm")):
                            path = _download(_base(), item)
                        t.update({"status": "done", "result": path})
                        _save_tasks(tasks)
                        return {"status": "done", "detail": "真生成完成",
                                "path": path, "elapsed": elapsed}
        t["status"] = "running"
        _save_tasks(tasks)
        return {"status": "running",
                "detail": "正在 Spark 上生成，已用时 %d 秒（预计共 %d 秒）" % (elapsed, t.get("eta_seconds", 0)),
                "elapsed": elapsed}

    _save_tasks(tasks)
    return {"status": "queued",
            "detail": "已排队，已用时 %d 秒（预计共 %d 秒）" % (elapsed, t.get("eta_seconds", 0)),
            "elapsed": elapsed}


def list_tasks(limit=8):
    tasks = _load_tasks()
    rows = sorted(tasks.values(), key=lambda x: x.get("submitted_at", 0), reverse=True)
    return rows[:limit]


def replay_shots(limit=6):
    """回放素材列表。顺序按 index.json，没有 index 就按文件名。"""
    idx_path = os.path.join(config.FALLBACK_DIR, "index.json")
    if os.path.exists(idx_path):
        try:
            idx = json.load(open(idx_path, encoding="utf-8"))
            names = [s["file"] for s in idx.get("shots", [])]
        except Exception:
            names = []
    else:
        names = []
    if not names:
        names = sorted(f for f in os.listdir(config.FALLBACK_DIR) if f.lower().endswith(".mp4"))
    paths = [os.path.join(config.FALLBACK_DIR, n) for n in names]
    paths = [p for p in paths if os.path.exists(p)]
    return paths[:limit] or []


def replay_note():
    idx_path = os.path.join(config.FALLBACK_DIR, "index.json")
    if os.path.exists(idx_path):
        try:
            return json.load(open(idx_path, encoding="utf-8")).get("note", "")
        except Exception:
            return ""
    return ""
