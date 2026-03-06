import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { DocumentService } from './document.service';

/**
 * 文档管理控制器
 *
 * 提供 3 个接口，与前端契约完全对齐：
 *
 * POST   /api/documents/upload   — 上传文档（multipart/form-data）
 * GET    /api/documents          — 获取文档列表
 * DELETE /api/documents/:id      — 删除文档
 *
 * 文件上传使用 Multer 中间件处理：
 * - 前端用 FormData 把文件放在 "file" 字段发送
 * - Multer 自动接收文件并存到临时目录
 * - Controller 拿到文件信息后交给 DocumentService 处理
 */
@Controller('documents')
export class DocumentController {
  private readonly logger = new Logger(DocumentController.name);
  constructor(private readonly documentService: DocumentService) {}

  /**
   * POST /api/documents/upload
   *
   * 上传文档文件，支持 pdf/docx/md/txt 格式。
   *
   * 请求格式：multipart/form-data
   * - file: 文件（必须）
   *
   * @FileInterceptor('file', ...) 的作用：
   * - 'file': 前端 FormData 中的字段名
   * - diskStorage: 文件先存到临时目录（os.tmpdir()），后续由 Service 移到正式目录
   * - fileFilter: 校验文件类型，非法类型直接拒绝
   * - limits: 限制文件大小（默认 20MB）
   *
   * 响应：返回文档信息（此时 status 可能还是 pending，入库在后台异步进行）
   */

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        // 临时存储目录（系统临时目录）
        destination: (req, file, cb) => {
          const os = require('os');
          cb(null, os.tmpdir());
        },
        // 临时文件名（加时间戳防止冲突）
        filename: (req, file, cb) => {
          const uniqueName = `${Date.now()}-${file.originalname}`;
          cb(null, uniqueName);
        },
      }),
      // 文件类型白名单校验
      fileFilter: (req, file, cb) => {
        const allowedExts = ['.pdf', '.docx', '.md', '.txt'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext)) {
          cb(null, true); // 通过
        } else {
          cb(
            new BadRequestException(
              `Unsupported file type: ${ext}. Allowed: ${allowedExts.join(', ')}`,
            ),
            false, // 拒绝
          );
        }
      },
      limits: {
        fileSize: 20 * 1024 * 1024, // 20MB 上限
      },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded. Use field name "file".');
    }

    this.logger.log(`开始上传文件: ${file.originalname}`);
    file.originalname = Buffer.from(file.originalname, 'latin1').toString(
      'utf-8',
    );
    const document = await this.documentService.upload(file);

    // 返回格式与前端契约对齐
    return {
      id: document.id,
      filename: document.filename,
      type: document.type,
      status: document.status,
      chunkCount: document.chunkCount,
    };
  }
  /**
   * GET /api/documents
   *
   * 获取所有文档列表，按上传时间倒序。
   * 前端用来展示文档管理页面，可以看到每个文档的处理状态。
   */
  @Get()
  async findAll() {
    const docs = await this.documentService.findAll();

    return docs.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      type: doc.type,
      status: doc.status,
      chunkCount: doc.chunkCount,
      updateAt: doc.updateAt,
      error: doc.error,
    }));
  }

  /**
   * DELETE /api/documents/:id
   *
   * 删除指定文档，同时清理：
   * - MySQL 中的文档和块记录
   * - Milvus 中的向量
   * - 磁盘上的文件
   */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.documentService.remove(id);
    return { success: true, message: `Document ${id} deleted` };
  }
}
