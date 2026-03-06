import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNumber,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

//对话历史中的单条消息
class ChatMessageDto {
  @IsString()
  role: 'user' | 'assistant';

  @IsString()
  content: string;
}

//检索选项-前端可以精细控制
class ChatOptionDto {
  /** 返回最相关的 K 个文档块，默认 5 */
  @IsOptional()
  @IsNumber()
  topK?: number;

  /** 相似度阈值，低于此值的结果丢弃 */
  @IsOptional()
  @IsNumber()
  threshold?: number;

  /** 是否启用重排序（Phase 4 实现） */
  @IsOptional()
  @IsBoolean()
  enableRerank?: boolean;

  /** 是否启用语义缓存（Phase 5 实现） */
  @IsOptional()
  @IsBoolean()
  enableCache?: boolean;

  /** 是否启用幻觉检测（Phase 5 实现） */
  @IsOptional()
  @IsBoolean()
  enableHallucinationCheck?: boolean;
}

/**
 * Chat 请求 DTO
 *
 * 前端发送格式：
 * {
 *   "question": "NestJS 怎么连接数据库？",
 *   "sessionId": "abc-123",
 *   "history": [
 *     { "role": "user", "content": "你好" },
 *     { "role": "assistant", "content": "你好！有什么可以帮你的？" }
 *   ],
 *   "options": { "topK": 5 }
 * }
 */
export class ChatDto {
  /** 用户当前的问题（必填） */
  @IsString()
  question: string;

  /** 会话 ID，关联多轮对话 */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** 之前的对话历史 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  history?: ChatMessageDto[];

  /** RAG 行为选项 */
  @IsOptional()
  @ValidateNested()
  @Type(() => ChatOptionDto)
  options?: ChatOptionDto;
}
