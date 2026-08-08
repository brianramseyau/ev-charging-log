CREATE TABLE `evnex_dismissed_sessions` (
	`external_id` text PRIMARY KEY NOT NULL,
	`dismissed_at` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evnex_integration` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text,
	`org_id` text,
	`charge_point_id` text,
	`charge_point_name` text,
	`charge_point_time_zone` text,
	`import_lookback_days` integer DEFAULT 3 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`access_token` text,
	`access_token_expires_at` text,
	`refresh_token` text,
	`last_polled_at` text,
	`last_poll_status` text,
	`last_poll_error` text
);
--> statement-breakpoint
ALTER TABLE `charging_sessions` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `charging_sessions_external_id_unique` ON `charging_sessions` (`external_id`);