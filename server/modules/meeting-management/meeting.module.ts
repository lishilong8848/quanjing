import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MeetingController } from './meeting.controller';
import { MeetingService } from './meeting.service';
import { WeeklyController } from './weekly.controller';
import { WeeklyService } from './weekly.service';
import { WeeklyGateway } from './weekly.gateway';
import { WeeklyEngine } from './weekly.engine';
import { MeetingSourcesService } from './meeting.sources.service';

@Module({
  imports: [HttpModule.register({ timeout: 10000, maxRedirects: 0 })],
  controllers: [MeetingController, WeeklyController],
  providers: [
    MeetingService,
    MeetingSourcesService,
    WeeklyService,
    WeeklyGateway,
    WeeklyEngine,
  ],
})
export class MeetingManagementModule {}
