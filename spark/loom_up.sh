#!/bin/bash
# LOOM · Spark 侧一键启动：ComfyUI → 鉴权代理 → 整片调度器 → natapp 隧道 → 地址上报守护
#
# 顺序是有讲究的：ComfyUI 必须先起来（代理与调度器要转发给它），natapp 必须最后起
# （它一起来，公网就能访问了，此时代理必须已经在端口上等着）。
set -u
L=/home/Developer/loom
NAT=/home/Developer/natapp
COMFY=/home/Developer/minimax-h3-dgx-spark/ComfyUI
PY=/home/Developer/miniforge3/envs/h3-comfy/bin/python

alive() { pgrep -f "$1" >/dev/null 2>&1; }

echo "== 1/5 ComfyUI（回环 8288）=="
if alive "[m]ain.py --listen 127.0.0.1 --port 8288"; then
  echo "  已在运行"
elif alive "[m]ain.py"; then
  echo "  ⚠️  检测到 ComfyUI 正在以旧参数运行（--listen 0.0.0.0 --port 8188）。"
  echo "     它会占住 8188，代理起不来。请先执行： bash $L/comfy_switch.sh"
  echo "     该脚本会把它改成只监听回环的 8288，并让代理接管 8188。"
  exit 1
else
  cd "$COMFY" && setsid nohup "$PY" main.py --listen 127.0.0.1 --port 8288 \
      </dev/null >>"$L/comfy.log" 2>&1 &
  echo "  已启动，等待就绪…"; sleep 20
fi

echo "== 2/5 鉴权代理（0.0.0.0:8188 → 127.0.0.1:8288 / 8388）=="
if alive "[l]oom_proxy.py"; then echo "  已在运行"; else
  setsid nohup python3 "$L/loom_proxy.py" </dev/null >>"$L/proxy.log" 2>&1 &
  sleep 2; alive "[l]oom_proxy.py" && echo "  已启动" || { echo "  ❌ 启动失败，看 $L/proxy.log"; exit 1; }
fi

echo "== 2.5/5 整片调度器（127.0.0.1:8388，由代理 /batch/* 转发进来）=="
if alive "[l]oom_batch.py"; then echo "  已在运行"; else
  setsid nohup python3 "$L/loom_batch.py" </dev/null >>"$L/batch.log" 2>&1 &
  sleep 2; alive "[l]oom_batch.py" && echo "  已启动" || { echo "  ❌ 启动失败，看 $L/batch.log"; exit 1; }
fi

echo "== 3/5 natapp 隧道 =="
if pgrep -x natapp >/dev/null; then echo "  已在运行"; else
  cd "$NAT" && setsid nohup sh "$NAT/start.sh" </dev/null >>"$NAT/natapp.log" 2>&1 &
  sleep 10
fi

echo "== 4/5 地址上报守护 =="
if alive "[l]oom_watch.py"; then echo "  已在运行"; else
  setsid nohup python3 "$L/loom_watch.py" </dev/null >>"$L/watch.log" 2>&1 &
  sleep 3; alive "[l]oom_watch.py" && echo "  已启动" || echo "  ⚠️  启动失败（不影响隧道，仅影响自动上报）"
fi

echo "== 5/5 状态总览 =="
bash "$L/loom_status.sh"