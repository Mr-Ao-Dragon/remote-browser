# remote-browser 自定义沙箱镜像（可选）
#
# 默认直接使用官方镜像 ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest，
# 无需构建本文件。当需要补字体、时区、证书或额外系统依赖时，再基于官方镜像加一层：
# 这样能保留 AGS 必需的 /init、envd(49983) 与 nginx(9000 → 127.0.0.1:9222) 反代。
#
# 构建与推送：
#   docker build -t registry.example.com/remote-browser/sandbox-browser:1 ./docker
#   docker push registry.example.com/remote-browser/sandbox-browser:1
#
# 使用时把 RB_IMAGE 指向新镜像，或用 node scripts/deploy.cjs（读取 RB_IMAGE）。

FROM ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest

# 中文站点常见需求：CJK 字体与时区，避免截图/markdown 出现方块
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        tzdata \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TZ=Asia/Shanghai

# 保持官方入口不变：由 /init 拉起 nginx 与 AGS 组件，
# Chromium 由 AGS 工具的 Args 启动脚本负责拉起（见 src/sandbox/bootstrap.ts 的 BROWSER_BOOTSTRAP）。
ENTRYPOINT ["/init"]