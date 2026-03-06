import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Chunk } from 'src/shared/entities/chunk.entity';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MilvusService } from 'src/shared/milvus/milvus.service';
import * as fs from 'fs';
import * as path from 'path';
import { DocumentStatus, Document } from 'src/shared/entities/document.entity';
import { NotFoundException } from '@nestjs/common';
import { IngestionService } from './Ingestion.service';

/**
 * 文档管理服务
 *
 * 负责文档的 CRUD 操作和对接 IngestionService 触发入库流程。
 * 是 DocumentController 的直接下游。
 *
 * 核心职责：
 * - upload():  保存上传文件到磁盘 → 创建数据库记录 → 触发入库流程
 * - findAll(): 查询文档列表（前端首页展示）
 * - remove():  删除文档（MySQL 记录 + Milvus 向量 + 磁盘文件 三方清理）
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);
  private readonly uploadDir: string;

  @InjectRepository(Document)
  private documentDto: Repository<Document>;

  @InjectRepository(Chunk)
  private chunkDto: Repository<Chunk>;

  constructor(
    private configService: ConfigService,
    private readonly milvusService: MilvusService,
    private readonly ingestionService: IngestionService,
  ) {
    //上传目录从环境变量中读取，默认是./uploads
    this.uploadDir = this.configService.get('UPLOAD_DIR', './uploads');

    //判断upload目录是否存在，不存在手动创建
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /**
   * 上传文档
   *
   * 流程：
   * 1. Multer 已经把文件保存到了临时位置（file.path）
   * 2. 我们把文件移到正式的上传目录
   * 3. 在 MySQL 创建 document 记录（status = pending）
   * 4. 触发入库流程（异步：解析→分块→向量化→存储）
   * 5. 立即返回文档信息给前端（不等入库完成，前端可以轮询状态）
   *
   * @param file  Multer 处理后的文件对象，包含 originalname、path、mimetype 等
   * @returns     新创建的文档记录
   */

  async upload(file: Express.Multer.File): Promise<Document> {
    //从文件名中提取扩展名称
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    //生成唯一的文件存储名称
    const savedFileName = `${Date.now()}-${file.originalname}`;
    const savedPath = path.join(this.uploadDir, savedFileName);

    // 把 Multer 的临时文件移到正式的上传目录
    // Windows 上 rename 不能跨盘符（C: -> F:），需用 copy + unlink
    try {
      fs.renameSync(file.path, savedPath);
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        fs.copyFileSync(file.path, savedPath);
        fs.unlinkSync(file.path);
      } else {
        throw e;
      }
    }

    //在mysql中创建文档记录
    const document = this.documentDto.create({
      filename: file.originalname,
      type: ext,
      filePath: savedPath,
      status: DocumentStatus.PENDING,
    });
    const savedDoc = await this.documentDto.save(document);

    this.logger.log('上传文件成功：' + savedDoc.id);

    /**
     * 异步触发入库流程
     *
     * 用 .then().catch() 而不是 await，这样不阻塞响应。
     * 前端立即收到文档信息（status=pending），
     * 入库在后台进行，完成后 status 变为 ready 或 failed。
     * 前端可以通过 GET /api/documents 轮询文档状态。
     *
     * 生产环境建议改用消息队列（如 BullMQ）来处理，
     * 好处是可以重试失败任务、控制并发、支持优先级等。
     */
    //mysql数据库自动生成id这个作为这个文档的documentid
    this.ingestionService.ingest(savedDoc).catch((err) => {
      this.logger.error(`Background ingestion failed: ${err.message}`);
    });

    return savedDoc;
  }

  /**
   * 查询所有文档列表
   *
   * 按上传时间倒序排列（最新的在前面）。
   * 前端用来展示文档管理页面。
   */

  async findAll(): Promise<Document[]> {
    return this.documentDto.find({
      order: {
        createAt: 'DESC',
      },
    });
  }

  //查询单个文档的信息
  async findOne(id: string): Promise<Document> {
    const doc = await this.documentDto.findOne({
      where: {
        id,
      },
    });
    if (!doc) {
      throw new NotFoundException('文档不存在');
    }
    return doc;
  }

  /**
   * 删除文档
   *
   * 需要同时清理三个地方的数据：
   * 1. Milvus：删除该文档所有块的向量
   * 2. MySQL：删除文档记录和关联的块记录（cascade 自动处理块的删除）
   * 3. 磁盘：删除上传的原始文件
   *
   * 删除顺序很重要：先删 Milvus（需要 chunkId 列表），
   * 再删 MySQL（cascade 会删掉 chunks，之后就查不到 chunkId 了）。
   */
  async remove(id: string): Promise<void> {
    const doc = await this.findOne(id);

    //查出该文档的所有的chunkId
    const chunks = this.chunkDto.find({
      where: { documentId: id },
      select: ['id'],
    });
    const chunIds = (await chunks).map((c) => c.id);

    //从向量数据库中删除这个id集合的所有关联的向量数据块
    if (chunIds.length > 0) {
      await this.milvusService.deleteChunkVectors(chunIds);
      this.logger.log(`从向量数据库中删除成功:${chunIds.length}条数据`);
    }

    //从mysql中删除相关文档
    await this.documentDto.delete(id);

    //从磁盘删除相关的文件
    if (doc.filePath && fs.existsSync(doc.filePath)) {
      fs.unlinkSync(doc.filePath);
      this.logger.log('从磁盘删除成功:' + doc.filename);
    }
  }
}
