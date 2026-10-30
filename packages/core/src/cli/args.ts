import path from 'node:path';

export interface GlobalFlags {
  path?: string;
  yes: boolean;
  json: boolean;
  quiet: boolean;
  help: boolean;
  /** Remaining positional + unknown flags after stripping globals. */
  rest: string[];
  raw: string[];
}

const VALUE_FLAGS = new Set([
  '--path',
  '-p',
  '--name',
  '--field',
  '--file',
  '--mode',
  '--page',
  '--size',
  '--data',
  '--set',
  '--where',
  '--id',
  '--collection',
  '--table',
  '--type',
  '--out',
  '--target',
  '--from-key',
  '--to-key',
  '--from-env',
  '--to-env',
  '--limit',
  '--host',
  '--port',
  '--token',
  '--fields',
  '--timeout',
  '--from',
  '--to',
  '--cert',
  '--key',
  '--file',
  '--keep-days',
  '--max-count',
  '--action',
]);

/**
 * Strip global flags; leave command-specific args in `rest`.
 * Globals may appear anywhere.
 */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const rest: string[] = [];
  let pathFlag: string | undefined;
  let yes = false;
  let json = false;
  let quiet = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--path' || a === '-p') {
      pathFlag = argv[++i];
      continue;
    }
    if (a === '--yes' || a === '-y') {
      yes = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--quiet' || a === '-q') {
      quiet = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      help = true;
      continue;
    }
    rest.push(a);
  }

  return { path: pathFlag, yes, json, quiet, help, rest, raw: argv };
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function flagAny(args: string[], names: string[]): string | undefined {
  for (const n of names) {
    const v = flag(args, n);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function hasFlag(args: string[], ...names: string[]): boolean {
  return names.some((n) => args.includes(n));
}

export function multiFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]!);
      i += 1;
    }
  }
  return out;
}

/** First positional that is not a flag or flag-value. */
export function positional(args: string[], skipValueFlags = VALUE_FLAGS): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (skipValueFlags.has(a) || a === '--path' || a === '-p') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

export function positionals(args: string[], skipValueFlags = VALUE_FLAGS): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (skipValueFlags.has(a) || a === '--path' || a === '-p') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

export function resolveStoragePath(
  globals: GlobalFlags,
  args: string[],
  fallback = './data',
): string {
  const fromFlag =
    globals.path ?? flag(args, '--path') ?? flag(args, '-p');
  if (fromFlag) return path.resolve(fromFlag);
  if (process.env.JSONSQLITE_PATH) {
    return path.resolve(process.env.JSONSQLITE_PATH);
  }
  const pos = args.find((a) => !a.startsWith('-'));
  if (pos && !VALUE_FLAGS.has(args[args.indexOf(pos) - 1] ?? '')) {
    // only use bare path for create/init style
  }
  return path.resolve(fallback);
}

export function resolvePathOnly(args: string[], globals: GlobalFlags): string {
  return (
    globals.path ??
    process.env.JSONSQLITE_PATH ??
    flag(args, '--path') ??
    flag(args, '-p') ??
    args.find((a) => !a.startsWith('-')) ??
    './data'
  );
}

export function noColor(): boolean {
  return (
    (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') ||
    process.env.FORCE_COLOR === '0'
  );
}
