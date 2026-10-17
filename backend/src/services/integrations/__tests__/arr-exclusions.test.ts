import { describe, it, expect, vi, beforeEach } from 'vitest';

const http = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
vi.mock('../base-service.client.js', () => ({ BaseServiceClient: { createClient: () => http } }));

const { SonarrClient } = await import('../sonarr.client.js');
const { RadarrClient } = await import('../radarr.client.js');

const seriesParams = { title: 'Show', year: 2020, tvdbId: 100, titleSlug: 'show', qualityProfileId: 1, rootFolderPath: '/tv' };
const movieParams = { title: 'Film', year: 2020, tmdbId: 200, titleSlug: 'film', qualityProfileId: 1, rootFolderPath: '/movies' };

beforeEach(() => {
  vi.resetAllMocks();
  http.post.mockResolvedValue({ data: {} });
  http.delete.mockResolvedValue({ data: {} });
});

describe('re-requesting a removed title', () => {
  it('Sonarr: lifts the exclusion before adding the series', async () => {
    http.get.mockResolvedValue({ data: [{ id: 7, tvdbId: 100 }, { id: 8, tvdbId: 999 }] });
    await new SonarrClient('http://x', 'k').addSeries(seriesParams);
    expect(http.delete).toHaveBeenCalledWith('/api/v3/importlistexclusion/7');
    expect(http.delete).toHaveBeenCalledTimes(1);
    expect(http.delete.mock.invocationCallOrder[0]).toBeLessThan(http.post.mock.invocationCallOrder[0]);
  });

  it('Radarr: lifts the exclusion before adding the movie', async () => {
    http.get.mockResolvedValue({ data: [{ id: 3, tmdbId: 200 }] });
    await new RadarrClient('http://x', 'k').addMovie(movieParams);
    expect(http.delete).toHaveBeenCalledWith('/api/v3/exclusions/3');
    expect(http.post).toHaveBeenCalledWith('/api/v3/movie', expect.objectContaining({ tmdbId: 200 }));
  });

  it('still adds when the exclusion lookup fails', async () => {
    http.get.mockRejectedValue(new Error('down'));
    await new SonarrClient('http://x', 'k').addSeries(seriesParams);
    expect(http.post).toHaveBeenCalledWith('/api/v3/series', expect.objectContaining({ tvdbId: 100 }));
  });
});

describe('janitor removal', () => {
  it('Sonarr deletes files and adds the import list exclusion', async () => {
    await new SonarrClient('http://x', 'k').deleteSeriesWithExclusion(5);
    expect(http.delete).toHaveBeenCalledWith('/api/v3/series/5', expect.objectContaining({
      params: { deleteFiles: true, addImportListExclusion: true },
    }));
  });

  it('Radarr deletes files and adds the import exclusion', async () => {
    await new RadarrClient('http://x', 'k').deleteMovieWithExclusion(6);
    expect(http.delete).toHaveBeenCalledWith('/api/v3/movie/6', expect.objectContaining({
      params: { deleteFiles: true, addImportExclusion: true },
    }));
  });
});
