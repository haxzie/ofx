/** Formatting helpers that mirror how gh prints to a terminal. */

/** gh renders ages as "about 2 days ago", "less than a minute ago". */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);

  if (seconds < 60) return "less than a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `about ${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `about ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `about ${years} year${years === 1 ? "" : "s"} ago`;
}

/** Left-aligned columns padded to the widest cell, as gh's list output does. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** gh indents issue and pull-request bodies by two spaces. */
export function indent(text: string, by = "  "): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line ? by + line : line))
    .join("\n");
}

export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
