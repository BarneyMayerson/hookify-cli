import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function resolveGitDir(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build']);

/**
 * Looks for package.json/composer.json deeper than the root — a sign of
 * a monorepo. v1.0 only works with a single root manifest; silently
 * pretending everything's fine is worse than honestly saying
 * "not supported yet".
 */
export function detectMonorepo(root, maxDepth = 3) {
  const found = [];

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);

      if (depth > 0 && (entry === 'package.json' || entry === 'composer.json')) {
        found.push(full);
        continue;
      }

      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;

      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        // A dangling symlink or missing permissions — not a reason to crash.
      }
    }
  };

  walk(root, 0);
  return found;
}

export function hasRootManifest(root) {
  return existsSync(join(root, 'package.json')) || existsSync(join(root, 'composer.json'));
}