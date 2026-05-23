FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    AI_EDGE_KEY= \
    AI_EDGE_CONFIG=

RUN npm install -g ai-edge

EXPOSE 25789

CMD ["ai-edge", "serve", "--skip-prompts"]
