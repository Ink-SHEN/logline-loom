#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LOOM · Spark 侧鉴权反向代理：natapp 隧道 → 本代理 → ComfyUI。

为什么必须有这一层
------------------
ComfyUI 自己**没有任何鉴权**：谁拿到地址谁就能 POST /prompt 提交生成任务。
natapp 的免费域名是公开的（且会被扫描），直连等于把 DGX Spark 的 GPU 开放给公网。
所以：ComfyUI 只监听 127.0.0.1:8288，本代理监听 8188（natapp 的转发目标不变），
请求进来先验 token，再决定要不要放行。

为什么只放行这几个路径
----------------------
创空间只需要提交任务、查进度、下载成片。
/queue 的 DELETE（清空队列）、/history 的 DELETE（删记录）这类破坏性接口一律不放行。

只用标准库：不往用户的 h3-comfy 环境里装东西。
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(HERE, "loom.env")
LOG_FILE = os.path.join(HERE, "proxy.log")

# 上游 ComfyUI（只监听回环，公网碰不到）
UPSTREAM = "http://127.0.0.1:8288"
LISTEN_PORT = 8188

# 放行前缀。创空间用到的就这些，其余一律 403。
ALLOW_PREFIXES = (
    "/system_stats",   # 探针：确认节点活着
    "/prompt",         # 提交生成任务
    "/history",        # 查任务结果
    "/view",           # 下载成片
    "/object_info",    # 查可用节点（排障用）
    "/queue",          # 只看队列长度（DELETE 已在下面拦掉）
    "/upload/",        # 首帧图（I2V/R2V 用）
)

# 单 IP 限流：创空间的并发很低，这里只是防扫描/防刷
RATE_WINDOW = 60.0
RATE_MAX = 240
MAX_CONCURRENCY = 8

_log_lock = threading.Lock()
_rate = {}
_rate_lock = threading.Lock()
_sem = threading.Semaphore(MAX_CONCURRENCY)
TOKEN = ""


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    with _log_lock:
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


def _slow_down(ip):
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate.get(ip, []) if now - t < RATE_WINDOW]
        if len(hits) >= RATE_MAX:
            _rate[ip] = hits
            return True
        hits.append(now)
        _rate[ip] = hits
        if len(_rate) > 512:  # 防止字典无限涨
            _rate.clear()
    return False


def _token_of(handler):
    """token 可以有三种带法，方便不同客户端。"""
    auth = handler.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    v = handler.headers.get("X-LOOM-Token", "")
    if v:
        return v.strip()
    qs = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
    return (qs.get("token") or [""])[0].strip()


def _cmp(a, b):
    if not a or not b:
        return False
    if len(a) != len(b):
        return False
    r = 0
    for x, y in zip(a, b):
        r |= ord(x) ^ ord(y)
    return r == 0


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LOOM-Proxy/1.0"

    def log_message(self, fmt, *args):  # 走自己的日志，别打 stderr
        pass

    def _deny(self, code, msg):
        body = json.dumps({"error": msg}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _relay(self, method):
        ip = self.client_address[0]
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path

        if _slow_down(ip):
            return self._deny(429, "请求过于频繁")

        if not _cmp(_token_of(self), TOKEN):
            log("deny  %s %s  from %s (token 不匹配)" % (method, path, ip))
            return self._deny(401, "token 无效")

        if not path.startswith(ALLOW_PREFIXES):
            return self._deny(403, "路径不在白名单内：%s" % path)
        if method in ("DELETE",):
            return self._deny(405, "不允许破坏性方法：%s" % method)

        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None

        upstream = UPSTREAM + path + (("?" + parts.query) if parts.query else "")
        req = urllib.request.Request(upstream, data=body, method=method)
        for k in ("Content-Type", "Accept", "Range"):
            if self.headers.get(k):
                req.add_header(k, self.headers.get(k))

        acquired = _sem.acquire(timeout=30)
        if not acquired:
            return self._deny(503, "后端繁忙，请稍后重试")
        try:
            try:
                r = urllib.request.urlopen(req, timeout=300)
                status, resp_headers, raw = r.status, r.headers, r
            except urllib.error.HTTPError as e:
                status, resp_headers, raw = e.code, e.headers, e
            payload = raw.read()
        except Exception as e:
            log("error %s %s -> %s" % (method, path, e))
            return self._deny(502, "访问 ComfyUI 失败：%s" % e)
        finally:
            _sem.release()

        self.send_response(status)
        for k, v in resp_headers.items():
            if k.lower() in ("transfer-encoding", "connection", "content-length"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)
        log("ok    %s %s  %s bytes" % (method, path, len(payload)))

    def do_GET(self):
        self._relay("GET")

    def do_POST(self):
        self._relay("POST")

    def do_HEAD(self):
        self._relay("HEAD")


class Server(ThreadingHTTPServer):  # ThreadingHTTPServer 本身已是多线程，不要再混 ThreadingMixIn
    daemon_threads = True
    allow_reuse_address = True


def main():
    global TOKEN
    env = load_env()
    TOKEN = env.get("LOOM_PROXY_TOKEN") or os.environ.get("LOOM_PROXY_TOKEN") or ""
    if not TOKEN:
        print("LOOM_PROXY_TOKEN 未配置 —— 拒绝启动（不设 token 等于把 GPU 开放给公网）", file=sys.stderr)
        sys.exit(2)
    port = int(env.get("LOOM_PROXY_PORT") or LISTEN_PORT)
    global UPSTREAM
    UPSTREAM = (env.get("LOOM_COMFY_UPSTREAM") or UPSTREAM).rstrip("/")
    log("启动：监听 0.0.0.0:%s → %s" % (port, UPSTREAM))
    Server(("0.0.0.0", port), ProxyHandler).serve_forever()


if __name__ == "__main__":
    main()
