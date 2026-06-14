import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

const oldCode = `    if (m.tool_calls) {
      return { role: 'model', parts: m.tool_calls.map((c:any) => ({ functionCall: { name: c.function.name, args: JSON.parse(c.function.arguments), id: c.id } })) };
    }`;

const newCode = `    if (m.tool_calls) {
      const toolParts = m.tool_calls.map((c:any) => ({ functionCall: { name: c.function.name, args: JSON.parse(c.function.arguments), id: c.id } }));
      if (typeof m.content === "string" && m.content.length > 0) {
          return { role: 'model', parts: [{ text: m.content }, ...toolParts] };
      }
      return { role: 'model', parts: toolParts };
    }`;

content = content.replace(oldCode, newCode);
fs.writeFileSync("server.ts", content, "utf8");
console.log("Patched tool calls mapped parts.");
