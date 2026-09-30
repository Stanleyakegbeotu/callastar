import { STORE_NOTIFICATIONS, runTransaction } from "@/services/admin/indexeddb";

import type { NotificationRepository } from "./repository";
import type { AdminNotification, CreateNotificationInput, NotificationFilters } from "./types";

/**
 * Notifications against the local development engine.
 *
 * `readAt` is null while unread, and IndexedDB cannot index null — so unread is
 * counted by reading and filtering rather than by an index lookup. That is fine
 * at this scale and honest about it; a backend would use a partial index.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export const localNotificationRepository: NotificationRepository = {
  mode: "local",

  async create(input: CreateNotificationInput) {
    const notification: AdminNotification = {
      id: newId(),
      type: input.type,
      title: input.title,
      body: input.body,
      entityKind: input.entityKind,
      entityId: input.entityId,
      createdAt: nowIso(),
      readAt: null,
    };

    await runTransaction([STORE_NOTIFICATIONS], "readwrite", (scope) =>
      scope.put(STORE_NOTIFICATIONS, notification),
    );
    return notification;
  },

  async list(filters?: NotificationFilters) {
    const all = await runTransaction([STORE_NOTIFICATIONS], "readonly", (scope) =>
      scope.getAll<AdminNotification>(STORE_NOTIFICATIONS),
    );

    const matched = filters?.unreadOnly ? all.filter((item) => item.readAt === null) : all;
    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filters?.limit ? matched.slice(0, filters.limit) : matched;
  },

  async markRead(id) {
    await runTransaction([STORE_NOTIFICATIONS], "readwrite", async (scope) => {
      const existing = await scope.get<AdminNotification>(STORE_NOTIFICATIONS, id);
      if (!existing || existing.readAt !== null) return;
      await scope.put(STORE_NOTIFICATIONS, { ...existing, readAt: nowIso() });
    });
  },

  async markAllRead() {
    await runTransaction([STORE_NOTIFICATIONS], "readwrite", async (scope) => {
      const all = await scope.getAll<AdminNotification>(STORE_NOTIFICATIONS);
      const timestamp = nowIso();
      for (const notification of all) {
        if (notification.readAt === null) {
          await scope.put(STORE_NOTIFICATIONS, { ...notification, readAt: timestamp });
        }
      }
    });
  },

  async countUnread() {
    const all = await runTransaction([STORE_NOTIFICATIONS], "readonly", (scope) =>
      scope.getAll<AdminNotification>(STORE_NOTIFICATIONS),
    );
    return all.reduce((total, item) => total + (item.readAt === null ? 1 : 0), 0);
  },
};
