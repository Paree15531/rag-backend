import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private embeddings: OpenAIEmbeddings; //生命嵌入模型实例

  constructor(private readonly configService: ConfigService) {
    this.embeddings = new OpenAIEmbeddings({
      apiKey: this.configService.get('DASHSCOPE_API_KEY'),
      model: this.configService.get('EMBEDDING_MODEL'),
      configuration: {
        baseURL: this.configService.get('BASE_URL'),
      },
    });
  }

  /**
   * 单文本向量化 — 主要用于用户提问时将问题转成向量
   */
  async embedText(text: string) {
    try {
      return await this.embeddings.embedQuery(text);
    } catch (e) {
      this.logger.error(`Embedding error: ${e.message}`);
      throw e;
    }
  }

  /**
   * 批量向量化 — 主要用于文档分块后批量转向量
   * 比逐条调用效率高（减少 HTTP 请求次数）
   */

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.embeddings.embedDocuments(texts);
    } catch (e) {
      this.logger.error(`Embedding error: ${e.message}`);
      throw e;
    }
  }
}
