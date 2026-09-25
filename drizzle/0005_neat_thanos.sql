CREATE TABLE `car_odometer_integration` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_url` text,
	`secret` text,
	`enabled` integer DEFAULT false NOT NULL,
	`last_read_at` text,
	`last_success_at` text,
	`last_read_status` text,
	`last_read_error` text
);
--> statement-breakpoint
ALTER TABLE `charging_sessions` ADD `odometer_source` text;--> statement-breakpoint
ALTER TABLE `charging_sessions` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `charging_sessions` ADD `ended_at` text;