import { BaseMessage } from '@langchain/core/messages';

/** LLM 调用的可选参数 */
export interface LLMChatOptions {
  temperature?: number; // 温度：0 = 确定性输出，0.7 = 较有创意
  maxTokens?: number; // 最大输出 Token 数
  stop?: string[]; // 停止词列表
}

/** 流式输出的单个片段 */
export interface LLMStreamChunk {
  token: string;
  done: boolean;
}

/** judge 方法的返回结果 */
export interface JudgeResult {
  raw: string; // LLM 原始输出
  parsed?: Record<string, any>; // 解析后的 JSON 对象
}

/** LangChain 消息数组类型别名 */
export type MessageInput = BaseMessage[];
