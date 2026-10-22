/** CLI exit codes (frozen for 1.5.5 / 1.6 CLI-API). */
export enum ExitCode {
  OK = 0,
  USAGE = 1,
  SYSTEM = 2,
  LOCK = 3,
}

export function setExit(code: ExitCode): void {
  process.exitCode = code;
}
