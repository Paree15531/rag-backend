import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Sessions } from 'src/shared/entities/session.entity';
import { Repository } from 'typeorm';
import { Message } from 'src/shared/entities/message.entity';

/**
 * 会话管理服务
 *
 * 职责：
 * 1. 创建/获取会话
 * 2. 存储消息（用户提问 + AI 回答）
 * 3. 查询对话历史（带截断，防止超出 LLM 上下文窗口）
 * 4. 列出所有会话（前端侧边栏展示）
 *
 * 多轮对话流程：
 *   前端传 sessionId（或不传，自动创建）
 *     ↓
 *   SessionService.getHistory()  查出最近 N 轮对话
 *     ↓
 *   QueryRewriteService.rewrite()  结合历史改写查询
 *     ↓
 *   ... RAG Pipeline ...
 *     ↓
 *   SessionService.saveMessages()  存入本轮的问题和回答
 *
 * 历史截断策略：
 *   只取最近 maxTurns 轮对话（默认 10 轮 = 20 条消息）。
 *   超过的部分直接丢弃，不做摘要压缩。
 *   这样既保证 LLM 有足够上下文，又不会超出 token 限制。
 *   如果未来需要更长的记忆，可以加一个"历史摘要"步骤。
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  //保留最近N轮对话
  private MAX_TURNS = 20;

  constructor(
    @InjectRepository(Sessions)
    private sessionRepo: Repository<Sessions>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
  ) {}

  /**
   * 获取或创建会话
   *
   * - 传了 sessionId 且存在 → 返回该会话
   * - 传了 sessionId 但不存在 → 创建新会话（用传入的 ID）
   * - 没传 sessionId → 创建新会话（自动生成 ID）
   */
  async getOrCreateSession(sessionId?: string) {
    if (sessionId) {
      const existing = await this.sessionRepo.findOne({
        where: {
          id: sessionId,
        },
      });

      if (existing) {
        return existing;
      }
    }
    //创建新的会话
    const session = this.sessionRepo.create({
      ...(sessionId ? { id: sessionId } : {}),
    });
    const saved = await this.sessionRepo.save(session);
    this.logger.log(`创建新会话: ${saved.id}`);
    return saved;
  }

  //获取历史对话消息
  async getHistory(sessionId, maxTurns?: number) {
    const turns = maxTurns || this.MAX_TURNS;

    //获取最近N*2条消息
    const messages = await this.messageRepo.find({
      where: { id: sessionId },
      order: {
        createAt: 'DESC',
      },
      take: turns * 2,
    });
    // 反转为时间正序（DESC 取的是最新的，要翻转回来）
    const chronological = messages.reverse();
    return chronological.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /**
   * 存储一轮对话（用户问题 + AI 回答）
   *
   * 在 RAG Pipeline 完成后调用，同时存入用户消息和 AI 回答。
   * 同时更新会话标题（如果是第一轮对话，取问题前 50 字作标题）。
   */

  async saveMessages(sessionId: string, question: string, answer: string) {
    //存储用户消息
    await this.messageRepo.save(
      this.messageRepo.create({
        id: sessionId,
        role: 'user',
        content: question,
      }),
    );

    //存AI回答
    await this.messageRepo.save(
      this.messageRepo.create({
        id: sessionId,
        role: 'assistant',
        content: answer,
      }),
    );

    //更新会话消息
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
    });
    if (session) {
      session.messageCount += 2;
      if (!session.title) {
        session.title = question.slice(0, 20);
      }
      await this.sessionRepo.save(session);
    }
  }
  /**
   * 列出所有会话（前端侧边栏用）
   * 按最近活跃时间倒序
   */
  async listSessions() {
    return this.sessionRepo.find({
      order: { updateAt: 'DESC' },
      select: ['id', 'title', 'messageCount', 'createAt', 'updateAt'],
    });
  }
  /**
   * 获取指定会话的所有消息（前端打开历史对话时加载）
   */
  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return this.messageRepo.find({
      where: { sessionId },
      order: { createAt: 'ASC' },
    });
  }
  /**
   * 删除会话（级联删除所有消息）
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionRepo.delete(sessionId);
    this.logger.log(`Deleted session: ${sessionId}`);
  }
}
