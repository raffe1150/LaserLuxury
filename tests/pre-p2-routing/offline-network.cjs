const fs=require('node:fs');const exists=fs.existsSync;fs.existsSync=function(p){if(String(p).endsWith('agent-config.json'))return false;return exists.call(this,p)};
const deny=()=>{throw new Error('AUDIT_NETWORK_DISABLED')};global.fetch=async()=>{throw new Error('AUDIT_NETWORK_DISABLED')};
require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;require('node:dgram').createSocket=deny;
