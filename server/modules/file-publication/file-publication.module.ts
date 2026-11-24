import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { FilePublicationController } from './file-publication.controller';
import { FilePublicationGateway } from './file-publication.gateway';
import { FilePublicationRecordsController } from './file-publication-records.controller';
import { FilePublicationRecordsService } from './file-publication-records.service';
import { FilePublicationService } from './file-publication.service';
import { FilePublicationStore } from './file-publication.store';

@Module({
  imports: [HttpModule.register({ timeout: 15_000, maxRedirects: 0 })],
  controllers: [FilePublicationController, FilePublicationRecordsController],
  providers: [FilePublicationGateway, FilePublicationService, FilePublicationRecordsService, FilePublicationStore],
})
export class FilePublicationModule {}
