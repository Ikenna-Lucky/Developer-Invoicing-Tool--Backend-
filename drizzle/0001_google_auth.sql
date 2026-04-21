-- ─── Migration: Google OAuth support ──────────────────────────────────────────
--
-- 1. Make password_hash nullable so Google-authenticated users (who have no
--    password) can be stored without a placeholder hash.
--
-- 2. Add google_id column to link Billd accounts to Google accounts.
--    Unique so the same Google account can't create duplicate Billd accounts.

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" text;
--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_google_id_unique" UNIQUE("google_id");
