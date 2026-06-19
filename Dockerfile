FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
ARG SOURCE_COMMIT=unknown
ENV GIT_COMMIT=${SOURCE_COMMIT}
COPY server.js .
COPY db/ ./db/
COPY seeds/ ./seeds/
COPY f3-dashboard/ ./f3-dashboard/
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
