import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { AdminOnly } from '../auth/auth.decorators';
import { DbService } from '../db/db.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class MarginQuery {
  @ApiPropertyOptional({ example: '2026-03-01', description: 'First UTC day included (default: since the beginning)' })
  @IsOptional() @Matches(DAY)
  from?: string;

  @ApiPropertyOptional({ example: '2026-03-31', description: 'Last UTC day included (default: up to now)' })
  @IsOptional() @Matches(DAY)
  to?: string;
}

/** What the platform kept: its fee revenue minus what the payment providers charged it. */
@ApiTags('reports')
@AdminOnly()
@Controller('reports')
export class MarginController {
  constructor(private readonly db: DbService) {}

  @Get('margin')
  @ApiOperation({ summary: 'Platform fee revenue, provider processing fees and the net margin per currency, for a range of UTC days' })
  async margin(@Query() q: MarginQuery) {
    const r = await this.db.query<{ currency: string; fee_revenue: number; provider_fees: number }>(
      `SELECT a.currency,
              -COALESCE(sum(p.amount) FILTER (WHERE a.code LIKE 'platform:fees:%'), 0)::bigint AS fee_revenue,
              COALESCE(sum(p.amount) FILTER (WHERE a.code LIKE 'platform:provider_fees:%'), 0)::bigint AS provider_fees
         FROM postings p
         JOIN accounts a ON a.id = p.account_id
         JOIN journal_entries e ON e.id = p.entry_id
        WHERE (a.code LIKE 'platform:fees:%' OR a.code LIKE 'platform:provider_fees:%')
          AND ($1::date IS NULL OR (e.created_at AT TIME ZONE 'UTC')::date >= $1::date)
          AND ($2::date IS NULL OR (e.created_at AT TIME ZONE 'UTC')::date <= $2::date)
        GROUP BY a.currency ORDER BY a.currency`,
      [q.from ?? null, q.to ?? null],
    );
    return {
      from: q.from ?? null,
      to: q.to ?? null,
      currencies: r.rows.map((row) => ({
        currency: row.currency.trim(),
        /** Fees charged to sellers, net of fees returned on refunds and lost disputes. */
        platformFeeRevenue: row.fee_revenue,
        /** What Stripe / Razorpay / the simulator charged for processing. */
        providerFees: row.provider_fees,
        netMargin: row.fee_revenue - row.provider_fees,
      })),
    };
  }
}
