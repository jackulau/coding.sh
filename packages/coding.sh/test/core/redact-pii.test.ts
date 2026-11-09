// The opt-in PII pack (capture.redact "pii"): emails, phone numbers, card
// numbers (issuer prefix + Luhn), IBANs (country length + mod 97) and national
// ids (US SSN, UK NINO, Canadian SIN). Ids, versions, timestamps and paths that
// look like numbers must pass through. Card numbers and IBANs are built with
// .join("") so no vendor-shaped literal sits in the source.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor, ibanValid, luhnValid, PII_KINDS, REDACTORS } from "../../src/core/redact.ts";
import { loadConfig } from "../../src/core/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const j = (...parts: string[]) => parts.join("");

// [label, text, the redacted form]
const POSITIVES: [string, string, string][] = [
  ["email", "mail jane.doe@example.com today", "mail [redacted:email] today"],
  ["email with tag and subdomain", "a+tag@mail.example.co.uk", "[redacted:email]"],
  ["phone E.164", "call +14155552671", "call [redacted:phone]"],
  ["phone +1 spaced", "+1 415 555 2671", "[redacted:phone]"],
  ["phone +1 with area parens", "tel: +1 (415) 555-2671.", "tel: [redacted:phone]."],
  ["phone UK", "+44 20 7946 0958", "[redacted:phone]"],
  ["phone DE", "Tel. +49 30 901820", "Tel. [redacted:phone]"],
  ["phone FR pairs", "+33 1 42 68 53 00", "[redacted:phone]"],
  ["phone JP dashed", "+81-3-1234-5678", "[redacted:phone]"],
  ["phone IN", "+91 98765 43210", "[redacted:phone]"],
  ["phone NANP parens", "(415) 555-2671", "[redacted:phone]"],
  ["phone NANP dashed", "phone: 415-555-2671", "phone: [redacted:phone]"],
  ["phone NANP dotted", "415.555.2671", "[redacted:phone]"],
  ["card Visa grouped", j("card 4111 ", "1111 1111 1111 exp 12/29"), "card [redacted:card] exp 12/29"],
  ["card Visa dashed", j("4012-8888-", "8888-1881"), "[redacted:card]"],
  ["card Visa unbroken", j("40128888", "88881881"), "[redacted:card]"],
  ["card Visa 13", j("42222222", "22222"), "[redacted:card]"],
  ["card Mastercard", j("5555 5555 ", "5555 4444"), "[redacted:card]"],
  ["card Mastercard 2-series", j("2223 0031 ", "2200 3222"), "[redacted:card]"],
  ["card Amex 4-6-5", j("3782 822463 ", "10005"), "[redacted:card]"],
  ["card Amex unbroken", j("3714496", "35398431"), "[redacted:card]"],
  ["card Discover", j("6011 0009 ", "9013 9424"), "[redacted:card]"],
  ["card JCB", j("3566 0020 ", "2036 0505"), "[redacted:card]"],
  ["card Diners 4-6-4", j("3056 930902 ", "5904"), "[redacted:card]"],
  ["card UnionPay", j("6200 0000 ", "0000 0005"), "[redacted:card]"],
  ["IBAN DE grouped", j("IBAN DE89 3704 ", "0044 0532 0130 00"), "IBAN [redacted:iban]"],
  ["IBAN GB", j("GB82WEST", "12345698765432"), "[redacted:iban]"],
  ["IBAN FR", j("FR142004101005", "0500013M02606"), "[redacted:iban]"],
  ["IBAN NL", j("NL91ABNA", "0417164300"), "[redacted:iban]"],
  ["IBAN NO, shortest", j("NO938601", "1117947"), "[redacted:iban]"],
  ["IBAN CH", j("CH9300762", "011623852957"), "[redacted:iban]"],
  ["US SSN", "ssn 536-22-1234", "ssn [redacted:national-id]"],
  ["UK NINO", "NI: AB 12 34 56 C", "NI: [redacted:national-id]"],
  ["UK NINO unbroken", "JG103759A", "[redacted:national-id]"],
  ["Canadian SIN", "SIN 130 692 544", "SIN [redacted:national-id]"],
  ["two in a JSON string", j('{"phone":"+1 415 555 2671","card":"4111', "111111111111", '"}'), '{"phone":"[redacted:phone]","card":"[redacted:card]"}'],
];

const NEGATIVES: [string, string][] = [
  ["git sha", "commit 3f786850e387550fdab836ed7e6dc881de23001b"],
  ["short sha", "0275114d fix(store)"],
  ["semver", "bump to 1.2.3"],
  ["v-semver", "node v10.24.1"],
  ["semver build metadata", "1.0.0+20130313144700"],
  ["four-part version", "1.2.3.4"],
  ["UUID", "123e4567-e89b-12d3-a456-426614174000"],
  ["all-digit UUID", "12345678-1234-1234-1234-123456789012"],
  ["file path and line", "/Users/x/proj/src/a.ts:120:5"],
  ["Windows path", "C:\\Users\\x\\proj\\src\\a.ts"],
  ["port", "localhost:3000"],
  ["ip and port", "127.0.0.1:8080"],
  ["ISO timestamp", "2026-11-08T10:30:00.000Z"],
  ["timestamp with offset", "2026-11-08T10:30:00+0000"],
  ["tz offset", "+05:30"],
  ["epoch ms", "ts=1731060000000"],
  ["epoch s", "1731060000"],
  ["IPv4", "192.168.1.1"],
  ["npm spec", "coding.sh@0.1.3"],
  ["retina image", "icon@2x.png"],
  ["money", "$1,234,567.89"],
  ["Luhn-invalid card", j("4111 1111 ", "1111 1112")],
  ["card digits with mixed separators", j("4111 1111-", "1111 1111")],
  ["unbroken number, no issuer", "9876543210123456"],
  ["ISBN", "ISBN 978-3-16-148410-0"],
  ["US date", "11/08/2026"],
  ["date", "2026-11-08"],
  ["time", "10:30:45"],
  ["digest", "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["hex", "0x7fffffff"],
  ["issue number", "issue #12345"],
  ["ten digits unbroken", "id 1234567890"],
  ["IBAN with a bad check", j("DE00 3704 ", "0044 0532 0130 00")],
  ["IBAN-shaped, wrong length", j("DE89370400", "4405320130")],
  ["SSN area 000", "000-12-3456"],
  ["SSN area 666", "666-12-3456"],
  ["SIN with a bad check digit", "130 692 545"],
  ["NINO without suffix", "AB123456"],
  ["too few digits after +", "+1 23"],
  ["float", "3.14159265358979"],
  ["order id", "ORD-2026-000123"],
  ["docker tag", "node:22.15.0-alpine"],
  ["css color", "#ff0000"],
  ["base64", "dGhpcyBpcyBhIHRlc3Q="],
  ["HTTP line", "HTTP/1.1 200 OK"],
  ["tsc position", "src/a.ts(3,1): error TS2304"],
];

const pii = createRedactor({ redact: ["secrets", "pii"] });

describe("PII pack", () => {
  it(`has at least 30 positives and 30 negatives (${POSITIVES.length} / ${NEGATIVES.length})`, () => {
    assert.ok(POSITIVES.length >= 30);
    assert.ok(NEGATIVES.length >= 30);
  });

  for (const [label, text, expect] of POSITIVES) it(`redacts ${label}`, () => assert.equal(pii.string(text), expect));
  for (const [label, text] of NEGATIVES) it(`leaves ${label}`, () => assert.equal(pii.string(text), text));

  it("is opt-in: the default redactor leaves personal data alone", () => {
    const def = createRedactor();
    for (const [, text] of POSITIVES.filter(([l]) => !l.startsWith("email"))) assert.equal(def.string(text), text);
  });

  it("each kind turns on alone", () => {
    const phone = createRedactor({ redact: ["phone"] });
    assert.equal(phone.string(j("+1 415 555 2671 ", "4111111111111111")), j("[redacted:phone] ", "4111111111111111"));
    const card = createRedactor({ redact: ["card"] });
    assert.equal(card.string(j("+1 415 555 2671 ", "4111111111111111")), "+1 415 555 2671 [redacted:card]");
    assert.equal(createRedactor({ redact: ["iban"] }).string(j("GB82WEST", "12345698765432")), "[redacted:iban]");
    assert.equal(createRedactor({ redact: ["national-id"] }).string("536-22-1234 jane@example.com"), "[redacted:national-id] jane@example.com");
  });

  it("counts what it replaced by kind", () => {
    const tally = { kinds: {} as Record<string, number> };
    pii.string(j("+1 415 555 2671, jane@example.com, 4111 1111 ", "1111 1111"), tally);
    assert.deepEqual(tally.kinds, { email: 1, card: 1, phone: 1 });
  });

  it("checks Luhn and IBAN mod 97", () => {
    assert.equal(luhnValid(j("4111111111", "111111")), true);
    assert.equal(luhnValid(j("4111111111", "111112")), false);
    assert.equal(ibanValid(j("DE8937040044", "0532013000")), true);
    assert.equal(ibanValid(j("DE8837040044", "0532013000")), false);
  });

  it("stays linear on long digit runs", () => {
    const long = "1-".repeat(50_000) + "+1 ".repeat(50_000);
    const t0 = performance.now();
    pii.string(long);
    assert.ok(performance.now() - t0 < 2000);
  });

  it("config accepts pii and each kind, and names them on a typo", () => {
    for (const k of ["pii", ...PII_KINDS]) assert.ok((REDACTORS as readonly string[]).includes(k));
    const home = mkdtempSync(join(tmpdir(), "csh-pii-"));
    const file = join(home, "config.toml");
    writeFileSync(file, '[capture]\nredact = ["secrets", "pii", "phone"]\n');
    const env = { HOME: home, CODING_SH_HOME: home };
    assert.deepEqual(loadConfig({ env, file }).capture.redact, ["secrets", "pii", "phone"]);
    writeFileSync(file, '[capture]\nredact = ["phones"]\n');
    assert.throws(() => loadConfig({ env, file }), /unknown redactor "phones".*"pii"/);
  });
});
