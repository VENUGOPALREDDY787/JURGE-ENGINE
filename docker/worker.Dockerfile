FROM node:18-slim
RUN apt-get update && apt-get install -y build-essential gcc g++ openjdk-11-jdk python3 python3-pip golang-go curl timeout && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "src/workers/launchWorkers.js"]
