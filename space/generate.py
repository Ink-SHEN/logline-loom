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

from . import config

T2V_PROMPT_NODE = "140:131"
T2V_DURATION_NODE = "140:133"
T2V_SEED_NODE = "140:129"
T2V_PREFIX_NODE = "92"


def _auth_headers():
    h = {"Content-Type": "application/json"}
    token = config.proxy_token()
    if token:
        h["Authorization"] = "Bearer %s" % token
    return h


def _get(url, timeout=10):
    req = urllib.request.Request(url, headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post(url, payload, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=_auth_headers(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def probe_live():
    """探测反向代理是否可达。返回 (是否可达, 说明文字)。"""
    url = config.comfy_url()
    if not url:
        return False, "未配置 LOOM_COMFY_URL（真生成后端地址）"
    if config.generation_mode() == "replay":
        return False, "运行模式被设为 replay，跳过探测"
    try:
        data = _get(url + "/system_stats", timeout=config.probe_timeout())
        dev = (data.get("devices") or [{}])[0]
        return True, "已连通：%s" % (dev.get("name", "ComfyUI 节点"))
    except urllib.error.HTTPError as e:
        return False, "代理返回 HTTP %s（token 可能不对，或节点未开）" % e.code
    except Exception as e:
        return False, "探测失败：%s" % e


def submit_live(prompt_text, seconds=5.0, seed=None, prefix="loom/space"):
    """POST 一次 T2V 生成。返回 prompt_id。"""
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
    res = _post(config.comfy_url() + "/prompt", {"prompt": wf})
    return res.get("prompt_id")


def poll_live(prompt_id, budget=None):
    """轮询直到出片或超过预算。返回 (本地视频路径 or None, 状态说明)。"""
    budget = budget or config.generate_budget()
    deadline = time.time() + budget
    while time.time() < deadline:
        try:
            hist = _get("%s/history/%s" % (config.comfy_url(), prompt_id), timeout=10)
        except Exception as e:
            return None, "轮询失败：%s" % e
        entry = (hist or {}).get(prompt_id)
        if entry:
            for node_out in (entry.get("outputs") or {}).values():
                for key in ("images", "gifs", "videos"):
                    for item in (node_out.get(key) or []):
                        if str(item.get("filename", "")).lower().endswith((".mp4", ".webm")):
                            return _download(item), "真生成完成"
        time.sleep(5)
    return None, "真生成在 %s 秒内未完成（prompt_id=%s），改用回放" % (budget, prompt_id)


def _download(item):
    import urllib.parse
    q = urllib.parse.urlencode({
        "filename": item.get("filename"),
        "subfolder": item.get("subfolder", ""),
        "type": item.get("type", "output"),
    })
    url = "%s/view?%s" % (config.comfy_url(), q)
    req = urllib.request.Request(url, headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    name = "live_%s_%s" % (int(time.time()), os.path.basename(item.get("filename", "out.mp4")))
    path = os.path.join(config.OUT_DIR, name)
    open(path, "wb").write(raw)
    return path


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
