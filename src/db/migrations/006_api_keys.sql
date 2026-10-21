-- Database-backed API keys. The secret itself is never stored: only its SHA-256 (tokens are 256 random bits, so a
-- fast hash is enough and lets the guard look a key up by index). Keys can expire, be revoked and be rotated.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  role         text NOT NULL CHECK (role IN ('client', 'admin')),
  key_prefix   text NOT NULL,            -- first characters of the token, so an operator can recognise a key; not secret
  key_hash     bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,                     -- id of the key that issued this one (env:<fingerprint> or a key uuid)
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  replaced_by  uuid REFERENCES api_keys (id)
);
CREATE INDEX api_keys_created_idx ON api_keys (created_at DESC, id DESC);
