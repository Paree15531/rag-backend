import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Message } from './message.entity';

/**
 * 会话表 (sessions)
 *
 * 每次用户开始一段新对话，创建一条 session 记录。
 * 后续该对话中的所有消息都关联到这个 sessionId。
 *
 * 前端只需要传 sessionId，后端自动管理对话历史。
 * 不传 sessionId 时自动创建新会话。
 */
@Entity('sessions')
export class Sessions extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  //会话标题
  @Column({ length: 255, nullable: true })
  title: string;

  //消息总数
  @Column({ default: 0 })
  messageCount: number;

  //一个会话会有多条消息
  @OneToMany(() => Message, (message) => message.session, {
    cascade: true,
  })
  messages: Message[];
}
