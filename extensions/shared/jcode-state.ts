// jcode-state.ts — the `jcode` host: Tersio owns no jcode files, the jcode CLI does all the wiring.
// Detection parses `jcode tersio status --json`; install/uninstall delegate to `jcode tersio ...`.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { shimCommand } from './utils.ts';

/** The four wiring booleans `jcode tersio status --json` reports, restated in Tersio's camelCase. */
export interface JcodeWiring {
  guidanceEnabled: boolean;
  rtkTransformWired: boolean;
  usageLedgerWired: boolean;
  mcpWired: boolean;
}

/** A valid status payload plus the binary that answered it. */
export interface JcodeTersioState {
  bin: string;
  wiring: JcodeWiring;
}

const STATUS_TIMEOUT_MS = 5000;

/** A `jcode` executable on PATH (`.exe`/`.cmd` suffixes on Windows); null when absent. */
function jcodeBinary(env: NodeJS.ProcessEnv): string | null {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const suffix of suffixes) {
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, `jcode${suffix}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep scanning PATH */
      }
    }
  }
  return null;
}

/** Where jcode keeps its config (display and doctor paths only; jcode exposes no path in its payload). */
export function jcodeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.JCODE_HOME?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return path.join(home, '.jcode');
}

/** Status JSON with the exact four boolean fields; anything else is not the contract. */
function parseWiring(out: string): JcodeWiring | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.guidance_enabled !== 'boolean' ||
    typeof record.rtk_transform_wired !== 'boolean' ||
    typeof record.usage_ledger_wired !== 'boolean' ||
    typeof record.mcp_wired !== 'boolean'
  )
    return null;
  return {
    guidanceEnabled: record.guidance_enabled,
    rtkTransformWired: record.rtk_transform_wired,
    usageLedgerWired: record.usage_ledger_wired,
    mcpWired: record.mcp_wired,
  };
}

/**
 * Ask jcode itself whether the host is wired. A binary that answers the four-field JSON means jcode
 * is present; an absent binary, nonzero exit, malformed JSON, or missing fields all read as
 * "not installed" — never a thrown error, and never decided by a Tersio MCP entry alone.
 */
export function jcodeTersioState(env: NodeJS.ProcessEnv = process.env): JcodeTersioState | null {
  const bin = jcodeBinary(env);
  if (!bin) return null;
  const shim = shimCommand(bin, ['tersio', 'status', '--json']);
  let out: string;
  try {
    out = execFileSync(shim.cmd, shim.args, {
      encoding: 'utf8',
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
      env,
    });
  } catch {
    return null;
  }
  const wiring = parseWiring(out);
  return wiring ? { bin, wiring } : null;
}

/**
 * The argv Tersio hands to jcode for a lifecycle action. `dryRun` forwards the caller's preview
 * state; `force` rides only when the Tersio caller explicitly supplied `--force`.
 */
export function jcodeTersioArgs(
  action: 'install' | 'uninstall',
  opts: { dryRun?: boolean; force?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } {
  const argv = [jcodeBinary(env) ?? 'jcode', 'tersio', action];
  if (action === 'install' && opts.force) argv.push('--force');
  if (opts.dryRun) argv.push('--dry-run');
  return shimCommand(argv[0], argv.slice(1));
}
