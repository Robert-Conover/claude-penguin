FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs ./
COPY bridge ./bridge
ENV PROJECT_ROOT=/project PORT=8080 BIND_ADDRESS=0.0.0.0
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
