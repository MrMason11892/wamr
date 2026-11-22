import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearSessionFiles } from '../session-files.js';

describe('clearSessionFiles', () => {
  it('empties the session directory but keeps the directory (bind mount safe)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wamr-session-'));
    fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.writeFileSync(path.join(dir, 'keys', 'pre-key-1.json'), '{}');

    await clearSessionFiles(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmdirSync(dir);
  });

  it('does nothing when the directory does not exist', async () => {
    await expect(clearSessionFiles(path.join(os.tmpdir(), 'wamr-missing-dir-x'))).resolves.toBeUndefined();
  });
});
