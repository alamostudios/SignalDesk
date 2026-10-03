FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS app
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data STORAGE_DIR=/app/storage
RUN apk add --no-cache ffmpeg && mkdir -p /app/data /app/storage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/migrations ./api/migrations
COPY --from=build /app/web/dist ./web/dist
RUN chown -R node:node /app/data /app/storage
USER node
EXPOSE 3000
CMD ["node", "api/dist/server.js"]