import { Module } from '@nestjs/common';
import { OperationsKbController } from '@server/modules/operations-kb/operations-kb.controller';
import { OperationsKbService } from '@server/modules/operations-kb/operations-kb.service';

@Module({
  controllers: [OperationsKbController],
  providers: [OperationsKbService],
})
export class OperationsKbModule {}
