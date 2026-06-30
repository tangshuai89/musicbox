import { Module, Global } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { QqOAuthStrategy } from './qq.strategy';
import { NeteaseAuthStrategy } from './netease-auth.strategy';
import { CommonModule } from '../common/common.module';

@Global()
@Module({
  imports: [CommonModule],
  controllers: [AuthController],
  providers: [QqOAuthStrategy, NeteaseAuthStrategy],
  exports: [QqOAuthStrategy, NeteaseAuthStrategy],
})
export class AuthModule {}