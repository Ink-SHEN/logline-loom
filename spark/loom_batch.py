#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LOOM · Spark 侧「整片调度器」：接收创空间下发的镜头清单，逐镜真生成、落盘、报告进度。

为什么有这个服务
----------------
创空间是「云端无状态 Web」容器，会休眠、重启会丢本地状态——它不适合当一个要
连续跑 20–35 分钟的后台调度器。而 DGX Spark 常驻、有 loom_watch/cron 守护。
所以让「创空间只管编排+下发」，由本服务在 Spark 上把整片所有镜头逐镜真生成。

本服务不造镜头、不写提示词（那是创空间 Agent 的活）。它只做四件事：
  1. 接收一份「已填好提示词/种子/前缀的 ComfyUI 工作流清单」
  2. 按 FIFO 顺序逐镜提交给 ComfyUI，等前一个完成再交下一个
  3. 每镜完成后把成片从 ComfyUI /view 下载到本机落盘
  4. 进度落盘到 ~/loom/batches/<film_id>.json（Spark 本地盘，崩了可断点续跑）

鉴权：复用 LOOM_PROXY_TOKEN。只监听 127.0.0.1，由 loom_proxy 鉴权后把 /batch/* 转发进来。
只用标准库。
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# 质检模块（同目录）：⑥ 客观项 ffprobe 硬判
sys.path.insert(0, HERE)
try:
    from loom_qc import qc_mp4
except Exception as e:
    qc_mp4 = None
    print("warn: loom_qc 导入失败（%s），⑥质检将跳过" % e)
ENV_FILE = os.path.join(HERE, "loom.env")
LOG_FILE = os.path.join(HERE, "batch.log")
BATCH_DIR = os.path.join(HERE, "batches")
QC_DIR = os.path.join(HERE, "qc")              # ⑥质检 c06 报告落盘 ~/loom/qc/<film>/<shot>.c06.json
OUT_ROOT = os.path.join(HERE, "out")           # 成片落盘根 ~/loom/out/<film_id>/<shot_id>.mp4
COMFY = "http://127.0.0.1:8288"                # 上游 ComfyUI（回环）

LISTEN_HOST = "127.0.0.1"                       # 只回环，公网经 loom_proxy 转发进来
LISTEN_PORT = 8388

POLL_INTERVAL = 5                               # 每镜轮询出片间隔秒
STATUS_BUDGET = 20 * 60                         # 单镜最长等待(秒)，超时标 error 跳过
_resume_lock = threading.Lock()
TOKEN = ""


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def load_env(path=ENV_FILE):
    d = {}
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return d


def _ensure():
    os.makedirs(BATCH_DIR, exist_ok=True)
    os.makedirs(OUT_ROOT, exist_ok=True)
    os.makedirs(QC_DIR, exist_ok=True)


def _cmp(a, b):
    if not a or not b or len(a) != len(b):
        return False
    r = 0
    for x, y in zip(a, b):
        r |= ord(x) ^ ord(y)
    return r == 0


def _auth():
    h = {"Content-Type": "application/json"}
    if TOKEN:
        h["Authorization"] = "Bearer %s" % TOKEN
    return h


def _comfy_post(path, payload, timeout=60):
    req = urllib.request.Request(COMFY + path, data=json.dumps(payload).encode("utf-8"),
                                 headers=_auth(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _comfy_get(path, timeout=30):
    req = urllib.request.Request(COMFY + path, headers=_auth())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _download(item, dest_path):
    """从 ComfyUI /view 下载单个产物到 dest_path。"""
    from urllib.parse import urlencode
    q = urlencode({
        "filename": item.get("filename"),
        "subfolder": item.get("subfolder", ""),
        "type": item.get("type", "output"),
    })
    req = urllib.request.Request(COMFY + "/view?" + q, headers=_auth())
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    with open(dest_path, "wb") as f:
        f.write(raw)
    return dest_path


# ---------- 批次状态 读写 ----------

def _bpath(film_id):
    return os.path.join(BATCH_DIR, "%s.json" % re.sub(r"[^A-Za-z0-9._-]", "_", str(film_id)))


def load_batch(film_id):
    p = _bpath(film_id)
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_batch(b):
    p = _bpath(b["film_id"])
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(b, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def _pick_next_pending(batch):
    """按批次内顺序取下一个待生成镜头（含断点续跑：已完成/进行中跳过）。"""
    for s in batch["shots"]:
        if s.get("status") in ("pending", "queued"):
            return s
        if s.get("status") == "running" and not s.get("result"):
            return s  # 上次进程崩在 running，续跑它
    return None


def _run_batch(film_id):
    """后台执行线程：逐镜生成。异常时整个线程退出（下次由 API/守护续跑）。"""
    b = load_batch(film_id)
    if not b:
        return
    while True:
        with _resume_lock:
            cur = _pick_next_pending(b)
            if cur is None:
                break
            cur["status"] = "running"
            cur["started_at"] = int(time.time())
            save_batch(b)

        shot_id = cur["shot_id"]
        log("[%s] 生成 %s ..." % (film_id, shot_id))
        try:
            _gen_one(b, cur)
        except Exception as e:
            log("[%s] %s 失败：%s" % (film_id, shot_id, e))
            cur["status"] = "error"
            cur["error"] = str(e)[:400]
            cur["finished_at"] = int(time.time())
            save_batch(b)
            # 失败也继续下一个镜头
    # 全部走完
    done = [s for s in b["shots"] if s.get("status") in ("done", "error")]
    b["status"] = "finished" if done else "running"
    b["updated_at"] = int(time.time())
    save_batch(b)
    log("[%s] 批次结束，finished=%d/%d" % (film_id, len([s for s in b["shots"] if s.get("status") == "done"]), len(b["shots"])))


def _gen_one(batch, shot):
    """提交一个镜头 → 轮询 → 下载。会写回 shot 状态。"""
    wf = shot.get("workflow")
    if not isinstance(wf, dict):
        raise ValueError("该镜头缺 workflow 字段")
    res = _comfy_post("/prompt", {"prompt": wf})
    pid = res.get("prompt_id")
    if not pid:
        raise ValueError("ComfyUI 未返回 prompt_id: %s" % res)
    shot["prompt_id"] = pid
    save_batch(batch)

    deadline = time.time() + STATUS_BUDGET
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL)
        hist = _comfy_get("/history/%s" % pid)
        entry = (hist or {}).get(pid)
        if not entry:
            continue
        # 成功：找 mp4
        got = None
        for node_out in (entry.get("outputs") or {}).values():
            for key in ("images", "gifs", "videos"):
                for item in (node_out.get(key) or []):
                    if str(item.get("filename", "")).lower().endswith((".mp4", ".webm")):
                        got = item
                        break
                if got:
                    break
            if got:
                break
        if got:
            safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", shot.get("shot_id") or "shot")
            dest = os.path.join(OUT_ROOT, batch["film_id"], safe_id + ".mp4")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            _download(got, dest)
            shot["result"] = dest
            shot["status"] = "done"
            shot["finished_at"] = int(time.time())
            # ⑥ 客观质检：对成片跑 ffprobe
            if qc_mp4 is not None:
                targets = shot.get("qc_targets") or {}
                qc = qc_mp4(dest, {
                    "duration_seconds": targets.get("duration_seconds"),
                    "aspect_ratio_text": targets.get("aspect_ratio_text"),
                    "megapixels": targets.get("megapixels"),
                })
                if qc.get("ok"):
                    shot["qc"] = {
                        "verdict": qc["c06"]["verdict"],
                        "score": qc["c06"]["score"],
                        "failed_items": qc["c06"]["failed_items"],
                        "route_to": qc["c06"]["route_to"],
                        "report": os.path.join(QC_DIR, batch["film_id"], safe_id + ".c06.json"),
                    }
                    os.makedirs(os.path.join(QC_DIR, batch["film_id"]), exist_ok=True)
                    with open(shot["qc"]["report"], "w", encoding="utf-8") as _f:
                        json.dump(qc["c06"], _f, ensure_ascii=False, indent=1)
                else:
                    shot["qc"] = {"verdict": "error", "error": qc.get("error"), "score": None,
                                  "failed_items": [], "route_to": "human"}
            log("[%s] %s 完成 -> %s" % (batch["film_id"], shot["shot_id"], dest))
            save_batch(batch)
            return
        # 失败态
        st = (entry.get("status") or {}).get("status_str")
        if st in ("error", "cancelled"):
            msgs = entry.get("status", {}).get("messages", [])
            raise RuntimeError("ComfyUI %s: %s" % (st, json.dumps(msgs)[:300]))
        # 否则继续等
    raise TimeoutError("单镜 %s 超时 %ss" % (shot.get("shot_id"), STATUS_BUDGET))


# ---------- HTTP ----------

def _token_of(handler):
    auth = handler.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return handler.headers.get("X-LOOM-Token", "").strip()


class BatchHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LOOM-Batch/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return _cmp(_token_of(self), TOKEN)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _handle(self, method):
        if not self._auth_ok():
            return self._json(401, {"error": "token 无效"})
        parts = self.path.strip("/").split("/")  # batch / <film_id>
        if parts and parts[0] == "batch":
            film_id = parts[1] if len(parts) > 1 else None
            if method == "POST" and film_id:
                return self._create_batch(film_id)
            if method == "GET" and film_id:
                b = load_batch(film_id)
                if not b:
                    return self._json(404, {"error": "没有该批次"})
                return self._json(200, _public(b))
            if method == "DELETE" and film_id:
                p = _bpath(film_id)
                try:
                    os.remove(p)
                except Exception:
                    pass
                return self._json(200, {"ok": True, "deleted": film_id})
        return self._json(404, {"error": "未知路径"})

    def _create_batch(self, film_id):
        body = self._read_body()
        if not body or "shots" not in body:
            return self._json(400, {"error": "body 需含 shots 数组"})
        shots = body["shots"]
        if not isinstance(shots, list) or not shots:
            return self._json(400, {"error": "shots 不能为空"})

        with _resume_lock:
            # 重名批次：已存在则拒绝覆盖（避免评审误操作冲掉进行中任务）
            if load_batch(film_id) is not None:
                return self._json(409, {"error": "批次 %s 已存在" % film_id})

            # 分批顺序：T2V/I2V(FL2VA) 在前连续跑，R2V(Ref2VA) 单独后跑，避免反复重载权重
            ordered = []
            for grp in (("T2V", "I2V"), ("R2V",)):
                for s in shots:
                    wt = str(s.get("workflow_type") or "T2V").upper()
                    if wt in grp:
                        ordered.append(s)
            # 防重复（保底按原序补漏）
            seen = set()
            clean = []
            for s in ordered:
                sid = str(s.get("shot_id") or "?")
                if sid in seen:
                    continue
                seen.add(sid)
                clean.append({
                    "shot_id": sid,
                    "status": "pending",
                    "workflow": s.get("workflow"),
                    "qc_targets": s.get("qc_targets") or {},
                })
            if not clean:
                return self._json(400, {"error": "shots 无效"})

            b = {
                "film_id": film_id,
                "created_at": int(time.time()),
                "status": "running",
                "shots": clean,
                "updated_at": int(time.time()),
            }
            save_batch(b)

        threading.Thread(target=_run_batch, args=(film_id,), daemon=True).start()
        log("批次创建 %s：%d 镜，后台调度启动" % (film_id, len(clean)))
        return self._json(202, {"ok": True, "film_id": film_id, "accepted_shots": len(clean)})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")


def _public(b):
    """返回给创空间的只读视图（去掉内部 workflow，避免大payload）。"""
    return {
        "film_id": b["film_id"],
        "status": b["status"],
        "updated_at": b.get("updated_at"),
        "shots": [{
            "shot_id": s["shot_id"],
            "status": s.get("status"),
            "result": s.get("result"),
            "error": s.get("error"),
            "prompt_id": s.get("prompt_id"),
            "qc": s.get("qc"),
        } for s in b["shots"]],
    }


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    global TOKEN
    env = load_env()
    TOKEN = env.get("LOOM_PROXY_TOKEN") or os.environ.get("LOOM_PROXY_TOKEN") or ""
    if not TOKEN:
        print("LOOM_PROXY_TOKEN 未配置 —— 拒绝启动", file=sys.stderr)
        sys.exit(2)
    _ensure()
    port = int(env.get("LOOM_BATCH_PORT") or LISTEN_PORT)
    log("整片调度器启动：监听 %s:%s → %s" % (LISTEN_HOST, port, COMFY))
    Server((LISTEN_HOST, port), BatchHandler).serve_forever()


if __name__ == "__main__":
    main()
