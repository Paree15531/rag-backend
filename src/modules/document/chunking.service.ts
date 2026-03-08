import { Injectable, Logger } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';

/**
 * 智能分块服务
 *
 * 解决痛点 2：固定长度切割破坏语义完整性
 *
 * 输入：LangChain Document[]（由 DocumentParserService 返回）
 * 输出：LangChain Document[]（更小的块，每块约 512 字符）
 *
 * 因为输入输出都是 LangChain Document 格式，所以：
 * - metadata 会自动继承（页码、文件名等信息不会丢失）
 * - 可以直接对接 LangChain 的其他组件
 *
 * RecursiveCharacterTextSplitter 的分割策略：
 *   优先按 "\n\n"（段落边界）分割
 *   → 段落太长就按 "\n"（换行）分割
 *   → 还是太长按 "。""？""！"（句子边界）分割
 *   → 实在不行按字符分割
 *   这样尽量保证每个块都是语义完整的。
 *
 * chunkOverlap（重叠）的作用：
 *   块 A 的最后 64 个字 = 块 B 的开头 64 个字
 *   防止关键信息正好在切割边界丢失
 */
@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);
  //切分器
  private splitter: RecursiveCharacterTextSplitter;

  constructor(private configService: ConfigService) {
    // ConfigService 从 .env 读出的是字符串，必须转成数字，否则 TextSplitter 校验会失败
    const chunkSize = Number(this.configService.get('CHUNK_SIZE', 512)) || 512;
    const chunkOverlap =
      Number(this.configService.get('CHUNK_OVERLAP', 64)) || 64;

    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      // 分隔符优先级：段落 > 换行 > 中文句号/问号/叹号 > 英文句号 > 逗号 > 空格
      // 排在前面的优先使用，确保尽量按语义边界切割
      separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ','],
    });

    this.logger.log('切片完成');
  }

  async chunk(docs: Document[]): Promise<Document[]> {
    /**
     * splitDocuments vs splitText：
     * - splitText(string):    只处理文本，丢失 metadata
     * - splitDocuments(docs): 处理 Document 对象，保留并继承 metadata
     * 这里用 splitDocuments 确保页码等元信息不丢失
     */
    const chunks = await this.splitter.splitDocuments(docs);

    this.logger.log(`分块完成，共 ${chunks.length} 个块`);
    return chunks;
  }
}
