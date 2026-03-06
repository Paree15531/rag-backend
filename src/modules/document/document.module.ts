import { Module } from '@nestjs/common';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from 'src/shared/entities/document.entity';
import { Chunk } from 'src/shared/entities/chunk.entity';
import { ChunkService } from './chunk.service';
import { IngestionService } from './Ingestion.service';
import { MilvusService } from 'src/shared/milvus/milvus.service';
import { DocumentParseService } from './document-parse.service';
import { EmbeddingService } from 'src/shared/embedding/embedding.service';
import { BM25Service } from 'src/shared/milvus/bm25.service';

/**
 * 文档模块
 *
 * 组装文档管道的所有组件：
 * - Controller: 处理 HTTP 请求
 * - DocumentService: 文档 CRUD + 业务逻辑
 * - DocumentParserService: 文件解析（PDF/DOCX/MD/TXT）
 * - ChunkingService: 智能分块
 * - IngestionService: 入库编排（解析→分块→向量化→存储）
 *
 * EmbeddingService 和 MilvusService 来自全局的 SharedModule，无需再次导入。
 *
 * TypeOrmModule.forFeature([Document, Chunk])：
 * 注册这两个实体的 Repository，让 Service 中可以通过
 * @InjectRepository(Document) 注入来操作数据库。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Document, Chunk])],
  controllers: [DocumentController],
  providers: [
    DocumentService,
    ChunkService,
    IngestionService,
    MilvusService,
    DocumentParseService,
    EmbeddingService,
    BM25Service,
  ],
  exports: [
    DocumentService,
    ChunkService,
    IngestionService,
    MilvusService,
    DocumentParseService,
    EmbeddingService,
    BM25Service,
  ],
})
export class DocumentModule {}
