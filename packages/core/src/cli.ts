import { getVersion } from './lifecycle.js';
import { dispatch } from './cli/commands.js';
import { CliFail, mapErrorToExit } from './cli/output.js';
import { ExitCode, setExit } from './cli/exit.js';
import { helpRoot } from './cli/help.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (
    argv[0] === '--version' ||
    argv[0] === '-V' ||
    argv[0] === '-v'
  ) {
    console.log(getVersion());
    return;
  }

  if (argv.length === 0) {
    console.log(helpRoot());
    return;
  }

  await dispatch(argv);
}

main().catch((err) => {
  if (err instanceof CliFail) {
    setExit(err.exitCode);
    return;
  }
  const code = mapErrorToExit(err);
  setExit(code);
  // Avoid double-printing if already printed as JSON
  if (process.exitCode === undefined || process.exitCode === ExitCode.OK) {
    setExit(code);
  }
  if (!(err instanceof CliFail)) {
    console.error(err instanceof Error ? err.message : err);
  }
});
