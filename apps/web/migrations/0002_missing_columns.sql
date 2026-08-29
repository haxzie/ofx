-- Columns Better Auth expects that the initial hand-written schema missed.
-- Confirmed against getAuthTables() rather than guessed.

-- Required: the OAuth callback writes it, so account inserts failed without it.
-- A default is needed because SQLite cannot add a NOT NULL column without one.
ALTER TABLE account ADD COLUMN issuer TEXT NOT NULL DEFAULT '';

-- The JWT plugin records the key's algorithm, curve and expiry.
ALTER TABLE jwks ADD COLUMN expires_at INTEGER;
ALTER TABLE jwks ADD COLUMN alg TEXT;
ALTER TABLE jwks ADD COLUMN crv TEXT;
