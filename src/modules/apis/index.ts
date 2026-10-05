/**
 * 统一端点模块入口：一次性迁移（boot 时调用）。
 *
 * initApis 顺序敏感：persona 域必须先经 migratePersonaDomain 从旧
 * localStorage 键成型（端点旧字段以过渡形状进域），migrateApiDomain 才能收到
 * persona 侧收编原料。两步各自幂等，二次启动零重写。
 */

import { migratePersonaDomain } from '@/modules/persona/storage';
import { migrateApiDomain, type ApiMigrationReport } from './migration';
import type { PersonaMigrationReport } from '@/modules/persona/storage';

export interface ApisInitReport {
    persona: PersonaMigrationReport;
    apis: ApiMigrationReport;
}

export function initApis(): ApisInitReport {
    const persona = migratePersonaDomain();
    const apis = migrateApiDomain();
    return { persona, apis };
}

export { migrateApiDomain, type ApiMigrationReport } from './migration';
