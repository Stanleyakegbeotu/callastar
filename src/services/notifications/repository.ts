import { config, type AdminDataMode } from "@/lib/config";

import { localNotificationRepository } from "./localNotificationRepository";
import { supabaseNotificationRepository } from "./supabaseNotificationRepository";
import type { AdminNotification, CreateNotificationInput, NotificationFilters } from "./types";

/** The seam for admin notifications. */
export interface NotificationRepository {
  readonly mode: AdminDataMode;
  create(input: CreateNotificationInput): Promise<AdminNotification>;
  list(filters?: NotificationFilters): Promise<AdminNotification[]>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  countUnread(): Promise<number>;
}

export function getNotificationRepository(): NotificationRepository {
  return config.adminDataMode === "local" ? localNotificationRepository : supabaseNotificationRepository;
}

export const notificationRepository = getNotificationRepository();

/**
 * Raise a notification without letting it matter.
 *
 * A notification is a courtesy to an operator, never part of the operation that
 * caused it. A customer's payment request must not fail because writing a row
 * for the dashboard failed, so this swallows everything.
 */
export function notifyAdmin(input: CreateNotificationInput): void {
  void notificationRepository.create(input).catch(() => undefined);
}
