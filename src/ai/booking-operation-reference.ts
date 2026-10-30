/** Detection copy only: attributive state in a temporal reference does not
 * assert an operation. Retain the noun and every independent predicate. */
export function withoutTemporalBookingAttribute(text:string):string {
 return text.replace(/\b(before|after)\s+((?:their|your|the|an?|our|his|her)\s+)(?:booked|confirmed|reserved)\s+(?=(?:appointments?|bookings?|slots?|times?)\b)/giu,'$1 $2');
}
