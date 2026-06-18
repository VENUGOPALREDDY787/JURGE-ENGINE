require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const routes = require('./routes/submission.routes');
const { initQueues } = require('./services/queue.service');
const { setupMetrics } = require('./utils/metrics');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));
app.use(compression());

// Health & metrics
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/metrics', setupMetrics);

// API
app.use('/api/submissions', routes);


const PORT = process.env.PORT || 3000;

async function start() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/judge';
  await mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('MongoDB connected');

  // initialize queues and workers
  const init = await initQueues();
  if (init && init.router) app.use('/admin/queues', init.router);

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});