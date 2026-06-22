const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Default versions — derived from the existing nsjail Dockerfiles in docker/
// ---------------------------------------------------------------------------
const RUNTIME_DEFAULTS = [
  { language: 'python',     version: '3.12',  imageName: 'judge-python-nsjail' },
  { language: 'java',       version: '21',    imageName: 'judge-java-nsjail'   },
  { language: 'javascript', version: '20',    imageName: 'judge-node-nsjail'   },
  { language: 'c',          version: '12',    imageName: 'judge-c-nsjail'      },
  { language: 'cpp',        version: '12',    imageName: 'judge-cpp-nsjail'    },
  { language: 'go',         version: '1.22',  imageName: 'judge-go-nsjail'     },
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const runtimeSchema = new mongoose.Schema(
  {
    language:  { type: String, required: true, unique: true, index: true },
    version:   { type: String, required: true },
    imageName: { type: String, required: true },

    // Build lifecycle — 'idle' | 'building' | 'failed'
    status:   { type: String, enum: ['idle', 'building', 'failed'], default: 'idle' },

    // Last build output (stdout + stderr captured from dockerode stream)
    buildLog: { type: String, default: '' },
  },
  { timestamps: true }
);

const Runtime = mongoose.model('Runtime', runtimeSchema);

// ---------------------------------------------------------------------------
// Seed — called lazily on first GET /api/runtimes so no startup coupling
// ---------------------------------------------------------------------------
async function seedRuntimeDefaults() {
  const count = await Runtime.countDocuments();
  if (count === 0) {
    await Runtime.insertMany(RUNTIME_DEFAULTS);
    console.log('[runtime] Seeded default runtime versions');
  }
}

module.exports = { Runtime, RUNTIME_DEFAULTS, seedRuntimeDefaults };
