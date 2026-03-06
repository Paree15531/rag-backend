import { Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class BaseEntity {
  @CreateDateColumn({ type: 'datetime' })
  createAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateAt: Date;

  @Column({ nullable: true })
  createBy: string;

  @Column({ nullable: true })
  updatedBy?: string;

  @Column({ nullable: true })
  remark?: string;

  @Column({ default: false })
  isDeleted: boolean;
}
