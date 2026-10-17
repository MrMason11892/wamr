import { describe, it, expect } from 'vitest';
import { judge, type JanitorSignals, type JanitorTitle } from '../janitor-rules';

const now = Date.parse('2026-10-17T12:00:00Z');
const cutoff = new Date(now - 90 * 864e5);
const daysAgo = (d: number) => new Date(now - d * 864e5).toISOString();

const signals = (over: Partial<JanitorSignals> = {}): JanitorSignals => ({
  lastPlayedById: new Map(),
  lastPlayedByFolder: new Map(),
  favouriteIds: new Set(),
  favouriteFolders: new Set(),
  recentlyRequestedIds: new Set(),
  ...over,
});

const title = (over: Partial<JanitorTitle> = {}): JanitorTitle => ({
  kind: 'series',
  id: 1,
  title: 'Show',
  externalId: 100,
  folder: 'show (2020)',
  added: daysAgo(200),
  sizeOnDisk: 5e10,
  tags: [],
  ...over,
});

describe('media janitor rules', () => {
  it('removes an old title nobody has ever played', () => {
    expect(judge(title(), signals(), cutoff)).toEqual({ remove: true, lastPlayed: undefined });
  });

  it('removes an old title last played before the cutoff', () => {
    const s = signals({ lastPlayedById: new Map([['100', daysAgo(120)]]) });
    expect(judge(title(), s, cutoff)).toMatchObject({ remove: true });
  });

  it('keeps a title watched inside the window, matched by id', () => {
    const s = signals({ lastPlayedById: new Map([['100', daysAgo(10)]]) });
    expect(judge(title(), s, cutoff)).toMatchObject({ remove: false, reason: 'watched recently' });
  });

  it('keeps a title watched inside the window, matched by folder when ids differ', () => {
    const s = signals({ lastPlayedByFolder: new Map([['show (2020)', daysAgo(10)]]) });
    expect(judge(title(), s, cutoff)).toMatchObject({ remove: false, reason: 'watched recently' });
  });

  it('uses the most recent play when id and folder disagree', () => {
    const s = signals({
      lastPlayedById: new Map([['100', daysAgo(150)]]),
      lastPlayedByFolder: new Map([['show (2020)', daysAgo(5)]]),
    });
    expect(judge(title(), s, cutoff)).toMatchObject({ remove: false, reason: 'watched recently' });
  });

  it('keeps anything added inside the window even if unwatched', () => {
    expect(judge(title({ added: daysAgo(30) }), signals(), cutoff)).toMatchObject({
      remove: false,
      reason: 'added recently',
    });
  });

  it('keeps favourites, keep-tagged and recently requested titles', () => {
    expect(judge(title(), signals({ favouriteIds: new Set(['100']) }), cutoff)).toMatchObject({ reason: 'favourite' });
    expect(judge(title(), signals({ favouriteFolders: new Set(['show (2020)']) }), cutoff)).toMatchObject({ reason: 'favourite' });
    expect(judge(title({ tags: ['Keep'] }), signals(), cutoff)).toMatchObject({ reason: 'tagged keep' });
    expect(judge(title(), signals({ recentlyRequestedIds: new Set([100]) }), cutoff)).toMatchObject({
      reason: 'requested recently',
    });
  });

  it('never removes a title without an added date', () => {
    expect(judge(title({ added: undefined }), signals(), cutoff)).toMatchObject({ remove: false, reason: 'no added date' });
  });
});
