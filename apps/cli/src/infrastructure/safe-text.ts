const sensitiveName =
  /(?:token|password|passwd|secret|api[-_]?key|credential|authorization|cookie|private[-_]?key)/iu;

export function sanitizeTerminalText(value: string, options: { multiline?: boolean } = {}): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (options.multiline && character === "\n") result += character;
    else if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) {
      result +=
        codePoint <= 0xff
          ? `\\x${codePoint.toString(16).padStart(2, "0")}`
          : `\\u{${codePoint.toString(16)}}`;
    } else result += character;
  }
  return result;
}

export function formatCommandForDisplay(argv: string[]): string {
  const redacted: string[] = [];
  let redactNext = false;
  for (const argument of argv) {
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }
    const assignment = argument.match(/^([^=]+)=(.*)$/u);
    if (assignment?.[1] && sensitiveName.test(assignment[1])) {
      redacted.push(`${assignment[1]}=<redacted>`);
      continue;
    }
    if (/^-{1,2}[^=]+$/u.test(argument) && sensitiveName.test(argument)) {
      redacted.push(argument);
      redactNext = true;
      continue;
    }
    redacted.push(redactSensitiveText(argument));
  }
  return redacted.map(quoteCommandArgument).join(" ");
}

export function formatShellForDisplay(command: string): string {
  const redactedAssignments = command.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gu,
    (assignment, name: string) => (sensitiveName.test(name) ? `${name}=<redacted>` : assignment),
  );
  const redactedFlags = redactedAssignments.replace(
    /(--?[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[-_]?key|credential|authorization|cookie|private[-_]?key)[A-Za-z0-9_-]*)(?:=|\s+)("[^"]*"|'[^']*'|[^\s]+)/giu,
    "$1=<redacted>",
  );
  return sanitizeTerminalText(redactSensitiveText(redactedFlags));
}

export function redactSensitiveText(value: string): string {
  const withoutCredentials = value.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gu,
    "$1<redacted>@",
  );
  return withoutCredentials.replace(
    /([?&](?:token|password|passwd|secret|api[-_]?key|credential|authorization|cookie|private[-_]?key)=)[^&#\s]*/giu,
    "$1<redacted>",
  );
}

function quoteCommandArgument(argument: string): string {
  const safe = sanitizeTerminalText(argument);
  if (/^[A-Za-z0-9_@%+=:,./<>-]+$/u.test(safe)) return safe;
  return `'${safe.replaceAll("'", `'\\''`)}'`;
}
