/**
 * Media janitor decision rules, kept free of I/O so they can be tested directly.
 *
 * A title is removed when it was added to Sonarr/Radarr before the cutoff AND nobody on
 * Emby has played it since the cutoff. Favourites, anything tagged "keep" and anything
 * requested through WAMR since the cutoff are always kept.
 */

export interface JanitorTitle {
  kind: 'series' | 'movie';
  id: number;
  title: string;
  externalId?: number; // TVDB for series, TMDB for movies
  folder?: string; // lower-cased folder name, used when ids do not line up
  path?: string;
  added?: string;
  sizeOnDisk: number;
  tags: string[];
}

export interface JanitorSignals {
  lastPlayedById: Map<string, string>;
  lastPlayedByFolder: Map<string, string>;
  favouriteIds: Set<string>;
  favouriteFolders: Set<string>;
  recentlyRequestedIds: Set<number>;
}

export type JanitorVerdict =
  | { remove: true; lastPlayed?: string }
  | { remove: false; reason: string; lastPlayed?: string };

export const KEEP_TAG = 'keep';

export function lastPlayedFor(title: JanitorTitle, signals: JanitorSignals): string | undefined {
  const dates = [
    title.externalId !== undefined ? signals.lastPlayedById.get(String(title.externalId)) : undefined,
    title.folder ? signals.lastPlayedByFolder.get(title.folder) : undefined,
  ].filter((d): d is string => !!d);
  if (!dates.length) return undefined;
  return dates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export function judge(title: JanitorTitle, signals: JanitorSignals, cutoff: Date): JanitorVerdict {
  const lastPlayed = lastPlayedFor(title, signals);
  const cutoffMs = cutoff.getTime();

  if (title.tags.some((t) => t.toLowerCase() === KEEP_TAG)) {
    return { remove: false, reason: 'tagged keep', lastPlayed };
  }
  if (
    (title.externalId !== undefined && signals.favouriteIds.has(String(title.externalId))) ||
    (title.folder && signals.favouriteFolders.has(title.folder))
  ) {
    return { remove: false, reason: 'favourite', lastPlayed };
  }
  if (title.externalId !== undefined && signals.recentlyRequestedIds.has(title.externalId)) {
    return { remove: false, reason: 'requested recently', lastPlayed };
  }
  const addedMs = title.added ? Date.parse(title.added) : NaN;
  if (Number.isNaN(addedMs)) {
    return { remove: false, reason: 'no added date', lastPlayed };
  }
  if (addedMs >= cutoffMs) {
    return { remove: false, reason: 'added recently', lastPlayed };
  }
  if (lastPlayed && Date.parse(lastPlayed) >= cutoffMs) {
    return { remove: false, reason: 'watched recently', lastPlayed };
  }
  return { remove: true, lastPlayed };
}
