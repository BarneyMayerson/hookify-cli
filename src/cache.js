import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CACHE_FILE = 'manifest.json';

export function cachePath(gitDir) {
  return join(gitDir, 'hookify', CACHE_FILE);
}

export function readCache(gitDir) {
  const path = cachePath(gitDir);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Повреждённый кэш эквивалентен его отсутствию.
    return null;
  }
}

export function writeCache(gitDir, manifest) {
  const path = cachePath(gitDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Три сценария из дорожной карты:
 *   сеть есть                  -> свежий манифест, обновляем кэш
 *   сети нет, кэш есть         -> тихий fail-open на кэше
 *   сети нет, кэша никогда нет -> пропускаем проверки с явным сообщением
 *
 * Причина сетевой ошибки прокидывается наружу даже в fail-open-сценариях —
 * молчаливое поглощение ошибки не даёт продиагностировать, что случилось
 * (например, недоверенный TLS-сертификат локального .lan-домена).
 *
 * @returns {{manifest: object|null, source: 'network'|'cache'|'none', error?: Error}}
 */
export async function resolveManifest(gitDir, fetchManifest) {
  try {
    const manifest = await fetchManifest();
    writeCache(gitDir, manifest);
    return { manifest, source: 'network' };
  } catch (error) {
    const cached = readCache(gitDir);
    return cached
      ? { manifest: cached, source: 'cache', error }
      : { manifest: null, source: 'none', error };
  }
}