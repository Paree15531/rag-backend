import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from 'src/shared/embedding/embedding.service';
import { RetrievedChunk } from 'src/shared/types/rag.types';
import { QwenLLMService } from 'src/shared/llm/qwen-llm.service';

/**
 * 生成服务
 *
 * RAG 的最后一环：把检索到的文档块和用户问题组装成 Prompt，
 * 交给 LLM 生成回答。
 *
 * 核心工作是构建 Prompt，模板大致是：
 * ```
 * 系统提示：你是一个文档问答助手，请严格基于以下上下文回答问题。
 *          如果上下文中没有相关信息，请明确说明。
 *
 * 上下文：
 *   [来源1] 第3页 — NestJS 使用 TypeORM 连接数据库...
 *   [来源2] 第5页 — 数据库配置需要在 app.module.ts 中...
 *
 * 用户问题：NestJS 怎么连接数据库？
 * ```
 *
 * 为什么要强调"严格基于上下文"？
 * → 防止 LLM 用自己的"知识"编造回答（幻觉）。
 *   我们希望 LLM 只做"阅读理解"而不是"开放问答"。
 *
 * 提供两种生成模式：
 * - generate():       同步模式，等完整回答生成后一次返回
 * - streamGenerate(): 流式模式，边生成边返回，前端可以实时展示打字效果
 */
@Injectable()
export class GeneratorService {
  private readonly logger = new Logger(GeneratorService.name);

  //RAG 系统提示词 - 告诉LLM它的角色和行为规范
  private readonly SYSTEM_PROMPT = `你是一个专业的文档问答助手。请严格基于以下提供的上下文信息回答用户问题。
  
  
  规则：
  1. 只使用上下文中的信息回答，不要使用你自己的知识。
  2. 如果上下文中没有足够的信息来回答问题，请明确说明“根据提供的文档，我无法找到相关信息。”
  3. 回答时尽量引用来源如（"根据第X页..."或"根据文档中提到..."）
  4. 保证回答简洁、准确、有条理。
  5. 如果问题与上下文完全无关，请引导用户提出与文档相关的问题。
  `;

  constructor(private llmService: QwenLLMService) {}

  async generate(
    question: string,
    contexts: RetrievedChunk[],
    history?: { role: string; content: string }[],
  ): Promise<string> {
    //把检索到的文档块格式化成Prompt中的“上下文”部分
    const contextText = this.formatContexts(contexts);

    //把上下文嵌入用户消息中（不能放到系统提示词中）
    //这样LLM能更清除区分“指令”和“参考资料”
    const userMessage = this.buildUserMessage(question, contextText);

    //构建langchain消息数组
    const messages = await QwenLLMService.buildUserMessage(
      this.SYSTEM_PROMPT,
      userMessage,
      history,
    );

    const answer = await this.llmService.chat(messages);
    this.logger.log(`回答生成完成，${messages.length}`);
    return answer;
  }

  /**
   * 流式生成 — 边生成边返回，前端可以实时展示"打字机"效果
   *
   * 适用场景：前端聊天界面，用户能看到 AI 正在思考和输出
   *
   * 返回 AsyncGenerator，每次 yield 一个 token（通常是一个字或词）
   *
   * 用法：
   * ```ts
   * for await (const token of generatorService.streamGenerate(question, contexts)) {
   *   // 每收到一个 token，通过 SSE 推送给前端
   *   res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
   * }
   * ```
   */
  async *streamGenerate(
    question: string,
    contexts: RetrievedChunk[],
    history?: { role: string; content: string }[],
  ): AsyncGenerator<string> {
    //合成上下文消息，需要将原文内容和引用地址保存
    const contextText = this.formatContexts(contexts);
    //将用户问题和上下文组合成用户消息
    const userMessage = this.buildUserMessage(question, contextText);

    //组合消息列表
    const messages = await QwenLLMService.buildUserMessage(
      this.SYSTEM_PROMPT,
      userMessage,
      history,
    );

    for await (const token of this.llmService.streamChat(messages)) {
      yield token;
    }
  }

  /**
   * 格式化上下文 — 把 RetrievedChunk[] 转成 LLM 能读懂的文本
   *
   * 输出格式：
   * ```
   * [来源1] (产品说明书.pdf, 第3页, 相关度: 0.89)
   * NestJS 使用 TypeORM 连接数据库...
   *
   * [来源2] (技术手册.pdf, 第5页, 相关度: 0.85)
   * 数据库配置需要在 app.module.ts 中...
   * ```
   *
   * 为什么要加来源标注？
   * → 让 LLM 回答时可以引用"根据来源1..."，
   *   也方便我们做幻觉检测时追溯。
   */
  private formatContexts(contexts: RetrievedChunk[]) {
    if (contexts.length === 0) {
      return `没有找到相关内容`;
    }
    return contexts
      .map((ctx, index) => {
        const source = ctx.metadata?.filename || '未知文档';
        const page = ctx.pageNumber ? `第${ctx.pageNumber}页` : '';
        const section = ctx.sectionTitle ? `${ctx.sectionTitle}` : '';
        const score = ctx.score.toFixed(2);

        return `[来源${index + 1}] (${source}${page}${section}, 相关度: ${score})\n${ctx.content}`;
      })
      .join('\n\n');
  }

  //构建用户消息-把上下文和问题组合在一起
  private buildUserMessage(question: string, contextText: string): string {
    return `以下时从文档中检索到相关内容：
    
    ${contextText}
    ----
    基于以上文档内容，请回答以下问题：
    ${question}
    `;
  }
}
