-- Password reset tokens for the forgot-password flow
CREATE TABLE "password_reset_tokens" (
  "id"          text PRIMARY KEY,
  "user_id"     text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"  text NOT NULL UNIQUE,
  "expires_at"  timestamp NOT NULL,
  "created_at"  timestamp DEFAULT now() NOT NULL
);
