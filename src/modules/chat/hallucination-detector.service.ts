import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwenLLMService } from 'src/shared/llm/qwen-llm.service';
import { RetrievedChunk } from 'src/shared/types/rag.types';

/**
 * 幻觉检测结果
 */
export interface HallucinationResult {
  isHallucination: boolean; // 是否存在幻觉
  confidence: number; // 回答置信度 (0~1)
  details?: string; // LLM 给出的判断理由
}

/**
 * 幻觉检测服务
 *
 * 解决痛点 7：LLM 编造回答（幻觉）
 *
 * 什么是幻觉？
 *   LLM 生成了看似合理但实际上没有文档依据的内容。
 *   比如文档里说"NestJS 支持 TypeORM"，LLM 却回答"NestJS 推荐使用 Prisma"。
 *   这种回答语法通顺、逻辑自洽，但不忠于源文档。
 *
 * 检测方法：LLM-as-Judge（用 LLM 做裁判）
 *   把 LLM 的回答和检索到的文档块一起交给另一次 LLM 调用，
 *   让 LLM 判断回答中的每个论点是否有文档支持。
 *   使用温度 0（judge 模式），确保判断结果一致可复现。
 *
 * 输出：
 *   - confidence: 0.0~1.0，表示回答有多少比例有文档支持
 *   - isHallucination: confidence < 阈值（默认 0.7）时标记为幻觉
 *
 * 在 Pipeline 中的位置：生成之后
 *   ... → LLM 生成回答 → 幻觉检测 → 标记结果 → 返回
 */
@Injectable()
export class HallucinationDetectorService {
  private readonly logger = new Logger(HallucinationDetectorService.name);

  /** 低于此阈值标记为幻觉 */
  private readonly threshold: number;

  /**
   * 检测提示词
   * 让 LLM 扮演"事实核查员"，逐句检查回答是否有文档支持
   */
  private readonly DETECT_PROMPT = `你是一个严格的事实核查员。请检查以下"AI回答"中的每个论点是否有"参考文档"的支持。

评估规则：
1. 逐句检查回答内容，判断每句话是否能在参考文档中找到依据
2. 如果回答中包含文档未提及的信息，视为"无依据"
3. 如果回答与文档内容矛盾，视为"矛盾"
4. 合理的推理和总结不算幻觉，但编造的细节算

请只返回 JSON，不要返回其他内容：
{
  "supported_claims": <有文档支持的论点数>,
  "total_claims": <总论点数>,
  "confidence": <有支持的比例, 0.0~1.0>,
  "reason": "<一句话总结判断理由>"
}`;

  constructor(
    private llmService: QwenLLMService,
    private configService: ConfigService,
  ) {
    this.threshold = this.configService.get<number>(
      'HALLUCINATION_THRESHOLD',
      0.7,
    );
  }

  /**
   * 检测回答是否存在幻觉
   *
   * @param answer   LLM 生成的回答
   * @param contexts 检索到的文档块（作为事实依据）
   * @returns        幻觉检测结果
   */
  async detect(
    answer: string,
    contexts: RetrievedChunk[],
  ): Promise<HallucinationResult> {
    // 没有检索到任何文档，无法判断，默认标记为幻觉
    if (contexts.length === 0) {
      return {
        isHallucination: true,
        confidence: 0,
        details: 'No context documents available for verification',
      };
    }

    // 拼接参考文档
    const contextText = contexts
      .map((ctx, i) => `[文档${i + 1}] ${ctx.content}`)
      .join('\n\n');

    const prompt = `${this.DETECT_PROMPT}

参考文档：
${contextText}

AI回答：
${answer}

请评估：`;

    try {
      // 用 judge 模式（温度 0）调用 LLM
      const response = await this.llmService.judge(prompt);
      const result = this.parseResult(response);

      this.logger.log(
        `Hallucination check: confidence=${result.confidence.toFixed(2)}, hallucination=${result.isHallucination}`,
      );

      return result;
    } catch (error) {
      this.logger.warn(`Hallucination detection failed: ${error.message}`);
      // 检测失败时保守处理：给一个中等置信度，不标记为幻觉
      return {
        isHallucination: false,
        confidence: 0.5,
        details: `Detection failed: ${error.message}`,
      };
    }
  }

  /**
   * 解析 LLM 返回的 JSON 结果
   *
   * LLM 可能返回：
   * - 标准 JSON: {"confidence": 0.8, ...}
   * - 带 markdown 包裹: ```json\n{...}\n```
   * - 格式异常
   *
   * 需要容错处理
   */
  private parseResult(response: string): HallucinationResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(
        /\{[\s\S]*"confidence"\s*:\s*[\d.]+[\s\S]*\}/,
      );

      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        const confidence = Math.min(1, Math.max(0, json.confidence || 0));

        return {
          isHallucination: confidence < this.threshold,
          confidence,
          details: json.reason || '',
        };
      }

      // 兜底：尝试提取数字
      const numMatch = response.match(/confidence['":\s]+(\d+\.?\d*)/i);
      if (numMatch) {
        const confidence = Math.min(1, Math.max(0, parseFloat(numMatch[1])));
        return {
          isHallucination: confidence < this.threshold,
          confidence,
        };
      }

      // 完全解析不了
      return {
        isHallucination: false,
        confidence: 0.5,
        details: 'Failed to parse LLM response',
      };
    } catch {
      return {
        isHallucination: false,
        confidence: 0.5,
        details: 'JSON parse error',
      };
    }
  }
}
