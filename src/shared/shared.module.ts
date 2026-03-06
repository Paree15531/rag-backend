import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/**
 * 共享模块（全局）
 *
 * @Global() 让这三个核心服务在所有模块中可直接注入：
 * - QwenLLMService:  LLM 对话和评判
 * - EmbeddingService: 文本转向量
 * - MilvusService:    向量存储和搜索
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [],
})
export class SharedModule {}
