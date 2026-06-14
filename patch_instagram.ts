import fs from 'fs';
import path from 'path';

// مسیر فایل نهایی که توسط Render اجرا می‌شود
const distServerPath = path.join('dist', 'server.cjs');

if (fs.existsSync(distServerPath)) {
  let distContent = fs.readFileSync(distServerPath, 'utf8');
  
  const n8nEndpoint = `
    app.post("/api/n8n-check-slots", async (req, res) => {
      try {
        const { startDate, endDate, durationMinutes } = req.body;
        // در اینجا باید دقت کنی که متغیرِ activeConfig در dist در دسترس باشد
        const adapter = getCalendarAdapter(activeConfig);
        const result = await adapter.checkSlots(startDate, endDate, durationMinutes);
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ error: "API Error" });
      }
    });
  `;

  // تزریق به فایلِ بیلدشده
  if (!distContent.includes('/api/n8n-check-slots')) {
    distContent = distContent.replace('const app = express();', 'const app = express();\n' + n8nEndpoint);
    fs.writeFileSync(distServerPath, distContent);
  }
}
