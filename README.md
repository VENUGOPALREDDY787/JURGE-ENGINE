# Jurge Engine — Online Code Execution Platform

This repository is a starting point for a production-grade online code execution engine (Judge0-like) built with Node.js, Express, MongoDB, BullMQ, Redis and Docker.

See the `src/` folder for core components: server, models, routes, services, workers, and sandbox runner.

Quick start (requires Docker):

```bash
cp .env.example .env
docker-compose up --build
```



.ENV COONTENT :-
PORT=3000
MONGODB_URI=mongodb://localhost:27017/execution-engine
SANDBOX_CPU=0.5
SANDBOX_MEMORY=256m
SANDBOX_TIMEOUT_MS=5000
REDIS_HOST = 127.0.0.1
REDIS_PORT = 6379
REDIS_PASSWORD = 12345