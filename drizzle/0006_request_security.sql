CREATE TABLE
	IF NOT EXISTS "request_rate_limits" (
		"key" text PRIMARY KEY NOT NULL,
		"attempts" integer NOT NULL,
		"expires_at" timestamp
		with
			time zone NOT NULL
	);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_rate_limits_expiry_idx" ON "request_rate_limits" ("expires_at");