import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

const oldC1 = "You are strictly FORBIDDEN from telling a user whether a date or time is available or free based on your memory. You MUST explicitly call the `checkSlots` tool EVERY SINGLE TIME a user asks about availability, mentions a date/time, or requests a booking.";
const newC1 = "You may use your conversation memory (context) to keep track of already checked time slots without re-checking the calendar if you already queried the exact date in this conversation. However, BEFORE proposing any NEW date/time or confirming a booking, you MUST read the calendar output.";

content = content.replace(new RegExp(oldC1.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), "g"), newC1);

const oldC2 = "CRITICAL CONSTRAINT: Keep response max 60 words, strictly use `checkSlots` before any scheduling.";
const newC2 = "CRITICAL CONSTRAINT: Keep response max 60 words, use memory of checked slots if applicable, otherwise use `checkSlots`.";

content = content.replace(new RegExp(oldC2.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), "g"), newC2);

fs.writeFileSync("server.ts", content);
console.log("Patched constraint.", content.includes(newC1));
