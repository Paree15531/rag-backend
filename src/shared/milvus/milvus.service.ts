import { Injectable, Logger, OnModuleInit, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataType, MilvusClient } from '@zilliz/milvus2-sdk-node';

/**
 * Milvus 向量数据库服务 — 支持 dense + sparse 混合检索
 *
 * rag_chunks Collection 有两个向量字段：
 *   - embedding (FloatVector 1024维)       dense 向量，EmbeddingService 生成
 *   - sparse_embedding (SparseFloatVector) sparse 向量，BM25Service 生成
 *
 * 混合检索在 Milvus 内部完成：
 *   一次请求同时搜两个字段，Milvus 用 RRF 自动融合结果。
 */
@Injectable()
export class MilvusService implements OnModuleInit {
  private readonly logger = new Logger();

  //collection名称，从环境配置文件中读取
  private chunksCollection: string;
  private cacheCollection: string;

  //创建向量数据库实例
  private client: MilvusClient;

  //向量维度，需要和嵌入模型的输出维度保持一致才可以
  private readonly VECTOR_DIM = 1024;

  constructor(private readonly configService: ConfigService) {
    this.chunksCollection = this.configService.get(
      'MILVUS_COLLECTION_CHUNKS',
      'rag_chunks',
    );
    this.cacheCollection = this.configService.get(
      'MILVUS_COLLECTION_CACHE',
      'rag_semantic_cache',
    );
  }

  /**
   * 模块初始化时自动执行：
   * 1. 连接 Milvus
   * 2. 创建所需的 Collection（如果不存在）
   * 3. 加载 Collection 到内存（Milvus 搜索前必须 load）
   */
  async onModuleInit() {
    try {
      this.client = new MilvusClient({
        address: `${this.configService.get('MILVUS_HOST', 'localhost')}:${this.configService.get('MILVUS_PORT', 19530)}`,
      });
      this.logger.log('向量数据库已设置连接');
      // 确保两个 Collection 存在
      await this.ensureChunksCollection();
      await this.ensureCacheCollection();
    } catch (e) {
      this.logger.error(`Milvus init failed: ${e.message}`);
      // 不抛出异常，允许应用启动（Milvus 可能还没就绪）
      // 实际操作时如果连接不上会报错
    }
  }

  // ============================================
  // Collection 初始化
  // ============================================

  /**
   * 创建文档块向量 Collection
   *
   * Schema 设计：
   * - chunk_id:  VARCHAR(36)，主键，对应 MySQL chunks.id
   * - embedding: 1024 维浮点向量
   *
   * 索引：IVF_FLAT + 余弦相似度
   *   IVF_FLAT 是一种常用的 ANN 索引，先把向量聚类，搜索时只扫描相关的簇，
   *   在精度和速度之间取得平衡。nlist=128 表示分 128 个簇。
   */
  private async ensureChunksCollection() {
    const exists = await this.client.hasCollection({
      collection_name: this.chunksCollection,
    });
    if (exists.value) return;

    //定义集合字段结构
    await this.client.createCollection({
      collection_name: this.chunksCollection,
      fields: [
        {
          name: 'chunk_id',
          data_type: DataType.VarChar,
          is_primary_key: true, //主键
          max_length: 36, //uuid的长度
        },
        {
          name: 'embedding', //向量数据字段
          data_type: DataType.FloatVector,
          dim: this.VECTOR_DIM, //向量维度数
        },
        { name: 'sparse_embedding', data_type: DataType.SparseFloatVector },
      ],
    });

    //创建向量稠密索引-没有索引搜索速度会非常慢
    await this.client.createIndex({
      collection_name: this.chunksCollection,
      field_name: 'embedding',
      index_type: 'IVF_FLAT', //索引类型，不同的索引类型代表不同的算法
      metric_type: 'COSINE', //距离度量：余弦相似度
      params: { nlist: 128 }, //聚类数量
    });

    //创建稀疏向量索引
    await this.client.createIndex({
      collection_name: this.chunksCollection,
      field_name: 'sparse_embedding',
      index_type: 'SPARSE_INVERTED_INDEX',
      metric_type: 'IP',
      params: { drop_ratio_build: 0.2 },
    });

    await this.client.loadCollection({
      collection_name: this.chunksCollection,
    });

    this.logger.log('向量数据集合和数据索引创建完成:' + this.chunksCollection);
  }
  /**
   * 创建语义缓存向量 Collection（结构与 chunks 类似）
   */
  private async ensureCacheCollection() {
    const exists = await this.client.hasCollection({
      collection_name: this.cacheCollection,
    });
    if (exists.value) return;

    await this.client.createCollection({
      collection_name: this.cacheCollection,
      fields: [
        {
          name: 'cache_id',
          data_type: DataType.VarChar,
          is_primary_key: true,
          max_length: 36,
        },
        {
          name: 'embedding',
          data_type: DataType.FloatVector,
          dim: this.VECTOR_DIM,
        },
      ],
    });

    await this.client.createIndex({
      collection_name: this.cacheCollection,
      field_name: 'embedding',
      index_type: 'IVF_FLAT',
      metric_type: 'COSINE',
      params: {
        nlist: 128,
      }, //聚类数量
    });

    await this.client.loadCollection({
      collection_name: this.cacheCollection,
    });
    this.logger.log('向量数据集合和数据索引创建完成:' + this.cacheCollection);
  }

  /**
   * 批量插入文档块向量
   *
   * 在文档入库流程中调用：
   *   解析文档 → 分块 → EmbeddingService 批量向量化 → 本方法插入 Milvus
   *
   * @param data  数组，每项包含 chunkId（对应 MySQL 的 chunk.id）和 embedding（向量）
   */
  async insertChunkVectors(
    data: Array<{
      chunkId: string;
      embedding: number[];
      sparseEmbedding: Record<number, number>;
    }>,
  ): Promise<void> {
    if (data.length === 0) return;

    await this.client.insert({
      collection_name: this.chunksCollection,
      data: data.map((item) => {
        return {
          chunk_id: item.chunkId,
          embedding: item.embedding,
          sparse_embedding: item.sparseEmbedding,
        };
      }),
    });

    this.logger.log('插入文档数据' + data.length + '至向量数据库中');
  }

  /**
   * 向量相似度搜索 — RAG 检索的核心
   *
   * 用户提问时调用：
   *   问题文本 → EmbeddingService 转向量 → 本方法在 Milvus 中搜索 → 返回最相似的 chunk_id 列表
   *
   * @param queryVector  问题的 embedding 向量（1024 维）
   * @param topK         返回最相似的 K 个结果
   * @returns            数组，每项包含 chunkId 和 score（余弦相似度，0~1）
   *
   * 搜索参数 nprobe=16：搜索时扫描 16 个簇（nlist=128 的情况下）
   * nprobe 越大精度越高但越慢，16 是常用的平衡值。
   */
  //纯dense搜索
  async searchChunks(queryVector: number[], topK: number = 5) {
    const results = await this.client.search({
      collection_name: this.chunksCollection,
      vector: queryVector,
      limit: topK,
      metric_type: 'COSINE',
      params: {
        nprobe: 16,
      },
      output_fields: ['chunk_id'], //只需要返回chunk_id，完整的数据去mysql中进行查询
    });

    // 将 Milvus 返回的结果转成业务友好的格式
    return (results.results || []).map((item: any) => ({
      chunkId: item.chunk_id || item.id,
      score: item.score,
    }));
  }

  /**
   * 删除指定文档的所有块向量
   *
   * 用户删除文档时调用，需要同时清理 MySQL 和 Milvus 的数据。
   *
   * @param chunkIds  要删除的 chunk_id 列表（从 MySQL 查出后传入）
   */
  async deleteChunkVectors(chunkIds: string[]) {
    if (chunkIds.length === 0) return;

    await this.client.delete({
      collection_name: this.chunksCollection,
      filter: `chunk_id [${chunkIds.map((id) => `"${id}"`).join(',')}]`,
    });

    this.logger.debug(`从向量数据库中删除` + chunkIds.length + '条数据');
  }

  // ============================================
  // 语义缓存向量操作
  // ============================================

  /**
   * 插入一条语义缓存的问题向量
   *
   * RAG 流程结束后调用：把问题和结果同时写入 MySQL（文本）和 Milvus（向量）
   */
  async insertCacheVector(cacheId: string, embedding: number[]) {
    await this.client.insert({
      collection_name: this.cacheCollection,
      data: [{ cache_id: cacheId, embedding }],
    });
  }

  /**
   * 搜索语义缓存 — 判断新问题是否和之前某个问题"几乎一样"
   *
   * @param queryVector  新问题的 embedding
   * @param threshold    相似度阈值，默认 0.95（非常严格，几乎要是同一个问题）
   * @returns            命中时返回 { cacheId, score }，没命中返回 null
   */
  async searchCache(
    queryVector: number[],
    threshold: number = 0.95,
  ): Promise<{ cacheId: string; score: number } | null> {
    const results = await this.client.search({
      collection_name: this.cacheCollection,
      vector: queryVector,
      limit: 1, //只需要最相似的那一个
      metric_type: 'COSINE',
      params: { nprobe: 16 },
      output_fields: ['cache_id'],
    });

    const top = results.results?.[0] as any;
    if (top && top.score > threshold) {
      return {
        cacheId: top.chunk_id,
        score: top.score,
      };
    }
    return null;
  }

  /**
   * 删除语义缓存向量（缓存过期或手动清理时用）
   */
  async deleteCacheVector(cacheId: string): Promise<void> {
    await this.client.delete({
      collection_name: this.cacheCollection,
      filter: `cache_id == "${cacheId}"`,
    });
  }

  //获取向量数据库实例
  async getMilvusClient() {
    return this.client;
  }

  //混合检索 dense + sparse同时搜索，Milvus 内部 RFF进行融合
  async hybirdSearchChunks(
    denseVector: number[],
    sparseVector: Record<number, number>,
    topK: number = 5,
  ): Promise<{ chunkId: string; score: number }[]> {
    //从向量数据库中并行进行稀疏和稠密向量检索
    const results = await this.client.search({
      collection_name: this.chunksCollection,
      data: [
        {
          anns_field: 'embedding',
          data: denseVector,
          params: {
            nprobe: 16,
          },
          metric_type: 'COSINE',
        },
        {
          anns_field: 'sparse_embedding',
          data: sparseVector,
          params: {
            drop_ratio_search: 0.2,
          },
          metric_type: 'IP',
        } as any,
      ],
      limit: topK,
      output_fields: ['chunk_id'],
      rerank: {
        strategy: 'rrf',
        params: { k: 60 },
      },
    });
    return (results.results || []).map((item: any) => ({
      chunkId: item.chunk_id || item.id,
      score: item.score,
    }));
  }
}
