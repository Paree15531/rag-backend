import { Module } from '@nestjs/common';
import { Document } from '../entities/document.entity';
import { Chunk } from '../entities/chunk.entity';
import { SemanticCache } from '../entities/cache.entity';
import { QueryLog } from '../entities/query-log.entity';
import { EvaluationRecord } from '../entities/evaluation-record.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

//所有实体类集中注册
const entities = [Document, Chunk, SemanticCache, QueryLog, EvaluationRecord];
/**
 * MySQL 数据库模块
 *
 * 职责：
 * 1. 建立 MySQL 连接
 * 2. 注册所有 TypeORM 实体
 * 3. 导出 TypeOrmModule，让其他模块可以注入 Repository
 *
 * 注意：此模块只负责关系数据。
 * 向量数据由 MilvusService（shared/milvus/）单独管理。
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return {
          type: 'mysql',
          host: config.get('DB_HOST'),
          port: config.get<number>('DB_PORT', 3306),
          username: config.get('DB_USERNAME', 'root'),
          password: config.get('DB_PASSWORD', 'root'),
          database: config.get('DB_DATABASE', 'ragtest'),
          entities,
          synchronize: true, // ⚠️ 生产环境改为 false，用 migration 管理
          logging: true,
        };
      },
    }),
    TypeOrmModule.forFeature(entities),
  ],
  // 导出后，其他模块 import DatabaseModule 就能直接用 Repository
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
