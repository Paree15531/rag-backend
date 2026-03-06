import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

/**
 * BM25 稀疏向量服务 — 使用 jieba 分词
 *
 * 把文本转成稀疏向量（Sparse Vector），存进 Milvus，
 * 让 Milvus 内部同时做 dense（语义）+ sparse（关键词）混合检索。
 *
 分词方案：segmentit
 * - 纯 JavaScript 实现，零原生依赖，npm install 不会有任何编译问题
 * - 内置词典和多种优化器（人名识别、地名识别、数词优化等）
 * - fork 自 node-segment，支持 Node.js / 浏览器 / Electron
 *
 * 稀疏向量原理：
 *   每个词在词表中有唯一 ID，值是该词的 TF-IDF 权重。
 *   例如 "TypeORM" ID=5920，权重=0.3 → sparse = {..., 5920: 0.3, ...}
 *   Milvus 用内积（IP）计算稀疏向量相似度，共有词越多、权重越高，分数越高。
 *
 */

@Injectable()
export class BM25Service implements OnModuleInit {
  private logger = new Logger(BM25Service.name);
  /** jieba 分词器实例 */
  private jieba: Jieba;

  /** 词表：word → dimId */
  private vocabulary: Map<string, number> = new Map();
  private nextId: number = 0;

  /** 文档频率：word → 出现在多少个文档中 */
  private docFrequency: Map<string, number> = new Map();

  /** 已处理的总文档数 */
  private totalDocs: number = 0;

  /**
   * 停用词表
   * 高频无语义词，过滤后提高检索精度
   */
  private readonly STOP_WORDS = new Set([
    '的',
    '了',
    '在',
    '是',
    '我',
    '有',
    '和',
    '就',
    '不',
    '人',
    '都',
    '一',
    '一个',
    '上',
    '也',
    '很',
    '到',
    '说',
    '要',
    '去',
    '你',
    '会',
    '着',
    '没有',
    '看',
    '好',
    '自己',
    '这',
    '他',
    '她',
    '它',
    '们',
    '那',
    '些',
    '什么',
    '怎么',
    '如何',
    '可以',
    '能',
    '被',
    '把',
    '从',
    '对',
    '为',
    '与',
    '或',
    '但',
    '而',
    '所',
    '以',
    '及',
    '等',
    '中',
    '下',
    '之',
    '已',
    '还',
    '将',
    '其',
    '此',
    '因',
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'and',
    'but',
    'or',
    'not',
    'no',
    'if',
    'then',
    'than',
    'that',
    'this',
    'it',
    'its',
    'he',
    'she',
    'they',
    'them',
    'their',
    'we',
    'our',
  ]);

  /**
   * 初始化 jieba 分词器
   * Jieba.withDict(dict) 加载 @node-rs/jieba 内置的 20 万词默认词典
   */
  async onModuleInit() {
    this.jieba = Jieba.withDict(dict);

    this.logger.log('@node-rs/jieba v2 initialized');
  }

  /**
   * 将文本转成 BM25 稀疏向量
   * @returns Milvus 稀疏向量格式 {dimId: weight, ...}
   */
  textToSparse(text: string): Record<number, number> {
    const words = this.tokenize(text);
    if (words.length === 0) return {};

    // 统计词频
    const termFreq = new Map<string, number>();
    for (const word of words) {
      termFreq.set(word, (termFreq.get(word) || 0) + 1);
    }

    const sparse: Record<number, number> = {};

    for (const [word, count] of termFreq) {
      const dimId = this.vocabulary.get(word);
      if (dimId === undefined) continue;

      // TF: 词频 / 总词数（归一化）
      const tf = count / words.length;
      // IDF: 逆文档频率，越稀有的词权重越高
      const df = this.docFrequency.get(word) || 0;
      const idf = Math.log((this.totalDocs + 1) / (df + 1)) + 1;
      const weight = tf * idf;

      if (weight > 0) {
        sparse[dimId] = parseFloat(weight.toFixed(4));
      }
    }

    return sparse;
  }

  /** 批量转换 */
  textToSparseBatch(texts: string[]): Record<number, number>[] {
    return texts.map((text) => this.textToSparse(text));
  }

  /**
   * 批量学习词表 + 文档频率
   * 文档入库时调用，必须在 textToSparse() 之前
   */
  fit(texts: string[]): void {
    for (const text of texts) {
      const words = this.tokenize(text);
      const uniqueWords = new Set(words);

      for (const word of uniqueWords) {
        if (!this.vocabulary.has(word)) {
          this.vocabulary.set(word, this.nextId++);
        }
        this.docFrequency.set(word, (this.docFrequency.get(word) || 0) + 1);
      }

      this.totalDocs++;
    }

    this.logger.debug(
      `Vocabulary: ${this.vocabulary.size} words, ${this.totalDocs} docs`,
    );
  }
  /**
   * 分词 — jieba 精确模式 + HMM 新词发现
   *
   * jieba.cut(text, hmm) 参数：
   * - text: 待分词文本
   * - hmm: true = 启用 HMM 新词发现（能识别词典中没有的新词）
   *
   * 精确模式返回不重叠的分词结果：
   *   "数据库管理系统" → ["数据库", "管理系统"]
   *
   * 流程：jieba 分词 → 转小写 → 过滤停用词 → 过滤单字符和纯数字
   */
  private tokenize(text: string): string[] {
    const words = this.jieba.cut(text, true);
    this.logger.log(`分词结果: ${words.join(', ')}`);
    return words
      .map((w) => w.trim().toLowerCase())
      .filter((w) => {
        if (w.length === 0) return false;
        if (this.STOP_WORDS.has(w)) return false;
        if (/^\d+$/.test(w)) return false;
        if (/^\s+$/.test(w)) return false;
        if (w.length === 1 && /[\u4e00-\u9fff]/.test(w)) return false;
        return true;
      });
  }
  getVocabularySize(): number {
    return this.vocabulary.size;
  }
}
