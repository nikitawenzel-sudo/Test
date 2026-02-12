FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

ENV PORT=8080
ENV DB_PATH=/app/data/relay.db

EXPOSE 8080

CMD ["node", "server.js"]
