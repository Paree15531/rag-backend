import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Document, DocumentStatus } from 'src/shared/entities/document.entity';
import { Chunk } from 'src/shared/entities/chunk.entity';
import { Repository } from 'typeorm';
import { DocumentParseService } from './document-parse.service';
import { ChunkService } from './chunk.service';
import { EmbeddingService } from 'src/shared/embedding/embedding.service';
import { MilvusService } from 'src/shared/milvus/milvus.service';
import { Document as LCDocument } from '@langchain/core/documents';
import { BM25Service } from 'src/shared/milvus/bm25.service';

/**
 * 文档入库编排服务
 *
 * 串联整个文档管道：
 *
 *   文件路径
 *     ↓
 *   1. DocumentParserService.parse()      → LCDocument[]（粗粒度，按页/段）
 *     ↓
 *   2. ChunkingService.chunk()            → LCDocument[]（细粒度，每块约 512 字符）
 *     ↓
 *   3. EmbeddingService.embedBatch()      → number[][]（每块对应一个 1024 维向量）
 *     ↓
 *   4. MySQL: 保存 pageContent + metadata → 后续查询要用原文
 *      Milvus: 保存 embedding 向量        → 后续检索要用向量
 *     ↓
 *   5. 更新文档 status = 'ready'
 *
 * 全程使用 LangChain 的 Document 对象传递，
 * metadata（页码、文件名等）自动从解析层流转到分块层，不需要手动搬运。
 */
/**
 * 文档入库编排服务
 *
 * 入库时同时生成两种向量：
 *   EmbeddingService → dense 向量（语义匹配）
 *   BM25Service      → sparse 向量（关键词匹配）
 *   两者一起存入 Milvus，混合检索时两路同时搜。
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  /**
   * Embedding 批处理大小
   * DashScope 的 embedding 接口有请求大小限制，
   * 一次传太多文本可能超限或超时，所以分批处理。
   * 每批 20 个块是一个安全的值。
   */
  private readonly EMBEDDING_BATCH_SIZE = 20;

  @InjectRepository(Document)
  private documentDto: Repository<Document>;

  @InjectRepository(Chunk)
  private chunkDto: Repository<Chunk>;

  constructor(
    private parserService: DocumentParseService,
    private chunkingService: ChunkService,
    private embeddingService: EmbeddingService,
    private milvusService: MilvusService,
    private bm25Service: BM25Service,
  ) {}

  /**
   * 执行完整入库流程
   *
   * @param document  MySQL 中的文档记录（status=pending）
   */

  async ingest(document: Document) {
    try {
      await this.updateStatus(document.id, DocumentStatus.PROCESSING);
      this.logger.log('开始插入文档' + document.filename);

      // Step 1: 解析 — 文件 → LangChain Document[]
      const parsedDocs = await this.parserService.parse(
        document.filename,
        document.filePath,
      );

      // Step 2: 分块 — 粗粒度 Document[] → 细粒度 Document[]
      const chunks = await this.chunkingService.chunk(parsedDocs);

      //bm25学习这批文本的词表
      const allTexts = chunks.map((document) => document.pageContent);
      this.bm25Service.fit(allTexts);
      this.logger.log('BM25词表学习完成');

      // Step 3: 向量化 + 存储（分批）
      await this.embedAndStore(document.id, chunks);

      // Step 4: 更新文档状态
      await this.documentDto.update(document.id, {
        status: DocumentStatus.READY,
        chunkCount: chunks.length,
      });
    } catch (e) {
      this.logger.log('入库失败' + document.filename, e);
      await this.updateStatus(document.id, DocumentStatus.FAILED, e.message);
      throw e;
    }
  }

  /**
   * 分批做向量化 + 双端存储
   *
   * 每批处理 EMBED_BATCH_SIZE 个块：
   * 1. 取这批块的 pageContent 做批量 embedding
   * 2. 把文本 + metadata 写入 MySQL（拿到自动生成的 chunk.id）
   * 3. 把向量 + chunk.id 写入 Milvus
   */
  private async embedAndStore(documentId: string, chunks: LCDocument[]) {
    for (let i = 0; i < chunks.length; i += this.EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + this.EMBEDDING_BATCH_SIZE);
      const batchNum = Math.floor(i / this.EMBEDDING_BATCH_SIZE) + 1;
      this.logger.log(`正在处理第${batchNum}批，共${chunks.length}批`);

      //批量向量化
      const texts = batch.map((doc) => doc.pageContent);

      //并行生成两种向量
      const [embeddings, sparseEmbeddings] = await Promise.all([
        this.embeddingService.embedBatch(texts),
        this.bm25Service.textToSparseBatch(texts),
      ]);

      //写入mysql
      const savedChunks: Chunk[] = [];
      for (let j = 0; j < batch.length; j++) {
        const lcDoc = batch[j];

        //创建chunk实例对象存入数据
        const chunk = this.chunkDto.create({
          documentId,
          content: lcDoc.pageContent,
          /**
           * 从 LangChain metadata 中提取页码：
           * PDFLoader 设置为 loc.pageNumber（从 0 开始，+1 转为从 1 开始）
           * 其他 Loader 可能没有此字段
           */
          pageNumber: lcDoc?.metadata?.loc?.pageNumber
            ? lcDoc.metadata.loc.pageNumber + 1
            : null,
          chunkIndex: i + j,
          sectionTitle: lcDoc.metadata?.sectionTitle || null,
          metadata: lcDoc.metadata,
        });
        //将数据存入mysql中,返回的数据会生成一个chunkid，这个chunkid放到mysql中，milvus中也需要存一份，保证向量数据喝mysql中的id对应的上
        const savedChunk = await this.chunkDto.save(chunk);
        savedChunks.push(savedChunk);
      }
      //写入milvus-chun.id作为关联键
      const milvusData = savedChunks.map((chunk, j) => {
        return {
          chunkId: chunk.id,
          embedding: embeddings[j],
          sparseEmbedding: sparseEmbeddings[j],
        };
      });
      await this.milvusService.insertChunkVectors(milvusData);
    }
  }

  //更新文件状态
  private async updateStatus(
    id: string,
    status: DocumentStatus,
    error?: string,
  ) {
    await this.documentDto.update(id, {
      status,
      error: error || '',
    });
  }
}
