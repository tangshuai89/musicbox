import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { MusicService, type LikeMeta } from './music.service';
import {
  normalizeProvider,
  MusicProvider,
  MUSIC_PROVIDERS,
} from '../common/provider';
import { SessionService } from '../common/session';
import { DeezerMusicProvider } from './deezer.provider';
import { QqQuality } from './qq.provider';
import type { FanOutLikeResponse, SourceInfo } from './types';

/** 从请求体里宽松解析跨平台匹配元数据。缺字段 / 类型不对 → undefined，
 *  服务端退化成「只写已有 source」的老行为（不因 meta 脏数据 400）。 */
function parseMeta(m: unknown): LikeMeta | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  if (typeof o.title !== 'string' || typeof o.artist !== 'string') {
    return undefined;
  }
  const duration =
    typeof o.duration === 'number' && Number.isFinite(o.duration)
      ? o.duration
      : 0;
  return { title: o.title, artist: o.artist, duration };
}

/** 宽松解析 `sources=platform:trackId,platform:trackId` 查询参数。
 *  未知平台 / 缺 trackId 的条目直接丢弃（不 400）。trackId 里可能有
 *  冒号以外的任意字符，所以只按第一个冒号切。 */
function parseSourcesParam(
  raw: string | undefined,
): Array<{ platform: MusicProvider; trackId: string }> {
  if (!raw) return [];
  const out: Array<{ platform: MusicProvider; trackId: string }> = [];
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const platform = part.slice(0, idx) as MusicProvider;
    const trackId = part.slice(idx + 1);
    if (!MUSIC_PROVIDERS.includes(platform) || !trackId) continue;
    out.push({ platform, trackId });
  }
  return out;
}

@Controller('music')
export class MusicController {
  constructor(
    private readonly musicService: MusicService,
    private readonly sessionService: SessionService,
  ) {}

  @Get('next')
  async next(
    @Query('provider') provider: string,
    @Query('preset') preset: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    // Persist the Deezer preset on the session so subsequent /next
    // calls (without a preset query) keep the user's choice. Other
    // providers ignore this field.
    if (preset && normalizeProvider(provider) === 'deezer') {
      session.prefs = { ...(session.prefs ?? {}), deezerPreset: preset };
    }
    return this.musicService.getNextTrack(session, normalizeProvider(provider));
  }

  /**
   * 搜索歌曲。
   *
   * - 单平台: GET /music/search?provider=qq&q=周杰伦
   * - 统一搜索(跨 QQ+网易云+Deezer): GET /music/search?q=周杰伦&page=1&pageSize=20
   *
   * 统一搜索同时查三个平台，合并去重，自动选有版权的平台为 bestSource。
   * 单个平台挂了不影响其他平台——部分结果仍然返回。
   */
  @Get('search')
  async search(
    @Query('provider') provider: string | undefined,
    @Query('q') q: string,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('keyword') keyword: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    // q 参数兼容 'keyword' 别名
    const query = q ?? keyword ?? '';

    // 指定了 provider → 单平台搜索（现有行为，保持不变）
    if (provider) {
      const items = await this.musicService.searchTracks(
        session,
        normalizeProvider(provider),
        query,
      );
      return { items };
    }

    // 未指定 provider → 统一跨平台搜索（新功能）
    return this.musicService.searchUnified(
      session,
      query,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  /**
   * List the Deezer editorial charts we expose to the UI. The renderer
   * fetches this once on first Deezer session to populate the preset
   * picker.
   */
  @Get('deezer/editorials')
  deezerEditorials() {
    return { items: DeezerMusicProvider.getEditorials() };
  }

  /**
   * Heart fan-out：把一个统一 track 的 ❤ 一次性写到所有 hasCopyright 的平台。
   *
   * 请求体: { mergedId, sources: [{platform, trackId}], liked }
   * 响应: { success, liked, fannedOutTo: MusicProvider[] }
   *
   * ⚠️ 必须注册在 /like/:trackId 之前 —— Express 路由按声明顺序匹配，
   * "like/merged" 会被 "like/:trackId" 截胡（trackId=merged），走到老
   * toggleLike 路径。
   */
  @Post('like/merged')
  async likeMerged(
    @Body() body: {
      mergedId?: string;
      sources?: Array<{ platform: string; trackId: string }>;
      liked?: boolean;
      meta?: unknown;
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FanOutLikeResponse> {
    if (!body?.mergedId || typeof body.mergedId !== 'string') {
      throw new BadRequestException('mergedId 必填');
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      throw new BadRequestException('sources 至少 1 项');
    }
    if (typeof body.liked !== 'boolean') {
      throw new BadRequestException('liked 必填（true / false）');
    }
    const sources: Array<{ platform: MusicProvider; trackId: string }> = [];
    for (const s of body.sources) {
      if (
        !s ||
        typeof s.platform !== 'string' ||
        typeof s.trackId !== 'string' ||
        !s.trackId.length
      ) {
        throw new BadRequestException('sources 每项需要 platform + trackId');
      }
      sources.push({
        platform: normalizeProvider(s.platform),
        trackId: s.trackId,
      });
    }
    const session = this.sessionService.resolve(req, res);
    return this.musicService.fanOutLike(
      session,
      body.mergedId,
      sources,
      body.liked,
      parseMeta(body.meta),
    );
  }

  /**
   * 切歌时的红心检测 + 自动同步。查这首统一 track 在各平台的红心情况，
   * 任一平台已红心 → 补齐其余平台并返回 liked=true。
   *
   * 请求体: { mergedId, sources: [{platform, trackId}] }
   * 响应: { liked, fannedOutTo: MusicProvider[] }
   *
   * ⚠️ 同 like/merged：必须注册在 /like/:trackId 之前，否则被截胡。
   */
  @Post('like/detect')
  async likeDetect(
    @Body() body: {
      mergedId?: string;
      sources?: Array<{ platform: string; trackId: string }>;
      meta?: unknown;
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ liked: boolean; fannedOutTo: MusicProvider[] }> {
    if (!body?.mergedId || typeof body.mergedId !== 'string') {
      throw new BadRequestException('mergedId 必填');
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      throw new BadRequestException('sources 至少 1 项');
    }
    const sources: Array<{ platform: MusicProvider; trackId: string }> = [];
    for (const s of body.sources) {
      if (
        !s ||
        typeof s.platform !== 'string' ||
        typeof s.trackId !== 'string' ||
        !s.trackId.length
      ) {
        throw new BadRequestException('sources 每项需要 platform + trackId');
      }
      sources.push({
        platform: normalizeProvider(s.platform),
        trackId: s.trackId,
      });
    }
    const session = this.sessionService.resolve(req, res);
    return this.musicService.detectLikedAndSync(
      session,
      body.mergedId,
      sources,
      parseMeta(body.meta),
    );
  }

  @Post('like/:trackId')
  async like(
    @Param('trackId') trackId: string,
    @Query('provider') provider: string,
    @Body() body: { meta?: unknown } | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.musicService.toggleLike(
      session,
      normalizeProvider(provider),
      trackId,
      parseMeta(body?.meta),
    );
  }

  /**
   * 统一 track 的「踩」：取消这首歌在所有 fan-out 平台的红心 + 标记不喜欢。
   *
   * 请求体: { mergedId, sources: [{platform, trackId}] }
   * 响应: { success }
   *
   * ⚠️ 同 like/merged：必须注册在 /dislike/:trackId 之前，否则会被
   * "dislike/:trackId"（trackId='merged'）截胡，走到单平台 markDisliked。
   */
  @Post('dislike/merged')
  async dislikeMerged(
    @Body() body: {
      mergedId?: string;
      sources?: Array<{ platform: string; trackId: string }>;
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    if (!body?.mergedId || typeof body.mergedId !== 'string') {
      throw new BadRequestException('mergedId 必填');
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      throw new BadRequestException('sources 至少 1 项');
    }
    const sources: Array<{ platform: MusicProvider; trackId: string }> = [];
    for (const s of body.sources) {
      if (
        !s ||
        typeof s.platform !== 'string' ||
        typeof s.trackId !== 'string' ||
        !s.trackId.length
      ) {
        throw new BadRequestException('sources 每项需要 platform + trackId');
      }
      sources.push({
        platform: normalizeProvider(s.platform),
        trackId: s.trackId,
      });
    }
    const session = this.sessionService.resolve(req, res);
    return this.musicService.dislikeMerged(session, body.mergedId, sources);
  }

  @Post('dislike/:trackId')
  async dislike(
    @Param('trackId') trackId: string,
    @Query('provider') provider: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.musicService.markDisliked(
      session,
      normalizeProvider(provider),
      trackId,
    );
  }

  @Get('liked')
  async liked(
    @Query('provider') provider: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.musicService.getLikedTracks(
      session,
      normalizeProvider(provider),
    );
  }

  /**
   * 触发"我的喜欢"导入：从各平台拉取用户已 ❤ 列表，合并去重后存到
   * .storage/library.json。POST 而非 GET 是因为有副作用（写本地 state + 远端
   * API 调用），结果在 body 里返回（调用方无需再 GET /library）。
   */
  @Post('library/import')
  async importLibrary(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.musicService.importLiked(session);
  }

  /** 读最近一次 import 的库（无则 404）。 */
  @Get('library')
  async getLibrary(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    const lib = this.musicService.getLibrary(session);
    if (!lib) {
      res.status(404);
      return { error: 'library_not_imported' };
    }
    return lib;
  }

  /**
   * Audio stream proxy. The browser's <audio> tag loads this URL.
   *
   * We proxy the raw bytes for ALL providers (previously QQ/NetEase
   * were 302-redirected to their CDN). Two reasons the byte-proxy is
   * required, not just nicer:
   *
   *   1. Web Audio visualizer. A <audio> element playing cross-origin
   *      media (the CDN, after a redirect) is CORS-tainted, so
   *      captureStream()/createMediaElementSource() yield no samples —
   *      the frequency analyser sees silence and the visualizer never
   *      starts. By proxying the bytes through our own origin and
   *      emitting `Access-Control-Allow-Origin: *`, the media becomes
   *      CORS-clean and the analyser can read it.
   *   2. Deezer's preview URL needs a `Referer: deezer.com` header that
   *      the <audio> element can't send; we set it here server-side.
   *
   * Range requests are forwarded to the upstream and the 206 Partial
   * Content response is passed through verbatim, so seeking (dragging
   * the progress bar) keeps working.
   */
  private static readonly STREAM_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  /**
   * 实时跨平台匹配：给定当前 track 元数据，去其余已登录平台搜同名同时长的
   * 等价曲目，返回首个命中（含后端代理 src 路径）。renderer 在 code=4 时
   * 调这个端点拿到 fallback 源后直接 play()。
   *
   * 严格匹配：normalizeKey(歌名+歌手) + duration ±3s。命中优先级 qq > netease
   * > deezer > spotify（沿用 server 的 PLAY_PRIORITY）。
   *
   * 不写 liked 状态（避免和同步队列的 discover 步双写）；只读 + 返回。
   * 未登录 / 搜不到 / 异常 → 200 + { source: null }（不 404，避免 renderer 死循环）。
   */
  @Get('equivalents')
  async equivalents(
    @Query('provider') provider: string,
    @Query('title') title: string,
    @Query('artist') artist: string,
    @Query('duration') duration: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ source: SourceInfo | null }> {
    const seedProvider = normalizeProvider(provider);
    const dur = Number(duration);
    if (!title && !artist) {
      return { source: null };
    }
    const session = this.sessionService.resolve(req, res);
    const source = await this.musicService.findPlayableEquivalent(
      session,
      seedProvider,
      {
        title: title ?? '',
        artist: artist ?? '',
        duration: Number.isFinite(dur) ? dur : 0,
      },
    );
    return { source };
  }

  @Get('stream/:provider/:trackId')
  async stream(
    @Param('provider') providerParam: string,
    @Param('trackId') trackId: string,
    @Query('mm') mm: string | undefined,
    @Query('q') q: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const provider = normalizeProvider(providerParam);
    const session = this.sessionService.resolve(req, res);
    try {
      let upstream: string;
      const headers: Record<string, string> = {
        'User-Agent': MusicController.STREAM_UA,
      };
      if (provider === 'deezer') {
        upstream = await this.musicService.getStreamUrl(session, 'deezer', trackId);
        headers.Referer = 'https://www.deezer.com/';
      } else if (provider === 'spotify') {
        // Spotify 的 30s preview（p.scdn.co）对 Referer 不敏感，但也别乱塞
        // 网易云的 Referer。quality/mediaMid 对 spotify 无意义，不传。
        upstream = await this.musicService.getStreamUrl(
          session,
          'spotify',
          decodeURIComponent(trackId),
        );
        headers.Referer = 'https://open.spotify.com/';
      } else {
        const quality = (['standard', 'high', 'lossless'] as const).includes(
          q as QqQuality,
        )
          ? (q as QqQuality)
          : 'standard';
        upstream = await this.musicService.getStreamUrl(
          session,
          provider,
          decodeURIComponent(trackId),
          { mediaMid: mm, quality },
        );
        headers.Referer =
          provider === 'qq' ? 'https://y.qq.com/' : 'https://music.163.com/';
      }
      await this.proxyAudio(upstream, headers, req, res);
    } catch (err) {
      res.status(502).json({
        error: 'stream_unavailable',
        message: (err as Error).message,
      });
    }
  }

  /**
   * Fetch an upstream audio URL and pipe the bytes back to the client,
   * forwarding Range headers (so seeking works) and adding CORS headers
   * (so the Web Audio analyser can read the samples). Shared by all
   * providers.
   */
  private async proxyAudio(
    url: string,
    extraHeaders: Record<string, string>,
    req: Request,
    res: Response,
  ): Promise<void> {
    const headers: Record<string, string> = { ...extraHeaders };
    // Forward the browser's Range request so the CDN answers with a
    // 206 partial — required for smooth seeking on large FLAC/MP3.
    const range = req.headers['range'];
    if (typeof range === 'string') headers['Range'] = range;

    const upstream = await fetch(url, { headers });
    // 200 (full) and 206 (partial) are both success for media.
    if ((!upstream.ok && upstream.status !== 206) || !upstream.body) {
      res.status(502).json({
        error: 'audio_upstream_failed',
        status: upstream.status,
      });
      return;
    }

    // CORS: this is the header that unblocks the Web Audio analyser
    // for the visualizer (the renderer sets crossOrigin="anonymous").
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') ?? 'audio/mpeg',
    );
    res.setHeader('Accept-Ranges', 'bytes');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Cache-Control', 'no-cache');
    // Mirror the upstream status (206 for partial, 200 for full).
    res.status(upstream.status);

    const { Readable } = await import('stream');
    Readable.fromWeb(
      upstream.body as unknown as import('stream/web').ReadableStream,
    ).pipe(res);
  }

  /**
   * Cover-art proxy. The renderer needs to read pixel data from the
   * cover image (canvas drawImage → getImageData) so it can extract
   * the dominant colour and drive the cover-accent CSS variable that
   * tints the glass cards, progress bar, etc. The cover CDNs (QQ's
   * y.gtimg.cn in particular) don't return an Access-Control-Allow-
   * Origin header, so a browser-side fetch fails before the canvas
   * step. The image still loads fine as a CSS background-image (the
   * browser happily renders cross-origin <img>s without reading
   * pixels), but the colour-extraction path is dead.
   *
   * This route fetches the image server-side and re-emits it with
   * `Access-Control-Allow-Origin: *`, which unblocks the canvas path
   * AND lets us reuse the same URL for the CSS background — one
   * cached response, both consumers happy.
   *
   * Allowlisted to known cover CDNs so this can't be abused as a
   * generic open proxy. If we ever add a new provider with a new
   * CDN, append its host here.
   */
  private static readonly ALLOWED_COVER_HOSTS = new Set([
    'y.gtimg.cn',                       // QQ 音乐
    'p1.music.126.net',                 // 网易云音乐
    'p2.music.126.net',
    'p3.music.126.net',
    'p4.music.126.net',
    'e-cdns-images.dzcdn.net',          // Deezer
    'cdn-images.dzcdn.net',
    'i.scdn.co',                        // Spotify（专辑封面 CDN）
    'mosaic.scdn.co',                   // Spotify（歌单拼图封面）
  ]);

  @Get('cover-proxy')
  async coverProxy(
    @Query('url') url: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!url) {
      res.status(400).json({ error: 'missing_url' });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('bad_protocol');
      }
    } catch {
      res.status(400).json({ error: 'invalid_url' });
      return;
    }
    if (!MusicController.ALLOWED_COVER_HOSTS.has(parsed.hostname)) {
      res.status(403).json({
        error: 'host_not_allowed',
        host: parsed.hostname,
      });
      return;
    }
    try {
      const upstream = await fetch(parsed.toString(), {
        headers: {
          // QQ in particular 403s bare HTTP clients. A normal browser
          // UA gets through cleanly.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      if (!upstream.ok || !upstream.body) {
        res.status(502).json({
          error: 'upstream_failed',
          status: upstream.status,
        });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Content-Type',
        upstream.headers.get('content-type') ?? 'image/jpeg',
      );
      if (upstream.headers.get('content-length')) {
        res.setHeader('Content-Length', upstream.headers.get('content-length')!);
      }
      // Cover URLs for a given song ID are stable across plays, so
      // an hour of browser cache is safe and saves re-fetching on
      // every skip-back.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const { Readable } = await import('stream');
      Readable.fromWeb(
        upstream.body as unknown as import('stream/web').ReadableStream,
      ).pipe(res);
    } catch (err) {
      res.status(502).json({
        error: 'cover_proxy_failed',
        message: (err as Error).message,
      });
    }
  }

  /**
   * Fetch synced lyrics for a track. Delegates to the per-provider
   * implementation in music.service — QQ returns null (no public
   * lyric API without an app signature), NetEase parses LRC from
   * /api/song/lyric, Deezer returns unsynced plain text or LRC
   * from the public track endpoint.
   *
   * Response: { lyrics: [{time, text}, ...] } or { lyrics: null }
   * when the provider or track has no lyrics.
   */
  @Get('lyrics')
  async lyrics(
    @Query('provider') provider: string,
    @Query('trackId') trackId: string,
    @Query('sources') sources: string | undefined,
    @Query('title') title: string | undefined,
    @Query('artist') artist: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    const result = await this.musicService.getLyricsAggregated(
      session,
      normalizeProvider(provider),
      trackId ?? '',
      parseSourcesParam(sources),
      title ?? '',
      artist ?? '',
    );
    return { lyrics: result.lines, synced: result.synced, source: result.source };
  }

  /**
   * Lyrics availability probe for search-result rows. Only checks the
   * platform sources (never lyrics.ovh — probing a whole result page
   * against a third party would be abusive); results land in the same
   * server-side cache the full lyrics fetch uses.
   *
   * Query: sources=platform:trackId,platform:trackId,...
   * Response: { available: boolean, source: MusicProvider | null }
   */
  @Get('lyrics/availability')
  async lyricsAvailability(
    @Query('sources') sources: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.musicService.getLyricsAvailability(
      session,
      parseSourcesParam(sources),
    );
  }

}