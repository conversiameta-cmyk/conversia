import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

async function ensureNewTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      status VARCHAR(20) DEFAULT 'connected',
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, type)
    );
  `);

  // AI Creative Studio: créditos por usuario + campos del studio en creatives
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_credits INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE creatives ADD COLUMN IF NOT EXISTS video_url TEXT`);
  await pool.query(`ALTER TABLE creatives ADD COLUMN IF NOT EXISTS studio JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE creatives ADD COLUMN IF NOT EXISTS credits_used INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE creatives ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false`);

  // Ledger de créditos (reserva/consumo/refund) con idempotencia
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      amount INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'committed',
      balance_before INTEGER, balance_after INTEGER,
      operation VARCHAR(40), provider VARCHAR(40), model VARCHAR(60),
      campaign_id UUID, creative_id UUID,
      idempotency_key VARCHAR(120),
      meta JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_idem ON credit_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at DESC);
  `);

  // Cost tracking (costo real del proveedor — solo admin)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_generations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id UUID, creative_id UUID,
      provider VARCHAR(40) NOT NULL, model VARCHAR(60) NOT NULL, operation VARCHAR(40) NOT NULL,
      duration_secs INTEGER, resolution VARCHAR(20),
      estimated_provider_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
      credits_reserved INTEGER NOT NULL DEFAULT 0, credits_consumed INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL, error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_gen_user ON ai_generations(user_id, created_at DESC);
  `);

  // Recargas de créditos por transferencia (el CEO aprueba)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_purchases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pack_key VARCHAR(40) NOT NULL, credits INTEGER NOT NULL, amount_usd NUMERIC(10,2) NOT NULL,
      receipt_url TEXT, status VARCHAR(20) NOT NULL DEFAULT 'pending',
      reviewed_by UUID, reviewed_at TIMESTAMPTZ, note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_credit_purchases_status ON credit_purchases(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_credit_purchases_user ON credit_purchases(user_id, created_at DESC);
  `);
  // Comprobante guardado en DB (persistente; el disco de Railway es efímero)
  await pool.query(`ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS receipt_data TEXT`);

  // Proyectos (campañas guardadas) + espacio de marca
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL, type VARCHAR(40) NOT NULL DEFAULT 'ugc_campaign',
      thumbnail_url TEXT, status VARCHAR(20) NOT NULL DEFAULT 'ready',
      credits_used INTEGER NOT NULL DEFAULT 0, data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS brand_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL, image_url TEXT, image_data TEXT,
      description TEXT, price VARCHAR(40), url TEXT, category VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_brand_products_user ON brand_products(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS brand_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      brand_name VARCHAR(200), logo_url TEXT, primary_color VARCHAR(20),
      data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // CEO / admin owner — idempotent, kept in sync on every boot
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, role, status, email_verified)
    VALUES ('ugartealan776@gmail.com',
            '$2a$12$dZtO7SboA28bzNqwcrF/4undBPFqdv.OLzbO2jOmT7bh6Pr/zXNc2',
            'Alan Ugarte - CEO', 'admin', 'active', TRUE)
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          full_name = EXCLUDED.full_name,
          role = 'admin', status = 'active', email_verified = TRUE
  `);
}

// Limpieza de datos de prueba/ficticios. Se activa SOLO con la env RESET_DEMO.
// Conserva la cuenta CEO y el esquema; borra el resto de datos y usuarios de prueba.
async function cleanDemoData(pool: Pool): Promise<void> {
  if (!process.env.RESET_DEMO) return;
  const CEO = 'conversia.meta@gmail.com';
  const dataTables = ['creatives', 'projects', 'ai_generations', 'credit_transactions', 'credit_purchases', 'leads', 'campaigns', 'user_integrations', 'brand_products', 'brand_profiles', 'subscriptions'];
  let removed = 0;
  for (const t of dataTables) {
    try { const r = await pool.query(`DELETE FROM ${t}`); removed += r.rowCount ?? 0; } catch { /* la tabla puede no existir */ }
  }
  try {
    const r = await pool.query('DELETE FROM users WHERE lower(email) <> $1', [CEO]);
    console.log(`🧹 RESET_DEMO: ${removed} filas de datos borradas + ${r.rowCount ?? 0} usuarios de prueba eliminados (CEO conservado).`);
  } catch (e: any) {
    console.log(`🧹 RESET_DEMO: ${removed} filas de datos borradas; usuarios no se pudieron limpiar (${e.message}).`);
  }
}

export async function autoMigrate(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('⚠️  No DATABASE_URL — skipping auto-migrate');
    return;
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // Check if DB is already migrated
    const { rows } = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1
    `);

    if (rows.length > 0) {
      // DB already migrated — patch admin hash + ensure new tables exist
      await pool.query(`
        UPDATE users SET password_hash = '$2a$12$XSsoBhGBomdNSB8i9yymvO3x0F.L2OxfUnEJYoYRnckZtZcpVR5LO'
        WHERE email = 'admin@aicommerceads.com'
      `);
      await ensureNewTables(pool);
      await cleanDemoData(pool);
      console.log('✅ Admin password hash verified');
      return;
    }

    console.log('🔄 Running database migrations...');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('✅ Schema applied');

    const seedPath = join(__dirname, 'seed.sql');
    const seed = readFileSync(seedPath, 'utf8');
    await pool.query(seed);
    console.log('✅ Seed applied — admin: admin@aicommerceads.com / AdminACA2026!#');

    // Fix admin password hash to ensure login works
    await pool.query(`
      UPDATE users SET password_hash = '$2a$12$XSsoBhGBomdNSB8i9yymvO3x0F.L2OxfUnEJYoYRnckZtZcpVR5LO'
      WHERE email = 'admin@aicommerceads.com'
    `);
    console.log('✅ Admin password hash updated');

    await ensureNewTables(pool);
    console.log('✅ Extended tables created');

  } catch (err: any) {
    console.error('❌ Migration error:', err.message);
  } finally {
    await pool.end();
  }
}
