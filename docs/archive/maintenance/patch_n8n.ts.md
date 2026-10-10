# patch_n8n.ts — historical non-executable fragment

Retired on 2026-10-08. This is preserved source material, not a supported
maintenance command. Do not execute it or reconstruct missing file operations
from this reference.

- Original path: `patch_n8n.ts`
- Introducing commit: `3fa949036264234c572a9bdb4047445bacdd3efe` (2026-06-14)
- Original Git blob: `5da59a2d7f3c29851273ce59ddf48c5e5c6b38ef`
- Original file SHA-256: `79c4b3c4f92a8cede713bb8885362b3c38a8ae3b272af9e24f49605f48eb2f53`
- Last inspected ancestry: `adec3d68b9dfdaaaede7ed00c3c17dfae22e9540`

The introducing commit added only this fragment. Its history contains no later
repair, and no import, package, build or deployment workflow invokes it. The
fragment references an undeclared `content` variable and has no input/output
lifecycle. Its comment suggests inserting code into `server.ts`, but does not
establish a supported executable script. Related historical sibling scripts
used different insertion points and targets; they do not supply this file's
missing contract.

Retirement preserves the historical content instead of inventing behavior or
suppressing diagnostics. No active endpoint or maintenance workflow is removed.
The `.md` artifact is documentation, intentionally outside executable TypeScript
sources without any change to compiler or lint configuration.

## Exact original source

The following block preserves every byte of the original UTF-8 file, including
its final newline. See the [archive policy](README.md).

```ts
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
```
