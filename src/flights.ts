/**
 * Flights handler — files flight segments from a Papra document into AirTrail.
 *
 * Runs only when the tags just applied include one of `[handlers.flights] tags`
 * (default `viaggi`), so this second model call never happens for the ~95% of an
 * archive that is not travel. That gate is the cost control.
 *
 * Two rules were learned the hard way and are enforced here in code rather than
 * trusted to the model:
 *
 *   - The owner must appear in the document's PASSENGER list. Flights booked for
 *     family are addressed to the owner but flown by someone else, so the model
 *     reports `ownerIsAboard` and `checkFlight` independently re-verifies that
 *     exactly one passenger carries the owner's userId before anything is sent.
 *   - Dedup keys on (date, origin, destination), never on flight number: one
 *     physical flight arrives under codeshare numbers (IB6660 == LA2485) and
 *     carrier variants (Wizz W4 vs W6).
 */

import type { Config } from "./config.ts";
import type { Document } from "./papra.ts";
import type { AirtrailFlight, Ports } from "./ports.ts";

/** Flight-number prefix -> airline ICAO, which is what AirTrail's `airline` field wants. */
const PREFIX_ICAO: Record<string, string> = {
  FR: "RYR", RK: "RUK", FQ: "MAY", W6: "WZZ", W4: "WMT", W9: "WAZ",
  IB: "IBE", QR: "QTR", TK: "THY", BR: "EVA", U2: "EZY", AV: "AVA",
  LH: "DLH", VY: "VLG", RO: "ROT", A3: "AEE", KL: "KLM", AF: "AFR",
  V7: "VOE", OS: "AUA", LX: "SWR", HV: "TRA", DY: "NAX", EW: "EWG",
  EK: "UAE", AZ: "ITY", TP: "TAP", AY: "FIN", PC: "PGT", EI: "EIN",
  BA: "BAW", SN: "BEL", LO: "LOT", LA: "LAN", AA: "AAL", DL: "DAL",
  UA: "UAL", SK: "SAS", "7C": "JJA", KE: "KAL", OZ: "AAR", JL: "JAL",
  NH: "ANA", CA: "CCA", MU: "CES", CZ: "CSN", MS: "MSR", ET: "ETH",
  SU: "AFL", TU: "TAR", AT: "RAM", UX: "AEA", TO: "TVF", XQ: "SXS",
};

const SEAT_CLASSES = new Set(["economy", "economy+", "business", "first", "private"]);

export interface Segment {
  from: string;
  to: string;
  departure: string;
  departureTime?: string;
  arrival?: string;
  arrivalTime?: string;
  flightNumber?: string;
  seatNumber?: string;
  seatClass?: string;
  guests?: string[];
  ownerIsAboard: boolean;
  evidence: string;
}

export interface Passenger {
  userId: string | null;
  guestName: string | null;
  seatNumber?: string;
  seatClass?: string;
}

export interface FlightBody {
  from: string;
  to: string;
  departure: string;
  departureTime?: string;
  arrival?: string;
  arrivalTime?: string;
  flightNumber?: string;
  airline?: string;
  passengers: Passenger[];
}

export const FLIGHTS_SCHEMA = {
  type: "object",
  properties: {
    flights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          departure: { type: "string" },
          departureTime: { type: "string" },
          arrival: { type: "string" },
          arrivalTime: { type: "string" },
          flightNumber: { type: "string" },
          seatNumber: { type: "string" },
          seatClass: { type: "string" },
          guests: { type: "array", items: { type: "string" } },
          ownerIsAboard: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["from", "to", "departure", "ownerIsAboard", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["flights"],
  additionalProperties: false,
} as const;

export function flightsPrompt(ownerNames: string[]): string {
  return `You extract flight segments from a document's OCR text.

The archive owner is: ${ownerNames.join(" | ")}

RULES
1. Return a segment only if the owner appears in the document's PASSENGER LIST.
   Being addressed, greeted, or named as the booker/"customer contact"/payer is
   NOT evidence of flying — the owner books flights for family members, and those
   documents are still addressed to the owner. If the passenger list names only
   other people, return no segments.
2. One object per flight segment (one takeoff and one landing). A return trip is
   two objects; each leg of a connection is its own object. Never merge legs.
3. Airports as 3-letter IATA codes. Dates as YYYY-MM-DD. Times local 24h HH:MM.
4. Other passengers on the same booking go in \`guests\` as full names.
5. Invent nothing; omit any field the document does not state. If the document is
   not a flight document, return {"flights": []}.
6. Ignore cancelled bookings and documents that merely quote or advertise flights.`;
}

/** Uppercase, strip separators, drop leading zeros: 'BR 0096' -> 'BR96'. */
export function normFlightNumber(value: string | undefined): string {
  const compact = (value ?? "").toUpperCase().replaceAll(" ", "").replaceAll("-", "");
  const match = /^([A-Z0-9]{2})0*(\d+)$/.exec(compact);
  return match ? `${match[1]}${match[2]}` : compact;
}

export function icaoFor(flightNumber: string | undefined): string | undefined {
  const match = /^([A-Z0-9]{2})\d/.exec(normFlightNumber(flightNumber));
  return match ? PREFIX_ICAO[match[1]] : undefined;
}

export function keyOf(when: string | undefined, origin: string | undefined, destination: string | undefined): string {
  return [String(when ?? "").slice(0, 10), (origin ?? "").toUpperCase(), (destination ?? "").toUpperCase()].join("|");
}

/**
 * Same flight number already logged within `days` of the proposed date.
 *
 * An overnight connection straddles midnight, and a model reading OCR routinely
 * takes the departure date off the wrong line — TK1895 IST-MXP is the 31 Oct leg
 * of a 30 Oct itinerary. Route and number match an existing flight and only the
 * date slips, so the (date, route) key sees a brand-new segment and would
 * duplicate one already logged. Prefer a false "needs review" over that.
 */
export function nearDuplicate(
  body: Pick<FlightBody, "flightNumber" | "departure">,
  logged: { flightNumber: string; date: string }[],
  days: number,
): string | null {
  const number = body.flightNumber;
  if (!number) return null;
  const want = Date.parse(`${body.departure}T00:00:00Z`);
  if (Number.isNaN(want)) return null;
  for (const other of logged) {
    if (other.flightNumber !== number) continue;
    const have = Date.parse(`${other.date}T00:00:00Z`);
    if (Number.isNaN(have)) continue;
    if (Math.abs(want - have) / 86_400_000 <= days) return other.date;
  }
  return null;
}

export function toAirtrail(segment: Segment, ownerUserId: string): FlightBody {
  const body: FlightBody = {
    from: (segment.from ?? "").toUpperCase(),
    to: (segment.to ?? "").toUpperCase(),
    departure: String(segment.departure ?? "").slice(0, 10),
    passengers: [],
  };
  if (segment.departureTime) body.departureTime = segment.departureTime;
  if (segment.arrivalTime) body.arrivalTime = segment.arrivalTime;
  if (segment.arrival) body.arrival = String(segment.arrival).slice(0, 10);

  const number = normFlightNumber(segment.flightNumber);
  if (number) body.flightNumber = number;
  const icao = icaoFor(number);
  if (icao) body.airline = icao;

  const me: Passenger = { userId: ownerUserId, guestName: null };
  if (segment.seatNumber) me.seatNumber = segment.seatNumber;
  if (segment.seatClass && SEAT_CLASSES.has(segment.seatClass)) me.seatClass = segment.seatClass;

  // AirTrail rejects a passenger whose userId key is absent: a guest needs an
  // explicit null, not an omitted field, or the save 400s with invalid_type.
  const guests: Passenger[] = (segment.guests ?? [])
    .filter((guest) => guest && guest.trim())
    .map((guest) => ({ userId: null, guestName: titleCase(guest.trim()) }));

  body.passengers = [me, ...guests];
  return body;
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/** Problems that must block a push. An empty array means safe to send. */
export function checkFlight(body: FlightBody, ownerUserId: string): string[] {
  const problems: string[] = [];
  if (!/^[A-Z]{3}$/.test(body.from)) problems.push(`bad origin ${JSON.stringify(body.from)}`);
  if (!/^[A-Z]{3}$/.test(body.to)) problems.push(`bad destination ${JSON.stringify(body.to)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.departure)) {
    problems.push(`bad date ${JSON.stringify(body.departure)}`);
  }
  if (body.from && body.from === body.to) problems.push("origin equals destination");
  const mine = body.passengers.filter((passenger) => passenger.userId === ownerUserId);
  if (mine.length !== 1) problems.push(`owner not the sole userId passenger (${mine.length})`);
  return problems;
}

export async function handleFlights(
  config: Config,
  ports: Ports,
  doc: Document,
  ownerUserId: string,
  dryRun = false,
): Promise<string[]> {
  const answer = await ports.askModel(
    "flights",
    flightsPrompt(config.flights.ownerNames),
    `Document name: ${doc.originalName || doc.name}\n\n${doc.content.slice(0, config.papra.contentLimit)}`,
    FLIGHTS_SCHEMA,
  );
  const segments: Segment[] = answer?.flights ?? [];

  const existing = await ports.listFlights();
  const known = new Set<string>();
  const logged: { flightNumber: string; date: string }[] = [];
  for (const flight of existing) {
    known.add(keyOf(flight.date, flight.from?.iata, flight.to?.iata));
    const number = normFlightNumber(flight.flightNumber);
    if (number) logged.push({ flightNumber: number, date: String(flight.date ?? "").slice(0, 10) });
  }

  const added: string[] = [];
  for (const segment of segments) {
    if (!segment.ownerIsAboard) continue;

    const body = toAirtrail(segment, ownerUserId);
    const problems = checkFlight(body, ownerUserId);
    if (problems.length > 0) {
      ports.log(`    ! ${doc.name.slice(0, 40)}: ${problems.join("; ")}`);
      continue;
    }

    const key = keyOf(body.departure, body.from, body.to);
    if (known.has(key)) continue;

    const clash = nearDuplicate(body, logged, config.flights.nearDuplicateDays);
    if (clash) {
      ports.log(
        `    ~ ${body.flightNumber} on ${body.departure} looks like the ${clash} flight ` +
          "already logged — skipped for review",
      );
      continue;
    }

    const label = `${body.departure} ${body.from}->${body.to} ${body.flightNumber ?? ""}`.trim();
    if (!dryRun) await ports.saveFlight(body);
    known.add(key);
    if (body.flightNumber) logged.push({ flightNumber: body.flightNumber, date: body.departure });
    added.push(dryRun ? `WOULD ADD ${label}` : label);
  }
  return added;
}
