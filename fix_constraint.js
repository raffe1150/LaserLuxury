const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');
const oldStr = 'CRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. Never exceed this limit under any circumstances, whether responding in Swedish, English, or Persian or another languages . Keep it brief, professional, and straight to the point.';
const newStr = 'CRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. You are strictly FORBIDDEN from telling a user whether a date or time is available or free based on your memory. You MUST explicitly call the `checkSlots` tool EVERY SINGLE TIME a user asks about availability, mentions a date/time, or requests a booking. If a slot is marked as \\\'BOOKED\\\' in the matrix, you must tell the user it is taken and offer alternative open slots.';
content = content.split(oldStr).join(newStr);
fs.writeFileSync('server.ts', content);
