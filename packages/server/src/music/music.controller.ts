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
import { MusicService } from './music.service';
import { normalizeProvider, MusicProvider } from '../common/provider';
import { SessionService } from '../common/session';
import { DeezerMusicProvider } from './deezer.provider';
import { QqQuality } from './qq.provider';
import type { FanOutLikeResponse } from './types';

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
    );
  }

  @Post('like/:trackId')
  async like(
    @Param('trackId') trackId: string,
    @Query('provider') provider: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.musicService.toggleLike(
      session,
      normalizeProvider(provider),
      trackId,
    );
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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    const lyrics = await this.musicService.getLyrics(
      session,
      normalizeProvider(provider),
      trackId ?? '',
    );
    return { lyrics };
  }

}