import { Module } from '@nestjs/common';
import { MusicController } from './music.controller';
import { MusicService } from './music.service';
import { QqMusicProvider } from './qq.provider';
import { NeteaseMusicProvider } from './netease.provider';
import { DeezerMusicProvider } from './deezer.provider';
import { SpotifyMusicProvider } from './spotify.provider';
import { CommonModule } from '../common/common.module';
import { MatchService } from '../match/match.service';
import { LikeSyncQueue } from './like-sync.queue';

@Module({
  imports: [CommonModule],
  controllers: [MusicController],
  providers: [
    MusicService,
    MatchService,
    LikeSyncQueue,
    QqMusicProvider,
    NeteaseMusicProvider,
    DeezerMusicProvider,
    SpotifyMusicProvider,
  ],
  exports: [MusicService, MatchService, SpotifyMusicProvider],
})
export class MusicModule {}