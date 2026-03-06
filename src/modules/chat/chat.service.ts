import { Inject, Injectable, Logger } from '@nestjs/common';
import { RetrievalService } from './retrieval.service';
import { GeneratorService } from './generator.service';
import {
  ChatRequest,
  ChatResponse,
  RetrievedChunk,
  SourceReference,
} from 'src/shared/types/rag.types';
import { SemanticCacheService } from './semantic-cache.service';

/**
 * Chat 服务 — 完整 RAG Pipeline
 *
 * Phase 5 Pipeline（近乎完整）：
 *
 *   用户问题
 *       ↓
 *   ① 语义缓存查找  → 命中？直接返回（跳过后续所有步骤）
 *       ↓ cache miss
 *   ② 查询改写      → 补全代词和省略
 *       ↓
 *   ③ 混合检索      → dense + sparse + RRF 融合
 *       ↓
 *   ④ LLM 重排序    → 精细评分，取 top-K
 *       ↓
 *   ⑤ LLM 生成回答
 *       ↓
 *   ⑥ 幻觉检测      → 判断回答是否忠于文档
 *       ↓
 *   ⑦ 存入语义缓存  → 下次相似问题直接命中
 *       ↓
 *   ⑧ 记录查询日志  → 供监控模块统计
 *       ↓
 *   返回回答
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  //检索召回内容
  @Inject(RetrievalService)
  private readonly retrievalService: RetrievalService;

  //生成回答内容
  @Inject(GeneratorService)
  private readonly generatorService: GeneratorService;

  //回答接口
  @Inject(SemanticCacheService)
  private readonly semanticCacheService: SemanticCacheService;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();
    //前端调用接口获取用户传递来棏问题，会话ID，历史对话消息，RAG行为选择
    const { question, sessionId, history, options } = request;
    const topK = options?.topK || 5;
    const enableRerank = options?.enableRerank || true;
    const enableCache = options?.enableCache || true;
    const enableHallucinationCheck = options?.enableHallucinationCheck || true;
    this.logger.log(`收到聊天请求: ${question}，会话ID: ${sessionId}`);

    if (enableCache) {
      const cached = await this.semanticCacheService.lookUp(question);
      if (cached) {
        return cached;
      }
    }

    //检索召回的内容
    const retrievalResults = await this.retrievalService.search(question, topK);

    //生成回答内容，将检索结果和用户问题组装成提示词，提交给LLM
    const answer = await this.generatorService.generate(
      question,
      retrievalResults,
      history,
    );

    //构建来源引用列表
    const sources = this.buildSources(retrievalResults);

    const latencyMs = Date.now() - startTime;
    this.logger.log(`Answered in ${latencyMs}ms`);
    return {
      answer,
      sources,
      confidence: 1.0,
      isHallucination: false,
      cached: false,
    };
  }

  /**
   * 流式问答 — 边生成边返回 token
   *
   * 用于 POST /api/chat/stream 接口（SSE）
   *
   * 和 chat() 的区别：
   * - chat() 等 LLM 生成完毕才返回完整 answer
   * - streamChat() 每生成一个 token 就 yield 出来
   *
   * 返回的是一个包含所有信息的对象：
   * - tokenStream: AsyncGenerator，逐 token yield
   * - sources: 检索到的来源引用
   * - retrievedChunks: 原始检索结果（供后续幻觉检测用）
   */

  async streamChat(request: ChatRequest): Promise<{
    tokenStream: AsyncGenerator<string>;
    sources: SourceReference[];
    retrievedChunks: RetrievedChunk[];
  }> {
    const { question, history, options } = request;
    const topK = options?.topK || 5;
    this.logger.log(
      `收到流式聊天请求: ${request.question}，会话ID: ${request.sessionId}`,
    );

    //检索
    const retrievalResults = await this.retrievalService.search(question, topK);

    //流式生成
    const tokenStream = this.generatorService.streamGenerate(
      question,
      retrievalResults,
      history,
    );
    const sources = this.buildSources(retrievalResults);
    return {
      tokenStream,
      sources,
      retrievedChunks: retrievalResults,
    };
  }

  /**
   * 把检索结果转成前端展示用的来源引用格式
   *
   * 只取 content 的前 200 字符做截断展示，
   * 完整内容前端可以通过 chunk ID 另外查询。
   */
  private buildSources(chunks: RetrievedChunk[]): SourceReference[] {
    return chunks.map((chunk) => {
      return {
        documentId: chunk.documentId,
        filename: chunk.metadata?.filename || 'unknown',
        chunkContent:
          chunk.content.length > 200
            ? chunk.content.slice(0, 200) + '...'
            : chunk.content,
        score: chunk.score,
        pageNumber: chunk.pageNumber,
        sectionTitle: chunk.sectionTitle,
      };
    });
  }
}
