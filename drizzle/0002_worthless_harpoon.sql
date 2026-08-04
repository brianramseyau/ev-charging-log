PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_charging_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`billing_period_id` integer,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`odometer_km` real NOT NULL,
	`kwh_used` real,
	`location` text NOT NULL,
	`cost` real,
	`notes` text,
	FOREIGN KEY (`billing_period_id`) REFERENCES `billing_periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_charging_sessions`("id", "billing_period_id", "kind", "date", "time", "odometer_km", "kwh_used", "location", "cost", "notes") SELECT "id", "billing_period_id", "kind", "date", "time", "odometer_km", "kwh_used", "location", "cost", "notes" FROM `charging_sessions`;--> statement-breakpoint
DROP TABLE `charging_sessions`;--> statement-breakpoint
ALTER TABLE `__new_charging_sessions` RENAME TO `charging_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;