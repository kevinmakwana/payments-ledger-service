import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PaymentProvider } from './provider.interface';
import { RazorpayProvider } from './razorpay.provider';
import { SimulatedProvider } from './simulated.provider';
import { StripeProvider } from './stripe.provider';

@Injectable()
export class ProviderRegistry {
  private readonly providers: Map<string, PaymentProvider>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    simulated: SimulatedProvider,
    private readonly stripe: StripeProvider,
    private readonly razorpay: RazorpayProvider,
  ) {
    this.providers = new Map<string, PaymentProvider>([
      [simulated.name, simulated],
      [stripe.name, stripe],
      [razorpay.name, razorpay],
    ]);
  }

  get(name: string = this.config.defaultProvider): PaymentProvider {
    const p = this.providers.get(name);
    if (!p) throw new BadRequestException(`Unknown provider "${name}"`);
    if (name === 'stripe' && !this.stripe.configured) throw new BadRequestException('Stripe is not configured');
    if (name === 'razorpay' && !this.razorpay.configured) throw new BadRequestException('Razorpay is not configured');
    return p;
  }

  /** Providers that can be used right now (the simulator, plus Stripe / Razorpay when their credentials are set). */
  available(): string[] {
    return this.names().filter((n) => {
      try {
        this.get(n);
        return true;
      } catch {
        return false;
      }
    });
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
