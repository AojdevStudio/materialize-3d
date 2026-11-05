import { describe, it, expect } from 'bun:test';
import { join } from 'path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(...args: string[]) {
  const proc = Bun.spawnSync(['bun', CLI, ...args]);
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe('cli flags (#187)', () => {
  it('prints usage and exits 0 on --help', () => {
    const { exitCode, stdout, stderr } = runCli('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: bun run cli.ts --input <stl> --output <3mf>');
    expect(stderr).toBe('');
  });

  it('prints usage and one error line, with no stack trace, on an unknown flag', () => {
    const { exitCode, stdout, stderr } = runCli('--bogus');
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Usage: bun run cli.ts --input <stl> --output <3mf>');
    expect(stderr).toContain("--bogus");
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain('TypeError');
  });
});
