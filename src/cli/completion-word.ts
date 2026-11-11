// Bash completion words retain quoting from the command line. Decode only quotes and escapes;
// command substitution, variable expansion, and other shell evaluation must never run here.
export function decodeCompletionWord(word: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < word.length; index += 1) {
    const character = word[index];
    if (character === undefined) continue;
    if (character === "\\" && quote !== "'") {
      const next = word[index + 1];
      if (next !== undefined && (quote !== '"' || ["$", "`", '"', "\\", "\n"].includes(next))) {
        if (next !== "\n") result += next;
        index += 1;
      } else if (next !== undefined) result += character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    result += character;
  }
  return result;
}
