import { Module, Global } from '@nestjs/common';
import { ConfigService } from './config';
import { StorageService } from './storage';
import { SessionService } from './session';

@Global()
@Module({
  providers: [ConfigService, StorageService, SessionService],
  exports: [ConfigService, StorageService, SessionService],
})
export class CommonModule {}