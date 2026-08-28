/** The flights extraction call: structured-output schema and prompt. */

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

export function flightsPrompt(
  ownerNames: string[],
  today: string = new Date().toISOString().slice(0, 10),
): string {
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
6. Ignore cancelled bookings and documents that merely quote or advertise flights.
7. Today is ${today}. Use it only to resolve a date whose year the document
   omits — it is never a travel date itself.`;
}
