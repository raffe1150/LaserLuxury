// Fail closed if an audit regression accidentally reaches a real network client.
import net from 'node:net';
process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.GEMINI_API_KEY = 'offline-placeholder';
net.Socket.prototype.connect = function () { throw new Error('Network forbidden in offline context audit'); };
globalThis.fetch = async () => { throw new Error('Network forbidden in offline context audit'); };
