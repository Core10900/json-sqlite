const STOP = new Set(['的', '了', '是', '在', '和', '有']);

export interface ChineseTokenizer {
  name: string;
  version: string;
  tokenize(text: string): string[];
}

/**
 * Built-in bigram tokenizer for CJK runs. Latin words stay whole.
 * This function is not loaded unless the caller opts in. There is no
 * native dependency.
 */
export function bigramTokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9_]+|[\u3400-\u9fff]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const token = match[0]!;
    if (/[A-Za-z0-9_]/.test(token[0] ?? '')) {
      const word = token.toLowerCase();
      if (!STOP.has(word)) out.push(word);
      continue;
    }
    if (token.length === 1) {
      if (!STOP.has(token)) out.push(token);
      continue;
    }
    for (let i = 0; i < token.length - 1; i++) {
      const gram = token.slice(i, i + 2);
      if (!STOP.has(gram)) out.push(gram);
    }
  }
  return out;
}

function isMissingModuleError(err: unknown): boolean {
  const chunks: string[] = [];
  const pending: unknown[] = [err];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === 'string') {
      chunks.push(current);
      continue;
    }
    if (typeof current !== 'object') continue;
    const record = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (record.code === 'ERR_MODULE_NOT_FOUND' || record.code === 'MODULE_NOT_FOUND') return true;
    if (typeof record.code === 'string') chunks.push(record.code);
    if (typeof record.message === 'string') chunks.push(record.message);
    if (current instanceof Error && current.stack) chunks.push(current.stack);
    if (record.cause) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return /cannot find (module|package)|failed to (resolve|load url|load)|does the file exist|ERR_MODULE_NOT_FOUND|module not found/i.test(
    chunks.join('\n'),
  );
}

export function createBigramTokenizer(): ChineseTokenizer {
  return {
    name: 'bigram',
    version: '1.0.0',
    tokenize: bigramTokenize,
  };
}

export interface LoadedTokenizer {
  available: boolean;
  name: string | null;
  reason: string | null;
  tokenize: ((text: string) => string[]) | null;
  /** True when the module itself threw. A missing package is not a failure. */
  failed: boolean;
}

/**
 * Load an optional tokenizer module by its package name. A missing
 * module resolves to available:false. It does not throw.
 */
async function importSpecifier(spec: string): Promise<Record<string, unknown>> {
  try {
    // Keep the specifier out of the bundler's static import graph.
    const importer = new Function(
      'specifier',
      'return import(specifier)',
    ) as (specifier: string) => Promise<Record<string, unknown>>;
    return await importer(spec);
  } catch (err) {
    // Vitest evaluates `new Function` inside a VM that cannot import.
    // A direct import is rewritten by the test runner and works there.
    // Node never takes this branch.
    if ((err as { code?: string }).code !== 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') throw err;
    return import(spec);
  }
}

export async function tryLoadTokenizerModule(spec: string): Promise<LoadedTokenizer> {
  try {
    const mod = await importSpecifier(spec);
    const candidate =
      (typeof mod.tokenize === 'function' && mod.tokenize) ||
      (mod.default &&
        typeof mod.default === 'object' &&
        mod.default &&
        typeof (mod.default as { tokenize?: unknown }).tokenize === 'function' &&
        (mod.default as { tokenize: (text: string) => string[] }).tokenize) ||
      (typeof mod.default === 'function' && mod.default);
    if (typeof candidate !== 'function') {
      return {
        available: false,
        name: null,
        reason: 'no-tokenize-export',
        tokenize: null,
        failed: true,
      };
    }
    return {
      available: true,
      name: spec,
      reason: null,
      tokenize: candidate as (text: string) => string[],
      failed: false,
    };
  } catch (err) {
    const missing = isMissingModuleError(err);
    // A missing package is not a failure. A module that throws is.
    // Open must continue either way.
    return {
      available: false,
      name: null,
      reason: missing ? 'module-not-found' : 'module-threw',
      tokenize: null,
      failed: !missing,
    };
  }
}
