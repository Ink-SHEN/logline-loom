#!/bin/bash
# LOOM · 本地节点（DGX Spark）侧一键启动：ComfyUI → 鉴权代理 → 整片调度器
#
# 顺序是有讲究的：ComfyUI 必须先起来（代理与调度器都要转发给它）。
#
# 2026-09-13 第二次变更：**隧道与地址上报整体退役**。
# 架构改了——创空间不再远程回源本机生成，⑤ 生成站改成创空间侧一层可插拔的
# 模型 API 接口（见 space/generate.py）。本机因此**完全不需要公网入口**：
# cloudflared / natapp / loom_watch 全部摘掉，端口只为本机内部使用而开。
set -u
L=/home/Developer/loom
COMFY=/home/Developer/minimax-h3-dgx-spark/ComfyUI
PY=/home/Developer/miniforge3/envs/h3-comfy/bin/python

alive() { pgrep -f "$1" >/dev/null 2>&1; }

echo "== 1/4 ComfyUI（回环 8288）=="
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

echo "== 2/4 鉴权代理（0.0.0.0:8188 → 127.0.0.1:8288 / 8388）=="
if alive "[l]oom_proxy.py"; then echo "  已在运行"; else
  setsid nohup python3 "$L/loom_proxy.py" </dev/null >>"$L/proxy.log" 2>&1 &
  sleep 2; alive "[l]oom_proxy.py" && echo "  已启动" || { echo "  ❌ 启动失败，看 $L/proxy.log"; exit 1; }
fi

echo "== 3/4 整片调度器（127.0.0.1:8388，由代理 /batch/* 转发进来）=="
if alive "[l]oom_batch.py"; then echo "  已在运行"; else
  setsid nohup python3 "$L/loom_batch.py" </dev/null >>"$L/batch.log" 2>&1 &
  sleep 2; alive "[l]oom_batch.py" && echo "  已启动" || { echo "  ❌ 启动失败，看 $L/batch.log"; exit 1; }
fi

echo "== 4/4 状态总览 =="
bash "$L/loom_status.sh"
