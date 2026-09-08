#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LOOM · natapp 隧道守护 + 地址上报。

干三件事，都是为了「评审那几天窗口不能断」：

1. **保活**：natapp 进程没了就拉起来（免费隧道会掉线，掉线后地址可能变）。
2. **认地址**：从 natapp 日志里读出当前公网地址，写进 `~/loom/tunnel_url`。
   natapp 的本地控制台（4040）只有 HTML 页面、没有 JSON 接口，所以解析日志是唯一可靠的办法。
3. **报地址**：地址一变（或每 REPORT_INTERVAL 秒）就 POST 给创空间。
   这样即使域名变了，创空间也能自己找到新地址，不用人去改 secrets。

上报失败不影响本地运行——会记在 report_state.json 里，地址也始终写在本地文件，
随时可以人工抄到创空间的 secrets 里。
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(HERE, "loom.env")
NATAPP_DIR = os.path.expanduser("~/natapp")
NATAPP_LOG = os.path.join(NATAPP_DIR, "natapp.log")
TUNNEL_URL_FILE = os.path.join(HERE, "tunnel_url")
STATE_FILE = os.path.join(HERE, "report_state.json")
WATCH_LOG = os.path.join(HERE, "watch.log")

URL_RE = re.compile(r"(?:Tunnel established at|forwarding=)(http://[^\s\"']+)")
CHECK_INTERVAL = 20
REPORT_INTERVAL = 300


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(WATCH_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def load_env():
    d = {}
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return d


def natapp_running():
    try:
        out = subprocess.run(["pgrep", "-x", "natapp"], capture_output=True, text=True, timeout=10)
        return bool(out.stdout.strip())
    except Exception:
        return False


def start_natapp():
    log("natapp 未运行，正在拉起…")
    try:
        subprocess.Popen(
            ["setsid", "nohup", "sh", os.path.join(NATAPP_DIR, "start.sh")],
            cwd=NATAPP_DIR,
            stdin=subprocess.DEVNULL,
            stdout=open(os.path.join(NATAPP_DIR, "start.out"), "ab"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except Exception as e:
        log("拉起失败：%s" % e)


def current_url():
    """从 natapp 日志里取最后一次成功的公网地址。"""
    try:
        with open(NATAPP_LOG, encoding="utf-8", errors="replace") as f:
            txt = f.read()
    except FileNotFoundError:
        return ""
    hits = URL_RE.findall(txt)
    return hits[-1].rstrip(",;") if hits else ""


def report(api_base, ms_token, token, url):
    """把当前地址告诉创空间。成功返回说明文字，失败返回 None。

    走 Gradio 的 API 通道（/gradio_api/run/report_tunnel）：
    魔搭网关只放行 /gradio_api/*，自定义 HTTP 路由从外面调不到。
    代价是这个通道要魔搭 token 鉴权——所以 LOOM_MS_TOKEN 留空就跳过自动上报，
    地址照样写进 tunnel_url 文件，人工抄到 secrets 里一样能用。
    """
    if not api_base or not url or not ms_token:
        return None
    payload = json.dumps({"data": [url, token]}).encode("utf-8")
    req = urllib.request.Request(
        api_base.rstrip("/") + "/gradio_api/run/report_tunnel", data=payload, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer %s" % ms_token})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            if r.status == 200:
                return "已上报（gradio_api/run/report_tunnel）"
    except urllib.error.HTTPError as e:
        log("上报失败：HTTP %s" % e.code)
    except Exception as e:
        log("上报失败：%s" % e)
    return None


def main():
    env = load_env()
    token = env.get("LOOM_PROXY_TOKEN") or ""
    ms_token = env.get("LOOM_MS_TOKEN") or ""
    api_base = env.get("LOOM_SPACE_API") or ""
    last_url, last_report = "", 0

    log("守护启动：自动上报=%s  每 %ss 检查一次"
        % ("开" if ms_token else "关（未填 LOOM_MS_TOKEN）", CHECK_INTERVAL))
    while True:
        try:
            if not natapp_running():
                start_natapp()
                time.sleep(12)
            url = current_url()
            if url and url != last_url:
                last_url = url
                with open(TUNNEL_URL_FILE, "w", encoding="utf-8") as f:
                    f.write(url + "\n")
                log("隧道地址：%s" % url)
                last_report = 0  # 地址变了，立刻上报

            now = time.time()
            if url and (not last_report or now - last_report > REPORT_INTERVAL):
                ok = report(api_base, ms_token, token, url)
                if not ms_token:
                    err = "未启用自动上报（LOOM_MS_TOKEN 为空）——地址已写入 tunnel_url，可手动填进创空间 secrets"
                elif ok:
                    err = ""
                else:
                    err = "上报失败（创空间可能在重建，或 token 无效）"
                state = {
                    "url": url,
                    "reported_at": int(now),
                    "channel": "gradio_api" if ok else "",
                    "last_error": err,
                }
                with open(STATE_FILE, "w", encoding="utf-8") as f:
                    json.dump(state, f, ensure_ascii=False, indent=1)
                if ok:
                    last_report = now
                    log("上报成功：%s" % ok)
                else:
                    last_report = now - REPORT_INTERVAL + 60  # 1 分钟后重试
                    log("上报失败：%s" % state["last_error"])
        except Exception as e:
            log("循环异常：%s" % e)
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
