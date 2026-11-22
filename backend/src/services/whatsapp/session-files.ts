import fs from 'fs/promises';
import path from 'path';

/**
 * Remove everything inside the WhatsApp session directory, keeping the directory itself.
 * In Docker the session directory is a bind mount, so removing the directory fails with
 * EBUSY before any file inside it is deleted, which leaves stale creds in place.
 */
export async function clearSessionFiles(sessionPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    entries.map((entry) => fs.rm(path.join(sessionPath, entry), { recursive: true, force: true }))
  );
}
