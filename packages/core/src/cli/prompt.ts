import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function withPrompt<T>(
  fn: (rl: readline.Interface) => Promise<T>,
): Promise<T> {
  const rl = readline.createInterface({ input, output });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

export async function ask(
  rl: readline.Interface,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix =
    defaultValue !== undefined && defaultValue !== ''
      ? ` [${defaultValue}]`
      : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  if (answer === '' && defaultValue !== undefined) return defaultValue;
  return answer;
}

export async function confirmOnce(
  rl: readline.Interface,
  message: string,
): Promise<boolean> {
  const a = (await ask(rl, `${message} (yes/no)`, 'no')).toLowerCase();
  return a === 'yes' || a === 'y';
}

/** Two-step confirmation for destructive ops. */
export async function confirmTwice(
  rl: readline.Interface,
  firstMessage: string,
  secondMessage: string,
): Promise<boolean> {
  if (!(await confirmOnce(rl, firstMessage))) return false;
  return confirmOnce(rl, secondMessage);
}

export async function confirmDropTable(
  rl: readline.Interface,
  tableName: string,
): Promise<boolean> {
  const first = await confirmOnce(
    rl,
    `确认删除表「${tableName}」？这将永久删除表内全部数据`,
  );
  if (!first) return false;
  const typed = await ask(
    rl,
    `请再次输入表名「${tableName}」以确认删除`,
  );
  return typed === tableName;
}

export async function confirmAlter(
  rl: readline.Interface,
  summary: string,
): Promise<boolean> {
  console.log('\n将应用以下修改：');
  console.log(summary);
  console.log('');
  return confirmTwice(
    rl,
    '确认修改以上内容',
    '再次确认：真的要修改吗',
  );
}
