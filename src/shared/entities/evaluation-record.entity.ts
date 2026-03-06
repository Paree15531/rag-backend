import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * 评估记录表 (evaluation_records)
 *
 * 存储每次 RAGAS 评估的结果。
 * 你可以拿一批"标准问答对"（问题 + 标准答案）来跑评估，
 * 系统会自动计算 4 个维度的得分，帮你量化 RAG 系统的效果。
 *
 * 典型用法：调整了分块策略或检索参数后，跑一次评估看看分数有没有提升。
 */

@Entity('evaluation_records')
export class EvaluationRecord extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 评估用的问题 */
  @Column({ type: 'text', nullable: true })
  question: string;

  /** RAG 系统给出的回答 */
  @Column({ type: 'text', nullable: true })
  answer: string;

  /** 人工标注的标准答案（ground truth），用于计算 contextRecall */
  @Column({ type: 'text', nullable: true })
  groundTruth: string;

  /** 忠实度：回答是否忠于检索到的上下文 */
  @Column({ type: 'float', nullable: true })
  faithfulness: number;

  /** 回答相关性：回答是否切中问题 */
  @Column({ type: 'float', nullable: true })
  answerRelevancy: number;

  /** 上下文精确度：检索结果是否都和问题相关 */
  @Column({ type: 'float', nullable: true })
  contextPrecision: number;

  /** 上下文召回率：需要的信息是否都检索到了 */
  @Column({ type: 'float', nullable: true })
  contextRecall: number;

  /** RAGAS 综合得分（四项加权平均） */
  @Column({ type: 'float', nullable: true })
  ragasScore: number;
}
