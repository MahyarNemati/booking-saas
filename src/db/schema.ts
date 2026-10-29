import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Global identity tables (Auth.js). Not tenant scoped.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", {
    withTimezone: true,
    mode: "date",
  }),
  image: text("image"),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// Tenant tables. Every table below is protected by row-level security
// (see drizzle/0001_rls.sql) and must only be queried through withTenant().

export const roleEnum = pgEnum("member_role", ["owner", "admin", "member"]);
export const planEnum = pgEnum("plan", ["free", "pro", "enterprise"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  stripeCustomerId: text("stripe_customer_id").unique(),
  // The business's own IANA time zone. Every local rule -- opening hours,
  // date overrides, the dates a calendar shows -- is relative to this, and
  // there is no sensible default for a booking product, so it is required.
  timeZone: text("time_zone").notNull().default("UTC"),
  // How long before an appointment reminders go out, in minutes. An array
  // because businesses genuinely want more than one: a day before and an
  // hour before.
  reminderOffsetsMinutes: jsonb("reminder_offsets_minutes")
    .$type<number[]>()
    .notNull()
    .default([24 * 60, 60]),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_pending_uq")
      .on(t.orgId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
  ],
);

export const subscriptions = pgTable("subscriptions", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
  stripePriceId: text("stripe_price_id").notNull(),
  plan: planEnum("plan").notNull(),
  status: text("status").notNull(),
  seats: integer("seats").notNull().default(1),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull().unique(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_org_idx").on(t.orgId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorType: text("actor_type")
      .$type<"user" | "api_key" | "system">()
      .notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.orgId, t.createdAt.desc())],
);

// ---------------------------------------------------------------- booking
//
// An organization is a business. Everything below is tenant scoped and
// carries org_id, which the row-level security policies in
// drizzle/0001_rls.sql read from `app.current_org`.

export const appointmentStatusEnum = pgEnum("appointment_status", [
  // `pending` exists because a booking that requires payment is real before
  // the money arrives: the slot has to be held, or two customers can both
  // reach the payment page for it.
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "not_required",
  "pending",
  "paid",
  "refunded",
  "partially_refunded",
  "failed",
]);

/** What a business sells: a duration, a price, and its booking rules. */
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    // Separate from the duration: a 50-minute service offered on the hour is
    // duration 50, step 60. Deriving one from the other makes that case
    // unexpressible.
    stepMinutes: integer("step_minutes").notNull().default(15),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    minimumNoticeMinutes: integer("minimum_notice_minutes")
      .notNull()
      .default(60),
    maximumAdvanceDays: integer("maximum_advance_days").notNull().default(60),
    // Minor units, so 4500 is £45.00. Never a float: a price that cannot be
    // represented exactly is a price that will eventually be wrong.
    priceMinor: integer("price_minor").notNull().default(0),
    currency: text("currency").notNull().default("GBP"),
    // How much is taken at booking. Null means the full price.
    depositMinor: integer("deposit_minor"),
    requiresPayment: boolean("requires_payment").notNull().default(false),
    // Hours before the appointment within which a cancellation is no longer
    // refundable.
    cancellationWindowHours: integer("cancellation_window_hours")
      .notNull()
      .default(24),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("services_org_slug_uq").on(t.orgId, t.slug),
    index("services_org_active_idx").on(t.orgId, t.active),
  ],
);

/** A person or room that can serve an appointment. */
export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    // Null for a room or a shared resource that nobody signs in as.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // IANA zone. A business can have staff in different zones, and their
    // working hours are in their own.
    timeZone: text("time_zone").notNull().default("UTC"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("staff_org_idx").on(t.orgId, t.active)],
);

/** Which staff can perform which service. */
export const staffServices = pgTable(
  "staff_services",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.staffId, t.serviceId] }),
    index("staff_services_service_idx").on(t.serviceId),
  ],
);

/**
 * Weekly recurring hours, in local wall-clock minutes past midnight.
 *
 * Stored as rules rather than instants on purpose: "09:00" is a different
 * instant in January and in July, and a stored instant does not survive the
 * next daylight-saving transition. `end_minute` may exceed 1440, which is how
 * a business open until 02:00 describes itself.
 *
 * `staff_id` null means the whole business.
 */
export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, {
      onDelete: "cascade",
    }),
    // 0 = Sunday, matching Date.prototype.getUTCDay.
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    // Optional validity window, so summer hours can be expressed without
    // deleting the winter ones.
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
    createdAt: createdAt(),
  },
  (t) => [
    index("availability_rules_lookup_idx").on(t.orgId, t.staffId, t.weekday),
  ],
);

/**
 * A date whose hours replace the weekly rules entirely.
 *
 * An empty window set means closed. The distinction has to be explicit: with
 * only additive rules there is no way to say "closed on Christmas Day", and
 * with only subtractive ones no way to say "open specially this Sunday".
 */
export const dateOverrides = pgTable(
  "date_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, {
      onDelete: "cascade",
    }),
    // A local date, YYYY-MM-DD, in the zone of the business or the member of
    // staff. Not a timestamp: "the 25th of December" is not an instant.
    onDate: text("on_date").notNull(),
    closed: boolean("closed").notNull().default(false),
    windows: jsonb("windows")
      .$type<{ startMinute: number; endMinute: number }[]>()
      .notNull()
      .default([]),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("date_overrides_uq").on(t.orgId, t.staffId, t.onDate)],
);

/** Time off, holidays, and any other block on real instants. */
export const timeOff = pgTable(
  "time_off",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, {
      onDelete: "cascade",
    }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("time_off_lookup_idx").on(t.orgId, t.staffId, t.startsAt)],
);

/**
 * The people who book. Not `users`: a customer never signs in, and requiring
 * an account to book is the fastest way to lose the booking.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    // The customer's own zone, so a reminder arrives at a sensible hour and
    // a confirmation shows the time they expect.
    timeZone: text("time_zone"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("customers_org_email_idx").on(t.orgId, t.email),
    index("customers_org_phone_idx").on(t.orgId, t.phone),
  ],
);

/**
 * The appointments themselves.
 *
 * `during` is a generated tstzrange over the appointment plus its buffers,
 * and there is an exclusion constraint on it per member of staff. That
 * constraint, not the application, is what makes double booking impossible:
 * checking availability and then inserting is two statements, and two requests
 * can run the check before either inserts. See drizzle/0002_booking.sql.
 */
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // The buffers are copied onto the appointment rather than read from the
    // service, because the service's rules can change afterwards and the
    // block this appointment occupies must not move when they do.
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    status: appointmentStatusEnum("status").notNull().default("pending"),
    paymentStatus: paymentStatusEnum("payment_status")
      .notNull()
      .default("not_required"),
    priceMinor: integer("price_minor").notNull().default(0),
    depositMinor: integer("deposit_minor").notNull().default(0),
    currency: text("currency").notNull().default("GBP"),
    // The zone the customer saw when they booked, so a confirmation or a
    // reschedule can be rendered in the times they actually chose.
    customerTimeZone: text("customer_time_zone"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    // A client-supplied key that makes the booking request safe to retry: a
    // customer double-clicking "confirm" must not produce two appointments.
    idempotencyKey: text("idempotency_key"),
    notes: text("notes"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    // A long random string, so a customer can manage their booking from an
    // emailed link without an account. Not the appointment id: that is
    // guessable in sequence if the id generator ever changes.
    manageToken: text("manage_token").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("appointments_manage_token_uq").on(t.manageToken),
    // Partial unique index in the migration: an idempotency key is only
    // unique when present.
    index("appointments_staff_window_idx").on(t.staffId, t.startsAt),
    index("appointments_org_window_idx").on(t.orgId, t.startsAt),
    index("appointments_customer_idx").on(t.customerId, t.startsAt),
  ],
);

export const reminderChannelEnum = pgEnum("reminder_channel", ["email", "sms"]);
export const reminderStatusEnum = pgEnum("reminder_status", [
  "scheduled",
  "sent",
  "failed",
  "cancelled",
]);

/**
 * Reminders, as rows with a due time rather than timers in a process.
 *
 * A timer dies with the process that holds it. A row survives a restart, can
 * be claimed by exactly one worker, and leaves a record of what was sent --
 * which is the difference between "we think we reminded them" and knowing.
 */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    channel: reminderChannelEnum("channel").notNull(),
    // How long before the appointment this one is for, so rescheduling can
    // recompute the due time instead of guessing.
    offsetMinutes: integer("offset_minutes").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: reminderStatusEnum("status").notNull().default("scheduled"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // The provider's id for the message, so a delivery report can be matched
    // back and a resend can be recognised as a duplicate.
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // One reminder per appointment, channel and offset: the natural key, and
    // what makes scheduling idempotent.
    uniqueIndex("reminders_appointment_channel_offset_uq").on(
      t.appointmentId,
      t.channel,
      t.offsetMinutes,
    ),
    index("reminders_due_idx").on(t.status, t.dueAt),
  ],
);

// Infrastructure tables. Not tenant scoped.

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  allowed: boolean("allowed").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export type Role = (typeof roleEnum.enumValues)[number];
export type Plan = (typeof planEnum.enumValues)[number];
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type AvailabilityRule = typeof availabilityRules.$inferSelect;
export type DateOverrideRow = typeof dateOverrides.$inferSelect;
export type TimeOff = typeof timeOff.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type AppointmentStatus =
  (typeof appointmentStatusEnum.enumValues)[number];
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type ReminderChannel = (typeof reminderChannelEnum.enumValues)[number];
export type ReminderStatus = (typeof reminderStatusEnum.enumValues)[number];
