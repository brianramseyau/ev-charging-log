CREATE TABLE `billing_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`submitted_at` text
);
--> statement-breakpoint
CREATE TABLE `charging_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`billing_period_id` integer,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`odometer_km` real NOT NULL,
	`kwh_used` real NOT NULL,
	`location` text NOT NULL,
	`cost` real,
	`notes` text,
	FOREIGN KEY (`billing_period_id`) REFERENCES `billing_periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rate_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_from` text NOT NULL,
	`type` text NOT NULL,
	`flat_rate` real,
	`peak_rate` real,
	`offpeak_rate` real,
	`offpeak_windows` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`vehicle_label` text NOT NULL
);
