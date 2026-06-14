import fs from "fs";
let c = fs.readFileSync("server.ts", "utf8");

const oldRules = "\"\\nBOOKING RULES: 1. Before calling `insertAppointment`, you must check availability. If a user asks for a slot that is already booked, you must NOT book it. 2. MANDATORY DATA COLLECTION: Before calling `createEvent` or `insertAppointment`, you MUST explicitly and politely ask the user for their Name and Mobile Number ('Vad är ditt namn och mobilnummer?'). You are STRICTLY PROHIBITED from calling `insertAppointment` until both pieces of information are gathered from the user's voice/text.\";"

const newRules = oldRules.replace(".\";", ". 3. VAGUE TIME REQUESTS: Whenever a customer asks for a vague or general time (e.g., 'next week', 'sometime this afternoon', 'tomorrow around lunch'), DO NOT ask them 'What time works for you?'. Instead, automatically call the checkSlots tool for that period. Once you receive the list of empty slots, politely offer the top 2 or 3 closest options to the customer and ask them to choose one.\";");

c = c.replaceAll(oldRules, newRules);

fs.writeFileSync("server.ts", c);
