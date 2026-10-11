import { Module } from '@nestjs/common';
import { ProviderRegistry } from './provider.registry';
import { RazorpayProvider } from './razorpay.provider';
import { SimulatedProvider } from './simulated.provider';
import { StripeProvider } from './stripe.provider';

@Module({
  providers: [SimulatedProvider, StripeProvider, RazorpayProvider, ProviderRegistry],
  exports: [ProviderRegistry, SimulatedProvider],
})
export class ProvidersModule {}
