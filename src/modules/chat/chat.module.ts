import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RetrievalService } from './retrieval.service';
import { GeneratorService } from './generator.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from 'src/shared/entities/chunk.entity';
import { Document } from 'src/shared/entities/document.entity';
import { DocumentModule } from '../document/document.module';
import { QwenLLMService } from 'src/shared/llm/qwen-llm.service';

@Module({
  imports: [TypeOrmModule.forFeature([Chunk, Document]), DocumentModule],
  controllers: [ChatController],
  providers: [ChatService, RetrievalService, GeneratorService, QwenLLMService],
  exports: [],
})
export class ChatModule {}
