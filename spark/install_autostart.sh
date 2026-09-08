#!/bin/bash
# 把 LOOM 链路配成「机器重启后自动恢复 + 持续自愈」，全程不需要 sudo。
#
# 原理（对无 sudo 的账号最可靠）：
#   1. crontab @reboot 在开机时跑一次 loom_up.sh（按顺序拉起 ComfyUI/代理/natapp/守望）
#   2. crontab 每 2 分钟跑一次 loom_health.sh：哪个环节断了就补拉哪个
#
# 效果：评审那几天（09.15–09.18）哪怕 DGX Spark 重启/掉线，也会自己恢复。
set -u
L=/home/Developer/loom
# @reboot 里没有完整 PATH，脚本开头得显式带上
PATH_LINE='export PATH=/home/Developer/miniforge3/bin:/home/Developer/miniforge3/condabin:/usr/bin:/bin:/usr/local/bin'

# 先清掉旧的 loom 相关 cron（避免重复条目）
crontab -l 2>/dev/null | grep -vE 'loom_up\.sh|loom_health\.sh' > /tmp/loom_cron.new

cat >> /tmp/loom_cron.new <<EOF
$PATH_LINE
@reboot bash $L/loom_up.sh >> $L/autostart.log 2>&1
*/2 * * * * bash $L/loom_health.sh >> $L/health.log 2>&1
EOF

crontab /tmp/loom_cron.new && echo "crontab 已安装：" && crontab -l | grep loom
echo
echo "立即自测一次 loom_health.sh："
bash "$L/loom_health.sh"; echo "退出码 $?"
