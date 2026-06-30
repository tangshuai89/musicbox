import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { MusicService } from './music.service';
import { normalizeProvider, MusicProvider } from '../common/provider';
import { SessionService, Session } from '../common/session';
import { DeezerMusicProvider } from './deezer.provider';

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
   * List the Deezer editorial charts we expose to the UI. The renderer
   * fetches this once on first Deezer session to populate the preset
   * picker.
   */
  @Get('deezer/editorials')
  deezerEditorials() {
    return { items: DeezerMusicProvider.getEditorials() };
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
   * Audio stream proxy. The browser's <audio> tag loads this URL.
   *
   * QQ / NetEase:  the upstream URL is a freshly-signed CDN link that
   *   expires in minutes. We 302-redirect there.
   *
   * Deezer:        the upstream is a hot-linkable preview URL, BUT it
   *   carries an `hdnea=…` signature that requires a `Referer: https://
   *   www.deezer.com/` header to be honoured. Audio elements don't
   *   send Referer, so the cross-origin request returns nothing useful
   *   from the renderer. We instead fetch the bytes server-side (where
   *   we can set the Referer) and stream them back with proper headers.
   */
  @Get('stream/:provider/:trackId')
  async stream(
    @Param('provider') providerParam: string,
    @Param('trackId') trackId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const provider = normalizeProvider(providerParam);
    const session = this.sessionService.resolve(req, res);
    try {
      if (provider === 'deezer') {
        await this.streamDeezer(session, trackId, res);
        return;
      }
      const upstream = await this.musicService.getStreamUrl(
        session,
        provider,
        decodeURIComponent(trackId),
      );
      res.redirect(302, upstream);
    } catch (err) {
      res.status(502).json({
        error: 'stream_unavailable',
        message: (err as Error).message,
      });
    }
  }

  /**
   * Fetch the Deezer preview URL with the right Referer, then stream
   * the bytes back to the renderer. The Deezer CDN enforces the hdnea
   * signature against the Referer header; setting it to the deezer.com
   * homepage is the documented way to make cross-origin consumers work.
   */
  private async streamDeezer(
    session: Session,
    trackId: string,
    res: Response,
  ): Promise<void> {
    const url = await this.musicService.getStreamUrl(session, 'deezer', trackId);
    const upstream = await fetch(url, {
      headers: {
        Referer: 'https://www.deezer.com/',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({
        error: 'deezer_upstream_failed',
        status: upstream.status,
      });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length')!);
    }
    res.setHeader('Cache-Control', 'no-cache');
    // Pipe the upstream ReadableStream straight to the renderer.
    const { Readable } = await import('stream');
    Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream).pipe(res);
  }
}