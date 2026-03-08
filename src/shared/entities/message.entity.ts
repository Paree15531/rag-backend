import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Sessions } from './session.entity';

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
}

@Entity('messages')
export class Message extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  //所属会话id
  @Column({ type: 'varchar', length: 36 })
  sessionId: string;

  //消息角色：user | assistant
  @Column({ length: 20, enum: MessageRole, nullable: false })
  role: string;

  //消息内容
  @Column({ type: 'text' })
  content: string;

  @ManyToOne(() => Sessions, (session) => session.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sessionId' })
  session: Sessions;
}
