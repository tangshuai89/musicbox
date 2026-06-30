import { Module } from '@nestjs/common';
import { MusicController } from './music.controller';
import { MusicService } from './music.service';
import { QqMusicProvider } from './qq.provider';
import { NeteaseMusicProvider } from './netease.provider';
import { DeezerMusicProvider } from './deezer.provider';
import { NeteaseProxy } from './netease-proxy';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [MusicController],
  providers: [
    MusicService,
    QqMusicProvider,
    NeteaseMusicProvider,
    DeezerMusicProvider,
    NeteaseProxy,
  ],
  exports: [MusicService],
})
export class MusicModule {}