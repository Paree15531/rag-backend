import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EmbeddingService } from 'src/shared/embedding/embedding.service';
import { Chunk } from 'src/shared/entities/chunk.entity';
import { Document } from 'src/shared/entities/document.entity';
import { MilvusService } from 'src/shared/milvus/milvus.service';
import { RetrievedChunk } from 'src/shared/types/rag.types';
import { Repository, In } from 'typeorm';
import { BM25Service } from 'src/shared/milvus/bm25.service';

/**
 * 检索服务 — Milvus 混合检索
 *
 * 流程：
 *   用户问题
 *     ├→ EmbeddingService → dense 向量
 *     └→ BM25Service      → sparse 向量
 *           ↓
 *     Milvus.hybridSearch(dense, sparse)
 *       → 内部 RRF 融合 → chunk_id 列表
 *           ↓
 *     MySQL 查完整内容
 */

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  @InjectRepository(Chunk)
  private chunkRepo: Repository<Chunk>;

  @InjectRepository(Document)
  private documentRepo: Repository<Document>;

  @Inject(EmbeddingService)
  private embeddingService: EmbeddingService;

  @Inject(BM25Service)
  private bm25Service: BM25Service;

  @Inject(MilvusService)
  private milvusService: MilvusService;

  constructor() {}

  /**
   * 向量检索 — Phase 3 的主方法
   *
   * @param query      用户的问题文本
   * @param topK       返回最相关的 K 个结果，默认 5
   * @param threshold  相似度阈值，低于此值的结果过滤掉，默认 0.3
   * @returns          按相关度从高到低排序的文档块数组
   */
  // async search(query: string, topK: number = 5, threshold: number = 0.3) {
  //   //将用户的问题向量化
  //   const queryVector = await this.embeddingService.embedText(query);
  //   this.logger.log(`用户的: ${JSON.stringify(topK)},${threshold}`);
  //   //去向量数据库搜索最相似的向量,返回chunk_id 和 score
  //   const milvusResults = await this.milvusService.searchChunks(
  //     queryVector,
  //     topK,
  //   );

  //   if (milvusResults.length === 0) {
  //     this.logger.log(`没有检索到向量数据`);
  //     return [];
  //   }

  //   //过滤低于阈值的向量结果
  //   const filterResult = milvusResults.filter((item) => item.score > threshold);

  //   if (milvusResults.length === 0) {
  //     this.logger.warn(
  //       `All ${milvusResults.length} results below threshold ${threshold}`,
  //     );
  //     return [];
  //   }

  //   //用chunk_id列表返回mysql的对应的数据
  //   const chunkIds = filterResult.map((item) => item.chunkId);
  //   //从关系数据库中查询出id关联的原文
  //   const chunks = await this.chunkRepo.find({
  //     where: { id: In(chunkIds) },
  //   });

  //   //将chunkid和score的映射关系建立起来
  //   const chunkIdToScore = new Map<string, number>();
  //   filterResult.forEach((item) =>
  //     chunkIdToScore.set(item.chunkId, item.score),
  //   );

  //   //查询出这些chunk所属的document文档
  //   const docIds = [...new Set(chunks.map((item) => item.documentId))];
  //   const documents = await this.documentRepo.find({
  //     where: {
  //       id: In(docIds),
  //     },
  //   });
  //   const docMap = new Map<string, Document>();
  //   documents.forEach((item) => docMap.set(item.id, item));

  //   //拼装成RetrievedChunk，按照score从高到低进行排序
  //   const results: RetrievedChunk[] = chunks
  //     .map((chunk) => {
  //       return {
  //         id: chunk.id,
  //         content: chunk.content,
  //         score: chunkIdToScore.get(chunk.id) || 0,
  //         documentId: chunk.documentId,
  //         sectionTitle: chunk.sectionTitle,
  //         pageNumber: chunk.pageNumber,
  //         chunkIndex: chunk.chunkIndex,
  //         metadata: {
  //           ...chunk.metadata,
  //           filename: docMap.get(chunk.documentId)?.filename,
  //         },
  //       };
  //     })
  //     .sort((a, b) => b.score - a.score);
  //   this.logger.log(
  //     `检索到${results.length}个结果，top${topK}个，阈值${threshold}`,
  //   );
  //   return results;
  // }

  //混合向量检索
  async hybridSearch(
    query: string,
    topK: number = 5,
  ): Promise<RetrievedChunk[]> {
    //同时生成两种查询向量
    const [desenVector, sparseVector] = await Promise.all([
      this.embeddingService.embedText(query),
      Promise.resolve(this.bm25Service.textToSparse(query)),
    ]);
    // this.logger.log(`Dense Vector: ${JSON.stringify(desenVector)}`);
    this.logger.log(`Sparse Vector: ${JSON.stringify(sparseVector)}`);

    //进行混合检索
    const milvusResults = await this.milvusService.hybirdSearchChunks(
      desenVector,
      sparseVector,
    );

    if (milvusResults.length === 0) {
      this.logger.log('没有检索到向量数据');
      return [];
    }

    //去mysql中查询完整数据
    const chunkIds = milvusResults.map((item) => item.chunkId);
    const chunks = await this.chunkRepo.find({
      where: { id: In(chunkIds) },
    });

    const scoreMap = new Map<string, number>();
    milvusResults.forEach((item) => {
      scoreMap.set(item.chunkId, item.score);
    });
    // 查文档信息
    const docIds = [...new Set(chunks.map((c) => c.documentId))];
    const documents = await this.documentRepo.find({
      where: { id: In(docIds) },
    });
    const docMap = new Map<string, Document>();
    documents.forEach((d) => docMap.set(d.id, d));

    const results: RetrievedChunk[] = chunks
      .map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        score: scoreMap.get(chunk.id) || 0,
        documentId: chunk.documentId,
        sectionTitle: chunk.sectionTitle,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        metadata: {
          ...chunk.metadata,
          filename: docMap.get(chunk.documentId)?.filename,
        },
      }))
      .sort((a, b) => b.score - a.score);

    this.logger.log(
      `Hybrid search: ${results.length} results (top: ${results[0]?.score?.toFixed(4)})`,
    );
    return results;
  }
  async search(query: string, topK: number = 5): Promise<RetrievedChunk[]> {
    return this.hybridSearch(query, topK);
  }
}
