import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MusicModule } from './music/music.module';

@Module({
  imports: [AuthModule, MusicModule],
})
export class AppModule {}
