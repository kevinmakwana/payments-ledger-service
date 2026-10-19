import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WorkerRoleService } from './worker-role.service';

@Module({ imports: [DiscoveryModule], providers: [WorkerRoleService] })
export class WorkerModule {}
