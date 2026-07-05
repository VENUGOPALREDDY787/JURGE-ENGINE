/**
 * submissionDispatcher.js
 *
 * Submission Dispatcher — Horizontal Scaling Ready Routing Layer
 *
 * Sits between the HTTP controller and the execution service.
 * Responsibilities:
 *   1. Accept a normalized submission payload.
 *   2. Validate the language is supported.
 *   3. Route the job into the correct language-specific BullMQ queue.
 *
 * Why this layer exists:
 *   In a horizontally scaled deployment, multiple dispatcher nodes can run
 *   behind a load balancer. Each dispatcher is stateless — it only writes to
 *   MongoDB and pushes a job ID onto the Redis-backed BullMQ queue.
 *   Worker nodes (running launchWorkers.js) can scale independently.
 *
 * Future autoscaling hooks can be added here:
 *   - Emit queue-depth metrics before/after enqueue.
 *   - Trigger scale-up events based on queue backlog.
 *   - Route to different queue clusters by language tier.
 *
 * Current behavior: delegates directly to execution.service — zero change
 * to the existing execution pipeline.
 */

const executionService = require('../services/execution.service');

/**
 * dispatchSubmission(payload)
 *
 * Enqueues a single submission for async execution.
 *
 * @param {{
 *   sourceCode: string,
 *   language: string,
 *   stdin?: string,
 *   expected_output?: string,
 *   callback_url?: string,
 *   metadata?: object
 * }} payload
 * @returns {Promise<MongooseDocument>} The created submission document.
 */
async function dispatchSubmission(payload) {
  return executionService.createAndEnqueue(payload);
}

module.exports = { dispatchSubmission };
