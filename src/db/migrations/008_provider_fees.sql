-- Provider processing fees.
-- What the simulated provider charges for a charge (its own books, like a real provider's balance transactions).
ALTER TABLE sim_provider_transactions ADD COLUMN fee bigint NOT NULL DEFAULT 0 CHECK (fee >= 0);
