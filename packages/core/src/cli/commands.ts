import fs from 'node:fs/promises';
import path from 'node:path';
import { create, init } from '../lifecycle.js';
import { rekeyDatabase, resolveRekeyKeys } from '../ops/rekey.js';
import { ErrorCode } from '../errors.js';
import type { FieldDef, FieldType, FilterCondition, JsonQuery } from '../types/index.js';
import {
  flag,
  flagAny,
  hasFlag,
  multiFlag,
  parseGlobalFlags,
  positional,
  positionals,
  resolvePathOnly,
  type GlobalFlags,
} from './args.js';
import {
  makeContext,
  parseKvPairs,
  parseWhere,
  withDb,
  type CliContext,
} from './context.js';
import { ExitCode, setExit } from './exit.js';
import {
  helpFor,
  helpIndex,
  helpInsert,
  helpRoot,
  helpTableCreate,
  helpUpdate,
  helpDelete,
} from './help.js';
import { fail, printData, printSuccess, requireTty } from './output.js';
import { formatDocsPage, formatSchema, formatSqlResult, formatTables } from './format.js';
import { ask, confirmAlter, confirmDropTable, withPrompt } from './prompt.js';

export async function dispatch(argv: string[]): Promise<void> {
  const globals = parseGlobalFlags(argv);
  const [cmd, ...rest] = globals.rest;

  if (!cmd || cmd === 'help') {
    const sub = rest.filter((a) => !a.startsWith('-'));
    const text = helpFor(sub) ?? helpRoot();
    console.log(text);
    setExit(ExitCode.OK);
    return;
  }

  if (cmd === 'version') {
    const { getVersion } = await import('../lifecycle.js');
    console.log(getVersion());
    return;
  }

  // Nested help: `table --help` or `table create --help`
  if (globals.help || rest.includes('--help') || rest.includes('-h')) {
    const pathSegs = [cmd, ...rest.filter((a) => !a.startsWith('-'))].slice(0, 2);
    const text = helpFor(pathSegs) ?? helpFor([cmd]) ?? helpRoot();
    console.log(text);
    setExit(ExitCode.OK);
    return;
  }

  const ctx = makeContext(globals, rest);

  switch (cmd) {
    case 'create':
      return cmdCreate(ctx, rest, globals);
    case 'init':
      return cmdInit(ctx, rest, globals);
    case 'tables':
    case 'collections':
      return cmdTables(ctx);
    case 'table':
      return cmdTable(ctx, rest, globals);
    case 'run':
      return cmdRun(ctx, rest);
    case 'sql':
      return cmdSqlRepl(ctx);
    case 'insert':
      return cmdInsert(ctx, rest);
    case 'update':
      return cmdUpdate(ctx, rest, globals);
    case 'delete':
      return cmdDelete(ctx, rest, globals);
    case 'get':
      return cmdGet(ctx, rest);
    case 'count':
      return cmdCount(ctx, rest);
    case 'index':
      return cmdIndex(ctx, rest);
    case 'stats':
      return cmdStats(ctx, rest);
    case 'explain':
      return cmdExplain(ctx, rest);
    case 'query':
      return cmdQuery(ctx, rest);
    case 'backup':
      return cmdBackup(ctx);
    case 'vacuum':
      return cmdVacuum(ctx, rest, globals);
    case 'rekey':
      return cmdRekey(ctx, rest, globals);
    case 'doctor':
      return cmdDoctor(ctx, rest);
    default:
      fail(
        ctx.out,
        `Unknown command: ${cmd}`,
        'USAGE',
        ExitCode.USAGE,
        '运行 jsonsqlite help 查看可用命令',
      );
  }
}

async function cmdCreate(ctx: CliContext, rest: string[], g: GlobalFlags): Promise<void> {
  const storagePath = path.resolve(resolvePathOnly(rest, g));
  const force = hasFlag(rest, '--force');
  const result = await create({ storagePath, force });
  printSuccess(ctx.out, `✓ created ${result.storagePath}`, {
    action: 'create',
    ...result,
  });
}

async function cmdInit(ctx: CliContext, rest: string[], g: GlobalFlags): Promise<void> {
  const storagePath = path.resolve(resolvePathOnly(rest, g));
  const result = await init({ storagePath });
  printSuccess(ctx.out, `✓ initialized ${result.storagePath}`, {
    action: 'init',
    ...result,
  });
}

async function cmdTables(ctx: CliContext): Promise<void> {
  await withDb(ctx, async (db) => {
    const tables = await db.listTables();
    printData(ctx.out, formatTables(tables), {
      action: 'tables',
      tables: tables.map((t) => ({
        name: t.name,
        documents: t.documentCount,
        fields: t.fields ?? [],
      })),
    });
  });
}

async function cmdTable(
  ctx: CliContext,
  rest: string[],
  g: GlobalFlags,
): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  if (!sub || sub === 'list') {
    return cmdTables(ctx);
  }
  if (sub === 'create') {
    if (args.includes('--help') || args.includes('-h')) {
      console.log(helpTableCreate());
      return;
    }
    const nameFlag = flag(args, '--name');
    const fieldFlags = multiFlag(args, '--field');
    if (nameFlag || fieldFlags.length) {
      return nonInteractiveCreate(ctx, nameFlag, fieldFlags);
    }
    requireTty(
      ctx.out,
      'table create（对话模式）',
      '改用: jsonsqlite table create --name <t> --field name:type -p ./data',
    );
    return interactiveCreate(ctx);
  }
  if (sub === 'drop') {
    const name = positional(args);
    if (!name) {
      fail(ctx.out, '用法: jsonsqlite table drop <name> [--yes]', 'USAGE');
    }
    const skip = g.yes || hasFlag(args, '--yes', '-y');
    await withDb(ctx, async (db) => {
      if (!skip) {
        requireTty(
          ctx.out,
          'table drop',
          'CI 请加 --yes：jsonsqlite table drop <name> --yes',
        );
        const ok = await withPrompt((rl) => confirmDropTable(rl, name));
        if (!ok) {
          printSuccess(ctx.out, '已取消删除', { action: 'drop', cancelled: true });
          return;
        }
      }
      await db.dropTable(name);
      printSuccess(ctx.out, `已删除表「${name}」`, { action: 'drop', table: name });
    });
    return;
  }
  if (sub === 'alter') {
    const name = positional(args);
    if (!name) fail(ctx.out, '用法: jsonsqlite table alter <name>', 'USAGE');
    requireTty(ctx.out, 'table alter', '目前仅支持对话模式');
    return interactiveAlter(ctx, name);
  }
  if (sub === 'show' || sub === 'data') {
    return cmdTableShow(ctx, args);
  }
  if (sub === 'describe' || sub === 'desc') {
    const name = positional(args);
    if (!name) fail(ctx.out, '用法: jsonsqlite table describe <name>', 'USAGE');
    await withDb(ctx, async (db) => {
      const info = await db.describeTable(name);
      printData(
        ctx.out,
        formatSchema(info.name, info.fields ?? [], info.documentCount),
        {
          action: 'describe',
          table: info.name,
          fields: info.fields ?? [],
          documentCount: info.documentCount,
        },
      );
    });
    return;
  }
  if (sub === 'export') {
    const name = positional(args);
    const file = flag(args, '--file');
    if (!name || !file) {
      fail(
        ctx.out,
        '用法: jsonsqlite table export <name> --file <out.jsonl>',
        'USAGE',
      );
    }
    await withDb(ctx, async (db) => {
      const docs = await db.exportCollection(name);
      const body = docs.map((d) => JSON.stringify(d)).join('\n');
      await fs.writeFile(file, body ? `${body}\n` : '', 'utf8');
      printSuccess(ctx.out, `✓ exported ${docs.length} docs → ${file}`, {
        action: 'export',
        table: name,
        file,
        count: docs.length,
      });
    });
    return;
  }
  if (sub === 'import') {
    const name = positional(args);
    const file = flag(args, '--file');
    const modeRaw = flag(args, '--mode') ?? 'append';
    if (!name || !file) {
      fail(
        ctx.out,
        '用法: jsonsqlite table import <name> --file <in.jsonl> [--mode append|replace]',
        'USAGE',
      );
    }
    if (modeRaw !== 'append' && modeRaw !== 'replace') {
      fail(ctx.out, '--mode must be append or replace', 'USAGE');
    }
    const raw = await fs.readFile(file, 'utf8');
    const docs: Record<string, unknown>[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      docs.push(JSON.parse(line) as Record<string, unknown>);
    }
    await withDb(ctx, async (db) => {
      const result = await db.importCollection(name, docs, { mode: modeRaw });
      printSuccess(
        ctx.out,
        `✓ imported ${result.imported} docs (${modeRaw}) ← ${file}`,
        { action: 'import', table: name, file, ...result, mode: modeRaw },
      );
    });
    return;
  }
  fail(
    ctx.out,
    `Unknown table subcommand: ${sub}`,
    'USAGE',
    ExitCode.USAGE,
    '见 jsonsqlite table --help',
  );
}

async function nonInteractiveCreate(
  ctx: CliContext,
  nameFlag: string | undefined,
  fieldFlags: string[],
): Promise<void> {
  if (!nameFlag) {
    fail(
      ctx.out,
      '用法: jsonsqlite table create --name <table> [--field name:type]...',
      'USAGE',
    );
  }
  const fields: FieldDef[] = [];
  for (const raw of fieldFlags) {
    const [fname, ftypeRaw = 'any'] = raw.split(':');
    if (!fname) continue;
    const ftype = normalizeFieldType(ftypeRaw.toLowerCase());
    if (!ftype) fail(ctx.out, `无效字段类型: ${ftypeRaw}`, 'USAGE');
    fields.push({ name: fname, type: ftype });
  }
  await withDb(ctx, async (db) => {
    const info = await db.createTable(nameFlag, { fields });
    printSuccess(ctx.out, `✓ 已创建表「${info.name}」`, {
      action: 'createTable',
      table: info.name,
      fields: info.fields ?? [],
    });
  });
}

async function interactiveCreate(ctx: CliContext): Promise<void> {
  await withPrompt(async (rl) => {
    console.log('—— 新建表（对话模式）——');
    console.log('提示：直接回车结束字段输入；ctrl+c 取消\n');
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
        console.log('类型无效，已跳过');
        continue;
      }
      fields.push({ name: fname, type: ftype });
    }
    console.log('\n—— 预览 ——');
    console.log(
      `  ${name} (${fields.map((f) => `${f.name}:${f.type}`).join(', ') || 'schemaless'})`,
    );
    const ok = (await ask(rl, '确认创建？[Y/n]', 'Y')).toLowerCase();
    if (ok === 'n' || ok === 'no') {
      console.log('已取消');
      return;
    }
    await withDb(ctx, async (db) => {
      const info = await db.createTable(name, { fields });
      printSuccess(ctx.out, `✓ 已创建表「${info.name}」`, {
        action: 'createTable',
        table: info.name,
      });
    });
  });
}

async function interactiveAlter(ctx: CliContext, name: string): Promise<void> {
  await withPrompt(async (rl) => {
    await withDb(ctx, async (db) => {
      const info = await db.describeTable(name);
      console.log('—— 修改表 ——');
      console.log(formatSchema(info.name, info.fields ?? [], info.documentCount));
      console.log('\n1) 重命名  2) 添加字段  3) 删除字段定义  0) 取消');
      const choice = await ask(rl, '请选择', '0');
      let summary = '';
      let apply: (() => Promise<void>) | null = null;
      let finalName = name;
      if (choice === '1') {
        const renameTo = await ask(rl, '新表名');
        summary = `重命名: ${name} → ${renameTo}`;
        finalName = renameTo;
        apply = async () => {
          await db.alterTable(name, { renameTo });
        };
      } else if (choice === '2') {
        const fname = await ask(rl, '新字段名');
        const ftype = normalizeFieldType(
          (await ask(rl, '类型', 'string')).toLowerCase(),
        );
        if (!ftype) {
          console.log('类型无效');
          return;
        }
        summary = `添加字段: ${fname}:${ftype}`;
        apply = async () => {
          await db.alterTable(name, { addFields: [{ name: fname, type: ftype }] });
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
      const after = await db.describeTable(finalName);
      printSuccess(ctx.out, '✓ 修改已应用', { action: 'alter', table: after.name });
      console.log(formatSchema(after.name, after.fields ?? [], after.documentCount));
    });
  });
}

async function cmdTableShow(ctx: CliContext, args: string[]): Promise<void> {
  const name = positional(args);
  if (!name) fail(ctx.out, '用法: jsonsqlite table show <name>', 'USAGE');
  const page = Number(flag(args, '--page') ?? '1') || 1;
  const size = Number(flag(args, '--size') ?? '20') || 20;
  const interactive = hasFlag(args, '-i', '--interactive');
  await withDb(ctx, async (db) => {
    const total = await db.count(name);
    if (total === 0 && !ctx.out.json) {
      console.log(`(表「${name}」为空)`);
    }
    const rows = await db.query({
      collection: name,
      limit: size,
      offset: (page - 1) * size,
    });
    const preferred = Object.keys(rows[0] ?? {}).filter((k) => !k.startsWith('_'));
    const cols = preferred.length ? ['_id', ...preferred] : ['_id'];
    printData(ctx.out, formatDocsPage(rows, cols, page, size, total), {
      action: 'show',
      table: name,
      page,
      size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      rows,
    });
    if (interactive) {
      requireTty(ctx.out, 'table show -i', '去掉 -i 使用 --page/--size');
      await withPrompt(async (rl) => {
        let cur = page;
        for (;;) {
          const totalPages = Math.max(1, Math.ceil(total / size));
          const cmd = (
            await ask(rl, '命令 [n]下一页 [p]上一页 [g]跳转 [q]退出', 'q')
          ).toLowerCase();
          if (cmd === 'q' || cmd === 'quit' || cmd === '') break;
          if (cmd === 'n' && cur < totalPages) cur += 1;
          else if (cmd === 'p' && cur > 1) cur -= 1;
          else if (cmd === 'g') {
            const n = Number(await ask(rl, '页码'));
            if (n >= 1 && n <= totalPages) cur = n;
            else {
              console.log('页码无效');
              continue;
            }
          } else continue;
          const pageRows = await db.query({
            collection: name,
            limit: size,
            offset: (cur - 1) * size,
          });
          console.log(formatDocsPage(pageRows, cols, cur, size, total));
        }
      });
    }
  });
}

async function cmdRun(ctx: CliContext, rest: string[]): Promise<void> {
  const sqlParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--path' || a === '-p' || a === '--limit') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    sqlParts.push(a);
  }
  const sql = sqlParts.join(' ').trim();
  if (!sql) fail(ctx.out, '用法: jsonsqlite run "<sql>"', 'USAGE');
  if (sql.includes(';') && sql.replace(/;+\s*$/, '').includes(';')) {
    fail(
      ctx.out,
      'run 仅支持单条 SQL（不要用分号串联多语句）',
      'SQL_UNSUPPORTED',
    );
  }
  const limitOverride = flag(rest, '--limit');
  await withDb(ctx, async (db) => {
    let execSql = sql;
    if (limitOverride && /^\s*SELECT/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
      execSql = `${sql.replace(/;+\s*$/, '')} LIMIT ${Number(limitOverride)}`;
    }
    const result = await db.run(execSql);
    if (
      result.type === 'rows' &&
      (result.total ?? result.rowCount) > 1000 &&
      !limitOverride &&
      !ctx.out.json
    ) {
      console.error(
        `警告: 结果集较大 (total=${result.total ?? result.rowCount})，建议加 LIMIT 或 --limit`,
      );
    }
    printData(ctx.out, formatSqlResult(result), { action: 'run', result });
  });
}

async function cmdSqlRepl(ctx: CliContext): Promise<void> {
  requireTty(
    ctx.out,
    'sql REPL',
    '非交互请用: jsonsqlite run "<sql>" -p ./data',
  );
  await withDb(ctx, async (db) => {
    await withPrompt(async (rl) => {
      console.log('jsonsqlite sql — 输入 SQL；.tables / .schema [t] / .quit');
      for (;;) {
        const line = (await ask(rl, 'sql>')).trim();
        if (!line) continue;
        if (line === '.quit' || line === '.exit') break;
        if (line === '.tables') {
          console.log(formatTables(await db.listTables()));
          continue;
        }
        if (line.startsWith('.schema')) {
          const t = line.slice(7).trim();
          if (!t) {
            for (const info of await db.listTables()) {
              console.log(
                formatSchema(info.name, info.fields ?? [], info.documentCount),
              );
            }
          } else {
            const info = await db.describeTable(t);
            console.log(
              formatSchema(info.name, info.fields ?? [], info.documentCount),
            );
          }
          continue;
        }
        try {
          console.log(formatSqlResult(await db.run(line)));
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
        }
      }
    });
  });
}

async function cmdInsert(ctx: CliContext, rest: string[]): Promise<void> {
  if (hasFlag(rest, '--help', '-h')) {
    console.log(helpInsert());
    return;
  }
  const table = positional(rest);
  if (!table) fail(ctx.out, '用法: jsonsqlite insert <table> --data|\'--field\'|--file', 'USAGE');
  const dataRaw = flag(rest, '--data');
  const file = flag(rest, '--file');
  const fields = multiFlag(rest, '--field');
  let docs: Record<string, unknown>[] = [];
  if (file) {
    const raw = await fs.readFile(file, 'utf8');
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      docs = JSON.parse(trimmed) as Record<string, unknown>[];
    } else {
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        docs.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  } else if (dataRaw) {
    const parsed = JSON.parse(dataRaw) as
      | Record<string, unknown>
      | Record<string, unknown>[];
    docs = Array.isArray(parsed) ? parsed : [parsed];
  } else if (fields.length) {
    docs = [parseKvPairs(fields)];
  } else {
    fail(ctx.out, '需要 --data、--field 或 --file', 'USAGE', ExitCode.USAGE, helpInsert());
  }
  await withDb(ctx, async (db) => {
    const inserted = await db.insert(table, docs.length === 1 ? docs[0]! : docs);
    const list = Array.isArray(inserted) ? inserted : [inserted];
    printSuccess(ctx.out, `✓ inserted ${list.length} row(s)`, {
      action: 'insert',
      table,
      ids: list.map((d) => d._id),
      count: list.length,
    });
  });
}

async function cmdUpdate(
  ctx: CliContext,
  rest: string[],
  g: GlobalFlags,
): Promise<void> {
  if (hasFlag(rest, '--help', '-h')) {
    console.log(helpUpdate());
    return;
  }
  const table = positional(rest);
  const id = flag(rest, '--id');
  const sets = multiFlag(rest, '--set');
  const whereRaw = flag(rest, '--where');
  if (!table || sets.length === 0) {
    fail(ctx.out, '用法: jsonsqlite update <table> --set k=v ... (--id|--where)', 'USAGE');
  }
  const patch = parseKvPairs(sets);
  if (!id && !whereRaw && !(g.yes || hasFlag(rest, '--yes', '-y'))) {
    fail(
      ctx.out,
      'update 无 --id/--where 时必须 --yes（将更新全表）',
      'USAGE',
    );
  }
  await withDb(ctx, async (db) => {
    let changes = 0;
    if (id) {
      await db.update(table, id, patch);
      changes = 1;
    } else {
      const filter = parseWhere(whereRaw) as FilterCondition | undefined;
      const rows = await db.query({ collection: table, filter });
      for (const row of rows) {
        await db.update(table, row._id, patch);
        changes += 1;
      }
    }
    printSuccess(ctx.out, `✓ updated ${changes} row(s)`, {
      action: 'update',
      table,
      changes,
    });
  });
}

async function cmdDelete(
  ctx: CliContext,
  rest: string[],
  g: GlobalFlags,
): Promise<void> {
  if (hasFlag(rest, '--help', '-h')) {
    console.log(helpDelete());
    return;
  }
  const table = positional(rest);
  const id = flag(rest, '--id');
  const whereRaw = flag(rest, '--where');
  const yes = g.yes || hasFlag(rest, '--yes', '-y');
  if (!table || (!id && !whereRaw)) {
    fail(ctx.out, '用法: jsonsqlite delete <table> --id <id> | --where \'{...}\' [--yes]', 'USAGE');
  }
  if (!yes && !process.stdin.isTTY) {
    fail(ctx.out, '非 TTY 删除需要 --yes', 'USAGE');
  }
  await withDb(ctx, async (db) => {
    if (!yes && process.stdin.isTTY) {
      const ok = await withPrompt(async (rl) => {
        const a = (await ask(rl, `确认删除 ${table} 中匹配行？(yes/no)`, 'no')).toLowerCase();
        return a === 'yes' || a === 'y';
      });
      if (!ok) {
        printSuccess(ctx.out, '已取消', { action: 'delete', cancelled: true });
        return;
      }
    }
    let changes = 0;
    if (id) {
      if (await db.delete(table, id)) changes = 1;
    } else {
      const filter = parseWhere(whereRaw) as FilterCondition | undefined;
      const rows = await db.query({ collection: table, filter });
      for (const row of rows) {
        if (await db.delete(table, row._id)) changes += 1;
      }
    }
    printSuccess(ctx.out, `✓ deleted ${changes} row(s)`, {
      action: 'delete',
      table,
      changes,
    });
  });
}

async function cmdGet(ctx: CliContext, rest: string[]): Promise<void> {
  const table = positional(rest);
  const id = flag(rest, '--id');
  if (!table || !id) fail(ctx.out, '用法: jsonsqlite get <table> --id <id>', 'USAGE');
  await withDb(ctx, async (db) => {
    const doc = await db.findById(table, id);
    if (!doc) {
      fail(ctx.out, `Document not found: ${id}`, ErrorCode.DOCUMENT_NOT_FOUND);
    }
    printData(ctx.out, JSON.stringify(doc, null, 2), {
      action: 'get',
      table,
      doc,
    });
  });
}

async function cmdCount(ctx: CliContext, rest: string[]): Promise<void> {
  const table = positional(rest);
  if (!table) fail(ctx.out, '用法: jsonsqlite count <table> [--where \'{...}\']', 'USAGE');
  const whereRaw = flag(rest, '--where');
  await withDb(ctx, async (db) => {
    const filter = parseWhere(whereRaw) as FilterCondition | undefined;
    const n = await db.count(table, filter);
    printData(ctx.out, String(n), { action: 'count', table, count: n });
  });
}

async function cmdIndex(ctx: CliContext, rest: string[]): Promise<void> {
  if (hasFlag(rest, '--help', '-h') || !rest[0]) {
    console.log(helpIndex());
    if (!rest[0]) setExit(ExitCode.USAGE);
    return;
  }
  const sub = rest[0]!;
  const args = rest.slice(1);
  await withDb(ctx, async (db) => {
    if (sub === 'list') {
      const indexes = await db.listIndexes();
      const human =
        indexes.length === 0
          ? '(没有索引)'
          : indexes
              .map((i) => `${i.collection}.${i.field} (${i.type})`)
              .join('\n');
      printData(ctx.out, human, { action: 'index.list', indexes });
      return;
    }
    if (sub === 'create') {
      const [table, field] = positionals(args);
      const type = (flag(args, '--type') ?? 'object') as 'object' | 'tree' | 'inverted';
      if (!table || !field) {
        fail(ctx.out, '用法: jsonsqlite index create <table> <field> [--type object|tree|inverted]', 'USAGE');
      }
      const meta = await db.createIndex(table, field, type);
      printSuccess(ctx.out, `✓ index ${meta.collection}.${meta.field} (${meta.type})`, {
        action: 'index.create',
        index: meta,
      });
      return;
    }
    if (sub === 'drop') {
      const [table, field] = positionals(args);
      if (!table || !field) {
        fail(ctx.out, '用法: jsonsqlite index drop <table> <field>', 'USAGE');
      }
      await db.dropIndex(table, field);
      printSuccess(ctx.out, `✓ dropped index ${table}.${field}`, {
        action: 'index.drop',
        table,
        field,
      });
      return;
    }
    fail(ctx.out, `Unknown index subcommand: ${sub}`, 'USAGE', ExitCode.USAGE, helpIndex());
  });
}

async function cmdStats(ctx: CliContext, rest: string[]): Promise<void> {
  const table = flagAny(rest, ['--table', '--collection']) ?? positional(rest);
  await withDb(ctx, async (db) => {
    const tables = await db.listTables();
    const indexes = await db.listIndexes();
    const perTable: Record<string, { documents: number; indexes: number }> = {};
    let documents = 0;
    for (const t of tables) {
      if (table && t.name !== table) continue;
      const idxCount = indexes.filter((i) => i.collection === t.name).length;
      perTable[t.name] = { documents: t.documentCount, indexes: idxCount };
      documents += t.documentCount;
    }
    let sizeEstimate = 0;
    try {
      sizeEstimate = await dirSize(ctx.storagePath);
    } catch {
      /* ignore */
    }
    const payload = {
      action: 'stats',
      tables: Object.keys(perTable).length,
      documents,
      indexes: indexes.length,
      sizeBytes: sizeEstimate,
      perTable,
    };
    const human = [
      `tables=${payload.tables}  documents=${documents}  indexes=${payload.indexes}`,
      `size≈${sizeEstimate} bytes  path=${ctx.storagePath}`,
      ...Object.entries(perTable).map(
        ([n, v]) => `  ${n}: docs=${v.documents} indexes=${v.indexes}`,
      ),
    ].join('\n');
    printData(ctx.out, human, payload);
  });
}

async function cmdExplain(ctx: CliContext, rest: string[]): Promise<void> {
  const text = rest.filter((a) => !a.startsWith('-')).join(' ').trim();
  if (!text) {
    fail(ctx.out, '用法: jsonsqlite explain "<sql|json-query>"', 'USAGE');
  }
  await withDb(ctx, async (db) => {
    let query: JsonQuery;
    if (text.trim().startsWith('{')) {
      query = JSON.parse(text) as JsonQuery;
    } else {
      // Compile SELECT to JsonQuery via run path: parse only
      const { parseSql } = await import('../sql/parse.js');
      const stmt = parseSql(text);
      if (stmt.kind !== 'select' || stmt.join || stmt.aggregate) {
        fail(
          ctx.out,
          'explain 目前支持单表 SELECT 或 JSON JsonQuery',
          'SQL_UNSUPPORTED',
        );
      }
      query = {
        collection: stmt.table,
        filter: stmt.filter,
        orderBy: stmt.orderBy,
        limit: stmt.limit,
        offset: stmt.offset,
        projection: stmt.columns === '*' ? undefined : stmt.columns,
      };
    }
    const advice = db.advise(query);
    const indexes = (await db.listIndexes()).filter(
      (i) => i.collection === query.collection,
    );
    const human = [
      `collection: ${query.collection}`,
      `indexes: ${indexes.map((i) => `${i.field}(${i.type})`).join(', ') || '(none)'}`,
      ...advice.map((a) => `- [${a.type}] ${a.message}`),
    ].join('\n');
    printData(ctx.out, human, {
      action: 'explain',
      collection: query.collection,
      query,
      indexes,
      advice,
    });
  });
}

async function cmdQuery(ctx: CliContext, rest: string[]): Promise<void> {
  const jsonArg = rest.find((a) => a.trim().startsWith('{')) ?? '{}';
  await withDb(ctx, async (db) => {
    const rows = await db.query(JSON.parse(jsonArg));
    printData(ctx.out, JSON.stringify(rows, null, 2), { action: 'query', rows });
  });
}

async function cmdBackup(ctx: CliContext): Promise<void> {
  await withDb(ctx, async (db) => {
    const info = await db.backupFull();
    printSuccess(ctx.out, `✓ backup ${info.file}`, { action: 'backup', ...info });
  });
}

async function cmdVacuum(
  ctx: CliContext,
  rest: string[],
  g: GlobalFlags,
): Promise<void> {
  const collection = flagAny(rest, ['--collection', '--table']);
  // vacuum is safe rewrite; --yes optional for future destructive modes
  void g;
  await withDb(ctx, async (db) => {
    const result = await db.vacuum(collection ? { collection } : undefined);
    printSuccess(ctx.out, `✓ vacuum ${result.collections.join(', ')}`, {
      action: 'vacuum',
      ...result,
    });
  });
}

async function cmdRekey(
  ctx: CliContext,
  rest: string[],
  g: GlobalFlags,
): Promise<void> {
  const targetPath = flagAny(rest, ['--out', '--target']);
  const inPlace = hasFlag(rest, '--in-place', '--inplace');
  const yes = g.yes || hasFlag(rest, '--yes', '-y');
  let keys;
  try {
    keys = resolveRekeyKeys({
      fromKey: flag(rest, '--from-key'),
      toKey: flag(rest, '--to-key'),
      fromEnv: flag(rest, '--from-env'),
      toEnv: flag(rest, '--to-env'),
    });
  } catch (err) {
    fail(ctx.out, err instanceof Error ? err.message : String(err), 'USAGE');
  }
  if (!inPlace && !targetPath) {
    fail(
      ctx.out,
      '需要 --out <dir> 或 --in-place --yes',
      'USAGE',
      ExitCode.USAGE,
      'jsonsqlite rekey --out ./data-v2 --to-key NEW [--from-key OLD]',
    );
  }
  const result = await rekeyDatabase({
    storagePath: ctx.storagePath,
    fromKey: keys.fromKey,
    toKey: keys.toKey,
    targetPath,
    inPlace,
    yes,
  });
  printSuccess(ctx.out, `✓ rekey → ${result.storagePath} (${result.mode})`, {
    action: 'rekey',
    ...result,
  });
}

async function cmdDoctor(ctx: CliContext, rest: string[]): Promise<void> {
  const deep = hasFlag(rest, '--deep');
  await withDb(ctx, async (db) => {
    if (deep) {
      const report = await db.doctor({ deep: true });
      printData(ctx.out, JSON.stringify(report, null, 2), {
        action: 'doctor',
        ...report,
      });
      if (report.status !== 'healthy') setExit(ExitCode.USAGE);
    } else {
      const h = await db.health();
      printData(ctx.out, JSON.stringify(h, null, 2), { action: 'doctor', ...h });
      if (h.status !== 'healthy') setExit(ExitCode.USAGE);
    }
  });
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

async function dirSize(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += (await fs.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root);
  return total;
}

void parseGlobalFlags;
void helpRoot;
