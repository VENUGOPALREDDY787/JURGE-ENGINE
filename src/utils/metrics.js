// Minimal Prometheus metrics endpoint placeholder. In production, integrate prom-client.
module.exports.setupMetrics = (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send('# HELP judge_submissions_total Total submissions\n# TYPE judge_submissions_total counter\njudge_submissions_total 1');
};
