import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

const regexWebTTS = /if \(voiceData\) \{[\s\S]*?outMimeType = "audio\/wav";[\s\S]*?\}\n         \} catch \(ttsErr\)/m;

const replacementWebTTS = `if (voiceData) {
             const pcmBase64 = voiceData.data;
             const pcmBuffer = Buffer.from(pcmBase64, 'base64');
             const sampleRate = 24000;
             const wavHeader = Buffer.alloc(44);
             wavHeader.write('RIFF', 0);
             wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
             wavHeader.write('WAVE', 8);
             wavHeader.write('fmt ', 12);
             wavHeader.writeUInt32LE(16, 16);
             wavHeader.writeUInt16LE(1, 20);
             wavHeader.writeUInt16LE(1, 22);
             wavHeader.writeUInt32LE(sampleRate, 24);
             wavHeader.writeUInt32LE(sampleRate * 2, 28);
             wavHeader.writeUInt16LE(2, 32); 
             wavHeader.writeUInt16LE(16, 34); 
             wavHeader.write('data', 36);
             wavHeader.writeUInt32LE(pcmBuffer.length, 40);
             
             const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
             audioData = wavBuffer.toString('base64');
             outMimeType = "audio/wav";
           }
         } catch (ttsErr)`;

code = code.replace(regexWebTTS, replacementWebTTS);

fs.writeFileSync('server.ts', code);
