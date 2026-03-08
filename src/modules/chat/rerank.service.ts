import { Injectable, Logger } from '@nestjs/common';
import { QwenLLMService } from 'src/shared/llm/qwen-llm.service';
import { RetrievedChunk } from 'src/shared/types/rag.types';

/**
 * LLM 重排序服务
 *
 * 解决痛点：向量相似度不等于业务相关度
 *
 * 向量检索（dense + sparse）基于统计相似度，但存在以下局限：
 * - 同义词/近义词的语义相似度不稳定
 * - 跨语言场景的检索偏差
 * - 长文本块的相关度计算不准确
 *
 * LLM 重排序通过直接理解问题和文档语义，给出更精准的相关度评分，
 * 作为向量检索之后的精细过滤步骤。
 *
 * 代价：每个 chunk 都需要一次 LLM 调用，延迟较高。
 * 适用场景：topK 较小（≤10）、对精度要求高的场景。
 * 生产建议：可替换为 Cross-Encoder 模型（如 BGE-Reranker）以降低延迟和成本。
 *
 * 在 Pipeline 中的位置：混合检索之后，LLM 生成之前
 *   混合检索（top-20）→ LLM 重排序 → 取 top-K → LLM 生成
 */
@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);

  constructor(private readonly llmService: QwenLLMService) {}

  /**
   * 对检索结果重排序
   *
   * @param question  用户问题
   * @param chunks    待重排序的文档块列表
   * @param topK      重排后返回的数量，默认 3
   * @returns         重排后的 top-K 文档块（按相关度从高到低）
   */
  async rerank(
    question: string,
    chunks: RetrievedChunk[],
    topK: number = 3,
  ): Promise<RetrievedChunk[]> {
    if (chunks.length === 0) return [];
    if (chunks.length <= topK) return chunks;

    this.logger.log(
      `开始 LLM 重排序: ${chunks.length} 个候选 → top-${topK}`,
    );

    // 并行评分：每个 chunk 独立调用一次 LLM
    const scored = await Promise.all(
      chunks.map(async (chunk, index) => {
        const score = await this.scoreChunk(question, chunk, index);
        return { ...chunk, rerankScore: score };
      }),
    );

    // 按重排分数从高到低排序，取 top-K
    const reranked = scored
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
      .slice(0, topK);

    this.logger.log(
      `重排序完成，top-1 分数: ${reranked[0]?.rerankScore?.toFixed(2)}`,
    );

    return reranked;
  }

  /**
   * 用 LLM 给单个文档块打分
   *
   * @returns 相关度分数，0-10 的整数
   */
  private async scoreChunk(
    question: string,
    chunk: RetrievedChunk,
    index: number,
  ): Promise<number> {
    const prompt = `请评估以下文档片段与问题的相关程度，返回 0-10 的整数分值，只返回数字，不要任何解释。

问题：${question}

文档片段（截取前 500 字符）：
${chunk.content.slice(0, 500)}

相关度分值（0=完全不相关，10=高度相关）：`;

    try {
      const response = await this.llmService.judge(prompt);
      const score = parseInt(response.trim(), 10);
      if (!isNaN(score)) {
        return Math.min(10, Math.max(0, score));
      }
    } catch (e) {
      this.logger.warn(`chunk[${index}] 重排评分失败: ${e.message}`);
    }

    // 评分失败时使用原始向量相似度分数（归一化到 0-10）
    return Math.round((chunk.score || 0) * 10);
  }
}
