process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.GEMINI_API_KEYS = 'synthetic-offline';
process.env.OPENAI_API_KEY = 'synthetic-offline';
process.env.GEMINI_API_KEY = 'synthetic-offline';
process.env.GOOGLE_API_KEY = 'synthetic-offline';
const deny = () => { throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN: mock every external request'); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const mod = require(name); mod.request = deny; mod.get = deny;
}
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:module').syncBuiltinESMExports();
