CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`owner_id` text,
	`created_at_ms` integer NOT NULL,
	`session_started_at_ms` integer NOT NULL,
	`last_updated_at_ms` integer NOT NULL,
	`member_count` integer DEFAULT 0 NOT NULL,
	`chat_count` integer DEFAULT 0 NOT NULL,
	`playlist_count` integer DEFAULT 0 NOT NULL,
	`current_media_title` text,
	`current_media_url` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rooms_last_updated_index` ON `rooms` (`last_updated_at_ms`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_index` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_rooms` (
	`user_id` text NOT NULL,
	`room_code` text NOT NULL,
	`joined_at_ms` integer NOT NULL,
	PRIMARY KEY(`user_id`, `room_code`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_code`) REFERENCES `rooms`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_rooms_room_code_index` ON `user_rooms` (`room_code`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`display_name_lower` text NOT NULL,
	`email` text NOT NULL,
	`email_lower` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_login_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_display_name_lower_unique` ON `users` (`display_name_lower`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_lower_unique` ON `users` (`email_lower`);