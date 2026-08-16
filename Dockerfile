FROM node:22.18.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:22.18.0-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 ATLAS_PUBLIC=/app/dist
RUN apk add --no-cache openssh-client
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node","dist-server/index.js"]
