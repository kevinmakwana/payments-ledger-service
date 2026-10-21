import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { PageQuery } from '../common/pagination';
import { ApiKeyService } from './api-key.service';
import { Principal } from './api-keys';
import { AdminOnly, CurrentPrincipal } from './auth.decorators';

const MAX_LIFETIME_DAYS = 3650;
const MAX_GRACE_SECONDS = 30 * 86_400;

class CreateApiKeyDto {
  @ApiProperty({ example: 'checkout-backend', description: 'Label shown when listing keys' })
  @IsString() @Matches(/^[A-Za-z0-9 _.:@-]{1,64}$/)
  name!: string;

  @ApiProperty({ enum: ['client', 'admin'] })
  @IsIn(['client', 'admin'])
  role!: 'client' | 'admin';

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIFETIME_DAYS, description: 'Stop working after this many days (default: never expires)' })
  @IsOptional() @IsInt() @Min(1) @Max(MAX_LIFETIME_DAYS)
  expiresInDays?: number;
}

class RotateApiKeyDto {
  @ApiPropertyOptional({ default: 86_400, minimum: 0, maximum: MAX_GRACE_SECONDS, description: 'Keep the old key working this long so clients can switch over; 0 retires it immediately' })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_GRACE_SECONDS)
  graceSeconds?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIFETIME_DAYS, description: 'Lifetime of the new key (default: never expires)' })
  @IsOptional() @IsInt() @Min(1) @Max(MAX_LIFETIME_DAYS)
  expiresInDays?: number;
}

const actor = (p: Principal | undefined) => p?.keyId ?? 'anonymous';

/** Issue, list, rotate and revoke API keys. The secret is returned exactly once, in the response that creates it. */
@ApiTags('api-keys')
@Controller('admin/api-keys')
@AdminOnly()
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Create an API key. The response carries the key itself: store it now, it cannot be shown again.' })
  async create(@Body() dto: CreateApiKeyDto, @CurrentPrincipal() by?: Principal) {
    const { key, token } = await this.keys.create(dto, actor(by));
    return { ...key, key: token };
  }

  @Get()
  @ApiOperation({ summary: 'List API keys (metadata only, newest first)' })
  list(@Query() query: PageQuery) {
    return this.keys.list(query);
  }

  @Post(':id/rotate')
  @HttpCode(201)
  @ApiOperation({ summary: 'Replace a key: issues a new one and retires the old one after a grace period' })
  async rotate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RotateApiKeyDto, @CurrentPrincipal() by?: Principal) {
    const { key, token, previous } = await this.keys.rotate(id, { graceSeconds: dto.graceSeconds ?? 86_400, expiresInDays: dto.expiresInDays }, actor(by));
    return { ...key, key: token, previous };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a key (takes effect within API_KEY_CACHE_TTL_MS on every instance)' })
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() by?: Principal) {
    return this.keys.revoke(id, actor(by));
  }
}
