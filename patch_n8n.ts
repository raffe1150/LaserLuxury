const n8nEndpoint = `
  app.post("/api/n8n-check-slots", async (req, res) => {
    try {
      const { startDate, endDate, durationMinutes } = req.body;
      const adapter = getCalendarAdapter(activeConfig);
      const result = await adapter.checkSlots(startDate, endDate, durationMinutes);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch slots" });
    }
  });
`;

// سپس این کد را به محتویاتِ server.ts اضافه کنید (شبیه به همان کاری که برای webhook کردید)
content = content.replace('app.post("/api/setup-telegram", ', n8nEndpoint + "\napp.post(\"/api/setup-telegram\", ");
