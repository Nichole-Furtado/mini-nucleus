import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { SlaProcessor } from './sla.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'sla' })],
  controllers: [TicketsController],
  providers: [TicketsService, SlaProcessor],
})
export class TicketsModule {}
