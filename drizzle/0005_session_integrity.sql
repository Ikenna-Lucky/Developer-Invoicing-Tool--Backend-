ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" text;
UPDATE "refresh_tokens" SET "session_id" = "id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;
CREATE UNIQUE INDEX "refresh_tokens_active_session_unique" ON "refresh_tokens" ("session_id") WHERE "revoked" = false;
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id");
--> statement-breakpoint
-- Keep only the newest outstanding reset link for each account.
DELETE FROM "password_reset_tokens" older USING "password_reset_tokens" newer
WHERE older.user_id = newer.user_id
  AND (older.created_at, older.id) < (newer.created_at, newer.id);
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_unique" UNIQUE ("user_id");
