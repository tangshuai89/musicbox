import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MusicModule } from './music/music.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [CommonModule, AuthModule, MusicModule],
})
export class AppModule {}