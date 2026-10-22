// Check grammatical glue around an address, not the language of the address.
// Proper nouns such as Stjärngatan and Nordpark are deliberately untouched.
const addressPrepositions: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['på', ['sv']], ['vid', ['sv']], ['at', ['en']], ['en', ['es']],
  ['auf', ['de']], ['bei', ['de']], ['در', ['fa']], ['في', ['ar']],
];
export function hasForeignAddressPreposition(text: string, language: string): boolean {
  return addressPrepositions.some(([word, languages]) => !languages.includes(language) &&
    new RegExp(`(?<![\\p{L}\\p{M}])${word}\\s+(?:[\\p{Lu}][\\p{L}\\p{M}'’.-]*\\s+){1,4}[0-9٠-٩۰-۹]+(?![\\p{L}\\p{N}])`, 'u').test(text));
}
