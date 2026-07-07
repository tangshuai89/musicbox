import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MusicModule } from './music/music.module';
import { CommonModule } from './common/common.module';
import { RecoModule } from './reco/reco.module';

@Module({
  imports: [CommonModule, AuthModule, MusicModule, RecoModule],
})
export class AppModule {}