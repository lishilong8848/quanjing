import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { OperationsToolsController } from './operations-tools.controller';
import { OperationsToolsService } from './operations-tools.service';

@Module({
  imports: [HttpModule.register({ timeout: 15000, maxRedirects: 0 })],
  controllers: [OperationsToolsController],
  providers: [OperationsToolsService],
})
export class OperationsToolsModule {}
