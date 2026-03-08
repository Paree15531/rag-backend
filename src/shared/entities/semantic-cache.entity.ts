import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * 语义缓存表 (semantic_cache)
 *
 * 解决的痛点：相似的问题重复调用 LLM，既慢又费钱。
 *
 * 工作原理：
 * 1. 用户提问时，先把问题转成 embedding 向量
 * 2. 和缓存表中已有问题的 embedding 做余弦相似度比较
 * 3. 如果相似度 > 0.95（几乎是同一个问题），直接返回缓存的答案
 * 4. 如果没命中缓存，走完整 RAG 流程后，把结果存入缓存供下次使用
 *
 * 举例：用户先问"NestJS 怎么配置数据库？"，后来又问"NestJS 如何连接数据库？"
 *       两个问题语义几乎相同，第二次直接返回缓存结果，省掉整个 RAG 流程。
 */

@Entity('semantic_cache')
export class SemanticCache extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  //用户的原始问题
  @Column({ type: 'text' })
  question: string;

  /**
   * 问题的 embedding 向量（和 chunks.embedding 一样，实际是 vector(1024)）
   * select: false → 默认不查出来，只在做相似度比较时通过原生 SQL 使用
   */
  @Column({
    type: 'text',
    nullable: false,
    select: false,
  })
  questionEmbedding: string;

  /** 缓存的回答内容 */
  @Column({ type: 'text' })
  answer: string;

  /** 缓存的来源引用（JSON 数组） */
  @Column({ type: 'simple-json', nullable: true })
  sources: any;

  /** 回答置信度 */
  @Column({ type: 'float', nullable: true })
  confidence: number;

  /** 是否存在幻觉 */
  @Column({ type: 'boolean', nullable: true })
  isHallucination: boolean;

  /** Token 用量 */
  @Column({ type: 'simple-json', nullable: true })
  tokenUsage: any;

  /** 缓存过期时间，过期后下次查询会重新走 RAG 流程 */
  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date;
}
