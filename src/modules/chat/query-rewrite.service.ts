import { Injectable, Logger } from '@nestjs/common';
import { QwenLLMService } from 'src/shared/llm/qwen-llm.service';
import { ChatMessage } from 'src/shared/types/rag.types';

/**
 * 查询改写服务
 *
 * 解决多轮对话中的代词歧义问题。
 *
 * 场景：
 *   用户第一轮问："NestJS 怎么连接数据库？"
 *   用户第二轮问："它支持哪些 ORM？"
 *   → "它" 指的是 NestJS，但如果直接检索"它支持哪些 ORM？"，
 *     向量检索会漏掉 NestJS 相关的文档块。
 *
 * 改写后："NestJS 支持哪些 ORM？"
 *   → 检索精度大幅提升。
 *
 * 触发条件：
 *   - 有对话历史（多轮对话）
 *   - 当前问题包含代词（这、它、他、她、那、this、it、that、he、she、they）
 *
 * 实现方式：LLM-as-rewriter
 *   - 把对话历史 + 当前问题一起交给 LLM（judge 模式，temperature=0）
 *   - 让 LLM 改写成不依赖上下文的独立问句
 *   - 改写失败时回退到原始问题，保证流程不中断
 */
@Injectable()
export class QueryRewriteService {
  private readonly logger = new Logger(QueryRewriteService.name);

  constructor(private readonly llmService: QwenLLMService) {}

  /**
   * 改写用户问题
   *
   * @param question  用户当前输入的问题
   * @param history   对话历史（最近 N 轮）
   * @returns         改写后的问题（或原始问题，若不需要改写）
   */
  async rewrite(question: string, history: ChatMessage[]): Promise<string> {
    if (!history || history.length === 0) {
      return question;
    }

    // 检测代词：中文（这、它、他、她、那）+ 英文（this、it、that、he、she、they、them）
    const pronounPattern =
      /\b(this|it|that|he|she|they|them)\b|[这它他她那]/i;
    if (!pronounPattern.test(question)) {
      return question;
    }

    // 只取最近 3 轮（6 条消息），避免 prompt 过长
    const recentHistory = history.slice(-6);
    const historyText = recentHistory
      .map((msg) => `${msg.role === 'user' ? '用户' : 'AI'}: ${msg.content}`)
      .join('\n');

    const prompt = `根据以下对话历史，将用户的最新问题改写成一个独立完整的问题（不需要上下文也能理解）。只返回改写后的问题，不要任何解释。

对话历史：
${historyText}

当前问题：${question}

改写后的问题：`;

    try {
      const rewritten = await this.llmService.judge(prompt);
      const trimmed = rewritten.trim();
      if (trimmed) {
        this.logger.log(`查询改写: "${question}" → "${trimmed}"`);
        return trimmed;
      }
    } catch (e) {
      this.logger.warn(`查询改写失败，使用原始问题: ${e.message}`);
    }

    return question;
  }
}
