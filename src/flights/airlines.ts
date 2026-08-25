/** Airline identification: flight-number normalisation and the ICAO lookup AirTrail wants. */

/** Flight-number prefix -> airline ICAO, which is what AirTrail's `airline` field wants. */
const PREFIX_ICAO: Record<string, string> = {
  FR: "RYR",
  RK: "RUK",
  FQ: "MAY",
  W6: "WZZ",
  W4: "WMT",
  W9: "WAZ",
  IB: "IBE",
  QR: "QTR",
  TK: "THY",
  BR: "EVA",
  U2: "EZY",
  AV: "AVA",
  LH: "DLH",
  VY: "VLG",
  RO: "ROT",
  A3: "AEE",
  KL: "KLM",
  AF: "AFR",
  V7: "VOE",
  OS: "AUA",
  LX: "SWR",
  HV: "TRA",
  DY: "NAX",
  EW: "EWG",
  EK: "UAE",
  AZ: "ITY",
  TP: "TAP",
  AY: "FIN",
  PC: "PGT",
  EI: "EIN",
  BA: "BAW",
  SN: "BEL",
  LO: "LOT",
  LA: "LAN",
  AA: "AAL",
  DL: "DAL",
  UA: "UAL",
  SK: "SAS",
  "7C": "JJA",
  KE: "KAL",
  OZ: "AAR",
  JL: "JAL",
  NH: "ANA",
  CA: "CCA",
  MU: "CES",
  CZ: "CSN",
  MS: "MSR",
  ET: "ETH",
  SU: "AFL",
  TU: "TAR",
  AT: "RAM",
  UX: "AEA",
  TO: "TVF",
  XQ: "SXS",
};

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
