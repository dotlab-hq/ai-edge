FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    AI_EDGE_KEY= \
    AI_EDGE_CONFIG= \
    NODE_OPTIONS=--max-old-space-size=384

RUN npm install -g ai-edge

EXPOSE 25789

CMD ["ai-edge", "serve", "--skip-prompts"]
