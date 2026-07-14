import { Global, Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import PgBoss from 'pg-boss';
import databaseConfig from '../config/database.config';

export const PG_BOSS = Symbol('PG_BOSS');

@Global()
@Module({
  providers: [
    {
      provide: PG_BOSS,
      inject: [databaseConfig.KEY],
      useFactory: (db: ConfigType<typeof databaseConfig>) =>
        new PgBoss({
          host: db.host,
          port: db.port,
          user: db.username,
          password: db.password,
          database: db.name,
        }),
    },
  ],
  exports: [PG_BOSS],
})
export class QueueModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss) {}

  async onModuleInit(): Promise<void> {
    await this.boss.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }
}
