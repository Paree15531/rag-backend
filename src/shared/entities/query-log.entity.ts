import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * 查询日志表 (query_logs)
 *
 * 每次用户提问，无论走缓存还是走完整 RAG 流程，都会记录一条日志。
 * 用于监控模块做聚合统计，比如：
 * - 平均延迟是多少？
 * - 幻觉率有没有升高？
 * - 缓存命中率是多少？
 *
 * 这些指标帮助你判断 RAG 系统的健康状况，及时发现问题。
 */

@Entity('query_logs')
export class QueryLog extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 会话 ID，关联同一个用户的多轮对话 */
  @Column({ length: 100, nullable: true })
  sessionId: string;

  /** 用户的问题 */
  @Column({ type: 'text', nullable: true })
  question: string;

  /** LLM 的回答 */
  @Column({ type: 'text', nullable: true })
  answer: string;

  /** 回答置信度 */
  @Column({ type: 'float', nullable: true })
  confidence: number;

  /** 是否检测到幻觉 */
  @Column({ type: 'boolean', nullable: true })
  isHallucination: boolean;

  /** 本次回答是否来自语义缓存 */
  @Column({ type: 'boolean', default: false })
  cached: boolean;

  /** 端到端延迟（毫秒），从收到请求到返回结果的总耗时 */
  @Column({ type: 'int', nullable: true })
  latencyMs: number;

  /** Token 用量（JSON 格式） */
  @Column({ type: 'simple-json', nullable: true })
  tokenUsage: any;
}
