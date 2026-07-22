import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { ConfigService } from './common/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const cfg = app.get(ConfigService);

  app.use(cookieParser(cfg.sessionSecret));
  app.enableCors({
    origin: cfg.rendererOrigins,
    credentials: true,
  });

  await app.listen(cfg.port);
  // 用 NestJS Logger 而非 console.log（项目约定：日志统一走 Logger）。
  new Logger('Bootstrap').log(`Server running on http://localhost:${cfg.port}`);
}
bootstrap();