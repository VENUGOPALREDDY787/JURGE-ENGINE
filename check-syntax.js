const { execSync } = require('child_process');

const files = [
  'src/config/judge0LanguageMap.js',
  'src/utils/languageRegistry.js',
  'src/middleware/adminAuth.js',
  'src/models/LanguageConfig.js',
  'src/models/Submission.js',
  'src/services/execution.service.js',
  'src/services/admin.service.js',
  'src/controllers/submission.controller.js',
  'src/controllers/admin.controller.js',
  'src/controllers/runtime.controller.js',
  'src/routes/submission.routes.js',
  'src/routes/admin.routes.js',
  'src/workers/generic.worker.js',
  'src/workers/launchWorkers.js',
  'src/server.js',
  'src/utils/cgroupMemoryReader.js',
];

let allOk = true;
for (const f of files) {
  try {
    execSync(`node --check ${f}`, { stdio: 'pipe' });
    console.log(`  ✅  ${f}`);
  } catch (e) {
    console.error(`  ❌  ${f}`);
    console.error(e.stderr.toString());
    allOk = false;
  }
}
console.log(allOk ? '\nALL SYNTAX OK' : '\nSYNTAX ERRORS FOUND');
process.exit(allOk ? 0 : 1);
