FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json .
RUN npm install --production
COPY server.js .
COPY db/ ./db/
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
