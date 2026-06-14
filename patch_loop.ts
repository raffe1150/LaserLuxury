import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

// FIRST OCCURRENCE in processTelegramUpdate
const regexCheckSlots1 = /if \(call\.function\.name === "checkSlots" && args\) adapterRes = await adapter\.checkSlots\(args\.startDate, args\.endDate\);/g;

const replacementCheckSlots1 = `
        if (call.function.name === "checkSlots" && args) {
            adapterRes = await adapter.checkSlots(args.startDate, args.endDate);
            if (adapterRes.available_slots_string) {
                const slotsArray = adapterRes.available_slots_string
                    .split('\\n')
                    .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));
                
                let replyMessage = "Jag hittade tyvärr inga lediga tider för den perioden. Har du något annat datum i åtanke? 😊";
                if (slotsArray.length > 0) {
                    replyMessage = "Jag hittade några lediga tider:\\n";
                    slotsArray.forEach((slot: string) => {
                        replyMessage += \`- \${slot}\\n\`;
                    });
                    replyMessage += "Vilken av dessa tider passar dig bäst? 😊";
                }
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
`;

content = content.replace(regexCheckSlots1, replacementCheckSlots1.trim());

// We also need to catch the "return { TERMINATE_EARLY... }" right after Promise.all
// Currently it is:
// messages.push(...functionResponsesParts);
// chatResponse = await generateContentWithFallback(ai, {

const arrayPushRegex = /messages\.push\(\.\.\.functionResponsesParts\);\s*chatResponse = await generateContentWithFallback/g;

const replacementArrayPush = `
      const earlyTerm = functionResponsesParts.find((p: any) => p && p.TERMINATE_EARLY);
      if (earlyTerm) {
          chatResponse.text = earlyTerm.replyMessage;
          chatResponse.functionCalls = null;
          break;
      }
      
      messages.push(...functionResponsesParts);
      
      chatResponse = await generateContentWithFallback
`;

content = content.replace(arrayPushRegex, replacementArrayPush.trim());

fs.writeFileSync("server.ts", content);
