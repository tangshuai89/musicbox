import 'dotenv/config';
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
  console.log(`Server running on http://localhost:${cfg.port}`);
}
bootstrap();