import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { icaoFor, normFlightNumber } from "#~/flights/airlines.ts";
import { checkFlight, keyOf, nearDuplicate, toAirtrail } from "#~/flights/index.ts";
import { OWNER, segment } from "#~/test-helpers.ts";

describe("flight conversion", () => {
  it("normalises flight numbers and airlines", async () => {
    assert.equal(normFlightNumber("BR 0096"), "BR96");
    assert.equal(icaoFor("W6 4312"), "WZZ");
    assert.equal(icaoFor("CA446"), "CCA");
    assert.equal(icaoFor("ZZ9"), undefined);
    assert.equal(keyOf("2024-07-14T10:00", "mxp", "otp"), "2024-07-14|MXP|OTP");
  });

  it("gives a guest an explicit null userId", async () => {
    // AirTrail 400s with invalid_type on an omitted userId key.
    const body = toAirtrail(segment({ guests: ["sara capogreco"] }), OWNER);
    const guest = body.passengers.find((p) => p.guestName)!;
    assert.equal(guest.userId, null);
    assert.equal(guest.guestName, "Sara Capogreco");
    assert.equal(body.airline, "WZZ");
    assert.equal(body.flightNumber, "W64312");
    assert.deepEqual(checkFlight(body, OWNER), []);
  });

  it("rejects a flight the owner is not a passenger on", async () => {
    const body = toAirtrail(segment({ guests: ["someone else"] }), OWNER);
    body.passengers = body.passengers.filter((p) => p.guestName); // owner removed
    assert.ok(checkFlight(body, OWNER).length > 0, "owner-absent flight must be rejected");
  });

  it("rejects malformed routes", async () => {
    const body = toAirtrail(segment(), OWNER);
    assert.ok(checkFlight({ ...body, from: "Milan" }, OWNER).length > 0);
    assert.ok(checkFlight({ ...body, to: body.from }, OWNER).length > 0);
    assert.ok(checkFlight({ ...body, departure: "26/10/2024" }, OWNER).length > 0);
  });

  it("drops an invalid seat class instead of sending it", async () => {
    const body = toAirtrail(segment({ seatClass: "coach" }), OWNER);
    assert.equal(body.passengers[0].seatClass, undefined);
    assert.equal(
      toAirtrail(segment({ seatClass: "business" }), OWNER).passengers[0].seatClass,
      "business",
    );
  });

  it("catches a one-day model date slip on the same flight number", async () => {
    const logged = [
      { flightNumber: "TK1895", date: "2026-10-31" },
      { flightNumber: "FR4475", date: "2022-06-24" },
    ];
    assert.equal(
      nearDuplicate({ flightNumber: "TK1895", departure: "2026-10-30" }, logged, 2),
      "2026-10-31",
    );
    assert.equal(
      nearDuplicate({ flightNumber: "TK1895", departure: "2026-12-25" }, logged, 2),
      null,
    );
    assert.equal(
      nearDuplicate({ flightNumber: "TK197", departure: "2026-10-31" }, logged, 2),
      null,
    );
    assert.equal(nearDuplicate({ departure: "2026-10-31" }, logged, 2), null);
  });
});
