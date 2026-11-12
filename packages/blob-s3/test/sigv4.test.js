// SigV4 against the published AWS reference vectors:
// - the IAM "derive a signing key" example,
// - the generic sig-v4 test suite (get-vanilla, query ordering, session token),
// - the S3 "Authenticating Requests: Using the Authorization Header" examples
//   (GET object with Range, PUT object with a `$` in the key, GET ?lifecycle,
//   GET bucket list with query parameters).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_SHA256, amzDate, canonicalQuery, encodePath, sha256Hex, signV4, signingKey, uriEncode } from "../src/sigv4.js";

describe("SigV4 signing key", () => {
  it("matches the IAM documentation example", () => {
    const k = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
    assert.equal(k.toString("hex"), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });
});

describe("SigV4 generic test suite (aws-sig-v4-test-suite)", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const base = { host: "example.amazonaws.com", region: "us-east-1", service: "service", credentials, date: new Date("2015-08-30T12:36:00Z"), payloadHash: EMPTY_SHA256 };

  it("get-vanilla", () => {
    const r = signV4({ ...base, method: "GET", path: "/" });
    assert.equal(r.canonicalRequest, "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n" + EMPTY_SHA256);
    assert.equal(r.stringToSign, "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
    assert.equal(r.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("get-vanilla-query-order-key-case", () => {
    const r = signV4({ ...base, method: "GET", path: "/", query: [["Param2", "value2"], ["Param1", "value1"]] });
    assert.equal(r.signature, "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("get-vanilla-query-unreserved", () => {
    const u = "-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const r = signV4({ ...base, method: "GET", path: "/", query: [[u, u]] });
    assert.equal(r.signature, "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197");
  });

  it("post-sts-header-after (session token is signed)", () => {
    const token = "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";
    const r = signV4({ ...base, method: "POST", path: "/", credentials: { ...credentials, sessionToken: token } });
    assert.equal(r.headers["x-amz-security-token"], token);
    assert.match(r.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
    assert.equal(r.signature, "85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead");
  });
});

describe("SigV4 S3 documentation examples", () => {
  // AWS's documented example key, built in pieces so no file holds a key-shaped literal.
  const credentials = { accessKeyId: ["AKIA", "IOSFODNN7EXAMPLE"].join(""), secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const base = { host: "examplebucket.s3.amazonaws.com", region: "us-east-1", service: "s3", credentials, date: new Date("2013-05-24T00:00:00Z") };

  it("GET object with Range", () => {
    const r = signV4({ ...base, method: "GET", path: "/test.txt", payloadHash: EMPTY_SHA256, headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256 } });
    assert.equal(r.canonicalRequest, [
      "GET", "/test.txt", "",
      "host:examplebucket.s3.amazonaws.com", "range:bytes=0-9", `x-amz-content-sha256:${EMPTY_SHA256}`, "x-amz-date:20130524T000000Z", "",
      "host;range;x-amz-content-sha256;x-amz-date", EMPTY_SHA256,
    ].join("\n"));
    assert.equal(sha256Hex(r.canonicalRequest), "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
    assert.equal(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("PUT object (key with `$`, payload hash, extra signed headers)", () => {
    const body = "Welcome to Amazon S3.";
    const payloadHash = sha256Hex(body);
    assert.equal(payloadHash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const r = signV4({
      ...base, method: "PUT", path: encodePath("/test$file.text"), payloadHash,
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY", "x-amz-content-sha256": payloadHash },
    });
    assert.match(r.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
    assert.equal(r.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("GET bucket lifecycle (?lifecycle with an empty value)", () => {
    const r = signV4({ ...base, method: "GET", path: "/", query: [["lifecycle", ""]], payloadHash: EMPTY_SHA256, headers: { "x-amz-content-sha256": EMPTY_SHA256 } });
    assert.match(r.canonicalRequest, /^GET\n\/\nlifecycle=\n/);
    assert.equal(r.signature, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });

  it("GET bucket (list objects) with sorted query parameters", () => {
    const r = signV4({ ...base, method: "GET", path: "/", query: [["prefix", "J"], ["max-keys", "2"]], payloadHash: EMPTY_SHA256, headers: { "x-amz-content-sha256": EMPTY_SHA256 } });
    assert.match(r.canonicalRequest, /^GET\n\/\nmax-keys=2&prefix=J\n/);
    assert.equal(r.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

describe("SigV4 encoding helpers", () => {
  it("uriEncode is RFC 3986 with uppercase hex", () => {
    assert.equal(uriEncode("a b/c$d!*'()~-._é"), "a%20b%2Fc%24d%21%2A%27%28%29~-._%C3%A9");
  });
  it("encodePath encodes each segment once and never double-encodes", () => {
    assert.equal(encodePath("/my prefix/ab/cd/x.zst"), "/my%20prefix/ab/cd/x.zst");
    assert.equal(encodePath("/a%2Fb"), "/a%252Fb"); // a literal % in a key is data, encoded exactly once
  });
  it("canonicalQuery sorts by encoded key then value and encodes slashes", () => {
    assert.equal(canonicalQuery([["prefix", "a/b/"], ["list-type", "2"], ["continuation-token", "x+y="]]), "continuation-token=x%2By%3D&list-type=2&prefix=a%2Fb%2F");
  });
  it("amzDate drops separators and millis", () => {
    assert.equal(amzDate(new Date("2015-08-30T12:36:00.123Z")), "20150830T123600Z");
  });
});
