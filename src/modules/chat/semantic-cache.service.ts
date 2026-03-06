import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { SemanticCache } from 'src/shared/entities/cache.entity';
import { Repository } from 'typeorm';
import { EmbeddingService } from 'src/shared/embedding/embedding.service';
import { MilvusService } from 'src/shared/milvus/milvus.service';
import { ChatResponse } from 'src/shared/types/rag.types';

@Injectable()
export class SemanticCacheService {
  private logger = new Logger(SemanticCacheService.name);

  //相似度阈值，这个值越接近越代表是不是同一个问题
  private readonly threshold: number;

  /**
   * 语义缓存服务
   *
   * 解决痛点：相似问题重复调 LLM，既慢又费钱。
   *
   * 原理：
   *   用户问 "NestJS 怎么连接数据库？"
   *   系统回答后，把问题的 embedding + 回答存起来。
   *   下次用户问 "NestJS 如何配置数据库连接？"（语义几乎相同），
   *   先把新问题转成 embedding，在缓存中搜索相似度 > 0.95 的记录，
   *   如果命中就直接返回缓存的回答，跳过整个 RAG 流程。
   *
   * 数据分布：
   *   MySQL (semantic_cache 表)：存问题文本、回答、来源、置信度
   *   Milvus (rag_semantic_cache)：存问题的 embedding 向量
   *   两边通过 cache_id 关联
   *
   * 在 Pipeline 中的位置：最前面
   *   用户提问 → 语义缓存查找 → 命中？→ 是：直接返回
   *                              → 否：走完整 RAG 流程 → 结果存入缓存
   */
  constructor(
    @InjectRepository(SemanticCache)
    private semanticCacheRepo: Repository<SemanticCache>,
    private configService: ConfigService,
    private embeddingService: EmbeddingService,
    private milvusService: MilvusService,
  ) {
    this.threshold = this.configService.get('SEMANTIC_CACHE_THRESHOLD', 0.95);
  }

  //查找缓存--判断这个问题和之前某个问题是否一样
  async lookUp(question: string): Promise<ChatResponse | null> {
    try {
      //把问题转换成向量数据
      const questionVector = await this.embeddingService.embedText(question);

      //在mulvus缓存集合中搜索最详细的问题
      const hit = await this.milvusService.searchCache(
        questionVector,
        this.threshold,
      );
      if (!hit) return null;

      //命中，从mysql中查看完整的回答
      const cached = await this.semanticCacheRepo.findOne({
        where: { id: hit.cacheId },
      });
      if (!cached) {
        //milvus有但是mysql中没有值，导致数据不一致，直接清理mulvus
        await this.milvusService.deleteCacheVector(hit.cacheId);
        return null;
      }
      //检查是否过期
      if (cached.expiresAt && cached.expiresAt < new Date()) {
        this.logger.log(`缓存过期: ${cached.id}`);
        await this.invalidate(hit.cacheId);
        return null;
      }
      this.logger.log('语义缓存命中: ${cached.id}');

      return {
        answer: cached.answer,
        sources: cached.sources || [],
        confidence: cached.confidence || 1.0,
        isHallucination: cached.isHallucination || false,
        cached: true,
      };
    } catch (e) {
      this.logger.error(`语义缓存查找失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 存入缓存 — RAG 流程完成后调用
   *
   * 同时写入 MySQL（文本数据）和 Milvus（问题向量）
   *
   * @param question   用户问题
   * @param response   完整的 ChatResponse
   * @param ttlMinutes 缓存有效期（分钟），默认 60 分钟
   */
  async store(question, response, ttlMinutes = 60) {
    try {
      const questionVector = await this.embeddingService.embedText(question);

      //计算过期时间
      const exporeAt = new Date();
      exporeAt.setMinutes(exporeAt.getMinutes() + ttlMinutes);

      //写入mysql
      const cache = this.semanticCacheRepo.create({
        answer: response.answer,
        question,
        sources: response.sources,
        confidence: response.confidence,
        isHallucination: response.isHallucination,
        tokenUsage: response.tokenUsage,
        expiresAt: exporeAt,
      });
      const saved = await this.semanticCacheRepo.save(cache);

      //写入mulvus cache.id是关键,缓存集合只存储问题的向量数据和mysql表中对应的cacheid，方便进行后续查找
      await this.milvusService.insertCacheVector(saved.id, questionVector);

      this.logger.log(`语义缓存存储成功: ${saved.id}`);
    } catch (e) {
      this.logger.warn(`语义缓存存储失败: ${e.message}`);
    }
  }

  //清除指定的缓存
  async invalidate(cacheId: string) {
    if (cacheId) {
      await this.semanticCacheRepo.delete(cacheId);
      await this.milvusService.deleteCacheVector(cacheId);
    }
  }
}
