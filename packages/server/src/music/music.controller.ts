import { Controller, Get, Post, Param } from '@nestjs/common';
import { MusicService } from './music.service';

@Controller('music')
export class MusicController {
  constructor(private readonly musicService: MusicService) {}

  @Get('next')
  getNextTrack() {
    return this.musicService.getNextTrack();
  }

  @Post('like/:trackId')
  likeTrack(@Param('trackId') trackId: string) {
    return this.musicService.likeTrack(trackId);
  }

  @Get('liked')
  getLikedTracks() {
    return this.musicService.getLikedTracks();
  }
}
