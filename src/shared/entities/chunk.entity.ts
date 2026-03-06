import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Document } from './document.entity';
import { BaseEntity } from './base.entity';

@Entity('chunks')
export class Chunk extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  //所属文档的id
  @Column('uuid')
  documentId: string;

  //块的原始文本内容
  @Column({ type: 'text' })
  content: string;

  //该块的所在章节标题
  @Column({ length: 255, nullable: true })
  sectionTitle: string;

  //该块所在的页码
  @Column({
    type: 'int',
    nullable: false,
  })
  pageNumber: number;

  //块在文档中的序号（第几块），用于还原阅读顺序
  @Column({ type: 'int', nullable: true })
  chunkIndex: number;

  /**
   * 向量列 (embedding)
   *
   * 实际类型是 pgvector 的 vector(1024)，但 TypeORM 不原生支持 vector 类型，
   * 所以这里用 text 映射，读写时通过原生 SQL 处理。
   * 建表后需要执行 init.sql 把此列 ALTER 为 vector(1024) 并建 HNSW 索引。
   *
   * select: false → 默认查询不返回此列（它很大，1024 个浮点数），
   *                 只在需要做向量运算时通过原生 SQL 访问。
   */
  @Column({ type: 'text', nullable: true, select: false })
  embedding: string;

  @Column({ type: 'simple-json' })
  metadata: Record<string, any>;

  //多对一，多个块属于同一个文档，删除文档级联删除块
  @ManyToOne(() => Document, (doc) => doc.chunks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'documentId' })
  document: Document;
}
