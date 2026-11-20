// jcode.test.ts — the delegated jcode host: status detection, install/uninstall delegation, and the surfaces that report it.
// Everything runs against a fake `jcode` executable and temp homes; the real CLI and config are never touched.
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST_CAPS } from '../../extensions/shared/host-caps.ts';
import { jcodeTersioState } from '../../extensions/shared/jcode-state.ts';
import { cliEnv, fakeExecutable, isWindows } from '../helpers/env.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = path.join(root, 'dist', 'tersio.js');

const ALL_TRUE = {
  guidance_enabled: true,
  rtk_transform_wired: true,
  usage_ledger_wired: true,
  mcp_wired: true,
};

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tersio-jcode-'));
}

/** A fake `jcode` on PATH whose `tersio status --json` prints `body`; args it saw land in the log file. */
function fakeJcode(binDir: string, body: string, opts: { exit?: number } = {}): string {
  const log = path.join(binDir, 'jcode-args.log');
  const escaped = body.replaceAll('"', '\\"');
  const posix = [
    `echo "$*" >> "${log}"`,
    opts.exit !== undefined && opts.exit !== 0 ? `echo "$1 $2 $3" >> "${log}"` : '',
    opts.exit !== undefined && opts.exit !== 0 ? `exit ${opts.exit}` : `printf '%s\\n' "${escaped}"`,
  ]
    .filter(Boolean)
    .join('\n');
  fakeExecutable(binDir, isWindows() ? 'jcode.exe' : 'jcode', posix, posix.replaceAll('\n', '\r\n'));
  return log;
}

function withPath(home: string, binDir: string): NodeJS.ProcessEnv {
  return cliEnv(home, { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` });
}

function run(env: NodeJS.ProcessEnv, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [installer, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  return { status: result.status ?? -1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

describe('jcode host registration', () => {
  test('HOST_CAPS carries the delegated jcode contract', () => {
    const cap = HOST_CAPS.jcode;
    expect(cap.label).toBe('Jcode');
    expect(cap.bin).toBe('jcode');
    expect(cap.installCmd).toBe('jcode tersio install');
    expect(cap.removeCmd).toBe('jcode tersio uninstall');
    expect(cap.mcp).toBeNull();
    expect(cap.mcpFile()).toBeNull();
    expect(cap.rtkAgent).toBeNull();
    expect(cap.headroom).toBe(false);
  });
});

describe('jcode status detection', () => {
  test('a valid status payload reads as installed with the four wiring booleans', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    fakeJcode(binDir, JSON.stringify(ALL_TRUE));
    const env = withPath(home, binDir);
    try {
      const state = jcodeTersioState(env);
      expect(state).not.toBeNull();
      expect(state?.wiring).toEqual({
        guidanceEnabled: true,
        rtkTransformWired: true,
        usageLedgerWired: true,
        mcpWired: true,
      });
      // detectHosts() reads the test process's env, so the installed jcode row is asserted in a
      // spawned child carrying the fixture PATH/HOME instead; see JCODE_DETECT_PROBE below.
      const entry = spawnSync(process.execPath, ['-e', JCODE_DETECT_PROBE], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env,
      });
      const parsed = JSON.parse(entry.stdout) as { installed: boolean; wiring: Record<string, boolean> | null };
      expect(parsed.installed).toBe(true);
      expect(parsed.wiring).toEqual({
        guidanceEnabled: true,
        rtkTransformWired: true,
        usageLedgerWired: true,
        mcpWired: true,
      });
    } finally {
      cleanup(home);
    }
  });

  test('disabled and unwired flags pass through as false', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    fakeJcode(
      binDir,
      JSON.stringify({
        guidance_enabled: false,
        rtk_transform_wired: false,
        usage_ledger_wired: false,
        mcp_wired: false,
      }),
    );
    const env = withPath(home, binDir);
    try {
      expect(jcodeTersioState(env)?.wiring).toEqual({
        guidanceEnabled: false,
        rtkTransformWired: false,
        usageLedgerWired: false,
        mcpWired: false,
      });
    } finally {
      cleanup(home);
    }
  });

  test('a missing binary reads as not installed', () => {
    const home = tempHome();
    const env = cliEnv(home, { PATH: path.join(home, 'empty-bin') });
    try {
      expect(jcodeTersioState(env)).toBeNull();
    } finally {
      cleanup(home);
    }
  });

  test('malformed JSON reads as not installed', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    fakeJcode(binDir, 'not json at all');
    const env = withPath(home, binDir);
    try {
      expect(jcodeTersioState(env)).toBeNull();
    } finally {
      cleanup(home);
    }
  });

  test('a nonzero status exit reads as not installed', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    fakeJcode(binDir, JSON.stringify(ALL_TRUE), { exit: 3 });
    const env = withPath(home, binDir);
    try {
      expect(jcodeTersioState(env)).toBeNull();
    } finally {
      cleanup(home);
    }
  });

  test('a payload missing an expected boolean reads as not installed', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    fakeJcode(binDir, JSON.stringify({ guidance_enabled: true, rtk_transform_wired: true, usage_ledger_wired: true }));
    const env = withPath(home, binDir);
    try {
      expect(jcodeTersioState(env)).toBeNull();
    } finally {
      cleanup(home);
    }
  });
});

describe('jcode install delegation', () => {
  test('install --host jcode --dry-run delegates to jcode tersio install --dry-run', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    const log = fakeJcode(binDir, JSON.stringify(ALL_TRUE));
    const tersioSettings = path.join(home, '.tersio', 'settings.json');
    try {
      const result = run(withPath(home, binDir), 'install', '--host', 'jcode', '--dry-run', '--yes');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/jcode tersio install --dry-run/);
      expect(result.stdout).toMatch(/Dry run — nothing was written/);
      const seen = readFileSync(log, 'utf8');
      expect(seen).toContain('tersio install --dry-run');
      expect(seen).not.toContain('--force');
      // No Tersio-side state: no shared settings, no OMP tree, no opencode tree.
      expect(existsSync(tersioSettings)).toBe(false);
      expect(existsSync(path.join(home, '.omp', 'agent', 'extensions'))).toBe(false);
      expect(existsSync(path.join(home, '.config', 'opencode', 'plugins', 'tersio'))).toBe(false);
    } finally {
      cleanup(home);
    }
  });

  test('a failing jcode install reports failure and exits nonzero', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    const log = fakeJcode(binDir, '', { exit: 4 });
    try {
      const result = run(withPath(home, binDir), 'install', '--host', 'jcode', '--yes');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/jcode tersio install did not complete/);
      expect(readFileSync(log, 'utf8')).toContain('tersio install');
    } finally {
      cleanup(home);
    }
  });

  test('a missing jcode binary fails with an actionable message', () => {
    const home = tempHome();
    try {
      const result = run(cliEnv(home, { PATH: path.join(home, 'empty-bin') }), 'install', '--host', 'jcode', '--yes');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/jcode tersio install did not complete|Install jcode/);
    } finally {
      cleanup(home);
    }
  });
});

describe('jcode uninstall delegation', () => {
  test('uninstall --host jcode delegates without touching shared Tersio state', () => {
    const home = tempHome();
    const binDir = path.join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    const log = fakeJcode(binDir, JSON.stringify(ALL_TRUE));
    mkdirSync(path.join(home, '.tersio'), { recursive: true });
    writeFileSync(path.join(home, '.tersio', 'settings.json'), JSON.stringify({ comboDefault: 'max' }), 'utf8');
    try {
      const result = run(withPath(home, binDir), 'uninstall', '--host', 'jcode', '--yes');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Will remove:/);
      expect(result.stdout).toMatch(/Restart jcode to drop the wiring/);
      const seen = readFileSync(log, 'utf8');
      expect(seen).toContain('tersio uninstall');
      // The uninstall above ran without --dry-run, so the forwarded argv must not carry it.
      expect(seen).not.toContain('--dry-run');
      // Shared Tersio state survives.
      expect(readFileSync(path.join(home, '.tersio', 'settings.json'), 'utf8')).toContain('comboDefault');
    } finally {
      cleanup(home);
    }
  });
});

/** Spawned probe: reports detectHosts()'s jcode row under an isolated PATH/HOME. */
const JCODE_DETECT_PROBE = `
  const { detectHosts } = await import(${JSON.stringify(path.join(root, 'cli', 'hosts.ts'))});
  const jcode = detectHosts().find((h) => h.id === 'jcode');
  console.log(JSON.stringify({ installed: jcode?.installed ?? false, wiring: jcode?.jcode ?? null, dir: jcode?.dir ?? null, via: jcode?.via ?? null }));
`;
