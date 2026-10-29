# booking-saas

Appointment booking for local businesses. A public booking page, a diary that
cannot be double-booked, deposits taken through Stripe, and SMS reminders.

Built on top of [saas-starter](https://github.com/MahyarNemati/saas-starter) —
organizations, roles, invitations, API keys, audit log, Stripe subscriptions
and Postgres row-level security — so what is new here is the booking domain.

```
customer                      this app                        Postgres
────────                      ────────                        ────────
GET /b/snips/dry-cut   ──▶  server component
                              ├─ loadAvailability()      ──▶  rules, overrides,
                              │                               time off, diary
                              └─ availableSlots()             (pure, no I/O)
                       ◀──  slots, rendered

POST /api/public/      ──▶  rate limit ─▶ isSlotBookable()
     bookings                            └─ INSERT appointment
                                                     │
                                            EXCLUDE USING gist
                                            (staff_id =, during &&)
                       ◀──  201, or 409 "that time has just been taken"

                            worker (separate process)
                              ├─ claim leased reminders ─▶ SMS / email
                              └─ release unpaid holds
Stripe  ──▶ POST /api/webhooks/payments ─▶ appointment confirmed
```

## Why this exists

Two problems in a booking system are harder than they look, and almost every
hand-rolled one gets at least one of them wrong.

**Two customers must not be sold the same half hour.** Checking availability
and then inserting is two statements, and two requests can both pass the check
before either inserts. No amount of care in the application closes that
window — so the guarantee is a Postgres exclusion constraint, and the
application's job is to turn its error into a sentence a customer can read.

**"We open at nine" is not a UTC offset.** It is a wall-clock time in a named
zone, which means a different instant in January and in July, and twice a year
there is a nine that happens twice or not at all. Opening hours are therefore
stored as local rules and expanded per query, never flattened into instants.

Everything else here — the forms, the emails, the Stripe plumbing — is
ordinary. Those two things are the project.

## Quickstart

Needs Node 22 or newer and a Postgres 17 server.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL and AUTH_SECRET
npm run db:migrate
npm run seed                  # creates "Snips", a salon with real opening hours
npm run dev
```

Then open **http://localhost:3000/b/snips** and book something.

In another terminal, for reminders and expiring holds:

```bash
npm run worker
```

Or the whole thing in containers:

```bash
docker compose up --build -d postgres app
docker compose run --rm migrate
docker compose run --rm seed
docker compose up -d worker
open http://localhost:3000/b/snips
```

## How the availability engine works

`src/domain/time/` is pure: no database, no clock of its own, no network. That
is what makes the awkward cases testable, and the awkward cases are the whole
difficulty.

| File              | What it owns                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `interval.ts`     | half-open intervals on the UTC timeline, and set algebra over them |
| `zone.ts`         | wall-clock arithmetic in an IANA zone, in both directions          |
| `schedule.ts`     | weekly rules and date overrides, expanded into UTC intervals       |
| `availability.ts` | the slot engine: hours, buffers, bookings, notice, staff           |

### Intervals are half-open

`[start, end)`. A 09:00–10:00 appointment and a 10:00–11:00 appointment do not
overlap. With closed intervals they would, and the business could not book
back-to-back customers — which is the single most common bug in a hand-rolled
booking system, and the reason the database range is `'[)'` as well.

### The two time-zone conversions

Instant to wall clock is easy: `Intl` does it. Wall clock to instant is not,
because the mapping is neither total nor injective:

- **A gap.** 01:30 on the spring-forward Sunday in London does not exist.
- **An overlap.** 01:30 on the autumn Sunday happens twice.

Both are represented rather than hidden, because the right answer depends on
what the time means. For a recurring opening hour, skipping the day would
close the business, so a gap time shifts forward — "half past one" means 02:30
on a day when half past one did not happen. For an appointment someone typed
in, the right answer is to refuse it. `resolve()` reports which case it is and
`instantOf()` takes a policy.

There is no transition table in `Intl`, so the conversion is a two-step fixed
point: guess the instant using the offset in force nearby, check what wall
clock that instant actually shows, and keep only guesses that match. A gap time
produces no candidates; an ambiguous one produces two. That is the whole test.

No date library. The zone database is already in the runtime, and shipping a
second copy of it that drifts from the first is worse than no dependency.

### Why hours are rules, not instants

A rule outlives the next transition and a stored instant does not. `09:00`
on a Tuesday stays `09:00` while the UTC instant moves by an hour twice a
year. `end_minute` may exceed 1440, which is how a business open until 02:00
describes itself — and querying a single day still finds the small hours,
because they belong to the previous day's rule.

### What the slot engine actually computes

Per member of staff:

1. `open` = business hours ∩ their hours, over the requested range
2. `blocked` = their appointments and time off, each grown by _its own_ buffers
3. candidate starts come from slicing `open`
4. a candidate survives if the appointment plus _this_ service's buffers
   overlaps nothing in `blocked`
5. finally the bookable window — minimum notice, maximum advance — filters the
   finished slots

Two details in there are the ones that get written wrong, and both were bugs
in this code that its tests caught:

- **Buffers are checked against bookings, not against opening hours.** Prep
  before the first appointment of the day and clean-up after the last are work
  the staff do outside trading hours. Requiring the buffers to fit inside the
  opening window silently deletes the first and last slot of every day.
- **The grid comes from the opening hours, and the bookable window is applied
  afterwards.** Clipping the hours to "now plus an hour's notice" first makes
  the offered times drift with the clock — 10:05, 10:35 instead of 10:30,
  11:00 — and it breaks the re-check at write time outright, because that
  searches a window of one slot: any start time then lands on the grid, and a
  crafted request can book 10:15 when only 10:00 and 10:30 were ever offered.

A slot is returned with the staff who could serve it, not as a bare time,
because "10:00 is available" is not actionable: booking it needs a resource.

## How double booking is prevented

Three layers, and the first two are not sufficient on their own.

**The slot list** only offers what is free when the page is rendered.

**A re-check at write time** (`isSlotBookable`) catches the customer whose
browser has been showing a stale list for twenty minutes, and gives them a
sentence rather than a surprise.

**An exclusion constraint** catches what neither can:

```sql
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_double_booking
  EXCLUDE USING gist (staff_id WITH =, during WITH &&)
  WHERE (status <> 'cancelled');
```

`during` is a generated `tstzrange` over the appointment plus its buffers, so
the index and the constraint are built from the same definition the rows carry.
`WHERE (status <> 'cancelled')` means cancelling genuinely frees the slot while
the row is kept for the record. There is a second constraint on `customer_id`,
because a person cannot be in two places either.

Postgres raises `23P01`, which the service layer treats as the expected outcome
of a race rather than an unexpected error: it becomes the same 409 the customer
would have seen a moment earlier, without the `DETAIL` that names the other
booking.

### The generated-column detail

The obvious way to write `during` is a generated column over `starts_at` and
the buffer minutes. Postgres refuses it: `timestamptz - interval` is `STABLE`,
not `IMMUTABLE`, because interval arithmetic depends on the session's
`TimeZone`, and a generated column may only use immutable expressions.

So a `BEFORE` trigger derives `blocked_from` and `blocked_to`, and `during` is
generated from those two timestamps. A trigger rather than the application,
because an application that fills those columns can fill them wrongly — a
stale buffer, a forgotten update path — and the constraint would then protect
the wrong interval. There is a test asserting that an insert supplying its own
narrower block is overwritten.

## Payments

The money is the source of truth and the webhook is what reports it.

A customer whose card succeeds and whose network then drops has paid. So the
booking is confirmed in the webhook handler and nowhere else, and the
thank-you page _reads_ the appointment rather than asserting anything about it.
The event id is recorded in the same transaction as its effect: a crash
between the two lets Stripe retry, and a redelivery after commit is a no-op.

- A booking that needs paying for is `pending` and **holds its slot**, or two
  customers reach the payment page for the same half hour.
- A declined card does **not** cancel the booking — a second attempt usually
  follows, and cancelling would give the slot away in between. A sweeper
  releases holds older than `BOOKING_HOLD_MINUTES` (30 by default; generous,
  because a customer fetching a card from another room is normal).
- A payment arriving for an already-cancelled booking keeps the booking
  cancelled, records the payment, and logs loudly: the slot is gone and a
  refund is owed.
- A refund is requested _after_ the cancellation is recorded, and a refund
  that fails does not undo it. A cancellation lost because a refund failed
  leaves the customer with no slot _and_ a live booking.

## Reminders

Rows with a due time, not timers. A booking made in January for March cannot
depend on a process staying up, and a row survives a restart, can be claimed
by exactly one worker, and leaves a record of what was sent.

Scheduling is idempotent on `(appointment, channel, offset)`, so a reschedule
moves the due times and resets a reminder already sent for the old date —
rather than adding a second set, or leaving the customer holding a message
about a day that has changed.

The claim is **leased**, and this is the part worth reading:

```sql
select id from reminders
where due_at <= now()
  and (status = 'scheduled'
       or (status = 'sending' and claimed_at < now() - interval '5 minutes'))
order by due_at limit 100
for update skip locked
```

`SKIP LOCKED` stops two workers reading the same row in the same instant. That
alone is not enough: the lock lasts only as long as the transaction and the
message is sent _after_ it commits, so a row left `scheduled` is claimable
again the moment the claiming transaction ends — and the customer is texted
twice. Rows therefore move to `sending` with the time claimed. Reclaiming an
expired lease is also what recovers a worker that died mid-send, with no
separate sweeper to write and forget about.

Text is rendered in the **customer's** zone when it is known, and names the
zone when it differs from the business's. A reminder saying 09:00 to someone
whose phone says 10:00 is worse than no reminder: they will trust the message.

A transient failure is retried up to four times; a permanent one is abandoned
at once. Retrying an invalid number burns the budget and eventually looks like
an outage.

## Tenant isolation

Inherited and extended. Every booking table carries `org_id` and gets the same
dull policy: it must equal `app.current_org`, for reads and for writes. The
application connects as the schema owner and drops to an unprivileged role
inside `withTenant()`, and both settings are transaction-local so they cannot
leak to the next borrower of a pooled connection.

On top of that, composite `(org_id, id)` foreign keys mean an appointment's
service, staff member and customer must all belong to the same organization as
the appointment. A bug in one endpoint cannot become a cross-tenant booking.

One interaction worth knowing: constraints are enforced regardless of
row-level security, so a tenant can be refused by a constraint on a row it
cannot see. The composite keys make that harmless here, and the service layer
does not pass the database's message through.

## API

The customer-facing endpoints need no account:

```
POST /api/public/bookings                   make a booking
POST /api/public/bookings/{token}/cancel    cancel with the emailed link
POST /api/webhooks/payments                 Stripe's callback
```

`{token}` is 32 random bytes, unique, and compared in constant time. It is the
credential, which is why it is not the appointment id.

The diary is available to an integration with an API key:

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:3000/api/v1/appointments?from=2026-06-01T00:00:00Z&to=2026-06-08T00:00:00Z"
```

## Configuration

| Variable                                                 | Default                 | Notes                                                                                                         |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                           | —                       | required                                                                                                      |
| `AUTH_SECRET`                                            | —                       | required, 32 characters or more                                                                               |
| `APP_URL`                                                | `http://localhost:3000` | used in links                                                                                                 |
| `RATE_LIMIT_BACKEND`                                     | `postgres`              | must be `postgres` in production: an in-memory bucket is per instance, so it does not bound a public endpoint |
| `BOOKING_HOLD_MINUTES`                                   | `30`                    | how long an unpaid booking keeps its slot                                                                     |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`             | —                       | deposits are off without them                                                                                 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | —                       | all three or none; without them SMS is logged, not sent                                                       |
| `LOG_LEVEL`                                              | `info`                  |                                                                                                               |

A business's own settings — time zone, reminder offsets — live on its
`organizations` row, not in the environment.

## Tests

```bash
npm test          # 246 unit and integration tests
npm run test:e2e  # 5 in a browser
npm run lint && npm run typecheck && npm run format:check
```

The database-backed suites skip silently without `TEST_DATABASE_URL`, and
those are the ones that prove the guarantees — so CI asserts by name that
`rls`, `booking`, `payments` and `reminders` actually ran, rather than
trusting a green tick.

What they cover, and why those cases:

- **The engine**, against both daylight-saving directions in both hemispheres,
  Lord Howe's half-hour jump, the hour that happens twice, Samoa's skipped
  day, zones at `:45` offsets, opening past midnight, per-staff hours in
  different zones, date overrides, and notice and advance limits. The set
  algebra also has property-based tests, because a bug there would show up as
  an occasional double booking — the hardest kind to reproduce.
- **Two concurrent transactions** racing for one slot: exactly one wins, and
  the loser gets a sentence, not a constraint name.
- **Two simultaneous retries** of the same idempotency key: one appointment.
- Cancel freeing the slot while keeping the row; reschedule excluding itself
  from its own availability check; a manage token of the right length but the
  wrong value being refused.
- **Payment paths**, including a refund that is declined, a refund whose
  provider is unreachable, a redelivered webhook, and a payment that arrives
  after the booking was cancelled.
- **Reminder paths**, including a worker that dies mid-send, two workers
  claiming at once, a permanently invalid recipient, and one bad number not
  stopping the rest of the batch.

CI additionally applies the migrations to an empty database and then asserts
the exclusion constraints, the generated column, the trigger and row-level
security are all really there — they live in hand-written migrations, which
is exactly the sort of thing a regenerate can quietly drop. It also runs the
compose quickstart from this README end to end, so the instructions above
cannot rot.

## Known limitations

Stated rather than discovered:

- **No admin UI.** The diary is readable through the API-key endpoint and the
  booking domain is fully exercised by tests, but there is no interactive
  screen for managing services, staff or opening hours. The services underneath
  one are written and tested; the screens are not.
- **No calendar sync.** Google Calendar two-way sync is the obvious next thing
  and is not here. The hard half — a conflict-free diary — is.
- **No email provider wired.** Email reminders go through the same
  `MessageSender` interface as SMS and currently use the logging sender.
- **Group bookings and capacity are not modelled.** One appointment occupies
  one member of staff. A class with twelve places needs a different constraint.
- **Recurring appointments are not modelled.** The _rules_ recur; appointments
  do not.
- **The monthly booking allowance turns over at UTC midnight**, so a business
  in Auckland sees its month roll over mid-afternoon. A per-organization month
  boundary is a more interesting query than the limit is worth today.
- **`if_tsresol` aside**, timestamps are stored as `timestamptz` and are
  exact; it is only the _display_ that depends on a zone, which is why the
  zone a customer booked in is recorded on the appointment.

## Licence

MIT. See [LICENSE](LICENSE).
