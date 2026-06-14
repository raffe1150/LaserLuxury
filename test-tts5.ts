import { EdgeTTS } from 'node-edge-tts';
global.tts = new EdgeTTS({ voice: 'en-US-AriaNeural', lang: 'en-US' });
console.log(global.tts);
