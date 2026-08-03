-- Supabase Schema for AiProdGen

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,          -- e.g. 'core_platform', 'batch_processing_pack'
  name TEXT NOT NULL,
  price_inr INTEGER NOT NULL,
  is_addon BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS user_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  purchased_at TIMESTAMPTZ DEFAULT now(),
  razorpay_payment_id TEXT,
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,        -- 'openai', 'stability', 'gemini', etc.
  encrypted_key TEXT NOT NULL,   -- AES-256-GCM, encrypted with server secret
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,          -- pending / complete / failed
  image_url TEXT,
  provider TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed the Lifetime Deal product
INSERT INTO products (id, name, price_inr, is_addon) 
VALUES ('core_platform', 'AiProdGen Lifetime Access', 4000, false)
ON CONFLICT (id) DO NOTHING;
