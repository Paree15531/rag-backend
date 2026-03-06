/**
 * 检索到的文档块
 *
 * 用户提问时，系统从 Milvus 中搜索出最相关的文档块向量，
 * 拿到 chunkId 后再回 MySQL 查完整的文本内容。
 * 最终拼装成 RetrievedChunk 送给 LLM 作为上下文。
 */
export interface RetrievedChunk {
  id: string; // chunk 在 MySQL 中的主键
  content: string; // 文档块的文本内容
  score: number; // 与用户问题的相关度 (0~1)，由 Milvus 返回
  documentId: string; // 所属文档 ID，用于回答溯源
  sectionTitle?: string; // 章节标题
  pageNumber?: number; // 页码（PDF 文档才有）
  chunkIndex?: number; // 块在文档内的序号
  metadata?: Record<string, any>;
}

/**
 * Chat 请求 — 前端发给后端的聊天请求体
 */
export interface ChatRequest {
  question: string; // 用户当前的提问
  sessionId?: string; // 会话 ID，关联多轮对话
  history?: ChatMessage[]; // 对话历史，让 LLM 理解上下文
  options?: {
    topK?: number; // 检索返回最相关的 N 个文档块，默认 5
    threshold?: number; // 相似度阈值，低于此值丢弃
    enableRerank?: boolean; // 是否启用重排序
    enableCache?: boolean; // 是否启用语义缓存
    enableHallucinationCheck?: boolean; // 是否做幻觉检测
  };
}

/**
 * Chat 响应 — 后端返回给前端的完整回答
 */
export interface ChatResponse {
  answer: string; // LLM 生成的回答
  sources: SourceReference[]; // 回答引用的文档来源
  confidence: number; // 回答置信度 (0~1)
  isHallucination: boolean; // 是否存在幻觉
  cached: boolean; // 是否命中语义缓存
  tokenUsage?: TokenUsage;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 来源引用 — 告诉用户"这段回答基于哪个文档生成"
 */
export interface SourceReference {
  documentId: string;
  filename: string;
  chunkContent: string;
  score: number;
  pageNumber?: number;
  sectionTitle?: string;
}

/**
 * Token 用量统计 — 用于成本监控
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 文档处理状态生命周期：pending → processing → ready / failed */
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * RAGAS 评估结果 — 4 个维度衡量 RAG 系统质量
 */
export interface EvaluationResult {
  faithfulness: number; // 忠实度：回答是否忠于上下文
  answerRelevancy: number; // 回答相关性：回答是否切题
  contextPrecision: number; // 上下文精确度：检索结果是否都相关
  contextRecall: number; // 上下文召回率：需要的信息是否都检索到了
  ragasScore: number; // 综合得分
}

/**
 * 监控聚合指标
 */
export interface MonitoringMetrics {
  totalQueries: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgConfidence: number;
  hallucinationRate: number;
  cacheHitRate: number;
}
