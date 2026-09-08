#!/bin/bash
# 把 ComfyUI 从「公网可直连」切到「只监听回环，由鉴权代理接管」。
#
# 背景：ComfyUI 现在是 `python main.py --listen 0.0.0.0 --port 8188`，
# 而 natapp 隧道的转发目标就是 8188 —— 等于把没有任何鉴权的 ComfyUI 直接挂在公网上。
#
# 本脚本做的事：
#   1. 停掉 ComfyUI
#   2. 用 --listen 127.0.0.1 --port 8288 重新拉起（公网碰不到，natapp 配置不用改）
#   3. 启动代理监听 8188（natapp 的转发目标不变），转发到 8288
#
# 回滚：bash /home/Developer/loom/comfy_rollback.sh
set -u
L=/home/Developer/loom
COMFY=/home/Developer/minimax-h3-dgx-spark/ComfyUI
PY=/home/Developer/miniforge3/envs/h3-comfy/bin/python

# 注意：pgrep -f 的模式要写成 [m]ain.py，否则会匹配到执行本脚本的 shell 自己
# （它的命令行里就含 "main.py" 这几个字）→ 把自己杀掉。
echo "→ 停止 ComfyUI…"
pkill -f "[m]ain.py"; sleep 6
pgrep -f "[m]ain.py" >/dev/null && { echo "  ❌ 没停掉，取消操作"; exit 1; }

echo "→ 以回环地址重启（--listen 127.0.0.1 --port 8288）…"
cd "$COMFY"
setsid nohup "$PY" main.py --listen 127.0.0.1 --port 8288 </dev/null >>"$L/comfy.log" 2>&1 &
for i in $(seq 1 40); do
  curl -s -m 2 http://127.0.0.1:8288/system_stats >/dev/null 2>&1 && break
  sleep 3
done
curl -s -m 3 http://127.0.0.1:8288/system_stats >/dev/null 2>&1 \
  && echo "  ✅ ComfyUI 已在 8288 就绪" \
  || { echo "  ❌ 起不来，看 $L/comfy.log；回滚：bash $L/comfy_rollback.sh"; exit 1; }

echo "→ 启动鉴权代理（8188 → 8288）…"
pgrep -f loom_proxy.py >/dev/null || setsid nohup python3 "$L/loom_proxy.py" </dev/null >>"$L/proxy.log" 2>&1 &
sleep 3
echo "  无 token 访问（应拒绝）："
curl -s -m 5 -o /dev/null -w "    HTTP %{http_code}\n" http://127.0.0.1:8188/system_stats
echo
echo "完成。用带 token 的方式自测："
echo "  curl -H 'Authorization: Bearer \$(grep LOOM_PROXY_TOKEN $L/loom.env | cut -d= -f2)' http://127.0.0.1:8188/system_stats"
