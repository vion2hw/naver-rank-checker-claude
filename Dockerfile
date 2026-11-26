# 네이버 순위체커 서버 이미지
# Playwright 공식 이미지(Chromium과 필요한 리눅스 라이브러리 포함). playwright-core 1.65.1 과 버전을 맞춘다.
# amd64 / arm64 둘 다 있어 일반 서버와 Oracle Arm 무료 서버 모두에서 돈다.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    PORT=8080 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY checkers.cjs server.cjs ./
COPY public ./public
RUN mkdir -p /data

EXPOSE 8080
# WEB_PASSWORD 는 실행할 때 환경변수로 넣는다(이미지에 넣지 않음).
CMD ["node", "server.cjs"]
