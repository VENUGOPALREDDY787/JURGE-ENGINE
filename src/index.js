const Bull = require('bull');
const dotenv = require('dotenv');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

dotenv.config();

const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = process.env;

const redisOptions = { redis: { host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD } };
const burgerQueue = new Bull('burger', redisOptions);

burgerQueue.process(async (job) => {
  console.log('grill the patty');
  job.progress(25);

  await sleep(1000);

  console.log('add cheese');
  job.progress(50);

  await sleep(1000);

  console.log('add toppings');
  job.progress(75);

  await sleep(1000);

  console.log('serve the burger');
  job.progress(100);

  return { status: 'completed' };
});

burgerQueue.add({ bun: 'sesame', chesse: 'cheddar', toppings: ['lettuce', 'tomato', 'onion'] });
