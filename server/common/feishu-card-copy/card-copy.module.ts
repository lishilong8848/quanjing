import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FeishuCardCopyService } from './card-copy.service';

@Global()
@Module({ imports: [HttpModule], providers: [FeishuCardCopyService], exports: [FeishuCardCopyService] })
export class FeishuCardCopyModule {}
