#!/bin/bash
# 回滚到改动前的状态：ComfyUI 重新以 --listen 0.0.0.0 --port 8188 监听，代理停掉。
# （只有在鉴权代理出问题、又马上要评审时才用这个；日常请保持代理开着——
#   关掉代理等于把没有鉴权的 ComfyUI 直接挂在公网隧道上。）
set -u
L=/home/Developer/loom
COMFY=/home/Developer/minimax-h3-dgx-spark/ComfyUI
PY=/home/Developer/miniforge3/envs/h3-comfy/bin/python

echo "→ 停止代理与 ComfyUI…"
pkill -f "[l]oom_proxy.py"; pkill -f "[m]ain.py"; sleep 6

echo "→ 以原参数重启 ComfyUI（0.0.0.0:8188）…"
cd "$COMFY"
setsid nohup "$PY" main.py --listen 0.0.0.0 --port 8188 </dev/null >>"$L/comfy.log" 2>&1 &
for i in $(seq 1 40); do
  curl -s -m 2 http://127.0.0.1:8188/system_stats >/dev/null 2>&1 && break
  sleep 3
done
curl -s -m 3 http://127.0.0.1:8188/system_stats >/dev/null 2>&1 \
  && echo "  ✅ 已回滚，隧道直连 ComfyUI（无鉴权）" \
  || echo "  ❌ 起不来，看 $L/comfy.log"
