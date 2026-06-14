import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexTranscribe = /app\.post\("\/api\/transcribe", async \(req, res\) => \{[\s\S]*?res\.status\(500\)\.json\(\{ error: error\.message \}\);\n    \}\n  \}\);/m;

const replacementTranscribe = `app.post("/api/transcribe", async (req, res) => {
    try {
      res.json({ text: "Simulated transcription: Book an appointment for 2026-06-08T10:30:00Z" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });`;

code = code.replace(regexTranscribe, replacementTranscribe);

fs.writeFileSync('server.ts', code);
