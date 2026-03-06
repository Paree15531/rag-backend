import { Controller, Logger, Post, Body, Res } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatDto } from './dto/chat.dto';
import { Response } from 'express';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chatService: ChatService) {}

  /**
   * POST /api/chat — 同步问答
   *
   * 请求体：ChatDto（question 必填，history 和 options 可选）
   * 响应：完整的 ChatResponse JSON
   *
   * 适合：Postman 测试、后台批量处理、不需要实时展示的场景
   */
  @Post()
  async chat(@Body() dto: ChatDto) {
    const response = await this.chatService.chat({
      question: dto.question,
      sessionId: dto.sessionId,
      history: dto.history,
      options: dto.options,
    });
    return response;
  }

  /**
   * POST /api/chat/stream — SSE 流式问答
   *
   * 工作流程：
   * 1. 收到请求后，先做检索（这步不流式，需要完整结果）
   * 2. 设置 SSE 响应头
   * 3. LLM 每生成一个 token，就推送一个 event:token 事件
   * 4. 所有 token 生成完毕后，推送 event:sources（来源引用）
   * 5. 最后推送 event:done（结束信号 + 元信息）
   *
   * 前端监听方式（EventSource 或 fetch + ReadableStream）：
   * ```js
   * const eventSource = new EventSource('/api/chat/stream', { method: 'POST', body: ... });
   * // 或者更常见的做法是用 fetch：
   * const res = await fetch('/api/chat/stream', { method: 'POST', body: JSON.stringify(dto) });
   * const reader = res.body.getReader();
   * // 逐行读取 SSE 事件...
   * ```
   *
   * SSE 事件格式：
   *
   * event: token
   * data: {"token": "Nest"}
   *
   * event: token
   * data: {"token": "JS"}
   *
   * event: token
   * data: {"token": "使用"}
   *
   * ... （每个 token 一个事件）
   *
   * event: sources
   * data: [{"filename": "手册.pdf", "score": 0.89, ...}]
   *
   * event: done
   * data: {"confidence": 1.0, "isHallucination": false, "cached": false}
   */

  @Post('stream')
  async streamChat(@Body() dto: ChatDto, @Res() res: Response) {
    //设置sse响应头
    res.setHeader('Content-Type', 'text/event-stream'); //告诉浏览器是sse格式
    res.setHeader('Cache-Control', 'no-cache'); //不进行缓存
    res.setHeader('Connection', 'keep-alive'); //保持长连接
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders(); //立即发送响应头，不等body

    try {
      //检索 + 获取流式生成器
      const { tokenStream, sources, retrievedChunks } =
        await this.chatService.streamChat({
          question: dto.question,
          sessionId: dto.sessionId,
          history: dto.history,
          options: dto.options,
        });
      this.logger.log(`检索到的文档块: ${JSON.stringify(retrievedChunks)}`);
      //逐个token推送给前端
      let fullAnswer = ''; //收集完整回答

      for await (const token of tokenStream) {
        fullAnswer += token;
        // SSE 格式：event: 事件名\ndata: JSON\n\n（两个换行表示事件结束）
        res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      }
      // Step 3: 推送来源引用
      res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

      // Step 4: 推送结束信号 + 元信息
      const metadata = {
        confidence: 1.0, // Phase 5 会给出真实值
        isHallucination: false, // Phase 5 会做真正的检测
        cached: false,
      };
      res.write(`event: done\ndata: ${JSON.stringify(metadata)}\n\n`);
    } catch (e) {
      this.logger.error(`Stream error: ${e.message}`);
      // 推送错误事件
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`,
      );
    } finally {
      res.end(); //关闭sse链接
    }
  }
}
