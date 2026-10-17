/**
 * Emby API Client
 * Used to verify media is visible in Emby before notifying users
 */

import axios from 'axios';
import { logger } from '../../config/logger.js';
import { env } from '../../config/environment.js';

export interface EmbyWatchIndex {
  seriesByTvdb: Map<string, string>;
  seriesByFolder: Map<string, string>;
  moviesByTmdb: Map<string, string>;
  moviesByFolder: Map<string, string>;
  favouriteSeriesTvdb: Set<string>;
  favouriteSeriesFolders: Set<string>;
  favouriteMovieTmdb: Set<string>;
  favouriteMovieFolders: Set<string>;
  users: number;
  datedPlays: number;
  activityPlays: number;
  unmatchedActivityPlays: string[];
}

class EmbyClient {
  private baseUrl: string | undefined;
  private token: string | undefined;

  constructor() {
    this.baseUrl = env.EMBY_URL?.replace(/\/$/, '');
    this.token = env.EMBY_TOKEN;
  }

  /**
   * Check if Emby is configured
   */
  isConfigured(): boolean {
    return !!(this.baseUrl && this.token);
  }

  /**
   * Search Emby for a movie by title and year
   * Returns true if the item is visible in Emby's library
   */
  async isMovieVisible(title: string, year?: number | null, tmdbId?: number | null): Promise<boolean> {
    if (!this.isConfigured()) return true; // If Emby not configured, skip check

    try {
      const headers = { 'X-Emby-Token': this.token! };

      // Search by name in Emby
      const resp = await axios.get(`${this.baseUrl}/Items`, {
        headers,
        params: {
          SearchTerm: title,
          IncludeItemTypes: 'Movie',
          Recursive: true,
          Limit: 20,
        },
        timeout: 10000,
      });

      const items = resp.data?.Items || [];

      // Try to find a match by TMDB provider ID first (most accurate)
      if (tmdbId) {
        for (const item of items) {
          const providerIds = item.ProviderIds || {};
          if (providerIds.Tmdb && parseInt(providerIds.Tmdb, 10) === tmdbId) {
            logger.debug({ title, tmdbId, embyId: item.Id }, 'Movie found in Emby by TMDB ID');
            return true;
          }
        }
      }

      // Fallback: match by title and year
      for (const item of items) {
        const nameMatch = item.Name?.toLowerCase() === title.toLowerCase();
        const yearMatch = !year || item.ProductionYear === year;
        if (nameMatch && yearMatch) {
          logger.debug({ title, year, embyId: item.Id }, 'Movie found in Emby by title/year');
          return true;
        }
      }

      logger.debug({ title, year, tmdbId, resultCount: items.length }, 'Movie not yet visible in Emby');
      return false;
    } catch (error) {
      logger.error({ error, title }, 'Error checking Emby for movie visibility');
      // On error, don't block the notification
      return true;
    }
  }

  /**
   * Search Emby for a series by title
   * Returns true if the item is visible in Emby's library
   */
  async isSeriesVisible(title: string, year?: number | null, tmdbId?: number | null): Promise<boolean> {
    if (!this.isConfigured()) return true; // If Emby not configured, skip check

    try {
      const headers = { 'X-Emby-Token': this.token! };

      const resp = await axios.get(`${this.baseUrl}/Items`, {
        headers,
        params: {
          SearchTerm: title,
          IncludeItemTypes: 'Series',
          Recursive: true,
          Limit: 20,
        },
        timeout: 10000,
      });

      const items = resp.data?.Items || [];

      // Try TMDB ID match first
      if (tmdbId) {
        for (const item of items) {
          const providerIds = item.ProviderIds || {};
          if (providerIds.Tmdb && parseInt(providerIds.Tmdb, 10) === tmdbId) {
            logger.debug({ title, tmdbId, embyId: item.Id }, 'Series found in Emby by TMDB ID');
            return true;
          }
        }
      }

      // Fallback: match by title
      for (const item of items) {
        const nameMatch = item.Name?.toLowerCase() === title.toLowerCase();
        const yearMatch = !year || item.ProductionYear === year;
        if (nameMatch && yearMatch) {
          logger.debug({ title, year, embyId: item.Id }, 'Series found in Emby by title/year');
          return true;
        }
      }

      logger.debug({ title, year, tmdbId, resultCount: items.length }, 'Series not yet visible in Emby');
      return false;
    } catch (error) {
      logger.error({ error, title }, 'Error checking Emby for series visibility');
      // On error, don't block the notification
      return true;
    }
  }

  /**
   * Build a watch index across every Emby user: the last time anyone played each series
   * (any episode) or movie, keyed by TVDB / TMDB id and by folder name, plus anything a
   * user has favourited. Throws if any request fails, so callers never mistake missing
   * data for "nobody watched it".
   *
   * Two sources are combined, because each misses plays the other sees: per-user play data
   * has no date for a short or abandoned play, and the activity log points at item ids that
   * change when a file is replaced, so those entries are matched by title instead.
   */
  async getWatchIndex(since: Date): Promise<EmbyWatchIndex> {
    if (!this.isConfigured()) throw new Error('Emby is not configured');
    const headers = { 'X-Emby-Token': this.token! };
    const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
      const resp = await axios.get<T>(`${this.baseUrl}${path}`, { headers, params, timeout: 120_000 });
      return resp.data;
    };
    type Item = {
      Id: string;
      Name?: string;
      Type: string;
      SeriesId?: string;
      Path?: string;
      ProviderIds?: Record<string, string>;
      UserData?: { LastPlayedDate?: string; IsFavorite?: boolean };
    };

    const index: EmbyWatchIndex = {
      seriesByTvdb: new Map(),
      seriesByFolder: new Map(),
      moviesByTmdb: new Map(),
      moviesByFolder: new Map(),
      favouriteSeriesTvdb: new Set(),
      favouriteSeriesFolders: new Set(),
      favouriteMovieTmdb: new Set(),
      favouriteMovieFolders: new Set(),
      users: 0,
      datedPlays: 0,
      activityPlays: 0,
      unmatchedActivityPlays: [],
    };
    const folderOf = (path?: string) => (path ? path.replace(/\/+$/, '').split('/').pop()!.toLowerCase() : undefined);
    const later = (map: Map<string, string>, key: string | undefined, date: string) => {
      if (!key) return;
      const current = map.get(key);
      if (!current || Date.parse(date) > Date.parse(current)) map.set(key, date);
    };

    // Episodes only carry their series' Emby id, so map that to TVDB id and folder first.
    const series = await get<{ Items: Item[] }>('/Items', {
      Recursive: 'true',
      IncludeItemTypes: 'Series',
      Fields: 'ProviderIds,Path',
    });
    const seriesKeys = new Map<string, { tvdb?: string; folder?: string }>();
    const seriesByName = new Map<string, { tvdb?: string; folder?: string }>();
    for (const s of series.Items) {
      const keys = { tvdb: s.ProviderIds?.Tvdb, folder: folderOf(s.Path) };
      seriesKeys.set(s.Id, keys);
      if (s.Name) seriesByName.set(s.Name.toLowerCase(), keys);
    }
    const movies = await get<{ Items: Item[] }>('/Items', {
      Recursive: 'true',
      IncludeItemTypes: 'Movie',
      Fields: 'ProviderIds,Path',
    });
    const movieByName = new Map<string, { tmdb?: string; folder?: string }>();
    for (const m of movies.Items) {
      if (m.Name) movieByName.set(m.Name.toLowerCase(), { tmdb: m.ProviderIds?.Tmdb, folder: folderOf(m.Path?.replace(/\/[^/]+$/, '')) });
    }
    const markSeries = (keys: { tvdb?: string; folder?: string } | undefined, date: string) => {
      later(index.seriesByTvdb, keys?.tvdb, date);
      later(index.seriesByFolder, keys?.folder, date);
    };
    const markMovie = (keys: { tmdb?: string; folder?: string } | undefined, date: string) => {
      later(index.moviesByTmdb, keys?.tmdb, date);
      later(index.moviesByFolder, keys?.folder, date);
    };

    const users = await get<Array<{ Id: string }>>('/Users', {});
    index.users = users.length;
    for (const user of users) {
      for (const filter of ['IsPlayed', 'IsResumable']) {
        const items = await get<{ Items: Item[] }>(`/Users/${user.Id}/Items`, {
          Recursive: 'true',
          IncludeItemTypes: 'Episode,Movie',
          Filters: filter,
          EnableUserData: 'true',
          Fields: 'UserDataLastPlayedDate,ProviderIds,Path,SeriesId',
        });
        for (const item of items.Items) {
          const date = item.UserData?.LastPlayedDate;
          if (!date) continue; // marked played by hand, never actually watched
          index.datedPlays++;
          if (item.Type === 'Episode' && item.SeriesId) {
            markSeries(seriesKeys.get(item.SeriesId), date);
          } else if (item.Type === 'Movie') {
            markMovie({ tmdb: item.ProviderIds?.Tmdb, folder: folderOf(item.Path?.replace(/\/[^/]+$/, '')) }, date);
          }
        }
      }

      const favourites = await get<{ Items: Item[] }>(`/Users/${user.Id}/Items`, {
        Recursive: 'true',
        IncludeItemTypes: 'Series,Movie',
        Filters: 'IsFavorite',
        Fields: 'ProviderIds,Path',
      });
      for (const item of favourites.Items) {
        if (item.Type === 'Series') {
          if (item.ProviderIds?.Tvdb) index.favouriteSeriesTvdb.add(item.ProviderIds.Tvdb);
          const folder = folderOf(item.Path);
          if (folder) index.favouriteSeriesFolders.add(folder);
        } else {
          if (item.ProviderIds?.Tmdb) index.favouriteMovieTmdb.add(item.ProviderIds.Tmdb);
          const folder = folderOf(item.Path?.replace(/\/[^/]+$/, ''));
          if (folder) index.favouriteMovieFolders.add(folder);
        }
      }
    }

    // Activity log, newest first: every playback start since the cutoff.
    type Entry = { Type: string; ItemId?: string; Name: string; Date: string };
    const plays: Entry[] = [];
    for (let start = 0; ; ) {
      const page = await get<{ Items: Entry[] }>('/System/ActivityLog/Entries', {
        StartIndex: String(start),
        Limit: '1000',
      });
      if (!page.Items.length) break;
      let reachedCutoff = false;
      for (const entry of page.Items) {
        if (Date.parse(entry.Date) < since.getTime()) {
          reachedCutoff = true;
          break;
        }
        if (entry.Type === 'playback.start') plays.push(entry);
      }
      if (reachedCutoff) break;
      start += page.Items.length;
    }
    index.activityPlays = plays.length;

    const ids = [...new Set(plays.map((p) => p.ItemId).filter((id): id is string => !!id))];
    const items = new Map<string, Item>();
    for (let i = 0; i < ids.length; i += 100) {
      const page = await get<{ Items: Item[] }>('/Items', {
        Ids: ids.slice(i, i + 100).join(','),
        Fields: 'ProviderIds,Path,SeriesId',
      });
      for (const item of page.Items) items.set(item.Id, item);
    }
    for (const play of plays) {
      const item = play.ItemId ? items.get(play.ItemId) : undefined;
      if (item?.Type === 'Episode' && item.SeriesId && seriesKeys.has(item.SeriesId)) {
        markSeries(seriesKeys.get(item.SeriesId), play.Date);
        continue;
      }
      if (item?.Type === 'Movie') {
        markMovie({ tmdb: item.ProviderIds?.Tmdb, folder: folderOf(item.Path?.replace(/\/[^/]+$/, '')) }, play.Date);
        continue;
      }
      // The item id no longer exists, so match the title in "<user> is playing <title> on <device>".
      const what = play.Name.replace(/^.+? is playing /, '');
      const episode = what.match(/^(.+?) - S\d+, Ep\d+/);
      if (episode && seriesByName.has(episode[1].toLowerCase())) {
        markSeries(seriesByName.get(episode[1].toLowerCase()), play.Date);
        continue;
      }
      const onAt = what.lastIndexOf(' on ');
      const movieName = (onAt > 0 ? what.slice(0, onAt) : what).toLowerCase();
      if (!episode && movieByName.has(movieName)) {
        markMovie(movieByName.get(movieName), play.Date);
        continue;
      }
      index.unmatchedActivityPlays.push(play.Name);
    }

    return index;
  }
}

// Export singleton
export const embyClient = new EmbyClient();
