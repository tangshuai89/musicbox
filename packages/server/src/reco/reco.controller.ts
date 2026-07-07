import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RecoService } from './reco.service';
import { SessionService } from '../common/session';

@Controller('reco')
export class RecoController {
  constructor(
    private readonly reco: RecoService,
    private readonly sessionService: SessionService,
  ) {}

  /** 当前是否已设 DeepSeek key + 库规模。给前端 UI 决定按钮是否可点。 */
  @Get('status')
  status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = this.sessionService.resolve(req, res);
    return this.reco.status(session);
  }

  /** 跑一次推荐。 */
  @Post('run')
  async run(
    @Body() body: { count?: number; language?: string; mood?: string } = {},
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = this.sessionService.resolve(req, res);
    return this.reco.run(session, body ?? {});
  }

  /** 写 key 到 .storage/secrets.json。 */
  @Post('key')
  async saveKey(
    @Body() body: { apiKey?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.apiKey || typeof body.apiKey !== 'string') {
      throw new BadRequestException('apiKey 必填');
    }
    return this.reco.setApiKey(body.apiKey);
  }
}
