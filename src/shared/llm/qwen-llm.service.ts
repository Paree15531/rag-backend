import { ChatOpenAI } from '@langchain/openai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HumanMessage,
  SystemMessage,
  AIMessage,
  BaseMessage,
} from '@langchain/core/messages';
import { LLMChatOptions } from '../types/llm.types';

/**

 * 3 种调用方式：
 *
 * 1. chat()       — 等待完整回复后返回，用于后台处理
 * 2. streamChat() — 流式逐 token 返回，用于前端打字机效果
 * 3. judge()      — 温度 0 的确定性输出，用于幻觉检测/重排/评估等"裁判"场景
 */
@Injectable()
export class QwenLLMService {
  private readonly logger = new Logger(QwenLLMService.name);

  //对话模型:温度0.3，存在一定灵活度
  private chatModel: ChatOpenAI;

  //评判模型：温度0，输出确定一致
  private judgeModel: ChatOpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get('DASHSCOPE_API_KEY') as string;
    const baseURL = this.configService.get('BASE_URL') as string;
    const modelName = this.configService.get('CHAT_MODEL') as string;
    this.logger.log(
      `QwenLLMService constructor: modelName=${modelName},apiKey=${apiKey},baseURL=${baseURL}`,
    );
    //对话模型
    this.chatModel = new ChatOpenAI({
      model: modelName,
      apiKey: apiKey,
      temperature: 0.3,
      streaming: true,
      configuration: {
        baseURL,
      },
    });

    //评判模型
    this.judgeModel = new ChatOpenAI({
      model: modelName,
      apiKey: apiKey,
      configuration: { baseURL },
      temperature: 0.0,
      streaming: false,
    });
  }

  async judge(prompt: string) {
    try {
      const response = await this.judgeModel.invoke([
        new SystemMessage(
          `你是一个专业严谨的内容检查人员，请根据以下内容进行评估：`,
        ),
        new HumanMessage(prompt),
      ]);
      return response.content as string;
    } catch (error) {
      this.logger.error(`LLM judge error: ${error.message}`);
      throw error;
    }
  }
  /**
   * 普通对话 — 传入消息列表，返回完整回复文本
   */

  async chat(messages: BaseMessage[], options?: LLMChatOptions) {
    try {
      const model = this.chatModel;

      const response = await model.invoke(messages);
      return response.content as string;
    } catch (error) {
      this.logger.error(`LLM chat error: ${error.message}`);
      throw error;
    }
  }

  /**
   * 流式对话 — 返回异步迭代器，每次 yield 一个 token
   *
   * 用法：
   * ```ts
   * for await (const token of llmService.streamChat(messages)) {
   *   res.write(`data: ${token}\n\n`);  // 推给前端 SSE
   * }
   * ```
   */

  async *streamChat(
    messages: BaseMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<string> {
    try {
      const stream = await this.chatModel.stream(messages);
      for await (const chunk of stream) {
        const token = chunk.content as string;
        if (token) yield token;
      }
    } catch (error) {
      this.logger.error(`LLM stream error: ${error.message}`);
      throw error;
    }
  }

  //构建langchian消息数组的静态方法
  static async buildUserMessage(
    systemPrompt: string,
    userMessage: string,
    history?: {
      role: string;
      content: string;
    }[],
  ) {
    const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];
    //判断循环历史消息并分配角色和消息类型
    if (history?.length) {
      for (const msg of history) {
        const message =
          msg.role === 'user'
            ? new HumanMessage(msg.content)
            : new AIMessage(msg.content);
        messages.push(message);
      }
    }

    messages.push(new HumanMessage(userMessage));
    return messages;
  }
}
