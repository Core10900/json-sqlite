import path from 'node:path';
import { open, type JSONSQLite } from './engine/JSONSQLite.js';
import { create, getVersion, init } from './lifecycle.js';
import { formatDocsPage, formatSchema, formatSqlResult, formatTables } from './cli/format.js';
import {
  ask,
  confirmAlter,
  confirmDropTable,
  withPrompt,
} from './cli/prompt.js';
import type { FieldDef, FieldType } from './types/index.js';

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }

  if (
    argv[0] === '--version' ||
    argv[0] === '-V' ||
    argv[0] === '-v' ||
    argv[0] === 'version'
  ) {
    console.log(getVersion());
    return;
  }

  const [cmd, ...rest] = argv;

  switch (cmd) {
    case 'create': {
      const storagePath = resolvePathOnly(rest);
      const force = rest.includes('--force');
      const result = await create({ storagePath, force });
      console.log(JSON.stringify({ ok: true, action: 'create', ...result }, null, 2));
      return;
    }
    case 'init': {
      const storagePath = resolvePathOnly(rest);
      const result = await init({ storagePath });
      console.log(JSON.stringify({ ok: true, action: 'init', ...result }, null, 2));
      return;
    }
    case 'tables':
    case 'collections': {
      const storagePath = resolveDbPath(rest, './data');
      const db = await open({ storagePath });
      try {
        console.log(formatTables(await db.listTables()));
      } finally {
        await db.close();
      }
      return;
    }
    case 'table': {
      await handleTable(rest);
      return;
    }
    case 'run': {
      await handleRun(rest);
      return;
    }
    case 'doctor':
    case 'query':
    case 'backup':
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
      return;
  }

  const storagePath = resolveDbPath(rest, cmd === 'query' ? './data' : './data');
  const db = await open({ storagePath });
  try {
    switch (cmd) {
      case 'doctor': {
        const h = await db.health();
        console.log(JSON.stringify(h, null, 2));
        process.exitCode = h.status === 'healthy' ? 0 : 1;
        break;
      }
      case 'query': {
        const jsonArg = rest.find((a) => a.trim().startsWith('{')) ?? '{}';
        console.log(JSON.stringify(await db.query(JSON.parse(jsonArg)), null, 2));
        break;
      }
      case 'backup': {
        console.log(JSON.stringify(await db.backupFull(), null, 2));
        break;
      }
    }
  } finally {
    await db.close();
  }
}

async function handleTable(rest: string[]): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  const storagePath = resolveDbPath(args, './data');

  if (!sub || sub === 'list') {
    const db = await open({ storagePath });
    try {
      console.log(formatTables(await db.listTables()));
    } finally {
      await db.close();
    }
    return;
  }

  if (sub === 'create') {
    const nameFlag = flag(args, '--name');
    const fieldFlags = multiFlag(args, '--field');
    if (nameFlag || fieldFlags.length > 0) {
      await nonInteractiveCreateTable(storagePath, nameFlag, fieldFlags);
      return;
    }
    requireTty('table create（对话模式）');
    await interactiveCreateTable(storagePath);
    return;
  }

  if (sub === 'drop') {
    const name = positionalName(args);
    if (!name) {
      console.error(
        '用法: jsonsqlite table drop <name> [--path ./data] [--yes]',
      );
      process.exitCode = 1;
      return;
    }
    const skipConfirm = args.includes('--yes') || args.includes('-y');
    const db = await open({ storagePath });
    try {
      if (!skipConfirm) {
        requireTty('table drop（需二次确认；CI 请加 --yes）');
        const ok = await withPrompt((rl) => confirmDropTable(rl, name));
        if (!ok) {
          console.log('已取消删除');
          return;
        }
      }
      await db.dropTable(name);
      console.log(`已删除表「${name}」`);
    } finally {
      await db.close();
    }
    return;
  }

  if (sub === 'alter') {
    const name = positionalName(args);
    if (!name) {
      console.error('用法: jsonsqlite table alter <name> [--path ./data]');
      process.exitCode = 1;
      return;
    }
    requireTty('table alter（对话模式）');
    await interactiveAlterTable(storagePath, name);
    return;
  }

  if (sub === 'show' || sub === 'data') {
    const name = positionalName(args);
    if (!name) {
      console.error('用法: jsonsqlite table show <name> [--path ./data] [--page 1] [--size 20]');
      process.exitCode = 1;
      return;
    }
    const page = Number(flag(args, '--page') ?? '1') || 1;
    const size = Number(flag(args, '--size') ?? '20') || 20;
    const interactive = args.includes('-i') || args.includes('--interactive');
    const db = await open({ storagePath });
    try {
      await showTableData(db, name, page, size, interactive);
    } finally {
      await db.close();
    }
    return;
  }

  if (sub === 'describe' || sub === 'desc') {
    const name = positionalName(args);
    if (!name) {
      console.error('用法: jsonsqlite table describe <name> [--path ./data]');
      process.exitCode = 1;
      return;
    }
    const db = await open({ storagePath });
    try {
      const info = await db.describeTable(name);
      console.log(formatSchema(info.name, info.fields ?? [], info.documentCount));
    } finally {
      await db.close();
    }
    return;
  }

  console.error(`Unknown table subcommand: ${sub}`);
  printHelp();
  process.exitCode = 1;
}

async function nonInteractiveCreateTable(
  storagePath: string,
  nameFlag: string | undefined,
  fieldFlags: string[],
): Promise<void> {
  if (!nameFlag) {
    console.error(
      '用法: jsonsqlite table create --name <table> [--field name:type]... [--path ./data]',
    );
    process.exitCode = 1;
    return;
  }
  const fields: FieldDef[] = [];
  for (const raw of fieldFlags) {
    const [fname, ftypeRaw = 'any'] = raw.split(':');
    if (!fname) continue;
    const ftype = normalizeFieldType(ftypeRaw.toLowerCase());
    if (!ftype) {
      console.error(`无效字段类型: ${ftypeRaw}`);
      process.exitCode = 1;
      return;
    }
    fields.push({ name: fname, type: ftype });
  }
  const db = await open({ storagePath });
  try {
    const info = await db.createTable(nameFlag, { fields });
    console.log(`✓ 已创建表「${info.name}」`);
  } finally {
    await db.close();
  }
}

async function interactiveCreateTable(storagePath: string): Promise<void> {
  await withPrompt(async (rl) => {
    console.log('—— 新建表（对话模式）——');
    console.log('提示：直接回车结束字段输入；字段类型: string|number|boolean|json|any\n');

    let name = '';
    while (!name) {
      name = await ask(rl, '表名 (字母开头，可含数字/_/-)');
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
        console.log('表名不合法，请重试');
        name = '';
      }
    }

    const fields: FieldDef[] = [];
    for (;;) {
      const fname = await ask(rl, `字段 #${fields.length + 1} 名称（回车结束）`);
      if (!fname) break;
      const ftypeRaw = (await ask(rl, `字段「${fname}」类型`, 'string')).toLowerCase();
      const ftype = normalizeFieldType(ftypeRaw);
      if (!ftype) {
        console.log('类型无效，已跳过该字段');
        continue;
      }
      fields.push({ name: fname, type: ftype });
    }

    console.log('\n即将创建：');
    console.log(`  表名: ${name}`);
    console.log(
      `  字段: ${
        fields.length
          ? fields.map((f) => `${f.name}:${f.type}`).join(', ')
          : '(无 — 纯 schemaless)'
      }`,
    );
    const ok = (await ask(rl, '确认创建？(yes/no)', 'yes')).toLowerCase();
    if (ok !== 'yes' && ok !== 'y') {
      console.log('已取消');
      return;
    }

    const db = await open({ storagePath });
    try {
      const info = await db.createTable(name, { fields });
      console.log(`\n✓ 已创建表「${info.name}」`);
    } finally {
      await db.close();
    }
  });
}

async function interactiveAlterTable(
  storagePath: string,
  name: string,
): Promise<void> {
  await withPrompt(async (rl) => {
    const db = await open({ storagePath });
    try {
      const info = await db.describeTable(name);
      console.log('—— 修改表（对话模式）——');
      console.log(formatSchema(info.name, info.fields ?? [], info.documentCount));
      console.log('\n可选操作：');
      console.log('  1) 重命名表');
      console.log('  2) 添加字段定义');
      console.log('  3) 删除字段定义（仅元数据，不删文档字段）');
      console.log('  0) 取消');
      const choice = await ask(rl, '请选择', '0');

      let summary = '';
      let apply: (() => Promise<void>) | null = null;

      if (choice === '1') {
        const renameTo = await ask(rl, '新表名');
        summary = `重命名: ${name} → ${renameTo}`;
        apply = async () => {
          await db.alterTable(name, { renameTo });
        };
      } else if (choice === '2') {
        const fname = await ask(rl, '新字段名');
        const ftypeRaw = (await ask(rl, '类型', 'string')).toLowerCase();
        const ftype = normalizeFieldType(ftypeRaw);
        if (!ftype) {
          console.log('类型无效，已取消');
          return;
        }
        summary = `添加字段: ${fname}:${ftype}`;
        apply = async () => {
          await db.alterTable(name, {
            addFields: [{ name: fname, type: ftype }],
          });
        };
      } else if (choice === '3') {
        const fname = await ask(rl, '要删除定义的字段名');
        summary = `删除字段定义: ${fname}`;
        apply = async () => {
          await db.alterTable(name, { dropFields: [fname] });
        };
      } else {
        console.log('已取消');
        return;
      }

      const ok = await confirmAlter(rl, summary);
      if (!ok || !apply) {
        console.log('已取消修改');
        return;
      }
      await apply();
      console.log('✓ 修改已应用');
      const finalName =
        choice === '1' ? (summary.split('→')[1]?.trim() ?? name) : name;
      const after = await db.describeTable(finalName);
      console.log(
        formatSchema(after.name, after.fields ?? [], after.documentCount),
      );
    } finally {
      await db.close();
    }
  });
}

async function showTableData(
  db: JSONSQLite,
  name: string,
  page: number,
  size: number,
  interactive: boolean,
): Promise<void> {
  const total = await db.count(name);
  const printPage = async (p: number) => {
    const rows = await db.query({
      collection: name,
      limit: size,
      offset: (p - 1) * size,
    });
    const columns =
      rows.length > 0
        ? [
            ...['_id', '_version'],
            ...Object.keys(rows[0]!).filter(
              (k) => !k.startsWith('_') || k === '_id',
            ),
          ].filter((v, i, a) => a.indexOf(v) === i)
        : ['_id'];
    // prefer user fields first for readability
    const preferred = Object.keys(rows[0] ?? {}).filter((k) => !k.startsWith('_'));
    const cols = preferred.length
      ? ['_id', ...preferred]
      : columns;
    console.log(formatDocsPage(rows, cols, p, size, total));
  };

  await printPage(page);
  if (!interactive) return;

  await withPrompt(async (rl) => {
    let cur = page;
    for (;;) {
      const totalPages = Math.max(1, Math.ceil(total / size));
      const cmd = (
        await ask(rl, '命令 [n]下一页 [p]上一页 [g]跳转 [q]退出', 'q')
      ).toLowerCase();
      if (cmd === 'q' || cmd === 'quit' || cmd === '') break;
      if (cmd === 'n' || cmd === 'next') {
        if (cur < totalPages) {
          cur += 1;
          await printPage(cur);
        } else console.log('已是最后一页');
        continue;
      }
      if (cmd === 'p' || cmd === 'prev') {
        if (cur > 1) {
          cur -= 1;
          await printPage(cur);
        } else console.log('已是第一页');
        continue;
      }
      if (cmd === 'g' || cmd === 'goto') {
        const n = Number(await ask(rl, '页码'));
        if (n >= 1 && n <= totalPages) {
          cur = n;
          await printPage(cur);
        } else console.log('页码无效');
      }
    }
  });
}

async function handleRun(rest: string[]): Promise<void> {
  const sqlParts: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--path') {
      flagArgs.push(a, rest[++i] ?? '');
      continue;
    }
    if (a.startsWith('-')) {
      flagArgs.push(a);
      continue;
    }
    sqlParts.push(a);
  }
  const sql = sqlParts.join(' ').trim();
  if (!sql) {
    console.error('用法: jsonsqlite run "<sql>" [--path ./data]');
    process.exitCode = 1;
    return;
  }
  const storagePath = resolveDbPath(flagArgs, './data');
  const db = await open({ storagePath });
  try {
    const result = await db.run(sql);
    console.log(formatSqlResult(result));
  } finally {
    await db.close();
  }
}

function normalizeFieldType(raw: string): FieldType | null {
  const map: Record<string, FieldType> = {
    string: 'string',
    text: 'string',
    varchar: 'string',
    number: 'number',
    int: 'number',
    integer: 'number',
    float: 'number',
    boolean: 'boolean',
    bool: 'boolean',
    json: 'json',
    any: 'any',
  };
  return map[raw] ?? null;
}

function resolvePathOnly(rest: string[]): string {
  return (
    process.env.JSONSQLITE_PATH ??
    flag(rest, '--path') ??
    rest.find((a) => !a.startsWith('-')) ??
    './data'
  );
}

function resolveDbPath(rest: string[], fallback: string): string {
  const fromFlag = flag(rest, '--path');
  if (fromFlag) return path.resolve(fromFlag);
  if (process.env.JSONSQLITE_PATH) return path.resolve(process.env.JSONSQLITE_PATH);
  return path.resolve(fallback);
}

function positionalName(args: string[]): string | undefined {
  const valueFlags = new Set([
    '--path',
    '--page',
    '--size',
    '--name',
    '--field',
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function multiFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]!);
      i += 1;
    }
  }
  return out;
}

function requireTty(context: string): void {
  if (!process.stdin.isTTY) {
    console.error(
      `错误: ${context} 需要交互式终端。请在 TTY 中运行，或改用非交互参数（如 --name / --yes）。`,
    );
    process.exit(1);
  }
}

function printHelp() {
  console.log(`jsonsqlite — JSONSQLite CLI (v${getVersion()})

Usage:
  jsonsqlite --version | -V | version
  jsonsqlite create [path] [--force]
  jsonsqlite init [path]
  jsonsqlite tables [--path ./data]
  jsonsqlite table create [--path ./data]              # 对话式建表（需 TTY）
  jsonsqlite table create --name t --field a:string [--path]
  jsonsqlite table drop <name> [--path] [--yes]        # 二次确认；CI 用 --yes
  jsonsqlite table alter <name> [--path ./data]        # 对话式修改 + 二次确认（需 TTY）
  jsonsqlite table show <name> [--path] [--page 1] [--size 20] [-i]
  jsonsqlite table describe <name> [--path]
  jsonsqlite run "<sql>" [--path ./data]
  jsonsqlite doctor|query|backup|collections ...
  jsonsqlite help

SQL 示例:
  jsonsqlite run "SHOW TABLES" --path ./data
  jsonsqlite run "SELECT * FROM users WHERE age > 18 LIMIT 10" --path ./data
  jsonsqlite run "INSERT INTO users (name, age) VALUES ('寒', 30)" --path ./data

Env:
  JSONSQLITE_PATH   default storage path

Alias:
  jsql   same as jsonsqlite
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
