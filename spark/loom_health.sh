#!/bin/bash
# LOOM 链路健康自愈（本地节点侧）：哪个环节断了，就把从它开始的后续环节补拉起来。
# 每 2 分钟由 crontab 调用一次。链路依赖（必须按序）：
#   ComfyUI(8288) → loom_proxy(8188) → loom_batch(8388)
#
# 2026-09-13 第二次变更：**隧道与地址上报整体退役**。
# 架构改了——不再由创空间远程回源本机生成，⑤ 生成站改成创空间侧一层
# 可插拔的模型 API 接口（见 space/generate.py）。本机不再需要公网入口，
# 所以 cloudflared / natapp / loom_watch 三个环节全部摘掉，续跑也不再有隧道步骤。
#
# 保留的历史教训（适用于任何环节）：**进程存活 ≠ 服务可用**。
# 上次隧道死了 2.5 天而巡检全绿，就是只看了进程。所以下面每一步都真打接口，不看进程。
set -u
L=/home/Developer/loom
COMFY=/home/Developer/minimax-h3-dgx-spark/ComfyUI
PY=/home/Developer/miniforge3/envs/h3-comfy/bin/python
export PATH=/home/Developer/miniforge3/bin:/usr/bin:/bin:/usr/local/bin

now() { date '+%Y-%m-%d %H:%M:%S'; }
ok_comfy=0; ok_proxy=0; ok_batch=0

# 1) ComfyUI：必须监听 127.0.0.1:8288（回环，公网不可达）
if curl -s -m 3 http://127.0.0.1:8288/system_stats >/dev/null 2>&1; then
  ok_comfy=1
elif ! pgrep -f "[m]ain.py --listen 127.0.0.1 --port 8288" >/dev/null; then
  echo "$(now) ComfyUI 未在 8288，尝试拉起…"
  cd "$COMFY" && setsid nohup "$PY" main.py --listen 127.0.0.1 --port 8288 \
      </dev/null >>"$L/comfy.log" 2>&1 &
  sleep 15
  curl -s -m 3 http://127.0.0.1:8288/system_stats >/dev/null 2>&1 && ok_comfy=1
fi

# 2) loom_proxy：8188 → 8288（本机内部使用；已不再对外暴露）
if curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats 2>/dev/null \
   | grep -qE '^(401|403|200|500)$'; then
  ok_proxy=1  # 代理活着（401=token 校验拦截，也算活着）
else
  echo "$(now) loom_proxy 未响应，尝试拉起…"
  setsid nohup python3 "$L/loom_proxy.py" </dev/null >>"$L/proxy.log" 2>&1 &
  sleep 3
  ok_proxy=1
fi

# 3) loom_batch：整片调度器（127.0.0.1:8388，本地可达性；无 token 期望 401）
if curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8388/batch/x 2>/dev/null \
   | grep -qE '^(401|403|404|200|500)$'; then
  ok_batch=1
else
  echo "$(now) loom_batch 未响应，尝试拉起…"
  setsid nohup python3 "$L/loom_batch.py" </dev/null >>"$L/batch.log" 2>&1 &
  sleep 3
  ok_batch=1
fi

echo "$(now) health: comfy=$ok_comfy proxy=$ok_proxy batch=$ok_batch tunnel=retired watch=retired"
