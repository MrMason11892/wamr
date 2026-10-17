/**
 * Media janitor: removes shows and movies nobody has watched for JANITOR_DAYS, so the
 * Wasabi-backed library does not fill up with things import lists pulled in.
 *
 * Removal goes through Sonarr/Radarr with the import exclusion flag, so import lists cannot
 * re-add the title. A WAMR request lifts the exclusion again (see the add methods on the
 * clients), so anything removed comes back on request.
 *
 * JANITOR_MODE=report (the default) only writes the report; delete acts on it.
 */

import fs from 'fs';
import path from 'path';
import { env } from '../../config/environment.js';
import { logger } from '../../config/logger.js';
import { mediaServiceConfigRepository } from '../../repositories/media-service-config.repository.js';
import { requestHistoryRepository } from '../../repositories/request-history.repository.js';
import { encryptionService } from '../encryption/encryption.service.js';
import { embyClient } from '../integrations/emby.client.js';
import { SonarrClient } from '../integrations/sonarr.client.js';
import { RadarrClient } from '../integrations/radarr.client.js';
import { adminNotificationService } from '../notifications/admin-notification.service.js';
import { whatsappClientService } from '../whatsapp/whatsapp-client.service.js';
import { judge, type JanitorSignals, type JanitorTitle } from './janitor-rules.js';

const DATA_DIR = path.join(path.dirname(path.resolve(env.DATABASE_PATH)), 'janitor');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DELETED_LOG = path.join(DATA_DIR, 'deleted.jsonl');
// Read by the host's jfs-trash-purge timer, which permanently removes these folders from the
// JuiceFS trash. Folder names only; the purge matches them against trash entries.
const TRASH_QUEUE = path.join(DATA_DIR, 'trash-purge-queue.jsonl');
const CHECK_INTERVAL_MS = 15 * 60_000;

interface CandidateRow {
  kind: 'series' | 'movie';
  title: string;
  externalId?: number;
  sizeOnDisk: number;
  added?: string;
  lastPlayed?: string;
  folder?: string;
}

export interface JanitorReport {
  generatedAt: string;
  mode: 'report' | 'delete';
  days: number;
  cutoff: string;
  embyUsers: number;
  embyDatedPlays: number;
  totals: { series: number; movies: number };
  kept: Record<string, number>;
  candidates: CandidateRow[];
  candidateBytes: number;
  removed: CandidateRow[];
  removedBytes: number;
  failed: Array<{ title: string; error: string }>;
}

const folderName = (p?: string) => (p ? p.replace(/\/+$/, '').split('/').pop()!.toLowerCase() : undefined);
const tb = (bytes: number) => `${(bytes / 1e12).toFixed(2)} TB`;
const londonDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const londonHour = (d = new Date()) =>
  Number(d.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));

export class MediaJanitorService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (!env.JANITOR_ENABLED) {
      logger.info('Media janitor disabled');
      return;
    }
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    this.tick();
    logger.info({ mode: env.JANITOR_MODE, days: env.JANITOR_DAYS, hour: env.JANITOR_HOUR }, 'Media janitor started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readState(): { lastRunDate?: string } {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return {};
    }
  }

  private tick(): void {
    const today = londonDate();
    const state = this.readState();
    if (state.lastRunDate === today) return;
    // Report mode is harmless, so the first report appears straight after a deploy;
    // deletes only ever happen in the scheduled window.
    const due = londonHour() === env.JANITOR_HOUR || (env.JANITOR_MODE === 'report' && !state.lastRunDate);
    if (!due) return;
    this.run(env.JANITOR_MODE).catch((error) => logger.error({ error }, 'Media janitor run failed'));
  }

  async run(mode: 'report' | 'delete'): Promise<JanitorReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const report = await this.execute(mode);
      fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRunDate: londonDate() }));
      await this.notifyAdmin(report);
      return report;
    } catch (error) {
      await this.notifyAdmin(null, error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async execute(mode: 'report' | 'delete'): Promise<JanitorReport> {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const cutoff = new Date(Date.now() - env.JANITOR_DAYS * 864e5);

    const sonarrConfig = (await mediaServiceConfigRepository.findEnabledByType('sonarr'))[0];
    const radarrConfig = (await mediaServiceConfigRepository.findEnabledByType('radarr'))[0];
    if (!sonarrConfig && !radarrConfig) throw new Error('No enabled Sonarr or Radarr configured');
    const sonarr = sonarrConfig
      ? new SonarrClient(sonarrConfig.baseUrl, encryptionService.decrypt(sonarrConfig.apiKeyEncrypted), sonarrConfig.allowInsecure ?? false)
      : null;
    const radarr = radarrConfig
      ? new RadarrClient(radarrConfig.baseUrl, encryptionService.decrypt(radarrConfig.apiKeyEncrypted), radarrConfig.allowInsecure ?? false)
      : null;

    // Without watch data everything would look unwatched, so refuse to judge on a bad read.
    const watch = await embyClient.getWatchIndex();
    if (watch.users === 0 || watch.datedPlays === 0) {
      throw new Error(`Emby watch data looks empty (users ${watch.users}, dated plays ${watch.datedPlays}); refusing to run`);
    }

    const requested = (await requestHistoryRepository.findAll()).filter(
      (r) => r.createdAt && Date.parse(r.createdAt) >= cutoff.getTime()
    );
    const requestedTvdb = new Set(requested.map((r) => r.tvdbId).filter((id): id is number => !!id));
    const requestedTmdb = new Set(requested.map((r) => r.tmdbId).filter((id): id is number => !!id));

    const titles: JanitorTitle[] = [];
    if (sonarr) {
      const tagNames = new Map((await sonarr.getTags()).map((t) => [t.id, t.label]));
      for (const s of await sonarr.getAllSeriesForCleanup()) {
        if (s.id === undefined) continue;
        titles.push({
          kind: 'series',
          id: s.id,
          title: s.title,
          externalId: s.tvdbId,
          folder: folderName(s.path),
          path: s.path,
          added: s.added,
          sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
          tags: (s.tags ?? []).map((t) => tagNames.get(t) ?? ''),
        });
      }
    }
    if (radarr) {
      const tagNames = new Map((await radarr.getTags()).map((t) => [t.id, t.label]));
      for (const m of await radarr.getAllMoviesForCleanup()) {
        if (m.id === undefined) continue;
        titles.push({
          kind: 'movie',
          id: m.id,
          title: m.year ? `${m.title} (${m.year})` : m.title,
          externalId: m.tmdbId,
          folder: folderName(m.path),
          path: m.path,
          added: m.added,
          sizeOnDisk: m.sizeOnDisk ?? 0,
          tags: (m.tags ?? []).map((t) => tagNames.get(t) ?? ''),
        });
      }
    }

    const seriesSignals: JanitorSignals = {
      lastPlayedById: watch.seriesByTvdb,
      lastPlayedByFolder: watch.seriesByFolder,
      favouriteIds: watch.favouriteSeriesTvdb,
      favouriteFolders: watch.favouriteSeriesFolders,
      recentlyRequestedIds: requestedTvdb,
    };
    const movieSignals: JanitorSignals = {
      lastPlayedById: watch.moviesByTmdb,
      lastPlayedByFolder: watch.moviesByFolder,
      favouriteIds: watch.favouriteMovieTmdb,
      favouriteFolders: watch.favouriteMovieFolders,
      recentlyRequestedIds: requestedTmdb,
    };

    const kept: Record<string, number> = {};
    const candidates: Array<{ title: JanitorTitle; row: CandidateRow }> = [];
    for (const t of titles) {
      const verdict = judge(t, t.kind === 'series' ? seriesSignals : movieSignals, cutoff);
      if (!verdict.remove) {
        kept[verdict.reason] = (kept[verdict.reason] ?? 0) + 1;
        continue;
      }
      candidates.push({
        title: t,
        row: {
          kind: t.kind,
          title: t.title,
          externalId: t.externalId,
          sizeOnDisk: t.sizeOnDisk,
          added: t.added,
          lastPlayed: verdict.lastPlayed,
          folder: t.folder,
        },
      });
    }
    // Biggest first, so a capped run frees the most space.
    candidates.sort((a, b) => b.title.sizeOnDisk - a.title.sizeOnDisk);

    const report: JanitorReport = {
      generatedAt: new Date().toISOString(),
      mode,
      days: env.JANITOR_DAYS,
      cutoff: cutoff.toISOString(),
      embyUsers: watch.users,
      embyDatedPlays: watch.datedPlays,
      totals: {
        series: titles.filter((t) => t.kind === 'series').length,
        movies: titles.filter((t) => t.kind === 'movie').length,
      },
      kept,
      candidates: candidates.map((c) => c.row),
      candidateBytes: candidates.reduce((sum, c) => sum + c.title.sizeOnDisk, 0),
      removed: [],
      removedBytes: 0,
      failed: [],
    };

    if (mode === 'delete') {
      for (const { title, row } of candidates.slice(0, env.JANITOR_MAX_PER_RUN)) {
        try {
          if (title.kind === 'series') await sonarr!.deleteSeriesWithExclusion(title.id);
          else await radarr!.deleteMovieWithExclusion(title.id);
          const deletedAt = new Date().toISOString();
          report.removed.push(row);
          report.removedBytes += title.sizeOnDisk;
          fs.appendFileSync(DELETED_LOG, JSON.stringify({ ...row, path: title.path, deletedAt }) + '\n');
          if (title.folder && title.sizeOnDisk > 0) {
            fs.appendFileSync(TRASH_QUEUE, JSON.stringify({ folder: title.folder, deletedAt }) + '\n');
          }
          logger.info({ kind: title.kind, title: title.title, size: title.sizeOnDisk }, 'Media janitor removed title');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.failed.push({ title: title.title, error: message });
          logger.error({ error, title: title.title }, 'Media janitor failed to remove title');
        }
      }
    }

    const file = path.join(DATA_DIR, `report-${londonDate()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    logger.info(
      { file, candidates: report.candidates.length, candidateBytes: report.candidateBytes, removed: report.removed.length },
      'Media janitor report written'
    );
    return report;
  }

  private async notifyAdmin(report: JanitorReport | null, error?: unknown): Promise<void> {
    try {
      if (!(await adminNotificationService.isConfigured()) || !whatsappClientService.isReady()) return;
      const phone = await adminNotificationService.getAdminPhoneNumber();
      if (!phone) return;
      let message: string;
      if (!report) {
        message = `🧹 *Media janitor failed*\n\n${error instanceof Error ? error.message : String(error)}\n\nNothing was removed.`;
      } else {
        const series = report.candidates.filter((c) => c.kind === 'series').length;
        const movies = report.candidates.length - series;
        message =
          `🧹 *Media janitor (${report.mode})*\n\n` +
          `Not watched for ${report.days} days: ${series} shows, ${movies} movies (${tb(report.candidateBytes)}).\n` +
          (report.mode === 'delete'
            ? `Removed this run: ${report.removed.length} (${tb(report.removedBytes)})` +
              (report.failed.length ? `, ${report.failed.length} failed` : '') +
              `.\n`
            : `Report only, nothing removed.\n`);
      }
      await whatsappClientService.sendMessage(phone, message);
    } catch (notifyError) {
      logger.warn({ error: notifyError }, 'Media janitor could not notify admin');
    }
  }
}

export const mediaJanitorService = new MediaJanitorService();
