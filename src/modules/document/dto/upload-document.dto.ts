import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 上传文档 DTO
 *
 * 文件本身通过 Multer @UploadedFile() 接收，
 * 此 DTO 用于接收文件以外的附加字段（如描述、标签）。
 */
export class UploadDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tags?: string;
}
