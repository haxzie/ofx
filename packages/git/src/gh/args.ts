/** Minimal flag parser covering the gh flags this implementation supports. */
export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["--paginate", "--json", "--web", "--draft", "--fill", "-q"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();

  const add = (name: string, value: string): void => {
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }

    // --name=value
    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals !== -1) {
      add(arg.slice(0, equals), arg.slice(equals + 1));
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      add(arg, "true");
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      add(arg, next);
      i += 1;
    } else {
      add(arg, "true");
    }
  }

  return { positional, flags };
}

export function flag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = args.flags.get(name);
    if (values?.length) return values[values.length - 1];
  }
  return undefined;
}

export function flagAll(args: ParsedArgs, ...names: string[]): string[] {
  return names.flatMap((name) => args.flags.get(name) ?? []);
}

export function hasFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => args.flags.has(name));
}
