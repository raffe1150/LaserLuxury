/** Detection copy only: attributive state in a temporal reference does not
 * assert an operation. Retain the noun and every independent predicate. */
export function withoutTemporalBookingAttribute(text:string):string {
 return text.replace(/\b(before|after)\s+((?:their|your|the|an?|our|his|her)\s+)(?:booked|confirmed|reserved)\s+(?=(?:appointments?|bookings?|slots?|times?)\b)/giu,'$1 $2')
  // Arabic definite adjectives in "before your booked appointment" describe
  // an existing appointment. Keep its noun and all independent predicates;
  // bare "your appointment is booked" and "a booking was made" still veto.
  .replace(/(?<![\p{L}\p{N}])(قبل|بعد)\s+(موعدك)\s+(?:المحجوز|المؤكد)(?![\p{L}\p{N}])/gu,'$1 $2');
}
