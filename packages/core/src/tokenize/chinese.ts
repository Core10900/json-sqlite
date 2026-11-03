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
}

/**
 * Load an optional tokenizer module by its package name. A missing
 * module resolves to available:false. It does not throw.
 */
export async function tryLoadTokenizerModule(spec: string): Promise<LoadedTokenizer> {
  try {
    const importer = new Function(
      'specifier',
      'return import(specifier)',
    ) as (specifier: string) => Promise<Record<string, unknown>>;
    const mod = await importer(spec);
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
      };
    }
    return {
      available: true,
      name: spec,
      reason: null,
      tokenize: candidate as (text: string) => string[],
    };
  } catch {
    // Missing package, bundler resolution failure, or a throw inside the
    // module. Open must continue; tokenization stays unavailable.
    return {
      available: false,
      name: null,
      reason: 'module-not-found',
      tokenize: null,
    };
  }
}
