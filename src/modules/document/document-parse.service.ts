import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { Document as LCDocument } from '@langchain/core/documents';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { TextLoader } from '@langchain/classic/document_loaders/fs/text';

/**
 * 文档解析服务 — 基于 LangChain Document Loaders
 *
 * 解决痛点 1：多格式文档解析
 *
 * 为什么用 LangChain Loader 而不是自己调 pdf-parse/mammoth？
 * → Loader 返回的 Document 对象（pageContent + metadata）
 *   可以直接传给 LangChain 的 TextSplitter 做分块，
 *   整条链路无缝衔接，不需要自定义中间数据结构。
 *
 * 各 Loader 说明：
 * - PDFLoader:  底层用 pdf-parse，splitPages=true 时按页拆分，自动带页码
 * - DocxLoader: 底层用 mammoth，将 DOCX 转纯文本
 * - TextLoader: 直接读文件内容
 *
 * 返回值 LCDocument[]，每个元素：
 *   { pageContent: "这一页/段的文本", metadata: { source, loc.pageNumber, ... } }
 */

/** 解析后的文档结构 */
@Injectable()
export class DocumentParseService {
  private readonly logger = new Logger(DocumentParseService.name);

  /**
   * 解析文档 — 根据文件扩展名自动选择解析策略
   *
   * @param filePath  文件在服务器上的存储路径
   * @param filename  原始文件名（用于判断类型和记录元信息）
   * @returns         统一的 ParsedDocument 结构
   */

  async parse(filename: string, filePath: string): Promise<LCDocument[]> {
    //获取文件扩展名
    const ext = path.extname(filename).toLowerCase().replace(',', '');
    this.logger.log(`开始解析文件: ${filename} (${ext})`);

    let docs: LCDocument[] = [];

    switch (ext) {
      case '.pdf':
        docs = await this.parsePdf(filePath);
        break;
      case '.docx':
        docs = await this.parseDocx(filePath);
        break;
      case '.txt':
        docs = await this.parseText(filePath);
        break;
      default:
        throw new Error(`不支持的文件类型: ${ext}`);
    }

    // 给每个 Document 补上文件名和类型，方便后续溯源
    docs.forEach((doc: LCDocument) => {
      doc.metadata.filename = filename;
      doc.metadata.type = ext;
    });

    return docs;
  }

  /**
   * 解析 PDF
   *
   * splitPages: true → 每页一个 Document，metadata.loc.pageNumber 自动带页码
   * 注意：扫描件（纯图片 PDF）会返回空文本，需要 OCR 支持（当前不支持）
   */
  private async parsePdf(filePath: string): Promise<LCDocument[]> {
    const loader = new PDFLoader(filePath);
    return loader.load();
  }

  /** 解析 DOCX — 底层 mammoth 转纯文本 */
  private async parseDocx(filePath: string): Promise<LCDocument[]> {
    return new DocxLoader(filePath).load();
  }

  /** 解析 TXT / MD — 直接读取文件内容 */
  private async parseText(filePath: string): Promise<LCDocument[]> {
    return new TextLoader(filePath).load();
  }
}
