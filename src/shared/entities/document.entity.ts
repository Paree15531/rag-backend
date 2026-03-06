import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { Chunk } from './chunk.entity';
import { BaseEntity } from './base.entity';

export enum DocumentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/**
 * 文档表 (documents)
 *
 * 用户上传的每个文件对应一行记录。
 * 上传后会经历 pending → processing → ready 的生命周期：
 *   1. 用户上传文件 → 创建记录，status = 'pending'
 *   2. 后台开始解析、分块、向量化 → status = 'processing'
 *   3. 全部完成 → status = 'ready'，chunkCount 记录分了多少块
 *   4. 如果出错 → status = 'failed'，error 字段记录错误信息
 */

@Entity()
export class Document extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  //原始文件名
  @Column({ type: 'varchar', length: 255, nullable: false })
  filename: string;

  //文件类型
  @Column({ type: 'varchar', length: 20, nullable: false })
  type: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  filePath: string;

  //该文档被切分成了多少块
  @Column({ type: 'int', default: 0 })
  chunkCount: number;

  //文档处理状态
  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  //处理失败时的错误信息
  @Column({ type: 'text', nullable: true })
  error: string;

  //一对多的关系，一个文档存在多个块；cascade：true，删除文档时自动删除关联的所有块
  @OneToMany(() => Chunk, (chunk) => chunk.document, { cascade: true })
  chunks: Chunk[];
}
