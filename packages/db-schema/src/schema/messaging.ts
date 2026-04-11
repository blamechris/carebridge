/**
 * Secure messaging schema.
 *
 * Conversations between patients and their care team. Message bodies are
 * encrypted at rest via encryptedText. All message access is audit-logged.
 */

import { pgTable, text, index, jsonb } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { patients } from "./patients.js";
import { encryptedText } from "../encryption.js";

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("open"), // open, closed, archived
  created_by: text("created_by").notNull().references(() => users.id),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_conversations_patient").on(table.patient_id),
  index("idx_conversations_status").on(table.status),
]);

export const conversationParticipants = pgTable("conversation_participants", {
  id: text("id").primaryKey(),
  conversation_id: text("conversation_id").notNull().references(() => conversations.id),
  user_id: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(), // patient, provider
  joined_at: text("joined_at").notNull(),
}, (table) => [
  index("idx_conv_participants_conv").on(table.conversation_id),
  index("idx_conv_participants_user").on(table.user_id),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  conversation_id: text("conversation_id").notNull().references(() => conversations.id),
  sender_id: text("sender_id").notNull().references(() => users.id),
  body: encryptedText("body").notNull(), // encrypted at rest — contains PHI
  message_type: text("message_type").notNull().default("text"), // text, refill_request, appointment_request
  read_by: jsonb("read_by").$type<string[]>().default([]), // user IDs who have read this message
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_messages_conversation").on(table.conversation_id, table.created_at),
  index("idx_messages_sender").on(table.sender_id),
]);
