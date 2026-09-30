FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache ffmpeg && mkdir -p /data/audio && chown node:node /data/audio
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/migrations ./api/migrations
USER node
EXPOSE 80 3000

FROM nginx:1.27-alpine AS web-runtime
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80